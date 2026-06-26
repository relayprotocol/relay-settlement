// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../utils/BaseTest.sol";
import {Config} from "../../contracts/Config.sol";
import {RelayAllocator, BuildPayloadParams} from "../../contracts/RelayAllocator.sol";
import {RelayHub} from "../../contracts/RelayHub.sol";
import {SolanaVmPayloadBuilder} from "../../contracts/payload-builders/SolanaVmPayloadBuilder.sol";

/// @notice Port of test/PayloadBuilders/SolanaVmPayloadBuilder.ts.
/// The Solana payload is a Borsh-encoded fixed-layout blob; the test
/// decodes it inline rather than depending on the TS-side `decodeDepositoryRequest`
/// helper. Base58 addresses are pre-decoded to their raw 32-byte pubkeys
/// (see node script in the original PR description).
abstract contract SolanaVmPayloadBuilderBase is BaseTest {
    string internal constant CHAIN_ID = "solana-mainnet";
    bytes32 internal constant DOMAIN = keccak256(hex"01");
    uint256 internal constant EXPIRATION_DELAY_SECONDS = 300;
    uint256 internal constant EXPIRATION_TOLERANCE_SECONDS = 10;

    // bs58.decode of canonical test addresses (computed offline).
    bytes32 internal constant VAULT_PUBKEY =
        0x1fa427265aebc381e466efb16f55b95fc3d44af745a3c52f6c599d3a7ec6b19a; // 38WpM5VeBuUM1GLTF8aWAYs4p4JDVPjrFxh1YRxzFpLH
    bytes32 internal constant TOKEN_PUBKEY =
        0x471500e6828e391e3b31326faa896e01212f976de1ad90ecb7823a2b96e9eb85; // 5nUXHYLUrYv9PmeN4RKZ1iwUFBGWmoqMTajEiKNsXRdE
    bytes32 internal constant RECIPIENT_PUBKEY_A =
        0xd354d13253ad4f7764f5c933ccadca795c052d143e2721ff5716848f1fe390cc; // FDx39MbXSupLUaxmN3SQ9x3G6mtTjemZVcWgz7jkcvTD
    bytes32 internal constant RECIPIENT_PUBKEY_B =
        0xc7f5fbcec2e7aa03f3be425f739b2eff62ccbd3c86b2b63ba5c7d09a14a1f138; // ETZgVwqLnzZFQfK2YB1rDLratt4cCGwNHcV8jJokrxmm

    address internal depositoryAddr;

    RelayHub internal hub;
    RelayAllocator internal allocator;
    Config internal config;
    SolanaVmPayloadBuilder internal payloadBuilder;

    function setUp() public virtual override {
        super.setUp();
        depositoryAddr = otherAccounts[0];

        hub = new RelayHub(owner);
        allocator = new RelayAllocator(owner, address(hub), address(0));
        config = new Config(address(allocator));
        payloadBuilder = new SolanaVmPayloadBuilder(address(config));

        bytes32 domainKey = payloadBuilder.getDomainKey(CHAIN_ID);
        bytes32 vaultKey = payloadBuilder.getVaultAddressKey(CHAIN_ID);
        bytes32 expirationKey = payloadBuilder.getExpirationKey();

        bytes32[] memory keys = new bytes32[](3);
        keys[0] = domainKey;
        keys[1] = vaultKey;
        keys[2] = expirationKey;
        bytes32[] memory values = new bytes32[](3);
        values[0] = DOMAIN;
        values[1] = VAULT_PUBKEY;
        values[2] = bytes32(EXPIRATION_DELAY_SECONDS);

        vm.prank(owner);
        config.setConfigValues(keys, values);
    }

    function _depositoryBytes() internal view returns (bytes memory) {
        return abi.encodePacked(depositoryAddr);
    }

    function _expectedNonce(
        uint256 blockNumber,
        uint256 nonce,
        bytes memory currency,
        bytes memory receiver,
        bytes memory data,
        uint256 amount
    ) internal pure returns (uint64) {
        return
            uint64(
                uint256(
                    keccak256(
                        abi.encode(
                            blockNumber,
                            nonce,
                            currency,
                            receiver,
                            data,
                            amount
                        )
                    )
                )
            );
    }

    // Decoders for the fixed-layout Borsh-encoded payload.

    function _decodeDomain(
        bytes memory payload
    ) internal pure returns (bytes32 result) {
        // Bytes [0..32)
        assembly {
            result := mload(add(payload, 32))
        }
    }

    function _decodeRecipient(
        bytes memory payload
    ) internal pure returns (bytes32 result) {
        // Bytes [32..64)
        assembly {
            result := mload(add(payload, 64))
        }
    }

    function _hasToken(
        bytes memory payload
    ) internal pure returns (bool) {
        // Byte at index 64
        return uint8(payload[64]) == 1;
    }

    function _decodeToken(
        bytes memory payload
    ) internal pure returns (bytes32 result) {
        // Bytes [65..97) when token tag is 0x01
        assembly {
            result := mload(add(payload, 97))
        }
    }

    function _decodeUint64LE(
        bytes memory payload,
        uint256 offset
    ) internal pure returns (uint64 v) {
        for (uint256 i = 0; i < 8; i++) {
            v |= uint64(uint8(payload[offset + i])) << uint8(i * 8);
        }
    }

    function _decodeAmount(
        bytes memory payload
    ) internal pure returns (uint64) {
        uint256 off = _hasToken(payload) ? 97 : 65;
        return _decodeUint64LE(payload, off);
    }

    function _decodeNonce(
        bytes memory payload
    ) internal pure returns (uint64) {
        uint256 off = _hasToken(payload) ? 105 : 73;
        return _decodeUint64LE(payload, off);
    }

    function _decodeExpiration(
        bytes memory payload
    ) internal pure returns (uint64) {
        uint256 off = _hasToken(payload) ? 113 : 81;
        return _decodeUint64LE(payload, off);
    }

    function _decodeVault(
        bytes memory payload
    ) internal pure returns (bytes32 result) {
        // Vault starts after expiration.
        uint256 off = (_hasToken(payload) ? 121 : 89) + 32;
        // Pull 32 bytes ending at `off` (i.e. starting at off-32).
        assembly {
            result := mload(add(add(payload, 0x20), sub(off, 32)))
        }
    }
}

