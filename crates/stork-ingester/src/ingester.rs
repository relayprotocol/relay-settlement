use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::time::Duration;

use anyhow::{Context as _, Result, anyhow};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::time::{sleep, timeout};
use tracing::{Instrument as _, debug, info, info_span, instrument, warn};
use yawc::frame::{Frame, OpCode};
use yawc::{HttpRequestBuilder, Options, TcpWebSocket, WebSocket};

use crate::cache::{
    FeedKey, IpcServerSink, NANOS_PER_MILLISECOND, PriceUpdateSink, SignedPriceUpdate, now_unix_ms,
    now_unix_ns, provider_id,
};
use crate::payload::FastPayload;
use crate::taxonomy::FastAsset;
use crate::telemetry::TRACE_TARGET;
use crate::{Context, metrics};

const WS_API_PATH: &str = "/ws";
const MESSAGE_TYPE: &str = "signed_ecdsa";
const DEFAULT_RECONNECT_BACKOFF: Duration = Duration::from_secs(1);
const DEFAULT_MAX_RECONNECT_BACKOFF: Duration = Duration::from_secs(15);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

#[instrument(skip_all)]
pub async fn run(ctx: Context) -> Result<()> {
    let config = StreamConfig {
        ws_endpoint: ctx.config.ws_endpoint.clone(),
        auth_token: ctx.config.auth_token.clone(),
        channel: ctx.config.channel.clone(),
        compression: ctx.config.compression,
        idle_timeout: ctx.config.idle_timeout,
        reconnect_backoff: DEFAULT_RECONNECT_BACKOFF,
        max_reconnect_backoff: DEFAULT_MAX_RECONNECT_BACKOFF,
    };
    let sink = Arc::new(IpcServerSink {
        cache: ctx.cache.clone(),
    });
    info!(
        provider_id = %provider_id(),
        feed_count = ctx.feeds.assets.len(),
        taxonomy_id = ctx.feeds.taxonomy_id,
        channel = %ctx.config.channel,
        "starting stork ingester"
    );

    let worker = BatchWorker {
        config,
        sink,
        asset_ids: ctx.feeds.assets.iter().map(|a| a.asset_id).collect(),
        assets: ctx
            .feeds
            .assets
            .iter()
            .map(|a| (a.asset_id, a.clone()))
            .collect(),
        taxonomy_id: ctx.feeds.taxonomy_id,
        max_age_sec: ctx.config.max_age_sec,
        sockets: ctx.sockets.clone(),
        published: AtomicU64::new(0),
    };
    let mut shutdown = ctx.shutdown.subscribe();
    tokio::select! {
        biased;
        _ = shutdown.recv() => {}
        _ = worker.run() => {}
    }
    Ok(())
}

#[derive(Debug, Clone)]
struct StreamConfig {
    ws_endpoint: String,
    auth_token: String,
    channel: String,
    compression: bool,
    idle_timeout: Option<Duration>,
    reconnect_backoff: Duration,
    max_reconnect_backoff: Duration,
}

struct BatchWorker {
    config: StreamConfig,
    sink: Arc<dyn PriceUpdateSink>,
    asset_ids: Vec<u16>,
    assets: HashMap<u16, FastAsset>,
    taxonomy_id: u16,
    max_age_sec: u64,
    sockets: Arc<AtomicUsize>,
    published: AtomicU64,
}

impl BatchWorker {
    async fn run(&self) {
        let base = self.config.reconnect_backoff;
        let max = self.config.max_reconnect_backoff;
        let mut backoff = base;
        loop {
            let published_before = self.published.load(Ordering::Relaxed);
            let result = self.pump().await;
            if self.published.load(Ordering::Relaxed) > published_before {
                backoff = base;
            }
            metrics::on_reconnect();
            match result {
                Ok(()) => {
                    debug!("fast stream ended, reconnecting after backoff");
                    sleep(base).await;
                }
                Err(e) => {
                    warn!(error = %e, "fast stream error, reconnecting after backoff");
                    sleep(backoff).await;
                    backoff = (backoff * 2).min(max);
                }
            }
        }
    }

