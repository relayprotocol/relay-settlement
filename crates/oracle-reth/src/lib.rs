//! reth/revm integration shim for the price oracle precompile.
//!
//! This crate is intentionally minimal today: it pins the precompile address
//! and re-exports the runtime-agnostic core. Wiring into reth's revm
//! precompile registry lands in a follow-up once we commit to a specific
//! revm version.
//!
//! The expected shape of the adapter (`revm-precompile` ~ 36.x) is roughly:
//!
//! ```ignore
//! use revm_precompile::{Precompile, PrecompileError as RevmError,
//!     PrecompileErrors, PrecompileOutput as RevmOutput};
//! use price_oracle_precompile::{run, PrecompileError};
//!
//! pub fn precompile() -> Precompile {
//!     Precompile::Standard(|input, gas_limit| match run(input, gas_limit) {
//!         Ok(o) => Ok(RevmOutput::new(o.gas_used, o.output.into())),
//!         Err(PrecompileError::OutOfGas) => Err(PrecompileErrors::Error(RevmError::OutOfGas)),
//!         Err(e) => Err(PrecompileErrors::Error(RevmError::Other(e.to_string()))),
//!     })
//! }
//! ```
//!
//! On the reth side, the adapter is then injected via
//! `EvmConfig`/`PrecompilesMap` so block execution and `eth_call` both see
//! the precompile at [`PRICE_ORACLE_ADDRESS`].

use alloy_primitives::{address, Address};

pub use price_oracle_precompile;

/// Address the precompile is mounted at. Lives well outside the standard
/// precompile range (0x01..0x11); the trailing `FEED` is a mnemonic so the
/// address is recognisable in traces and call data dumps.
pub const PRICE_ORACLE_ADDRESS: Address = address!("0x000000000000000000000000000000000000FEED");

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn address_is_in_custom_range() {
        let bytes = PRICE_ORACLE_ADDRESS.into_array();
        // First 18 bytes must be zero, last 2 bytes encode the slot.
        assert!(bytes[..18].iter().all(|b| *b == 0));
        assert_eq!(u16::from_be_bytes([bytes[18], bytes[19]]), 0xFEED);
    }
}
