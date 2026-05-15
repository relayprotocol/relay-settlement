// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {RelayOracleMultisigBase} from "./RelayOracleMultisigBase.sol";
import {Eip712} from "../utils/Eip712.sol";
import {RelayHub} from "../../contracts/RelayHub.sol";
import {RelayOracle} from "../../contracts/RelayOracle.sol";
import {RelayOracleMultisig} from "../../contracts/RelayOracleMultisig.sol";

/// @notice Port of test/RelayOracleMultisig/integration.ts.
contract RelayOracleMultisigIntegrationTest is RelayOracleMultisigBase {
    RelayHub internal hub;
    RelayOracle internal oracle;
    RelayOracleMultisig internal multisig;

    bytes32 internal oracleDomain;
    bytes32 internal constant EXECUTION_TYPEHASH =
        keccak256("Execution(bytes32 idempotencyKey,bytes[] actions)");

    function setUp() public override {
        super.setUp();
        hub = new RelayHub(multisigOwner);
        oracle = new RelayOracle(multisigOwner, address(hub));
        multisig = _defaultMultisig();

        bytes32 operatorRole = hub.OPERATOR_ROLE();
        bytes32 oracleRole = oracle.ORACLE_ROLE();

        vm.prank(multisigOwner);
        oracle.grantRole(oracleRole, address(multisig));
        vm.prank(multisigOwner);
        hub.grantRole(operatorRole, address(oracle));

        oracleDomain = Eip712.domainSeparator(
            "RelayOracle",
            "1",
            block.chainid,
            address(oracle)
        );
    }

    function _mintAction(
        address hubToAddress,
        uint256 hubTokenId,
        uint256 amount
    ) internal pure returns (bytes memory) {
        return
            abi.encode(
                uint8(RelayOracle.ActionType.MINT),
                hubToAddress,
                hubTokenId,
                amount
            );
    }

    function _executionDigest(
        bytes32 idempotencyKey,
        bytes[] memory actions
    ) internal view returns (bytes32) {
        bytes32[] memory actionHashes = new bytes32[](actions.length);
        for (uint256 i = 0; i < actions.length; i++) {
            actionHashes[i] = keccak256(actions[i]);
        }
        bytes32 structHash = keccak256(
            abi.encode(
                EXECUTION_TYPEHASH,
                idempotencyKey,
                keccak256(abi.encodePacked(actionHashes))
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", oracleDomain, structHash));
    }

    function _signExecutionWith(
        uint256[2] memory pks,
        bytes32 idempotencyKey,
        bytes[] memory actions
    ) internal view returns (bytes memory) {
        bytes32 digest = _executionDigest(idempotencyKey, actions);
        // signer order: ascending by address. pks[] must already be in that
        // order — the integration tests prepare them that way.
        (uint8 v0, bytes32 r0, bytes32 s0) = vm.sign(pks[0], digest);
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(pks[1], digest);
        return
            bytes.concat(
                abi.encodePacked(r0, s0, v0),
                abi.encodePacked(r1, s1, v1)
            );
    }

    function _hubAddr(address a) internal pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encode("hub-addr", a)))));
    }

    function _hubTokenId(address a) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode("hub-token", a)));
    }

    function test_executesMintWhenMultisigValidatesSignature() public {
        address recipient = otherAccounts[3];
        uint256 tokenId = _hubTokenId(otherAccounts[2]);
        address hubTo = _hubAddr(recipient);
        uint256 amount = 1e18;

        bytes[] memory actions = new bytes[](1);
        actions[0] = _mintAction(hubTo, tokenId, amount);
        bytes32 idempotencyKey = keccak256("multisig-mint");

        // pks[0] and pks[1] are the two smallest signer addresses (already
        // sorted ascending by address in setUp).
        bytes memory sig = _signExecutionWith(
            [signerPks[0], signerPks[1]],
            idempotencyKey,
            actions
        );

        uint256 before_ = hub.balanceOf(hubTo, tokenId);

        vm.expectEmit(true, false, false, true, address(oracle));
        emit RelayOracle.Executed(idempotencyKey, actions);

        oracle.execute(
            RelayOracle.Execution({
                idempotencyKey: idempotencyKey,
                actions: actions
            }),
            address(multisig),
            sig
        );

        assertEq(hub.balanceOf(hubTo, tokenId) - before_, amount);
    }

    function test_rejectsExecutionWithInsufficientMultisigSignatures() public {
        bytes[] memory actions = new bytes[](1);
        actions[0] = _mintAction(
            _hubAddr(otherAccounts[3]),
            _hubTokenId(otherAccounts[2]),
            1e18
        );
        bytes32 idempotencyKey = keccak256("insufficient");

        // Single signature — well below threshold.
        bytes32 digest = _executionDigest(idempotencyKey, actions);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPks[0], digest);
        bytes memory single = abi.encodePacked(r, s, v);

        vm.expectRevert(
            abi.encodeWithSelector(
                RelayOracle.InvalidSignature.selector,
                address(multisig)
            )
        );
        oracle.execute(
            RelayOracle.Execution({
                idempotencyKey: idempotencyKey,
                actions: actions
            }),
            address(multisig),
            single
        );
    }

    function test_rejectsExecutionWithAllSignaturesFromNonSigners() public {
        (address ns1, uint256 nsPk1) = makeAddrAndKey("nonSigner1");
        (address ns2, uint256 nsPk2) = makeAddrAndKey("nonSigner2");

        bytes[] memory actions = new bytes[](1);
        actions[0] = _mintAction(
            _hubAddr(otherAccounts[3]),
            _hubTokenId(otherAccounts[2]),
            1e18
        );
        bytes32 idempotencyKey = keccak256("non-signers");
        bytes32 digest = _executionDigest(idempotencyKey, actions);

        // Order non-signers ascending so the contract doesn't fail on
        // InvalidSignatureOrder before reaching the SignerNotAuthorized check.
        uint256 pkA = ns1 < ns2 ? nsPk1 : nsPk2;
        uint256 pkB = ns1 < ns2 ? nsPk2 : nsPk1;

        (uint8 v0, bytes32 r0, bytes32 s0) = vm.sign(pkA, digest);
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(pkB, digest);
        bytes memory combined = bytes.concat(
            abi.encodePacked(r0, s0, v0),
            abi.encodePacked(r1, s1, v1)
        );

        vm.expectRevert(
            abi.encodeWithSelector(
                RelayOracle.InvalidSignature.selector,
                address(multisig)
            )
        );
        oracle.execute(
            RelayOracle.Execution({
                idempotencyKey: idempotencyKey,
                actions: actions
            }),
            address(multisig),
            combined
        );
    }

    function test_worksWithExecuteMultiple() public {
        address recipient = otherAccounts[3];
        uint256 tokenId = _hubTokenId(otherAccounts[2]);
        address hubTo = _hubAddr(recipient);
        uint256 amount = 1e18;

        bytes[] memory a1 = new bytes[](1);
        a1[0] = _mintAction(hubTo, tokenId, amount);
        bytes[] memory a2 = new bytes[](1);
        a2[0] = _mintAction(hubTo, tokenId, amount * 2);

        RelayOracle.Execution[] memory execs = new RelayOracle.Execution[](2);
        execs[0] = RelayOracle.Execution({
            idempotencyKey: keccak256("ek-1"),
            actions: a1
        });
        execs[1] = RelayOracle.Execution({
            idempotencyKey: keccak256("ek-2"),
            actions: a2
        });

        bytes[] memory sigs = new bytes[](2);
        // First execution signed by signers[0] + signers[1].
        sigs[0] = _signExecutionWith(
            [signerPks[0], signerPks[1]],
            execs[0].idempotencyKey,
            a1
        );
        // Second execution signed by signers[0] + signers[2] — also a valid
        // 2-of-3, but a different pair.
        sigs[1] = _signExecutionWith(
            [signerPks[0], signerPks[2]],
            execs[1].idempotencyKey,
            a2
        );

        uint256 before_ = hub.balanceOf(hubTo, tokenId);

        oracle.executeMultiple(execs, address(multisig), sigs);

        assertEq(hub.balanceOf(hubTo, tokenId) - before_, amount * 3);
    }
}
