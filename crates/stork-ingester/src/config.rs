use std::env;
use std::time::Duration;

use anyhow::{Context as _, Result, anyhow};
use tracing::instrument;

const DEFAULT_ADDRESS: &str = "127.0.0.1:9804";
const DEFAULT_MAX_AGE_SEC: u64 = 30;
const DEFAULT_CHANNEL: &str = "500ms";
const DEFAULT_IDLE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConfiguredFeed {
    pub symbol: String,
    pub asset_id: u16,
}

#[derive(Clone, Debug)]
pub struct Config {
    pub listen_address: String,
    pub ws_endpoint: String,
    pub auth_token: String,
    pub feeds: Vec<ConfiguredFeed>,
    pub taxonomy_id: u16,
    pub channel: String,
    pub compression: bool,
    pub idle_timeout: Option<Duration>,
    pub max_age_sec: u64,
    pub telemetry: Option<TelemetryConfig>,
}

#[derive(Clone, Debug)]
pub struct TelemetryConfig {
    pub endpoint: String,
    pub service_name: String,
    pub instance_id: String,
    pub auth_token: Option<String>,
}

impl TelemetryConfig {
    pub fn traces_url(&self) -> String {
        format!("{}/v1/traces", self.endpoint)
    }

    pub fn metrics_url(&self) -> String {
        format!("{}/v1/metrics", self.endpoint)
    }

    pub fn logs_url(&self) -> String {
        format!("{}/v1/logs", self.endpoint)
    }
}

#[instrument(skip_all)]
pub fn get() -> Result<Config> {
    let feeds = parse_feeds(&required_env("STORK_FEED_IDS")?)?;
    let channel = optional_env("STORK_CHANNEL_TYPE").unwrap_or_else(|| DEFAULT_CHANNEL.to_string());
    let period = channel_period(&channel)?;
    Ok(Config {
        listen_address: parse_listen_address(),
        ws_endpoint: required_env("STORK_WS_ENDPOINT")?,
        auth_token: required_env("STORK_API_KEY")?,
        feeds,
        taxonomy_id: parse_taxonomy_id()?,
        compression: parse_bool("STORK_COMPRESSION", true)?,
        idle_timeout: derive_idle_timeout(optional_env("STORK_IDLE_TIMEOUT_SEC"), period)?,
        channel,
        max_age_sec: parse_max_age_sec()?,
        telemetry: parse_telemetry()?,
    })
}

fn channel_period(channel: &str) -> Result<Option<Duration>> {
    if channel == "real_time" {
        return Ok(None);
    }
    let (number, unit): (&str, fn(u64) -> Duration) = if let Some(number) =
        channel.strip_suffix("ms")
    {
        (number, Duration::from_millis)
    } else if let Some(number) = channel.strip_suffix('s') {
        (number, Duration::from_secs)
    } else {
        return Err(anyhow!(
            "STORK_CHANNEL_TYPE must be real_time or a fixed cadence like 500ms or 1s, got {channel}"
        ));
    };
    let value = number
        .parse::<u64>()
        .with_context(|| format!("STORK_CHANNEL_TYPE has an invalid cadence: {channel}"))?;
    if value == 0 {
        return Err(anyhow!(
            "STORK_CHANNEL_TYPE cadence must be greater than zero"
        ));
    }
    Ok(Some(unit(value)))
}

fn derive_idle_timeout(
    override_raw: Option<String>,
    period: Option<Duration>,
) -> Result<Option<Duration>> {
    if let Some(raw) = override_raw {
        let secs = raw
            .parse::<u64>()
            .context("STORK_IDLE_TIMEOUT_SEC must be a non-negative integer")?;
        return Ok((secs > 0).then_some(Duration::from_secs(secs)));
    }
    Ok(period.map(|_| DEFAULT_IDLE_TIMEOUT))
}

fn parse_bool(name: &'static str, default: bool) -> Result<bool> {
    let Some(raw) = optional_env(name) else {
        return Ok(default);
    };
    match raw.to_ascii_lowercase().as_str() {
        "true" => Ok(true),
        "false" => Ok(false),
        other => Err(anyhow!("{name} must be true or false, got {other}")),
    }
}

fn parse_max_age_sec() -> Result<u64> {
    let Some(raw) = optional_env("STORK_MAX_AGE_SEC") else {
        return Ok(DEFAULT_MAX_AGE_SEC);
    };
    let secs = raw
        .parse::<u64>()
        .context("STORK_MAX_AGE_SEC must be a positive integer")?;
    if secs == 0 {
        return Err(anyhow!("STORK_MAX_AGE_SEC must be greater than zero"));
    }
    Ok(secs)
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
                "OTEL_EXPORTER_ENABLE must be true or false, got {other}"
            ));
        }
    };
    if !enabled {
        return Ok(None);
    }

    let endpoint = required_env("OTEL_EXPORTER_ENDPOINT")?;
    if !(endpoint.starts_with("http://") || endpoint.starts_with("https://")) {
        return Err(anyhow!(
            "OTEL_EXPORTER_ENDPOINT must start with http:// or https://, got {endpoint}"
        ));
    }
    let endpoint = endpoint
        .trim_end_matches('/')
        .trim_end_matches("/v1/traces")
        .to_string();

    Ok(Some(TelemetryConfig {
        endpoint,
        service_name: optional_env("OTEL_SERVICE_NAME")
            .unwrap_or_else(|| env!("CARGO_PKG_NAME").to_string()),
        instance_id: resolve_instance_id(),
        auth_token: optional_env("OTEL_EXPORTER_AUTH_TOKEN"),
    }))
}

