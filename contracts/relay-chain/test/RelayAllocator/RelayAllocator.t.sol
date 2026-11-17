// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {WithdrawRequestAuthorization} from "../../contracts/RelayAllocator.sol";

import {Authorization} from "../../contracts/Authorization.sol";

import {WithdrawFee, WithdrawFeePaymentAuthorization} from "../../contracts/RelayAllocator.sol";

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {BaseTest} from "../utils/BaseTest.sol";
import {Eip712} from "../utils/Eip712.sol";
import {RelayHub} from "../../contracts/RelayHub.sol";
import {
    WithdrawRequest,
    IPayloadBuilder,
    RelayAllocator
} from "../../contracts/RelayAllocator.sol";
import {Config} from "../../contracts/Config.sol";
import {
    Call,
    CallRequest,
    EthereumVmPayloadBuilder
} from "../../contracts/payload-builders/EthereumVmPayloadBuilder.sol";
import {HyperliquidVmPayloadBuilder} from "../../contracts/payload-builders/HyperliquidVmPayloadBuilder.sol";
import {
    AtlasPayloadHeader,
    AtlasTransfer,
    AtlasVmPayloadBuilder
} from "../../contracts/payload-builders/AtlasVmPayloadBuilder.sol";
import {EmptyPayloadBuilder} from "../../contracts/mocks/EmptyPayloadBuilder.sol";
import {NoHashesPayloadBuilder} from "../../contracts/mocks/NoHashesPayloadBuilder.sol";
import {Utils} from "../../contracts/Utils.sol";
import {RelayDepository} from "../../contracts/depository/RelayDepository.sol";
import {
    Call as DepositoryCall,
    CallRequest as DepositoryCallRequest
} from "../../contracts/depository/utils/RelayDepositoryStructs.sol";

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
    string internal constant SPENDER_CHAIN_ID = "relay";
    string internal constant REMOTE_SPENDER_CHAIN_ID = "ethereum-mainnet";
    uint256 internal constant EXPIRATION_DELAY_SECONDS = 10 * 24 * 60 * 60;

    bytes32 internal constant WITHDRAW_REQUEST_TYPEHASH =
        keccak256(
            "WithdrawRequest(string chainId,bytes depository,bytes currency,uint256 amount,string spenderChainId,bytes spender,bytes receiver,bytes data,bytes32 nonce)"
        );

    bytes32 internal constant WITHDRAW_REQUEST_AUTHORIZATION_TYPEHASH =
        keccak256(
            "WithdrawRequestAuthorization(WithdrawRequest request,uint256 expiration)WithdrawRequest(string chainId,bytes depository,bytes currency,uint256 amount,string spenderChainId,bytes spender,bytes receiver,bytes data,bytes32 nonce)"
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
    address internal remoteAlias;
    uint256 internal tokenId;
    bytes32 internal allocatorDomain;
    uint256 internal expiration;

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

        remoteAlias = Utils.generateAddress(
            REMOTE_SPENDER_CHAIN_ID,
            abi.encodePacked(receiver)
        );
        vm.prank(allocatorOwner);
        hub.mint(remoteAlias, tokenId, 100);

        allocatorDomain = Eip712.domainSeparator(
            "RelayAllocator",
            "1",
            block.chainid,
            address(allocator)
        );
        expiration = block.timestamp + 1 hours;
    }

    function _request(
        bytes32 nonce,
        uint256 amount
    ) internal view returns (WithdrawRequest memory) {
        return
            WithdrawRequest({
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

    function _remoteRequest(
        bytes32 nonce,
        uint256 amount
    ) internal view returns (WithdrawRequest memory r) {
        r = _request(nonce, amount);
        r.spenderChainId = REMOTE_SPENDER_CHAIN_ID;
    }

    function _requestDigest(
        WithdrawRequest memory r
    ) internal view returns (bytes32) {
        return _requestDigest(r, expiration);
    }

    function _requestDigest(
        WithdrawRequest memory r,
        uint256 exp
    ) internal view returns (bytes32) {
        bytes32 requestHash = keccak256(
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
        bytes32 structHash = keccak256(
            abi.encode(WITHDRAW_REQUEST_AUTHORIZATION_TYPEHASH, requestHash, exp)
        );
        return
            keccak256(
                abi.encodePacked("\x19\x01", allocatorDomain, structHash)
            );
    }

    function _signRequest(
        uint256 pk,
        WithdrawRequest memory r
    ) internal view returns (bytes memory) {
        bytes32 digest = _requestDigest(r);
        (uint8 v, bytes32 sigR, bytes32 sigS) = vm.sign(pk, digest);
        return abi.encodePacked(sigR, sigS, v);
    }

    function _spenderNonceKey(
        WithdrawRequest memory r
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

contract RelayAllocatorPauseUnpauseTest is RelayAllocatorBase {
    function test_isNotPausedByDefault() public view {
        assertFalse(allocator.paused());
    }

    function test_onlyAllowsOwnerToPause() public {
        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(
                Ownable.OwnableUnauthorizedAccount.selector,
                relayer
            )
        );
        allocator.pause();

        assertFalse(allocator.paused());
    }

    function test_onlyAllowsOwnerToUnpause() public {
        vm.prank(allocatorOwner);
        allocator.pause();

        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(
                Ownable.OwnableUnauthorizedAccount.selector,
                relayer
            )
        );
        allocator.unpause();

        assertTrue(allocator.paused());
    }

    function test_emitsPausedAndUnpausedWithTheCaller() public {
        vm.expectEmit(false, false, false, true);
        emit Pausable.Paused(allocatorOwner);
        vm.prank(allocatorOwner);
        allocator.pause();
        assertTrue(allocator.paused());

        vm.expectEmit(false, false, false, true);
        emit Pausable.Unpaused(allocatorOwner);
        vm.prank(allocatorOwner);
        allocator.unpause();
        assertFalse(allocator.paused());
    }

    function test_blocksDirectWithdrawalsWhilePaused() public {
        vm.prank(allocatorOwner);
        allocator.pause();

        WithdrawRequest memory r = _request(bytes32(uint256(1)), 10);

        vm.prank(receiver);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        allocator.submitWithdrawRequest(r);

        assertEq(hub.balanceOf(spenderAlias, tokenId), 100);
        assertEq(allocator.payloads(keccak256(abi.encode(r))).length, 0);
    }

    function test_blocksSignedWithdrawalsWhilePaused() public {
        vm.prank(allocatorOwner);
        allocator.pause();

        WithdrawRequest memory r = _request(bytes32(uint256(1)), 10);
        bytes memory sig = _signRequest(receiverPk, r);

        vm.prank(relayer);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        allocator.submitWithdrawRequestWithSignature(
            WithdrawRequestAuthorization(r, Authorization(expiration, sig))
        );

        assertEq(hub.balanceOf(spenderAlias, tokenId), 100);
        assertFalse(allocator.usedNonces(_spenderNonceKey(r), r.nonce));
    }

    function test_blocksOperatorWithdrawalsWhilePaused() public {
        vm.startPrank(allocatorOwner);
        hub.setOperatorFor(remoteAlias, relayer, true);
        allocator.pause();
        vm.stopPrank();

        vm.prank(relayer);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        allocator.submitWithdrawRequest(
            _remoteRequest(bytes32(uint256(1)), 10)
        );

        assertEq(hub.balanceOf(remoteAlias, tokenId), 100);
    }

    function test_checksPauseBeforeAnyOtherSubmissionCheck() public {
        vm.prank(allocatorOwner);
        allocator.pause();

        // An unknown destination and an unauthorized caller each revert on their
        // own; the pause must be reported first so callers always learn about it
        WithdrawRequest memory r = _request(bytes32(uint256(1)), 10);
        r.chainId = "unknown-chain";

        vm.prank(relayer);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        allocator.submitWithdrawRequest(r);
    }

    function test_resumesWithdrawalsAfterUnpause() public {
        vm.startPrank(allocatorOwner);
        allocator.pause();
        allocator.unpause();
        vm.stopPrank();

        vm.prank(receiver);
        allocator.submitWithdrawRequest(_request(bytes32(uint256(1)), 10));

        assertEq(hub.balanceOf(spenderAlias, tokenId), 90);
    }

    function test_revertsWhenPausingAnAlreadyPausedAllocator() public {
        vm.startPrank(allocatorOwner);
        allocator.pause();

        vm.expectRevert(Pausable.EnforcedPause.selector);
        allocator.pause();
        vm.stopPrank();

        assertTrue(allocator.paused());
    }

    function test_revertsWhenUnpausingAnUnpausedAllocator() public {
        vm.prank(allocatorOwner);
        vm.expectRevert(Pausable.ExpectedPause.selector);
        allocator.unpause();
    }

    function test_allowsSuspendingAliasesWhilePaused() public {
        vm.startPrank(allocatorOwner);
        allocator.pause();
        allocator.suspend(spenderAlias);
        allocator.unpause();
        vm.stopPrank();

        vm.prank(receiver);
        vm.expectRevert(
            abi.encodeWithSelector(
                RelayAllocator.SpenderSuspended.selector,
                spenderAlias
            )
        );
        allocator.submitWithdrawRequest(_request(bytes32(uint256(1)), 10));
    }

    function test_allowsPayloadBuilderChangesWhilePaused() public {
        EmptyPayloadBuilder emptyBuilder = new EmptyPayloadBuilder();

        vm.startPrank(allocatorOwner);
        allocator.pause();
        allocator.setPayloadBuilder(
            CHAIN_ID,
            abi.encodePacked(depositoryAddr),
            address(emptyBuilder)
        );
        vm.stopPrank();

        assertEq(
            allocator.payloadBuilders(
                CHAIN_ID,
                abi.encodePacked(depositoryAddr)
            ),
            address(emptyBuilder)
        );
    }
}

contract RelayAllocatorChainPauseTest is RelayAllocatorBase {
    string internal constant OTHER_CHAIN_ID = "ethereum-sepolia";

    uint256 internal otherTokenId;

    function setUp() public override {
        super.setUp();

        // Register a second destination chain on the same builder so tests can
        // show that pausing one chain leaves the other open
        otherTokenId = Utils.generateTokenId(
            OTHER_CHAIN_ID,
            abi.encodePacked(address(0))
        );
        vm.startPrank(allocatorOwner);
        allocator.setPayloadBuilder(
            OTHER_CHAIN_ID,
            abi.encodePacked(depositoryAddr),
            address(payloadBuilder)
        );
        config.setConfigValue(
            payloadBuilder.getEvmChainIdKey(OTHER_CHAIN_ID),
            bytes32(uint256(2))
        );
        hub.mint(spenderAlias, otherTokenId, 100);
        vm.stopPrank();
    }

    function _chains(
        string memory chainId
    ) internal pure returns (string[] memory chainIds) {
        chainIds = new string[](1);
        chainIds[0] = chainId;
    }

    function _otherChainRequest(
        bytes32 nonce,
        uint256 amount
    ) internal view returns (WithdrawRequest memory r) {
        r = _request(nonce, amount);
        r.chainId = OTHER_CHAIN_ID;
    }

    function test_noChainIsPausedByDefault() public view {
        assertFalse(allocator.pausedChains(CHAIN_ID));
        assertFalse(allocator.pausedChains(OTHER_CHAIN_ID));
    }

    function test_onlyAllowsOwnerToPauseChains() public {
        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(
                Ownable.OwnableUnauthorizedAccount.selector,
                relayer
            )
        );
        allocator.pauseChains(_chains(CHAIN_ID));

        assertFalse(allocator.pausedChains(CHAIN_ID));
    }

    function test_onlyAllowsOwnerToUnpauseChains() public {
        vm.prank(allocatorOwner);
        allocator.pauseChains(_chains(CHAIN_ID));

        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(
                Ownable.OwnableUnauthorizedAccount.selector,
                relayer
            )
        );
        allocator.unpauseChains(_chains(CHAIN_ID));

        assertTrue(allocator.pausedChains(CHAIN_ID));
    }

    function test_pausesSeveralChainsInOneCallAndEmitsPerChain() public {
        string[] memory chainIds = new string[](2);
        chainIds[0] = CHAIN_ID;
        chainIds[1] = OTHER_CHAIN_ID;

        vm.expectEmit(false, false, false, true);
        emit RelayAllocator.ChainPaused(CHAIN_ID, true);
        vm.expectEmit(false, false, false, true);
        emit RelayAllocator.ChainPaused(OTHER_CHAIN_ID, true);
        vm.prank(allocatorOwner);
        allocator.pauseChains(chainIds);

        assertTrue(allocator.pausedChains(CHAIN_ID));
        assertTrue(allocator.pausedChains(OTHER_CHAIN_ID));

        vm.expectEmit(false, false, false, true);
        emit RelayAllocator.ChainUnpaused(CHAIN_ID);
        vm.expectEmit(false, false, false, true);
        emit RelayAllocator.ChainUnpaused(OTHER_CHAIN_ID);
        vm.prank(allocatorOwner);
        allocator.unpauseChains(chainIds);

        assertFalse(allocator.pausedChains(CHAIN_ID));
        assertFalse(allocator.pausedChains(OTHER_CHAIN_ID));
    }

    function test_pausingAChainTwiceIsIdempotent() public {
        vm.startPrank(allocatorOwner);
        allocator.pauseChains(_chains(CHAIN_ID));
        allocator.pauseChains(_chains(CHAIN_ID));
        allocator.pauseChains(new string[](0));
        vm.stopPrank();

        assertTrue(allocator.pausedChains(CHAIN_ID));
    }

    function test_blocksDirectWithdrawalsToPausedChain() public {
        vm.prank(allocatorOwner);
        allocator.pauseChains(_chains(CHAIN_ID));

        WithdrawRequest memory r = _request(bytes32(uint256(1)), 10);

        vm.prank(receiver);
        vm.expectRevert(
            abi.encodeWithSelector(
                RelayAllocator.DestinationChainPaused.selector,
                CHAIN_ID
            )
        );
        allocator.submitWithdrawRequest(r);

        assertEq(hub.balanceOf(spenderAlias, tokenId), 100);
        assertEq(allocator.payloads(keccak256(abi.encode(r))).length, 0);
    }

    function test_blocksSignedWithdrawalsToPausedChain() public {
        vm.prank(allocatorOwner);
        allocator.pauseChains(_chains(CHAIN_ID));

        WithdrawRequest memory r = _request(bytes32(uint256(1)), 10);
        bytes memory sig = _signRequest(receiverPk, r);

        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(
                RelayAllocator.DestinationChainPaused.selector,
                CHAIN_ID
            )
        );
        allocator.submitWithdrawRequestWithSignature(
            WithdrawRequestAuthorization(r, Authorization(expiration, sig))
        );

        assertEq(hub.balanceOf(spenderAlias, tokenId), 100);
        assertFalse(allocator.usedNonces(_spenderNonceKey(r), r.nonce));
    }

    function test_leavesOtherChainsOpenWhileOneIsPaused() public {
        vm.prank(allocatorOwner);
        allocator.pauseChains(_chains(CHAIN_ID));

        vm.prank(receiver);
        allocator.submitWithdrawRequest(
            _otherChainRequest(bytes32(uint256(1)), 10)
        );

        assertEq(hub.balanceOf(spenderAlias, otherTokenId), 90);
        assertEq(hub.balanceOf(spenderAlias, tokenId), 100);
    }

    function test_checksChainPauseBeforePayloadBuilderLookup() public {
        // A chain can be paused before it has a builder; the pause is what
        // callers learn about, not the missing builder
        string memory unknownChain = "unknown-chain";
        vm.prank(allocatorOwner);
        allocator.pauseChains(_chains(unknownChain));

        WithdrawRequest memory r = _request(bytes32(uint256(1)), 10);
        r.chainId = unknownChain;

        vm.prank(receiver);
        vm.expectRevert(
            abi.encodeWithSelector(
                RelayAllocator.DestinationChainPaused.selector,
                unknownChain
            )
        );
        allocator.submitWithdrawRequest(r);
    }

    function test_reportsWhetherAPausedChainHasAPayloadBuilder() public {
        vm.expectEmit(false, false, false, true);
        emit RelayAllocator.ChainPaused("ethereum", false);
        vm.prank(allocatorOwner);
        allocator.pauseChains(_chains("ethereum"));

        // A pause under a mistyped id leaves the registered chain open
        vm.prank(receiver);
        allocator.submitWithdrawRequest(_request(bytes32(uint256(1)), 10));
        assertEq(hub.balanceOf(spenderAlias, tokenId), 90);
    }

    function test_countsPayloadBuildersPerChain() public {
        bytes memory otherDepository = abi.encodePacked(address(0xd0));
        assertEq(allocator.payloadBuilderCounts(CHAIN_ID), 1);

        vm.startPrank(allocatorOwner);
        // Replacing a builder does not change the count
        allocator.setPayloadBuilder(
            CHAIN_ID,
            abi.encodePacked(depositoryAddr),
            address(payloadBuilder)
        );
        assertEq(allocator.payloadBuilderCounts(CHAIN_ID), 1);

        allocator.setPayloadBuilder(
            CHAIN_ID,
            otherDepository,
            address(payloadBuilder)
        );
        assertEq(allocator.payloadBuilderCounts(CHAIN_ID), 2);

        allocator.setPayloadBuilder(
            CHAIN_ID,
            abi.encodePacked(depositoryAddr),
            address(0)
        );
        allocator.setPayloadBuilder(CHAIN_ID, otherDepository, address(0));
        // Removing an unset builder does not underflow
        allocator.setPayloadBuilder(CHAIN_ID, otherDepository, address(0));
        assertEq(allocator.payloadBuilderCounts(CHAIN_ID), 0);

        vm.expectEmit(false, false, false, true);
        emit RelayAllocator.ChainPaused(CHAIN_ID, false);
        allocator.pauseChains(_chains(CHAIN_ID));
        vm.stopPrank();
    }

    function test_globalPauseIsReportedBeforeChainPause() public {
        vm.startPrank(allocatorOwner);
        allocator.pauseChains(_chains(CHAIN_ID));
        allocator.pause();
        vm.stopPrank();

        vm.prank(receiver);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        allocator.submitWithdrawRequest(_request(bytes32(uint256(1)), 10));
    }

    function test_chainPauseSurvivesGlobalUnpause() public {
        vm.startPrank(allocatorOwner);
        allocator.pause();
        allocator.pauseChains(_chains(CHAIN_ID));
        allocator.unpause();
        vm.stopPrank();

        vm.prank(receiver);
        vm.expectRevert(
            abi.encodeWithSelector(
                RelayAllocator.DestinationChainPaused.selector,
                CHAIN_ID
            )
        );
        allocator.submitWithdrawRequest(_request(bytes32(uint256(1)), 10));
    }

    function test_resumesWithdrawalsAfterUnpauseChains() public {
        vm.startPrank(allocatorOwner);
        allocator.pauseChains(_chains(CHAIN_ID));
        allocator.unpauseChains(_chains(CHAIN_ID));
        vm.stopPrank();

        vm.prank(receiver);
        allocator.submitWithdrawRequest(_request(bytes32(uint256(1)), 10));

        assertEq(hub.balanceOf(spenderAlias, tokenId), 90);
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

    function test_revertsWhenHubIsZero() public {
        vm.expectRevert(RelayAllocator.ZeroAddress.selector);
        new RelayAllocator(allocatorOwner, address(0), address(signatureOracle));
    }

    function test_revertsWhenOracleMultisigIsZero() public {
        vm.expectRevert(RelayAllocator.ZeroAddress.selector);
        new RelayAllocator(allocatorOwner, address(hub), address(0));
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

    function test_revertsWhenPayloadBuilderReturnsNoHashes() public {
        NoHashesPayloadBuilder noHashesBuilder = new NoHashesPayloadBuilder();

        vm.prank(allocatorOwner);
        allocator.setPayloadBuilder(
            CHAIN_ID,
            abi.encodePacked(depositoryAddr),
            address(noHashesBuilder)
        );

        vm.prank(receiver);
        vm.expectRevert(RelayAllocator.NoHashesToSign.selector);
        allocator.submitWithdrawRequest(_request(bytes32(uint256(1)), 10));

        assertEq(hub.balanceOf(spenderAlias, tokenId), 100);
    }

    function test_checksDuplicateRequestsBeforeBuildingReplacementPayload()
        public
    {
        WithdrawRequest memory r = _request(
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

    function test_rejectsPlantedOperatorAfterGranterRoleIsRevoked() public {
        vm.prank(allocatorOwner);
        hub.setOperatorFor(spenderAlias, relayer, true);

        vm.prank(relayer);
        allocator.submitWithdrawRequest(_request(bytes32(uint256(1)), 10));
        assertEq(hub.balanceOf(spenderAlias, tokenId), 90);

        bytes32 operatorRole = hub.OPERATOR_ROLE();
        vm.prank(allocatorOwner);
        hub.revokeRole(operatorRole, allocatorOwner);

        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(
                RelayAllocator.CallerIsNotApproved.selector,
                relayer
            )
        );
        allocator.submitWithdrawRequest(_request(bytes32(uint256(2)), 10));
    }

    function test_rejectsUnsignedDirectCallFromRemoteSpenderChain() public {
        vm.prank(receiver);
        vm.expectRevert(
            abi.encodeWithSelector(
                RelayAllocator.CallerIsNotApproved.selector,
                receiver
            )
        );
        allocator.submitWithdrawRequest(
            _remoteRequest(bytes32(uint256(1)), 10)
        );
    }

    function test_allowsRemoteSpenderChainViaHubOperator() public {
        vm.prank(allocatorOwner);
        hub.setOperatorFor(remoteAlias, relayer, true);

        vm.prank(relayer);
        allocator.submitWithdrawRequest(
            _remoteRequest(bytes32(uint256(1)), 10)
        );

        assertEq(hub.balanceOf(remoteAlias, tokenId), 90);
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
        WithdrawRequest memory r = _request(
            bytes32(uint256(1)),
            10
        );
        bytes memory sig = _signRequest(receiverPk, r);

        vm.prank(relayer);
        allocator.submitWithdrawRequestWithSignature(
            WithdrawRequestAuthorization(r, Authorization(expiration, sig))
        );

        assertEq(hub.balanceOf(spenderAlias, tokenId), 90);
        assertTrue(allocator.usedNonces(_spenderNonceKey(r), r.nonce));
    }

    function test_allowsRemoteSpenderChainWithSignature() public {
        WithdrawRequest memory r = _remoteRequest(
            bytes32(uint256(1)),
            10
        );
        bytes memory sig = _signRequest(receiverPk, r);

        vm.prank(relayer);
        allocator.submitWithdrawRequestWithSignature(
            WithdrawRequestAuthorization(r, Authorization(expiration, sig))
        );

        assertEq(hub.balanceOf(remoteAlias, tokenId), 90);
    }

    function test_rejectsReplayingReceiverNonce() public {
        bytes32 nonce = bytes32(uint256(1));
        WithdrawRequest memory r = _request(nonce, 10);
        bytes memory sig = _signRequest(receiverPk, r);

        vm.prank(relayer);
        allocator.submitWithdrawRequestWithSignature(
            WithdrawRequestAuthorization(r, Authorization(expiration, sig))
        );

        WithdrawRequest memory r2 = _request(nonce, 11);

        vm.prank(relayer);
        vm.expectRevert();
        allocator.submitWithdrawRequestWithSignature(
            WithdrawRequestAuthorization(r2, Authorization(expiration, sig))
        );
    }

    function test_allowsSpenderSignatureVerifiedByOracle() public {
        bytes memory solanaSpender = bytes("solana-public-key");
        address solanaAlias = Utils.generateAddress(
            "solana-mainnet",
            solanaSpender
        );
        vm.prank(allocatorOwner);
        hub.mint(solanaAlias, tokenId, 100);

        WithdrawRequest memory r = _request(
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
        allocator.submitWithdrawRequestWithSignature(
            WithdrawRequestAuthorization(r, Authorization(expiration, sig))
        );

        assertEq(hub.balanceOf(solanaAlias, tokenId), 90);
        assertTrue(allocator.usedNonces(_spenderNonceKey(r), r.nonce));
    }

    function test_fallsBackToOracleWhenEvmRecoverFails() public {
        WithdrawRequest memory r = _request(
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
        allocator.submitWithdrawRequestWithSignature(
            WithdrawRequestAuthorization(r, Authorization(expiration, sig))
        );

        assertEq(hub.balanceOf(spenderAlias, tokenId), 90);
        assertTrue(allocator.usedNonces(_spenderNonceKey(r), r.nonce));
    }

    function test_sharesNonceBetweenEcdsaAndOracleSignaturesForSpender()
        public
    {
        bytes32 nonce = bytes32(uint256(4));
        WithdrawRequest memory r = _request(nonce, 10);
        bytes memory sig = _signRequest(receiverPk, r);

        vm.prank(relayer);
        allocator.submitWithdrawRequestWithSignature(
            WithdrawRequestAuthorization(r, Authorization(expiration, sig))
        );

        WithdrawRequest memory r2 = _request(nonce, 11);
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
        allocator.submitWithdrawRequestWithSignature(
            WithdrawRequestAuthorization(r2, Authorization(expiration, oracleSig))
        );
    }

    function test_sharesOracleNonceForSameSpenderAcrossSpenderChainIds()
        public
    {
        bytes32 nonce = bytes32(uint256(5));
        bytes memory sharedSpender = bytes("shared-spender");

        WithdrawRequest memory r = _request(nonce, 10);
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
        allocator.submitWithdrawRequestWithSignature(
            WithdrawRequestAuthorization(r, Authorization(expiration, sig))
        );

        WithdrawRequest memory r2 = _request(nonce, 11);
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
        allocator.submitWithdrawRequestWithSignature(
            WithdrawRequestAuthorization(r2, Authorization(expiration, sig2))
        );
    }
}

contract RelayAllocatorSignatureExpirationTest is RelayAllocatorBase {
    function test_acceptsSignatureAtItsExpiration() public {
        WithdrawRequest memory r = _request(bytes32(uint256(1)), 10);
        bytes memory sig = _signRequest(receiverPk, r);

        vm.warp(expiration);
        vm.prank(relayer);
        allocator.submitWithdrawRequestWithSignature(
            WithdrawRequestAuthorization(r, Authorization(expiration, sig))
        );

        assertEq(hub.balanceOf(spenderAlias, tokenId), 90);
    }

    function test_revertsSignatureExpiredAfterExpiration() public {
        WithdrawRequest memory r = _request(bytes32(uint256(1)), 10);
        bytes memory sig = _signRequest(receiverPk, r);

        vm.warp(expiration + 1);
        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(
                RelayAllocator.SignatureExpired.selector,
                expiration
            )
        );
        allocator.submitWithdrawRequestWithSignature(
            WithdrawRequestAuthorization(r, Authorization(expiration, sig))
        );

        assertEq(hub.balanceOf(spenderAlias, tokenId), 100);
        assertFalse(allocator.usedNonces(_spenderNonceKey(r), r.nonce));
    }

    function test_revertsSignatureExpiredForOracleVerifiedSpender() public {
        WithdrawRequest memory r = _request(bytes32(uint256(2)), 10);
        r.spenderChainId = "solana-mainnet";
        r.spender = bytes("solana-public-key");
        address solanaAlias = Utils.generateAddress(
            r.spenderChainId,
            r.spender
        );
        vm.prank(allocatorOwner);
        hub.mint(solanaAlias, tokenId, 100);
        bytes memory sig = bytes("oracle-verified-signature");
        signatureOracle.setExpected(
            r.spenderChainId,
            r.spender,
            _requestDigest(r),
            sig,
            true
        );

        vm.warp(expiration + 1);
        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(
                RelayAllocator.SignatureExpired.selector,
                expiration
            )
        );
        allocator.submitWithdrawRequestWithSignature(
            WithdrawRequestAuthorization(r, Authorization(expiration, sig))
        );
    }

    function test_rejectsSignatureWithTamperedExpiration() public {
        WithdrawRequest memory r = _request(bytes32(uint256(1)), 10);
        bytes memory sig = _signRequest(receiverPk, r);

        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(
                RelayAllocator.CallerIsNotApproved.selector,
                relayer
            )
        );
        allocator.submitWithdrawRequestWithSignature(
            WithdrawRequestAuthorization(r, Authorization(expiration + 1, sig))
        );
    }

    function test_rejectsOracleSignatureWithTamperedExpiration() public {
        WithdrawRequest memory r = _request(bytes32(uint256(2)), 10);
        r.spenderChainId = "solana-mainnet";
        r.spender = bytes("solana-public-key");
        address solanaAlias = Utils.generateAddress(
            r.spenderChainId,
            r.spender
        );
        vm.prank(allocatorOwner);
        hub.mint(solanaAlias, tokenId, 100);
        bytes memory sig = bytes("oracle-verified-signature");
        signatureOracle.setExpected(
            r.spenderChainId,
            r.spender,
            _requestDigest(r, expiration),
            sig,
            true
        );

        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(
                RelayAllocator.CallerIsNotApproved.selector,
                relayer
            )
        );
        allocator.submitWithdrawRequestWithSignature(
            WithdrawRequestAuthorization(r, Authorization(expiration + 1, sig))
        );

        assertEq(hub.balanceOf(solanaAlias, tokenId), 100);
        assertFalse(allocator.usedNonces(_spenderNonceKey(r), r.nonce));
    }

    function test_signatureForUnfundedAliasExpires() public {
        // A failed burn rolls back the nonce, so only the expiration bounds the signature
        WithdrawRequest memory r = _request(bytes32(uint256(1)), 150);
        bytes memory sig = _signRequest(receiverPk, r);

        vm.prank(relayer);
        vm.expectRevert();
        allocator.submitWithdrawRequestWithSignature(
            WithdrawRequestAuthorization(r, Authorization(expiration, sig))
        );
        assertFalse(allocator.usedNonces(_spenderNonceKey(r), r.nonce));

        vm.prank(allocatorOwner);
        hub.mint(spenderAlias, tokenId, 100);

        vm.warp(expiration + 1);
        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(
                RelayAllocator.SignatureExpired.selector,
                expiration
            )
        );
        allocator.submitWithdrawRequestWithSignature(
            WithdrawRequestAuthorization(r, Authorization(expiration, sig))
        );
        assertEq(hub.balanceOf(spenderAlias, tokenId), 200);
    }

    function test_ignoresExpirationForDirectSpender() public {
        // An expired signature is never consulted when the caller is the spender
        WithdrawRequest memory r = _request(bytes32(uint256(1)), 10);
        bytes memory sig = _signRequest(receiverPk, r);

        vm.warp(expiration + 1);
        vm.prank(receiver);
        allocator.submitWithdrawRequestWithSignature(
            WithdrawRequestAuthorization(r, Authorization(expiration, sig))
        );

        assertEq(hub.balanceOf(spenderAlias, tokenId), 90);
    }
}

