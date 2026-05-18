// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {OracleExecuteBase} from "./OracleBase.sol";
import {RelayOracle} from "../../contracts/RelayOracle.sol";

/// @notice Port of test/Oracle/execute.ts.
contract OracleExecuteTest is OracleExecuteBase {
    function test_executesSingleMintAction() public {
        address currency = otherAccounts[2];
        address to = otherAccounts[3];
        uint256 amount = 1e18;

        uint256 tokenId = _hubTokenId(currency);
        address hubTo = _hubAddr(to);

        bytes[] memory actions = new bytes[](1);
        actions[0] = _mintAction(hubTo, tokenId, amount);
        bytes32 idempotencyKey = keccak256("mint-1");
        bytes memory sig = _signExecution(oracleSignerPk, idempotencyKey, actions);

        uint256 before_ = hub.balanceOf(hubTo, tokenId);

        vm.expectEmit(true, false, false, true, address(oracle));
        emit RelayOracle.Executed(idempotencyKey, actions);

        oracle.execute(_buildExecution(idempotencyKey, actions), oracleSigner, sig);

        assertEq(hub.balanceOf(hubTo, tokenId) - before_, amount);
        assertTrue(oracle.isExecuted(idempotencyKey));
    }

    function test_executesSingleBurnAction() public {
        address currency = otherAccounts[2];
        address from = otherAccounts[3];
        uint256 amount = 1e18;

        uint256 tokenId = _hubTokenId(currency);
        address hubFrom = _hubAddr(from);

        {
            bytes[] memory mintActions = new bytes[](1);
            mintActions[0] = _mintAction(hubFrom, tokenId, amount);
            bytes32 k = keccak256("mint-for-burn");
            bytes memory s = _signExecution(oracleSignerPk, k, mintActions);
            oracle.execute(_buildExecution(k, mintActions), oracleSigner, s);
        }

        uint256 before_ = hub.balanceOf(hubFrom, tokenId);

        bytes[] memory actions = new bytes[](1);
        actions[0] = _burnAction(hubFrom, tokenId, amount);
        bytes32 idempotencyKey = keccak256("burn-1");
        bytes memory sig = _signExecution(oracleSignerPk, idempotencyKey, actions);

        oracle.execute(_buildExecution(idempotencyKey, actions), oracleSigner, sig);

        assertEq(before_ - hub.balanceOf(hubFrom, tokenId), amount);
    }

    function test_executesSingleTransferAction() public {
        address currency = otherAccounts[2];
        address from = otherAccounts[3];
        address to = otherAccounts[4];
        uint256 amount = 1e18;

        uint256 tokenId = _hubTokenId(currency);
        address hubFrom = _hubAddr(from);
        address hubTo = _hubAddr(to);

        {
            bytes[] memory mintActions = new bytes[](1);
            mintActions[0] = _mintAction(hubFrom, tokenId, amount);
            bytes32 k = keccak256("mint-for-transfer");
            bytes memory s = _signExecution(oracleSignerPk, k, mintActions);
            oracle.execute(_buildExecution(k, mintActions), oracleSigner, s);
        }

        bytes[] memory actions = new bytes[](1);
        actions[0] = _transferAction(hubFrom, hubTo, tokenId, amount);
        bytes32 idempotencyKey = keccak256("transfer-1");
        bytes memory sig = _signExecution(oracleSignerPk, idempotencyKey, actions);

        oracle.execute(_buildExecution(idempotencyKey, actions), oracleSigner, sig);

        assertEq(hub.balanceOf(hubFrom, tokenId), 0);
        assertEq(hub.balanceOf(hubTo, tokenId), amount);
    }

    function test_executesMultipleActionsInOneExecution() public {
        address currency = otherAccounts[2];
        address to1 = otherAccounts[3];
        address to2 = otherAccounts[4];
        uint256 tokenId = _hubTokenId(currency);
        address hubTo1 = _hubAddr(to1);
        address hubTo2 = _hubAddr(to2);

        bytes[] memory actions = new bytes[](2);
        actions[0] = _mintAction(hubTo1, tokenId, 1e18);
        actions[1] = _mintAction(hubTo2, tokenId, 2e18);
        bytes32 idempotencyKey = keccak256("batch-1");
        bytes memory sig = _signExecution(oracleSignerPk, idempotencyKey, actions);

        oracle.execute(_buildExecution(idempotencyKey, actions), oracleSigner, sig);

        assertEq(hub.balanceOf(hubTo1, tokenId), 1e18);
        assertEq(hub.balanceOf(hubTo2, tokenId), 2e18);
    }

    function test_revertsAlreadyExecutedOnReplay() public {
        address currency = otherAccounts[2];
        address to = otherAccounts[3];
        uint256 tokenId = _hubTokenId(currency);
        address hubTo = _hubAddr(to);

        bytes[] memory actions = new bytes[](1);
        actions[0] = _mintAction(hubTo, tokenId, 1e18);
        bytes32 idempotencyKey = keccak256("replay");
        bytes memory sig = _signExecution(oracleSignerPk, idempotencyKey, actions);

        oracle.execute(_buildExecution(idempotencyKey, actions), oracleSigner, sig);

        vm.expectRevert(
            abi.encodeWithSelector(
                RelayOracle.AlreadyExecuted.selector,
                idempotencyKey
            )
        );
        oracle.execute(_buildExecution(idempotencyKey, actions), oracleSigner, sig);
    }

    function test_revertsUnauthorizedOracleWhenSignerLacksRole() public {
        (address rogue, uint256 roguePk) = makeAddrAndKey("rogue");

        bytes[] memory actions = new bytes[](1);
        actions[0] = _mintAction(
            _hubAddr(otherAccounts[3]),
            _hubTokenId(otherAccounts[2]),
            1e18
        );
        bytes32 idempotencyKey = keccak256("rogue");
        bytes memory sig = _signExecution(roguePk, idempotencyKey, actions);

        vm.expectRevert(
            abi.encodeWithSelector(
                RelayOracle.UnauthorizedOracle.selector,
                rogue
            )
        );
        oracle.execute(_buildExecution(idempotencyKey, actions), rogue, sig);
    }

    function test_revertsInvalidSignatureWhenSignerMismatch() public {
        (, uint256 otherPk) = makeAddrAndKey("other");

        bytes[] memory actions = new bytes[](1);
        actions[0] = _mintAction(
            _hubAddr(otherAccounts[3]),
            _hubTokenId(otherAccounts[2]),
            1e18
        );
        bytes32 idempotencyKey = keccak256("mismatch");
        bytes memory sigByOther = _signExecution(otherPk, idempotencyKey, actions);

        vm.expectRevert(
            abi.encodeWithSelector(
                RelayOracle.InvalidSignature.selector,
                oracleSigner
            )
        );
        oracle.execute(
            _buildExecution(idempotencyKey, actions),
            oracleSigner,
            sigByOther
        );
    }
}
