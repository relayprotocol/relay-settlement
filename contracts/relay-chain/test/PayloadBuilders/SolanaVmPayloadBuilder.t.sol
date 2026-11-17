// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {buildPayloadOnly} from "../utils/Payload.sol";

import {BaseTest} from "../utils/BaseTest.sol";
import {Config} from "../../contracts/Config.sol";
import {
  RelayAllocator,
  WithdrawRequest
} from "../../contracts/RelayAllocator.sol";
import {RelayHub} from "../../contracts/RelayHub.sol";
import {
  SolanaVmPayloadBuilder,
  SolanaRoutedWithdrawalData
} from "../../contracts/payload-builders/SolanaVmPayloadBuilder.sol";

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
  bytes32 internal constant NATIVE_SOL = bytes32(0); // 11111111111111111111111111111111

  address internal depositoryAddr;

  RelayHub internal hub;
  RelayAllocator internal allocator;
  Config internal config;
  SolanaVmPayloadBuilder internal payloadBuilder;

  function setUp() public virtual override {
    super.setUp();
    depositoryAddr = otherAccounts[0];

    hub = new RelayHub(owner);
    allocator = new RelayAllocator(owner, address(hub), address(0xbeef));
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
    WithdrawRequest memory request
  ) internal pure returns (uint64) {
    return uint64(uint256(keccak256(abi.encode(blockNumber, request))));
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

  function _hasToken(bytes memory payload) internal pure returns (bool) {
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

  function _decodeAmount(bytes memory payload) internal pure returns (uint64) {
    uint256 off = _hasToken(payload) ? 97 : 65;
    return _decodeUint64LE(payload, off);
  }

  function _decodeNonce(bytes memory payload) internal pure returns (uint64) {
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
    WithdrawRequest memory params = WithdrawRequest({
      chainId: "missing-chain",
      depository: _depositoryBytes(),
      currency: abi.encodePacked(NATIVE_SOL),
      amount: 100000000,
      spenderChainId: "relay",
      spender: abi.encodePacked(address(1)),
      receiver: abi.encodePacked(VAULT_PUBKEY),
      data: "",
      nonce: bytes32(uint256(0))
    });

    vm.expectRevert(
      abi.encodeWithSelector(
        Config.ConfigValueNotSet.selector,
        payloadBuilder.getDomainKey("missing-chain")
      )
    );
    buildPayloadOnly(
      payloadBuilder,
      "missing-chain",
      _depositoryBytes(),
      params
    );
  }

  function test_buildsPayloadWhenUsingSol() public {
    uint256 blockNumber = block.number;
    uint256 nowTs = block.timestamp;

    WithdrawRequest memory params = WithdrawRequest({
      chainId: CHAIN_ID,
      depository: _depositoryBytes(),
      currency: abi.encodePacked(NATIVE_SOL),
      amount: 100000000,
      spenderChainId: "relay",
      spender: abi.encodePacked(address(1)),
      receiver: abi.encodePacked(VAULT_PUBKEY),
      data: "",
      nonce: bytes32(uint256(1749095710252))
    });
    bytes memory payload = buildPayloadOnly(
      payloadBuilder,
      CHAIN_ID,
      _depositoryBytes(),
      params
    );

    assertEq(_decodeDomain(payload), DOMAIN);
    assertEq(_decodeRecipient(payload), VAULT_PUBKEY);
    assertFalse(_hasToken(payload));
    assertEq(_decodeAmount(payload), uint64(100000000));

    uint64 expectedNonce = _expectedNonce(blockNumber, params);
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

    WithdrawRequest memory params = WithdrawRequest({
      chainId: CHAIN_ID,
      depository: _depositoryBytes(),
      currency: abi.encodePacked(TOKEN_PUBKEY),
      amount: 100000000,
      spenderChainId: "relay",
      spender: abi.encodePacked(address(1)),
      receiver: abi.encodePacked(RECIPIENT_PUBKEY_A),
      data: "",
      nonce: bytes32(uint256(1749095749158))
    });
    bytes memory payload = buildPayloadOnly(
      payloadBuilder,
      CHAIN_ID,
      _depositoryBytes(),
      params
    );

    assertEq(_decodeDomain(payload), DOMAIN);
    assertEq(_decodeRecipient(payload), RECIPIENT_PUBKEY_A);
    assertTrue(_hasToken(payload));
    assertEq(_decodeToken(payload), TOKEN_PUBKEY);
    assertEq(_decodeAmount(payload), uint64(100000000));

    uint64 expectedNonce = _expectedNonce(blockNumber, params);
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
    WithdrawRequest memory params = WithdrawRequest({
      chainId: CHAIN_ID,
      depository: _depositoryBytes(),
      currency: abi.encodePacked(NATIVE_SOL),
      amount: 1,
      spenderChainId: "relay",
      spender: abi.encodePacked(address(1)),
      receiver: abi.encodePacked(VAULT_PUBKEY),
      data: "",
      nonce: bytes32(uint256(9))
    });
    bytes memory payload = buildPayloadOnly(
      payloadBuilder,
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
    WithdrawRequest memory params = WithdrawRequest({
      chainId: CHAIN_ID,
      depository: _depositoryBytes(),
      currency: abi.encodePacked(NATIVE_SOL),
      amount: 1,
      spenderChainId: "relay",
      spender: abi.encodePacked(address(1)),
      receiver: hex"1234",
      data: "",
      nonce: bytes32(uint256(0))
    });
    vm.expectRevert(
      abi.encodeWithSelector(
        SolanaVmPayloadBuilder.InvalidAddressLength.selector,
        uint256(2),
        uint256(32)
      )
    );
    buildPayloadOnly(payloadBuilder, CHAIN_ID, _depositoryBytes(), params);
  }

  function test_rejectsEmptyCurrency() public {
    WithdrawRequest memory params = WithdrawRequest({
      chainId: CHAIN_ID,
      depository: _depositoryBytes(),
      currency: "",
      amount: 1,
      spenderChainId: "relay",
      spender: abi.encodePacked(address(1)),
      receiver: abi.encodePacked(VAULT_PUBKEY),
      data: "",
      nonce: bytes32(uint256(0))
    });
    vm.expectRevert(
      abi.encodeWithSelector(
        SolanaVmPayloadBuilder.InvalidAddressLength.selector,
        uint256(0),
        uint256(32)
      )
    );
    payloadBuilder.buildPayload(CHAIN_ID, _depositoryBytes(), params);
  }

  function test_rejectsTokenWithInvalidEncodedLength() public {
    WithdrawRequest memory params = WithdrawRequest({
      chainId: CHAIN_ID,
      depository: _depositoryBytes(),
      currency: hex"1234",
      amount: 1,
      spenderChainId: "relay",
      spender: abi.encodePacked(address(1)),
      receiver: abi.encodePacked(VAULT_PUBKEY),
      data: "",
      nonce: bytes32(uint256(0))
    });
    vm.expectRevert(
      abi.encodeWithSelector(
        SolanaVmPayloadBuilder.InvalidAddressLength.selector,
        uint256(2),
        uint256(32)
      )
    );
    buildPayloadOnly(payloadBuilder, CHAIN_ID, _depositoryBytes(), params);
  }
}

contract SolanaVmPayloadBuilderHashesToSignTest is SolanaVmPayloadBuilderBase {
  function test_hashesPayloadCorrectlyUsingSha256() public {
    WithdrawRequest memory params = WithdrawRequest({
      chainId: CHAIN_ID,
      depository: _depositoryBytes(),
      currency: abi.encodePacked(NATIVE_SOL),
      amount: 100000000,
      spenderChainId: "relay",
      spender: abi.encodePacked(address(1)),
      receiver: abi.encodePacked(VAULT_PUBKEY),
      data: "",
      nonce: bytes32(uint256(1749095710252))
    });
    bytes memory payload = buildPayloadOnly(
      payloadBuilder,
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

    WithdrawRequest memory params = WithdrawRequest({
      chainId: CHAIN_ID,
      depository: _depositoryBytes(),
      currency: abi.encodePacked(NATIVE_SOL),
      amount: 1,
      spenderChainId: "relay",
      spender: abi.encodePacked(address(1)),
      receiver: abi.encodePacked(RECIPIENT_PUBKEY_B),
      data: "",
      nonce: bytes32(uint256(nonceInput))
    });
    bytes memory payload = buildPayloadOnly(
      payloadBuilder,
      CHAIN_ID,
      _depositoryBytes(),
      params
    );

    assertEq(_decodeDomain(payload), DOMAIN);
    assertEq(_decodeRecipient(payload), RECIPIENT_PUBKEY_B);
    assertFalse(_hasToken(payload));
    assertEq(_decodeAmount(payload), uint64(1));

    uint64 expectedNonce = _expectedNonce(blockNumber, params);
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

    WithdrawRequest memory params = WithdrawRequest({
      chainId: CHAIN_ID,
      depository: _depositoryBytes(),
      currency: abi.encodePacked(TOKEN_PUBKEY),
      amount: 1,
      spenderChainId: "relay",
      spender: abi.encodePacked(address(1)),
      receiver: abi.encodePacked(RECIPIENT_PUBKEY_B),
      data: "",
      nonce: bytes32(uint256(nonceInput))
    });
    bytes memory payload = buildPayloadOnly(
      payloadBuilder,
      CHAIN_ID,
      _depositoryBytes(),
      params
    );

    assertEq(_decodeDomain(payload), DOMAIN);
    assertEq(_decodeRecipient(payload), RECIPIENT_PUBKEY_B);
    assertTrue(_hasToken(payload));
    assertEq(_decodeToken(payload), TOKEN_PUBKEY);
    assertEq(_decodeAmount(payload), uint64(1));

    uint64 expectedNonce = _expectedNonce(blockNumber, params);
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

/// @notice The Solana request nonce commits to the whole withdraw request
contract SolanaVmPayloadBuilderRequestHashTest is SolanaVmPayloadBuilderBase {
  function _nonce(address spender) internal view returns (uint64) {
    WithdrawRequest memory params = WithdrawRequest({
      chainId: CHAIN_ID,
      depository: _depositoryBytes(),
      currency: abi.encodePacked(NATIVE_SOL),
      amount: 100000000,
      spenderChainId: "relay",
      spender: abi.encodePacked(spender),
      receiver: abi.encodePacked(VAULT_PUBKEY),
      data: "",
      nonce: bytes32(uint256(0))
    });
    return
      _decodeNonce(
        buildPayloadOnly(payloadBuilder, CHAIN_ID, _depositoryBytes(), params)
      );
  }

  function test_derivesDifferentNoncePerRequest() public view {
    assertTrue(_nonce(address(1)) != _nonce(address(2)));
  }
}

/// @notice Pins plain request bytes, so routed mode cannot change the empty-data path
contract SolanaVmPayloadBuilderPlainVectorTest is SolanaVmPayloadBuilderBase {
  bytes32 internal constant DEPOSITORY_PUBKEY =
    0x792689378ecd51d80406eb0caa3b62795beb10b6c5dc96bc2e0df03cbfee1abf; // 99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2

  function test_plainPayloadMatchesFixedVector() public {
    vm.roll(100);
    vm.warp(1_700_000_000);

    WithdrawRequest memory params = WithdrawRequest({
      chainId: CHAIN_ID,
      depository: abi.encodePacked(DEPOSITORY_PUBKEY),
      currency: abi.encodePacked(NATIVE_SOL),
      amount: 1_000_000,
      spenderChainId: "relay",
      spender: abi.encodePacked(address(1)),
      receiver: abi.encodePacked(RECIPIENT_PUBKEY_A),
      data: "",
      nonce: bytes32(uint256(1))
    });
    bytes memory payload = buildPayloadOnly(
      payloadBuilder,
      CHAIN_ID,
      abi.encodePacked(DEPOSITORY_PUBKEY),
      params
    );

    assertEq(
      payload,
      hex"5fe7f977e71dba2ea1a68e21057beebb9be2ac30c6410aa38d4f3fbe41dcffd2d354d13253ad4f7764f5c933ccadca795c052d143e2721ff5716848f1fe390cc0040420f000000000006a1b7263d2ad1582cf25365000000001fa427265aebc381e466efb16f55b95fc3d44af745a3c52f6c599d3a7ec6b19a"
    );
    assertEq(
      sha256(payload),
      0x23248679b1b5788059e8a403f783cee104a5b1775d21958f89bdf970863a436d
    );
  }
}

contract SolanaVmPayloadBuilderRoutedTest is SolanaVmPayloadBuilderBase {
  bytes32 internal constant DEPOSITORY_PUBKEY =
    0x792689378ecd51d80406eb0caa3b62795beb10b6c5dc96bc2e0df03cbfee1abf; // 99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2
  bytes32 internal constant ROUTER_PUBKEY =
    0x7d01d9c59e2296807ea0d4df99ccf825c028060cba6aa00c2ab482dad32161be; // 9QybjuydfDYwJkdDLMJJaHEcQPaYeRoiJ5cYj7qLd5Su
  bytes32 internal constant EXECUTOR_PUBKEY =
    0xd1c24bcb2cf2f78791a8e63d2e528be4e923944900af6d8826f0063e91d1515f; // F7p3dFrjRTbtRp8FRF6qHLomXbKRBzpvBLjtQcfcgmNe

  function setUp() public virtual override {
    super.setUp();
    _setRouterAllowed(ROUTER_PUBKEY, bytes32(uint256(1)));
  }

  function _setRouterAllowed(bytes32 router, bytes32 value) internal {
    bytes32 allowedKey = payloadBuilder.getRouterAllowedKey(
      CHAIN_ID,
      DEPOSITORY_PUBKEY,
      router
    );
    vm.prank(owner);
    config.setConfigValue(allowedKey, value);
  }

  function _routedData(
    uint8 version,
    bytes32 router,
    bytes32 executor
  ) internal pure returns (bytes memory) {
    return
      abi.encode(
        SolanaRoutedWithdrawalData({
          version: version,
          router: router,
          executor: executor
        })
      );
  }

  function _routedParams(
    bytes32 currency,
    bytes memory data
  ) internal pure returns (WithdrawRequest memory params) {
    params = WithdrawRequest({
      chainId: CHAIN_ID,
      depository: abi.encodePacked(DEPOSITORY_PUBKEY),
      currency: abi.encodePacked(currency),
      amount: 1_000_000,
      spenderChainId: "relay",
      spender: abi.encodePacked(address(1)),
      receiver: abi.encodePacked(RECIPIENT_PUBKEY_A),
      data: data,
      nonce: bytes32(uint256(1))
    });
  }

  function _build(
    WithdrawRequest memory params
  ) internal view returns (bytes memory) {
    return
      buildPayloadOnly(
        payloadBuilder,
        CHAIN_ID,
        abi.encodePacked(DEPOSITORY_PUBKEY),
        params
      );
  }

  function test_routedPayloadMatchesFixedVectorForSplToken() public {
    vm.roll(100);
    vm.warp(1_700_000_000);

    WithdrawRequest memory params = _routedParams(
      TOKEN_PUBKEY,
      _routedData(1, ROUTER_PUBKEY, EXECUTOR_PUBKEY)
    );
    bytes memory payload = _build(params);

    // Field by field: prefix, domain, recipient, Some(token), amount, nonce, expiration, vault, router
    bytes memory expected = bytes.concat(
      "RelayDepository:RoutedTransferRequest:v1",
      DOMAIN,
      RECIPIENT_PUBKEY_A,
      hex"01",
      TOKEN_PUBKEY,
      hex"40420f0000000000",
      hex"480f5aeee00edfc2",
      hex"2cf2536500000000",
      VAULT_PUBKEY,
      ROUTER_PUBKEY
    );
    assertEq(_expectedNonce(100, params), 14041958522398838600);
    assertEq(payload, expected);
    assertEq(
      payload,
      hex"52656c61794465706f7369746f72793a526f757465645472616e73666572526571756573743a76315fe7f977e71dba2ea1a68e21057beebb9be2ac30c6410aa38d4f3fbe41dcffd2d354d13253ad4f7764f5c933ccadca795c052d143e2721ff5716848f1fe390cc01471500e6828e391e3b31326faa896e01212f976de1ad90ecb7823a2b96e9eb8540420f0000000000480f5aeee00edfc22cf25365000000001fa427265aebc381e466efb16f55b95fc3d44af745a3c52f6c599d3a7ec6b19a7d01d9c59e2296807ea0d4df99ccf825c028060cba6aa00c2ab482dad32161be"
    );

    bytes32[] memory hashes = payloadBuilder.hashesToSign(
      CHAIN_ID,
      abi.encodePacked(DEPOSITORY_PUBKEY),
      payload
    );
    assertEq(hashes.length, 1);
    assertEq(
      hashes[0],
      0xbaac8f151b7e4a8db284ac7c47affad9d7dcd8c8df0f6235b80dbe0e2ca887a3
    );
  }

  function test_routedPayloadMatchesFixedVectorForNativeSol() public {
    vm.roll(100);
    vm.warp(1_700_000_000);

    WithdrawRequest memory params = _routedParams(
      NATIVE_SOL,
      _routedData(1, ROUTER_PUBKEY, EXECUTOR_PUBKEY)
    );
    bytes memory payload = _build(params);

    bytes memory expected = bytes.concat(
      "RelayDepository:RoutedTransferRequest:v1",
      DOMAIN,
      RECIPIENT_PUBKEY_A,
      hex"00",
      hex"40420f0000000000",
      hex"90d850787ee02604",
      hex"2cf2536500000000",
      VAULT_PUBKEY,
      ROUTER_PUBKEY
    );
    assertEq(_expectedNonce(100, params), 299173259055782032);
    assertEq(payload, expected);

    bytes32[] memory hashes = payloadBuilder.hashesToSign(
      CHAIN_ID,
      abi.encodePacked(DEPOSITORY_PUBKEY),
      payload
    );
    assertEq(
      hashes[0],
      0xb97661047d558f820d0c88b7a66c2c40d8d4adb3dd50aca6584a878b902eea67
    );
  }

  function test_routedNonceCommitsToExecutor() public view {
    // The executor is not in the payload, so the nonce is what binds it to the signed request
    bytes memory payloadA = _build(
      _routedParams(NATIVE_SOL, _routedData(1, ROUTER_PUBKEY, EXECUTOR_PUBKEY))
    );
    bytes memory payloadB = _build(
      _routedParams(NATIVE_SOL, _routedData(1, ROUTER_PUBKEY, bytes32(0)))
    );
    assertTrue(keccak256(payloadA) != keccak256(payloadB));
  }

  function test_routedAllowsTwoRoutersAtOnce() public {
    bytes32 secondRouter = keccak256("second-router");
    _setRouterAllowed(secondRouter, bytes32(uint256(1)));

    bytes memory payloadA = _build(
      _routedParams(NATIVE_SOL, _routedData(1, ROUTER_PUBKEY, EXECUTOR_PUBKEY))
    );
    bytes memory payloadB = _build(
      _routedParams(NATIVE_SOL, _routedData(1, secondRouter, EXECUTOR_PUBKEY))
    );

    assertEq(_lastWord(payloadA), ROUTER_PUBKEY);
    assertEq(_lastWord(payloadB), secondRouter);
  }

  function _lastWord(
    bytes memory payload
  ) internal pure returns (bytes32 result) {
    assembly {
      result := mload(add(payload, mload(payload)))
    }
  }

  function test_routedRevertsWhenVersionUnsupported() public {
    vm.expectRevert(
      abi.encodeWithSelector(
        SolanaVmPayloadBuilder.UnsupportedRoutedDataVersion.selector,
        uint8(2)
      )
    );
    _build(
      _routedParams(NATIVE_SOL, _routedData(2, ROUTER_PUBKEY, EXECUTOR_PUBKEY))
    );
  }

  function test_routedRevertsWhenVersionIsZero() public {
    vm.expectRevert(
      abi.encodeWithSelector(
        SolanaVmPayloadBuilder.UnsupportedRoutedDataVersion.selector,
        uint8(0)
      )
    );
    _build(
      _routedParams(NATIVE_SOL, _routedData(0, ROUTER_PUBKEY, EXECUTOR_PUBKEY))
    );
  }

  function test_routedRevertsWhenDataIsMalformed() public {
    vm.expectRevert();
    _build(_routedParams(NATIVE_SOL, hex"deadbeef"));
  }

  function test_routedRevertsWhenRouterNotAllowlisted() public {
    bytes32 unknownRouter = keccak256("unknown-router");

    // An unset allowlist key fails closed inside Config
    vm.expectRevert(
      abi.encodeWithSelector(
        Config.ConfigValueNotSet.selector,
        payloadBuilder.getRouterAllowedKey(
          CHAIN_ID,
          DEPOSITORY_PUBKEY,
          unknownRouter
        )
      )
    );
    _build(
      _routedParams(NATIVE_SOL, _routedData(1, unknownRouter, EXECUTOR_PUBKEY))
    );
  }

  function test_routedRevertsWhenRouterDisabled() public {
    _setRouterAllowed(ROUTER_PUBKEY, bytes32(0));

    vm.expectRevert(
      abi.encodeWithSelector(
        SolanaVmPayloadBuilder.RouterNotAllowed.selector,
        ROUTER_PUBKEY
      )
    );
    _build(
      _routedParams(NATIVE_SOL, _routedData(1, ROUTER_PUBKEY, EXECUTOR_PUBKEY))
    );
  }

  function test_routedRevertsWhenAllowlistValueIsNotOne() public {
    _setRouterAllowed(ROUTER_PUBKEY, bytes32(uint256(2)));

    vm.expectRevert(
      abi.encodeWithSelector(
        SolanaVmPayloadBuilder.RouterNotAllowed.selector,
        ROUTER_PUBKEY
      )
    );
    _build(
      _routedParams(NATIVE_SOL, _routedData(1, ROUTER_PUBKEY, EXECUTOR_PUBKEY))
    );
  }

  function test_routedRevertsWhenRouterAllowedForDifferentDepository() public {
    bytes32 wrongDepository = keccak256("other-depository");

    vm.expectRevert(
      abi.encodeWithSelector(
        Config.ConfigValueNotSet.selector,
        payloadBuilder.getRouterAllowedKey(
          CHAIN_ID,
          wrongDepository,
          ROUTER_PUBKEY
        )
      )
    );
    buildPayloadOnly(
      payloadBuilder,
      CHAIN_ID,
      abi.encodePacked(wrongDepository),
      _routedParams(NATIVE_SOL, _routedData(1, ROUTER_PUBKEY, EXECUTOR_PUBKEY))
    );
  }

  function test_routedRevertsWhenDepositoryIsNot32Bytes() public {
    vm.expectRevert(
      abi.encodeWithSelector(
        SolanaVmPayloadBuilder.InvalidAddressLength.selector,
        uint256(20),
        uint256(32)
      )
    );
    buildPayloadOnly(
      payloadBuilder,
      CHAIN_ID,
      _depositoryBytes(),
      _routedParams(NATIVE_SOL, _routedData(1, ROUTER_PUBKEY, EXECUTOR_PUBKEY))
    );
  }

  function test_namespacesConfigKeyForRouterAllowlist() public view {
    bytes32 key = payloadBuilder.getRouterAllowedKey(
      CHAIN_ID,
      DEPOSITORY_PUBKEY,
      ROUTER_PUBKEY
    );
    bytes32 expected = keccak256(
      abi.encode(
        keccak256("SOLANA_VM_ROUTER_ALLOWED"),
        keccak256(bytes(CHAIN_ID)),
        DEPOSITORY_PUBKEY,
        ROUTER_PUBKEY
      )
    );
    assertEq(key, expected);
  }
}
