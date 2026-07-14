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

pub fn provider_id() -> B256 {
    keccak256("chainlink")
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
}

pub struct Report {
    pub ingested: u64,
    pub sent: u64,
    pub regressed: u64,
    pub consumer_connected: bool,
    pub feeds: usize,
    pub oldest_sec: u32,
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
    regressed: AtomicU64,
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
            regressed: AtomicU64::new(0),
            sent: AtomicU64::new(0),
            subscribers: AtomicUsize::new(0),
        }
    }

    pub fn report(&self) -> Report {
        let latest = self.latest.lock();
        let oldest_delivery_time_ms = latest.values().map(|p| p.delivery_time_ms).min();
        Report {
            ingested: self.ingested.load(Ordering::Relaxed),
            regressed: self.regressed.load(Ordering::Relaxed),
            sent: self.sent.load(Ordering::Relaxed),
            consumer_connected: self.subscribers.load(Ordering::Relaxed) > 0,
            feeds: latest.len(),
            oldest_sec: oldest_delivery_time_ms
                .map(|ts| (now_unix_ms().saturating_sub(ts) / 1000) as u32)
                .unwrap_or(0),
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
                self.cache.regressed.fetch_add(1, Ordering::Relaxed);
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
}
