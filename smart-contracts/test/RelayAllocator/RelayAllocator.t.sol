// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../utils/BaseTest.sol";
import {Eip712} from "../utils/Eip712.sol";
import {RelayHub} from "../../contracts/RelayHub.sol";
import {RelayAllocator} from "../../contracts/RelayAllocator.sol";
import {Config} from "../../contracts/Config.sol";
import {EthereumVmPayloadBuilder} from "../../contracts/payload-builders/EthereumVmPayloadBuilder.sol";
import {EmptyPayloadBuilder} from "../../contracts/mocks/EmptyPayloadBuilder.sol";
import {Utils} from "../../contracts/Utils.sol";

contract MockSpenderSignatureOracle {
    bytes4 internal constant MAGIC_VALUE = 0x1626ba7e;

    bytes32 internal expectedDigest;
    bytes internal expectedSignature;
    bool internal expectedValid;
    bool internal shouldRevert;

    function setExpected(
        string memory,
        bytes memory,
        bytes32 digest,
        bytes memory signature,
        bool valid
    ) external {
        expectedDigest = digest;
        expectedSignature = signature;
        expectedValid = valid;
        shouldRevert = false;
    }

    function setShouldRevert(bool value) external {
        shouldRevert = value;
    }

    function isValidSignature(
        bytes32 digest,
        bytes calldata signature
    ) external view returns (bytes4) {
        if (shouldRevert) {
            revert("oracle reverted");
        }

        if (
            expectedValid &&
            digest == expectedDigest &&
            keccak256(signature) == keccak256(expectedSignature)
        ) {
            return MAGIC_VALUE;
        }

        return bytes4(0);
    }
}

/// @notice Port of test/RelayAllocator/RelayAllocator.ts.
contract RelayAllocatorBase is BaseTest {
    string internal constant CHAIN_ID = "ethereum-mainnet";
    string internal constant SPENDER_CHAIN_ID = "ethereum-mainnet";
    uint256 internal constant EXPIRATION_DELAY_SECONDS = 10 * 24 * 60 * 60;

    bytes32 internal constant WITHDRAW_REQUEST_TYPEHASH =
        keccak256(
            "WithdrawRequest(string chainId,bytes depository,bytes currency,uint256 amount,string spenderChainId,bytes spender,bytes receiver,bytes data,bytes32 nonce)"
        );

    address internal allocatorOwner;
    address internal relayer;
    address internal receiver;
    uint256 internal receiverPk;
    address internal depositoryAddr;

    RelayHub internal hub;
    RelayAllocator internal allocator;
    Config internal config;
    EthereumVmPayloadBuilder internal payloadBuilder;
    MockSpenderSignatureOracle internal signatureOracle;

    address internal spenderAlias;
    uint256 internal tokenId;
    bytes32 internal allocatorDomain;

    function setUp() public virtual override {
        super.setUp();
        allocatorOwner = owner;
        relayer = otherAccounts[0];
        (receiver, receiverPk) = makeAddrAndKey("receiver");
        depositoryAddr = otherAccounts[2];

        hub = new RelayHub(allocatorOwner);
        signatureOracle = new MockSpenderSignatureOracle();
        allocator = new RelayAllocator(
            allocatorOwner,
            address(hub),
            address(signatureOracle)
        );
        config = new Config(address(allocator));
        payloadBuilder = new EthereumVmPayloadBuilder(address(config));

        vm.prank(allocatorOwner);
        allocator.setPayloadBuilder(
            CHAIN_ID,
            abi.encodePacked(depositoryAddr),
            address(payloadBuilder)
        );

        bytes32[] memory keys = new bytes32[](2);
        keys[0] = payloadBuilder.getExpirationKey();
        keys[1] = payloadBuilder.getEvmChainIdKey(CHAIN_ID);
        bytes32[] memory values = new bytes32[](2);
        values[0] = bytes32(EXPIRATION_DELAY_SECONDS);
        values[1] = bytes32(uint256(1));

        vm.prank(allocatorOwner);
        config.setConfigValues(keys, values);

        bytes32 operatorRole = hub.OPERATOR_ROLE();
        vm.startPrank(allocatorOwner);
        hub.grantRole(operatorRole, allocatorOwner);
        hub.grantRole(operatorRole, address(allocator));
        vm.stopPrank();

        spenderAlias = Utils.generateAddress(
            SPENDER_CHAIN_ID,
            abi.encodePacked(receiver)
        );
        tokenId = Utils.generateTokenId(
            CHAIN_ID,
            abi.encodePacked(address(0))
        );
        vm.prank(allocatorOwner);
        hub.mint(spenderAlias, tokenId, 100);

        allocatorDomain = Eip712.domainSeparator(
            "RelayAllocator",
            "1",
            block.chainid,
            address(allocator)
        );
    }

    function _request(
        bytes32 nonce,
        uint256 amount
    ) internal view returns (RelayAllocator.WithdrawRequest memory) {
        return
            RelayAllocator.WithdrawRequest({
                chainId: CHAIN_ID,
                depository: abi.encodePacked(depositoryAddr),
                currency: abi.encodePacked(address(0)),
                amount: amount,
                spenderChainId: SPENDER_CHAIN_ID,
                spender: abi.encodePacked(receiver),
                receiver: abi.encodePacked(receiver),
                data: "",
                nonce: nonce
            });
    }

    function _requestDigest(
        RelayAllocator.WithdrawRequest memory r
    ) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                WITHDRAW_REQUEST_TYPEHASH,
                keccak256(bytes(r.chainId)),
                keccak256(r.depository),
                keccak256(r.currency),
                r.amount,
                keccak256(bytes(r.spenderChainId)),
                keccak256(r.spender),
                keccak256(r.receiver),
                keccak256(r.data),
                r.nonce
            )
        );
        return
            keccak256(
                abi.encodePacked("\x19\x01", allocatorDomain, structHash)
            );
    }

    function _signRequest(
        uint256 pk,
        RelayAllocator.WithdrawRequest memory r
    ) internal view returns (bytes memory) {
        bytes32 digest = _requestDigest(r);
        (uint8 v, bytes32 sigR, bytes32 sigS) = vm.sign(pk, digest);
        return abi.encodePacked(sigR, sigS, v);
    }

    function _spenderNonceKey(
        RelayAllocator.WithdrawRequest memory r
    ) internal pure returns (bytes32) {
        return keccak256(r.spender);
    }
}

