use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use alloy_primitives::B256;
use anyhow::Result;
use futures_util::StreamExt;
use serde::Deserialize;
use tokio::net::TcpStream;
use tokio::time::sleep;
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async,
    tungstenite::{
        Message,
        client::IntoClientRequest,
        http::{HeaderName, HeaderValue},
    },
};
use tracing::{debug, info, instrument, warn};

use crate::Context;
use crate::cache::{FeedKey, IpcServerSink, PriceUpdateSink, SignedPriceUpdate, provider_id};

const WS_PATH: &str = "/api/v1/ws";
const DEFAULT_RECONNECT_BACKOFF: Duration = Duration::from_secs(1);
const DEFAULT_MAX_RECONNECT_BACKOFF: Duration = Duration::from_secs(30);

#[instrument(skip_all)]
pub async fn run(ctx: Context) -> Result<()> {
    let ingester = StreamIngester::new(
        StreamConfig::new(
            ctx.config.ws_endpoint.clone(),
            ctx.config.credentials.clone(),
        ),
        Arc::new(IpcServerSink {
            cache: ctx.cache.clone(),
        }),
        ctx.config.feed_ids.clone(),
        ctx.config.max_age_sec,
    );
    info!(
        provider_id = %provider_id(),
        feed_count = ctx.config.feed_ids.len(),
        "starting chainlink ingester"
    );
    ingester.run().await;
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
    #[error("invalid websocket endpoint: {0}")]
    InvalidEndpoint(String),
    #[error("websocket transport error: {0}")]
    WebSocket(String),
    #[error("malformed report message: {0}")]
    Malformed(String),
    #[error("server closed the connection")]
    Closed,
}

#[derive(Debug, Clone)]
pub struct StreamConfig {
    pub ws_endpoint: String,
    pub credentials: crate::authentication::Credentials,
    pub reconnect_backoff: Duration,
    pub max_reconnect_backoff: Duration,
}

