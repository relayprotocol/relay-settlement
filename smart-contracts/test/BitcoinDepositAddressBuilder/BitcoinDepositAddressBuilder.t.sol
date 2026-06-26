// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../utils/BaseTest.sol";
import {BitcoinDepositSweepBuilder, BitcoinTransactionData, UTXO} from "../../contracts/deposit-addresses/strict/bitcoin/BitcoinDepositSweepBuilder.sol";

/// @notice Port of test/BitcoinDepositAddressBuilder/BitcoinDepositAddressBuilder.ts.
///
/// Coverage scope: BitcoinDepositSweepBuilder describe block — buildSweepPayload,
/// setMaxFeeRate, and the determinism-style hashToSign assertions. The four tests
/// that compare against bitcoinjs-lib BIP143 SIGHASH_ALL outputs, the 253-byte
/// varint test, and the entire BitcoinDepositAddress (manager) suite all rely on
/// fixtures derived from off-chain bitcoinjs-lib + Aurora/NEAR mocking — those
/// are deferred to a follow-up PR alongside the manager tests.
///
/// The depositoryScript bytes correspond to bitcoin.address.toOutputScript(
/// '1BoatSLRHtKNngkdXEeobR76b53LETtpyT', bitcoin.networks.bitcoin) — a standard
/// P2PKH script hard-coded here so the Foundry suite doesn't need bitcoinjs-lib.
abstract contract BitcoinDepositSweepBuilderBase is BaseTest {
    // Base64 of the P2PKH script for 1BoatSLRHtKNngkdXEeobR76b53LETtpyT.
    string internal constant DEPOSITORY_SCRIPT_BASE64 =
        "dqkUdoCt7I6ryrrGdr6eg4VK3gvSLNuIrA==";
    // Equivalent raw bytes.
    bytes internal constant DEPOSITORY_SCRIPT_BYTES =
        hex"76a9147680adec8eabcabac676be9e83854ade0bd22cdb88ac";

    uint64 internal constant MAX_FEE_RATE = 100;
    uint256 internal constant SWEEP_TX_SIZE = 191;
    uint64 internal constant DUST_THRESHOLD = 546;

    // Sample UTXO matching the TS suite.
    bytes32 internal constant SAMPLE_TXID =
        0xec37cafc98e406a048e2b2592a23be7eb2c0f1e0754b0710bb2ea4efb3a9371d;
    uint32 internal constant SAMPLE_VOUT = 0;
    uint64 internal constant SAMPLE_VALUE = 100000;
    // P2WPKH scriptPubKey for the UTXO.
    bytes internal constant SAMPLE_SCRIPTPUBKEY =
        hex"0014632a250a7f721ae8583ad911950eeeb82c00e547";

    bytes32 internal constant ORDER_ID_1 =
        0x0000000000000000000000000000000000000000000000000000000000000001;
    bytes32 internal constant ORDER_ID_2 =
        0x0000000000000000000000000000000000000000000000000000000000000002;

    BitcoinDepositSweepBuilder internal builder;

    function setUp() public virtual override {
        super.setUp();
        builder = new BitcoinDepositSweepBuilder(
            owner,
            DEPOSITORY_SCRIPT_BASE64,
            MAX_FEE_RATE
        );
    }

    function _encodeSweepData(
        UTXO memory utxo,
        uint64 feeRate
    ) internal pure returns (bytes memory) {
        return abi.encode(utxo, feeRate);
    }

    function _defaultUtxo() internal pure returns (UTXO memory) {
        return
            UTXO({
                txid: SAMPLE_TXID,
                index: SAMPLE_VOUT,
                value: SAMPLE_VALUE,
                scriptPubKey: SAMPLE_SCRIPTPUBKEY
            });
    }

    function _decodeUint64LE(
        bytes memory data
    ) internal pure returns (uint64 v) {
        require(data.length == 8, "expected 8 bytes for uint64LE");
        for (uint256 i = 0; i < 8; i++) {
            v |= uint64(uint8(data[i])) << uint8(i * 8);
        }
    }
}

