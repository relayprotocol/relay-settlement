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

pub(crate) fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignedPriceUpdate {
    pub key: FeedKey,
    pub payload: Vec<u8>,
    pub received_at: u64,
    pub source_time: u64,
}

pub trait PriceUpdateSink: Send + Sync {
    fn insert(&self, update: SignedPriceUpdate);
}

pub struct Report {
    pub ingested: u64,
    pub sent: u64,
    pub consumer_connected: bool,
    pub feeds: usize,
    pub oldest_sec: u32,
}

#[derive(Debug, Clone)]
pub(crate) struct CachedPrice {
    pub payload: Vec<u8>,
    pub ingested_at: u64,
    pub source_time: u64,
}

pub struct FeedCache {
    pub(crate) latest: Mutex<BTreeMap<FeedKey, CachedPrice>>,
    pub(crate) live: broadcast::Sender<OracleFrame>,
    ingested: AtomicU64,
    pub(crate) sent: AtomicU64,
    pub(crate) subscribers: AtomicUsize,
}

impl FeedCache {
    pub fn new() -> Self {
        let (live, _) = broadcast::channel(BROADCAST_CAPACITY);
        Self {
            latest: Mutex::new(BTreeMap::new()),
            live,
            ingested: AtomicU64::new(0),
            sent: AtomicU64::new(0),
            subscribers: AtomicUsize::new(0),
        }
    }

    pub fn report(&self) -> Report {
        let latest = self.latest.lock();
        let oldest_received_at = latest.values().map(|p| p.ingested_at).min();
        Report {
            ingested: self.ingested.load(Ordering::Relaxed),
            sent: self.sent.load(Ordering::Relaxed),
            consumer_connected: self.subscribers.load(Ordering::Relaxed) > 0,
            feeds: latest.len(),
            oldest_sec: oldest_received_at
                .map(|ts| now_unix().saturating_sub(ts) as u32)
                .unwrap_or(0),
        }
    }

    pub(crate) fn snapshot(&self) -> Vec<OracleFrame> {
        self.latest
            .lock()
            .iter()
            .map(|(key, price)| OracleFrame::PriceUpdate {
                provider_id: key.provider_id,
                feed_id: key.feed_id,
                payload: price.payload.clone(),
                ingested_at: price.ingested_at,
                source_time: price.source_time,
            })
            .collect()
    }
}

impl Default for FeedCache {
    fn default() -> Self {
        Self::new()
    }
}

pub(crate) struct IpcServerSink {
    pub(crate) cache: Arc<FeedCache>,
}

impl PriceUpdateSink for IpcServerSink {
    fn insert(&self, update: SignedPriceUpdate) {
        let _span = tracing::info_span!(
            target: crate::telemetry::TRACE_TARGET,
            "receive",
            feed_id = %update.key.feed_id,
        )
        .entered();
        let frame = OracleFrame::PriceUpdate {
            provider_id: update.key.provider_id,
            feed_id: update.key.feed_id,
            payload: update.payload.clone(),
            ingested_at: update.received_at,
            source_time: update.source_time,
        };
        self.cache.latest.lock().insert(
            update.key,
            CachedPrice {
                payload: update.payload,
                ingested_at: update.received_at,
                source_time: update.source_time,
            },
        );
        self.cache.ingested.fetch_add(1, Ordering::Relaxed);
        let _ = self.cache.live.send(frame);
    }
}