contract SolanaVmPayloadBuilderConfigKeysTest is SolanaVmPayloadBuilderBase {
    function test_derivesNamespacedDomainKey() public view {
        bytes32 key = payloadBuilder.getDomainKey(CHAIN_ID);
        bytes32 expected = keccak256(
            abi.encodePacked(keccak256("SOLANA_VM_DOMAIN"), CHAIN_ID)
        );
        assertEq(key, expected);
    }

    function test_derivesNamespacedVaultAddressKey() public view {
        bytes32 key = payloadBuilder.getVaultAddressKey(CHAIN_ID);
        bytes32 expected = keccak256(
            abi.encodePacked(keccak256("SOLANA_VM_VAULT_ADDRESS"), CHAIN_ID)
        );
        assertEq(key, expected);
    }

    function test_derivesNamespacedExpirationKey() public view {
        assertEq(
            payloadBuilder.getExpirationKey(),
            keccak256("SOLANA_VM_EXPIRATION")
        );
    }
}

contract SolanaVmPayloadBuilderBuildPayloadTest is SolanaVmPayloadBuilderBase {
    function test_rejectsUnconfiguredChainId() public {
        BuildPayloadParams memory params = BuildPayloadParams({
            currency: "",
            amount: 100000000,
            receiver: abi.encodePacked(VAULT_PUBKEY),
            nonce: 0,
            data: ""
        });

        vm.expectRevert(
            abi.encodeWithSelector(
                Config.ConfigValueNotSet.selector,
                payloadBuilder.getDomainKey("missing-chain")
            )
        );
        payloadBuilder.buildPayload("missing-chain", _depositoryBytes(), params);
    }

    function test_buildsPayloadWhenUsingSol() public {
        uint256 blockNumber = block.number;
        uint256 nowTs = block.timestamp;

        BuildPayloadParams memory params = BuildPayloadParams({
            currency: "",
            amount: 100000000,
            receiver: abi.encodePacked(VAULT_PUBKEY),
            nonce: 1749095710252,
            data: ""
        });
        bytes memory payload = payloadBuilder.buildPayload(
            CHAIN_ID,
            _depositoryBytes(),
            params
        );

        assertEq(_decodeDomain(payload), DOMAIN);
        assertEq(_decodeRecipient(payload), VAULT_PUBKEY);
        assertFalse(_hasToken(payload));
        assertEq(_decodeAmount(payload), uint64(100000000));

        uint64 expectedNonce = _expectedNonce(
            blockNumber,
            1749095710252,
            "",
            abi.encodePacked(VAULT_PUBKEY),
            "",
            100000000
        );
        assertEq(_decodeNonce(payload), expectedNonce);

        uint64 expiration = _decodeExpiration(payload);
        assertGe(
            uint256(expiration),
            nowTs + EXPIRATION_DELAY_SECONDS - EXPIRATION_TOLERANCE_SECONDS
        );
        assertLe(
            uint256(expiration),
            nowTs + EXPIRATION_DELAY_SECONDS + EXPIRATION_TOLERANCE_SECONDS
        );
        assertEq(_decodeVault(payload), VAULT_PUBKEY);
    }

    function test_buildsPayloadWhenUsingSplToken() public {
        uint256 blockNumber = block.number;
        uint256 nowTs = block.timestamp;

        BuildPayloadParams memory params = BuildPayloadParams({
            currency: abi.encodePacked(TOKEN_PUBKEY),
            amount: 100000000,
            receiver: abi.encodePacked(RECIPIENT_PUBKEY_A),
            nonce: 1749095749158,
            data: ""
        });
        bytes memory payload = payloadBuilder.buildPayload(
            CHAIN_ID,
            _depositoryBytes(),
            params
        );

        assertEq(_decodeDomain(payload), DOMAIN);
        assertEq(_decodeRecipient(payload), RECIPIENT_PUBKEY_A);
        assertTrue(_hasToken(payload));
        assertEq(_decodeToken(payload), TOKEN_PUBKEY);
        assertEq(_decodeAmount(payload), uint64(100000000));

        uint64 expectedNonce = _expectedNonce(
            blockNumber,
            1749095749158,
            abi.encodePacked(TOKEN_PUBKEY),
            abi.encodePacked(RECIPIENT_PUBKEY_A),
            "",
            100000000
        );
        assertEq(_decodeNonce(payload), expectedNonce);

        uint64 expiration = _decodeExpiration(payload);
        assertGe(
            uint256(expiration),
            nowTs + EXPIRATION_DELAY_SECONDS - EXPIRATION_TOLERANCE_SECONDS
        );
        assertLe(
            uint256(expiration),
            nowTs + EXPIRATION_DELAY_SECONDS + EXPIRATION_TOLERANCE_SECONDS
        );
        assertEq(_decodeVault(payload), VAULT_PUBKEY);
    }

    function test_usesConfiguredExpirationDelayWhenMetadataIsOmitted() public {
        uint256 nowTs = block.timestamp;
        BuildPayloadParams memory params = BuildPayloadParams({
            currency: "",
            amount: 1,
            receiver: abi.encodePacked(VAULT_PUBKEY),
            nonce: 9,
            data: ""
        });
        bytes memory payload = payloadBuilder.buildPayload(
            CHAIN_ID,
            _depositoryBytes(),
            params
        );
        uint64 expiration = _decodeExpiration(payload);
        assertGe(
            uint256(expiration),
            nowTs + EXPIRATION_DELAY_SECONDS - EXPIRATION_TOLERANCE_SECONDS
        );
        assertLe(
            uint256(expiration),
            nowTs + EXPIRATION_DELAY_SECONDS + EXPIRATION_TOLERANCE_SECONDS
        );
    }

    function test_rejectsReceiverWithInvalidEncodedLength() public {
        BuildPayloadParams memory params = BuildPayloadParams({
            currency: "",
            amount: 1,
            receiver: hex"1234",
            nonce: 0,
            data: ""
        });
        vm.expectRevert(
            abi.encodeWithSelector(
                SolanaVmPayloadBuilder.InvalidAddressLength.selector,
                uint256(2),
                uint256(32)
            )
        );
        payloadBuilder.buildPayload(CHAIN_ID, _depositoryBytes(), params);
    }

    function test_rejectsTokenWithInvalidEncodedLength() public {
        BuildPayloadParams memory params = BuildPayloadParams({
            currency: hex"1234",
            amount: 1,
            receiver: abi.encodePacked(VAULT_PUBKEY),
            nonce: 0,
            data: ""
        });
        vm.expectRevert(
            abi.encodeWithSelector(
                SolanaVmPayloadBuilder.InvalidAddressLength.selector,
                uint256(2),
                uint256(32)
            )
        );
        payloadBuilder.buildPayload(CHAIN_ID, _depositoryBytes(), params);
    }
}