contract BitcoinDepositSweepBuilderBuildSweepPayloadTest is
    BitcoinDepositSweepBuilderBase
{
    function test_revertsIfFeeRateExceedsMaxFeeRate() public {
        uint64 excessive = MAX_FEE_RATE + 1;
        vm.expectRevert(
            abi.encodeWithSelector(
                BitcoinDepositSweepBuilder.FeeRateTooHigh.selector,
                excessive,
                MAX_FEE_RATE
            )
        );
        builder.buildSweepPayload(
            ORDER_ID_1,
            _encodeSweepData(_defaultUtxo(), excessive)
        );
    }

    function test_revertsIfUtxoValueDoesNotCoverFees() public {
        uint64 tinyValue = 100;
        uint64 feeRate = 10;
        uint256 expectedFees = uint256(feeRate) * SWEEP_TX_SIZE;
        UTXO memory utxo = _defaultUtxo();
        utxo.value = tinyValue;

        vm.expectRevert(
            abi.encodeWithSelector(
                BitcoinDepositSweepBuilder.InsufficientUTXOValue.selector,
                tinyValue,
                expectedFees
            )
        );
        builder.buildSweepPayload(ORDER_ID_1, _encodeSweepData(utxo, feeRate));
    }

    function test_revertsIfSweepAmountIsBelowDustThreshold() public {
        uint64 feeRate = 10;
        uint64 fees = uint64(uint256(feeRate) * SWEEP_TX_SIZE);
        uint64 dustValue = fees + 545; // sweepAmount = 545 (< 546)
        UTXO memory utxo = _defaultUtxo();
        utxo.value = dustValue;

        vm.expectRevert(
            abi.encodeWithSelector(
                BitcoinDepositSweepBuilder.SweepAmountBelowDust.selector,
                uint64(545)
            )
        );
        builder.buildSweepPayload(ORDER_ID_1, _encodeSweepData(utxo, feeRate));
    }

    function test_producesExactly2Outputs() public view {
        (bytes memory payload, ) = builder.buildSweepPayload(
            ORDER_ID_1,
            _encodeSweepData(_defaultUtxo(), 1)
        );
        BitcoinTransactionData memory tx_ = abi.decode(
            payload,
            (BitcoinTransactionData)
        );
        assertEq(tx_.inputs.length, 1);
        assertEq(tx_.outputs.length, 2);
    }

    function test_setsCorrectDepositoryOutputValueAfterFeeDeduction()
        public
        view
    {
        uint64 feeRate = 5;
        uint64 expectedFees = uint64(uint256(feeRate) * SWEEP_TX_SIZE);
        uint64 expectedSweep = SAMPLE_VALUE - expectedFees;

        (bytes memory payload, ) = builder.buildSweepPayload(
            ORDER_ID_1,
            _encodeSweepData(_defaultUtxo(), feeRate)
        );
        BitcoinTransactionData memory tx_ = abi.decode(
            payload,
            (BitcoinTransactionData)
        );
        assertEq(_decodeUint64LE(tx_.outputs[0].value), expectedSweep);
    }

    function test_setsDepositoryOutputScriptToDepositoryScriptBytes()
        public
        view
    {
        (bytes memory payload, ) = builder.buildSweepPayload(
            ORDER_ID_1,
            _encodeSweepData(_defaultUtxo(), 1)
        );
        BitcoinTransactionData memory tx_ = abi.decode(
            payload,
            (BitcoinTransactionData)
        );
        assertEq(tx_.outputs[0].script, DEPOSITORY_SCRIPT_BYTES);
    }

    function test_setsOpReturnOutputWithZeroValueAndCorrectScript() public view {
        (bytes memory payload, ) = builder.buildSweepPayload(
            ORDER_ID_1,
            _encodeSweepData(_defaultUtxo(), 1)
        );
        BitcoinTransactionData memory tx_ = abi.decode(
            payload,
            (BitcoinTransactionData)
        );

        assertEq(_decodeUint64LE(tx_.outputs[1].value), uint64(0));

        // Script = 0x6a (OP_RETURN) + 0x42 (PUSH 66) + ASCII "0x" + hex(orderId).
        string memory orderHex = _bytes32ToHexString(ORDER_ID_1);
        bytes memory expected = abi.encodePacked(
            hex"6a42",
            "0x",
            bytes(orderHex)
        );
        assertEq(tx_.outputs[1].script, expected);
    }

    function test_worksWithZeroFeeRate() public view {
        (bytes memory payload, ) = builder.buildSweepPayload(
            ORDER_ID_1,
            _encodeSweepData(_defaultUtxo(), 0)
        );
        BitcoinTransactionData memory tx_ = abi.decode(
            payload,
            (BitcoinTransactionData)
        );
        assertEq(_decodeUint64LE(tx_.outputs[0].value), SAMPLE_VALUE);
    }

    function test_revertsIfScriptPubKeyIsNotP2wpkh() public {
        // P2PKH (legacy), not P2WPKH.
        bytes memory legacyScript = hex"76a914632a250a7f721ae8583ad911950eeeb82c00e54788ac";
        UTXO memory utxo = _defaultUtxo();
        utxo.scriptPubKey = legacyScript;

        vm.expectRevert(BitcoinDepositSweepBuilder.InvalidScriptPubKey.selector);
        builder.buildSweepPayload(ORDER_ID_1, _encodeSweepData(utxo, 1));
    }

    function test_revertsIfScriptPubKeyLengthIsNot22Bytes() public {
        // 21-byte script (one byte short).
        bytes memory shortScript = hex"0014632a250a7f721ae8583ad911950eeeb82c00e5";
        UTXO memory utxo = _defaultUtxo();
        utxo.scriptPubKey = shortScript;

        vm.expectRevert(BitcoinDepositSweepBuilder.InvalidScriptPubKey.selector);
        builder.buildSweepPayload(ORDER_ID_1, _encodeSweepData(utxo, 1));
    }

    function test_revertsIfScriptPubKeyFirstByteIsNotZero() public {
        // 22 bytes, starts with 0xa9 (P2SH version), second byte 0x14.
        bytes memory wrongVersion = hex"a914632a250a7f721ae8583ad911950eeeb82c00e547";
        UTXO memory utxo = _defaultUtxo();
        utxo.scriptPubKey = wrongVersion;

        vm.expectRevert(BitcoinDepositSweepBuilder.InvalidScriptPubKey.selector);
        builder.buildSweepPayload(ORDER_ID_1, _encodeSweepData(utxo, 1));
    }

    function test_revertsIfScriptPubKeyPushLengthIsNot0x14() public {
        // P2WSH/P2TR-style header (0x0020) — invalid push length for P2WPKH.
        bytes memory wrongPush = hex"0020632a250a7f721ae8583ad911950eeeb82c00e547";
        UTXO memory utxo = _defaultUtxo();
        utxo.scriptPubKey = wrongPush;

        vm.expectRevert(BitcoinDepositSweepBuilder.InvalidScriptPubKey.selector);
        builder.buildSweepPayload(ORDER_ID_1, _encodeSweepData(utxo, 1));
    }

    function test_permitsSweepAmountExactlyEqualToDustThreshold() public view {
        uint64 feeRate = 1;
        uint64 fees = uint64(uint256(feeRate) * SWEEP_TX_SIZE);
        uint64 dustValue = fees + DUST_THRESHOLD;

        UTXO memory utxo = _defaultUtxo();
        utxo.value = dustValue;

        (bytes memory payload, uint64 sweepAmount) = builder.buildSweepPayload(
            ORDER_ID_1,
            _encodeSweepData(utxo, feeRate)
        );
        assertEq(sweepAmount, DUST_THRESHOLD);
        BitcoinTransactionData memory tx_ = abi.decode(
            payload,
            (BitcoinTransactionData)
        );
        assertEq(_decodeUint64LE(tx_.outputs[0].value), DUST_THRESHOLD);
    }

    function test_permitsFeeRateExactlyEqualToMaxFeeRate() public view {
        uint64 fees = uint64(uint256(MAX_FEE_RATE) * SWEEP_TX_SIZE);
        uint64 expectedSweep = SAMPLE_VALUE - fees;

        (bytes memory payload, uint64 sweepAmount) = builder.buildSweepPayload(
            ORDER_ID_1,
            _encodeSweepData(_defaultUtxo(), MAX_FEE_RATE)
        );
        assertEq(sweepAmount, expectedSweep);
        BitcoinTransactionData memory tx_ = abi.decode(
            payload,
            (BitcoinTransactionData)
        );
        assertEq(_decodeUint64LE(tx_.outputs[0].value), expectedSweep);
    }

    function test_producesDistinctOpReturnScriptsForDistinctOrderIds()
        public
        view
    {
        (bytes memory payload1, ) = builder.buildSweepPayload(
            ORDER_ID_1,
            _encodeSweepData(_defaultUtxo(), 1)
        );
        (bytes memory payload2, ) = builder.buildSweepPayload(
            ORDER_ID_2,
            _encodeSweepData(_defaultUtxo(), 1)
        );
        BitcoinTransactionData memory tx1 = abi.decode(
            payload1,
            (BitcoinTransactionData)
        );
        BitcoinTransactionData memory tx2 = abi.decode(
            payload2,
            (BitcoinTransactionData)
        );

        // Structure: 0x6a + 0x42 + ASCII("0x") + 64 hex chars = 68 bytes.
        for (uint256 i = 0; i < 2; i++) {
            bytes memory script = i == 0
                ? tx1.outputs[1].script
                : tx2.outputs[1].script;
            assertEq(script.length, 68);
            assertEq(uint8(script[0]), uint8(0x6a));
            assertEq(uint8(script[1]), uint8(0x42));
            // ASCII payload starts at index 2.
            assertEq(uint8(script[2]), uint8(bytes1("0")));
            assertEq(uint8(script[3]), uint8(bytes1("x")));
        }

        // OP_RETURN differs across orderIds; depository output is identical.
        assertTrue(
            keccak256(tx1.outputs[1].script) !=
                keccak256(tx2.outputs[1].script)
        );
        assertEq(
            keccak256(tx1.outputs[0].script),
            keccak256(tx2.outputs[0].script)
        );
        assertEq(
            keccak256(tx1.outputs[0].value),
            keccak256(tx2.outputs[0].value)
        );
    }

    function test_roundTripsDepositoryScriptBytesFromConstructorInput()
        public
        view
    {
        bytes memory stored = builder.depositoryScriptBytes();
        assertEq(stored, DEPOSITORY_SCRIPT_BYTES);
    }

    /// @dev Lowercase hex string of a bytes32, no 0x prefix.
    function _bytes32ToHexString(
        bytes32 v
    ) internal pure returns (string memory) {
        bytes memory hexChars = "0123456789abcdef";
        bytes memory out = new bytes(64);
        for (uint256 i = 0; i < 32; i++) {
            uint8 b = uint8(v[i]);
            out[i * 2] = hexChars[b >> 4];
            out[i * 2 + 1] = hexChars[b & 0x0f];
        }
        return string(out);
    }
}