/// @notice Test builder that echoes the hash of the request it received as the payload
contract RequestHashEchoPayloadBuilder is IPayloadBuilder {
    function buildPayload(
        string calldata,
        bytes calldata,
        WithdrawRequest calldata params
    ) external pure returns (bytes memory payload, WithdrawFee memory fee) {
        return (abi.encode(keccak256(abi.encode(params))), fee);
    }

    function hashesToSign(
        string calldata,
        bytes calldata,
        bytes calldata
    ) external pure returns (bytes32[] memory hashes) {
        hashes = new bytes32[](1);
    }

    function curve() external pure returns (string memory name) {
        return "Ecdsa";
    }

    function family() external pure returns (string memory name) {
        return "mock";
    }
}

/// @notice Cyfrin #19: destination ids must commit to the withdraw request, so two
/// spenders submitting byte-identical parameters in one block both execute
contract RelayAllocatorRequestHashTest is RelayAllocatorBase {
    function test_forwardsTheWholeRequestToPayloadBuilder() public {
        RequestHashEchoPayloadBuilder echo = new RequestHashEchoPayloadBuilder();
        vm.prank(allocatorOwner);
        allocator.setPayloadBuilder(
            CHAIN_ID,
            abi.encodePacked(depositoryAddr),
            address(echo)
        );

        WithdrawRequest memory r = _request(
            bytes32(uint256(7)),
            10
        );
        vm.prank(receiver);
        bytes32 withdrawRequestHash = allocator.submitWithdrawRequest(r);

        assertEq(withdrawRequestHash, keccak256(abi.encode(r)));
        assertEq(
            abi.decode(allocator.payloads(withdrawRequestHash), (bytes32)),
            withdrawRequestHash
        );
    }

    function test_twoSpendersWithIdenticalParametersBothExecuteInOneBlock()
        public
    {
        (address allocatorSigner, uint256 allocatorSignerPk) = makeAddrAndKey(
            "allocator-signer"
        );
        RelayDepository depository = new RelayDepository(
            allocatorOwner,
            allocatorSigner
        );
        vm.deal(address(depository), 1 ether);
        bytes memory depositoryBytes = abi.encodePacked(address(depository));

        vm.startPrank(allocatorOwner);
        allocator.setPayloadBuilder(
            CHAIN_ID,
            depositoryBytes,
            address(payloadBuilder)
        );
        // The depository signs over the real chain id; point the builder at it
        config.setConfigValue(
            payloadBuilder.getEvmChainIdKey(CHAIN_ID),
            bytes32(block.chainid)
        );
        vm.stopPrank();

        address spenderB = otherAccounts[3];
        address aliasB = Utils.generateAddress(
            SPENDER_CHAIN_ID,
            abi.encodePacked(spenderB)
        );
        vm.prank(allocatorOwner);
        hub.mint(aliasB, tokenId, 100);

        // Same currency, amount, receiver, nonce and data; only the spender differs
        WithdrawRequest memory rA = _request(bytes32(0), 10);
        rA.depository = depositoryBytes;
        WithdrawRequest memory rB = _request(bytes32(0), 10);
        rB.depository = depositoryBytes;
        rB.spender = abi.encodePacked(spenderB);

        vm.prank(receiver);
        bytes32 hashA = allocator.submitWithdrawRequest(rA);
        vm.prank(spenderB);
        bytes32 hashB = allocator.submitWithdrawRequest(rB);

        CallRequest memory requestA = abi.decode(
            allocator.payloads(hashA),
            (CallRequest)
        );
        CallRequest memory requestB = abi.decode(
            allocator.payloads(hashB),
            (CallRequest)
        );
        assertTrue(requestA.nonce != requestB.nonce);

        uint256 balanceBefore = receiver.balance;
        depository.execute(
            _executable(requestA),
            _signDigest(allocatorSignerPk, allocator.hashesToSign(hashA, 0))
        );
        depository.execute(
            _executable(requestB),
            _signDigest(allocatorSignerPk, allocator.hashesToSign(hashB, 0))
        );
        assertEq(receiver.balance, balanceBefore + 20);
    }

    /// @dev The depository consumes the built request without the `dataHash`
    /// commitment column, as the off-chain executor submits it
    function _executable(
        CallRequest memory built
    ) internal pure returns (DepositoryCallRequest memory request) {
        request.calls = new DepositoryCall[](built.calls.length);
        for (uint256 i; i < built.calls.length; ++i) {
            Call memory c = built.calls[i];
            request.calls[i] = DepositoryCall({
                to: c.to,
                data: c.data,
                value: c.value,
                allowFailure: c.allowFailure
            });
        }
        request.nonce = built.nonce;
        request.expiration = built.expiration;
    }

    function _signDigest(
        uint256 pk,
        bytes32 digest
    ) internal pure returns (bytes memory) {
        (uint8 v, bytes32 sigR, bytes32 sigS) = vm.sign(pk, digest);
        return abi.encodePacked(sigR, sigS, v);
    }
}

