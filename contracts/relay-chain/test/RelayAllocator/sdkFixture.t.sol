// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {WithdrawRequestAuthorization} from "../../contracts/RelayAllocator.sol";

import {Authorization} from "../../contracts/Authorization.sol";

import {RelayAllocatorBase} from "./RelayAllocator.t.sol";
import {Eip712} from "../utils/Eip712.sol";
import {Config} from "../../contracts/Config.sol";
import {EthereumVmPayloadBuilder} from "../../contracts/payload-builders/EthereumVmPayloadBuilder.sol";
import {
    RelayAllocator,
    WithdrawRequest
} from "../../contracts/RelayAllocator.sol";
import {Utils} from "../../contracts/Utils.sol";

/// @notice Pins the digest produced by the SDK v2.4 `getWithdrawRequestAuthorizationHash`
/// (packages/sdk/test/withdraw-request-authorization-v2.4.test.ts); drift means the SDK
/// and the contract disagree on what the spender signs.
contract RelayAllocatorSdkFixtureTest is RelayAllocatorBase {
    address internal constant FIXTURE_ALLOCATOR =
        0xa110ca70a110cA70a110CA70a110cA70a110cA70;
    uint256 internal constant FIXTURE_SPENDER_PK = 0xA11CE;
    address internal constant FIXTURE_SPENDER =
        0xe05fcC23807536bEe418f142D19fa0d21BB0cfF7;
    address internal constant FIXTURE_DEPOSITORY =
        0x2222222222222222222222222222222222222222;
    address internal constant FIXTURE_RECEIVER =
        0x3333333333333333333333333333333333333333;
    bytes32 internal constant FIXTURE_NONCE =
        0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd;
    uint256 internal constant FIXTURE_EXPIRATION = 1_900_000_000;

    bytes32 internal constant SDK_WITHDRAW_REQUEST_AUTHORIZATION_HASH =
        0x0528bdd3cecf713e0b53a65410a0385df137513506bc809a556a412c8b4bcdc8;

    address internal fixtureAlias;

    function setUp() public override {
        super.setUp();
        assertEq(block.chainid, 31337);
        assertEq(vm.addr(FIXTURE_SPENDER_PK), FIXTURE_SPENDER);

        // Same contract at the SDK fixture address
        deployCodeTo(
            "RelayAllocator.sol:RelayAllocator",
            abi.encode(allocatorOwner, address(hub), address(signatureOracle)),
            FIXTURE_ALLOCATOR
        );
        allocator = RelayAllocator(FIXTURE_ALLOCATOR);
        config = new Config(address(allocator));
        payloadBuilder = new EthereumVmPayloadBuilder(address(config));

        bytes32[] memory keys = new bytes32[](2);
        keys[0] = payloadBuilder.getExpirationKey();
        keys[1] = payloadBuilder.getEvmChainIdKey(CHAIN_ID);
        bytes32[] memory values = new bytes32[](2);
        values[0] = bytes32(EXPIRATION_DELAY_SECONDS);
        values[1] = bytes32(uint256(1));
        bytes32 operatorRole = hub.OPERATOR_ROLE();

        vm.startPrank(allocatorOwner);
        allocator.setPayloadBuilder(
            CHAIN_ID,
            abi.encodePacked(FIXTURE_DEPOSITORY),
            address(payloadBuilder)
        );
        config.setConfigValues(keys, values);
        hub.grantRole(operatorRole, address(allocator));
        vm.stopPrank();

        fixtureAlias = Utils.generateAddress(
            SPENDER_CHAIN_ID,
            abi.encodePacked(FIXTURE_SPENDER)
        );
        vm.prank(allocatorOwner);
        hub.mint(fixtureAlias, tokenId, 100);

        allocatorDomain = Eip712.domainSeparator(
            "RelayAllocator",
            "1",
            block.chainid,
            FIXTURE_ALLOCATOR
        );
    }

    function _fixtureRequest() internal pure returns (WithdrawRequest memory) {
        return
            WithdrawRequest({
                chainId: CHAIN_ID,
                depository: abi.encodePacked(FIXTURE_DEPOSITORY),
                currency: abi.encodePacked(address(0)),
                amount: 10,
                spenderChainId: SPENDER_CHAIN_ID,
                spender: abi.encodePacked(FIXTURE_SPENDER),
                receiver: abi.encodePacked(FIXTURE_RECEIVER),
                data: "",
                nonce: FIXTURE_NONCE
            });
    }

    function test_withdrawRequestAuthorizationHashMatchesSdkFixture() public {
        assertEq(
            allocator.WITHDRAW_REQUEST_AUTHORIZATION_TYPEHASH(),
            WITHDRAW_REQUEST_AUTHORIZATION_TYPEHASH
        );
        WithdrawRequest memory r = _fixtureRequest();
        assertEq(
            _requestDigest(r, FIXTURE_EXPIRATION),
            SDK_WITHDRAW_REQUEST_AUTHORIZATION_HASH
        );

        // The contract accepts a spender signature over the SDK digest
        (uint8 v, bytes32 sigR, bytes32 sigS) = vm.sign(
            FIXTURE_SPENDER_PK,
            SDK_WITHDRAW_REQUEST_AUTHORIZATION_HASH
        );
        vm.prank(relayer);
        allocator.submitWithdrawRequestWithSignature(
            WithdrawRequestAuthorization(
                r,
                Authorization(
                    FIXTURE_EXPIRATION,
                    abi.encodePacked(sigR, sigS, v)
                )
            )
        );

        assertEq(hub.balanceOf(fixtureAlias, tokenId), 90);
        assertTrue(
            allocator.usedNonces(
                keccak256(abi.encodePacked(FIXTURE_SPENDER)),
                FIXTURE_NONCE
            )
        );
    }

    function test_rejectsPreviousAuthorizationTypeName() public {
        WithdrawRequest memory request = _fixtureRequest();
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            FIXTURE_SPENDER_PK,
            0x7b166b2c5f5448e0116880e248566036eccc4a84d4681102fcc010afc4327867
        );
        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(
                RelayAllocator.CallerIsNotApproved.selector,
                relayer
            )
        );
        allocator.submitWithdrawRequestWithSignature(
            WithdrawRequestAuthorization(
                request,
                Authorization(FIXTURE_EXPIRATION, abi.encodePacked(r, s, v))
            )
        );
        assertEq(hub.balanceOf(fixtureAlias, tokenId), 100);
        assertFalse(
            allocator.usedNonces(keccak256(request.spender), request.nonce)
        );
    }

    function test_rejectsSdkDigestSignedByAnotherKey() public {
        WithdrawRequest memory r = _fixtureRequest();
        (uint8 v, bytes32 sigR, bytes32 sigS) = vm.sign(
            receiverPk,
            SDK_WITHDRAW_REQUEST_AUTHORIZATION_HASH
        );

        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(
                RelayAllocator.CallerIsNotApproved.selector,
                relayer
            )
        );
        allocator.submitWithdrawRequestWithSignature(
            WithdrawRequestAuthorization(
                r,
                Authorization(
                    FIXTURE_EXPIRATION,
                    abi.encodePacked(sigR, sigS, v)
                )
            )
        );

        assertEq(hub.balanceOf(fixtureAlias, tokenId), 100);
    }
}
