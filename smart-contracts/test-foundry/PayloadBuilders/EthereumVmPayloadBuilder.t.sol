// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../utils/BaseTest.sol";
import {Eip712} from "../utils/Eip712.sol";
import {Config} from "../../contracts/Config.sol";
import {RelayAllocator, BuildPayloadParams} from "../../contracts/RelayAllocator.sol";
import {RelayHub} from "../../contracts/RelayHub.sol";
import {MyToken} from "../../contracts/test-utils/MyToken.sol";
import {EthereumVmPayloadBuilder, CallRequest, Call} from "../../contracts/payload-builders/EthereumVmPayloadBuilder.sol";

/// @notice Port of test/PayloadBuilders/EthereumVmPayloadBuilder.ts.
abstract contract EthereumVmPayloadBuilderBase is BaseTest {
    uint256 internal constant EXPIRATION_DELAY_SECONDS = 10 * 24 * 60 * 60;
    uint256 internal constant EXPIRATION_TOLERANCE_SECONDS = 10;

    address internal depositoryAddr;
    address internal receiverAddr;

    RelayHub internal hub;
    RelayAllocator internal allocator;
    Config internal config;
    EthereumVmPayloadBuilder internal payloadBuilder;
    MyToken internal myToken;

    function setUp() public virtual override {
        super.setUp();
        depositoryAddr = otherAccounts[0];
        receiverAddr = otherAccounts[1];

        hub = new RelayHub(owner);
        allocator = new RelayAllocator(owner, address(hub));
        config = new Config(address(allocator));
        payloadBuilder = new EthereumVmPayloadBuilder(address(config));
        myToken = new MyToken();

        bytes32 expirationKey = payloadBuilder.getExpirationKey();
        vm.prank(owner);
        config.setConfigValue(expirationKey, bytes32(EXPIRATION_DELAY_SECONDS));
    }

    function _addrBytes(address a) internal pure returns (bytes memory) {
        return abi.encodePacked(a);
    }
}