    async fn pump(&self) -> Result<()> {
        info!(feed_count = self.asset_ids.len(), "connecting fast stream");
        let mut ws = async {
            let result =
                match timeout(CONNECT_TIMEOUT, connect(&self.config, &self.asset_ids)).await {
                    Ok(result) => result,
                    Err(_) => Err(anyhow!(
                        "timed out connecting fast stream after {CONNECT_TIMEOUT:?}"
                    )),
                };
            if let Err(err) = &result {
                let span = tracing::Span::current();
                span.record("otel.status_code", "ERROR");
                span.record("error.message", err.to_string().as_str());
            }
            result
        }
        .instrument(info_span!(
            target: TRACE_TARGET,
            "stream_connect",
            feed_count = self.asset_ids.len(),
            otel.status_code = tracing::field::Empty,
            error.message = tracing::field::Empty,
        ))
        .await?;
        let _gauge = SocketGauge::open(&self.sockets);
        info!("fast stream connected");

        let mut tracker = self
            .config
            .idle_timeout
            .map(|idle| AbsenceTracker::new(&self.asset_ids, idle * 2, now_unix_ms()));

        loop {
            let frame = match self.config.idle_timeout {
                Some(idle) => timeout(idle, ws.next())
                    .await
                    .context(format!("no frame received within {idle:?}"))?,
                None => ws.next().await,
            };
            let Some(frame) = frame else {
                return Ok(());
            };
            match frame.opcode() {
                OpCode::Text | OpCode::Binary => {
                    let Some(hex) = parse_signed_message(frame.payload().as_ref()) else {
                        debug!("skipping non-price frame");
                        continue;
                    };
                    self.cache_payload(&hex, tracker.as_mut());
                    if let Some(tracker) = &tracker {
                        let absent = tracker.absent(now_unix_ms());
                        if !absent.is_empty() {
                            let symbols: Vec<&str> = absent
                                .iter()
                                .filter_map(|id| self.assets.get(id).map(|a| a.symbol.as_str()))
                                .collect();
                            return Err(anyhow!(
                                "subscribed feeds absent from batches beyond the absence threshold: {symbols:?}"
                            ));
                        }
                    }
                }
                OpCode::Close => return Ok(()),
                _ => {}
            }
        }
    }

    fn cache_payload(&self, hex_payload: &str, tracker: Option<&mut AbsenceTracker>) {
        let delivery_time_ns = now_unix_ns();
        let delivery_time_ms = delivery_time_ns / NANOS_PER_MILLISECOND;
        let payload = match FastPayload::from_hex(hex_payload) {
            Ok(payload) => payload,
            Err(e) => {
                warn!(error = %e, "dropping malformed fast payload");
                self.sink.record_dropped(self.assets.len() as u64);
                metrics::on_dropped(None, "malformed", self.assets.len() as u64);
                return;
            }
        };

        if let Err(e) = crate::verification::verify(
            &payload,
            self.taxonomy_id,
            delivery_time_ns,
            self.max_age_sec,
        ) {
            warn!(error = %e, "dropping fast payload that failed verification");
            let subscribed = payload
                .assets
                .iter()
                .filter(|value| self.assets.contains_key(&value.asset_id))
                .map(|value| value.asset_id)
                .collect::<HashSet<_>>()
                .len();
            self.sink.record_dropped(subscribed as u64);
            metrics::on_dropped(None, "verification", subscribed as u64);
            return;
        }

        if let Some(tracker) = tracker {
            for value in &payload.assets {
                tracker.observe(value.asset_id, delivery_time_ms);
            }
        }

        let published = publish_batch(self.sink.as_ref(), &self.assets, &payload, delivery_time_ms);
        self.published
            .fetch_add(published as u64, Ordering::Relaxed);
        if published < self.assets.len() {
            debug!(
                published,
                subscribed = self.assets.len(),
                "batch does not cover every subscribed asset"
            );
        }
    }
}

