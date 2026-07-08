// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../utils/BaseTest.sol";
import {Eip712} from "../utils/Eip712.sol";

import {RelayHub} from "../../contracts/RelayHub.sol";
import {RelayOracle} from "../../contracts/RelayOracle.sol";
import {RelayOracleV2} from "../../contracts/RelayOracleV2.sol";
import {RelayAmountRateLimiter} from "../../contracts/rate-limiters/RelayAmountRateLimiter.sol";
import {DeployRelayAmountRateLimiter} from "../../script/DeployRelayAmountRateLimiter.s.sol";
import {DeployRelayOracleV2} from "../../script/DeployRelayOracleV2.s.sol";

/// @notice End-to-end deploy + wiring integration: runs the Foundry deploy scripts for the limiter
///         and RelayOracleV2, applies the full on-chain wiring a fast deposit needs (RelayHub
///         OPERATOR_ROLE, ORACLE_ROLE, limiter CONSUMER_ROLE, addRateLimiter, setBucketConfig), then
///         drives a FAST_MINT through executeMultiple — both the happy path (split + bucket consume)
///         and the fail-closed path (zero amount → ExecutionFailed, nothing minted). This pins the
///         deploy scripts and the wiring sequence so the dev e2e doesn't discover them one at a time.
contract FastMintDeployIntegrationTest is BaseTest {
  RelayHub internal hub;
  RelayOracle internal oldOracle;
  RelayOracleV2 internal v2;
  RelayAmountRateLimiter internal limiter;

  address internal deployer;
  uint256 internal deployerPk;
  address internal oracleSigner;
  uint256 internal oracleSignerPk;
  address internal orderAddr;
  address internal feeRecipient;

  bytes32 internal v2Domain;

  bytes32 internal constant EXECUTION_TYPEHASH =
    keccak256("Execution(bytes32 idempotencyKey,bytes[] actions)");

  string internal constant CHAIN_ID = "8453";
  bytes internal constant CURRENCY =
    hex"833589fcd6edb6e08f4c7c32d4f71b54bda02913";

  function setUp() public override {
    super.setUp();
    vm.warp(1_700_000_000);

    (deployer, deployerPk) = makeAddrAndKey("deployer");
    (oracleSigner, oracleSignerPk) = makeAddrAndKey("oracleSigner");
    orderAddr = makeAddr("orderAddr");
    feeRecipient = makeAddr("feeRecipient");

    // Dependencies the scripts expect to already exist on-chain (admin = deployer so it can wire).
    hub = new RelayHub(deployer);
    oldOracle = new RelayOracle(deployer, address(hub));

    // Drive the actual Foundry deploy scripts (ADMIN unset → admin defaults to the deployer key).
    vm.setEnv("DEPLOYER_PRIVATE_KEY", vm.toString(deployerPk));
    vm.setEnv("HUB", vm.toString(address(hub)));
    vm.setEnv("OLD_ORACLE", vm.toString(address(oldOracle)));
    limiter = new DeployRelayAmountRateLimiter().run();
    v2 = new DeployRelayOracleV2().run();

    // The wiring checklist a fast deposit needs (all admin-gated; deployer holds every admin role).
    vm.startPrank(deployer);
    hub.grantRole(hub.OPERATOR_ROLE(), address(v2)); // V2 must mint on the hub
    v2.grantRole(v2.ORACLE_ROLE(), oracleSigner); // signer of the execution
    limiter.grantRole(limiter.CONSUMER_ROLE(), address(v2)); // V2 may consume budget
    v2.addRateLimiter(address(limiter));
    limiter.setBucketConfig(
      RelayAmountRateLimiter.BucketConfig({
        chainId: CHAIN_ID,
        currency: CURRENCY,
        isEnabled: true,
        capacity: type(uint128).max,
        rate: 0
      })
    );
    vm.stopPrank();

    v2Domain = Eip712.domainSeparator(
      "RelayOracle",
      "2",
      block.chainid,
      address(v2)
    );
  }

  // Helpers

  function _tokenId(
    string memory chainId,
    bytes memory currency
  ) internal pure returns (uint256) {
    return uint256(keccak256(abi.encodePacked(chainId, currency)));
  }

  function _fastMintAction(
    uint256 amount,
    uint256 feeBps,
    address recipient
  ) internal view returns (bytes memory) {
    return
      abi.encode(
        uint8(RelayOracleV2.ActionType.FAST_MINT),
        orderAddr,
        _tokenId(CHAIN_ID, CURRENCY),
        amount,
        feeBps,
        recipient,
        address(limiter),
        abi.encode(CHAIN_ID, CURRENCY, amount)
      );
  }

  function _exec(
    bytes32 key,
    bytes[] memory actions
  )
    internal
    view
    returns (RelayOracleV2.Execution[] memory execs, bytes[] memory sigs)
  {
    execs = new RelayOracleV2.Execution[](1);
    execs[0] = RelayOracleV2.Execution({idempotencyKey: key, actions: actions});

    bytes32[] memory actionHashes = new bytes32[](actions.length);
    for (uint256 i = 0; i < actions.length; i++) {
      actionHashes[i] = keccak256(actions[i]);
    }
    bytes32 structHash = keccak256(
      abi.encode(
        EXECUTION_TYPEHASH,
        key,
        keccak256(abi.encodePacked(actionHashes))
      )
    );
    sigs = new bytes[](1);
    sigs[0] = Eip712.sign(oracleSignerPk, v2Domain, structHash);
  }

  // Tests

  function test_deployWireFastMint_happyPath() public {
    uint256 tokenId = _tokenId(CHAIN_ID, CURRENCY);
    uint256 amount = 100e8; // 1% fee → 1 fee, 99 order input
    RelayAmountRateLimiter.TokenBucket memory before_ = limiter.getBucket(
      CHAIN_ID,
      CURRENCY
    );

    bytes[] memory actions = new bytes[](1);
    actions[0] = _fastMintAction(amount, 1e16, feeRecipient); // feeBps 1% = 1e16/1e18
    (RelayOracleV2.Execution[] memory execs, bytes[] memory sigs) = _exec(
      keccak256("deploy-fast-happy"),
      actions
    );

    v2.executeMultiple(execs, oracleSigner, sigs);

    // split: fee -> feeRecipient, order input -> order address
    assertEq(hub.balanceOf(feeRecipient, tokenId), 1e8);
    assertEq(hub.balanceOf(orderAddr, tokenId), amount - 1e8);
    // bucket consumed exactly the gross amount
    assertEq(
      before_.tokens - limiter.getBucket(CHAIN_ID, CURRENCY).tokens,
      amount
    );
    assertTrue(v2.isExecuted(keccak256("deploy-fast-happy")));
  }

  function test_deployWireFastMint_failClosedZeroAmount() public {
    uint256 tokenId = _tokenId(CHAIN_ID, CURRENCY);
    bytes32 key = keccak256("deploy-fast-zero");

    bytes[] memory actions = new bytes[](1);
    actions[0] = _fastMintAction(0, 0, feeRecipient); // amount 0 -> fail-closed
    (RelayOracleV2.Execution[] memory execs, bytes[] memory sigs) = _exec(
      key,
      actions
    );

    // The limiter rejects (amount 0), V2 reverts FastMintRejected, executeMultiple isolates it.
    vm.expectEmit(true, false, false, true, address(v2));
    emit RelayOracleV2.ExecutionFailed(key, actions);
    v2.executeMultiple(execs, oracleSigner, sigs);

    // nothing minted, key reusable -> re-attestable as slow
    assertFalse(v2.isExecuted(key));
    assertEq(hub.balanceOf(orderAddr, tokenId), 0);
    assertEq(hub.balanceOf(feeRecipient, tokenId), 0);
  }
}
