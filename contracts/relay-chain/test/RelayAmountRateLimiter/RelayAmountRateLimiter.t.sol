// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../utils/BaseTest.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {RelayAmountRateLimiter} from "../../contracts/rate-limiters/RelayAmountRateLimiter.sol";
import {DeployRelayAmountRateLimiter} from "../../script/DeployRelayAmountRateLimiter.s.sol";

/// @notice Scenario coverage for the per-token amount token-bucket rate limiter: config lifecycle,
///         consume accept/reject (incl. zero-amount fail-closed), per-token budget isolation,
///         rolling refill, views, role gating, fuzz. The deposit amount is in the token's base units
///         and passed straight in (no on-chain pricing).
contract RelayAmountRateLimiterTest is BaseTest {
  RelayAmountRateLimiter internal policy;
  address internal consumer;
  bytes32 internal adminRole;
  bytes32 internal consumerRole;
  uint256 internal tokenId;
  uint256 internal tokenId2;
  uint256 internal tokenIdChain2;

  string internal constant CHAIN_ID = "8453"; // base
  string internal constant CHAIN_ID_2 = "42161"; // arbitrum
  bytes internal constant CURRENCY =
    hex"a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"; // USDC
  bytes internal constant CURRENCY_2 =
    hex"c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"; // WETH

  // Budget is in the currency's base units (18-dec here). 1 token = 1e18.
  uint128 internal constant CAPACITY = 1_000_000e18; // 1M tokens max in-flight
  uint128 internal constant RATE = 10_000e18; // 10k tokens / sec refill

  function setUp() public override {
    super.setUp();
    // Realistic timestamp: lastUpdated==0 is the "never configured" sentinel.
    vm.warp(1_700_000_000);

    policy = new RelayAmountRateLimiter(owner);
    adminRole = policy.ADMIN_ROLE();
    consumerRole = policy.CONSUMER_ROLE();
    consumer = makeAddr("consumer");
    tokenId = _tokenId(CHAIN_ID, CURRENCY);
    tokenId2 = _tokenId(CHAIN_ID, CURRENCY_2);
    tokenIdChain2 = _tokenId(CHAIN_ID_2, CURRENCY);
    vm.prank(owner);
    policy.grantRole(consumerRole, consumer);
  }

  // Helpers

  function _tokenId(
    string memory chainId,
    bytes memory currency
  ) internal pure returns (uint256) {
    return uint256(keccak256(abi.encodePacked(chainId, currency)));
  }

  function _config(
    uint256 tokenId_,
    bool isEnabled,
    uint128 capacity,
    uint128 rate
  ) internal pure returns (RelayAmountRateLimiter.BucketConfig memory) {
    return
      RelayAmountRateLimiter.BucketConfig({
        tokenId: tokenId_,
        isEnabled: isEnabled,
        capacity: capacity,
        rate: rate
      });
  }

  function _enable(uint256 tokenId_, uint128 capacity, uint128 rate) internal {
    vm.prank(owner);
    policy.setBucketConfig(_config(tokenId_, true, capacity, rate));
  }

  function _consume(uint256 tokenId_, uint256 amount) internal returns (bool) {
    return policy.consume(tokenId_, amount, bytes(""));
  }

  // ----------------------------------------------------------------------
  // Config
  // ----------------------------------------------------------------------

  function test_firstConfigStartsFull() public {
    _enable(tokenId, CAPACITY, RATE);

    RelayAmountRateLimiter.TokenBucket memory b = policy.getBucket(tokenId);
    assertEq(b.tokens, CAPACITY, "starts full");
    assertEq(b.capacity, CAPACITY);
    assertEq(b.rate, RATE);
    assertTrue(b.isEnabled);
  }

  function test_setBucketConfigsBatch() public {
    RelayAmountRateLimiter.BucketConfig[]
      memory configs = new RelayAmountRateLimiter.BucketConfig[](2);
    configs[0] = _config(tokenId, true, CAPACITY, RATE);
    configs[1] = _config(tokenIdChain2, true, 500_000e18, 5_000e18);

    vm.prank(owner);
    policy.setBucketConfigs(configs);

    assertEq(policy.getBucket(tokenId).tokens, CAPACITY);
    assertEq(policy.getBucket(tokenIdChain2).tokens, 500_000e18);
  }

  function test_reconfigLowerCapacityCapsTokens() public {
    _enable(tokenId, CAPACITY, RATE);

    uint128 lower = 100_000e18;
    vm.prank(owner);
    policy.setBucketConfig(_config(tokenId, true, lower, RATE));

    assertEq(
      policy.getBucket(tokenId).tokens,
      lower,
      "tokens capped to new capacity"
    );
  }

  function test_reconfigRefillsAtOldRateFirst() public {
    _enable(tokenId, CAPACITY, RATE);

    vm.prank(consumer);
    _consume(tokenId, CAPACITY);
    vm.warp(block.timestamp + 10); // +10s * RATE accrued at old rate

    vm.prank(owner);
    policy.setBucketConfig(_config(tokenId, true, CAPACITY, RATE * 2));

    assertEq(
      policy.getBucket(tokenId).tokens,
      uint256(RATE) * 10,
      "old-rate accrual preserved"
    );
  }

  /// @dev Disable -> wait -> re-enable must not hand back the disabled window's accrual as a burst.
  function test_disabledBucketDoesNotAccrue() public {
    _enable(tokenId, CAPACITY, RATE);
    vm.prank(consumer);
    _consume(tokenId, CAPACITY); // drain to 0

    vm.prank(owner);
    policy.setBucketConfig(_config(tokenId, false, CAPACITY, RATE));
    vm.warp(block.timestamp + 7 days);
    assertEq(policy.getBucket(tokenId).tokens, 0, "frozen while disabled");

    _enable(tokenId, CAPACITY, RATE);
    assertEq(policy.getBucket(tokenId).tokens, 0, "no burst on re-enable");
    vm.prank(consumer);
    assertFalse(_consume(tokenId, 1), "nothing to spend on re-enable");

    vm.warp(block.timestamp + 3);
    assertEq(
      policy.getBucket(tokenId).tokens,
      uint256(RATE) * 3,
      "accrual resumes from re-enable"
    );
  }

  function test_disableReenableKeepsStoredBalance() public {
    _enable(tokenId, CAPACITY, RATE);
    vm.prank(consumer);
    _consume(tokenId, CAPACITY / 4);
    uint256 stored = CAPACITY - CAPACITY / 4;

    vm.prank(owner);
    policy.setBucketConfig(_config(tokenId, false, CAPACITY, RATE));
    vm.warp(block.timestamp + 1 days);
    assertEq(
      policy.getBucket(tokenId).tokens,
      stored,
      "view matches re-enable"
    );

    _enable(tokenId, CAPACITY, RATE);
    assertEq(policy.getBucket(tokenId).tokens, stored, "balance preserved");
  }

  function test_onlyAdminCanConfig() public {
    vm.prank(otherAccounts[0]);
    vm.expectRevert(
      abi.encodeWithSelector(
        IAccessControl.AccessControlUnauthorizedAccount.selector,
        otherAccounts[0],
        adminRole
      )
    );
    policy.setBucketConfig(_config(tokenId, true, CAPACITY, RATE));
  }

  function test_configEmitsEvent() public {
    vm.expectEmit(true, false, false, true, address(policy));
    emit RelayAmountRateLimiter.BucketConfigSet(tokenId, true, CAPACITY, RATE);
    vm.prank(owner);
    policy.setBucketConfig(_config(tokenId, true, CAPACITY, RATE));
  }

  // ----------------------------------------------------------------------
  // Consume
  // ----------------------------------------------------------------------

  function test_consumeReducesTokens() public {
    _enable(tokenId, CAPACITY, RATE);

    vm.prank(consumer);
    _consume(tokenId, 250_000e18);

    assertEq(policy.getBucket(tokenId).tokens, CAPACITY - 250_000e18);
  }

  function test_perTokenBudgetIsolated() public {
    // Two tokens have independent buckets.
    _enable(tokenId, CAPACITY, RATE);
    _enable(tokenId2, CAPACITY, RATE);

    // Drain token A's bucket.
    vm.prank(consumer);
    _consume(tokenId, CAPACITY);
    assertEq(policy.getBucket(tokenId).tokens, 0, "A drained");

    // Token B is untouched.
    assertEq(policy.getBucket(tokenId2).tokens, CAPACITY, "B unaffected");
    assertTrue(policy.canConsume(tokenId2, CAPACITY), "B fully available");
  }

  function test_consumeEmitsEvent() public {
    _enable(tokenId, CAPACITY, RATE);

    vm.expectEmit(true, false, false, true, address(policy));
    emit RelayAmountRateLimiter.TokensConsumed(
      tokenId,
      250_000e18,
      CAPACITY - 250_000e18
    );
    vm.prank(consumer);
    _consume(tokenId, 250_000e18);
  }

  function test_consumeToZeroThenRateLimited() public {
    _enable(tokenId, CAPACITY, RATE);

    vm.prank(consumer);
    _consume(tokenId, CAPACITY); // drain exactly
    assertEq(policy.getBucket(tokenId).tokens, 0);

    // Over budget now => not consumed.
    vm.prank(consumer);
    assertFalse(_consume(tokenId, 1), "drained => not consumed");
  }

  function test_consumeMoreThanCapacityReturnsFalse() public {
    _enable(tokenId, CAPACITY, RATE);

    vm.prank(consumer);
    assertFalse(
      _consume(tokenId, uint256(CAPACITY) + 1),
      "over capacity => not consumed"
    );
  }

  function test_consumeZeroAmountFailsClosed() public {
    _enable(tokenId, CAPACITY, RATE);

    // Fail-closed: a 0 amount on an enabled bucket would otherwise consume nothing and always pass
    // (= unlimited fast). Reject it; nothing is consumed.
    vm.prank(consumer);
    assertFalse(_consume(tokenId, 0), "zero amount => not consumed");
    assertEq(policy.getBucket(tokenId).tokens, CAPACITY, "unchanged");
  }

  function test_consumeOnUnconfiguredBucketReturnsFalse() public {
    // Fail-closed: tokenId never configured => fast not enabled => not consumed.
    vm.prank(consumer);
    assertFalse(
      _consume(tokenId, type(uint128).max),
      "unconfigured => not consumed"
    );
  }

  function test_consumeOnDisabledReturnsFalse() public {
    // Disabling a token force-degrades its fast to slow (the kill-switch direction).
    vm.prank(owner);
    policy.setBucketConfig(_config(tokenId, false, CAPACITY, RATE));

    vm.prank(consumer);
    assertFalse(
      _consume(tokenId, type(uint128).max),
      "disabled => not consumed"
    );
  }

  function test_onlyConsumerCanConsume() public {
    _enable(tokenId, CAPACITY, RATE);

    vm.prank(otherAccounts[0]);
    vm.expectRevert(
      abi.encodeWithSelector(
        IAccessControl.AccessControlUnauthorizedAccount.selector,
        otherAccounts[0],
        consumerRole
      )
    );
    _consume(tokenId, 1);
  }

  // ----------------------------------------------------------------------
  // Rolling refill
  // ----------------------------------------------------------------------

  function test_refillOverTime() public {
    _enable(tokenId, CAPACITY, RATE);
    vm.prank(consumer);
    _consume(tokenId, CAPACITY); // empty

    vm.warp(block.timestamp + 30);
    assertEq(
      policy.getBucket(tokenId).tokens,
      uint256(RATE) * 30,
      "30s * rate accrued"
    );
  }

  function test_refillCapsAtCapacity() public {
    _enable(tokenId, CAPACITY, RATE);
    vm.prank(consumer);
    _consume(tokenId, CAPACITY);

    vm.warp(block.timestamp + 10_000_000); // way past full
    assertEq(
      policy.getBucket(tokenId).tokens,
      CAPACITY,
      "never exceeds capacity"
    );
  }

  function test_refillThenConsumeBoundary() public {
    _enable(tokenId, CAPACITY, RATE);
    vm.prank(consumer);
    _consume(tokenId, CAPACITY);

    vm.warp(block.timestamp + 5); // 5 * RATE available
    uint256 available = uint256(RATE) * 5;

    vm.prank(consumer);
    _consume(tokenId, available); // exactly drains the refill

    vm.prank(consumer);
    assertFalse(_consume(tokenId, 1), "refill drained => not consumed");
  }

  /// @dev A rejected consume after elapsed time must still persist the refill: advancing
  ///      `lastUpdated` without banking the accrued tokens would discard the accrual and let
  ///      repeated over-budget requests defeat the configured rate (grief the budget to ~0).
  function test_rejectedConsumeBanksRefill() public {
    _enable(tokenId, CAPACITY, RATE);
    vm.prank(consumer);
    _consume(tokenId, CAPACITY); // drain to 0

    vm.warp(block.timestamp + 5); // 5 * RATE accrued
    uint256 accrued = uint256(RATE) * 5;

    // Over-budget request is rejected but must NOT burn the accrued refill.
    vm.prank(consumer);
    assertFalse(_consume(tokenId, accrued + 1), "over budget => rejected");
    assertEq(
      policy.getBucket(tokenId).tokens,
      accrued,
      "refill banked despite rejection"
    );

    // The banked refill is spendable in the same block (no new accrual to mask it).
    vm.prank(consumer);
    assertTrue(_consume(tokenId, accrued), "banked refill spendable");
    assertEq(policy.getBucket(tokenId).tokens, 0);
  }

  // ----------------------------------------------------------------------
  // Views
  // ----------------------------------------------------------------------

  function test_getBucketIsLiveRefill() public {
    _enable(tokenId, CAPACITY, RATE);
    vm.prank(consumer);
    _consume(tokenId, CAPACITY);

    vm.warp(block.timestamp + 7);
    assertEq(policy.getBucket(tokenId).tokens, uint256(RATE) * 7);
  }

  function test_canConsumeWithinBudget() public {
    _enable(tokenId, CAPACITY, RATE);
    assertTrue(policy.canConsume(tokenId, CAPACITY));
  }

  function test_canConsumeOverBudget() public {
    _enable(tokenId, CAPACITY, RATE);
    vm.prank(consumer);
    _consume(tokenId, CAPACITY);
    assertFalse(policy.canConsume(tokenId, 1), "drained => cannot");
  }

  function test_canConsumeAboveCapacity() public {
    _enable(tokenId, CAPACITY, RATE);
    assertFalse(policy.canConsume(tokenId, uint256(CAPACITY) + 1));
  }

  function test_canConsumeFalseWhenBucketNotEnabled() public view {
    // Fail-closed: tokenId never configured => fast not enabled => cannot.
    assertFalse(policy.canConsume(tokenId, type(uint256).max));
  }

  function test_canConsumeZeroAmountIsFalse() public {
    // Mirrors consume's fail-closed: a zero amount can never be consumed.
    _enable(tokenId, CAPACITY, RATE);
    assertFalse(policy.canConsume(tokenId, 0), "zero amount => cannot");
  }

  function _amounts(
    uint256 a,
    uint256 b,
    uint256 c
  ) internal pure returns (uint256[] memory amounts) {
    amounts = new uint256[](3);
    amounts[0] = a;
    amounts[1] = b;
    amounts[2] = c;
  }

  /// @dev Each item fits on its own, but the batch together exceeds the shared per-token bucket.
  function test_canConsumeBatchCatchesCumulativeOverBudget() public {
    _enable(tokenId, CAPACITY, RATE);
    uint256 half = CAPACITY / 2;

    assertTrue(policy.canConsume(tokenId, half), "each item fits alone");
    assertFalse(
      policy.canConsumeBatch(tokenId, _amounts(half, half, 1)),
      "sum over budget => cannot"
    );
    assertTrue(
      policy.canConsumeBatch(tokenId, _amounts(half, half - 1, 1)),
      "sum == budget => can"
    );

    // Sequential consume() agrees with the batch verdict.
    vm.startPrank(consumer);
    assertTrue(_consume(tokenId, half));
    assertTrue(_consume(tokenId, half));
    assertFalse(_consume(tokenId, 1));
    vm.stopPrank();
  }

  function test_canConsumeBatchTracksRefill() public {
    _enable(tokenId, CAPACITY, RATE);
    vm.prank(consumer);
    _consume(tokenId, CAPACITY);

    vm.warp(block.timestamp + 3); // 3 * RATE available
    assertTrue(policy.canConsumeBatch(tokenId, _amounts(RATE, RATE, RATE)));
    assertFalse(
      policy.canConsumeBatch(tokenId, _amounts(RATE, RATE, uint256(RATE) + 1))
    );
  }

  function test_canConsumeBatchOverflowingSumIsFalse() public {
    _enable(tokenId, CAPACITY, RATE);
    uint256[] memory amounts = new uint256[](2);
    amounts[0] = type(uint256).max;
    amounts[1] = 1;
    assertFalse(
      policy.canConsumeBatch(tokenId, amounts),
      "no panic on overflow"
    );

    amounts[0] = 1;
    amounts[1] = type(uint256).max;
    assertFalse(
      policy.canConsumeBatch(tokenId, amounts),
      "no panic on overflow"
    );
  }

  function test_canConsumeBatchFailsClosed() public {
    assertFalse(
      policy.canConsumeBatch(tokenId, _amounts(1, 1, 1)),
      "disabled => cannot"
    );

    _enable(tokenId, CAPACITY, RATE);
    assertFalse(
      policy.canConsumeBatch(tokenId, new uint256[](0)),
      "empty => cannot"
    );
    assertFalse(
      policy.canConsumeBatch(tokenId, _amounts(1, 0, 1)),
      "zero item => cannot"
    );
  }

  // ----------------------------------------------------------------------
  // Roles
  // ----------------------------------------------------------------------

  function test_adminCanGrantConsumer() public {
    address newConsumer = makeAddr("newConsumer");
    vm.prank(owner);
    policy.grantRole(consumerRole, newConsumer);

    _enable(tokenId, CAPACITY, RATE);
    vm.prank(newConsumer);
    _consume(tokenId, 1); // no revert
    assertEq(policy.getBucket(tokenId).tokens, CAPACITY - 1);
  }

  // ----------------------------------------------------------------------
  // Fuzz
  // ----------------------------------------------------------------------

  /// @dev The advisory view must agree with the authoritative on-chain enforcement.
  function testFuzz_canConsumeMatchesConsume(
    uint128 capacity,
    uint128 rate,
    uint256 amount,
    uint32 elapsed
  ) public {
    capacity = uint128(bound(capacity, 1, 1e30));
    rate = uint128(bound(rate, 0, 1e24));
    elapsed = uint32(bound(elapsed, 0, 1e7));

    _enable(tokenId, capacity, rate);
    vm.warp(block.timestamp + elapsed);

    bool predicted = policy.canConsume(tokenId, amount);

    vm.prank(consumer);
    bool consumed = _consume(tokenId, amount);
    assertEq(consumed, predicted, "consume return must match canConsume");
  }

  /// @dev Live tokens never exceed capacity.
  /// @dev The batch view must agree with charging the same amounts through consume in sequence.
  function testFuzz_canConsumeBatchMatchesSequentialConsume(
    uint128 capacity,
    uint128 rate,
    uint256[4] memory rawAmounts,
    uint8 count,
    uint32 elapsed
  ) public {
    capacity = uint128(bound(capacity, 1, 1e30));
    rate = uint128(bound(rate, 0, 1e24));
    count = uint8(bound(count, 1, 4));
    elapsed = uint32(bound(elapsed, 0, 1e7));

    _enable(tokenId, capacity, rate);
    vm.prank(consumer);
    _consume(tokenId, capacity); // start empty so refill matters
    vm.warp(block.timestamp + elapsed);

    uint256[] memory amounts = new uint256[](count);
    for (uint256 i; i < count; ++i) {
      // Mostly in-range amounts so the batch is sometimes accepted; a few huge ones.
      amounts[i] = rawAmounts[i] % 8 == 0
        ? rawAmounts[i]
        : rawAmounts[i] % (uint256(capacity) / 2 + 1);
    }

    bool predicted = policy.canConsumeBatch(tokenId, amounts);

    bool allConsumed = true;
    vm.startPrank(consumer);
    for (uint256 i; i < count; ++i) {
      allConsumed = _consume(tokenId, amounts[i]) && allConsumed;
    }
    vm.stopPrank();

    assertEq(
      predicted,
      allConsumed,
      "batch view must match sequential consume"
    );
  }

  function testFuzz_tokensNeverExceedCapacity(
    uint128 capacity,
    uint128 rate,
    uint128 spent,
    uint32 elapsed
  ) public {
    capacity = uint128(bound(capacity, 1, 1e30));
    rate = uint128(bound(rate, 0, 1e24));
    spent = uint128(bound(spent, 0, capacity));
    elapsed = uint32(bound(elapsed, 0, 1e7));

    _enable(tokenId, capacity, rate);
    vm.prank(consumer);
    _consume(tokenId, spent);
    vm.warp(block.timestamp + elapsed);

    assertLe(policy.getBucket(tokenId).tokens, capacity);
  }

  /// @dev Refill follows min(capacity, remaining + elapsed*rate) exactly.
  function testFuzz_refillFormula(
    uint128 capacity,
    uint128 rate,
    uint128 spent,
    uint32 elapsed
  ) public {
    capacity = uint128(bound(capacity, 1, 1e30));
    rate = uint128(bound(rate, 0, 1e20));
    spent = uint128(bound(spent, 0, capacity));
    elapsed = uint32(bound(elapsed, 0, 1e7));

    _enable(tokenId, capacity, rate);
    vm.prank(consumer);
    _consume(tokenId, spent);
    vm.warp(block.timestamp + elapsed);

    uint256 expected = capacity - spent + uint256(rate) * elapsed;
    if (expected > capacity) {
      expected = capacity;
    }
    assertEq(policy.getBucket(tokenId).tokens, expected);
  }

  // ----------------------------------------------------------------------
  // Robustness
  // ----------------------------------------------------------------------

  /// @dev A no-refill bucket (rate == 0) drained then over-requested returns false cleanly, no panic.
  function test_zeroRateOverBudgetReturnsFalseCleanly() public {
    _enable(tokenId, CAPACITY, 0);
    vm.prank(consumer);
    _consume(tokenId, CAPACITY); // drain

    vm.prank(consumer);
    assertFalse(_consume(tokenId, 1), "zero-rate drained => not consumed");
  }

  /// @dev The refill checkpoint must keep working past the uint32 timestamp limit (2106-02-07).
  function test_worksPastUint32Timestamp() public {
    _enable(tokenId, CAPACITY, RATE);
    vm.prank(consumer);
    _consume(tokenId, CAPACITY);

    uint256 future = uint256(type(uint32).max) + 1;
    vm.warp(future);
    vm.prank(consumer);
    assertTrue(_consume(tokenId, 1), "consume past 2106");

    RelayAmountRateLimiter.TokenBucket memory b = policy.getBucket(tokenId);
    assertEq(b.lastUpdated, future);
    assertEq(b.tokens, CAPACITY - 1);

    vm.warp(future + 1);
    _enable(tokenId, CAPACITY, RATE * 2); // reconfig past 2106
    assertEq(policy.getBucket(tokenId).lastUpdated, future + 1);
  }

  // ----------------------------------------------------------------------
  // Deploy script
  // ----------------------------------------------------------------------

  // Uses the script's env-free deploy(): vm.setEnv is process-global and races parallel test contracts.
  uint256 internal constant DEPLOYER_KEY = 0xA11CE;

  function test_deployGrantsAdminToConfiguredAddress() public {
    address governance = makeAddr("governance");

    RelayAmountRateLimiter deployed = new DeployRelayAmountRateLimiter().deploy(
      governance,
      DEPLOYER_KEY
    );
    assertTrue(deployed.hasRole(adminRole, governance), "ADMIN is admin");
    assertFalse(
      deployed.hasRole(adminRole, vm.addr(DEPLOYER_KEY)),
      "deployer is not admin"
    );
  }

  function test_deployRevertsWhenAdminUnset() public {
    DeployRelayAmountRateLimiter script = new DeployRelayAmountRateLimiter();
    vm.expectRevert(bytes("DeployRelayAmountRateLimiter: ADMIN is required"));
    script.deploy(address(0), DEPLOYER_KEY);
  }

  function test_constructorRejectsZeroAdmin() public {
    vm.expectRevert(RelayAmountRateLimiter.ZeroAddress.selector);
    new RelayAmountRateLimiter(address(0));
  }
}
