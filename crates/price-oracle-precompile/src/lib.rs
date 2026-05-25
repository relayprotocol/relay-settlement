//! Relay price oracle EVM precompile — runtime-agnostic core.
//!
//! Exposes a single Solidity-style entry point:
//!
//! ```solidity
//! function getUsdPrice(uint256 tokenId) external view returns (uint256 usdPrice);
//! ```
//!
//! `usdPrice` is fixed-point with [`USD_PRICE_DECIMALS`] decimals (Chainlink
//! convention: 8). Token identifiers are protocol-defined `uint256` values;
//! see [`prices`] for the initial hardcoded set.
//!
//! The crate intentionally has no runtime dependency (no revm, no reth). The
//! [`run`] function takes raw calldata bytes plus a gas limit and returns a
//! [`PrecompileOutput`] that runtime adapters can translate into their own
//! precompile result type. See `oracle-reth` for the intended revm wiring.

pub mod precompile;
pub mod prices;

pub use precompile::{run, PrecompileError, PrecompileOutput, BASE_GAS_COST};
pub use prices::{price_for, TOKEN_ID_BTC, TOKEN_ID_ETH, TOKEN_ID_USDC, USD_PRICE_DECIMALS};

alloy_sol_types::sol! {
    /// Solidity interface mirrored by this precompile. Generated types
    /// (`getUsdPriceCall`, `getUsdPriceReturn`) are used internally for
    /// selector + calldata handling and re-exported for integration tests.
    #[allow(missing_docs)]
    interface IPriceOraclePrecompile {
        function getUsdPrice(uint256 tokenId) external view returns (uint256 usdPrice);
    }
}