contract EthereumVmPayloadBuilderBuildPayloadTest is
    EthereumVmPayloadBuilderBase
{
    function test_buildsPayloadForNativeCurrency() public {
        uint256 amount = 0.1 ether;
        BuildPayloadParams memory params = BuildPayloadParams({
            currency: _addrBytes(address(0)),
            amount: amount,
            receiver: _addrBytes(receiverAddr),
            nonce: 1,
            data: ""
        });

        uint256 nowTs = block.timestamp;
        bytes memory payload = payloadBuilder.buildPayload(
            "ethereum-mainnet",
            _addrBytes(depositoryAddr),
            params
        );
        CallRequest memory decoded = abi.decode(payload, (CallRequest));

        assertGe(
            decoded.expiration,
            nowTs + EXPIRATION_DELAY_SECONDS - EXPIRATION_TOLERANCE_SECONDS
        );
        assertLe(
            decoded.expiration,
            nowTs + EXPIRATION_DELAY_SECONDS + EXPIRATION_TOLERANCE_SECONDS
        );
        assertEq(decoded.calls.length, 1);
        Call memory c = decoded.calls[0];
        assertEq(c.to, receiverAddr);
        assertEq(c.value, amount);
        assertFalse(c.allowFailure);

        uint256 balBefore = receiverAddr.balance;
        vm.deal(depositoryAddr, amount);
        vm.prank(depositoryAddr);
        (bool ok, ) = c.to.call{value: c.value}(c.data);
        require(ok, "send failed");
        assertEq(receiverAddr.balance, balBefore + amount);
    }

    function test_derivesNonceFromBlockNumberAndPayloadFields() public {
        uint256 amount = 0.1 ether;
        BuildPayloadParams memory params = BuildPayloadParams({
            currency: _addrBytes(address(0)),
            amount: amount,
            receiver: _addrBytes(receiverAddr),
            nonce: 1,
            data: ""
        });

        uint256 blockNumber = block.number;
        bytes memory payload = payloadBuilder.buildPayload(
            "ethereum-mainnet",
            _addrBytes(depositoryAddr),
            params
        );
        CallRequest memory decoded = abi.decode(payload, (CallRequest));

        uint256 expectedNonce = uint256(
            keccak256(
                abi.encode(
                    blockNumber,
                    uint256(1),
                    _addrBytes(address(0)),
                    _addrBytes(receiverAddr),
                    bytes(""),
                    amount
                )
            )
        );
        assertEq(decoded.nonce, expectedNonce);
        assertTrue(decoded.nonce != 1);
    }

    function test_buildsPayloadForErc20Token() public {
        uint256 amount = 1337 * 1e18;
        myToken.mintFor(amount, depositoryAddr);

        uint256 nowTs = block.timestamp;
        BuildPayloadParams memory params = BuildPayloadParams({
            currency: _addrBytes(address(myToken)),
            amount: amount,
            receiver: _addrBytes(receiverAddr),
            nonce: 3,
            data: ""
        });

        bytes memory payload = payloadBuilder.buildPayload(
            "ethereum-mainnet",
            _addrBytes(depositoryAddr),
            params
        );
        CallRequest memory decoded = abi.decode(payload, (CallRequest));

        assertGe(
            decoded.expiration,
            nowTs + EXPIRATION_DELAY_SECONDS - EXPIRATION_TOLERANCE_SECONDS
        );
        assertLe(
            decoded.expiration,
            nowTs + EXPIRATION_DELAY_SECONDS + EXPIRATION_TOLERANCE_SECONDS
        );
        assertEq(decoded.calls.length, 1);
        Call memory c = decoded.calls[0];
        assertEq(c.to, address(myToken));
        assertEq(c.value, 0);
        assertFalse(c.allowFailure);

        uint256 balBefore = myToken.balanceOf(receiverAddr);
        vm.prank(depositoryAddr);
        (bool ok, ) = c.to.call(c.data);
        require(ok, "transfer call failed");
        assertEq(myToken.balanceOf(receiverAddr), balBefore + amount);
    }

    function test_revertsWhenReceiverIsNot20Bytes() public {
        BuildPayloadParams memory params = BuildPayloadParams({
            currency: _addrBytes(address(0)),
            amount: 1,
            receiver: hex"1234",
            nonce: 1,
            data: ""
        });

        vm.expectRevert(
            abi.encodeWithSelector(
                EthereumVmPayloadBuilder.InvalidReceiverLength.selector,
                uint256(2)
            )
        );
        payloadBuilder.buildPayload(
            "ethereum-mainnet",
            _addrBytes(depositoryAddr),
            params
        );
    }

    function test_revertsWhenCurrencyIsNeitherEmptyNor20Bytes() public {
        BuildPayloadParams memory params = BuildPayloadParams({
            currency: hex"1234",
            amount: 1,
            receiver: _addrBytes(receiverAddr),
            nonce: 1,
            data: ""
        });

        vm.expectRevert(
            abi.encodeWithSelector(
                EthereumVmPayloadBuilder.InvalidCurrencyLength.selector,
                uint256(2)
            )
        );
        payloadBuilder.buildPayload(
            "ethereum-mainnet",
            _addrBytes(depositoryAddr),
            params
        );
    }
}

