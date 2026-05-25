//! Hardcoded price registry.
//!
//! This is the seed dataset for the precompile while we bring up the runtime
//! integration. Subsequent revisions will replace [`price_for`] with a feed
//! ingested from Redstone / Chainlink (and likely move the table out of code).

use alloy_primitives::U256;

/// Token identifier for native ether.
pub const TOKEN_ID_ETH: u64 = 1;

/// Token identifier for bitcoin.
pub const TOKEN_ID_BTC: u64 = 2;

/// Token identifier for USD Coin.
pub const TOKEN_ID_USDC: u64 = 3;

/// Fixed-point precision of every USD price returned by the precompile.
pub const USD_PRICE_DECIMALS: u8 = 8;

const ONE_USD: u128 = 10u128.pow(USD_PRICE_DECIMALS as u32);

/// Returns the USD price for a known token id, scaled by `10 **
/// USD_PRICE_DECIMALS`. Returns `None` for unknown ids.
pub fn price_for(token_id: U256) -> Option<U256> {
    let id = u64::try_from(token_id).ok()?;
    let usd = match id {
        TOKEN_ID_ETH => 3_500u128 * ONE_USD,
        TOKEN_ID_BTC => 65_000u128 * ONE_USD,
        TOKEN_ID_USDC => ONE_USD,
        _ => return None,
    };
    Some(U256::from(usd))
}
