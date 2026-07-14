use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use alloy_primitives::{B256, keccak256};
use parking_lot::Mutex;
use tokio::sync::broadcast;

pub use price_oracle_ipc::FeedKey;
use price_oracle_ipc::OracleFrame;

const BROADCAST_CAPACITY: usize = 1024;

pub const STALENESS_THRESHOLD_MS: u64 = 1000;

pub fn provider_id() -> B256 {
    keccak256("stork")
}

pub fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignedPriceUpdate {
    pub key: FeedKey,
    pub payload: Vec<u8>,
    pub delivery_time_ms: u64,
    pub source_time_ms: u64,
}

pub trait PriceUpdateSink: Send + Sync {
    fn insert(&self, update: SignedPriceUpdate);
    fn record_dropped(&self, _count: u64) {}
}

pub struct Report {
    pub ingested: u64,
    pub sent: u64,
    pub dropped: u64,
    pub consumer_connected: bool,
    pub feeds: usize,
    pub stale: usize,
    pub oldest_feed_ms: u64,
}

#[derive(Debug, Clone)]
pub struct CachedPrice {
    pub payload: Vec<u8>,
    pub delivery_time_ms: u64,
    pub source_time_ms: u64,
}

pub struct FeedCache {
    pub latest: Mutex<BTreeMap<FeedKey, CachedPrice>>,
    pub live: broadcast::Sender<OracleFrame>,
    ingested: AtomicU64,
    dropped: AtomicU64,
    pub sent: AtomicU64,
    pub subscribers: AtomicUsize,
}

impl FeedCache {
    pub fn new() -> Self {
        let (live, _) = broadcast::channel(BROADCAST_CAPACITY);
        Self {
            latest: Mutex::new(BTreeMap::new()),
            live,
            ingested: AtomicU64::new(0),
            dropped: AtomicU64::new(0),
            sent: AtomicU64::new(0),
            subscribers: AtomicUsize::new(0),
        }
    }

    pub fn report(&self) -> Report {
        let now = now_unix_ms();
        let (feeds, stale, oldest_feed_ms) = {
            let latest = self.latest.lock();
            let mut stale = 0usize;
            let mut oldest = 0u64;
            for price in latest.values() {
                let age = now.saturating_sub(price.delivery_time_ms);
                if age > STALENESS_THRESHOLD_MS {
                    stale += 1;
                }
                oldest = oldest.max(age);
            }
            (latest.len(), stale, oldest)
        };
        Report {
            ingested: self.ingested.load(Ordering::Relaxed),
            dropped: self.dropped.load(Ordering::Relaxed),
            sent: self.sent.load(Ordering::Relaxed),
            consumer_connected: self.subscribers.load(Ordering::Relaxed) > 0,
            feeds,
            stale,
            oldest_feed_ms,
        }
    }

    pub fn snapshot(&self) -> Vec<OracleFrame> {
        self.latest
            .lock()
            .iter()
            .map(|(key, price)| OracleFrame::PriceUpdate {
                feed_id: key.feed_id,
                payload: price.payload.clone(),
                source_time_ms: price.source_time_ms,
            })
            .collect()
    }
}

impl Default for FeedCache {
    fn default() -> Self {
        Self::new()
    }
}

pub struct IpcServerSink {
    pub cache: Arc<FeedCache>,
}

impl PriceUpdateSink for IpcServerSink {
    fn insert(&self, update: SignedPriceUpdate) {
        let _span = tracing::info_span!(
            target: crate::telemetry::TRACE_TARGET,
            "receive",
            feed_id = %update.key.feed_id,
        )
        .entered();
        {
            let mut latest = self.cache.latest.lock();
            if let Some(existing) = latest.get(&update.key)
                && update.source_time_ms != 0
                && existing.source_time_ms != 0
                && update.source_time_ms < existing.source_time_ms
            {
                self.cache.dropped.fetch_add(1, Ordering::Relaxed);
                tracing::debug!(
                    feed_id = %update.key.feed_id,
                    incoming_ms = update.source_time_ms,
                    cached_ms = existing.source_time_ms,
                    "dropping update older than the cached entry"
                );
                return;
            }
            latest.insert(
                update.key,
                CachedPrice {
                    payload: update.payload.clone(),
                    delivery_time_ms: update.delivery_time_ms,
                    source_time_ms: update.source_time_ms,
                },
            );
        }
        let frame = OracleFrame::PriceUpdate {
            feed_id: update.key.feed_id,
            payload: update.payload,
            source_time_ms: update.source_time_ms,
        };
        self.cache.ingested.fetch_add(1, Ordering::Relaxed);
        let _ = self.cache.live.send(frame);
    }

    fn record_dropped(&self, count: u64) {
        self.cache.dropped.fetch_add(count, Ordering::Relaxed);
    }
}