struct AbsenceTracker {
    threshold_ms: u64,
    last_seen: HashMap<u16, u64>,
}

impl AbsenceTracker {
    fn new(asset_ids: &[u16], threshold: Duration, now_ms: u64) -> Self {
        Self {
            threshold_ms: threshold.as_millis() as u64,
            last_seen: asset_ids.iter().map(|&id| (id, now_ms)).collect(),
        }
    }

    fn observe(&mut self, asset_id: u16, now_ms: u64) {
        if let Some(seen) = self.last_seen.get_mut(&asset_id) {
            *seen = now_ms;
        }
    }

    fn absent(&self, now_ms: u64) -> Vec<u16> {
        let mut absent: Vec<u16> = self
            .last_seen
            .iter()
            .filter(|&(_, &seen)| now_ms.saturating_sub(seen) > self.threshold_ms)
            .map(|(&id, _)| id)
            .collect();
        absent.sort_unstable();
        absent
    }
}

fn publish_batch(
    sink: &dyn PriceUpdateSink,
    assets: &HashMap<u16, FastAsset>,
    payload: &FastPayload,
    delivery_time_ms: u64,
) -> usize {
    let source_time_ms = payload.timestamp_ns / NANOS_PER_MILLISECOND;
    let mut published = 0;
    for value in &payload.assets {
        let Some(asset) = assets.get(&value.asset_id) else {
            debug!(
                asset_id = value.asset_id,
                "skipping unsubscribed asset in batch"
            );
            continue;
        };
        debug!(
            symbol = %asset.symbol,
            feed_id = %asset.feed_id,
            source_time_ms,
            delivery_time_ms,
            payload_len = payload.raw.len(),
            "cached fast update, broadcasting to subscribers"
        );
        let inserted = sink.insert(SignedPriceUpdate {
            key: FeedKey::new(provider_id(), asset.feed_id),
            payload: payload.raw.clone(),
            delivery_time_ms,
            source_time_ns: payload.timestamp_ns,
            quantized_value: value.quantized_value,
        });
        published += usize::from(inserted);
    }
    published
}

struct SocketGauge<'a>(&'a AtomicUsize);

impl<'a> SocketGauge<'a> {
    fn open(gauge: &'a AtomicUsize) -> Self {
        gauge.fetch_add(1, Ordering::Relaxed);
        Self(gauge)
    }
}

impl Drop for SocketGauge<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Relaxed);
    }
}

async fn connect(config: &StreamConfig, asset_ids: &[u16]) -> Result<TcpWebSocket> {
    let url = format!(
        "{}{WS_API_PATH}?channel={}&message_type={MESSAGE_TYPE}",
        config.ws_endpoint.trim_end_matches('/'),
        config.channel,
    );
    let request =
        HttpRequestBuilder::new().header("authorization", format!("Basic {}", config.auth_token));

    let mut options = Options::default();
    if config.compression {
        options = options.with_low_latency_compression();
    }

    let mut ws = WebSocket::connect(
        url.parse()
            .context(format!("invalid websocket endpoint: {url}"))?,
    )
    .with_options(options)
    .with_request(request)
    .await
    .context("websocket transport error")?;

    let subscribe = serde_json::to_string(&SubscribeMessage {
        kind: "subscribe",
        assets: asset_ids,
    })
    .context("failed to serialize subscribe message")?;
    debug!(subscribe = %subscribe, "sending fast subscribe message");
    ws.send(Frame::text(subscribe))
        .await
        .context("websocket transport error")?;

    Ok(ws)
}

fn parse_signed_message(bytes: &[u8]) -> Option<String> {
    let envelope: SignedEnvelope = serde_json::from_slice(bytes).ok()?;
    if envelope.kind != MESSAGE_TYPE {
        return None;
    }
    envelope.p
}

#[derive(Debug, Serialize)]
struct SubscribeMessage<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    assets: &'a [u16],
}

#[derive(Debug, Deserialize)]
struct SignedEnvelope {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    p: Option<String>,
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use alloy_primitives::keccak256;

