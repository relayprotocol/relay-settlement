// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {BaseTest} from "../utils/BaseTest.sol";
import {BitcoinDepositAddress, GasSettings} from "../../contracts/deposit-addresses/strict/bitcoin/BitcoinDepositAddress.sol";
import {BitcoinDepositSweepBuilder, UTXO} from "../../contracts/deposit-addresses/strict/bitcoin/BitcoinDepositSweepBuilder.sol";
import {TestableBitcoinDepositAddress} from "../../contracts/mocks/TestableBitcoinDepositAddress.sol";
import {MockWNEAR} from "../../contracts/mocks/MockWNEAR.sol";

/// @notice Port of the BitcoinDepositAddress describe block in
/// test/BitcoinDepositAddressBuilder/BitcoinDepositAddressBuilder.ts.
///
/// Companion to test-foundry/BitcoinDepositAddressBuilder/BitcoinDepositAddressBuilder.t.sol
/// (the BitcoinDepositSweepBuilder describe block, ported in #395).
///
/// The TS tests exercised the production `sweep()` path; that path invokes
/// the Aurora SDK precompiles which can't run in Foundry. We use the
/// `TestableBitcoinDepositAddress` harness — already kept in the repo for
/// the equivalent Hardhat workaround — which mirrors the validation block
/// of `_requestSignature` without the precompile call.
abstract contract BitcoinDepositAddressBase is BaseTest {
    // P2PKH script for 1BoatSLRHtKNngkdXEeobR76b53LETtpyT — hard-coded so
    // the suite stays free of a bitcoinjs-lib runtime dependency.
    string internal constant DEPOSITORY_SCRIPT_BASE64 =
        "dqkUdoCt7I6ryrrGdr6eg4VK3gvSLNuIrA==";

    uint64 internal constant MAX_FEE_RATE = 100;
    uint256 internal constant SWEEP_TX_SIZE = 191;

    uint64 internal constant MIN_SIGN_GAS = 30_000_000_000_000;
    uint64 internal constant MIN_CALLBACK_GAS = 20_000_000_000_000;
    uint256 internal constant PENDING_SIGNATURE_COOLDOWN = 5 minutes;

    bytes32 internal constant SAMPLE_TXID =
        0xec37cafc98e406a048e2b2592a23be7eb2c0f1e0754b0710bb2ea4efb3a9371d;
    bytes32 internal constant ALT_TXID =
        0x0000000000000000000000000000000000000000000000000000000000000abc;
    uint32 internal constant SAMPLE_VOUT = 0;
    uint64 internal constant SAMPLE_VALUE = 100000;
    bytes internal constant SAMPLE_SCRIPTPUBKEY =
        hex"0014632a250a7f721ae8583ad911950eeeb82c00e547";

    bytes32 internal constant ORDER_ID_1 =
        0x0000000000000000000000000000000000000000000000000000000000000001;
    bytes32 internal constant ORDER_ID_2 =
        0x0000000000000000000000000000000000000000000000000000000000000002;

    BitcoinDepositSweepBuilder internal builder;
    BitcoinDepositAddress internal manager;
    MockWNEAR internal wNEAR;

    function setUp() public virtual override {
        super.setUp();
        // Aurora SDK does block.timestamp arithmetic; keep a realistic time.
        vm.warp(1_700_000_000);

        wNEAR = new MockWNEAR();
        builder = new BitcoinDepositSweepBuilder(
            owner,
            DEPOSITORY_SCRIPT_BASE64,
            MAX_FEE_RATE
        );
        manager = new BitcoinDepositAddress(
            owner,
            address(builder),
            "v1.signer.test",
            address(wNEAR)
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

    function _defaultSweepData() internal pure returns (bytes memory) {
        return _encodeSweepData(_defaultUtxo(), 1);
    }
}

contract BitcoinDepositAddressDerivationPathTest is BitcoinDepositAddressBase {
    function test_returnsCorrectFormat_hexAddressSlashHexOrderId() public view {
        string memory path = manager.derivationPath(ORDER_ID_1);

        // Must contain the manager address (toHexString includes 0x prefix).
        assertTrue(_contains(path, _toLowerHex(address(manager))));
        // Must contain a slash separator.
        assertTrue(_contains(path, "/"));
        // Must end with the hex-encoded orderId (no 0x prefix, stringifyBytes).
        assertTrue(_contains(path, _orderIdHex(ORDER_ID_1)));
    }

    function test_returnsDeterministicResultsForTheSameOrderId() public view {
        assertEq(manager.derivationPath(ORDER_ID_1), manager.derivationPath(ORDER_ID_1));
    }

    function test_returnsUniquePathsForDifferentOrderIds() public view {
        assertTrue(
            keccak256(bytes(manager.derivationPath(ORDER_ID_1))) !=
                keccak256(bytes(manager.derivationPath(ORDER_ID_2)))
        );
    }

    function _contains(string memory haystack, string memory needle) private pure returns (bool) {
        bytes memory h = bytes(haystack);
        bytes memory n = bytes(needle);
        if (n.length > h.length) return false;
        for (uint256 i = 0; i <= h.length - n.length; ++i) {
            bool ok = true;
            for (uint256 j = 0; j < n.length; ++j) {
                if (h[i + j] != n[j]) {
                    ok = false;
                    break;
                }
            }
            if (ok) return true;
        }
        return false;
    }

    function _toLowerHex(address a) private pure returns (string memory) {
        bytes memory alphabet = "0123456789abcdef";
        bytes memory out = new bytes(42);
        out[0] = "0";
        out[1] = "x";
        uint256 v = uint160(a);
        for (uint256 i = 0; i < 20; ++i) {
            uint8 b = uint8(v >> (8 * (19 - i)));
            out[2 + i * 2] = alphabet[b >> 4];
            out[2 + i * 2 + 1] = alphabet[b & 0x0f];
        }
        return string(out);
    }

    function _orderIdHex(bytes32 id) private pure returns (string memory) {
        bytes memory alphabet = "0123456789abcdef";
        bytes memory out = new bytes(64);
        for (uint256 i = 0; i < 32; ++i) {
            uint8 b = uint8(uint256(id) >> (8 * (31 - i)));
            out[i * 2] = alphabet[b >> 4];
            out[i * 2 + 1] = alphabet[b & 0x0f];
        }
        return string(out);
    }
}

contract BitcoinDepositAddressSweepReadOnlyTest is BitcoinDepositAddressBase {
    /// @dev TS suite verifies sweep() indirectly via buildSweepPayload(view)
    /// because Aurora precompiles are unavailable. The Foundry port preserves
    /// the same indirect verification.
    function test_storesThePayloadInSweepPayloads_viaBuildSweepPayload() public view {
        (bytes memory payload, ) = builder.buildSweepPayload(ORDER_ID_1, _defaultSweepData());
        assertGt(payload.length, 0);
    }

    function test_producesConsistentPayloadsForTheSameInputs() public view {
        (bytes memory p1, ) = builder.buildSweepPayload(ORDER_ID_1, _defaultSweepData());
        (bytes memory p2, ) = builder.buildSweepPayload(ORDER_ID_1, _defaultSweepData());
        assertEq(keccak256(p1), keccak256(p2));
    }
}

contract BitcoinDepositAddressSetSweepBuilderTest is BitcoinDepositAddressBase {
    function test_updatesSweepBuilderWhenCalledByOwner() public {
        address newBuilder = address(builder);
        vm.prank(owner);
        manager.setSweepBuilder(newBuilder);
        assertEq(address(manager.sweepBuilder()), newBuilder);
    }

    function test_emitsSweepBuilderChangedEvent() public {
        vm.expectEmit(true, true, true, true, address(manager));
        emit BitcoinDepositAddress.SweepBuilderChanged(address(builder));
        vm.prank(owner);
        manager.setSweepBuilder(address(builder));
    }

    function test_revertsWhenCalledByNonOwner() public {
        vm.prank(otherAccounts[0]);
        vm.expectRevert();
        manager.setSweepBuilder(address(builder));
    }
}

contract BitcoinDepositAddressInitTest is BitcoinDepositAddressBase {
    function test_revertsWhenCalledByNonOwner() public {
        vm.prank(otherAccounts[0]);
        vm.expectRevert();
        manager.init();
    }
}

abstract contract BitcoinDepositAddressTestableBase is BitcoinDepositAddressBase {
    TestableBitcoinDepositAddress internal testable;
    bytes internal payload;
    bytes32 internal payloadHash;
    bytes internal sweepData;

    GasSettings internal validGas =
        GasSettings({signGas: MIN_SIGN_GAS, callbackGas: MIN_CALLBACK_GAS});

    function setUp() public virtual override {
        super.setUp();
        testable = new TestableBitcoinDepositAddress(
            owner,
            address(builder),
            "v1.signer.test",
            address(wNEAR)
        );

        sweepData = _defaultSweepData();
        (payload, ) = builder.buildSweepPayload(ORDER_ID_1, sweepData);
        payloadHash = builder.hashToSign(payload);
    }
}

contract BitcoinDepositAddressInsufficientGasTest is BitcoinDepositAddressTestableBase {
    function test_revertsWhenSignGasBelowMinimum() public {
        uint64 tooLow = MIN_SIGN_GAS - 1;
        vm.expectRevert(
            abi.encodeWithSelector(
                BitcoinDepositAddress.InsufficientGas.selector,
                tooLow,
                MIN_SIGN_GAS
            )
        );
        testable.sweepNoCall(
            ORDER_ID_1,
            sweepData,
            GasSettings({signGas: tooLow, callbackGas: MIN_CALLBACK_GAS})
        );
    }

    function test_revertsWhenCallbackGasBelowMinimum() public {
        uint64 tooLow = MIN_CALLBACK_GAS - 1;
        vm.expectRevert(
            abi.encodeWithSelector(
                BitcoinDepositAddress.InsufficientGas.selector,
                tooLow,
                MIN_CALLBACK_GAS
            )
        );
        testable.sweepNoCall(
            ORDER_ID_1,
            sweepData,
            GasSettings({signGas: MIN_SIGN_GAS, callbackGas: tooLow})
        );
    }
}

contract BitcoinDepositAddressFirstSweepTest is BitcoinDepositAddressTestableBase {
    function test_storesPayloadSetsPendingSignaturesAndEmitsSweepSubmitted() public {
        uint64 expectedSweep = SAMPLE_VALUE - uint64(uint256(1) * SWEEP_TX_SIZE);

        vm.expectEmit(true, true, true, true, address(testable));
        emit BitcoinDepositAddress.SweepSubmitted(ORDER_ID_1, payload, expectedSweep);
        testable.sweepNoCall(ORDER_ID_1, sweepData, validGas);

        assertEq(
            keccak256(testable.sweepPayloads(ORDER_ID_1, payloadHash)),
            keccak256(payload)
        );
        assertEq(
            testable.pendingSignatures(ORDER_ID_1, payloadHash),
            block.timestamp + PENDING_SIGNATURE_COOLDOWN
        );
    }
}

contract BitcoinDepositAddressCooldownTest is BitcoinDepositAddressTestableBase {
    function test_revertsSignaturePendingDuringCooldownWindow() public {
        testable.sweepNoCall(ORDER_ID_1, sweepData, validGas);
        uint256 expiration = block.timestamp + PENDING_SIGNATURE_COOLDOWN;

        vm.expectRevert(
            abi.encodeWithSelector(
                BitcoinDepositAddress.SignaturePending.selector,
                ORDER_ID_1,
                expiration
            )
        );
        testable.sweepNoCall(ORDER_ID_1, sweepData, validGas);
    }

    function test_permitsRecallAfterCooldownElapses() public {
        testable.sweepNoCall(ORDER_ID_1, sweepData, validGas);
        uint256 firstExpiration = block.timestamp + PENDING_SIGNATURE_COOLDOWN;

        vm.warp(firstExpiration + 1);
        testable.sweepNoCall(ORDER_ID_1, sweepData, validGas);

        assertEq(
            testable.pendingSignatures(ORDER_ID_1, payloadHash),
            block.timestamp + PENDING_SIGNATURE_COOLDOWN
        );
    }
}

contract BitcoinDepositAddressSignatureAlreadyCompleteTest is BitcoinDepositAddressTestableBase {
    function test_revertsWhenSignedPayloadsIsAlreadyPopulated() public {
        bytes memory dummySig = hex"deadbeef";
        testable.setSignedPayload(ORDER_ID_1, payloadHash, dummySig);

        vm.expectRevert(
            abi.encodeWithSelector(
                BitcoinDepositAddress.SignatureAlreadyComplete.selector,
                ORDER_ID_1,
                payloadHash
            )
        );
        testable.sweepNoCall(ORDER_ID_1, sweepData, validGas);
    }
}

contract BitcoinDepositAddressSweepCallbackTest is BitcoinDepositAddressTestableBase {
    function test_revertsWhenCalledFromNonAuroraMsgSender() public {
        bytes32 dummyHash = bytes32(
            0xabababababababababababababababababababababababababababababababab
        );
        vm.prank(otherAccounts[0]);
        vm.expectRevert(
            abi.encodeWithSelector(
                BitcoinDepositAddress.SignCallbackFailed.selector,
                ORDER_ID_1
            )
        );
        testable.sweepCallback(ORDER_ID_1, dummyHash);
    }
}

contract BitcoinDepositAddressSameOrderIdMultiHashTest is BitcoinDepositAddressTestableBase {
    function test_tracksPendingSignaturesIndependentlyAcrossHashesWithinOneOrderId() public {
        testable.sweepNoCall(ORDER_ID_1, sweepData, validGas);

        UTXO memory altUtxo = _defaultUtxo();
        altUtxo.txid = ALT_TXID;
        bytes memory altSweepData = _encodeSweepData(altUtxo, 1);
        (bytes memory altPayload, ) = builder.buildSweepPayload(ORDER_ID_1, altSweepData);
        bytes32 altHash = builder.hashToSign(altPayload);
        assertTrue(altHash != payloadHash);

        testable.sweepNoCall(ORDER_ID_1, altSweepData, validGas);

        assertTrue(testable.pendingSignatures(ORDER_ID_1, payloadHash) != 0);
        assertTrue(testable.pendingSignatures(ORDER_ID_1, altHash) != 0);
    }
}

contract BitcoinDepositAddressMultiOrderIdTest is BitcoinDepositAddressTestableBase {
    function test_tracksPendingSignaturesPerOrderIdHashIndependently() public {
        testable.sweepNoCall(ORDER_ID_1, sweepData, validGas);

        (bytes memory payload2, ) = builder.buildSweepPayload(ORDER_ID_2, sweepData);
        bytes32 hash2 = builder.hashToSign(payload2);
        testable.sweepNoCall(ORDER_ID_2, sweepData, validGas);

        assertTrue(testable.pendingSignatures(ORDER_ID_1, payloadHash) != 0);
        assertTrue(testable.pendingSignatures(ORDER_ID_2, hash2) != 0);
        assertTrue(payloadHash != hash2);

        vm.expectRevert();
        testable.sweepNoCall(ORDER_ID_1, sweepData, validGas);
        vm.expectRevert();
        testable.sweepNoCall(ORDER_ID_2, sweepData, validGas);
    }
}