/// @notice Cyfrin #19: Hyperliquid has no memo, so its nonce takes the allocator's per-chain
/// withdrawal count for the block second and same-second requests never share a nonce
contract RelayAllocatorWithdrawalCountTest is RelayAllocatorBase {
    string internal constant HYPERLIQUID_CHAIN_ID = "hyperliquid";
    bytes internal constant HYPERLIQUID_NATIVE = hex"00000000000000000000000000000000";

    function test_givesSameSecondHyperliquidRequestsDistinctNonces() public {
        address spenderB = _useHyperliquidBuilder();

        // Same destination, token and amount from two spenders in one block
        vm.prank(receiver);
        bytes32 hashA = allocator.submitWithdrawRequest(
            _hyperliquidRequest(receiver, 0)
        );
        vm.prank(spenderB);
        bytes32 hashB = allocator.submitWithdrawRequest(
            _hyperliquidRequest(spenderB, 0)
        );
        assertEq(_hyperliquidTime(hashA), block.timestamp * 1000);
        assertEq(_hyperliquidTime(hashB), block.timestamp * 1000 + 1);
        assertEq(allocator.withdrawalsThisSecond(HYPERLIQUID_CHAIN_ID), 2);

        vm.warp(block.timestamp + 1);
        assertEq(allocator.withdrawalsThisSecond(HYPERLIQUID_CHAIN_ID), 0);
        vm.prank(receiver);
        bytes32 hashC = allocator.submitWithdrawRequest(
            _hyperliquidRequest(receiver, 1)
        );
        assertEq(_hyperliquidTime(hashC), block.timestamp * 1000);
    }

    function test_continuesTheIndexInALaterBlockOfTheSameSecond() public {
        _useHyperliquidBuilder();

        vm.prank(receiver);
        allocator.submitWithdrawRequest(_hyperliquidRequest(receiver, 0));
        vm.roll(block.number + 1);
        vm.prank(receiver);
        bytes32 hash = allocator.submitWithdrawRequest(
            _hyperliquidRequest(receiver, 1)
        );

        assertEq(_hyperliquidTime(hash), block.timestamp * 1000 + 1);
    }

    function test_revertsTheThousandAndFirstHyperliquidWithdrawalInOneSecond()
        public
    {
        _useHyperliquidBuilder();
        uint256 hyperliquidTokenId = Utils.generateTokenId(
            HYPERLIQUID_CHAIN_ID,
            HYPERLIQUID_NATIVE
        );
        vm.prank(allocatorOwner);
        hub.mint(spenderAlias, hyperliquidTokenId, 10_000);

        vm.startPrank(receiver);
        for (uint256 i; i < 1000; ++i) {
            allocator.submitWithdrawRequest(_hyperliquidRequest(receiver, i));
        }
        uint256 balance = hub.balanceOf(spenderAlias, hyperliquidTokenId);
        vm.expectRevert(HyperliquidVmPayloadBuilder.NoncesExhausted.selector);
        allocator.submitWithdrawRequest(_hyperliquidRequest(receiver, 1000));
        assertEq(hub.balanceOf(spenderAlias, hyperliquidTokenId), balance);

        vm.warp(block.timestamp + 1);
        bytes32 hash = allocator.submitWithdrawRequest(
            _hyperliquidRequest(receiver, 1000)
        );
        vm.stopPrank();
        assertEq(_hyperliquidTime(hash), block.timestamp * 1000);
    }

    function test_countsWithdrawalsPerChain() public {
        _useHyperliquidBuilder();

        vm.startPrank(receiver);
        allocator.submitWithdrawRequest(_request(bytes32(uint256(1)), 10));
        allocator.submitWithdrawRequest(_request(bytes32(uint256(2)), 10));
        vm.stopPrank();

        assertEq(allocator.withdrawalsThisSecond(CHAIN_ID), 2);
        assertEq(allocator.withdrawalsThisSecond(HYPERLIQUID_CHAIN_ID), 0);
    }

    function test_doesNotCountARejectedWithdrawal() public {
        vm.prank(receiver);
        allocator.submitWithdrawRequest(_request(bytes32(uint256(1)), 10));

        NoHashesPayloadBuilder noHashesBuilder = new NoHashesPayloadBuilder();
        vm.prank(allocatorOwner);
        allocator.setPayloadBuilder(
            CHAIN_ID,
            abi.encodePacked(depositoryAddr),
            address(noHashesBuilder)
        );
        vm.prank(receiver);
        vm.expectRevert(RelayAllocator.NoHashesToSign.selector);
        allocator.submitWithdrawRequest(_request(bytes32(uint256(2)), 10));

        assertEq(allocator.withdrawalsThisSecond(CHAIN_ID), 1);
    }

    /// @dev Registers a real Hyperliquid builder and funds the receiver and a second spender
    function _useHyperliquidBuilder() internal returns (address spenderB) {
        HyperliquidVmPayloadBuilder hyperliquid = new HyperliquidVmPayloadBuilder(
            address(config),
            42161,
            "Mainnet"
        );
        vm.startPrank(allocatorOwner);
        allocator.setPayloadBuilder(
            HYPERLIQUID_CHAIN_ID,
            abi.encodePacked(depositoryAddr),
            address(hyperliquid)
        );
        config.setConfigValue(
            hyperliquid.getTargetDecimalsKey(
                HYPERLIQUID_CHAIN_ID,
                HYPERLIQUID_NATIVE
            ),
            bytes32(uint256(8))
        );
        vm.stopPrank();

        spenderB = otherAccounts[3];
        uint256 hyperliquidTokenId = Utils.generateTokenId(
            HYPERLIQUID_CHAIN_ID,
            HYPERLIQUID_NATIVE
        );
        address aliasB = Utils.generateAddress(
            SPENDER_CHAIN_ID,
            abi.encodePacked(spenderB)
        );
        vm.startPrank(allocatorOwner);
        hub.mint(spenderAlias, hyperliquidTokenId, 100);
        hub.mint(aliasB, hyperliquidTokenId, 100);
        vm.stopPrank();
    }

    function _hyperliquidTime(
        bytes32 withdrawRequestHash
    ) internal view returns (uint256) {
        // A usdSend payload is (uint8 txType, string, string, string, uint64 time)
        (, , , , uint64 time) = abi.decode(
            allocator.payloads(withdrawRequestHash),
            (uint8, string, string, string, uint64)
        );
        return time;
    }

    function _hyperliquidRequest(
        address spender,
        uint256 nonce
    ) internal view returns (WithdrawRequest memory) {
        return
            WithdrawRequest({
                chainId: HYPERLIQUID_CHAIN_ID,
                depository: abi.encodePacked(depositoryAddr),
                currency: HYPERLIQUID_NATIVE,
                amount: 10,
                spenderChainId: SPENDER_CHAIN_ID,
                spender: abi.encodePacked(spender),
                receiver: abi.encodePacked(receiver),
                data: abi.encode(uint64(0)),
                nonce: bytes32(nonce)
            });
    }
}