contract RelayAllocatorSuspendUnsuspendTest is RelayAllocatorBase {
    function test_onlyAllowsOwnerToSuspendSpenderAlias() public {
        vm.prank(relayer);
        vm.expectRevert();
        allocator.suspend(spenderAlias);
    }

    function test_blocksWithdrawalsForSuspendedSpenderAlias() public {
        vm.prank(allocatorOwner);
        allocator.suspend(spenderAlias);

        vm.prank(receiver);
        vm.expectRevert(
            abi.encodeWithSelector(
                RelayAllocator.SpenderSuspended.selector,
                spenderAlias
            )
        );
        allocator.submitWithdrawRequest(_request(bytes32(uint256(1)), 10));
    }

    function test_allowsOwnerToUnsuspendSpenderAlias() public {
        vm.startPrank(allocatorOwner);
        allocator.suspend(spenderAlias);
        allocator.unsuspend(spenderAlias);
        vm.stopPrank();

        vm.prank(receiver);
        allocator.submitWithdrawRequest(_request(bytes32(uint256(1)), 10));
    }
}

contract RelayAllocatorSubmitWithdrawRequestTest is RelayAllocatorBase {
    function test_emitsOracleSetInConstructor() public {
        address newOracle = address(new MockSpenderSignatureOracle());

        vm.expectEmit(true, false, false, true);
        emit RelayAllocator.HubSet(address(hub));
        vm.expectEmit(true, false, false, true);
        emit RelayAllocator.OracleSet(newOracle);

        new RelayAllocator(allocatorOwner, address(hub), newOracle);
    }

    function test_revertsWhenPayloadBuilderReturnsEmptyPayload() public {
        EmptyPayloadBuilder emptyBuilder = new EmptyPayloadBuilder();

        vm.prank(allocatorOwner);
        allocator.setPayloadBuilder(
            CHAIN_ID,
            abi.encodePacked(depositoryAddr),
            address(emptyBuilder)
        );

        vm.prank(receiver);
        vm.expectRevert();
        allocator.submitWithdrawRequest(_request(bytes32(uint256(1)), 10));
    }

    function test_checksDuplicateRequestsBeforeBuildingReplacementPayload()
        public
    {
        RelayAllocator.WithdrawRequest memory r = _request(
            bytes32(uint256(1)),
            10
        );

        vm.prank(receiver);
        allocator.submitWithdrawRequest(r);

        EmptyPayloadBuilder emptyBuilder = new EmptyPayloadBuilder();
        vm.prank(allocatorOwner);
        allocator.setPayloadBuilder(
            CHAIN_ID,
            abi.encodePacked(depositoryAddr),
            address(emptyBuilder)
        );

        vm.prank(receiver);
        vm.expectRevert();
        allocator.submitWithdrawRequest(r);
    }

    function test_allowsDirectWithdrawalsFrom20ByteSpenderWithoutSignature()
        public
    {
        vm.prank(receiver);
        allocator.submitWithdrawRequest(_request(bytes32(uint256(1)), 10));

        assertEq(hub.balanceOf(spenderAlias, tokenId), 90);
    }
}