contract EthereumVmPayloadBuilderHashesToSignTest is
    EthereumVmPayloadBuilderBase
{
    function _setEvmChainId(string memory chainId, uint256 evmChainId) internal {
        bytes32 key = payloadBuilder.getEvmChainIdKey(chainId);
        vm.prank(owner);
        config.setConfigValue(key, bytes32(evmChainId));
    }

    function test_hashesPayloadCorrectlyUsingEip712() public {
        string memory chainId = "ethereum-mainnet";
        _setEvmChainId(chainId, 1);

        BuildPayloadParams memory params = BuildPayloadParams({
            currency: _addrBytes(address(0)),
            amount: 0.1 ether,
            receiver: _addrBytes(receiverAddr),
            nonce: 4,
            data: ""
        });
        bytes memory payload = payloadBuilder.buildPayload(
            chainId,
            _addrBytes(depositoryAddr),
            params
        );

        bytes32[] memory hashes = payloadBuilder.hashesToSign(
            chainId,
            _addrBytes(depositoryAddr),
            payload
        );

        CallRequest memory req = abi.decode(payload, (CallRequest));

        // Reconstruct the EIP-712 hash exactly as the contract does.
        bytes32 domainSep = Eip712.domainSeparator(
            "RelayDepository",
            "1",
            1,
            depositoryAddr
        );
        bytes32 CALL_TYPEHASH = keccak256(
            "Call(address to,bytes data,uint256 value,bool allowFailure)"
        );
        bytes32 CALL_REQUEST_TYPEHASH = keccak256(
            "CallRequest(Call[] calls,uint256 nonce,uint256 expiration)Call(address to,bytes data,uint256 value,bool allowFailure)"
        );
        bytes32[] memory callHashes = new bytes32[](req.calls.length);
        for (uint256 i = 0; i < req.calls.length; i++) {
            callHashes[i] = keccak256(
                abi.encode(
                    CALL_TYPEHASH,
                    req.calls[i].to,
                    keccak256(req.calls[i].data),
                    req.calls[i].value,
                    req.calls[i].allowFailure
                )
            );
        }
        bytes32 structHash = keccak256(
            abi.encode(
                CALL_REQUEST_TYPEHASH,
                keccak256(abi.encodePacked(callHashes)),
                req.nonce,
                req.expiration
            )
        );
        bytes32 expected = keccak256(
            abi.encodePacked("\x19\x01", domainSep, structHash)
        );

        assertEq(hashes[0], expected);
    }

    function test_namespacesConfigKeyForEvmChainIdLookups() public view {
        string memory chainId = "ethereum-mainnet";
        bytes32 key = payloadBuilder.getEvmChainIdKey(chainId);
        bytes32 expected = keccak256(
            abi.encodePacked(keccak256("ETHEREUM_VM_CHAIN_ID"), chainId)
        );
        assertEq(key, expected);
    }

    function test_namespacesConfigKeyForExpirationLookups() public view {
        assertEq(
            payloadBuilder.getExpirationKey(),
            keccak256("ETHEREUM_VM_EXPIRATION")
        );
    }

    function test_revertsIfChainIdIsNotConfigured() public {
        Call[] memory calls = new Call[](1);
        calls[0] = Call({
            to: address(0),
            data: "",
            value: 0,
            allowFailure: false
        });
        CallRequest memory req = CallRequest({
            calls: calls,
            nonce: 1,
            expiration: 2
        });
        bytes memory payload = abi.encode(req);

        vm.expectRevert(
            abi.encodeWithSelector(
                Config.ConfigValueNotSet.selector,
                payloadBuilder.getEvmChainIdKey("missing-chain-id")
            )
        );
        payloadBuilder.hashesToSign(
            "missing-chain-id",
            _addrBytes(address(0x1111111111111111111111111111111111111111)),
            payload
        );
    }

    function test_revertsIfDepositoryIsNot20Bytes() public {
        _setEvmChainId("ethereum-mainnet", 1);

        Call[] memory calls = new Call[](1);
        calls[0] = Call({
            to: address(0),
            data: "",
            value: 0,
            allowFailure: false
        });
        CallRequest memory req = CallRequest({
            calls: calls,
            nonce: 1,
            expiration: 2
        });
        bytes memory payload = abi.encode(req);

        vm.expectRevert(
            abi.encodeWithSelector(
                EthereumVmPayloadBuilder.InvalidDepositoryLength.selector,
                uint256(2)
            )
        );
        payloadBuilder.hashesToSign("ethereum-mainnet", hex"1234", payload);
    }
}

contract EthereumVmPayloadBuilderMetadataTest is EthereumVmPayloadBuilderBase {
    function test_returnsExpectedCurve() public view {
        assertEq(payloadBuilder.curve(), "Ecdsa");
    }

    function test_returnsExpectedFamily() public view {
        assertEq(payloadBuilder.family(), "ethereum-vm");
    }
}