/// @notice Cyfrin #19: the Atlas memo binds the whole request, so requests from two spenders
/// for the same gapless nonce never share a transfer
contract RelayAllocatorAtlasWithdrawalTest is RelayAllocatorBase {
    string internal constant ATLAS_CHAIN_ID = "atlas-testnet";
    bytes internal constant ATLAS_USDT = hex"00000000000000000000000000000002";

    AtlasVmPayloadBuilder internal atlas;

    function test_bindsTheAtlasMemoToTheWholeRequest() public {
        address spenderB = _useAtlasBuilder();

        vm.prank(receiver);
        bytes32 hashA = allocator.submitWithdrawRequest(
            _atlasRequest(receiver, 0)
        );
        vm.prank(spenderB);
        bytes32 hashB = allocator.submitWithdrawRequest(
            _atlasRequest(spenderB, 0)
        );

        assertEq(
            _atlasTransfer(hashA).memoHead,
            keccak256(abi.encode(address(atlas), _atlasRequest(receiver, 0)))
        );
        assertNotEq(
            _atlasTransfer(hashA).memoHead,
            _atlasTransfer(hashB).memoHead
        );
        assertNotEq(
            allocator.hashesToSign(hashA, 0),
            allocator.hashesToSign(hashB, 0)
        );
    }

    /// @dev Registers a real Atlas builder and funds the receiver and a second spender
    function _useAtlasBuilder() internal returns (address spenderB) {
        atlas = new AtlasVmPayloadBuilder(address(config));
        vm.startPrank(allocatorOwner);
        allocator.setPayloadBuilder(
            ATLAS_CHAIN_ID,
            abi.encodePacked(depositoryAddr),
            address(atlas)
        );
        config.setConfigValue(
            atlas.getDomainChainIdKey(ATLAS_CHAIN_ID),
            bytes32(uint256(43003))
        );
        config.setConfigValue(
            atlas.getExpirationKey(ATLAS_CHAIN_ID),
            bytes32(uint256(1 hours))
        );
        config.setConfigValue(
            atlas.getDomainSaltKey(ATLAS_CHAIN_ID),
            keccak256("atlas/testnet")
        );
        config.setConfigValue(
            atlas.getAssetDecimalsKey(ATLAS_CHAIN_ID, ATLAS_USDT),
            bytes32(uint256(6))
        );
        vm.stopPrank();

        spenderB = otherAccounts[3];
        uint256 atlasTokenId = Utils.generateTokenId(
            ATLAS_CHAIN_ID,
            ATLAS_USDT
        );
        address aliasB = Utils.generateAddress(
            SPENDER_CHAIN_ID,
            abi.encodePacked(spenderB)
        );
        vm.startPrank(allocatorOwner);
        hub.mint(spenderAlias, atlasTokenId, 100);
        hub.mint(aliasB, atlasTokenId, 100);
        vm.stopPrank();
    }

    function _atlasTransfer(
        bytes32 withdrawRequestHash
    ) internal view returns (AtlasTransfer memory) {
        (, AtlasTransfer memory transfer) = abi.decode(
            allocator.payloads(withdrawRequestHash),
            (AtlasPayloadHeader, AtlasTransfer)
        );
        return transfer;
    }

    function _atlasRequest(
        address spender,
        uint256 nonce
    ) internal view returns (WithdrawRequest memory) {
        return
            WithdrawRequest({
                chainId: ATLAS_CHAIN_ID,
                depository: abi.encodePacked(depositoryAddr),
                currency: ATLAS_USDT,
                amount: 10,
                spenderChainId: SPENDER_CHAIN_ID,
                spender: abi.encodePacked(spender),
                receiver: abi.encodePacked(receiver),
                data: abi.encode(uint64(2)),
                nonce: bytes32(nonce)
            });
    }
}

