// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {buildPayloadOnly} from "../utils/Payload.sol";

import {Test} from "forge-std/Test.sol";

import {Config} from "../../contracts/Config.sol";
import {
  RelayAllocator,
  WithdrawRequest
} from "../../contracts/RelayAllocator.sol";
import {RelayHub} from "../../contracts/RelayHub.sol";
import {Utils} from "../../contracts/Utils.sol";
import {
  BitcoinVmPayloadBuilder,
  BitcoinVmTransactionData,
  BitcoinVmTransactionDataInput,
  BitcoinVmTransactionDataOutput,
  BitcoinVmTransactionParams,
  BitcoinVmUtxo
} from "../../contracts/payload-builders/BitcoinVmPayloadBuilder.sol";

contract BitcoinVmPayloadBuilderTest is Test {
  BitcoinVmPayloadBuilder internal builder;
  Config internal config;
  RelayHub internal hub;
  RelayAllocator internal allocator;

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
  // SDK encoding of bc1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqmql8k8, the native BTC Hub token currency
  bytes internal constant NATIVE_CURRENCY =
    hex"0000000000000000000000000000000000000000";

  function setUp() public {
    hub = new RelayHub(address(this));
    allocator = new RelayAllocator(
      address(this),
      address(hub),
      address(0xbeef)
    );
    config = new Config(address(allocator));
    builder = new BitcoinVmPayloadBuilder(address(config), ALLOCATOR_SCRIPT);
  }

  function test_buildsP2wpkhPayloadWithFeeUtxoChange() public view {
    WithdrawRequest memory params = _buildParams(9000, _defaultTxParams(2));
    bytes memory payload = buildPayloadOnly(
      builder,
      "bitcoin-mainnet",
      "",
      params
    );
    BitcoinVmTransactionData memory txData = abi.decode(
      payload,
      (BitcoinVmTransactionData)
    );

    assert(txData.inputs.length == 2);
    assert(txData.outputs.length == 4);
    assertEq(txData.outputs[0].value, 9000);
    assertEq(txData.outputs[0].script, RECEIVER_SCRIPT);
    assertEq(txData.outputs[1].value, 0);
    assertEq(txData.outputs[1].script, _expectedIdentifierScript(params));
    assertEq(txData.outputs[2].value, 1000);
    assertEq(txData.outputs[2].script, ALLOCATOR_SCRIPT);
    assertEq(txData.outputs[3].value, 19434);
    assertEq(txData.outputs[3].script, FEE_SCRIPT);
  }

  function testFuzz_feeCoversMaximumP2wpkhSignatures(
    uint8 allocatorCountSeed,
    uint8 feeCountSeed,
    uint64 feeRateSeed
  ) public view {
    uint256 allocatorCount = bound(allocatorCountSeed, 1, 20);
    uint256 feeCount = bound(feeCountSeed, 1, 20);
    uint64 feeRate = uint64(bound(feeRateSeed, 1, 100));
    BitcoinVmTransactionParams memory bitcoinParams = _defaultTxParams(feeRate);
    bitcoinParams.allocatorUtxos = new BitcoinVmUtxo[](allocatorCount);
    bitcoinParams.feeUtxos = new BitcoinVmUtxo[](feeCount);
    for (uint256 i; i < allocatorCount; ++i) {
      bitcoinParams.allocatorUtxos[i] = BitcoinVmUtxo({
        txid: bytes32(i + 1),
        index: 0,
        value: 10000,
        scriptPubKey: ALLOCATOR_SCRIPT
      });
    }
    for (uint256 i; i < feeCount; ++i) {
      bitcoinParams.feeUtxos[i] = BitcoinVmUtxo({
        txid: bytes32(allocatorCount + i + 1),
        index: 0,
        value: 1000000,
        scriptPubKey: FEE_SCRIPT
      });
    }
    BitcoinVmTransactionData memory txData = abi.decode(
      buildPayloadOnly(
        builder,
        "bitcoin-mainnet",
        ALLOCATOR_ADDRESS,
        _buildParams(9000, bitcoinParams)
      ),
      (BitcoinVmTransactionData)
    );
    uint256 inputCount = allocatorCount + feeCount;
    // Native P2WPKH base input: outpoint (36), empty script length (1), sequence (4).
    uint256 baseBytes = 4 + 1 + 41 * inputCount + 1 + 4;
    for (uint256 i; i < txData.outputs.length; ++i) {
      baseBytes += 8 + 1 + txData.outputs[i].script.length;
    }
    // Two stack items: a 72-byte signature including SIGHASH_ALL and a 33-byte key.
    uint256 witnessBytes = 2 + inputCount * (1 + 1 + 72 + 1 + 33);
    uint256 maximumVsize = (baseBytes * 4 + witnessBytes + 3) / 4;
    uint256 paidFee = feeCount * 1000000 - txData.outputs[3].value;
    assertEq(paidFee, maximumVsize * feeRate);
  }

  function test_decodesProtocolEncodedP2pkhReceiver() public view {
    bytes memory payload = buildPayloadOnly(
      builder,
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

    bytes memory payload = buildPayloadOnly(
      builder,
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
    bytes memory payload = buildPayloadOnly(
      builder,
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

  function test_payloadStoresOutpointFieldsAsPlainValues() public view {
    BitcoinVmTransactionParams memory params = _defaultTxParams(2);
    params.feeUtxos[0].index = 0x01020304;

    BitcoinVmTransactionData memory txData = abi.decode(
      buildPayloadOnly(
        builder,
        "bitcoin-mainnet",
        "",
        _buildParams(9000, params)
      ),
      (BitcoinVmTransactionData)
    );

    assertEq(txData.inputs[0].txid, params.allocatorUtxos[0].txid);
    assertEq(txData.inputs[0].index, 0);
    assertEq(txData.inputs[0].value, 10000);
    assertEq(txData.inputs[0].script, ALLOCATOR_SCRIPT);
    assertEq(txData.inputs[1].txid, params.feeUtxos[0].txid);
    assertEq(txData.inputs[1].index, 0x01020304);
    assertEq(txData.inputs[1].value, 20000);
    assertEq(txData.inputs[1].script, FEE_SCRIPT);
  }

  /// @notice Known-answer vectors cross-checked against bitcoinjs-lib's
  /// `hashForWitnessV0` (version 1, sequence 0xFFFFFFFD, locktime 0).
  function test_hashesToSignMatchesBip143KnownAnswers() public view {
    BitcoinVmTransactionData memory txData;
    txData.inputs = new BitcoinVmTransactionDataInput[](3);
    txData.inputs[0] = BitcoinVmTransactionDataInput({
      txid: 0xb10e2d527612073b26eecdfd717e6a320cf44b4afac2b0732d9fcbe2b7fa0cf6,
      index: 0,
      script: ALLOCATOR_SCRIPT,
      value: 6000
    });
    txData.inputs[1] = BitcoinVmTransactionDataInput({
      txid: 0x405787fa12a823e0f2b7631cc41b3ba8828b3321ca811111fa75cd3aa3bb5ace,
      index: 0x01020304,
      script: ALLOCATOR_SCRIPT,
      value: 5000
    });
    txData.inputs[2] = BitcoinVmTransactionDataInput({
      txid: 0xc2575a0e9e593c00f959f8c92f12db2869c3395a3b0502d05e2516446f71f85b,
      index: 7,
      script: FEE_SCRIPT,
      value: 123456789
    });
    txData.outputs = new BitcoinVmTransactionDataOutput[](4);
    txData.outputs[0] = BitcoinVmTransactionDataOutput({
      value: 9000,
      script: RECEIVER_SCRIPT
    });
    txData.outputs[1] = BitcoinVmTransactionDataOutput({
      value: 0,
      script: hex"6a20307cd2f43f75f4ea9022983747dbed51f023dd11a19d28d687ffdd8d6cae3270"
    });
    txData.outputs[2] = BitcoinVmTransactionDataOutput({
      value: 2000,
      script: ALLOCATOR_SCRIPT
    });
    txData.outputs[3] = BitcoinVmTransactionDataOutput({
      value: 123455736,
      script: FEE_SCRIPT
    });
    bytes memory payload = abi.encode(txData);

    bytes32[] memory hashes = builder.hashesToSign(
      "bitcoin-mainnet",
      "",
      payload
    );

    assertEq(hashes.length, 2);
    assertEq(
      hashes[0],
      0xd47a63c338d628cda9ecf370b6d2fffaa88d972790f52f07a8f974e1ccc1f8aa
    );
    assertEq(
      hashes[1],
      0x43674720d0ae77e30db39facb2cedfbbae7b25444048c8c4695e230da80a46dd
    );
    assertEq(builder.hashToSign(payload, 0), hashes[0]);
    assertEq(builder.hashToSign(payload, 1), hashes[1]);
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
    buildPayloadOnly(
      builder,
      "bitcoin-mainnet",
      ALLOCATOR_ADDRESS,
      _buildParams(9000, params)
    );
  }

  // Values are summed by array position, so a repeated outpoint funds the spend
  // once but counts as many times as it appears (Cyfrin #14).
  function test_revertsWhenAnAllocatorOutpointIsRepeated() public {
    BitcoinVmTransactionParams memory params = _defaultTxParams(2);
    params.allocatorUtxos = new BitcoinVmUtxo[](2);
    params.allocatorUtxos[0] = BitcoinVmUtxo({
      txid: bytes32(uint256(0x01)),
      index: 0,
      value: 10000,
      scriptPubKey: ALLOCATOR_SCRIPT
    });
    params.allocatorUtxos[1] = params.allocatorUtxos[0];

    vm.expectRevert(
      abi.encodeWithSelector(
        BitcoinVmPayloadBuilder.DuplicateOutpoint.selector,
        bytes32(uint256(0x01)),
        uint32(0)
      )
    );
    buildPayloadOnly(
      builder,
      "bitcoin-mainnet",
      ALLOCATOR_ADDRESS,
      _buildParams(9000, params)
    );
  }

  // Both lists are concatenated into one input set, so a repeat that straddles
  // them double-counts the same way.
  function test_revertsWhenAnOutpointRepeatsAcrossAllocatorAndFeeUtxos()
    public
  {
    BitcoinVmTransactionParams memory params = _defaultTxParams(2);
    params.feeUtxos[0].txid = params.allocatorUtxos[0].txid;
    params.feeUtxos[0].index = params.allocatorUtxos[0].index;

    vm.expectRevert(
      abi.encodeWithSelector(
        BitcoinVmPayloadBuilder.DuplicateOutpoint.selector,
        params.allocatorUtxos[0].txid,
        params.allocatorUtxos[0].index
      )
    );
    buildPayloadOnly(
      builder,
      "bitcoin-mainnet",
      ALLOCATOR_ADDRESS,
      _buildParams(9000, params)
    );
  }

  // Same txid at a different vout is a different coin and must still work.
  function test_allowsTheSameTxidAtDifferentIndexes() public view {
    BitcoinVmTransactionParams memory params = _defaultTxParams(2);
    params.feeUtxos[0].txid = params.allocatorUtxos[0].txid;
    params.feeUtxos[0].index = params.allocatorUtxos[0].index + 1;

    buildPayloadOnly(
      builder,
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
    buildPayloadOnly(
      builder,
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
        uint64(434)
      )
    );
    buildPayloadOnly(
      builder,
      "bitcoin-mainnet",
      "",
      _buildParams(9000, params)
    );
  }

  function test_omitsFeeChangeOutputWhenFeeUtxosExactlyCoverFeeWithChange()
    public
    view
  {
    BitcoinVmTransactionParams memory params = _defaultTxParams(2);
    // 283 vbytes with a fee change output at 2 sat/vB.
    params.feeUtxos[0].value = 566;

    BitcoinVmTransactionData memory txData = abi.decode(
      buildPayloadOnly(
        builder,
        "bitcoin-mainnet",
        "",
        _buildParams(9000, params)
      ),
      (BitcoinVmTransactionData)
    );

    assertEq(txData.outputs.length, 3);
    assertEq(txData.outputs[2].script, ALLOCATOR_SCRIPT);
  }

  function test_feeCoversEmptyWitnessOfLegacyFeeInputs() public view {
    BitcoinVmTransactionParams memory params = _defaultTxParams(1);
    params.feeUtxos = new BitcoinVmUtxo[](4);
    for (uint256 i; i < 4; ++i) {
      params.feeUtxos[i] = BitcoinVmUtxo({
        txid: bytes32(i + 2),
        index: 0,
        value: 1000,
        scriptPubKey: P2PKH_FEE_SCRIPT
      });
    }

    BitcoinVmTransactionData memory txData = abi.decode(
      buildPayloadOnly(
        builder,
        "bitcoin-mainnet",
        "",
        _buildParams(9000, params)
      ),
      (BitcoinVmTransactionData)
    );

    // Base: version 4, input count 1, P2WPKH input 41, 4 P2PKH inputs 4 * 148,
    // output count 1, outputs 31 + 43 + 31 + 31, locktime 4 = 779 bytes.
    // Witness: marker and flag 2, P2WPKH 108, 4 empty P2PKH stacks 4 * 1 = 114 bytes.
    // vsize = ceil((779 * 4 + 114) / 4) = ceil(807.5) = 808.
    assertEq(txData.outputs.length, 4);
    assertEq(4000 - txData.outputs[3].value, 808);
  }

  function test_revertsWhenTaprootReceiverProgramIsNot32Bytes() public {
    bytes memory receiver = bytes.concat(hex"01", bytes20(uint160(0x77)));

    vm.expectRevert(
      abi.encodeWithSelector(
        BitcoinVmPayloadBuilder.InvalidBitcoinAddress.selector,
        receiver
      )
    );
    buildPayloadOnly(
      builder,
      "bitcoin-mainnet",
      "",
      _buildParamsWithReceiver(9000, receiver, _defaultTxParams(2))
    );
  }

  function test_decodesProtocolEncodedTaprootReceiver() public view {
    bytes32 program = bytes32(uint256(0x77));

    BitcoinVmTransactionData memory txData = abi.decode(
      buildPayloadOnly(
        builder,
        "bitcoin-mainnet",
        "",
        _buildParamsWithReceiver(
          9000,
          bytes.concat(hex"01", program),
          _defaultTxParams(2)
        )
      ),
      (BitcoinVmTransactionData)
    );

    assertEq(txData.outputs[0].script, bytes.concat(hex"5120", program));
  }

  function test_revertsWhenFeeChangeScriptIsNon32ByteWitnessV1() public {
    BitcoinVmTransactionParams memory params = _defaultTxParams(2);
    params.feeChangeScript = bytes.concat(hex"5114", bytes20(uint160(0x77)));

    vm.expectRevert(
      abi.encodeWithSelector(
        BitcoinVmPayloadBuilder.InvalidBitcoinScript.selector,
        params.feeChangeScript
      )
    );
    buildPayloadOnly(
      builder,
      "bitcoin-mainnet",
      "",
      _buildParams(9000, params)
    );
  }

  function test_revertsWhenFeeUtxoIsNon32ByteWitnessV1() public {
    BitcoinVmTransactionParams memory params = _defaultTxParams(2);
    params.feeUtxos[0].scriptPubKey = bytes.concat(
      hex"5114",
      bytes20(uint160(0x77))
    );

    vm.expectRevert(
      abi.encodeWithSelector(
        BitcoinVmPayloadBuilder.InvalidBitcoinScript.selector,
        params.feeUtxos[0].scriptPubKey
      )
    );
    buildPayloadOnly(
      builder,
      "bitcoin-mainnet",
      "",
      _buildParams(9000, params)
    );
  }

  function test_revertsWhenReceiverUsesFutureWitnessVersion() public {
    bytes[2] memory receivers = [
      bytes.concat(hex"02", bytes32(uint256(0x77))),
      bytes.concat(hex"10", bytes32(uint256(0x77)))
    ];
    for (uint256 i; i < receivers.length; ++i) {
      vm.expectRevert(
        abi.encodeWithSelector(
          BitcoinVmPayloadBuilder.InvalidBitcoinAddress.selector,
          receivers[i]
        )
      );
      buildPayloadOnly(
        builder,
        "bitcoin-mainnet",
        "",
        _buildParamsWithReceiver(9000, receivers[i], _defaultTxParams(2))
      );
    }
  }

  function test_revertsWhenFeeChangeScriptUsesFutureWitnessVersion() public {
    bytes[2] memory scripts = [
      bytes.concat(hex"5220", bytes32(uint256(0x77))),
      bytes.concat(hex"6020", bytes32(uint256(0x77)))
    ];
    for (uint256 i; i < scripts.length; ++i) {
      BitcoinVmTransactionParams memory params = _defaultTxParams(2);
      params.feeChangeScript = scripts[i];

      vm.expectRevert(
        abi.encodeWithSelector(
          BitcoinVmPayloadBuilder.InvalidBitcoinScript.selector,
          scripts[i]
        )
      );
      buildPayloadOnly(
        builder,
        "bitcoin-mainnet",
        "",
        _buildParams(9000, params)
      );
    }
  }

  function test_revertsWhenFeeUtxoUsesFutureWitnessVersion() public {
    bytes[2] memory scripts = [
      bytes.concat(hex"5220", bytes32(uint256(0x77))),
      bytes.concat(hex"6020", bytes32(uint256(0x77)))
    ];
    for (uint256 i; i < scripts.length; ++i) {
      BitcoinVmTransactionParams memory params = _defaultTxParams(2);
      params.feeUtxos[0].scriptPubKey = scripts[i];

      vm.expectRevert(
        abi.encodeWithSelector(
          BitcoinVmPayloadBuilder.InvalidBitcoinScript.selector,
          scripts[i]
        )
      );
      buildPayloadOnly(
        builder,
        "bitcoin-mainnet",
        "",
        _buildParams(9000, params)
      );
    }
  }

  function test_revertsWhenCurrencyIsNotNativeBtc() public {
    bytes[4] memory currencies = [
      bytes(""),
      bytes("BTC"),
      bytes.concat(NATIVE_CURRENCY, hex"00"),
      // Witness version 0 with a 20-byte zero program, not the native sentinel
      bytes(hex"000000000000000000000000000000000000000000")
    ];
    for (uint256 i; i < currencies.length; ++i) {
      WithdrawRequest memory params = _buildParams(9000, _defaultTxParams(2));
      params.currency = currencies[i];

      vm.expectRevert(
        abi.encodeWithSelector(
          BitcoinVmPayloadBuilder.InvalidCurrency.selector,
          currencies[i]
        )
      );
      buildPayloadOnly(builder, "bitcoin-mainnet", "", params);
    }
  }

  function test_acceptsSdkEncodedNativeBtcCurrency() public view {
    // The SDK encodes bc1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqmql8k8 as 20 zero bytes, and native
    // BTC Hub balances and price routes are keyed by the token id of that encoding.
    WithdrawRequest memory params = _buildParams(9000, _defaultTxParams(2));
    params.currency = hex"0000000000000000000000000000000000000000";
    assertEq(params.currency.length, 20);

    bytes memory payload = buildPayloadOnly(
      builder,
      "bitcoin-mainnet",
      "",
      params
    );
    assertGt(payload.length, 0);
  }

  function test_usesConstructorAllocatorChangeScript() public view {
    assertEq(builder.allocatorChangeScript(), ALLOCATOR_SCRIPT);
  }

  function test_returnsExpectedMetadata() public view {
    assertEq(builder.curve(), "Ecdsa");
    assertEq(builder.family(), "bitcoin-vm");
  }

  function test_allows65InputsWhenLimitIsUnsetOrZero() public {
    assertEq(builder.getMaxInputs(), 0);
    _assertInputCount(1, 64);
    config.setConfigValue(builder.getMaxInputsKey(), bytes32(0));
    _assertInputCount(1, 64);
  }

  function test_allowsInputsAtAndBelowLimit() public {
    config.setConfigValue(builder.getMaxInputsKey(), bytes32(uint256(16)));
    _assertInputCount(1, 14);
    _assertInputCount(8, 8);
    _assertInputCount(16, 0);
  }

  function test_revertsWhenCombinedInputsExceedLimit() public {
    config.setConfigValue(builder.getMaxInputsKey(), bytes32(uint256(16)));
    // Each array is below the limit, but their combined count exceeds it.
    WithdrawRequest memory params = _buildParams(9000, _manyInputs(8, 9));
    vm.expectRevert(
      abi.encodeWithSelector(
        BitcoinVmPayloadBuilder.TooManyInputs.selector,
        17,
        16
      )
    );
    buildPayloadOnly(builder, "bitcoin", "", params);
  }

  function test_limitUpdatesApplyWithoutChangingStoredPayloadHashes() public {
    bytes memory payload = buildPayloadOnly(
      builder,
      "bitcoin",
      "",
      _buildParams(9000, _defaultTxParams(2))
    );
    bytes32[] memory hashes = builder.hashesToSign("bitcoin", "", payload);
    config.setConfigValue(builder.getMaxInputsKey(), bytes32(uint256(1)));
    WithdrawRequest memory params = _buildParams(9000, _defaultTxParams(2));
    vm.expectRevert(
      abi.encodeWithSelector(
        BitcoinVmPayloadBuilder.TooManyInputs.selector,
        2,
        1
      )
    );
    buildPayloadOnly(builder, "bitcoin", "", params);
    assertEq(builder.hashesToSign("bitcoin", "", payload), hashes);
    assertEq(builder.hashToSign(payload, 0), hashes[0]);
    config.setConfigValue(builder.getMaxInputsKey(), bytes32(uint256(2)));
    _assertInputCount(1, 1);
  }

  function test_defaultsToZeroWhenConfigLookupReverts() public {
    config.setConfigValue(builder.getMaxInputsKey(), bytes32(uint256(16)));
    bytes memory reason = abi.encodeWithSignature("UnexpectedConfigFailure()");
    vm.mockCallRevert(
      address(config),
      abi.encodeCall(Config.getConfigValue, (builder.getMaxInputsKey())),
      reason
    );
    assertEq(builder.getMaxInputs(), 0);
    _assertInputCount(1, 64);
  }

  function test_oversizedSubmissionDoesNotBurnOrStorePayload() public {
    config.setConfigValue(builder.getMaxInputsKey(), bytes32(uint256(16)));
    allocator.setPayloadBuilder("bitcoin", ALLOCATOR_ADDRESS, address(builder));
    hub.grantRole(hub.OPERATOR_ROLE(), address(this));
    hub.grantRole(hub.OPERATOR_ROLE(), address(allocator));
    address spender = makeAddr("spender");
    WithdrawRequest memory request = WithdrawRequest({
      chainId: "bitcoin",
      depository: ALLOCATOR_ADDRESS,
      currency: NATIVE_CURRENCY,
      amount: 9000,
      spenderChainId: "relay",
      spender: abi.encodePacked(spender),
      receiver: RECEIVER_ADDRESS,
      data: abi.encode(_manyInputs(1, 64)),
      nonce: bytes32(uint256(1))
    });
    address spenderAlias = Utils.generateAddress(
      request.spenderChainId,
      request.spender
    );
    uint256 tokenId = Utils.generateTokenId(request.chainId, request.currency);
    hub.mint(spenderAlias, tokenId, request.amount);
    bytes32 requestHash = keccak256(abi.encode(request));

    vm.expectRevert(
      abi.encodeWithSelector(
        BitcoinVmPayloadBuilder.TooManyInputs.selector,
        65,
        16
      )
    );
    vm.prank(spender);
    allocator.submitWithdrawRequest(request);

    assertEq(hub.balanceOf(spenderAlias, tokenId), request.amount);
    assertEq(allocator.payloads(requestHash).length, 0);
    assertEq(allocator.hashesToSign(requestHash, 0), bytes32(0));
  }

  function _assertInputCount(
    uint256 allocatorInputs,
    uint256 feeInputs
  ) internal view {
    bytes memory payload = buildPayloadOnly(
      builder,
      "bitcoin",
      "",
      _buildParams(9000, _manyInputs(allocatorInputs, feeInputs))
    );
    BitcoinVmTransactionData memory txData = abi.decode(
      payload,
      (BitcoinVmTransactionData)
    );
    assertEq(txData.inputs.length, allocatorInputs + feeInputs);
  }

  function _manyInputs(
    uint256 allocatorInputs,
    uint256 feeInputs
  ) internal pure returns (BitcoinVmTransactionParams memory params) {
    params.allocatorUtxos = new BitcoinVmUtxo[](allocatorInputs);
    for (uint256 i; i < allocatorInputs; ++i) {
      params.allocatorUtxos[i] = BitcoinVmUtxo({
        txid: bytes32(i + 1),
        index: 0,
        value: 10000,
        scriptPubKey: ALLOCATOR_SCRIPT
      });
    }
    params.feeUtxos = new BitcoinVmUtxo[](feeInputs);
    for (uint256 i; i < feeInputs; ++i) {
      params.feeUtxos[i] = BitcoinVmUtxo({
        txid: bytes32(allocatorInputs + i + 1),
        index: 0,
        value: 0,
        scriptPubKey: FEE_SCRIPT
      });
    }
    params.feeChangeScript = FEE_SCRIPT;
    params.feeRate = 0;
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
  ) internal pure returns (WithdrawRequest memory) {
    return _buildParamsWithReceiver(amount, RECEIVER_ADDRESS, params);
  }

  function _buildParamsWithReceiver(
    uint256 amount,
    bytes memory receiver,
    BitcoinVmTransactionParams memory params
  ) internal pure returns (WithdrawRequest memory) {
    return
      WithdrawRequest({
        chainId: "bitcoin-mainnet",
        depository: ALLOCATOR_ADDRESS,
        currency: NATIVE_CURRENCY,
        amount: amount,
        spenderChainId: "relay",
        spender: abi.encodePacked(address(1)),
        receiver: receiver,
        data: abi.encode(params),
        nonce: bytes32(uint256(1))
      });
  }

  function _expectedIdentifierScript(
    WithdrawRequest memory params
  ) internal view returns (bytes memory) {
    return
      bytes.concat(hex"6a20", keccak256(abi.encode(address(builder), params)));
  }

  /// @notice The OP_RETURN identifier commits to the whole withdraw request, so two
  /// spenders submitting byte-identical parameters get different identifiers
  function test_derivesDifferentIdentifierPerRequest() public view {
    WithdrawRequest memory first = _buildParams(9000, _defaultTxParams(2));
    first.spender = abi.encodePacked(address(1));
    WithdrawRequest memory second = _buildParams(9000, _defaultTxParams(2));
    second.spender = abi.encodePacked(address(2));

    BitcoinVmTransactionData memory a = abi.decode(
      buildPayloadOnly(builder, "bitcoin-mainnet", "", first),
      (BitcoinVmTransactionData)
    );
    BitcoinVmTransactionData memory b = abi.decode(
      buildPayloadOnly(builder, "bitcoin-mainnet", "", second),
      (BitcoinVmTransactionData)
    );

    assertEq(a.outputs[1].script, _expectedIdentifierScript(first));
    assertEq(b.outputs[1].script, _expectedIdentifierScript(second));
    assertTrue(
      keccak256(a.outputs[1].script) != keccak256(b.outputs[1].script)
    );
  }
}
