// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../utils/BaseTest.sol";
import {MockWNEAR} from "../../contracts/mocks/MockWNEAR.sol";
import {RelayMultisigSignerHarness} from "../../contracts/mocks/RelayMultisigSignerHarness.sol";

/// @notice Port of test/RelayMultisigSigner/signatureGuards.test.ts.
contract RelayMultisigSignerSignatureGuardsTest is BaseTest {
    // The TS suite passes HASH_TO_SIGN as both bytes (for approveSignature /
    // sign) and bytes32 (for the __setSignature / signatures / pendingSignatures
    // harness slots). They are the same 32-byte value.
    bytes internal constant HASH_BYTES =
        hex"5d3d45f0a5ae26873aa88714ab7636f63953326819151dd6e00296de98122963";
    bytes32 internal constant HASH_KEY =
        0x5d3d45f0a5ae26873aa88714ab7636f63953326819151dd6e00296de98122963;
    string internal constant CURVE = "Eddsa";
    uint64 internal constant SIGN_GAS = 30_000_000_000_000;
    uint64 internal constant CALLBACK_GAS = 10_000_000_000_000;

    RelayMultisigSignerHarness internal signer_;
    MockWNEAR internal wNear;

    function setUp() public override {
        super.setUp();
        // sign() does `block.timestamp - PENDING_SIGNATURE_TIMEOUT` (5 minutes);
        // Foundry's default block.timestamp is 1, which underflows. Warp to a
        // realistic value matching the Hardhat node default.
        vm.warp(1_700_000_000);
        wNear = new MockWNEAR();
        signer_ = new RelayMultisigSignerHarness(
            owner,
            "signer.testnet",
            address(wNear)
        );
    }

    function test_shortCircuitsWhenSignatureAlreadyStored() public {
        vm.prank(owner);
        signer_.approveSignature(HASH_BYTES, CURVE);

        bytes memory preset = hex"1234";
        vm.prank(owner);
        signer_.__setSignature(HASH_KEY, CURVE, preset);

        vm.prank(owner);
        signer_.sign(HASH_BYTES, CURVE, SIGN_GAS, CALLBACK_GAS);

        assertEq(signer_.signatures(HASH_KEY, CURVE), preset);
    }

    function test_skipsSigningWhenThereIsARecentPendingRequest() public {
        vm.prank(owner);
        signer_.approveSignature(HASH_BYTES, CURVE);

        vm.prank(owner);
        signer_.__setPendingTimestamp(HASH_KEY, CURVE, 2_000_000_000_000);

        vm.prank(owner);
        signer_.sign(HASH_BYTES, CURVE, SIGN_GAS, CALLBACK_GAS);

        assertEq(signer_.signatures(HASH_KEY, CURVE).length, 0);
    }

    function test_allowsRequestingSignatureAgainOnceThrottleWindowPasses()
        public
    {
        vm.prank(owner);
        signer_.approveSignature(HASH_BYTES, CURVE);

        uint256 ts = block.timestamp;
        vm.prank(owner);
        signer_.__setPendingTimestamp(HASH_KEY, CURVE, ts);

        // Within throttle window — should not be allowed to re-mark.
        bool immediateAllowed;
        try signer_.__tryMarkPendingSignature(HASH_KEY, CURVE) returns (
            bool r
        ) {
            immediateAllowed = r;
        } catch {
            immediateAllowed = false;
        }
        // The TS test does a `simulate` (no state mutation), but since
        // __tryMarkPendingSignature has both views (returns bool) and effects
        // (writes pendingSignatures), the safe way to peek without mutating
        // is to revert state with a snapshot. The simpler equivalent: assert
        // the immediate call would NOT mark, by reading the pending value
        // before/after.
        // Here we already called it: if it returned true, pending would have
        // been updated; if false, pending stays at ts.
        assertFalse(immediateAllowed);

        // Advance past the 5-minute throttle.
        vm.warp(ts + 5 * 60 + 1);

        vm.prank(owner);
        bool ready = signer_.__tryMarkPendingSignature(HASH_KEY, CURVE);
        assertTrue(ready);

        assertEq(
            signer_.pendingSignatures(HASH_KEY, CURVE),
            block.timestamp
        );
    }
}
