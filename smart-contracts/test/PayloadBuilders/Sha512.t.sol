// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Sha512} from "../../contracts/payload-builders/utils/Sha512.sol";

/// @notice Known-answer tests for the from-scratch SHA-512 (FIPS 180-4),
/// including the padding boundaries (lengths around the 112/128-byte block
/// edges) where the padding logic is most error-prone.
contract Sha512Test is Test {
  // A message of `n` repeated 'a' (0x61) bytes.
  function _repeatA(uint256 n) internal pure returns (bytes memory b) {
    b = new bytes(n);
    for (uint256 i = 0; i < n; ++i) {
      b[i] = "a";
    }
  }

  function test_empty() public pure {
    assertEq(
      Sha512.hash(bytes("")),
      hex"cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e"
    );
  }

  function test_singleByte() public pure {
    assertEq(
      Sha512.hash(bytes("a")),
      hex"1f40fc92da241694750979ee6cf582f2d5d7d28e18335de05abc54d0560e0f5302860c652bf08d560252aa5e74210546f369fbbbce8c12cfc7957b2652fe9a75"
    );
  }

  function test_abc() public pure {
    assertEq(
      Sha512.hash(bytes("abc")),
      hex"ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f"
    );
  }

  function test_quickBrownFox() public pure {
    assertEq(
      Sha512.hash(bytes("The quick brown fox jumps over the lazy dog")),
      hex"07e547d9586f6a73f73fbac0435ed76951218fb7d0c8d788a309d785436bbb642e93a252a954f23912547d1e8a3b5ed6e1bfd7097821233fa0538f3db854fee6"
    );
  }

  /// @notice Canonical FIPS 180-4 two-block (896-bit) example.
  function test_nistTwoBlock() public pure {
    assertEq(
      Sha512.hash(
        bytes(
          "abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu"
        )
      ),
      hex"8e959b75dae313da8cf4f72814fc143f8f7779c6eb9f7fa17299aeadb6889018501d289e4900f7e4331b99dec4b5433ac7d329eeb6dd26545e96e55b874be909"
    );
  }

  /// @notice 111 bytes: 0x80 + zero padding + length still fit one 128-byte block.
  function test_len111_singleBlock() public pure {
    assertEq(
      Sha512.hash(_repeatA(111)),
      hex"fa9121c7b32b9e01733d034cfc78cbf67f926c7ed83e82200ef86818196921760b4beff48404df811b953828274461673c68d04e297b0eb7b2b4d60fc6b566a2"
    );
  }

  /// @notice 112 bytes: the length field no longer fits, forcing a second block.
  function test_len112_twoBlocks() public pure {
    assertEq(
      Sha512.hash(_repeatA(112)),
      hex"c01d080efd492776a1c43bd23dd99d0a2e626d481e16782e75d54c2503b5dc32bd05f0f1ba33e568b88fd2d970929b719ecbb152f58f130a407c8830604b70ca"
    );
  }

  function test_len127() public pure {
    assertEq(
      Sha512.hash(_repeatA(127)),
      hex"828613968b501dc00a97e08c73b118aa8876c26b8aac93df128502ab360f91bab50a51e088769a5c1eff4782ace147dce3642554199876374291f5d921629502"
    );
  }

  /// @notice 128 bytes: exactly one full data block plus an all-padding block.
  function test_len128_fullBlockPlusPadding() public pure {
    assertEq(
      Sha512.hash(_repeatA(128)),
      hex"b73d1929aa615934e61a871596b3f3b33359f42b8175602e89f7e06e5f658a243667807ed300314b95cacdd579f3e33abdfbe351909519a846d465c59582f321"
    );
  }

  function test_len129() public pure {
    assertEq(
      Sha512.hash(_repeatA(129)),
      hex"4f681e0bd53cda4b5a2041cc8a06f2eabde44fb16c951fbd5b87702f07aeab611565b19c47fde30587177ebb852e3971bbd8d3fd30da18d71037dfbd98420429"
    );
  }

  /// @notice hashHalf returns the first 32 bytes of the full digest.
  function test_hashHalf_abc() public pure {
    assertEq(
      Sha512.hashHalf(bytes("abc")),
      bytes32(
        hex"ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a"
      )
    );
  }
}
