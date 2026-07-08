// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";

import {RelayOracleV2} from "../../contracts/RelayOracleV2.sol";

/// @notice Cross-language roundtrip — decodes the exact FAST_MINT bytes produced by the settlement-sdk
///         TS encoder (encodeAction) and asserts the layout matches RelayOracleV2._executeFastMint's
///         abi.decode tuple, the nested limiter `data` (encodeAmountLimiterData), and the fee split.
contract FastMintTsVectorTest is Test {
  // Produced by the TS encoder for:
  //   { hubToAddress: 0x3333...3333, hubTokenId: 123456789, amount: 1000000,
  //     feeBps: 1e16 (1%), feeRecipient: 0x4444...4444, limiter: 0x5555...5555,
  //     limiterData: encodeAmountLimiterData("8453", 0xa0b8...eb48, 1000000) }
  bytes internal constant TS_VECTOR =
    hex"0000000000000000000000000000000000000000000000000000000000000003000000000000000000000000333333333333333333333333333333333333333300000000000000000000000000000000000000000000000000000000075bcd1500000000000000000000000000000000000000000000000000000000000f4240000000000000000000000000000000000000000000000000002386f26fc1000000000000000000000000000044444444444444444444444444444444444444440000000000000000000000005555555555555555555555555555555555555555000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000000e0000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000f4240000000000000000000000000000000000000000000000000000000000000000438343533000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000014a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48000000000000000000000000";

  function test_tsEncodedFastMint_decodesToContractTuple() public pure {
    (
      uint8 actionType,
      address hubToAddress,
      uint256 hubTokenId,
      uint256 amount,
      uint256 feeBps,
      address feeRecipient,
      address limiter,
      bytes memory data
    ) = abi.decode(
        TS_VECTOR,
        (uint8, address, uint256, uint256, uint256, address, address, bytes)
      );

    assertEq(actionType, uint8(RelayOracleV2.ActionType.FAST_MINT));
    assertEq(hubToAddress, 0x3333333333333333333333333333333333333333);
    assertEq(hubTokenId, 123456789);
    assertEq(amount, 1_000_000);
    assertEq(feeBps, 1e16);
    assertEq(feeRecipient, 0x4444444444444444444444444444444444444444);
    assertEq(limiter, 0x5555555555555555555555555555555555555555);

    // The opaque limiter data decodes to (chainId, currency, amount) — the amount limiter's layout.
    (
      string memory dataChainId,
      bytes memory dataCurrency,
      uint256 dataAmount
    ) = abi.decode(data, (string, bytes, uint256));
    assertEq(dataChainId, "8453");
    assertEq(dataCurrency, hex"a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
    assertEq(dataAmount, 1_000_000);

    // Same fee-of-amount split the contract applies: fee = amount * feeBps / 1e18, input = amount - fee.
    uint256 feeAmount = FixedPointMathLib.fullMulDiv(amount, feeBps, 1e18);
    uint256 orderInput = amount - feeAmount;
    assertEq(feeAmount, 10_000);
    assertEq(orderInput, 990_000);
  }
}