    use super::*;
    use crate::taxonomy::fast_feed_id;

    #[test]
    fn subscribe_message_serializes_to_expected_json() {
        let json = serde_json::to_string(&SubscribeMessage {
            kind: "subscribe",
            assets: &[1, 2, 10, 34],
        })
        .unwrap();
        assert_eq!(json, r#"{"type":"subscribe","assets":[1,2,10,34]}"#);
    }

    #[test]
    fn parses_signed_ecdsa_frame() {
        let frame = br#"{"type":"signed_ecdsa","p":"0xdeadbeef"}"#;
        assert_eq!(parse_signed_message(frame), Some("0xdeadbeef".to_string()));
    }

    #[test]
    fn ignores_non_signed_frames() {
        assert!(parse_signed_message(br#"{"type":"subscribe","assets":[1]}"#).is_none());
        assert!(parse_signed_message(br#"{"type":"unsigned","tax":1,"ts":1,"a":[]}"#).is_none());
        assert!(parse_signed_message(br#"not json"#).is_none());
    }

    #[derive(Default)]
    struct RecordingSink {
        updates: Mutex<Vec<SignedPriceUpdate>>,
    }

    impl PriceUpdateSink for RecordingSink {
        fn insert(&self, update: SignedPriceUpdate) -> bool {
            self.updates.lock().unwrap().push(update);
            true
        }
    }

    fn batch_payload(taxonomy: u16, timestamp_ns: u64, assets: &[(u16, i128)]) -> FastPayload {
        let mut raw = vec![0u8; 65];
        raw.extend_from_slice(&taxonomy.to_be_bytes());
        raw.extend_from_slice(&timestamp_ns.to_be_bytes());
        for (asset_id, value) in assets {
            raw.extend_from_slice(&asset_id.to_be_bytes());
            raw.extend_from_slice(&value.to_be_bytes());
        }
        FastPayload::from_bytes(raw).unwrap()
    }

    fn configured(taxonomy: u16, ids: &[u16]) -> HashMap<u16, FastAsset> {
        ids.iter()
            .map(|&asset_id| {
                (
                    asset_id,
                    FastAsset {
                        symbol: format!("ASSET{asset_id}"),
                        asset_id,
                        feed_id: fast_feed_id(taxonomy, asset_id),
                    },
                )
            })
            .collect()
    }

    #[test]
    fn absence_tracker_trips_after_threshold_and_resets_on_observe() {
        let start = 1_000_000;
        let threshold = Duration::from_secs(10);
        let mut tracker = AbsenceTracker::new(&[1, 2], threshold, start);

        assert!(tracker.absent(start + 10_000).is_empty());
        assert_eq!(tracker.absent(start + 10_001), vec![1, 2]);

        tracker.observe(2, start + 8_000);
        tracker.observe(99, start + 8_000);
        assert_eq!(tracker.absent(start + 10_001), vec![1]);
        assert_eq!(tracker.absent(start + 18_001), vec![1, 2]);
    }

    #[test]
    fn publishes_batch_under_each_subscribed_feed() {
        let sink = RecordingSink::default();
        let assets = configured(1, &[7, 8, 99]);
        let payload = batch_payload(1, 1_700_000_000_000 * 1_000_000, &[(7, 1), (8, 2), (55, 3)]);

        let published = publish_batch(&sink, &assets, &payload, 1_700_000_000_001);

        assert_eq!(published, 2);
        let updates = sink.updates.lock().unwrap();
        assert_eq!(updates.len(), 2);
        for (update, asset_id) in updates.iter().zip([7u16, 8]) {
            assert_eq!(update.key.provider_id, keccak256("stork"));
            assert_eq!(update.key.feed_id, fast_feed_id(1, asset_id));
            assert_eq!(update.payload, payload.raw);
            assert_eq!(update.source_time_ns, 1_700_000_000_000_000_000);
            assert_eq!(update.quantized_value, i128::from(asset_id - 6));
            assert_eq!(update.delivery_time_ms, 1_700_000_000_001);
        }
    }
}
