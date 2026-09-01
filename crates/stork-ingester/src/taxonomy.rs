use std::collections::HashMap;
use std::time::Duration;

use alloy_primitives::{B256, keccak256};
use anyhow::{Context as _, Result, anyhow};
use serde::Deserialize;
use tracing::instrument;

use crate::config::ConfiguredFeed;

pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
pub const MAX_ATTEMPTS: u32 = 3;
pub const RETRY_BACKOFF: Duration = Duration::from_secs(2);

const API_PATH: &str = "/v1/taxonomy";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FastAsset {
    pub symbol: String,
    pub asset_id: u16,
    pub feed_id: B256,
}

#[derive(Clone, Debug)]
pub struct FeedSet {
    pub taxonomy_id: u16,
    pub assets: Vec<FastAsset>,
    pub feed_ids: Vec<B256>,
}

pub fn fast_feed_id(taxonomy_id: u16, asset_id: u16) -> B256 {
    let mut preimage = [0u8; 4];
    preimage[..2].copy_from_slice(&taxonomy_id.to_be_bytes());
    preimage[2..].copy_from_slice(&asset_id.to_be_bytes());
    keccak256(preimage)
}

#[derive(Debug, Deserialize)]
pub struct TaxonomyResponse {
    taxonomy_id: u16,
    assets: Vec<TaxonomyAsset>,
}

#[derive(Debug, Deserialize)]
struct TaxonomyAsset {
    name: String,
    asset_id: u16,
}

#[instrument(target = "ingest", name = "taxonomy_fetch", skip_all)]
pub async fn fetch(ws_endpoint: &str, auth_token: &str) -> Result<TaxonomyResponse> {
    let url = taxonomy_url(ws_endpoint);
    reqwest::Client::new()
        .get(&url)
        .header("authorization", format!("Basic {auth_token}"))
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .with_context(|| format!("failed to request taxonomy from {url}"))?
        .error_for_status()
        .context("taxonomy request returned an error status")?
        .json::<TaxonomyResponse>()
        .await
        .context("failed to decode taxonomy response")
}

pub fn validate(
    taxonomy_id: u16,
    feeds: &[ConfiguredFeed],
    response: TaxonomyResponse,
) -> Result<FeedSet> {
    if response.taxonomy_id != taxonomy_id {
        return Err(anyhow!(
            "configured taxonomy {taxonomy_id} does not match Stork taxonomy {}",
            response.taxonomy_id
        ));
    }

    let ids: HashMap<String, u16> = response
        .assets
        .into_iter()
        .map(|a| (a.name, a.asset_id))
        .collect();

    let mut assets = Vec::with_capacity(feeds.len());
    for feed in feeds {
        match ids.get(&feed.symbol) {
            None => {
                return Err(anyhow!(
                    "symbol {} is not present in Stork taxonomy {taxonomy_id}",
                    feed.symbol
                ));
            }
            Some(&id) if id != feed.asset_id => {
                return Err(anyhow!(
                    "symbol {} maps to asset id {id} in Stork taxonomy {taxonomy_id}, config says {}",
                    feed.symbol,
                    feed.asset_id
                ));
            }
            Some(_) => {}
        }
        assets.push(FastAsset {
            symbol: feed.symbol.clone(),
            asset_id: feed.asset_id,
            feed_id: fast_feed_id(taxonomy_id, feed.asset_id),
        });
    }
    let feed_ids = assets.iter().map(|a| a.feed_id).collect();
    Ok(FeedSet {
        taxonomy_id,
        assets,
        feed_ids,
    })
}

fn taxonomy_url(ws_endpoint: &str) -> String {
    let trimmed = ws_endpoint.trim_end_matches('/');
    let base = if let Some(rest) = trimmed.strip_prefix("wss://") {
        format!("https://{rest}")
    } else if let Some(rest) = trimmed.strip_prefix("ws://") {
        format!("http://{rest}")
    } else {
        trimmed.to_string()
    };
    format!("{base}{API_PATH}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn response() -> TaxonomyResponse {
        serde_json::from_str(
            r#"{"taxonomy_id":1,"assets":[
                {"name":"BTCUSD","asset_id":3},
                {"name":"USDTUSD","asset_id":1},
                {"name":"SOLUSD","asset_id":40}
            ]}"#,
        )
        .unwrap()
    }

    fn feed(symbol: &str, asset_id: u16) -> ConfiguredFeed {
        ConfiguredFeed {
            symbol: symbol.into(),
            asset_id,
        }
    }

    #[test]
    fn validates_config_against_taxonomy() {
        let feeds = validate(1, &[feed("BTCUSD", 3), feed("USDTUSD", 1)], response()).unwrap();
        assert_eq!(feeds.taxonomy_id, 1);
        assert_eq!(feeds.assets[0].asset_id, 3);
        assert_eq!(feeds.assets[1].asset_id, 1);
        assert_eq!(feeds.assets[0].feed_id, fast_feed_id(1, 3));
        assert_eq!(feeds.feed_ids.len(), 2);
    }

    #[test]
    fn rejects_taxonomy_mismatch() {
        assert!(validate(2, &[feed("BTCUSD", 3)], response()).is_err());
    }

    #[test]
    fn rejects_asset_id_disagreeing_with_taxonomy() {
        assert!(validate(1, &[feed("BTCUSD", 999)], response()).is_err());
    }

    #[test]
    fn fast_feed_id_matches_adapter_encoding() {
        assert_eq!(
            fast_feed_id(1, 3),
            "0x2675065076b5e69b60497bd3cf1d151029073424bb8c5b65a5921da77beb6ad8"
                .parse::<B256>()
                .unwrap()
        );
        assert_eq!(
            fast_feed_id(1, 42),
            "0xa301ac32868bda4a03c9abfd150992bc94b21c1088a05b5eacfe201ecb27d47f"
                .parse::<B256>()
                .unwrap()
        );
        assert_ne!(fast_feed_id(14, 48), fast_feed_id(1, 448));
    }

    #[test]
    fn rejects_symbol_absent_from_taxonomy() {
        assert!(validate(1, &[feed("DOGEUSD", 1)], response()).is_err());
    }

    #[test]
    fn derives_taxonomy_url_from_ws_scheme() {
        assert_eq!(
            taxonomy_url("wss://fast.jp.stork-oracle.network"),
            "https://fast.jp.stork-oracle.network/v1/taxonomy"
        );
        assert_eq!(
            taxonomy_url("ws://localhost:8080/"),
            "http://localhost:8080/v1/taxonomy"
        );
    }
}
