// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../utils/BaseTest.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Price} from "../../contracts/deposit-addresses/oracle/IPricingOracle.sol";
import {IRateLimiter} from "../../contracts/rate-limiters/IRateLimiter.sol";
import {RelayUsdRateLimiter} from "../../contracts/rate-limiters/RelayUsdRateLimiter.sol";

contract MockTokenUsdPriceOracle {
  mapping(uint256 => Price) internal prices;

  function setPrice(uint256 tokenId, Price memory price) external {
    prices[tokenId] = price;
  }

  function resolveUsdPrice(
    uint256 tokenId
  ) external view returns (Price memory price) {
    return prices[tokenId];
  }
}

/// @notice Scenario coverage for the per-chain USD token-bucket rate limiter: config lifecycle,
///         consume accept/reject, per-chain budget, rolling refill, views, role gating, fuzz. USD
///         value is resolved from the pricing oracle using the token id and amount.
contract RelayUsdRateLimiterTest is BaseTest {
  RelayUsdRateLimiter internal policy;
  MockTokenUsdPriceOracle internal priceOracle;
  address internal consumer;
  bytes32 internal adminRole;
  bytes32 internal consumerRole;

  string internal constant CHAIN_ID = "8453"; // base
  string internal constant CHAIN_ID_2 = "42161"; // arbitrum
  uint256 internal constant TOKEN_ID = 1;
  uint256 internal constant TOKEN_ID_2 = 2;

  // Budget is USD scaled by USD_DECIMALS (18). $1 = 1e18.
  uint128 internal constant CAPACITY = 1_000_000e18; // $1M max in-flight
  uint128 internal constant RATE = 10_000e18; // $10k / sec refill

  function setUp() public override {
    super.setUp();
    // Realistic timestamp: lastUpdated==0 is the "never configured" sentinel.
    vm.warp(1_700_000_000);

    priceOracle = new MockTokenUsdPriceOracle();
    _setUsdPrice(TOKEN_ID, 1e18, 18, 18);
    _setUsdPrice(TOKEN_ID_2, 1e18, 18, 18);

    policy = new RelayUsdRateLimiter(owner, address(priceOracle));
    adminRole = policy.ADMIN_ROLE();
    consumerRole = policy.CONSUMER_ROLE();
    consumer = makeAddr("consumer");
    vm.prank(owner);
    policy.grantRole(consumerRole, consumer);
  }

  // Helpers

  function _config(
    string memory chainId,
    bool isEnabled,
    uint128 capacity,
    uint128 rate
  ) internal pure returns (RelayUsdRateLimiter.BucketConfig memory) {
    return
      RelayUsdRateLimiter.BucketConfig({
        chainId: chainId,
        isEnabled: isEnabled,
        capacity: capacity,
        rate: rate
      });
  }

  function _enable(
    string memory chainId,
    uint128 capacity,
    uint128 rate
  ) internal {
    vm.prank(owner);
    policy.setBucketConfig(_config(chainId, true, capacity, rate));
  }

  function _setUsdPrice(
    uint256 tokenId,
    uint256 usdPrice,
    uint8 usdPriceDecimals,
    uint8 currencyDecimals
  ) internal {
    priceOracle.setPrice(
      tokenId,
      Price({
        usdPrice: usdPrice,
        usdPriceDecimals: usdPriceDecimals,
        currencyDecimals: currencyDecimals,
        publishTime: block.timestamp,
        expiration: block.timestamp + 1 days
      })
    );
  }

  // Tests use a default 1:1 price, so `amount` also represents the expected
  // USD value scaled by 1e18.
  function _consume(
    string memory chainId,
    uint256 amount
  ) internal returns (bool) {
    return policy.consume(TOKEN_ID, amount, abi.encode(chainId));
  }

  // ----------------------------------------------------------------------
  // Config
  // ----------------------------------------------------------------------

  function test_firstConfigStartsFull() public {
    _enable(CHAIN_ID, CAPACITY, RATE);

    RelayUsdRateLimiter.TokenBucket memory b = policy.getBucket(CHAIN_ID);
    assertEq(b.tokens, CAPACITY, "starts full");
    assertEq(b.capacity, CAPACITY);
    assertEq(b.rate, RATE);
    assertTrue(b.isEnabled);
  }

  function test_setBucketConfigsBatch() public {
    RelayUsdRateLimiter.BucketConfig[]
      memory configs = new RelayUsdRateLimiter.BucketConfig[](2);
    configs[0] = _config(CHAIN_ID, true, CAPACITY, RATE);
    configs[1] = _config(CHAIN_ID_2, true, 500_000e18, 5_000e18);

    vm.prank(owner);
    policy.setBucketConfigs(configs);

    assertEq(policy.getBucket(CHAIN_ID).tokens, CAPACITY);
    assertEq(policy.getBucket(CHAIN_ID_2).tokens, 500_000e18);
  }

  function test_reconfigLowerCapacityCapsTokens() public {
    _enable(CHAIN_ID, CAPACITY, RATE);

    uint128 lower = 100_000e18;
    vm.prank(owner);
    policy.setBucketConfig(_config(CHAIN_ID, true, lower, RATE));

    assertEq(
      policy.getBucket(CHAIN_ID).tokens,
      lower,
      "tokens capped to new capacity"
    );
  }

  function test_reconfigRefillsAtOldRateFirst() public {
    _enable(CHAIN_ID, CAPACITY, RATE);

    vm.prank(consumer);
    _consume(CHAIN_ID, CAPACITY);
    vm.warp(block.timestamp + 10); // +10s * RATE accrued at old rate

    vm.prank(owner);
    policy.setBucketConfig(_config(CHAIN_ID, true, CAPACITY, RATE * 2));

    assertEq(
      policy.getBucket(CHAIN_ID).tokens,
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
    policy.setBucketConfig(_config(CHAIN_ID, true, CAPACITY, RATE));
  }

  function test_configEmitsEvent() public {
    vm.expectEmit(true, false, false, true, address(policy));
    emit RelayUsdRateLimiter.BucketConfigSet(CHAIN_ID, true, CAPACITY, RATE);
    vm.prank(owner);
    policy.setBucketConfig(_config(CHAIN_ID, true, CAPACITY, RATE));
  }

  // ----------------------------------------------------------------------
  // Consume
  // ----------------------------------------------------------------------

  function test_consumeReducesTokens() public {
    _enable(CHAIN_ID, CAPACITY, RATE);

    vm.prank(consumer);
    _consume(CHAIN_ID, 250_000e18);

    assertEq(policy.getBucket(CHAIN_ID).tokens, CAPACITY - 250_000e18);
  }

  function test_perChainBudgetIsShared() public {
    _enable(CHAIN_ID, CAPACITY, RATE);

    // spend $600k on the chain
    vm.prank(consumer);
    _consume(CHAIN_ID, 600_000e18);

    // the chain now has only $400k of headroom, regardless of which currency priced it
    assertEq(policy.getBucket(CHAIN_ID).tokens, CAPACITY - 600_000e18);
  }

  function test_consumeEmitsEvent() public {
    _enable(CHAIN_ID, CAPACITY, RATE);

    vm.expectEmit(true, false, false, true, address(policy));
    emit RelayUsdRateLimiter.TokensConsumed(
      CHAIN_ID,
      250_000e18,
      CAPACITY - 250_000e18
    );
    vm.prank(consumer);
    _consume(CHAIN_ID, 250_000e18);
  }

  function test_consumeToZeroThenRateLimited() public {
    _enable(CHAIN_ID, CAPACITY, RATE);

    vm.prank(consumer);
    _consume(CHAIN_ID, CAPACITY); // drain exactly
    assertEq(policy.getBucket(CHAIN_ID).tokens, 0);

    // Over budget now => not consumed.
    vm.prank(consumer);
    assertFalse(_consume(CHAIN_ID, 1), "drained => not consumed");
  }

  function test_consumeMoreThanCapacityReturnsFalse() public {
    _enable(CHAIN_ID, CAPACITY, RATE);

    vm.prank(consumer);
    assertFalse(
      _consume(CHAIN_ID, uint256(CAPACITY) + 1),
      "over capacity => not consumed"
    );
  }

  function test_consumeZeroAmountFailsClosed() public {
    _enable(CHAIN_ID, CAPACITY, RATE);

    // Fail-closed: a 0 amount on an enabled bucket would otherwise consume nothing and always pass
    // (= unlimited fast). Reject it; nothing is consumed.
    vm.prank(consumer);
    assertFalse(_consume(CHAIN_ID, 0), "zero amount => not consumed");
    assertEq(policy.getBucket(CHAIN_ID).tokens, CAPACITY, "unchanged");
  }

  function test_consumePricesAmountThroughOracle() public {
    _enable(CHAIN_ID, CAPACITY, RATE);
    _setUsdPrice(TOKEN_ID, 2e8, 8, 6); // $2.00, 6-decimal token

    vm.prank(consumer);
    assertTrue(
      policy.consume(TOKEN_ID, 50_000e6, abi.encode(CHAIN_ID)),
      "priced amount consumed"
    );

    assertEq(
      policy.getBucket(CHAIN_ID).tokens,
      CAPACITY - 100_000e18,
      "50k tokens * $2"
    );
  }

  function test_consumeUsesTokenIdForPricing() public {
    _enable(CHAIN_ID, CAPACITY, RATE);
    _setUsdPrice(TOKEN_ID, 1e18, 18, 18);
    _setUsdPrice(TOKEN_ID_2, 5e18, 18, 18);

    vm.prank(consumer);
    assertTrue(policy.consume(TOKEN_ID_2, 10_000e18, abi.encode(CHAIN_ID)));

    assertEq(
      policy.getBucket(CHAIN_ID).tokens,
      CAPACITY - 50_000e18,
      "token id selects its price"
    );
  }

  function test_consumeZeroPricedValueFailsClosed() public {
    _enable(CHAIN_ID, CAPACITY, RATE);
    _setUsdPrice(TOKEN_ID, 0, 18, 18);

    vm.prank(consumer);
    assertFalse(_consume(CHAIN_ID, 1e18), "zero priced value => not consumed");
    assertEq(policy.getBucket(CHAIN_ID).tokens, CAPACITY, "unchanged");
  }

  function test_consumeOnUnconfiguredChainReturnsFalse() public {
    // Fail-closed: CHAIN_ID never configured => fast not enabled => not consumed (degrade to slow).
    vm.prank(consumer);
    assertFalse(
      _consume(CHAIN_ID, type(uint128).max),
      "unconfigured => not consumed"
    );
  }

  function test_consumeOnDisabledReturnsFalse() public {
    // Disabling a chain force-degrades its fast to slow (the kill-switch direction).
    vm.prank(owner);
    policy.setBucketConfig(_config(CHAIN_ID, false, CAPACITY, RATE));

    vm.prank(consumer);
    assertFalse(
      _consume(CHAIN_ID, type(uint128).max),
      "disabled => not consumed"
    );
  }

  function test_onlyConsumerCanConsume() public {
    _enable(CHAIN_ID, CAPACITY, RATE);

    vm.prank(otherAccounts[0]);
    vm.expectRevert(
      abi.encodeWithSelector(
        IAccessControl.AccessControlUnauthorizedAccount.selector,
        otherAccounts[0],
        consumerRole
      )
    );
    _consume(CHAIN_ID, 1);
  }

  // ----------------------------------------------------------------------
  // Rolling refill
  // ----------------------------------------------------------------------

  function test_refillOverTime() public {
    _enable(CHAIN_ID, CAPACITY, RATE);
    vm.prank(consumer);
    _consume(CHAIN_ID, CAPACITY); // empty

    vm.warp(block.timestamp + 30);
    assertEq(
      policy.getBucket(CHAIN_ID).tokens,
      uint256(RATE) * 30,
      "30s * rate accrued"
    );
  }

  function test_refillCapsAtCapacity() public {
    _enable(CHAIN_ID, CAPACITY, RATE);
    vm.prank(consumer);
    _consume(CHAIN_ID, CAPACITY);

    vm.warp(block.timestamp + 10_000_000); // way past full
    assertEq(
      policy.getBucket(CHAIN_ID).tokens,
      CAPACITY,
      "never exceeds capacity"
    );
  }

  function test_refillThenConsumeBoundary() public {
    _enable(CHAIN_ID, CAPACITY, RATE);
    vm.prank(consumer);
    _consume(CHAIN_ID, CAPACITY);

    vm.warp(block.timestamp + 5); // 5 * RATE available
    uint256 available = uint256(RATE) * 5;

    vm.prank(consumer);
    _consume(CHAIN_ID, available); // exactly drains the refill

    vm.prank(consumer);
    assertFalse(_consume(CHAIN_ID, 1), "refill drained => not consumed");
  }

  /// @dev A rejected consume after elapsed time must still persist the refill: advancing
  ///      `lastUpdated` without banking the accrued tokens would discard the accrual and let
  ///      repeated over-budget requests defeat the configured rate (grief the budget to ~0).
  function test_rejectedConsumeBanksRefill() public {
    _enable(CHAIN_ID, CAPACITY, RATE);
    vm.prank(consumer);
    _consume(CHAIN_ID, CAPACITY); // drain to 0

    vm.warp(block.timestamp + 5); // 5 * RATE accrued
    uint256 accrued = uint256(RATE) * 5;

    // Over-budget request is rejected but must NOT burn the accrued refill.
    vm.prank(consumer);
    assertFalse(_consume(CHAIN_ID, accrued + 1), "over budget => rejected");
    assertEq(
      policy.getBucket(CHAIN_ID).tokens,
      accrued,
      "refill banked despite rejection"
    );

    // The banked refill is spendable in the same block (no new accrual to mask it).
    vm.prank(consumer);
    assertTrue(_consume(CHAIN_ID, accrued), "banked refill spendable");
    assertEq(policy.getBucket(CHAIN_ID).tokens, 0);
  }

  // ----------------------------------------------------------------------
  // Views
  // ----------------------------------------------------------------------

  function test_getBucketIsLiveRefill() public {
    _enable(CHAIN_ID, CAPACITY, RATE);
    vm.prank(consumer);
    _consume(CHAIN_ID, CAPACITY);

    vm.warp(block.timestamp + 7);
    assertEq(policy.getBucket(CHAIN_ID).tokens, uint256(RATE) * 7);
  }

  // ----------------------------------------------------------------------
  // Roles
  // ----------------------------------------------------------------------

  function test_adminCanGrantConsumer() public {
    address newConsumer = makeAddr("newConsumer");
    vm.prank(owner);
    policy.grantRole(consumerRole, newConsumer);

    _enable(CHAIN_ID, CAPACITY, RATE);
    vm.prank(newConsumer);
    _consume(CHAIN_ID, 1); // no revert
    assertEq(policy.getBucket(CHAIN_ID).tokens, CAPACITY - 1);
  }

  // ----------------------------------------------------------------------
  // Fuzz
  // ----------------------------------------------------------------------

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

    _enable(CHAIN_ID, capacity, rate);
    vm.prank(consumer);
    _consume(CHAIN_ID, spent);
    vm.warp(block.timestamp + elapsed);

    assertLe(policy.getBucket(CHAIN_ID).tokens, capacity);
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

    _enable(CHAIN_ID, capacity, rate);
    vm.prank(consumer);
    _consume(CHAIN_ID, spent);
    vm.warp(block.timestamp + elapsed);

    uint256 expected = capacity - spent + uint256(rate) * elapsed;
    if (expected > capacity) {
      expected = capacity;
    }
    assertEq(policy.getBucket(CHAIN_ID).tokens, expected);
  }

  // ----------------------------------------------------------------------
  // Robustness
  // ----------------------------------------------------------------------

  /// @dev A no-refill bucket (rate == 0) drained then over-requested returns false cleanly, no panic.
  function test_zeroRateOverBudgetReturnsFalseCleanly() public {
    _enable(CHAIN_ID, CAPACITY, 0);
    vm.prank(consumer);
    _consume(CHAIN_ID, CAPACITY); // drain

    vm.prank(consumer);
    assertFalse(_consume(CHAIN_ID, 1), "zero-rate drained => not consumed");
  }

  function test_constructorRejectsZeroAdmin() public {
    vm.expectRevert(RelayUsdRateLimiter.ZeroAddress.selector);
    new RelayUsdRateLimiter(address(0), address(priceOracle));
  }

  function test_constructorRejectsZeroPriceOracle() public {
    vm.expectRevert(RelayUsdRateLimiter.ZeroAddress.selector);
    new RelayUsdRateLimiter(owner, address(0));
  }

  // ----------------------------------------------------------------------
  // IRateLimiter conformance
  // ----------------------------------------------------------------------

  /// @dev Usable polymorphically through IRateLimiter — the type the oracle allowlist calls.
  function test_consumesThroughIRateLimiterInterface() public {
    _enable(CHAIN_ID, CAPACITY, RATE);

    IRateLimiter limiter = IRateLimiter(address(policy));
    vm.prank(consumer);
    assertTrue(
      limiter.consume(TOKEN_ID, CAPACITY, abi.encode(CHAIN_ID)),
      "consume via IRateLimiter"
    );
    assertEq(policy.getBucket(CHAIN_ID).tokens, 0, "budget deducted");
  }

  // ----------------------------------------------------------------------
  // Pre-check (resolveCanConsume / resolveCanConsumeBatch)
  // ----------------------------------------------------------------------

  /// @dev Stateful because pricing verifies a report; asserts it still writes no bucket state.
  function test_resolveCanConsumeLeavesBucketUntouched() public {
    _enable(CHAIN_ID, CAPACITY, RATE);
    RelayUsdRateLimiter.TokenBucket memory before = policy.getBucket(CHAIN_ID);

    assertTrue(policy.resolveCanConsume(TOKEN_ID, 1e18, abi.encode(CHAIN_ID)));

    RelayUsdRateLimiter.TokenBucket memory after_ = policy.getBucket(CHAIN_ID);
    assertEq(after_.tokens, before.tokens, "tokens unchanged");
    assertEq(after_.capacity, before.capacity, "capacity unchanged");
  }

  function test_resolveCanConsumeRejectsDisabledChain() public {
    assertFalse(policy.resolveCanConsume(TOKEN_ID, 1e18, abi.encode(CHAIN_ID)));
  }

  function test_resolveCanConsumeRejectsZeroAmount() public {
    _enable(CHAIN_ID, CAPACITY, RATE);
    assertFalse(policy.resolveCanConsume(TOKEN_ID, 0, abi.encode(CHAIN_ID)));
  }

  /// @dev An unpriced token id prices to zero — fail closed rather than consume nothing.
  function test_resolveCanConsumeRejectsUnpricedToken() public {
    _enable(CHAIN_ID, CAPACITY, RATE);
    assertFalse(policy.resolveCanConsume(999, 1e18, abi.encode(CHAIN_ID)));
  }

  function test_resolveCanConsumeRejectsAboveCapacity() public {
    _enable(CHAIN_ID, CAPACITY, RATE);
    assertFalse(
      policy.resolveCanConsume(TOKEN_ID, CAPACITY + 1, abi.encode(CHAIN_ID))
    );
  }

  /// @dev Drain the bucket, then the same amount that just fit no longer does, and refills back.
  function test_resolveCanConsumeTracksDrainAndRefill() public {
    _enable(CHAIN_ID, CAPACITY, RATE);
    vm.prank(consumer);
    policy.consume(TOKEN_ID, CAPACITY, abi.encode(CHAIN_ID));

    assertFalse(
      policy.resolveCanConsume(TOKEN_ID, 1e18, abi.encode(CHAIN_ID)),
      "drained"
    );
    vm.warp(block.timestamp + 1);
    assertTrue(
      policy.resolveCanConsume(TOKEN_ID, 1e18, abi.encode(CHAIN_ID)),
      "refilled"
    );
  }

  /// @dev The gap a per-message pre-check cannot see: two amounts that each fit, but not together.
  function test_resolveCanConsumeBatchCatchesCumulativeOverBudget() public {
    uint128 capacity = 100e18;
    _enable(CHAIN_ID, capacity, 0);

    uint256[] memory tokenIds = new uint256[](2);
    uint256[] memory amounts = new uint256[](2);
    tokenIds[0] = TOKEN_ID;
    tokenIds[1] = TOKEN_ID_2;
    amounts[0] = 60e18;
    amounts[1] = 60e18;

    assertTrue(
      policy.resolveCanConsume(TOKEN_ID, 60e18, abi.encode(CHAIN_ID)),
      "each fits alone"
    );
    assertFalse(
      policy.resolveCanConsumeBatch(tokenIds, amounts, abi.encode(CHAIN_ID)),
      "but not together"
    );

    amounts[1] = 40e18;
    assertTrue(
      policy.resolveCanConsumeBatch(tokenIds, amounts, abi.encode(CHAIN_ID)),
      "exactly capacity fits"
    );
  }

  function test_resolveCanConsumeBatchRevertsOnLengthMismatch() public {
    _enable(CHAIN_ID, CAPACITY, RATE);
    uint256[] memory tokenIds = new uint256[](2);
    uint256[] memory amounts = new uint256[](1);

    vm.expectRevert();
    policy.resolveCanConsumeBatch(tokenIds, amounts, abi.encode(CHAIN_ID));
  }

  function test_resolveCanConsumeBatchRejectsEmpty() public {
    _enable(CHAIN_ID, CAPACITY, RATE);
    assertFalse(
      policy.resolveCanConsumeBatch(
        new uint256[](0),
        new uint256[](0),
        abi.encode(CHAIN_ID)
      )
    );
  }

  /// @dev The drift guard: whatever the bucket state and amount, the pre-check must predict exactly
  ///      what `consume` then does. Snapshot/revert so the probe cannot influence the real call.
  function testFuzz_resolveCanConsumeMatchesConsume(
    uint128 amount,
    uint128 capacity,
    uint128 rate,
    uint32 elapsed
  ) public {
    capacity = uint128(bound(capacity, 1, 1_000_000_000e18));
    rate = uint128(bound(rate, 0, 1_000_000e18));
    amount = uint128(bound(amount, 0, capacity * 2));
    _enable(CHAIN_ID, capacity, rate);
    vm.warp(block.timestamp + bound(elapsed, 0, 3600));

    bool predicted = policy.resolveCanConsume(
      TOKEN_ID,
      amount,
      abi.encode(CHAIN_ID)
    );

    uint256 snap = vm.snapshotState();
    vm.prank(consumer);
    bool actual = policy.consume(TOKEN_ID, amount, abi.encode(CHAIN_ID));
    vm.revertToState(snap);

    assertEq(predicted, actual, "pre-check must match consume");
  }
}