contract RelayAllocatorExpirationTest is RelayAllocatorBase {
    function _digest(WithdrawRequest memory r, uint256 expiration, bool withFee) internal view returns (bytes32) {
        withFee;
        return allocator.hashWithdrawRequestAuthorization(r, expiration);
    }

    function _submit(WithdrawRequest memory r, uint256 expiration, bytes memory sig, bool withFee) internal returns (bytes32) {
        WithdrawFeePaymentAuthorization memory authorization;
        if (withFee) return allocator.submitWithdrawRequestWithSignature(WithdrawRequestAuthorization(r, Authorization(expiration, sig)), authorization);
        return allocator.submitWithdrawRequestWithSignature(WithdrawRequestAuthorization(r, Authorization(expiration, sig)));
    }

    function testFuzz_expirationBoundaryEoaAndOracle(bool withFee, bool oracle) public {
        WithdrawRequest memory r = _request(bytes32(uint256(99)), 1);
        uint256 expiration = block.timestamp + 100;
        bytes32 digest = _digest(r, expiration, withFee);
        bytes memory sig;
        if (oracle) {
            sig = hex"1234";
            signatureOracle.setExpected(r.spenderChainId, r.spender, digest, sig, true);
        } else {
            (uint8 v, bytes32 sR, bytes32 sS) = vm.sign(receiverPk, digest);
            sig = abi.encodePacked(sR, sS, v);
        }
        vm.warp(expiration + 1);
        vm.expectRevert(abi.encodeWithSelector(RelayAllocator.SignatureExpired.selector, expiration));
        _submit(r, expiration, sig, withFee);
        assertFalse(allocator.usedNonces(keccak256(r.spender), r.nonce));
        assertEq(allocator.payloads(keccak256(abi.encode(r))).length, 0);
        vm.warp(expiration);
        bytes32 canonical = _submit(r, expiration, sig, withFee);
        assertEq(canonical, keccak256(abi.encode(r)));
        assertTrue(allocator.usedNonces(keccak256(r.spender), r.nonce));
    }

    function testFuzz_expirationTamperingRejected(bool withFee) public {
        WithdrawRequest memory r = _request(bytes32(uint256(100)), 1);
        uint256 expiration = block.timestamp + 100;
        (uint8 v, bytes32 sR, bytes32 sS) = vm.sign(receiverPk, _digest(r, expiration, withFee));
        vm.expectRevert(abi.encodeWithSelector(RelayAllocator.CallerIsNotApproved.selector, address(this)));
        _submit(r, expiration + 1, abi.encodePacked(sR, sS, v), withFee);
        assertFalse(allocator.usedNonces(keccak256(r.spender), r.nonce));
    }

    function testFuzz_nonceSharedAcrossOverloads(bool feeFirst) public {
        WithdrawRequest memory r = _request(bytes32(uint256(101)), 1);
        uint256 expiration = block.timestamp + 100;
        (uint8 v, bytes32 sR, bytes32 sS) = vm.sign(receiverPk, _digest(r, expiration, feeFirst));
        _submit(r, expiration, abi.encodePacked(sR, sS, v), feeFirst);
        r.amount = 2;
        (v, sR, sS) = vm.sign(receiverPk, _digest(r, expiration, !feeFirst));
        vm.expectRevert(abi.encodeWithSelector(RelayAllocator.CallerIsNotApproved.selector, address(this)));
        _submit(r, expiration, abi.encodePacked(sR, sS, v), !feeFirst);
    }

    function testFuzz_failedBurnRollsBackSignedAuthorization(bool withFee) public {
        WithdrawRequest memory r = _request(bytes32(uint256(102)), 101);
        uint256 expiration = block.timestamp + 100;
        (uint8 v, bytes32 sR, bytes32 sS) = vm.sign(receiverPk, _digest(r, expiration, withFee));
        vm.expectRevert();
        _submit(r, expiration, abi.encodePacked(sR, sS, v), withFee);
        assertFalse(allocator.usedNonces(keccak256(r.spender), r.nonce));
        assertEq(allocator.payloads(keccak256(abi.encode(r))).length, 0);
        assertEq(allocator.withdrawalsThisSecond(CHAIN_ID), 0);
    }
}
