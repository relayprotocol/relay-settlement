use std::env;
use std::time::Duration;

use alloy_primitives::B256;
use anyhow::{Context as _, Result, anyhow};
use price_oracle_ipc::Endpoint;
use tracing::instrument;

const DEFAULT_HERMES_ENDPOINT: &str = "https://hermes.pyth.network";
const DEFAULT_TRANSPORT: &str = "tcp";
const DEFAULT_SOCKET_ADDRESS: &str = "127.0.0.1:9802";
const DEFAULT_SOCKET_PATH: &str = "/run/relay/pyth.sock";
const DEFAULT_HEARTBEAT_SEC: u64 = 10;
const DEFAULT_OTEL_SAMPLE_RATIO: f64 = 1.0;

#[derive(Clone, Debug)]
pub struct Config {
    pub listen_endpoint: Endpoint,
    pub hermes_endpoint: String,
    pub api_key: Option<String>,
    pub feed_ids: Vec<B256>,
    pub heartbeat_interval: Duration,
    pub write_timeout: Duration,
    pub telemetry: Option<TelemetryConfig>,
}

#[derive(Clone, Debug)]
pub struct TelemetryConfig {
    pub endpoint: String,
    pub service_name: String,
    pub sample_ratio: f64,
}

#[instrument(skip_all)]
pub fn get() -> Result<Config> {
    let heartbeat_interval = parse_heartbeat_interval()?;
    Ok(Config {
        listen_endpoint: parse_endpoint()?,
        hermes_endpoint: optional_env("HERMES_ENDPOINT")
            .unwrap_or_else(|| DEFAULT_HERMES_ENDPOINT.to_string()),
        api_key: optional_env("HERMES_API_KEY"),
        feed_ids: parse_feed_ids(&required_env("PYTH_FEED_IDS")?)?,
        write_timeout: parse_write_timeout(heartbeat_interval)?,
        heartbeat_interval,
        telemetry: parse_telemetry()?,
    })
}

fn parse_telemetry() -> Result<Option<TelemetryConfig>> {
    let Some(raw) = optional_env("OTEL_EXPORTER_ENABLE") else {
        return Ok(None);
    };
    let enabled = match raw.to_ascii_lowercase().as_str() {
        "true" => true,
        "false" => false,
        other => {
            return Err(anyhow!(
                "OTEL_EXPORTER_ENABLE must be \"true\" or \"false\", got \"{other}\""
            ));
        }
    };
    if !enabled {
        return Ok(None);
    }

    let endpoint = required_env("OTEL_EXPORTER_ENDPOINT")?;
    if !(endpoint.starts_with("http://") || endpoint.starts_with("https://")) {
        return Err(anyhow!(
            "OTEL_EXPORTER_ENDPOINT must start with \"http://\" or \"https://\", got \"{endpoint}\""
        ));
    }

    Ok(Some(TelemetryConfig {
        endpoint,
        service_name: optional_env("OTEL_SERVICE_NAME")
            .unwrap_or_else(|| env!("CARGO_PKG_NAME").to_string()),
        sample_ratio: parse_sample_ratio()?,
    }))
}

fn parse_sample_ratio() -> Result<f64> {
    let Some(raw) = optional_env("OTEL_TRACES_SAMPLE_RATIO") else {
        return Ok(DEFAULT_OTEL_SAMPLE_RATIO);
    };
    let ratio = raw
        .parse::<f64>()
        .context("OTEL_TRACES_SAMPLE_RATIO must be a number between 0.0 and 1.0")?;
    if !(0.0..=1.0).contains(&ratio) {
        return Err(anyhow!(
            "OTEL_TRACES_SAMPLE_RATIO must be between 0.0 and 1.0, got {ratio}"
        ));
    }
    Ok(ratio)
}

fn parse_endpoint() -> Result<Endpoint> {
    let transport =
        optional_env("INGESTER_TRANSPORT").unwrap_or_else(|| DEFAULT_TRANSPORT.to_string());
    match transport.as_str() {
        "tcp" => Ok(Endpoint::tcp(
            optional_env("INGESTER_SOCKET_ADDRESS")
                .unwrap_or_else(|| DEFAULT_SOCKET_ADDRESS.to_string()),
        )),
        "unix" => Ok(Endpoint::unix(
            optional_env("INGESTER_SOCKET_PATH").unwrap_or_else(|| DEFAULT_SOCKET_PATH.to_string()),
        )),
        other => Err(anyhow!(
            "INGESTER_TRANSPORT must be \"tcp\" or \"unix\", got \"{other}\""
        )),
    }
}