fn resolve_instance_id() -> String {
    if let Some(hostname) = optional_env("HOSTNAME") {
        return hostname;
    }
    if let Ok(hostname) = std::fs::read_to_string("/proc/sys/kernel/hostname") {
        let hostname = hostname.trim();
        if !hostname.is_empty() {
            return hostname.to_string();
        }
    }
    format!("{:08x}", rand::random::<u32>())
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

fn parse_taxonomy_id() -> Result<u16> {
    required_env("STORK_TAXONOMY")?
        .parse::<u16>()
        .context("STORK_TAXONOMY must be a 16-bit unsigned integer")
}

fn parse_feeds(raw: &str) -> Result<Vec<ConfiguredFeed>> {
    let mut feeds: Vec<ConfiguredFeed> = Vec::new();
    for item in raw.split(',') {
        let trimmed = item.trim();
        if trimmed.is_empty() {
            continue;
        }
        let (symbol, id) = trimmed
            .split_once('=')
            .ok_or_else(|| anyhow!("STORK_FEED_IDS entry {trimmed} must be SYMBOL=assetId"))?;
        let symbol = symbol.trim();
        if symbol.is_empty() {
            return Err(anyhow!(
                "STORK_FEED_IDS entry {trimmed} has an empty symbol"
            ));
        }
        let asset_id = id
            .trim()
            .parse::<u16>()
            .with_context(|| format!("STORK_FEED_IDS asset id in {trimmed} must be a uint16"))?;
        if feeds.iter().any(|f| f.symbol == symbol) {
            return Err(anyhow!(
                "STORK_FEED_IDS contains duplicate symbol: {symbol}"
            ));
        }
        if feeds.iter().any(|f| f.asset_id == asset_id) {
            return Err(anyhow!(
                "STORK_FEED_IDS contains duplicate asset id: {asset_id}"
            ));
        }
        feeds.push(ConfiguredFeed {
            symbol: symbol.to_string(),
            asset_id,
        });
    }
    if feeds.is_empty() {
        return Err(anyhow!("STORK_FEED_IDS must contain at least one feed"));
    }
    Ok(feeds)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_feeds_trims_and_dedupes() {
        let feeds = parse_feeds(" BTCUSD=1, ETHUSD =2,SOLUSD= 3").unwrap();
        assert_eq!(
            feeds,
            vec![
                ConfiguredFeed {
                    symbol: "BTCUSD".into(),
                    asset_id: 1
                },
                ConfiguredFeed {
                    symbol: "ETHUSD".into(),
                    asset_id: 2
                },
                ConfiguredFeed {
                    symbol: "SOLUSD".into(),
                    asset_id: 3
                },
            ]
        );
        assert!(parse_feeds("").is_err());
        assert!(parse_feeds(" , ").is_err());
        assert!(parse_feeds("BTCUSD").is_err());
        assert!(parse_feeds("=1").is_err());
        assert!(parse_feeds("BTCUSD=notanumber").is_err());
        assert!(parse_feeds("BTCUSD=70000").is_err());
        assert!(parse_feeds("BTCUSD=1,BTCUSD=2").is_err());
        assert!(parse_feeds("BTCUSD=1,ETHUSD=1").is_err());
    }

    #[test]
    fn channel_period_parses_fixed_and_real_time() {
        assert_eq!(
            channel_period("500ms").unwrap(),
            Some(Duration::from_millis(500))
        );
        assert_eq!(channel_period("1s").unwrap(), Some(Duration::from_secs(1)));
        assert_eq!(channel_period("real_time").unwrap(), None);
        assert!(channel_period("fast").is_err());
        assert!(channel_period("0ms").is_err());
        assert!(channel_period("ms").is_err());
    }

    #[test]
    fn idle_timeout_defaults_to_constant_on_fixed_channels() {
        assert_eq!(
            derive_idle_timeout(None, Some(Duration::from_millis(500))).unwrap(),
            Some(DEFAULT_IDLE_TIMEOUT)
        );
        assert_eq!(
            derive_idle_timeout(None, Some(Duration::from_millis(100))).unwrap(),
            Some(DEFAULT_IDLE_TIMEOUT)
        );
        assert_eq!(derive_idle_timeout(None, None).unwrap(), None);
        assert_eq!(
            derive_idle_timeout(Some("7".into()), None).unwrap(),
            Some(Duration::from_secs(7))
        );
        assert_eq!(
            derive_idle_timeout(Some("0".into()), Some(Duration::from_secs(1))).unwrap(),
            None
        );
        assert!(derive_idle_timeout(Some("abc".into()), None).is_err());
    }
}
