//! OTLP metrics for the ingester, focused on feed liveness.
//!
//! Instruments are created against the global meter provider, so every
//! function here is a no-op when telemetry is disabled. Per-feed values
//! are keyed by feed id and tagged with the human-readable symbol.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};

use alloy_primitives::B256;
use opentelemetry::KeyValue;
use opentelemetry::metrics::Counter;

use crate::cache::{FeedCache, NANOS_PER_MILLISECOND, now_unix_ms};
use crate::taxonomy::FeedSet;

const METER_NAME: &str = "stork-ingester";

struct FeedState {
    attributes: [KeyValue; 1],
    last_update_unix_ms: AtomicU64,
    max_gap_ms: AtomicU64,
    source_delay_ms: AtomicU64,
    seen_update: AtomicBool,
}

struct Registry {
    feeds: HashMap<B256, FeedState>,
    received: Counter<u64>,
    sent: Counter<u64>,
    dropped: Counter<u64>,
    reconnects: Counter<u64>,
    resends: Counter<u64>,
    rejected: Counter<u64>,
    disconnects: Counter<u64>,
}

static REGISTRY: OnceLock<Registry> = OnceLock::new();

/// Registers all instruments and gauge callbacks. Call once at startup,
/// after telemetry::init and after the feed set is resolved.
pub fn init(feeds: &FeedSet, streams: Arc<AtomicUsize>, cache: Arc<FeedCache>) {
    let meter = opentelemetry::global::meter(METER_NAME);
    let started_ms = now_unix_ms();

    let states: HashMap<B256, FeedState> = feeds
        .assets
        .iter()
        .map(|asset| {
            (
                asset.feed_id,
                FeedState {
                    attributes: [KeyValue::new("feed", asset.symbol.clone())],
                    last_update_unix_ms: AtomicU64::new(started_ms),
                    max_gap_ms: AtomicU64::new(0),
                    source_delay_ms: AtomicU64::new(0),
                    seen_update: AtomicBool::new(false),
                },
            )
        })
        .collect();

    let registry = Registry {
        feeds: states,
        received: meter.u64_counter("stork_ingester.updates.received").build(),
        sent: meter.u64_counter("stork_ingester.updates.sent").build(),
        dropped: meter.u64_counter("stork_ingester.updates.dropped").build(),
        reconnects: meter
            .u64_counter("stork_ingester.stream.reconnects")
            .build(),
        resends: meter.u64_counter("stork_ingester.consumer.resends").build(),
        rejected: meter
            .u64_counter("stork_ingester.consumer.rejected")
            .build(),
        disconnects: meter
            .u64_counter("stork_ingester.consumer.disconnects")
            .build(),
    };
    if REGISTRY.set(registry).is_err() {
        return;
    }

    meter
        .u64_observable_gauge("stork_ingester.feed.last_update_age_ms")
        .with_callback(|observer| {
            let Some(registry) = REGISTRY.get() else {
                return;
            };
            let now = now_unix_ms();
            for state in registry.feeds.values() {
                let last = state.last_update_unix_ms.load(Ordering::Relaxed);
                observer.observe(now.saturating_sub(last), &state.attributes);
            }
        })
        .build();

    meter
        .u64_observable_gauge("stork_ingester.feed.max_update_gap_ms")
        .with_callback(|observer| {
            let Some(registry) = REGISTRY.get() else {
                return;
            };
            for state in registry.feeds.values() {
                observer.observe(
                    state.max_gap_ms.swap(0, Ordering::Relaxed),
                    &state.attributes,
                );
            }
        })
        .build();

    meter
        .u64_observable_gauge("stork_ingester.feed.source_delay_ms")
        .with_callback(|observer| {
            let Some(registry) = REGISTRY.get() else {
                return;
            };
            for state in registry.feeds.values() {
                observer.observe(
                    state.source_delay_ms.load(Ordering::Relaxed),
                    &state.attributes,
                );
            }
        })
        .build();

    meter
        .u64_observable_gauge("stork_ingester.stream.connected")
        .with_callback(move |observer| {
            observer.observe(streams.load(Ordering::Relaxed) as u64, &[]);
        })
        .build();

    meter
        .u64_observable_gauge("stork_ingester.consumer.subscribers")
        .with_callback(move |observer| {
            observer.observe(cache.subscribers.load(Ordering::Relaxed) as u64, &[]);
        })
        .build();
}

/// Records an accepted price update: throughput, inter-update gap, and
/// the delay between the source timestamp and local delivery.
pub fn on_update_accepted(feed_id: &B256, source_time_ns: u64, delivery_time_ms: u64) {
    let Some(state) = feed_state(feed_id) else {
        return;
    };
    let now = now_unix_ms();
    let last = state.last_update_unix_ms.swap(now, Ordering::Relaxed);
    if state.seen_update.swap(true, Ordering::Relaxed) {
        state
            .max_gap_ms
            .fetch_max(now.saturating_sub(last), Ordering::Relaxed);
    }
    let source_time_ms = source_time_ns / NANOS_PER_MILLISECOND;
    state.source_delay_ms.store(
        delivery_time_ms.saturating_sub(source_time_ms),
        Ordering::Relaxed,
    );
    if let Some(registry) = REGISTRY.get() {
        registry.received.add(1, &state.attributes);
    }
}

pub fn on_update_sent(feed_id: &B256) {
    if let (Some(registry), Some(state)) = (REGISTRY.get(), feed_state(feed_id)) {
        registry.sent.add(1, &state.attributes);
    }
}

pub fn on_dropped(feed_id: Option<&B256>, reason: &'static str, count: u64) {
    let Some(registry) = REGISTRY.get() else {
        return;
    };
    let reason_attr = KeyValue::new("reason", reason);
    match feed_id.and_then(feed_state) {
        Some(state) => registry
            .dropped
            .add(count, &[state.attributes[0].clone(), reason_attr]),
        None => registry.dropped.add(count, &[reason_attr]),
    }
}

pub fn on_reconnect() {
    if let Some(registry) = REGISTRY.get() {
        registry.reconnects.add(1, &[]);
    }
}

pub fn on_resend() {
    if let Some(registry) = REGISTRY.get() {
        registry.resends.add(1, &[]);
    }
}

pub fn on_subscriber_rejected() {
    if let Some(registry) = REGISTRY.get() {
        registry.rejected.add(1, &[]);
    }
}

pub fn on_subscriber_disconnected(reason: &'static str) {
    if let Some(registry) = REGISTRY.get() {
        registry
            .disconnects
            .add(1, &[KeyValue::new("reason", reason)]);
    }
}

fn feed_state(feed_id: &B256) -> Option<&'static FeedState> {
    REGISTRY
        .get()
        .and_then(|registry| registry.feeds.get(feed_id))
}
