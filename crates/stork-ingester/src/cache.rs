use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use alloy_primitives::{B256, keccak256};
use parking_lot::Mutex;
use tokio::sync::broadcast;

pub use price_oracle_ipc::FeedKey;
use price_oracle_ipc::OracleFrame;

use crate::metrics;

const BROADCAST_CAPACITY: usize = 1024;
pub const NANOS_PER_MILLISECOND: u64 = 1_000_000;

pub const STALENESS_THRESHOLD_MS: u64 = 1000;

pub fn provider_id() -> B256 {
    keccak256("stork")
}

pub fn now_unix_ns() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
        .try_into()
        .unwrap_or(u64::MAX)
}

pub fn now_unix_ms() -> u64 {
    now_unix_ns() / NANOS_PER_MILLISECOND
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignedPriceUpdate {
    pub key: FeedKey,
    pub payload: Vec<u8>,
    pub delivery_time_ms: u64,
    pub source_time_ns: u64,
    pub quantized_value: i128,
}

pub trait PriceUpdateSink: Send + Sync {
    fn insert(&self, update: SignedPriceUpdate) -> bool;
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
    pub source_time_ns: u64,
    pub quantized_value: i128,
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
                source_time_ms: price.source_time_ns / NANOS_PER_MILLISECOND,
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
    fn insert(&self, update: SignedPriceUpdate) -> bool {
        {
            let mut latest = self.cache.latest.lock();
            if let Some(existing) = latest.get(&update.key) {
                if update.source_time_ns < existing.source_time_ns {
                    self.cache.dropped.fetch_add(1, Ordering::Relaxed);
                    metrics::on_dropped(Some(&update.key.feed_id), "stale", 1);
                    tracing::warn!(
                        feed_id = %update.key.feed_id,
                        incoming_ns = update.source_time_ns,
                        cached_ns = existing.source_time_ns,
                        "dropping update older than the cached entry"
                    );
                    return false;
                }
                if update.source_time_ns == existing.source_time_ns
                    && update.quantized_value != existing.quantized_value
                {
                    self.cache.dropped.fetch_add(1, Ordering::Relaxed);
                    metrics::on_dropped(Some(&update.key.feed_id), "conflict", 1);
                    tracing::warn!(
                        feed_id = %update.key.feed_id,
                        timestamp_ns = update.source_time_ns,
                        incoming_value = update.quantized_value,
                        cached_value = existing.quantized_value,
                        "dropping conflicting update at the cached timestamp"
                    );
                    return false;
                }
            }
            latest.insert(
                update.key,
                CachedPrice {
                    payload: update.payload.clone(),
                    delivery_time_ms: update.delivery_time_ms,
                    source_time_ns: update.source_time_ns,
                    quantized_value: update.quantized_value,
                },
            );
        }
        let frame = OracleFrame::PriceUpdate {
            feed_id: update.key.feed_id,
            payload: update.payload,
            source_time_ms: update.source_time_ns / NANOS_PER_MILLISECOND,
        };
        self.cache.ingested.fetch_add(1, Ordering::Relaxed);
        metrics::on_update_accepted(
            &update.key.feed_id,
            update.source_time_ns,
            update.delivery_time_ms,
        );
        let _ = self.cache.live.send(frame);
        true
    }

    fn record_dropped(&self, count: u64) {
        self.cache.dropped.fetch_add(count, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use alloy_primitives::B256;

    use super::*;

    const BASE_NS: u64 = 1_700_000_000_000_000_000;

    fn update(timestamp_ns: u64, quantized_value: i128, payload: u8) -> SignedPriceUpdate {
        SignedPriceUpdate {
            key: FeedKey::new(provider_id(), B256::repeat_byte(0x01)),
            payload: vec![payload],
            delivery_time_ms: 1_700_000_000_000,
            source_time_ns: timestamp_ns,
            quantized_value,
        }
    }

    #[test]
    fn rejects_older_nanoseconds_within_millisecond() {
        let cache = Arc::new(FeedCache::new());
        let sink = IpcServerSink {
            cache: cache.clone(),
        };

        assert!(sink.insert(update(BASE_NS + 900, 100, 1)));
        assert!(!sink.insert(update(BASE_NS + 100, 101, 2)));

        let cached = cache.latest.lock();
        let price = cached.values().next().unwrap();
        assert_eq!(price.payload, vec![1]);
        assert_eq!(price.source_time_ns, BASE_NS + 900);
        drop(cached);
        assert_eq!(cache.report().dropped, 1);
    }

    #[test]
    fn accepts_same_value_at_same_timestamp() {
        let cache = Arc::new(FeedCache::new());
        let sink = IpcServerSink {
            cache: cache.clone(),
        };

        assert!(sink.insert(update(BASE_NS, 100, 1)));
        assert!(sink.insert(update(BASE_NS, 100, 2)));

        let cached = cache.latest.lock();
        assert_eq!(cached.values().next().unwrap().payload, vec![2]);
    }

    #[test]
    fn rejects_conflicting_value_at_same_timestamp() {
        let cache = Arc::new(FeedCache::new());
        let sink = IpcServerSink {
            cache: cache.clone(),
        };

        assert!(sink.insert(update(BASE_NS, 100, 1)));
        assert!(!sink.insert(update(BASE_NS, 101, 2)));

        let cached = cache.latest.lock();
        let price = cached.values().next().unwrap();
        assert_eq!(price.payload, vec![1]);
        assert_eq!(price.quantized_value, 100);
        drop(cached);
        assert_eq!(cache.report().dropped, 1);
    }

    #[test]
    fn snapshot_exports_milliseconds() {
        let cache = Arc::new(FeedCache::new());
        let sink = IpcServerSink {
            cache: cache.clone(),
        };
        let update = update(BASE_NS + 999_999, 100, 1);
        let feed_id = update.key.feed_id;

        assert!(sink.insert(update));

        assert_eq!(
            cache.snapshot(),
            vec![OracleFrame::PriceUpdate {
                feed_id,
                payload: vec![1],
                source_time_ms: BASE_NS / NANOS_PER_MILLISECOND,
            }]
        );
    }
}
