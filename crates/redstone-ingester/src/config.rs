use std::env;
use std::time::Duration;

use alloy_primitives::B256;
use anyhow::{Context as _, Result, anyhow};
use tracing::instrument;

use crate::payload::feed_id_from_symbol;

const DEFAULT_GATEWAY_URL: &str = "https://oracle-gateway-1.a.redstone.finance";
const DEFAULT_DATA_SERVICE_ID: &str = "redstone-primary-prod";
const DEFAULT_MIN_SIGNERS: usize = 3;
const DEFAULT_POLL_INTERVAL_MS: u64 = 1000;
const DEFAULT_ADDRESS: &str = "127.0.0.1:9803";
const DEFAULT_OTEL_SAMPLE_RATIO: f64 = 1.0;

#[derive(Clone, Debug)]
pub struct RedstoneFeed {
    pub symbol: String,
    pub feed_id: B256,
}

#[derive(Clone, Debug)]
pub struct Config {
    pub listen_address: String,
    pub gateway_url: String,
    pub data_service_id: String,
    pub feeds: Vec<RedstoneFeed>,
    pub feed_ids: Vec<B256>,
    pub min_signers: usize,
    pub poll_interval: Duration,
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
    let feeds = parse_feeds(&required_env("REDSTONE_FEED_IDS")?)?;
    let feed_ids = feeds.iter().map(|f| f.feed_id).collect();
    Ok(Config {
        listen_address: parse_listen_address(),
        gateway_url: optional_env("REDSTONE_GATEWAY_URL")
            .unwrap_or_else(|| DEFAULT_GATEWAY_URL.to_string()),
        data_service_id: optional_env("REDSTONE_DATA_SERVICE_ID")
            .unwrap_or_else(|| DEFAULT_DATA_SERVICE_ID.to_string()),
        feeds,
        feed_ids,
        min_signers: parse_min_signers()?,
        poll_interval: parse_poll_interval()?,
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

fn parse_min_signers() -> Result<usize> {
    let Some(raw) = optional_env("REDSTONE_MIN_SIGNERS") else {
        return Ok(DEFAULT_MIN_SIGNERS);
    };
    let count = raw
        .parse::<usize>()
        .context("REDSTONE_MIN_SIGNERS must be a positive integer")?;
    if count == 0 {
        return Err(anyhow!("REDSTONE_MIN_SIGNERS must be greater than zero"));
    }
    Ok(count)
}

fn parse_poll_interval() -> Result<Duration> {
    let Some(raw) = optional_env("REDSTONE_POLL_INTERVAL_MS") else {
        return Ok(Duration::from_millis(DEFAULT_POLL_INTERVAL_MS));
    };
    let millis = raw
        .parse::<u64>()
        .context("REDSTONE_POLL_INTERVAL_MS must be a positive integer")?;
    if millis == 0 {
        return Err(anyhow!(
            "REDSTONE_POLL_INTERVAL_MS must be greater than zero"
        ));
    }
    Ok(Duration::from_millis(millis))
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

fn parse_feeds(raw: &str) -> Result<Vec<RedstoneFeed>> {
    let mut feeds = Vec::new();
    for item in raw.split(',') {
        let symbol = item.trim();
        if symbol.is_empty() {
            continue;
        }
        let feed_id = feed_id_from_symbol(symbol)
            .with_context(|| format!("invalid RedStone feed symbol: {symbol}"))?;
        feeds.push(RedstoneFeed {
            symbol: symbol.to_string(),
            feed_id,
        });
    }
    if feeds.is_empty() {
        return Err(anyhow!(
            "REDSTONE_FEED_IDS must contain at least one feed symbol"
        ));
    }
    Ok(feeds)
}

#[cfg(test)]
mod tests {
    use super::parse_feeds;

    #[test]
    fn parse_feeds_maps_symbols_to_ids() {
        let feeds = parse_feeds("ETH, BTC").unwrap();
        assert_eq!(feeds.len(), 2);
        assert_eq!(feeds[0].symbol, "ETH");
        assert_eq!(&feeds[0].feed_id.as_slice()[..3], b"ETH");
        assert_eq!(feeds[1].symbol, "BTC");
    }

    #[test]
    fn parse_feeds_skips_blanks() {
        let feeds = parse_feeds("ETH, , BTC,").unwrap();
        assert_eq!(feeds.len(), 2);
    }

    #[test]
    fn parse_feeds_rejects_empty() {
        assert!(parse_feeds("").is_err());
        assert!(parse_feeds("  ,  ").is_err());
    }
}
