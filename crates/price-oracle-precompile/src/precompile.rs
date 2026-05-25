//! Calldata-dispatching `run` function and associated types.
//!
//! Mirrors the shape of a revm `StandardPrecompileFn` (`fn(&[u8], u64) ->
//! Result<(gas_used, bytes), err>`) without taking a revm dependency.

use alloy_primitives::U256;
use alloy_sol_types::{SolCall, SolValue};

use crate::prices::price_for;
use crate::IPriceOraclePrecompile::getUsdPriceCall;

/// Flat per-call gas cost. Matches the static cost of most cheap precompiles
/// (cf. ecrecover at 3000). A future revision should benchmark and revisit.
pub const BASE_GAS_COST: u64 = 3_000;

/// Output of a successful precompile invocation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrecompileOutput {
    /// Gas consumed by this call.
    pub gas_used: u64,
    /// ABI-encoded return bytes.
    pub output: Vec<u8>,
}

/// Errors surfaced by [`run`]. Runtime adapters translate these into their
/// host's precompile error type (eg. `PrecompileErrors::Error` for revm).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PrecompileError {
    /// `gas_limit` was below [`BASE_GAS_COST`].
    OutOfGas,
    /// Calldata was shorter than a 4-byte selector.
    InvalidInputLength,
    /// Selector did not match any function in [`crate::IPriceOraclePrecompile`].
    UnknownSelector([u8; 4]),
    /// Calldata was the right length but failed ABI decoding.
    InvalidCalldata,
    /// Selector matched but the token id has no configured price.
    UnknownToken(U256),
}

impl core::fmt::Display for PrecompileError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::OutOfGas => write!(f, "out of gas"),
            Self::InvalidInputLength => write!(f, "calldata shorter than selector"),
            Self::UnknownSelector(s) => write!(
                f,
                "unknown selector 0x{:02x}{:02x}{:02x}{:02x}",
                s[0], s[1], s[2], s[3]
            ),
            Self::InvalidCalldata => write!(f, "invalid calldata"),
            Self::UnknownToken(id) => write!(f, "unknown token id {}", id),
        }
    }
}

impl std::error::Error for PrecompileError {}

/// Dispatch a precompile call.
///
/// `input` is the full EVM calldata (selector + ABI-encoded arguments).
/// `gas_limit` is the gas budget supplied by the caller.
pub fn run(input: &[u8], gas_limit: u64) -> Result<PrecompileOutput, PrecompileError> {
    if gas_limit < BASE_GAS_COST {
        return Err(PrecompileError::OutOfGas);
    }
    if input.len() < 4 {
        return Err(PrecompileError::InvalidInputLength);
    }

    let mut selector = [0u8; 4];
    selector.copy_from_slice(&input[..4]);

    match selector {
        s if s == getUsdPriceCall::SELECTOR => dispatch_get_usd_price(&input[4..]),
        other => Err(PrecompileError::UnknownSelector(other)),
    }
}

fn dispatch_get_usd_price(args: &[u8]) -> Result<PrecompileOutput, PrecompileError> {
    let call =
        getUsdPriceCall::abi_decode_raw(args).map_err(|_| PrecompileError::InvalidCalldata)?;
    let price = price_for(call.tokenId).ok_or(PrecompileError::UnknownToken(call.tokenId))?;
    Ok(PrecompileOutput {
        gas_used: BASE_GAS_COST,
        output: price.abi_encode(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::prices::{TOKEN_ID_BTC, TOKEN_ID_ETH, TOKEN_ID_USDC, USD_PRICE_DECIMALS};

    fn calldata(token_id: u64) -> Vec<u8> {
        getUsdPriceCall {
            tokenId: U256::from(token_id),
        }
        .abi_encode()
    }

    fn decode_uint(bytes: &[u8]) -> U256 {
        U256::abi_decode(bytes).expect("ABI decode of uint256")
    }

    #[test]
    fn selector_matches_keccak() {
        // `cast sig 'getUsdPrice(uint256)'` => 0x2695b3a2
        assert_eq!(getUsdPriceCall::SELECTOR, [0x26, 0x95, 0xb3, 0xa2]);
    }

    #[test]
    fn returns_eth_price() {
        let out = run(&calldata(TOKEN_ID_ETH), BASE_GAS_COST).unwrap();
        assert_eq!(out.gas_used, BASE_GAS_COST);
        let scale = U256::from(10u64).pow(U256::from(USD_PRICE_DECIMALS));
        assert_eq!(decode_uint(&out.output), U256::from(3_500u64) * scale);
    }

    #[test]
    fn returns_btc_price() {
        let out = run(&calldata(TOKEN_ID_BTC), BASE_GAS_COST).unwrap();
        let scale = U256::from(10u64).pow(U256::from(USD_PRICE_DECIMALS));
        assert_eq!(decode_uint(&out.output), U256::from(65_000u64) * scale);
    }

    #[test]
    fn returns_usdc_price() {
        let out = run(&calldata(TOKEN_ID_USDC), BASE_GAS_COST).unwrap();
        let scale = U256::from(10u64).pow(U256::from(USD_PRICE_DECIMALS));
        assert_eq!(decode_uint(&out.output), scale);
    }

    #[test]
    fn output_is_exactly_32_bytes() {
        let out = run(&calldata(TOKEN_ID_ETH), BASE_GAS_COST).unwrap();
        assert_eq!(out.output.len(), 32);
    }

    #[test]
    fn extra_gas_is_allowed() {
        let out = run(&calldata(TOKEN_ID_ETH), 1_000_000).unwrap();
        // Cost is flat; remaining gas is the caller's concern.
        assert_eq!(out.gas_used, BASE_GAS_COST);
    }

    #[test]
    fn rejects_unknown_token() {
        let err = run(&calldata(9999), BASE_GAS_COST).unwrap_err();
        assert_eq!(err, PrecompileError::UnknownToken(U256::from(9999u64)));
    }

    #[test]
    fn rejects_unknown_selector() {
        let mut bad = calldata(TOKEN_ID_ETH);
        bad[0] ^= 0xff;
        let mut expected = getUsdPriceCall::SELECTOR;
        expected[0] ^= 0xff;
        assert_eq!(
            run(&bad, BASE_GAS_COST).unwrap_err(),
            PrecompileError::UnknownSelector(expected),
        );
    }

    #[test]
    fn rejects_short_input() {
        assert_eq!(
            run(&[], BASE_GAS_COST).unwrap_err(),
            PrecompileError::InvalidInputLength,
        );
        assert_eq!(
            run(&[0u8; 3], BASE_GAS_COST).unwrap_err(),
            PrecompileError::InvalidInputLength,
        );
    }

    #[test]
    fn rejects_truncated_calldata() {
        let mut truncated = calldata(TOKEN_ID_ETH);
        truncated.truncate(20); // selector + partial arg
        assert_eq!(
            run(&truncated, BASE_GAS_COST).unwrap_err(),
            PrecompileError::InvalidCalldata,
        );
    }

    #[test]
    fn rejects_out_of_gas() {
        assert_eq!(
            run(&calldata(TOKEN_ID_ETH), BASE_GAS_COST - 1).unwrap_err(),
            PrecompileError::OutOfGas,
        );
    }

    #[test]
    fn out_of_gas_takes_precedence_over_decoding() {
        // Even malformed calldata should surface OutOfGas first so callers
        // can't probe selectors below the gas floor.
        assert_eq!(run(&[], 0).unwrap_err(), PrecompileError::OutOfGas,);
    }
}
