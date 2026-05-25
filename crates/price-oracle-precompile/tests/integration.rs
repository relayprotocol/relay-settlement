//! End-to-end ABI round-trip: build calldata exactly like a Solidity caller
//! would, dispatch it through `run`, and decode the result.

use alloy_primitives::U256;
use alloy_sol_types::{SolCall, SolValue};
use price_oracle_precompile::{
    run, IPriceOraclePrecompile::getUsdPriceCall, BASE_GAS_COST, TOKEN_ID_ETH,
};

#[test]
fn end_to_end_round_trip() {
    let call = getUsdPriceCall {
        tokenId: U256::from(TOKEN_ID_ETH),
    };
    let input = call.abi_encode();

    let output = run(&input, BASE_GAS_COST).expect("precompile run");

    let price = U256::abi_decode(&output.output).expect("decode price");
    assert!(price > U256::ZERO);
}