contract SolanaVmPayloadBuilderHashesToSignTest is SolanaVmPayloadBuilderBase {
    function test_hashesPayloadCorrectlyUsingSha256() public {
        BuildPayloadParams memory params = BuildPayloadParams({
            currency: "",
            amount: 100000000,
            receiver: abi.encodePacked(VAULT_PUBKEY),
            nonce: 1749095710252,
            data: ""
        });
        bytes memory payload = payloadBuilder.buildPayload(
            CHAIN_ID,
            _depositoryBytes(),
            params
        );
        bytes32[] memory hashes = payloadBuilder.hashesToSign(
            CHAIN_ID,
            _depositoryBytes(),
            payload
        );
        assertEq(hashes.length, 1);
        assertEq(hashes[0], sha256(payload));
    }
}

contract SolanaVmPayloadBuilderPayloadDecodingTest is
    SolanaVmPayloadBuilderBase
{
    function test_decodesNativeSolTransferRequest() public {
        uint256 blockNumber = block.number;
        uint256 nowTs = block.timestamp;
        uint256 nonceInput = 1749095710252;

        BuildPayloadParams memory params = BuildPayloadParams({
            currency: "",
            amount: 1,
            receiver: abi.encodePacked(RECIPIENT_PUBKEY_B),
            nonce: nonceInput,
            data: ""
        });
        bytes memory payload = payloadBuilder.buildPayload(
            CHAIN_ID,
            _depositoryBytes(),
            params
        );

        assertEq(_decodeDomain(payload), DOMAIN);
        assertEq(_decodeRecipient(payload), RECIPIENT_PUBKEY_B);
        assertFalse(_hasToken(payload));
        assertEq(_decodeAmount(payload), uint64(1));

        uint64 expectedNonce = _expectedNonce(
            blockNumber,
            nonceInput,
            "",
            abi.encodePacked(RECIPIENT_PUBKEY_B),
            "",
            1
        );
        assertEq(_decodeNonce(payload), expectedNonce);

        uint64 expiration = _decodeExpiration(payload);
        assertGe(
            uint256(expiration),
            nowTs + EXPIRATION_DELAY_SECONDS - EXPIRATION_TOLERANCE_SECONDS
        );
        assertLe(
            uint256(expiration),
            nowTs + EXPIRATION_DELAY_SECONDS + EXPIRATION_TOLERANCE_SECONDS
        );
        assertEq(_decodeVault(payload), VAULT_PUBKEY);
    }

    function test_decodesSplTokenTransferRequest() public {
        uint256 blockNumber = block.number;
        uint256 nowTs = block.timestamp;
        uint256 nonceInput = 1749095710252;

        BuildPayloadParams memory params = BuildPayloadParams({
            currency: abi.encodePacked(TOKEN_PUBKEY),
            amount: 1,
            receiver: abi.encodePacked(RECIPIENT_PUBKEY_B),
            nonce: nonceInput,
            data: ""
        });
        bytes memory payload = payloadBuilder.buildPayload(
            CHAIN_ID,
            _depositoryBytes(),
            params
        );

        assertEq(_decodeDomain(payload), DOMAIN);
        assertEq(_decodeRecipient(payload), RECIPIENT_PUBKEY_B);
        assertTrue(_hasToken(payload));
        assertEq(_decodeToken(payload), TOKEN_PUBKEY);
        assertEq(_decodeAmount(payload), uint64(1));

        uint64 expectedNonce = _expectedNonce(
            blockNumber,
            nonceInput,
            abi.encodePacked(TOKEN_PUBKEY),
            abi.encodePacked(RECIPIENT_PUBKEY_B),
            "",
            1
        );
        assertEq(_decodeNonce(payload), expectedNonce);

        uint64 expiration = _decodeExpiration(payload);
        assertGe(
            uint256(expiration),
            nowTs + EXPIRATION_DELAY_SECONDS - EXPIRATION_TOLERANCE_SECONDS
        );
        assertLe(
            uint256(expiration),
            nowTs + EXPIRATION_DELAY_SECONDS + EXPIRATION_TOLERANCE_SECONDS
        );
        assertEq(_decodeVault(payload), VAULT_PUBKEY);
    }
}

contract SolanaVmPayloadBuilderMetadataTest is SolanaVmPayloadBuilderBase {
    function test_returnsExpectedCurve() public view {
        assertEq(payloadBuilder.curve(), "Eddsa");
    }

    function test_returnsExpectedFamily() public view {
        assertEq(payloadBuilder.family(), "solana-vm");
    }
}
