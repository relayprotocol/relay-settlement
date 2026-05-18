// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {HubBase} from "./HubBase.sol";
import {RelayHub} from "../../contracts/RelayHub.sol";
import {Eip712} from "../utils/Eip712.sol";
import {ERC20View} from "../../contracts/ERC20View.sol";

/// @notice Port of test/Hub/permit.ts (single-user happy-path + edge cases).
contract HubPermitBase is HubBase {
    bytes32 internal constant PERMIT_TYPEHASH =
        keccak256(
            "Permit(address owner,address spender,uint256 tokenId,uint256 value,uint256 nonce,uint256 deadline)"
        );

    address internal operatorUser;
    address internal spender;
    address internal ownerAddr;
    uint256 internal ownerPk;
    address internal wrongAddr;
    uint256 internal wrongPk;
    uint256 internal tokenId;
    bytes32 internal hubDomain;

    function setUp() public virtual override {
        super.setUp();
        operatorUser = otherAccounts[0];
        spender = otherAccounts[1];
        (ownerAddr, ownerPk) = makeAddrAndKey("permitOwner");
        (wrongAddr, wrongPk) = makeAddrAndKey("permitWrong");

        vm.prank(admin);
        hub.grantRole(OPERATOR_ROLE, operatorUser);

        tokenId = 1;
        vm.prank(operatorUser);
        hub.mint(ownerAddr, tokenId, 1000);

        hubDomain = Eip712.domainSeparator("RelayHub", "1", block.chainid, address(hub));
    }

    function _sign(
        uint256 pk,
        address signedOwner,
        address signedSpender,
        uint256 signedTokenId,
        uint256 value,
        uint256 nonce,
        uint256 deadline
    ) internal view returns (uint8 v, bytes32 r, bytes32 s) {
        bytes32 structHash = keccak256(
            abi.encode(
                PERMIT_TYPEHASH,
                signedOwner,
                signedSpender,
                signedTokenId,
                value,
                nonce,
                deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", hubDomain, structHash));
        (v, r, s) = vm.sign(pk, digest);
    }
}

contract HubPermitTest is HubPermitBase {
    function test_revertsWhenOwnerIsZeroAddress() public {
        uint256 value = 500;
        uint256 deadline = block.timestamp + 3600;
        uint256 nonce = hub.nonces(ownerAddr);

        (uint8 v, bytes32 r, bytes32 s) = _sign(
            ownerPk,
            address(0),
            spender,
            tokenId,
            value,
            nonce,
            deadline
        );

        vm.expectRevert(RelayHub.InvalidPermitOwner.selector);
        hub.permit(address(0), spender, tokenId, value, deadline, v, r, s);
    }

    function test_allowsSpenderApprovedViaValidPermitSignature() public {
        uint256 value = 500;
        uint256 deadline = block.timestamp + 3600;
        uint256 nonce = hub.nonces(ownerAddr);

        (uint8 v, bytes32 r, bytes32 s) = _sign(
            ownerPk,
            ownerAddr,
            spender,
            tokenId,
            value,
            nonce,
            deadline
        );

        hub.permit(ownerAddr, spender, tokenId, value, deadline, v, r, s);

        assertEq(hub.allowance(ownerAddr, spender, tokenId), value);
    }

    function test_incrementsNonceAfterSuccessfulPermit() public {
        uint256 value = 500;
        uint256 deadline = block.timestamp + 3600;
        uint256 nonceBefore = hub.nonces(ownerAddr);

        (uint8 v, bytes32 r, bytes32 s) = _sign(
            ownerPk,
            ownerAddr,
            spender,
            tokenId,
            value,
            nonceBefore,
            deadline
        );

        hub.permit(ownerAddr, spender, tokenId, value, deadline, v, r, s);

        assertEq(hub.nonces(ownerAddr), nonceBefore + 1);
    }

    function test_emitsApprovalEventOnSuccessfulPermit() public {
        uint256 value = 500;
        uint256 deadline = block.timestamp + 3600;
        uint256 nonce = hub.nonces(ownerAddr);

        (uint8 v, bytes32 r, bytes32 s) = _sign(
            ownerPk,
            ownerAddr,
            spender,
            tokenId,
            value,
            nonce,
            deadline
        );

        vm.recordLogs();
        hub.permit(ownerAddr, spender, tokenId, value, deadline, v, r, s);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bytes32 sig = keccak256("Approval(address,address,uint256,uint256)");
        bool found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(hub) && logs[i].topics[0] == sig) {
                address logOwner = address(uint160(uint256(logs[i].topics[1])));
                address logSpender = address(uint160(uint256(logs[i].topics[2])));
                uint256 id = uint256(logs[i].topics[3]);
                uint256 amt = abi.decode(logs[i].data, (uint256));
                if (logOwner == ownerAddr && logSpender == spender && id == tokenId) {
                    assertEq(amt, value);
                    found = true;
                }
            }
        }
        assertTrue(found);
    }

    function test_revertsWhenDeadlineHasExpired() public {
        vm.warp(10_000);
        uint256 value = 500;
        uint256 deadline = block.timestamp - 1;
        uint256 nonce = hub.nonces(ownerAddr);

        (uint8 v, bytes32 r, bytes32 s) = _sign(
            ownerPk,
            ownerAddr,
            spender,
            tokenId,
            value,
            nonce,
            deadline
        );

        vm.expectRevert(RelayHub.PermitDeadlineExpired.selector);
        hub.permit(ownerAddr, spender, tokenId, value, deadline, v, r, s);
    }

    function test_revertsWhenSignatureIsInvalidWrongSigner() public {
        uint256 value = 500;
        uint256 deadline = block.timestamp + 3600;
        uint256 nonce = hub.nonces(ownerAddr);

        (uint8 v, bytes32 r, bytes32 s) = _sign(
            wrongPk,
            ownerAddr,
            spender,
            tokenId,
            value,
            nonce,
            deadline
        );

        vm.expectRevert(RelayHub.InvalidPermitSignature.selector);
        hub.permit(ownerAddr, spender, tokenId, value, deadline, v, r, s);
    }

    function test_revertsWhenUsingAlreadyUsedNonce() public {
        uint256 value = 500;
        uint256 deadline = block.timestamp + 3600;
        uint256 nonce = hub.nonces(ownerAddr);

        (uint8 v, bytes32 r, bytes32 s) = _sign(
            ownerPk,
            ownerAddr,
            spender,
            tokenId,
            value,
            nonce,
            deadline
        );

        hub.permit(ownerAddr, spender, tokenId, value, deadline, v, r, s);

        vm.expectRevert(RelayHub.InvalidPermitSignature.selector);
        hub.permit(ownerAddr, spender, tokenId, value, deadline, v, r, s);
    }

    function test_allowsPermitForDifferentTokenIdsIndependently() public {
        uint256 tokenId2 = 2;
        vm.prank(operatorUser);
        hub.mint(ownerAddr, tokenId2, 1000);

        uint256 deadline = block.timestamp + 3600;
        _doPermit(tokenId, 300, deadline);
        _doPermit(tokenId2, 700, deadline);

        assertEq(hub.allowance(ownerAddr, spender, tokenId), 300);
        assertEq(hub.allowance(ownerAddr, spender, tokenId2), 700);
    }

    function _doPermit(uint256 forTokenId, uint256 value, uint256 deadline) private {
        uint256 nonce = hub.nonces(ownerAddr);
        (uint8 v, bytes32 r, bytes32 s) = _sign(
            ownerPk,
            ownerAddr,
            spender,
            forTokenId,
            value,
            nonce,
            deadline
        );
        hub.permit(ownerAddr, spender, forTokenId, value, deadline, v, r, s);
    }

    function test_allowsSpenderToTransferFromAfterSuccessfulPermit() public {
        uint256 value = 500;
        uint256 deadline = block.timestamp + 3600;
        uint256 nonce = hub.nonces(ownerAddr);

        (uint8 v, bytes32 r, bytes32 s) = _sign(
            ownerPk,
            ownerAddr,
            spender,
            tokenId,
            value,
            nonce,
            deadline
        );
        hub.permit(ownerAddr, spender, tokenId, value, deadline, v, r, s);

        uint256 transferAmount = 250;
        vm.prank(spender);
        hub.transferFrom(ownerAddr, operatorUser, tokenId, transferAmount);

        assertEq(hub.balanceOf(ownerAddr, tokenId), 1000 - transferAmount);
        assertEq(hub.balanceOf(operatorUser, tokenId), transferAmount);
        assertEq(hub.allowance(ownerAddr, spender, tokenId), value - transferAmount);
    }

    function test_exposesDomainSeparatorForExternalVerification() public view {
        bytes32 separator = hub.DOMAIN_SEPARATOR();
        assertTrue(separator != bytes32(0));
    }
}

