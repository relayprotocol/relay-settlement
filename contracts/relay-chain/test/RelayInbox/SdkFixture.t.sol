// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {RelayHub} from "../../contracts/RelayHub.sol";
import {RelayInboxIdempotencyStore} from "../../contracts/RelayInboxIdempotencyStore.sol";
import {RelayInbox} from "../../contracts/RelayInbox.sol";
import {BaseTest} from "../utils/BaseTest.sol";
import {Eip712} from "../utils/Eip712.sol";

/// @notice Pins the digest produced by the SDK v2.4 oracle execution helper
/// (packages/sdk/test/oracle-execution-v2.4.test.ts); drift means the SDK and
/// the contract disagree on what the oracle signs.
contract RelayInboxSdkFixtureTest is BaseTest {
  address internal constant FIXTURE_ORACLE =
    0x4242424242424242424242424242424242424242;
  address internal constant FIXTURE_HUB_TO =
    0x1111111111111111111111111111111111111111;
  bytes32 internal constant FIXTURE_KEY =
    0xabababababababababababababababababababababababababababababababab;
  uint256 internal constant FIXTURE_EXPIRATION = 1_900_000_000;

  bytes32 internal constant SDK_EXECUTION_HASH =
    0xda5f83f243973373bf600d68b6f310c8870533adfa2b0c486b282b908a4b62cd;

  bytes32 internal constant SDK_MULTI_ACTION_HASH =
    0x4ceb8673aee13f255fa87bff6a204e751cb740af6b56e4fdaf37b457d2ded156;
  bytes32 internal constant SDK_EMPTY_ACTIONS_HASH =
    0xe4adf8f321128aaa4746855d7ba38c5d8bb9bd74518e6767af49f41763c18a52;

  bytes32 internal constant EXECUTION_TYPEHASH =
    keccak256(
      "Execution(bytes32 idempotencyKey,bytes[] actions,uint256 expiration)"
    );

  RelayHub internal hub;
  RelayInboxIdempotencyStore internal idempotencyStore;
  RelayInbox internal v2;
  address internal oracleSigner;
  uint256 internal oracleSignerPk;

  function setUp() public override {
    super.setUp();
    assertEq(block.chainid, 31337);
    (oracleSigner, oracleSignerPk) = makeAddrAndKey("oracleSigner");

    hub = new RelayHub(owner);
    idempotencyStore = new RelayInboxIdempotencyStore(owner);
    // Same contract at the SDK fixture address
    deployCodeTo(
      "RelayInbox.sol:RelayInbox",
      abi.encode(owner, address(hub), address(idempotencyStore)),
      FIXTURE_ORACLE
    );
    v2 = RelayInbox(FIXTURE_ORACLE);

    vm.startPrank(owner);
    hub.grantRole(hub.OPERATOR_ROLE(), address(v2));
    idempotencyStore.grantRole(idempotencyStore.WRITE_ROLE(), address(v2));
    v2.grantRole(v2.ORACLE_ROLE(), oracleSigner);
    vm.stopPrank();
  }

  function _actions() internal pure returns (bytes[] memory actions) {
    actions = new bytes[](1);
    actions[0] = abi.encode(
      uint8(RelayInbox.ActionType.MINT),
      FIXTURE_HUB_TO,
      uint256(1),
      uint256(1000)
    );
  }

  function _digest(bytes[] memory actions) internal view returns (bytes32) {
    bytes32[] memory actionHashes = new bytes32[](actions.length);
    for (uint256 i = 0; i < actions.length; i++) {
      actionHashes[i] = keccak256(actions[i]);
    }
    bytes32 structHash = keccak256(
      abi.encode(
        EXECUTION_TYPEHASH,
        FIXTURE_KEY,
        keccak256(abi.encodePacked(actionHashes)),
        FIXTURE_EXPIRATION
      )
    );
    bytes32 domain = Eip712.domainSeparator(
      "RelayInbox",
      "1",
      block.chainid,
      FIXTURE_ORACLE
    );
    return Eip712.digest(domain, structHash);
  }

  // Executes `actions` with an oracle signature over `sdkDigest`
  function _executeSigned(bytes[] memory actions, bytes32 sdkDigest) internal {
    (uint8 v, bytes32 r, bytes32 s) = vm.sign(oracleSignerPk, sdkDigest);
    v2.execute(
      RelayInbox.Execution({
        idempotencyKey: FIXTURE_KEY,
        actions: actions,
        expiration: FIXTURE_EXPIRATION
      }),
      oracleSigner,
      abi.encodePacked(r, s, v)
    );
    assertTrue(v2.isExecuted(FIXTURE_KEY));
  }

  function test_executionHashMatchesSdkFixture() public {
    bytes[] memory actions = _actions();
    assertEq(_digest(actions), SDK_EXECUTION_HASH);

    _executeSigned(actions, SDK_EXECUTION_HASH);
    assertEq(hub.balanceOf(FIXTURE_HUB_TO, 1), 1000);
  }

  function test_multiActionExecutionHashMatchesSdkFixture() public {
    bytes[] memory actions = new bytes[](2);
    actions[0] = _actions()[0];
    actions[1] = abi.encode(
      uint8(RelayInbox.ActionType.MINT),
      0x2222222222222222222222222222222222222222,
      uint256(2),
      uint256(5)
    );
    assertEq(_digest(actions), SDK_MULTI_ACTION_HASH);

    _executeSigned(actions, SDK_MULTI_ACTION_HASH);
    assertEq(hub.balanceOf(FIXTURE_HUB_TO, 1), 1000);
    assertEq(hub.balanceOf(0x2222222222222222222222222222222222222222, 2), 5);
  }

  function test_emptyExecutionHashMatchesSdkFixture() public {
    bytes[] memory actions = new bytes[](0);
    assertEq(_digest(actions), SDK_EMPTY_ACTIONS_HASH);

    _executeSigned(actions, SDK_EMPTY_ACTIONS_HASH);
  }
}