fn parse_write_timeout(heartbeat: Duration) -> Result<Duration> {
    let Some(raw) = optional_env("INGESTER_WRITE_TIMEOUT_SEC") else {
        return Ok(heartbeat * 3);
    };
    let secs = raw
        .parse::<u64>()
        .context("INGESTER_WRITE_TIMEOUT_SEC must be a positive integer")?;
    if secs == 0 {
        return Err(anyhow!(
            "INGESTER_WRITE_TIMEOUT_SEC must be greater than zero"
        ));
    }
    Ok(Duration::from_secs(secs))
}

fn parse_heartbeat_interval() -> Result<Duration> {
    let Some(raw) = optional_env("INGESTER_HEARTBEAT_SEC") else {
        return Ok(Duration::from_secs(DEFAULT_HEARTBEAT_SEC));
    };
    let secs = raw
        .parse::<u64>()
        .context("INGESTER_HEARTBEAT_SEC must be a positive integer")?;
    if secs == 0 {
        return Err(anyhow!("INGESTER_HEARTBEAT_SEC must be greater than zero"));
    }
    Ok(Duration::from_secs(secs))
}

fn required_env(name: &'static str) -> Result<String> {
    match env::var(name) {
        Ok(value) if !value.is_empty() => Ok(value),
        Ok(_) => Err(anyhow!("environment variable {name} is set but empty")),
        Err(_) => Err(anyhow!("missing required environment variable {name}")),
    }
}

fn optional_env(name: &'static str) -> Option<String> {
    match env::var(name) {
        Ok(value) if !value.is_empty() => Some(value),
        _ => None,
    }
}

fn parse_feed_ids(raw: &str) -> Result<Vec<B256>> {
    let mut feed_ids = Vec::new();
    for (idx, item) in raw.split(',').enumerate() {
        let trimmed = item.trim();
        if trimmed.is_empty() {
            continue;
        }
        let raw_hex = trimmed.strip_prefix("0x").unwrap_or(trimmed);
        let bytes = hex::decode(raw_hex)
            .with_context(|| format!("PYTH_FEED_IDS[{idx}] is not valid hex: {trimmed}"))?;
        let arr: [u8; 32] = bytes.try_into().map_err(|got: Vec<u8>| {
            anyhow!(
                "PYTH_FEED_IDS[{idx}] must be exactly 32 bytes, got {} bytes",
                got.len()
            )
        })?;
        feed_ids.push(B256::from(arr));
    }
    if feed_ids.is_empty() {
        return Err(anyhow!("PYTH_FEED_IDS must contain at least one feed id"));
    }
    Ok(feed_ids)
}

#[cfg(test)]
mod tests {
    use super::parse_feed_ids;

    #[test]
    fn parse_feed_ids_accepts_single_id() {
        let raw = "0x0003000000000000000000000000000000000000000000000000000000000001";
        let ids = parse_feed_ids(raw).unwrap();
        assert_eq!(ids.len(), 1);
        assert_eq!(ids[0].as_slice()[1], 0x03);
        assert_eq!(ids[0].as_slice()[31], 0x01);
    }

    #[test]
    fn parse_feed_ids_accepts_multiple_with_whitespace() {
        let raw = "
            0x0003000000000000000000000000000000000000000000000000000000000001,
            0003000000000000000000000000000000000000000000000000000000000002
        ";
        let ids = parse_feed_ids(raw).unwrap();
        assert_eq!(ids.len(), 2);
    }

    #[test]
    fn parse_feed_ids_rejects_short_id() {
        assert!(parse_feed_ids("0x0003").is_err());
    }

    #[test]
    fn parse_feed_ids_rejects_non_hex() {
        assert!(parse_feed_ids("not-hex").is_err());
    }

    #[test]
    fn parse_feed_ids_rejects_empty() {
        assert!(parse_feed_ids("").is_err());
        assert!(parse_feed_ids("  ,  ").is_err());
    }
}