impl StreamConfig {
    pub fn new(
        endpoint: impl Into<String>,
        credentials: crate::authentication::Credentials,
    ) -> Self {
        Self {
            ws_endpoint: endpoint.into(),
            credentials,
            reconnect_backoff: DEFAULT_RECONNECT_BACKOFF,
            max_reconnect_backoff: DEFAULT_MAX_RECONNECT_BACKOFF,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawReport {
    pub feed_id: B256,
    pub full_report: Vec<u8>,
    pub source_time: u64,
}

pub struct ChainlinkStream {
    ws: WebSocketStream<MaybeTlsStream<TcpStream>>,
}

impl ChainlinkStream {
    pub async fn connect(config: &StreamConfig, feeds: &[B256]) -> Result<Self, StreamError> {
        if feeds.is_empty() {
            return Err(StreamError::InvalidEndpoint(
                "at least one feed id is required".into(),
            ));
        }

        let path = subscription_path(feeds);
        let url = format!("{}{path}", config.ws_endpoint.trim_end_matches('/'));

        let mut request = url
            .into_client_request()
            .map_err(|e| StreamError::InvalidEndpoint(e.to_string()))?;

        let headers = config.credentials.sign("GET", &path, b"", unix_millis());
        let request_headers = request.headers_mut();
        for (name, value) in headers.as_pairs() {
            let header_name = HeaderName::from_bytes(name.as_bytes())
                .map_err(|e| StreamError::WebSocket(e.to_string()))?;
            let header_value =
                HeaderValue::from_str(value).map_err(|e| StreamError::WebSocket(e.to_string()))?;
            request_headers.insert(header_name, header_value);
        }

        let (ws, _response) = connect_async(request)
            .await
            .map_err(|e| StreamError::WebSocket(e.to_string()))?;

        Ok(Self { ws })
    }

    pub async fn next_report(&mut self) -> Option<Result<RawReport, StreamError>> {
        loop {
            match self.ws.next().await? {
                Ok(Message::Text(text)) => return Some(parse_report_message(text.as_bytes())),
                Ok(Message::Binary(bytes)) => return Some(parse_report_message(&bytes)),
                Ok(Message::Close(_)) => return Some(Err(StreamError::Closed)),
                Ok(_) => continue,
                Err(e) => return Some(Err(StreamError::WebSocket(e.to_string()))),
            }
        }
    }
}

pub struct StreamIngester {
    config: StreamConfig,
    sink: Arc<dyn PriceUpdateSink>,
    feeds: Vec<B256>,
    max_age_sec: u64,
}

impl StreamIngester {
    pub fn new(
        config: StreamConfig,
        sink: Arc<dyn PriceUpdateSink>,
        feeds: Vec<B256>,
        max_age_sec: u64,
    ) -> Self {
        Self {
            config,
            sink,
            feeds,
            max_age_sec,
        }
    }

    pub async fn run(self) {
        let mut backoff = self.config.reconnect_backoff;
        loop {
            match self.connect_and_pump().await {
                Ok(()) => {
                    backoff = self.config.reconnect_backoff;
                    debug!(
                        backoff_ms = backoff.as_millis(),
                        "chainlink stream ended, reconnecting after backoff"
                    );
                    sleep(backoff).await;
                }
                Err(e) => {
                    if matches!(e, StreamError::WebSocket(_)) {
                        info!(error = %e, backoff_ms = backoff.as_millis(), "chainlink stream disconnected, reconnecting after backoff");
                    } else {
                        warn!(error = %e, backoff_ms = backoff.as_millis(), "chainlink stream error, reconnecting after backoff");
                    }
                    sleep(backoff).await;
                    backoff = (backoff * 2).min(self.config.max_reconnect_backoff);
                }
            }
        }
    }

    async fn connect_and_pump(&self) -> Result<(), StreamError> {
        info!(
            endpoint = %self.config.ws_endpoint,
            feeds = self.feeds.len(),
            "connecting chainlink stream"
        );
        let mut stream = ChainlinkStream::connect(&self.config, &self.feeds).await?;
        info!("chainlink stream connected");
        while let Some(report) = stream.next_report().await {
            match report {
                Ok(report) => self.cache_report(report),
                Err(StreamError::Malformed(m)) => warn!(error = %m, "skipping malformed report"),
                Err(StreamError::Closed) => return Ok(()),
                Err(e) => return Err(e),
            }
        }
        Ok(())
    }

    fn cache_report(&self, report: RawReport) {
        let received_at = now_secs();
        if let Err(e) = crate::verification::verify(
            report.feed_id,
            &report.full_report,
            received_at,
            self.max_age_sec,
        ) {
            warn!(feed_id = %report.feed_id, error = %e, "dropping report that failed verification");
            return;
        }
        debug!(
            feed_id = %report.feed_id,
            payload_len = report.full_report.len(),
            "cached chainlink report"
        );
        self.sink.insert(SignedPriceUpdate {
            key: FeedKey::new(provider_id(), report.feed_id),
            payload: report.full_report,
            received_at,
            source_time: report.source_time,
        });
    }
}

fn subscription_path(feeds: &[B256]) -> String {
    let ids = feeds
        .iter()
        .map(|f| format!("0x{}", hex::encode(f.as_slice())))
        .collect::<Vec<_>>()
        .join(",");
    format!("{WS_PATH}?feedIDs={ids}")
}

fn parse_report_message(bytes: &[u8]) -> Result<RawReport, StreamError> {
    let message: WsMessage =
        serde_json::from_slice(bytes).map_err(|e| StreamError::Malformed(e.to_string()))?;
    let feed_id = decode_feed_id(&message.report.feed_id)?;
    let full_report = decode_hex(&message.report.full_report, "fullReport")?;
    if full_report.is_empty() {
        return Err(StreamError::Malformed("empty fullReport".into()));
    }
    Ok(RawReport {
        feed_id,
        full_report,
        source_time: message.report.observations_timestamp,
    })
}

fn decode_feed_id(raw: &str) -> Result<B256, StreamError> {
    let bytes = decode_hex(raw, "feedID")?;
    let arr: [u8; 32] = bytes
        .try_into()
        .map_err(|_| StreamError::Malformed(format!("feedID must be 32 bytes: {raw}")))?;
    Ok(B256::from(arr))
}

fn decode_hex(raw: &str, what: &str) -> Result<Vec<u8>, StreamError> {
    hex::decode(raw.strip_prefix("0x").unwrap_or(raw))
        .map_err(|e| StreamError::Malformed(format!("invalid hex for {what}: {e}")))
}

fn unix_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[derive(Debug, Deserialize)]
struct WsMessage {
    report: WsReport,
}

#[derive(Debug, Deserialize)]
struct WsReport {
    #[serde(rename = "feedID")]
    feed_id: String,
    #[serde(rename = "fullReport")]
    full_report: String,
    #[serde(default, rename = "observationsTimestamp")]
    observations_timestamp: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed(suffix: u8) -> B256 {
        let mut bytes = [0u8; 32];
        bytes[1] = 0x03;
        bytes[31] = suffix;
        B256::from(bytes)
    }

    #[test]
    fn subscription_path_joins_feed_ids() {
        let path = subscription_path(&[feed(0x01), feed(0x02)]);
        assert_eq!(
            path,
            "/api/v1/ws?feedIDs=0x0003000000000000000000000000000000000000000000000000000000000001,\
             0x0003000000000000000000000000000000000000000000000000000000000002"
        );
    }

    #[test]
    fn parses_pushed_report_frame() {
        let json = r#"{
            "report": {
                "feedID": "0x0003000000000000000000000000000000000000000000000000000000000001",
                "fullReport": "0xdeadbeef",
                "validFromTimestamp": 1718998800,
                "observationsTimestamp": 1718998800
            }
        }"#;
        let report = parse_report_message(json.as_bytes()).unwrap();
        assert_eq!(report.feed_id, feed(0x01));
        assert_eq!(report.full_report, vec![0xde, 0xad, 0xbe, 0xef]);
        assert_eq!(report.source_time, 1718998800);
    }

    #[test]
    fn parses_report_without_0x_prefix() {
        let json = r#"{"report":{"feedID":"0003000000000000000000000000000000000000000000000000000000000001","fullReport":"00ff"}}"#;
        let report = parse_report_message(json.as_bytes()).unwrap();
        assert_eq!(report.feed_id, feed(0x01));
        assert_eq!(report.full_report, vec![0x00, 0xff]);
    }

    #[test]
    fn rejects_non_report_json() {
        assert!(matches!(
            parse_report_message(br#"{"error":"unauthorized"}"#),
            Err(StreamError::Malformed(_))
        ));
    }

    #[test]
    fn rejects_short_feed_id() {
        let json = r#"{"report":{"feedID":"0x0003","fullReport":"0xdeadbeef"}}"#;
        assert!(matches!(
            parse_report_message(json.as_bytes()),
            Err(StreamError::Malformed(_))
        ));
    }

    #[test]
    fn rejects_empty_full_report() {
        let json = r#"{"report":{"feedID":"0x0003000000000000000000000000000000000000000000000000000000000001","fullReport":"0x"}}"#;
        assert!(matches!(
            parse_report_message(json.as_bytes()),
            Err(StreamError::Malformed(_))
        ));
    }
}
