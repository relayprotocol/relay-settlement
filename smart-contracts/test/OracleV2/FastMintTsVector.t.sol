// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// ABOUTME: Cross-language roundtrip — decodes the exact FAST_MINT bytes produced by the
// ABOUTME: settlement-sdk TS encoder (@relay-protocol/settlement-sdk encodeAction) and asserts the
// ABOUTME: layout matches RelayOracleV2._executeFastMint's abi.decode tuple + the fee/input split.

import {Test} from "forge-std/Test.sol";
import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";

import {RelayOracleV2} from "../../contracts/RelayOracleV2.sol";

contract FastMintTsVectorTest is Test {
  // Produced by the TS encoder for:
  //   { hubToAddress: 0x3333...3333, hubTokenId: 777, chainId: "8453",
  //     amount: 1000000, feeBps: 1e16 (1%), feeRecipient: 0x4444...4444, usdValue: 1000000 }
  // Regenerate with: node -e "require('@relay-protocol/settlement-sdk').encodeAction(...)"
  bytes internal constant TS_VECTOR =
    hex"000000000000000000000000000000000000000000000000000000000000000300000000000000000000000033333333333333333333333333333333333333330000000000000000000000000000000000000000000000000000000000000309000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000f4240000000000000000000000000000000000000000000000000002386f26fc10000000000000000000000000000444444444444444444444444444444444444444400000000000000000000000000000000000000000000000000000000000f424000000000000000000000000000000000000000000000000000000000000000043834353300000000000000000000000000000000000000000000000000000000";

  function test_tsEncodedFastMint_decodesToContractTuple() public pure {
    (
      uint8 actionType,
      address hubToAddress,
      uint256 hubTokenId,
      string memory chainId,
      uint256 amount,
      uint256 feeBps,
      address feeRecipient,
      uint256 usdValue
    ) = abi.decode(
        TS_VECTOR,
        (uint8, address, uint256, string, uint256, uint256, address, uint256)
      );

    assertEq(actionType, uint8(RelayOracleV2.ActionType.FAST_MINT));
    assertEq(hubToAddress, 0x3333333333333333333333333333333333333333);
    assertEq(hubTokenId, 777);
    assertEq(chainId, "8453");
    assertEq(amount, 1_000_000);
    assertEq(feeBps, 1e16);
    assertEq(feeRecipient, 0x4444444444444444444444444444444444444444);
    assertEq(usdValue, 1_000_000);

    // Same fee-of-amount split the contract applies: fee = amount * feeBps / 1e18, input = amount - fee.
    uint256 feeAmount = FixedPointMathLib.fullMulDiv(amount, feeBps, 1e18);
    uint256 orderInput = amount - feeAmount;
    assertEq(feeAmount, 10_000);
    assertEq(orderInput, 990_000);
  }
}
