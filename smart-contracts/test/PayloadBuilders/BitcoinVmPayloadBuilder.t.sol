// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";

import {BuildPayloadParams} from "../../contracts/RelayAllocator.sol";
import {
  BitcoinVmPayloadBuilder,
  BitcoinVmTransactionData,
  BitcoinVmTransactionParams,
  BitcoinVmUtxo
} from "../../contracts/payload-builders/BitcoinVmPayloadBuilder.sol";

contract BitcoinVmPayloadBuilderTest is Test {
  BitcoinVmPayloadBuilder internal builder;

  bytes internal constant RECEIVER_ADDRESS =
    hex"001111111111111111111111111111111111111111";
  bytes internal constant RECEIVER_SCRIPT =
    hex"00141111111111111111111111111111111111111111";
  bytes internal constant P2PKH_RECEIVER_ADDRESS =
    hex"ff004444444444444444444444444444444444444444";
  bytes internal constant P2PKH_RECEIVER_SCRIPT =
    hex"76a914444444444444444444444444444444444444444488ac";
  bytes internal constant ALLOCATOR_ADDRESS =
    hex"002222222222222222222222222222222222222222";
  bytes internal constant ALLOCATOR_SCRIPT =
    hex"00142222222222222222222222222222222222222222";
  bytes internal constant FEE_SCRIPT =
    hex"00143333333333333333333333333333333333333333";
  bytes internal constant P2PKH_FEE_SCRIPT =
    hex"76a914555555555555555555555555555555555555555588ac";
  bytes internal constant P2SH_FEE_SCRIPT =
    hex"a914666666666666666666666666666666666666666687";

  function setUp() public {
    builder = new BitcoinVmPayloadBuilder(ALLOCATOR_SCRIPT);
  }

  function test_buildsP2wpkhPayloadWithFeeUtxoChange() public view {
    BuildPayloadParams memory params = _buildParams(9000, _defaultTxParams(2));
    bytes memory payload = builder.buildPayload("bitcoin-mainnet", "", params);
    BitcoinVmTransactionData memory txData = abi.decode(
      payload,
      (BitcoinVmTransactionData)
    );

    assert(txData.inputs.length == 2);
    assert(txData.outputs.length == 4);
    assertEq(_readUint64LE(txData.outputs[0].value), 9000);
    assertEq(txData.outputs[0].script, RECEIVER_SCRIPT);
    assertEq(_readUint64LE(txData.outputs[1].value), 0);
    assertEq(
      txData.outputs[1].script,
      _expectedIdentifierScript("bitcoin-mainnet", "", params)
    );
    assertEq(_readUint64LE(txData.outputs[2].value), 1000);
    assertEq(txData.outputs[2].script, ALLOCATOR_SCRIPT);
    assertEq(_readUint64LE(txData.outputs[3].value), 19436);
    assertEq(txData.outputs[3].script, FEE_SCRIPT);
  }

  function test_decodesProtocolEncodedP2pkhReceiver() public view {
    bytes memory payload = builder.buildPayload(
      "bitcoin-mainnet",
      ALLOCATOR_ADDRESS,
      _buildParamsWithReceiver(
        9000,
        P2PKH_RECEIVER_ADDRESS,
        _defaultTxParams(2)
      )
    );
    BitcoinVmTransactionData memory txData = abi.decode(
      payload,
      (BitcoinVmTransactionData)
    );

    assertEq(txData.outputs[0].script, P2PKH_RECEIVER_SCRIPT);
  }

  function test_allowsNonP2wpkhFeeScripts() public view {
    BitcoinVmTransactionParams memory params = _defaultTxParams(2);
    params.feeUtxos[0].scriptPubKey = P2PKH_FEE_SCRIPT;
    params.feeChangeScript = P2SH_FEE_SCRIPT;

    bytes memory payload = builder.buildPayload(
      "bitcoin-mainnet",
      ALLOCATOR_ADDRESS,
      _buildParams(9000, params)
    );
    BitcoinVmTransactionData memory txData = abi.decode(
      payload,
      (BitcoinVmTransactionData)
    );

    assertEq(txData.inputs[1].script, P2PKH_FEE_SCRIPT);
    assertEq(txData.outputs[3].script, P2SH_FEE_SCRIPT);
  }

  function test_hashesOnlyAllocatorInputsUsingBip143() public view {
    bytes memory payload = builder.buildPayload(
      "bitcoin-mainnet",
      "",
      _buildParams(9000, _defaultTxParams(2))
    );

    bytes32[] memory hashes = builder.hashesToSign(
      "bitcoin-mainnet",
      "",
      payload
    );

    assertEq(hashes.length, 1);
    assertEq(hashes[0], builder.hashToSign(payload, 0));
  }

  function test_revertsWhenAllocatorUtxoScriptDoesNotMatchAllocator() public {
    BitcoinVmTransactionParams memory params = _defaultTxParams(2);
    params.allocatorUtxos[0].scriptPubKey = FEE_SCRIPT;

    vm.expectRevert(
      abi.encodeWithSelector(
        BitcoinVmPayloadBuilder.AllocatorScriptMismatch.selector,
        ALLOCATOR_SCRIPT,
        FEE_SCRIPT
      )
    );
    builder.buildPayload(
      "bitcoin-mainnet",
      ALLOCATOR_ADDRESS,
      _buildParams(9000, params)
    );
  }

  function test_revertsWhenFeeUtxoUsesAllocatorScript() public {
    BitcoinVmTransactionParams memory params = _defaultTxParams(2);
    params.feeUtxos[0].scriptPubKey = ALLOCATOR_SCRIPT;

    vm.expectRevert(
      abi.encodeWithSelector(
        BitcoinVmPayloadBuilder.FeeUtxoUsesAllocatorScript.selector,
        ALLOCATOR_SCRIPT
      )
    );
    builder.buildPayload(
      "bitcoin-mainnet",
      ALLOCATOR_ADDRESS,
      _buildParams(9000, params)
    );
  }

  function test_revertsWhenFeeUtxoChangeWouldBeDust() public {
    BitcoinVmTransactionParams memory params = _defaultTxParams(2);
    params.feeUtxos[0].value = 1000;

    vm.expectRevert(
      abi.encodeWithSelector(
        BitcoinVmPayloadBuilder.OutputBelowDust.selector,
        uint64(436)
      )
    );
    builder.buildPayload("bitcoin-mainnet", "", _buildParams(9000, params));
  }

  function test_usesConstructorAllocatorChangeScript() public view {
    assertEq(builder.allocatorChangeScript(), ALLOCATOR_SCRIPT);
  }

  function test_returnsExpectedMetadata() public view {
    assertEq(builder.curve(), "Ecdsa");
    assertEq(builder.family(), "bitcoin-vm");
  }

  function _defaultTxParams(
    uint64 feeRate
  ) internal pure returns (BitcoinVmTransactionParams memory params) {
    params.allocatorUtxos = new BitcoinVmUtxo[](1);
    params.allocatorUtxos[0] = BitcoinVmUtxo({
      txid: bytes32(uint256(0x01)),
      index: 0,
      value: 10000,
      scriptPubKey: ALLOCATOR_SCRIPT
    });

    params.feeUtxos = new BitcoinVmUtxo[](1);
    params.feeUtxos[0] = BitcoinVmUtxo({
      txid: bytes32(uint256(0x02)),
      index: 1,
      value: 20000,
      scriptPubKey: FEE_SCRIPT
    });

    params.feeChangeScript = FEE_SCRIPT;
    params.feeRate = feeRate;
  }

  function _buildParams(
    uint256 amount,
    BitcoinVmTransactionParams memory params
  ) internal pure returns (BuildPayloadParams memory) {
    return _buildParamsWithReceiver(amount, RECEIVER_ADDRESS, params);
  }

  function _buildParamsWithReceiver(
    uint256 amount,
    bytes memory receiver,
    BitcoinVmTransactionParams memory params
  ) internal pure returns (BuildPayloadParams memory) {
    return
      BuildPayloadParams({
        currency: "",
        amount: amount,
        receiver: receiver,
        nonce: 1,
        data: abi.encode(params)
      });
  }

  function _expectedIdentifierScript(
    string memory chainId,
    bytes memory depository,
    BuildPayloadParams memory params
  ) internal view returns (bytes memory) {
    return
      bytes.concat(
        hex"6a20",
        keccak256(abi.encode(address(builder), chainId, depository, params))
      );
  }

  function _readUint64LE(
    bytes memory data
  ) internal pure returns (uint64 value) {
    for (uint256 i = 0; i < 8; ++i) {
      value |= uint64(uint8(data[i])) << uint8(i * 8);
    }
  }
}
