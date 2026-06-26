use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use alloy_primitives::B256;
use anyhow::Result;
use bytes::Bytes;
use futures_util::{Stream, StreamExt};
use reqwest::{Client, StatusCode, Url, header};
use serde::Deserialize;
use tokio::sync::broadcast;
use tokio::time::sleep;
use tracing::{debug, info, instrument, warn};

use crate::Context;
use crate::cache::{FeedKey, IpcServerSink, PriceUpdateSink, SignedPriceUpdate, provider_id};

const DEFAULT_RECONNECT_BACKOFF: Duration = Duration::from_secs(1);
const DEFAULT_MAX_RECONNECT_BACKOFF: Duration = Duration::from_secs(30);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

#[instrument(skip_all)]
pub async fn run(ctx: Context) -> Result<()> {
    let ingester = StreamIngester::new(
        StreamConfig::new(
            ctx.config.hermes_endpoint.clone(),
            ctx.config.api_key.clone(),
        ),
        Arc::new(IpcServerSink {
            cache: ctx.cache.clone(),
        }),
        ctx.config.feed_ids.clone(),
    );
    info!(
        provider_id = %provider_id(),
        feed_count = ctx.config.feed_ids.len(),
        "starting pyth ingester"
    );
    ingester.run(ctx.shutdown.clone()).await;
    Ok(())
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[derive(Debug, thiserror::Error)]
pub enum StreamError {
    #[error("invalid hermes endpoint: {0}")]
    InvalidEndpoint(String),
    #[error("http transport error: {0}")]
    Http(String),
    #[error("hermes returned HTTP {status}: {body}")]
    HttpStatus { status: StatusCode, body: String },
    #[error("hermes rate limited the request")]
    RateLimited,
    #[error("malformed hermes payload: {0}")]
    Malformed(String),
}

#[derive(Debug, Clone)]
pub struct StreamConfig {
    pub endpoint: String,
    pub api_key: Option<String>,
    pub reconnect_backoff: Duration,
    pub max_reconnect_backoff: Duration,
}

impl StreamConfig {
    pub fn new(endpoint: impl Into<String>, api_key: Option<String>) -> Self {
        Self {
            endpoint: endpoint.into(),
            api_key,
            reconnect_backoff: DEFAULT_RECONNECT_BACKOFF,
            max_reconnect_backoff: DEFAULT_MAX_RECONNECT_BACKOFF,
        }
    }
}

#[derive(Clone)]
pub struct HermesClient {
    http: Client,
    endpoint: String,
}

impl HermesClient {
    pub fn new(config: &StreamConfig) -> Result<Self, StreamError> {
        let mut headers = header::HeaderMap::new();
        if let Some(api_key) = &config.api_key {
            let mut value = header::HeaderValue::from_str(&format!("Bearer {api_key}"))
                .map_err(|e| StreamError::InvalidEndpoint(format!("invalid auth header: {e}")))?;
            value.set_sensitive(true);
            headers.insert(header::AUTHORIZATION, value);
        }
        let http = Client::builder()
            .default_headers(headers)
            .connect_timeout(CONNECT_TIMEOUT)
            .build()
            .map_err(|e| StreamError::Http(e.to_string()))?;
        Ok(Self {
            http,
            endpoint: config.endpoint.clone(),
        })
    }

    pub async fn stream_feed(&self, feed: B256) -> Result<HermesUpdateStream, StreamError> {
        let url = self.stream_url(feed)?;
        let response = self
            .http
            .get(url)
            .send()
            .await
            .map_err(|e| StreamError::Http(e.to_string()))?;
        if response.status() == StatusCode::TOO_MANY_REQUESTS {
            return Err(StreamError::RateLimited);
        }
        if !response.status().is_success() {
            return Err(StreamError::HttpStatus {
                status: response.status(),
                body: response.text().await.unwrap_or_default(),
            });
        }
        Ok(HermesUpdateStream {
            chunks: Box::pin(response.bytes_stream()),
            buffer: String::new(),
        })
    }

    fn stream_url(&self, feed: B256) -> Result<Url, StreamError> {
        let base = self
            .endpoint
            .trim_end_matches('/')
            .parse::<Url>()
            .map_err(|e| StreamError::InvalidEndpoint(e.to_string()))?;
        let mut url = base
            .join("v2/updates/price/stream")
            .map_err(|e| StreamError::InvalidEndpoint(e.to_string()))?;
        {
            let mut qp = url.query_pairs_mut();
            qp.append_pair("encoding", "hex");
            qp.append_pair("parsed", "false");
            qp.append_pair("ids[]", &format!("0x{}", hex::encode(feed.as_slice())));
        }
        Ok(url)
    }
}

type ChunkStream = Pin<Box<dyn Stream<Item = Result<Bytes, reqwest::Error>> + Send>>;

pub struct HermesUpdateStream {
    chunks: ChunkStream,
    buffer: String,
}

impl HermesUpdateStream {
    pub async fn next_blob(&mut self) -> Option<Result<Vec<Vec<u8>>, StreamError>> {
        loop {
            if let Some(event) = take_sse_event(&mut self.buffer) {
                if let Some(data) = sse_data_payload(&event) {
                    if data.trim().is_empty() {
                        continue;
                    }
                    debug!(payload_len = data.len(), "received hermes SSE update");
                    return Some(
                        parse_stream_message(&data).and_then(HermesStreamMessage::into_blobs),
                    );
                }
                continue;
            }

            let chunk = self.chunks.next().await?;
            match chunk {
                Ok(bytes) => match std::str::from_utf8(&bytes) {
                    Ok(text) => self.buffer.push_str(text),
                    Err(e) => return Some(Err(StreamError::Malformed(e.to_string()))),
                },
                Err(e) => return Some(Err(StreamError::Http(e.to_string()))),
            }
        }
    }
}

pub struct StreamIngester {
    config: StreamConfig,
    sink: Arc<dyn PriceUpdateSink>,
    feeds: Vec<B256>,
}

impl StreamIngester {
    pub fn new(config: StreamConfig, sink: Arc<dyn PriceUpdateSink>, feeds: Vec<B256>) -> Self {
        Self {
            config,
            sink,
            feeds,
        }
    }

    pub async fn run(self, shutdown: broadcast::Sender<()>) {
        let client = match HermesClient::new(&self.config) {
            Ok(client) => client,
            Err(e) => {
                warn!(error = %e, "failed to build hermes client, ingester not started");
                return;
            }
        };

        let mut handles = Vec::with_capacity(self.feeds.len());
        for feed in self.feeds {
            let client = client.clone();
            let sink = self.sink.clone();
            let base = self.config.reconnect_backoff;
            let max = self.config.max_reconnect_backoff;
            let mut shutdown = shutdown.subscribe();
            handles.push(tokio::spawn(async move {
                tokio::select! {
                    biased;
                    _ = shutdown.recv() => {}
                    _ = run_feed(client, sink, feed, base, max) => {}
                }
            }));
        }
        for handle in handles {
            let _ = handle.await;
        }
    }
}

async fn run_feed(
    client: HermesClient,
    sink: Arc<dyn PriceUpdateSink>,
    feed: B256,
    base: Duration,
    max: Duration,
) {
    let mut backoff = base;
    loop {
        match pump_feed(&client, sink.as_ref(), feed).await {
            Ok(()) => {
                debug!(%feed, "hermes stream closed, reconnecting");
                backoff = base;
                sleep(jittered(base)).await;
            }
            Err(e) => {
                if matches!(e, StreamError::Http(_)) {
                    info!(%feed, error = %e, "hermes stream disconnected, reconnecting after backoff");
                } else {
                    warn!(%feed, error = %e, "hermes stream error, reconnecting after backoff");
                }
                sleep(jittered(backoff)).await;
                backoff = (backoff * 2).min(max);
            }
        }
    }
}

async fn pump_feed(
    client: &HermesClient,
    sink: &dyn PriceUpdateSink,
    feed: B256,
) -> Result<(), StreamError> {
    let mut stream = client.stream_feed(feed).await?;
    info!(%feed, "hermes stream connected");
    while let Some(item) = stream.next_blob().await {
        match item {
            Ok(blobs) => cache_blobs(sink, feed, blobs),
            Err(StreamError::Malformed(m)) => warn!(%feed, error = %m, "skipping malformed update"),
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

fn cache_blobs(sink: &dyn PriceUpdateSink, feed: B256, blobs: Vec<Vec<u8>>) {
    if blobs.len() > 1 {
        warn!(%feed, count = blobs.len(), "expected one blob per feed, using the first");
    }
    let Some(payload) = blobs.into_iter().next() else {
        return;
    };
    if let Err(e) = crate::verification::verify(feed, &payload) {
        warn!(%feed, error = %e, "dropping update that failed verification");
        return;
    }
    debug!(%feed, payload_len = payload.len(), "cached hermes update");
    sink.insert(SignedPriceUpdate {
        key: FeedKey::new(provider_id(), feed),
        payload,
        received_at: now_secs(),
    });
}

fn jittered(delay: Duration) -> Duration {
    let factor = 1.0 + rand::random::<f64>();
    delay.mul_f64(factor)
}

#[derive(Debug, Deserialize)]
struct HermesStreamMessage {
    binary: HermesBinary,
}

#[derive(Debug, Deserialize)]
struct HermesBinary {
    encoding: String,
    data: Vec<String>,
}

impl HermesStreamMessage {
    fn into_blobs(self) -> Result<Vec<Vec<u8>>, StreamError> {
        if self.binary.encoding != "hex" {
            return Err(StreamError::Malformed(format!(
                "expected hex encoding, got {}",
                self.binary.encoding
            )));
        }
        self.binary
            .data
            .iter()
            .map(|blob| {
                hex::decode(blob.strip_prefix("0x").unwrap_or(blob))
                    .map_err(|e| StreamError::Malformed(format!("invalid hex blob: {e}")))
            })
            .collect()
    }
}

fn parse_stream_message(data: &str) -> Result<HermesStreamMessage, StreamError> {
    serde_json::from_str(data).map_err(|e| StreamError::Malformed(e.to_string()))
}

fn take_sse_event(buffer: &mut String) -> Option<String> {
    let normalized = buffer.replace("\r\n", "\n");
    if let Some(idx) = normalized.find("\n\n") {
        let event = normalized[..idx].to_string();
        *buffer = normalized[idx + 2..].to_string();
        Some(event)
    } else {
        None
    }
}

fn sse_data_payload(event: &str) -> Option<String> {
    let mut data = String::new();
    for line in event.lines() {
        let line = line.trim_end();
        if line.starts_with(':') {
            continue;
        }
        if let Some(rest) = line.strip_prefix("data:") {
            if !data.is_empty() {
                data.push('\n');
            }
            data.push_str(rest.trim_start());
        }
    }
    (!data.is_empty()).then_some(data)
}
