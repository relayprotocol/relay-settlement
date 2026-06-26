use std::time::Duration;

use alloy_primitives::{Address, B256};
use anyhow::Result;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use reqwest::{Client, StatusCode, Url};
use serde::Deserialize;
use serde_json::value::RawValue;
use tokio::time::sleep;
use tracing::{debug, info, instrument, warn};

use crate::Context;
use crate::cache::{
    FeedKey, IpcServerSink, PriceUpdateSink, SignedPriceUpdate, now_unix, provider_id,
};
use crate::config::{Config, RedstoneFeed};
use crate::payload::{
    PayloadError, assemble_payload, feed_id_from_symbol, recover_signer, scale_value,
    serialize_data_point, serialize_signable,
};

const DEFAULT_RECONNECT_BACKOFF: Duration = Duration::from_secs(1);
const DEFAULT_MAX_RECONNECT_BACKOFF: Duration = Duration::from_secs(30);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_TIMESTAMP_AGE: Duration = Duration::from_secs(300);
const MAX_TIMESTAMP_AHEAD: Duration = Duration::from_secs(60);

#[instrument(skip_all)]
pub async fn run(ctx: Context) -> Result<()> {
    let client = GatewayClient::new(&ctx.config)?;
    let sink = IpcServerSink {
        cache: ctx.cache.clone(),
    };
    info!(
        provider_id = %provider_id(),
        feed_count = ctx.config.feeds.len(),
        gateway = %ctx.config.gateway_url,
        data_service = %ctx.config.data_service_id,
        "starting redstone ingester"
    );

    let mut backoff = DEFAULT_RECONNECT_BACKOFF;
    loop {
        match client.fetch().await {
            Ok(response) => {
                process_response(&response, &ctx.config, &sink);
                backoff = DEFAULT_RECONNECT_BACKOFF;
                sleep(ctx.config.poll_interval).await;
            }
            Err(e) => {
                if matches!(e, GatewayError::Http(_)) {
                    info!(error = %e, backoff_ms = backoff.as_millis(), "redstone gateway poll failed, retrying after backoff");
                } else {
                    warn!(error = %e, backoff_ms = backoff.as_millis(), "redstone gateway error, retrying after backoff");
                }
                sleep(jittered(backoff)).await;
                backoff = (backoff * 2).min(DEFAULT_MAX_RECONNECT_BACKOFF);
            }
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum GatewayError {
    #[error("invalid gateway url: {0}")]
    InvalidUrl(String),
    #[error("http transport error: {0}")]
    Http(String),
    #[error("gateway returned HTTP {status}: {body}")]
    HttpStatus { status: StatusCode, body: String },
    #[error("gateway rate limited the request")]
    RateLimited,
    #[error("malformed gateway payload: {0}")]
    Malformed(String),
}

type GatewayResponse = std::collections::HashMap<String, Vec<GatewayPackage>>;

#[derive(Debug, Deserialize)]
struct GatewayPackage {
    #[serde(rename = "timestampMilliseconds")]
    timestamp_ms: u64,
    signature: String,
    #[serde(rename = "dataPoints")]
    data_points: Vec<GatewayDataPoint>,
    #[serde(rename = "signerAddress")]
    signer_address: String,
}

#[derive(Debug, Deserialize)]
struct GatewayDataPoint {
    #[serde(rename = "dataFeedId")]
    data_feed_id: String,
    value: Box<RawValue>,
}

struct GatewayClient {
    http: Client,
    url: Url,
}

impl GatewayClient {
    fn new(config: &Config) -> Result<Self, GatewayError> {
        let base = config.gateway_url.trim_end_matches('/');
        let url = format!("{base}/data-packages/latest/{}", config.data_service_id)
            .parse::<Url>()
            .map_err(|e| GatewayError::InvalidUrl(e.to_string()))?;
        let http = Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|e| GatewayError::Http(e.to_string()))?;
        Ok(Self { http, url })
    }

    async fn fetch(&self) -> Result<GatewayResponse, GatewayError> {
        let response = self
            .http
            .get(self.url.clone())
            .send()
            .await
            .map_err(|e| GatewayError::Http(e.to_string()))?;
        if response.status() == StatusCode::TOO_MANY_REQUESTS {
            return Err(GatewayError::RateLimited);
        }
        if !response.status().is_success() {
            return Err(GatewayError::HttpStatus {
                status: response.status(),
                body: response.text().await.unwrap_or_default(),
            });
        }
        response
            .json::<GatewayResponse>()
            .await
            .map_err(|e| GatewayError::Malformed(e.to_string()))
    }
}

fn process_response(response: &GatewayResponse, config: &Config, sink: &dyn PriceUpdateSink) {
    for feed in &config.feeds {
        let Some(packages) = response.get(&feed.symbol) else {
            warn!(symbol = %feed.symbol, "feed missing from gateway response");
            continue;
        };
        if let Some(update) = build_feed_update(feed, packages, config.min_signers, now_unix()) {
            sink.insert(update);
        }
    }
}

fn build_feed_update(
    feed: &RedstoneFeed,
    packages: &[GatewayPackage],
    min_signers: usize,
    now_secs: u64,
) -> Option<SignedPriceUpdate> {
    let mut verified: Vec<(Vec<u8>, Address, u64)> = Vec::with_capacity(packages.len());

    for package in packages {
        match verify_package(package, feed.feed_id) {
            Ok((bytes, signer)) => {
                if verified.iter().any(|(_, seen, _)| *seen == signer) {
                    debug!(symbol = %feed.symbol, %signer, "duplicate signer, skipping");
                    continue;
                }
                verified.push((bytes, signer, package.timestamp_ms));
            }
            Err(e) => {
                warn!(symbol = %feed.symbol, error = %e, "dropping package that failed self-verification")
            }
        }
    }

    let Some(reference_ms) = verified.iter().map(|(_, _, ts)| *ts).max() else {
        warn!(symbol = %feed.symbol, "no verified packages, skipping feed");
        return None;
    };

    let before = verified.len();
    verified.retain(|(_, _, ts)| *ts == reference_ms);
    if verified.len() != before {
        warn!(
            symbol = %feed.symbol,
            dropped = before - verified.len(),
            "dropping packages with inconsistent timestamps"
        );
    }

    let timestamp_secs = reference_ms / 1000;
    if !timestamp_fresh(timestamp_secs, now_secs) {
        warn!(
            symbol = %feed.symbol,
            timestamp_secs,
            now_secs,
            "dropping feed with stale or future timestamp"
        );
        return None;
    }

    if verified.len() < min_signers {
        warn!(
            symbol = %feed.symbol,
            verified = verified.len(),
            required = min_signers,
            "insufficient verified signers, skipping feed"
        );
        return None;
    }

    let serialized: Vec<Vec<u8>> = verified.into_iter().map(|(bytes, _, _)| bytes).collect();
    let payload = assemble_payload(&serialized);
    debug!(
        symbol = %feed.symbol,
        signers = serialized.len(),
        payload_len = payload.len(),
        "assembled redstone payload"
    );
    Some(SignedPriceUpdate {
        key: FeedKey::new(provider_id(), feed.feed_id),
        payload,
        received_at: now_secs,
    })
}

fn timestamp_fresh(timestamp_secs: u64, now_secs: u64) -> bool {
    if timestamp_secs > now_secs + MAX_TIMESTAMP_AHEAD.as_secs() {
        return false;
    }
    timestamp_secs + MAX_TIMESTAMP_AGE.as_secs() >= now_secs
}

fn verify_package(
    package: &GatewayPackage,
    expected_feed: B256,
) -> Result<(Vec<u8>, Address), VerifyError> {
    let signature = BASE64
        .decode(package.signature.as_bytes())
        .map_err(|e| VerifyError::Signature(e.to_string()))?;

    let mut data_points = Vec::with_capacity(package.data_points.len() * 64);
    let mut has_expected_feed = false;
    for point in &package.data_points {
        let feed_id = feed_id_from_symbol(&point.data_feed_id)?;
        let value = scale_value(point.value.get())?;
        if value.is_zero() {
            return Err(VerifyError::NonPositiveValue(feed_id));
        }
        if feed_id == expected_feed {
            has_expected_feed = true;
        }
        data_points.extend_from_slice(&serialize_data_point(feed_id, value));
    }

    if !has_expected_feed {
        return Err(VerifyError::FeedMismatch(expected_feed));
    }

    let signable = serialize_signable(
        &data_points,
        package.data_points.len(),
        package.timestamp_ms,
    );
    let recovered = recover_signer(&signable, &signature)?;

    let expected = package
        .signer_address
        .parse::<Address>()
        .map_err(|e| VerifyError::SignerAddress(e.to_string()))?;
    if recovered != expected {
        return Err(VerifyError::SignerMismatch {
            expected,
            recovered,
        });
    }

    let mut full = signable;
    full.extend_from_slice(&signature);
    Ok((full, recovered))
}

#[derive(Debug, thiserror::Error)]
enum VerifyError {
    #[error("invalid base64 signature: {0}")]
    Signature(String),
    #[error("invalid signer address: {0}")]
    SignerAddress(String),
    #[error(transparent)]
    Payload(#[from] PayloadError),
    #[error("requested feed {0} not present in package")]
    FeedMismatch(B256),
    #[error("non-positive value for feed {0}")]
    NonPositiveValue(B256),
    #[error("recovered signer {recovered} does not match reported {expected}")]
    SignerMismatch {
        expected: Address,
        recovered: Address,
    },
}

fn jittered(delay: Duration) -> Duration {
    let factor = 1.0 + rand::random::<f64>();
    delay.mul_f64(factor)
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy_primitives::keccak256;
    use k256::ecdsa::SigningKey;

    fn signed_package(
        key: &SigningKey,
        symbol: &str,
        value: &str,
        timestamp_ms: u64,
    ) -> GatewayPackage {
        let feed_id = feed_id_from_symbol(symbol).unwrap();
        let scaled = scale_value(value).unwrap();
        let point = serialize_data_point(feed_id, scaled);
        let signable = serialize_signable(&point, 1, timestamp_ms);
        let digest = keccak256(&signable);
        let (sig, recid) = key.sign_prehash_recoverable(digest.as_slice()).unwrap();
        let mut signature = sig.to_bytes().to_vec();
        signature.push(27 + recid.to_byte());

        let address = {
            let p = key.verifying_key().to_encoded_point(false);
            Address::from_slice(&keccak256(&p.as_bytes()[1..])[12..])
        };

        GatewayPackage {
            timestamp_ms,
            signature: BASE64.encode(&signature),
            data_points: vec![GatewayDataPoint {
                data_feed_id: symbol.to_string(),
                value: RawValue::from_string(value.to_string()).unwrap(),
            }],
            signer_address: format!("{address:?}"),
        }
    }

    fn feed(symbol: &str) -> RedstoneFeed {
        RedstoneFeed {
            symbol: symbol.to_string(),
            feed_id: feed_id_from_symbol(symbol).unwrap(),
        }
    }

    fn eth() -> B256 {
        feed_id_from_symbol("ETH").unwrap()
    }

    #[test]
    fn verify_package_accepts_correctly_signed_package() {
        let key = SigningKey::from_slice(&[0x22u8; 32]).unwrap();
        let package = signed_package(&key, "ETH", "3120.55", 1_700_000_000_000);
        let (bytes, _signer) = verify_package(&package, eth()).unwrap();
        assert_eq!(bytes.len(), 64 + 6 + 4 + 3 + 65);
    }

    #[test]
    fn verify_package_rejects_wrong_signer_address() {
        let key = SigningKey::from_slice(&[0x22u8; 32]).unwrap();
        let mut package = signed_package(&key, "ETH", "3120.55", 1_700_000_000_000);
        package.signer_address = "0x0000000000000000000000000000000000000001".to_string();
        assert!(matches!(
            verify_package(&package, eth()),
            Err(VerifyError::SignerMismatch { .. })
        ));
    }

    #[test]
    fn verify_package_rejects_feed_mismatch() {
        let key = SigningKey::from_slice(&[0x22u8; 32]).unwrap();
        let package = signed_package(&key, "BTC", "60000", 1_700_000_000_000);
        assert!(matches!(
            verify_package(&package, eth()),
            Err(VerifyError::FeedMismatch(_))
        ));
    }

    #[test]
    fn verify_package_rejects_non_positive_value() {
        let key = SigningKey::from_slice(&[0x22u8; 32]).unwrap();
        let package = signed_package(&key, "ETH", "0", 1_700_000_000_000);
        assert!(matches!(
            verify_package(&package, eth()),
            Err(VerifyError::NonPositiveValue(_))
        ));
    }

    #[test]
    fn build_feed_update_meets_threshold_and_dedupes() {
        let keys: Vec<_> = (0u8..3)
            .map(|i| SigningKey::from_slice(&[i + 1; 32]).unwrap())
            .collect();
        let mut packages: Vec<_> = keys
            .iter()
            .map(|k| signed_package(k, "ETH", "3120.55", 1_700_000_000_000))
            .collect();
        packages.push(signed_package(
            &keys[0],
            "ETH",
            "3120.55",
            1_700_000_000_000,
        ));

        let update = build_feed_update(&feed("ETH"), &packages, 3, 1_700_000_000).unwrap();
        assert_eq!(update.key.feed_id, eth());
        assert_eq!(update.received_at, 1_700_000_000);
        assert_eq!(
            &update.payload[update.payload.len() - 9..],
            &[0, 0, 2, 0xed, 0x57, 1, 0x1e, 0, 0]
        );
    }

    #[test]
    fn build_feed_update_below_threshold_returns_none() {
        let key = SigningKey::from_slice(&[0x22u8; 32]).unwrap();
        let packages = vec![signed_package(&key, "ETH", "3120.55", 1_700_000_000_000)];
        assert!(build_feed_update(&feed("ETH"), &packages, 3, 1_700_000_000).is_none());
    }

    #[test]
    fn build_feed_update_drops_inconsistent_timestamps() {
        let keys: Vec<_> = (0u8..3)
            .map(|i| SigningKey::from_slice(&[i + 1; 32]).unwrap())
            .collect();
        let mut packages: Vec<_> = keys
            .iter()
            .map(|k| signed_package(k, "ETH", "3120.55", 1_700_000_000_000))
            .collect();
        let straggler = SigningKey::from_slice(&[0x44u8; 32]).unwrap();
        packages.push(signed_package(
            &straggler,
            "ETH",
            "3120.55",
            1_699_999_990_000,
        ));

        let update = build_feed_update(&feed("ETH"), &packages, 3, 1_700_000_000).unwrap();
        assert_eq!(update.received_at, 1_700_000_000);
    }

    #[test]
    fn build_feed_update_rejects_stale_timestamp() {
        let keys: Vec<_> = (0u8..3)
            .map(|i| SigningKey::from_slice(&[i + 1; 32]).unwrap())
            .collect();
        let packages: Vec<_> = keys
            .iter()
            .map(|k| signed_package(k, "ETH", "3120.55", 1_700_000_000_000))
            .collect();

        assert!(build_feed_update(&feed("ETH"), &packages, 3, 1_700_001_000).is_none());
    }
}
