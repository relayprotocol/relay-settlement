// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {OracleExecuteBase} from "./OracleBase.sol";
import {RelayOracle} from "../../contracts/RelayOracle.sol";

/// @notice Port of test/Oracle/executeMultiple.ts.
contract OracleExecuteMultipleTest is OracleExecuteBase {
    function test_executesMultipleSuccessfulExecutions() public {
        uint256 tokenId = _hubTokenId(otherAccounts[2]);
        address hubTo1 = _hubAddr(otherAccounts[3]);
        address hubTo2 = _hubAddr(otherAccounts[4]);

        RelayOracle.Execution[] memory execs = new RelayOracle.Execution[](2);
        bytes[] memory sigs = new bytes[](2);

        bytes[] memory a0 = new bytes[](1);
        a0[0] = _mintAction(hubTo1, tokenId, 1e18);
        execs[0] = _buildExecution(keccak256("k0"), a0);
        sigs[0] = _signExecution(oracleSignerPk, execs[0].idempotencyKey, a0);

        bytes[] memory a1 = new bytes[](1);
        a1[0] = _mintAction(hubTo2, tokenId, 2e18);
        execs[1] = _buildExecution(keccak256("k1"), a1);
        sigs[1] = _signExecution(oracleSignerPk, execs[1].idempotencyKey, a1);

        oracle.executeMultiple(execs, oracleSigner, sigs);

        assertEq(hub.balanceOf(hubTo1, tokenId), 1e18);
        assertEq(hub.balanceOf(hubTo2, tokenId), 2e18);
        assertTrue(oracle.isExecuted(execs[0].idempotencyKey));
        assertTrue(oracle.isExecuted(execs[1].idempotencyKey));
    }

    function test_skipsAlreadyExecutedWithoutFailing() public {
        uint256 tokenId = _hubTokenId(otherAccounts[2]);
        address hubTo = _hubAddr(otherAccounts[3]);

        {
            bytes[] memory pre = new bytes[](1);
            pre[0] = _mintAction(hubTo, tokenId, 1e18);
            bytes32 k = keccak256("dup");
            bytes memory s = _signExecution(oracleSignerPk, k, pre);
            oracle.execute(_buildExecution(k, pre), oracleSigner, s);
        }

        RelayOracle.Execution[] memory execs = new RelayOracle.Execution[](2);
        bytes[] memory sigs = new bytes[](2);

        bytes[] memory dup = new bytes[](1);
        dup[0] = _mintAction(hubTo, tokenId, 1e18);
        execs[0] = _buildExecution(keccak256("dup"), dup);
        sigs[0] = _signExecution(oracleSignerPk, execs[0].idempotencyKey, dup);

        bytes[] memory fresh = new bytes[](1);
        fresh[0] = _mintAction(hubTo, tokenId, 3e18);
        execs[1] = _buildExecution(keccak256("fresh"), fresh);
        sigs[1] = _signExecution(oracleSignerPk, execs[1].idempotencyKey, fresh);

        oracle.executeMultiple(execs, oracleSigner, sigs);

        // 1e18 from the standalone execute + 3e18 from the second batch entry.
        assertEq(hub.balanceOf(hubTo, tokenId), 4e18);
    }

    function test_emitsExecutionFailedAndContinuesOnPartialFailure() public {
        uint256 tokenId = _hubTokenId(otherAccounts[2]);
        address hubTo = _hubAddr(otherAccounts[3]);

        RelayOracle.Execution[] memory execs = new RelayOracle.Execution[](2);
        bytes[] memory sigs = new bytes[](2);

        // Invalid action type (255) → _executeAction reverts.
        bytes[] memory bad = new bytes[](1);
        bad[0] = abi.encode(uint8(255), address(0), uint256(0), uint256(0));
        execs[0] = _buildExecution(keccak256("bad"), bad);
        sigs[0] = _signExecution(oracleSignerPk, execs[0].idempotencyKey, bad);

        bytes[] memory good = new bytes[](1);
        good[0] = _mintAction(hubTo, tokenId, 1e18);
        execs[1] = _buildExecution(keccak256("good"), good);
        sigs[1] = _signExecution(oracleSignerPk, execs[1].idempotencyKey, good);

        vm.expectEmit(true, false, false, true, address(oracle));
        emit RelayOracle.ExecutionFailed(execs[0].idempotencyKey, bad);

        oracle.executeMultiple(execs, oracleSigner, sigs);

        assertEq(hub.balanceOf(hubTo, tokenId), 1e18);
        assertFalse(oracle.isExecuted(execs[0].idempotencyKey));
        assertTrue(oracle.isExecuted(execs[1].idempotencyKey));
    }

    function test_handlesEmptyExecutionsArray() public {
        RelayOracle.Execution[] memory execs = new RelayOracle.Execution[](0);
        bytes[] memory sigs = new bytes[](0);
        oracle.executeMultiple(execs, oracleSigner, sigs);
    }
}
