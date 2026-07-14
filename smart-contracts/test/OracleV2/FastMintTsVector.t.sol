// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";

import {RelayOracleV2} from "../../contracts/RelayOracleV2.sol";

/// @notice Cross-language roundtrip — decodes the exact FAST_MINT bytes produced by the settlement-sdk
///         TS encoder (encodeAction) and asserts the layout matches RelayOracleV2._executeFastMint's
///         abi.decode tuple and the nested module data.
contract FastMintTsVectorTest is Test {
  // Produced by the TS encoder for:
  //   { hubToAddress: 0x3333...3333, hubTokenId: 123456789, amount: 1000000,
  //     feeCalculator: 0x6666...6666,
  //     feeCalculatorData: abi.encode(123456789, 1e16, 0x4444...4444, 0x3333...3333),
  //     rateLimiter: 0x5555...5555,
  //     rateLimiterData: 0x }
  bytes internal constant TS_VECTOR =
    hex"0000000000000000000000000000000000000000000000000000000000000003000000000000000000000000333333333333333333333333333333333333333300000000000000000000000000000000000000000000000000000000075bcd1500000000000000000000000000000000000000000000000000000000000f424000000000000000000000000066666666666666666666666666666666666666660000000000000000000000000000000000000000000000000000000000000100000000000000000000000000555555555555555555555555555555555555555500000000000000000000000000000000000000000000000000000000000001a0000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000075bcd15000000000000000000000000000000000000000000000000002386f26fc10000000000000000000000000000444444444444444444444444444444444444444400000000000000000000000033333333333333333333333333333333333333330000000000000000000000000000000000000000000000000000000000000000";
  function test_tsEncodedFastMint_decodesToContractTuple() public pure {
    (
      uint8 actionType,
      address hubToAddress,
      uint256 hubTokenId,
      uint256 amount,
      address feeCalculator,
      bytes memory feeCalculatorData,
      address rateLimiter,
      bytes memory rateLimiterData
    ) = abi.decode(
        TS_VECTOR,
        (uint8, address, uint256, uint256, address, bytes, address, bytes)
      );

    assertEq(actionType, uint8(RelayOracleV2.ActionType.FAST_MINT));
    assertEq(hubToAddress, 0x3333333333333333333333333333333333333333);
    assertEq(hubTokenId, 123456789);
    assertEq(amount, 1_000_000);
    assertEq(feeCalculator, 0x6666666666666666666666666666666666666666);
    assertEq(rateLimiter, 0x5555555555555555555555555555555555555555);

    (
      uint256 feeCurrency,
      uint256 feeBps,
      address feeRecipient,
      address feePayer
    ) = abi.decode(feeCalculatorData, (uint256, uint256, address, address));
    assertEq(feeCurrency, 123456789);
    assertEq(feeBps, 1e16);
    assertEq(feeRecipient, 0x4444444444444444444444444444444444444444);
    assertEq(feePayer, 0x3333333333333333333333333333333333333333);

    // The default amount limiter is token-id keyed and does not require opaque data.
    assertEq(rateLimiterData.length, 0);

    // Same fee-of-amount calculation the default calculator applies; fee is transferred separately.
    uint256 feeAmount = FixedPointMathLib.fullMulDiv(amount, feeBps, 1e18);
    assertEq(feeAmount, 10_000);
  }
}