contract RelayAllocatorSubmitWithdrawRequestWithSignatureTest is
    RelayAllocatorBase
{
    function test_rejectsAliasBasedWithdrawalsWithoutReceiverSignature() public {
        vm.prank(relayer);
        vm.expectRevert();
        allocator.submitWithdrawRequest(_request(bytes32(uint256(1)), 10));
    }

    function test_allowsAliasBasedWithdrawalsWithValidReceiverSignature()
        public
    {
        RelayAllocator.WithdrawRequest memory r = _request(
            bytes32(uint256(1)),
            10
        );
        bytes memory sig = _signRequest(receiverPk, r);

        vm.prank(relayer);
        allocator.submitWithdrawRequestWithSignature(r, sig);

        assertEq(hub.balanceOf(spenderAlias, tokenId), 90);
        assertTrue(allocator.usedNonces(_spenderNonceKey(r), r.nonce));
    }

    function test_rejectsReplayingReceiverNonce() public {
        bytes32 nonce = bytes32(uint256(1));
        RelayAllocator.WithdrawRequest memory r = _request(nonce, 10);
        bytes memory sig = _signRequest(receiverPk, r);

        vm.prank(relayer);
        allocator.submitWithdrawRequestWithSignature(r, sig);

        RelayAllocator.WithdrawRequest memory r2 = _request(nonce, 11);

        vm.prank(relayer);
        vm.expectRevert();
        allocator.submitWithdrawRequestWithSignature(r2, sig);
    }

    function test_allowsSpenderSignatureVerifiedByOracle() public {
        bytes memory solanaSpender = bytes("solana-public-key");
        address solanaAlias = Utils.generateAddress(
            "solana-mainnet",
            solanaSpender
        );
        vm.prank(allocatorOwner);
        hub.mint(solanaAlias, tokenId, 100);

        RelayAllocator.WithdrawRequest memory r = _request(
            bytes32(uint256(2)),
            10
        );
        r.spenderChainId = "solana-mainnet";
        r.spender = solanaSpender;
        bytes memory sig = bytes("oracle-verified-signature");
        signatureOracle.setExpected(
            r.spenderChainId,
            r.spender,
            _requestDigest(r),
            sig,
            true
        );

        vm.prank(relayer);
        allocator.submitWithdrawRequestWithSignature(r, sig);

        assertEq(hub.balanceOf(solanaAlias, tokenId), 90);
        assertTrue(allocator.usedNonces(_spenderNonceKey(r), r.nonce));
    }

    function test_fallsBackToOracleWhenEvmRecoverFails() public {
        RelayAllocator.WithdrawRequest memory r = _request(
            bytes32(uint256(3)),
            10
        );
        bytes memory sig = bytes("oracle-signature");
        signatureOracle.setExpected(
            r.spenderChainId,
            r.spender,
            _requestDigest(r),
            sig,
            true
        );

        vm.prank(relayer);
        allocator.submitWithdrawRequestWithSignature(r, sig);

        assertEq(hub.balanceOf(spenderAlias, tokenId), 90);
        assertTrue(allocator.usedNonces(_spenderNonceKey(r), r.nonce));
    }

    function test_sharesNonceBetweenEcdsaAndOracleSignaturesForSpender()
        public
    {
        bytes32 nonce = bytes32(uint256(4));
        RelayAllocator.WithdrawRequest memory r = _request(nonce, 10);
        bytes memory sig = _signRequest(receiverPk, r);

        vm.prank(relayer);
        allocator.submitWithdrawRequestWithSignature(r, sig);

        RelayAllocator.WithdrawRequest memory r2 = _request(nonce, 11);
        bytes memory oracleSig = bytes("oracle-signature");
        signatureOracle.setExpected(
            r2.spenderChainId,
            r2.spender,
            _requestDigest(r2),
            oracleSig,
            true
        );

        vm.prank(relayer);
        vm.expectRevert();
        allocator.submitWithdrawRequestWithSignature(r2, oracleSig);
    }

    function test_sharesOracleNonceForSameSpenderAcrossSpenderChainIds()
        public
    {
        bytes32 nonce = bytes32(uint256(5));
        bytes memory sharedSpender = bytes("shared-spender");

        RelayAllocator.WithdrawRequest memory r = _request(nonce, 10);
        r.spenderChainId = "chain-a";
        r.spender = sharedSpender;

        address chainAAlias = Utils.generateAddress(
            r.spenderChainId,
            r.spender
        );
        vm.prank(allocatorOwner);
        hub.mint(chainAAlias, tokenId, 100);

        bytes memory sig = bytes("chain-a-oracle-signature");
        signatureOracle.setExpected(
            r.spenderChainId,
            r.spender,
            _requestDigest(r),
            sig,
            true
        );

        vm.prank(relayer);
        allocator.submitWithdrawRequestWithSignature(r, sig);

        RelayAllocator.WithdrawRequest memory r2 = _request(nonce, 11);
        r2.spenderChainId = "chain-b";
        r2.spender = sharedSpender;

        address chainBAlias = Utils.generateAddress(
            r2.spenderChainId,
            r2.spender
        );
        vm.prank(allocatorOwner);
        hub.mint(chainBAlias, tokenId, 100);

        bytes memory sig2 = bytes("chain-b-oracle-signature");
        signatureOracle.setExpected(
            r2.spenderChainId,
            r2.spender,
            _requestDigest(r2),
            sig2,
            true
        );

        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(
                RelayAllocator.CallerIsNotApproved.selector,
                relayer
            )
        );
        allocator.submitWithdrawRequestWithSignature(r2, sig2);
    }
}