contract BitcoinDepositSweepBuilderHashToSignTest is
    BitcoinDepositSweepBuilderBase
{
    function test_producesDifferentHashesForDifferentOrderIds() public view {
        (bytes memory p1, ) = builder.buildSweepPayload(
            ORDER_ID_1,
            _encodeSweepData(_defaultUtxo(), 1)
        );
        (bytes memory p2, ) = builder.buildSweepPayload(
            ORDER_ID_2,
            _encodeSweepData(_defaultUtxo(), 1)
        );
        bytes32 h1 = builder.hashToSign(p1);
        bytes32 h2 = builder.hashToSign(p2);
        assertTrue(h1 != h2);
    }

    function test_producesDifferentHashesForDifferentUtxoValues() public view {
        UTXO memory a = _defaultUtxo();
        UTXO memory b = _defaultUtxo();
        b.value = SAMPLE_VALUE - 1000;

        (bytes memory p1, ) = builder.buildSweepPayload(
            ORDER_ID_1,
            _encodeSweepData(a, 1)
        );
        (bytes memory p2, ) = builder.buildSweepPayload(
            ORDER_ID_1,
            _encodeSweepData(b, 1)
        );
        bytes32 h1 = builder.hashToSign(p1);
        bytes32 h2 = builder.hashToSign(p2);
        assertTrue(h1 != h2);
    }
}

contract BitcoinDepositSweepBuilderSetMaxFeeRateTest is
    BitcoinDepositSweepBuilderBase
{
    function test_updatesMaxFeeRateWhenCalledByOwner() public {
        vm.prank(owner);
        builder.setMaxFeeRate(MAX_FEE_RATE + 1);
        assertEq(builder.maxFeeRate(), MAX_FEE_RATE + 1);
    }

    function test_emitsMaxFeeRateChangedEvent() public {
        vm.expectEmit(false, false, false, true, address(builder));
        emit BitcoinDepositSweepBuilder.MaxFeeRateChanged(MAX_FEE_RATE + 1);
        vm.prank(owner);
        builder.setMaxFeeRate(MAX_FEE_RATE + 1);
    }

    function test_revertsWhenCalledByNonOwner() public {
        vm.prank(otherAccounts[0]);
        vm.expectRevert();
        builder.setMaxFeeRate(MAX_FEE_RATE + 1);
    }
}
