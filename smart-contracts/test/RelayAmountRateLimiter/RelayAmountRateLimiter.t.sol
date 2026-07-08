// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../utils/BaseTest.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {RelayAmountRateLimiter} from "../../contracts/rate-limiters/RelayAmountRateLimiter.sol";

/// @notice Scenario coverage for the per-(chain, currency) amount token-bucket rate limiter: config
///         lifecycle, consume accept/reject (incl. zero-amount fail-closed), per-(chain, currency)
///         budget isolation, rolling refill, views, role gating, fuzz. The deposit amount is in the
///         currency's base units and passed straight in (no on-chain pricing).
contract RelayAmountRateLimiterTest is BaseTest {
  RelayAmountRateLimiter internal policy;
  address internal consumer;
  bytes32 internal adminRole;
  bytes32 internal consumerRole;

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
    vm.prank(owner);
    policy.grantRole(consumerRole, consumer);
  }

  // Helpers

  function _config(
    string memory chainId,
    bytes memory currency,
    bool isEnabled,
    uint128 capacity,
    uint128 rate
  ) internal pure returns (RelayAmountRateLimiter.BucketConfig memory) {
    return
      RelayAmountRateLimiter.BucketConfig({
        chainId: chainId,
        currency: currency,
        isEnabled: isEnabled,
        capacity: capacity,
        rate: rate
      });
  }

  function _enable(
    string memory chainId,
    bytes memory currency,
    uint128 capacity,
    uint128 rate
  ) internal {
    vm.prank(owner);
    policy.setBucketConfig(_config(chainId, currency, true, capacity, rate));
  }

  // consume takes opaque bytes; the amount limiter decodes abi.encode(chainId, currency, amount).
  function _consume(
    string memory chainId,
    bytes memory currency,
    uint256 amount
  ) internal returns (bool) {
    return policy.consume(abi.encode(chainId, currency, amount));
  }

  // ----------------------------------------------------------------------
  // Config
  // ----------------------------------------------------------------------

  function test_firstConfigStartsFull() public {
    _enable(CHAIN_ID, CURRENCY, CAPACITY, RATE);

    RelayAmountRateLimiter.TokenBucket memory b = policy.getBucket(
      CHAIN_ID,
      CURRENCY
    );
    assertEq(b.tokens, CAPACITY, "starts full");
    assertEq(b.capacity, CAPACITY);
    assertEq(b.rate, RATE);
    assertTrue(b.isEnabled);
  }

  function test_setBucketConfigsBatch() public {
    RelayAmountRateLimiter.BucketConfig[]
      memory configs = new RelayAmountRateLimiter.BucketConfig[](2);
    configs[0] = _config(CHAIN_ID, CURRENCY, true, CAPACITY, RATE);
    configs[1] = _config(CHAIN_ID_2, CURRENCY, true, 500_000e18, 5_000e18);

    vm.prank(owner);
    policy.setBucketConfigs(configs);

    assertEq(policy.getBucket(CHAIN_ID, CURRENCY).tokens, CAPACITY);
    assertEq(policy.getBucket(CHAIN_ID_2, CURRENCY).tokens, 500_000e18);
  }

  function test_reconfigLowerCapacityCapsTokens() public {
    _enable(CHAIN_ID, CURRENCY, CAPACITY, RATE);

    uint128 lower = 100_000e18;
    vm.prank(owner);
    policy.setBucketConfig(_config(CHAIN_ID, CURRENCY, true, lower, RATE));

    assertEq(
      policy.getBucket(CHAIN_ID, CURRENCY).tokens,
      lower,
      "tokens capped to new capacity"
    );
  }

  function test_reconfigRefillsAtOldRateFirst() public {
    _enable(CHAIN_ID, CURRENCY, CAPACITY, RATE);

    vm.prank(consumer);
    _consume(CHAIN_ID, CURRENCY, CAPACITY);
    vm.warp(block.timestamp + 10); // +10s * RATE accrued at old rate

    vm.prank(owner);
    policy.setBucketConfig(
      _config(CHAIN_ID, CURRENCY, true, CAPACITY, RATE * 2)
    );

    assertEq(
      policy.getBucket(CHAIN_ID, CURRENCY).tokens,
      uint256(RATE) * 10,
      "old-rate accrual preserved"
    );
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
    policy.setBucketConfig(_config(CHAIN_ID, CURRENCY, true, CAPACITY, RATE));
  }

  function test_configEmitsEvent() public {
    vm.expectEmit(true, false, false, true, address(policy));
    emit RelayAmountRateLimiter.BucketConfigSet(
      CHAIN_ID,
      CURRENCY,
      true,
      CAPACITY,
      RATE
    );
    vm.prank(owner);
    policy.setBucketConfig(_config(CHAIN_ID, CURRENCY, true, CAPACITY, RATE));
  }

  // ----------------------------------------------------------------------
  // Consume
  // ----------------------------------------------------------------------

  function test_consumeReducesTokens() public {
    _enable(CHAIN_ID, CURRENCY, CAPACITY, RATE);

    vm.prank(consumer);
    _consume(CHAIN_ID, CURRENCY, 250_000e18);

    assertEq(
      policy.getBucket(CHAIN_ID, CURRENCY).tokens,
      CAPACITY - 250_000e18
    );
  }

  function test_perCurrencyBudgetIsolated() public {
    // Two currencies on the SAME chain have independent buckets.
    _enable(CHAIN_ID, CURRENCY, CAPACITY, RATE);
    _enable(CHAIN_ID, CURRENCY_2, CAPACITY, RATE);

    // Drain currency A's bucket on the chain.
    vm.prank(consumer);
    _consume(CHAIN_ID, CURRENCY, CAPACITY);
    assertEq(policy.getBucket(CHAIN_ID, CURRENCY).tokens, 0, "A drained");

    // Currency B on the same chain is untouched.
    assertEq(
      policy.getBucket(CHAIN_ID, CURRENCY_2).tokens,
      CAPACITY,
      "B unaffected"
    );
    assertTrue(
      policy.canConsume(CHAIN_ID, CURRENCY_2, CAPACITY),
      "B fully available"
    );
  }

  function test_consumeEmitsEvent() public {
    _enable(CHAIN_ID, CURRENCY, CAPACITY, RATE);

    vm.expectEmit(true, false, false, true, address(policy));
    emit RelayAmountRateLimiter.TokensConsumed(
      CHAIN_ID,
      CURRENCY,
      250_000e18,
      CAPACITY - 250_000e18
    );
    vm.prank(consumer);
    _consume(CHAIN_ID, CURRENCY, 250_000e18);
  }

  function test_consumeToZeroThenRateLimited() public {
    _enable(CHAIN_ID, CURRENCY, CAPACITY, RATE);

    vm.prank(consumer);
    _consume(CHAIN_ID, CURRENCY, CAPACITY); // drain exactly
    assertEq(policy.getBucket(CHAIN_ID, CURRENCY).tokens, 0);

    // Over budget now => not consumed.
    vm.prank(consumer);
    assertFalse(_consume(CHAIN_ID, CURRENCY, 1), "drained => not consumed");
  }

  function test_consumeMoreThanCapacityReturnsFalse() public {
    _enable(CHAIN_ID, CURRENCY, CAPACITY, RATE);

    vm.prank(consumer);
    assertFalse(
      _consume(CHAIN_ID, CURRENCY, uint256(CAPACITY) + 1),
      "over capacity => not consumed"
    );
  }

  function test_consumeZeroAmountFailsClosed() public {
    _enable(CHAIN_ID, CURRENCY, CAPACITY, RATE);

    // Fail-closed: a 0 amount on an enabled bucket would otherwise consume nothing and always pass
    // (= unlimited fast). Reject it; nothing is consumed.
    vm.prank(consumer);
    assertFalse(_consume(CHAIN_ID, CURRENCY, 0), "zero amount => not consumed");
    assertEq(
      policy.getBucket(CHAIN_ID, CURRENCY).tokens,
      CAPACITY,
      "unchanged"
    );
  }

  function test_consumeOnUnconfiguredBucketReturnsFalse() public {
    // Fail-closed: (CHAIN_ID, CURRENCY) never configured => fast not enabled => not consumed.
    vm.prank(consumer);
    assertFalse(
      _consume(CHAIN_ID, CURRENCY, type(uint128).max),
      "unconfigured => not consumed"
    );
  }

  function test_consumeOnDisabledReturnsFalse() public {
    // Disabling a (chain, currency) force-degrades its fast to slow (the kill-switch direction).
    vm.prank(owner);
    policy.setBucketConfig(_config(CHAIN_ID, CURRENCY, false, CAPACITY, RATE));

    vm.prank(consumer);
    assertFalse(
      _consume(CHAIN_ID, CURRENCY, type(uint128).max),
      "disabled => not consumed"
    );
  }

  function test_onlyConsumerCanConsume() public {
    _enable(CHAIN_ID, CURRENCY, CAPACITY, RATE);

    vm.prank(otherAccounts[0]);
    vm.expectRevert(
      abi.encodeWithSelector(
        IAccessControl.AccessControlUnauthorizedAccount.selector,
        otherAccounts[0],
        consumerRole
      )
    );
    _consume(CHAIN_ID, CURRENCY, 1);
  }

  // ----------------------------------------------------------------------
  // Rolling refill
  // ----------------------------------------------------------------------

  function test_refillOverTime() public {
    _enable(CHAIN_ID, CURRENCY, CAPACITY, RATE);
    vm.prank(consumer);
    _consume(CHAIN_ID, CURRENCY, CAPACITY); // empty

    vm.warp(block.timestamp + 30);
    assertEq(
      policy.getBucket(CHAIN_ID, CURRENCY).tokens,
      uint256(RATE) * 30,
      "30s * rate accrued"
    );
  }

  function test_refillCapsAtCapacity() public {
    _enable(CHAIN_ID, CURRENCY, CAPACITY, RATE);
    vm.prank(consumer);
    _consume(CHAIN_ID, CURRENCY, CAPACITY);

    vm.warp(block.timestamp + 10_000_000); // way past full
    assertEq(
      policy.getBucket(CHAIN_ID, CURRENCY).tokens,
      CAPACITY,
      "never exceeds capacity"
    );
  }

  function test_refillThenConsumeBoundary() public {
    _enable(CHAIN_ID, CURRENCY, CAPACITY, RATE);
    vm.prank(consumer);
    _consume(CHAIN_ID, CURRENCY, CAPACITY);

    vm.warp(block.timestamp + 5); // 5 * RATE available
    uint256 available = uint256(RATE) * 5;

    vm.prank(consumer);
    _consume(CHAIN_ID, CURRENCY, available); // exactly drains the refill

    vm.prank(consumer);
    assertFalse(
      _consume(CHAIN_ID, CURRENCY, 1),
      "refill drained => not consumed"
    );
  }

  /// @dev A rejected consume after elapsed time must still persist the refill: advancing
  ///      `lastUpdated` without banking the accrued tokens would discard the accrual and let
  ///      repeated over-budget requests defeat the configured rate (grief the budget to ~0).
  function test_rejectedConsumeBanksRefill() public {
    _enable(CHAIN_ID, CURRENCY, CAPACITY, RATE);
    vm.prank(consumer);
    _consume(CHAIN_ID, CURRENCY, CAPACITY); // drain to 0

    vm.warp(block.timestamp + 5); // 5 * RATE accrued
    uint256 accrued = uint256(RATE) * 5;

    // Over-budget request is rejected but must NOT burn the accrued refill.
    vm.prank(consumer);
    assertFalse(
      _consume(CHAIN_ID, CURRENCY, accrued + 1),
      "over budget => rejected"
    );
    assertEq(
      policy.getBucket(CHAIN_ID, CURRENCY).tokens,
      accrued,
      "refill banked despite rejection"
    );

    // The banked refill is spendable in the same block (no new accrual to mask it).
    vm.prank(consumer);
    assertTrue(
      _consume(CHAIN_ID, CURRENCY, accrued),
      "banked refill spendable"
    );
    assertEq(policy.getBucket(CHAIN_ID, CURRENCY).tokens, 0);
  }

  // ----------------------------------------------------------------------
  // Views
  // ----------------------------------------------------------------------

  function test_getBucketIsLiveRefill() public {
    _enable(CHAIN_ID, CURRENCY, CAPACITY, RATE);
    vm.prank(consumer);
    _consume(CHAIN_ID, CURRENCY, CAPACITY);

    vm.warp(block.timestamp + 7);
    assertEq(policy.getBucket(CHAIN_ID, CURRENCY).tokens, uint256(RATE) * 7);
  }

  function test_canConsumeWithinBudget() public {
    _enable(CHAIN_ID, CURRENCY, CAPACITY, RATE);
    assertTrue(policy.canConsume(CHAIN_ID, CURRENCY, CAPACITY));
  }

  function test_canConsumeOverBudget() public {
    _enable(CHAIN_ID, CURRENCY, CAPACITY, RATE);
    vm.prank(consumer);
    _consume(CHAIN_ID, CURRENCY, CAPACITY);
    assertFalse(policy.canConsume(CHAIN_ID, CURRENCY, 1), "drained => cannot");
  }

  function test_canConsumeAboveCapacity() public {
    _enable(CHAIN_ID, CURRENCY, CAPACITY, RATE);
    assertFalse(policy.canConsume(CHAIN_ID, CURRENCY, uint256(CAPACITY) + 1));
  }

  function test_canConsumeFalseWhenBucketNotEnabled() public view {
    // Fail-closed: (CHAIN_ID, CURRENCY) never configured => fast not enabled => cannot
    assertFalse(policy.canConsume(CHAIN_ID, CURRENCY, type(uint256).max));
  }

  function test_canConsumeZeroAmountIsFalse() public {
    // Mirrors consume's fail-closed: a zero amount can never be consumed.
    _enable(CHAIN_ID, CURRENCY, CAPACITY, RATE);
    assertFalse(
      policy.canConsume(CHAIN_ID, CURRENCY, 0),
      "zero amount => cannot"
    );
  }

  // ----------------------------------------------------------------------
  // Roles
  // ----------------------------------------------------------------------

  function test_adminCanGrantConsumer() public {
    address newConsumer = makeAddr("newConsumer");
    vm.prank(owner);
    policy.grantRole(consumerRole, newConsumer);

    _enable(CHAIN_ID, CURRENCY, CAPACITY, RATE);
    vm.prank(newConsumer);
    _consume(CHAIN_ID, CURRENCY, 1); // no revert
    assertEq(policy.getBucket(CHAIN_ID, CURRENCY).tokens, CAPACITY - 1);
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

    _enable(CHAIN_ID, CURRENCY, capacity, rate);
    vm.warp(block.timestamp + elapsed);

    bool predicted = policy.canConsume(CHAIN_ID, CURRENCY, amount);

    vm.prank(consumer);
    bool consumed = _consume(CHAIN_ID, CURRENCY, amount);
    assertEq(consumed, predicted, "consume return must match canConsume");
  }

  /// @dev Live tokens never exceed capacity.
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

    _enable(CHAIN_ID, CURRENCY, capacity, rate);
    vm.prank(consumer);
    _consume(CHAIN_ID, CURRENCY, spent);
    vm.warp(block.timestamp + elapsed);

    assertLe(policy.getBucket(CHAIN_ID, CURRENCY).tokens, capacity);
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

    _enable(CHAIN_ID, CURRENCY, capacity, rate);
    vm.prank(consumer);
    _consume(CHAIN_ID, CURRENCY, spent);
    vm.warp(block.timestamp + elapsed);

    uint256 expected = capacity - spent + uint256(rate) * elapsed;
    if (expected > capacity) {
      expected = capacity;
    }
    assertEq(policy.getBucket(CHAIN_ID, CURRENCY).tokens, expected);
  }

  // ----------------------------------------------------------------------
  // Robustness
  // ----------------------------------------------------------------------

  /// @dev A no-refill bucket (rate == 0) drained then over-requested returns false cleanly, no panic.
  function test_zeroRateOverBudgetReturnsFalseCleanly() public {
    _enable(CHAIN_ID, CURRENCY, CAPACITY, 0);
    vm.prank(consumer);
    _consume(CHAIN_ID, CURRENCY, CAPACITY); // drain

    vm.prank(consumer);
    assertFalse(
      _consume(CHAIN_ID, CURRENCY, 1),
      "zero-rate drained => not consumed"
    );
  }

  function test_constructorRejectsZeroAdmin() public {
    vm.expectRevert(RelayAmountRateLimiter.ZeroAddress.selector);
    new RelayAmountRateLimiter(address(0));
  }
}
