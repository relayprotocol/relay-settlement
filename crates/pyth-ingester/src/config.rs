use std::env;

use alloy_primitives::B256;
use anyhow::{Context as _, Result, anyhow};
use tracing::instrument;

const DEFAULT_HERMES_ENDPOINT: &str = "https://hermes.pyth.network";
const DEFAULT_ADDRESS: &str = "127.0.0.1:9802";
const DEFAULT_OTEL_SAMPLE_RATIO: f64 = 1.0;

#[derive(Clone, Debug)]
pub struct Config {
    pub listen_address: String,
    pub hermes_endpoint: String,
    pub api_key: Option<String>,
    pub feed_ids: Vec<B256>,
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
    Ok(Config {
        listen_address: parse_listen_address(),
        hermes_endpoint: optional_env("HERMES_ENDPOINT")
            .unwrap_or_else(|| DEFAULT_HERMES_ENDPOINT.to_string()),
        api_key: optional_env("HERMES_API_KEY"),
        feed_ids: parse_feed_ids(&required_env("PYTH_FEED_IDS")?)?,
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

fn parse_listen_address() -> String {
    optional_env("INGESTER_ADDRESS").unwrap_or_else(|| DEFAULT_ADDRESS.to_string())
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
