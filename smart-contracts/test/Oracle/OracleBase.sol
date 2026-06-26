// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../utils/BaseTest.sol";
import {Eip712} from "../utils/Eip712.sol";
import {RelayHub} from "../../contracts/RelayHub.sol";
import {RelayOracle} from "../../contracts/RelayOracle.sol";

/// @notice Shared deploy + per-describe setUp fixture for the Oracle tests.
abstract contract OracleBase is BaseTest {
    RelayHub internal hub;
    RelayOracle internal oracle;

    address internal admin;
    address internal oracleSigner;
    uint256 internal oracleSignerPk;

    bytes32 internal oracleDomain;

    // EIP-712 typehash matching contracts/RelayOracle.sol
    bytes32 internal constant EXECUTION_TYPEHASH =
        keccak256("Execution(bytes32 idempotencyKey,bytes[] actions)");

    function setUp() public virtual override {
        super.setUp();
        admin = owner;
        (oracleSigner, oracleSignerPk) = makeAddrAndKey("oracleSigner");

        hub = new RelayHub(admin);
        oracle = new RelayOracle(admin, address(hub));

        bytes32 operatorRole = hub.OPERATOR_ROLE();
        vm.prank(admin);
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

    function _burnAction(
        address hubFromAddress,
        uint256 hubTokenId,
        uint256 amount
    ) internal pure returns (bytes memory) {
        return
            abi.encode(
                uint8(RelayOracle.ActionType.BURN),
                hubFromAddress,
                hubTokenId,
                amount
            );
    }

    function _transferAction(
        address hubFromAddress,
        address hubToAddress,
        uint256 hubTokenId,
        uint256 amount
    ) internal pure returns (bytes memory) {
        return
            abi.encode(
                uint8(RelayOracle.ActionType.TRANSFER),
                hubFromAddress,
                hubToAddress,
                hubTokenId,
                amount
            );
    }

    function _signExecution(
        uint256 pk,
        bytes32 idempotencyKey,
        bytes[] memory actions
    ) internal view returns (bytes memory) {
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
        return Eip712.sign(pk, oracleDomain, structHash);
    }

    function _buildExecution(
        bytes32 idempotencyKey,
        bytes[] memory actions
    ) internal pure returns (RelayOracle.Execution memory) {
        return
            RelayOracle.Execution({
                idempotencyKey: idempotencyKey,
                actions: actions
            });
    }
}

/// @notice Variant of OracleBase that pre-grants ORACLE_ROLE to `oracleSigner`
/// so the execute / executeMultiple suites can exercise the signed-action path.
abstract contract OracleExecuteBase is OracleBase {
    function setUp() public virtual override {
        super.setUp();
        bytes32 oracleRole = oracle.ORACLE_ROLE();
        vm.prank(admin);
        oracle.grantRole(oracleRole, oracleSigner);
    }

    function _hubAddr(address a) internal pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encode("hub-addr", a)))));
    }

    function _hubTokenId(address currency) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode("hub-token", currency)));
    }
}