contract HubPermitIntegrationTest is HubPermitBase {
    address internal spender1;
    address internal spender2;
    address internal recipient;
    address internal owner1Addr;
    uint256 internal owner1Pk;
    address internal owner2Addr;
    uint256 internal owner2Pk;
    bytes32 internal owner1Domain;

    function setUp() public virtual override {
        super.setUp();
        spender1 = otherAccounts[2];
        spender2 = otherAccounts[3];
        recipient = otherAccounts[4];
        (owner1Addr, owner1Pk) = makeAddrAndKey("permitOwner1");
        (owner2Addr, owner2Pk) = makeAddrAndKey("permitOwner2");

        owner1Domain = hubDomain;

        vm.startPrank(operatorUser);
        hub.mint(owner1Addr, tokenId, 10000);
        hub.mint(owner2Addr, tokenId, 10000);
        vm.stopPrank();
    }

    function _signFor(
        uint256 pk,
        address signedOwner,
        address signedSpender,
        uint256 signedTokenId,
        uint256 value,
        uint256 nonce,
        uint256 deadline
    ) internal view returns (uint8 v, bytes32 r, bytes32 s) {
        return _sign(pk, signedOwner, signedSpender, signedTokenId, value, nonce, deadline);
    }

    function test_handlesMultiplePermitsFromSameOwnerToDifferentSpenders() public {
        uint256 value1 = 1000;
        uint256 value2 = 2000;
        uint256 deadline = block.timestamp + 3600;

        uint256 nonce1 = hub.nonces(owner1Addr);
        (uint8 v1, bytes32 r1, bytes32 s1) = _signFor(
            owner1Pk,
            owner1Addr,
            spender1,
            tokenId,
            value1,
            nonce1,
            deadline
        );
        hub.permit(owner1Addr, spender1, tokenId, value1, deadline, v1, r1, s1);

        uint256 nonce2 = hub.nonces(owner1Addr);
        (uint8 v2, bytes32 r2, bytes32 s2) = _signFor(
            owner1Pk,
            owner1Addr,
            spender2,
            tokenId,
            value2,
            nonce2,
            deadline
        );
        hub.permit(owner1Addr, spender2, tokenId, value2, deadline, v2, r2, s2);

        vm.prank(spender1);
        hub.transferFrom(owner1Addr, recipient, tokenId, 500);

        vm.prank(spender2);
        hub.transferFrom(owner1Addr, recipient, tokenId, 1500);

        assertEq(hub.balanceOf(owner1Addr, tokenId), 10000 - 500 - 1500);
        assertEq(hub.balanceOf(recipient, tokenId), 2000);
    }

    function test_handlesPermitOverwritingPreviousAllowance() public {
        uint256 value1 = 1000;
        uint256 value2 = 5000;
        uint256 deadline = block.timestamp + 3600;

        uint256 nonce1 = hub.nonces(owner1Addr);
        (uint8 v1, bytes32 r1, bytes32 s1) = _signFor(
            owner1Pk,
            owner1Addr,
            spender1,
            tokenId,
            value1,
            nonce1,
            deadline
        );
        hub.permit(owner1Addr, spender1, tokenId, value1, deadline, v1, r1, s1);
        assertEq(hub.allowance(owner1Addr, spender1, tokenId), value1);

        uint256 nonce2 = hub.nonces(owner1Addr);
        (uint8 v2, bytes32 r2, bytes32 s2) = _signFor(
            owner1Pk,
            owner1Addr,
            spender1,
            tokenId,
            value2,
            nonce2,
            deadline
        );
        hub.permit(owner1Addr, spender1, tokenId, value2, deadline, v2, r2, s2);
        assertEq(hub.allowance(owner1Addr, spender1, tokenId), value2);
    }

    function test_handlesPermitWithZeroValueToRevokeAllowance() public {
        uint256 value = 1000;
        uint256 deadline = block.timestamp + 3600;

        uint256 nonce1 = hub.nonces(owner1Addr);
        (uint8 v1, bytes32 r1, bytes32 s1) = _signFor(
            owner1Pk,
            owner1Addr,
            spender1,
            tokenId,
            value,
            nonce1,
            deadline
        );
        hub.permit(owner1Addr, spender1, tokenId, value, deadline, v1, r1, s1);

        uint256 nonce2 = hub.nonces(owner1Addr);
        (uint8 v2, bytes32 r2, bytes32 s2) = _signFor(
            owner1Pk,
            owner1Addr,
            spender1,
            tokenId,
            0,
            nonce2,
            deadline
        );
        hub.permit(owner1Addr, spender1, tokenId, 0, deadline, v2, r2, s2);

        assertEq(hub.allowance(owner1Addr, spender1, tokenId), 0);

        vm.prank(spender1);
        vm.expectRevert();
        hub.transferFrom(owner1Addr, recipient, tokenId, 100);
    }

    function test_handlesPermitWithMaxUint256ValueForUnlimitedAllowance() public {
        uint256 maxValue = type(uint256).max;
        uint256 deadline = block.timestamp + 3600;
        uint256 nonce = hub.nonces(owner1Addr);

        (uint8 v, bytes32 r, bytes32 s) = _signFor(
            owner1Pk,
            owner1Addr,
            spender1,
            tokenId,
            maxValue,
            nonce,
            deadline
        );
        hub.permit(owner1Addr, spender1, tokenId, maxValue, deadline, v, r, s);

        assertEq(hub.allowance(owner1Addr, spender1, tokenId), maxValue);

        vm.prank(spender1);
        hub.transferFrom(owner1Addr, recipient, tokenId, 1000);
        assertEq(hub.allowance(owner1Addr, spender1, tokenId), maxValue);
    }

    function test_keepsSeparateNoncesForDifferentOwners() public {
        uint256 value = 1000;
        uint256 deadline = block.timestamp + 3600;

        assertEq(hub.nonces(owner1Addr), 0);
        assertEq(hub.nonces(owner2Addr), 0);

        (uint8 v1, bytes32 r1, bytes32 s1) = _signFor(
            owner1Pk,
            owner1Addr,
            spender1,
            tokenId,
            value,
            0,
            deadline
        );
        hub.permit(owner1Addr, spender1, tokenId, value, deadline, v1, r1, s1);

        (uint8 v2, bytes32 r2, bytes32 s2) = _signFor(
            owner2Pk,
            owner2Addr,
            spender1,
            tokenId,
            value,
            0,
            deadline
        );
        hub.permit(owner2Addr, spender1, tokenId, value, deadline, v2, r2, s2);

        assertEq(hub.nonces(owner1Addr), 1);
        assertEq(hub.nonces(owner2Addr), 1);
    }

    function test_integratesPermitWithErc20ViewApprovalEvents() public {
        uint256 value = 1000;
        uint256 deadline = block.timestamp + 3600;
        uint256 nonce = hub.nonces(owner1Addr);

        (uint8 v, bytes32 r, bytes32 s) = _signFor(
            owner1Pk,
            owner1Addr,
            spender1,
            tokenId,
            value,
            nonce,
            deadline
        );

        address erc20ViewAddress = hub.erc20Views(tokenId);
        assertTrue(erc20ViewAddress != address(0));

        vm.recordLogs();
        hub.permit(owner1Addr, spender1, tokenId, value, deadline, v, r, s);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bytes32 hubApprovalSig = keccak256("Approval(address,address,uint256,uint256)");
        bytes32 erc20ApprovalSig = keccak256("Approval(address,address,uint256)");
        bool foundHubApproval;
        bool foundErc20Approval;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(hub) && logs[i].topics[0] == hubApprovalSig) {
                address logOwner = address(uint160(uint256(logs[i].topics[1])));
                address logSpender = address(uint160(uint256(logs[i].topics[2])));
                if (logOwner == owner1Addr && logSpender == spender1) {
                    foundHubApproval = true;
                }
            }
            if (logs[i].emitter == erc20ViewAddress && logs[i].topics[0] == erc20ApprovalSig) {
                address logOwner = address(uint160(uint256(logs[i].topics[1])));
                address logSpender = address(uint160(uint256(logs[i].topics[2])));
                if (logOwner == owner1Addr && logSpender == spender1) {
                    foundErc20Approval = true;
                }
            }
        }
        assertTrue(foundHubApproval);
        assertTrue(foundErc20Approval);
    }

    function test_allowsCombiningPermitAndRegularApprove() public {
        uint256 permitValue = 1000;
        uint256 approveValue = 500;
        uint256 deadline = block.timestamp + 3600;
        uint256 nonce = hub.nonces(owner1Addr);

        (uint8 v, bytes32 r, bytes32 s) = _signFor(
            owner1Pk,
            owner1Addr,
            spender1,
            tokenId,
            permitValue,
            nonce,
            deadline
        );
        hub.permit(owner1Addr, spender1, tokenId, permitValue, deadline, v, r, s);

        vm.prank(owner1Addr);
        hub.approve(spender2, tokenId, approveValue);

        assertEq(hub.allowance(owner1Addr, spender1, tokenId), permitValue);
        assertEq(hub.allowance(owner1Addr, spender2, tokenId), approveValue);

        vm.prank(spender1);
        hub.transferFrom(owner1Addr, recipient, tokenId, 100);
        vm.prank(spender2);
        hub.transferFrom(owner1Addr, recipient, tokenId, 100);

        assertEq(hub.balanceOf(recipient, tokenId), 200);
    }
}
