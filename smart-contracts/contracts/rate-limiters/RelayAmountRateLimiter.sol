// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {SafeCastLib} from "solady/utils/SafeCastLib.sol";
import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";
import {IRateLimiter} from "./IRateLimiter.sol";

/// @title RelayAmountRateLimiter
/// @author Relay Protocol
/// @notice Per-(chain, currency) token-bucket rate limiter. It caps the RATE at which a currency's
///         amount can be consumed on a chain — it is NOT a flat ceiling: over a window T, peak
///         in-flight consumption is ~ capacity + rate*T. Size `rate` accordingly (e.g. rate <=
///         capacity / (k * T)). One bucket per (chain, currency); each currency on a chain has its
///         own budget.
/// @dev    Budget is denominated in the currency's own base units — there is no USD pricing and no
///         decimal normalization, since each bucket holds a single currency. `consume` decodes
///         (chainId, currency, amount) from the opaque `data` the oracle passes; there is no on-chain
///         price read. The bucket key is keccak256(chainId, currency) (= the hub token id); config and
///         callers MUST use one canonical (chainId, currency) form, else a lookup miss returns false.
///         Fail-closed: consumption requires an enabled bucket AND a nonzero amount; an
///         unconfigured/disabled (chain, currency) — or a zero amount — returns false. "Unlimited" =
///         a deliberately high capacity. Implements the generic `IRateLimiter`, so a different limiter
///         is a drop-in behind RelayOracleV2's limiter allowlist with no oracle/SDK change.
contract RelayAmountRateLimiter is AccessControl, IRateLimiter {
  using SafeCastLib for uint256;

  // Structs

  /// @notice Live token-bucket state for one (chain, currency), in the currency's base units
  struct TokenBucket {
    uint128 tokens; // available budget (base units), as of `lastUpdated`
    uint32 lastUpdated; // unix seconds of the last refill checkpoint
    bool isEnabled; // false => not enabled for this (chain, currency) (consume returns false)
    uint128 capacity; // max budget / burst size (base units)
    uint128 rate; // base units refilled per second
  }

  /// @notice Admin-supplied bucket configuration for one (chain, currency)
  struct BucketConfig {
    string chainId;
    bytes currency;
    bool isEnabled;
    uint128 capacity;
    uint128 rate;
  }

  // Roles

  /// @notice Administers configuration and role grants
  bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

  /// @notice May consume budget (granted to the consumer contract)
  bytes32 public constant CONSUMER_ROLE = keccak256("CONSUMER_ROLE");

  // Fields

  /// @notice Token-bucket state keyed by keccak256(abi.encodePacked(chainId, currency))
  mapping(bytes32 => TokenBucket) private buckets;

  // Events

  /// @notice Emitted when budget is consumed
  /// @param chainId Origin chain id
  /// @param currency Origin currency (raw, VM-specific bytes)
  /// @param amount Amount consumed (currency base units)
  /// @param remaining Budget left after consumption (base units)
  event TokensConsumed(
    string indexed chainId,
    bytes currency,
    uint256 amount,
    uint256 remaining
  );

  /// @notice Emitted when a (chain, currency) bucket is (re)configured
  /// @param chainId Origin chain id
  /// @param currency Origin currency (raw, VM-specific bytes)
  /// @param isEnabled Whether the bucket rate-limits
  /// @param capacity Max budget (base units)
  /// @param rate Base units refilled per second
  event BucketConfigSet(
    string indexed chainId,
    bytes currency,
    bool isEnabled,
    uint128 capacity,
    uint128 rate
  );

  // Errors

  /// @notice Thrown when a required address argument is zero
  error ZeroAddress();

  // Constructor

  /// @notice Creates the rate limiter
  /// @param admin Address granted ADMIN_ROLE
  constructor(address admin) {
    if (admin == address(0)) {
      revert ZeroAddress();
    }
    _setRoleAdmin(ADMIN_ROLE, ADMIN_ROLE);
    _setRoleAdmin(CONSUMER_ROLE, ADMIN_ROLE);
    _grantRole(ADMIN_ROLE, admin);
  }

  // Consumer methods

  /// @notice Try to consume budget for a fast deposit; returns whether it was consumed.
  /// @dev Authoritative, trustless enforcement. Does NOT revert on rejection: the caller owns the
  ///      revert decision so it can carry its own context. Returns false (no deduct) when the budget
  ///      is unavailable — disabled (chain, currency), zero amount, or over budget (fail-closed). A
  ///      zero amount is rejected (NOT a no-op): it would otherwise consume nothing and always pass
  ///      (= unlimited). A caller's accept/reject choice must NOT depend on live budget (see
  ///      canConsume).
  /// @param data abi.encode(string chainId, bytes currency, uint256 amount) — the oracle constructs
  ///        it; (chainId, currency) are trusted attested values, amount is the at-risk deposit amount.
  /// @return consumed True if the budget was consumed; false otherwise
  function consume(
    bytes calldata data
  ) external override onlyRole(CONSUMER_ROLE) returns (bool consumed) {
    (string memory chainId, bytes memory currency, uint256 amount) = abi.decode(
      data,
      (string, bytes, uint256)
    );
    TokenBucket storage bucket = buckets[_bucketKey(chainId, currency)];
    if (!bucket.isEnabled) {
      // Fail-closed: requires an explicitly enabled budget; otherwise return false.
      return false;
    }
    if (amount == 0) {
      // Fail-closed: a zero amount on an enabled bucket would otherwise consume nothing and always
      // pass (= unlimited). Reject it.
      return false;
    }

    uint256 tokens = bucket.tokens;
    uint256 capacity = bucket.capacity;
    uint256 rate = bucket.rate;
    uint256 timeDiff = block.timestamp - bucket.lastUpdated;
    if (timeDiff != 0) {
      // Invariant guard (unreachable: every writer keeps tokens <= capacity, and _calculateRefill
      // caps regardless) — fall back rather than proceed if it were ever violated.
      if (tokens > capacity) {
        return false;
      }
      tokens = _calculateRefill(capacity, tokens, timeDiff, rate);
      // Persist the refill checkpoint (tokens + lastUpdated together): advancing lastUpdated alone
      // would discard the accrual if the request below is rejected, defeating the configured rate.
      bucket.lastUpdated = block.timestamp.toUint32();
      bucket.tokens = tokens.toUint128();
    }

    // Single request larger than capacity, or not enough budget right now → return false.
    if (capacity < amount || tokens < amount) {
      return false;
    }

    unchecked {
      tokens -= amount;
    }
    bucket.tokens = tokens.toUint128();
    emit TokensConsumed(chainId, currency, amount, tokens);
    return true;
  }

  // Admin methods

  /// @notice Configures a single (chain, currency) bucket
  /// @param config Bucket configuration
  function setBucketConfig(
    BucketConfig calldata config
  ) external onlyRole(ADMIN_ROLE) {
    _setBucketConfig(config);
  }

  /// @notice Configures many (chain, currency) buckets in one call (e.g. seeding the threshold table)
  /// @param configs Bucket configurations
  function setBucketConfigs(
    BucketConfig[] calldata configs
  ) external onlyRole(ADMIN_ROLE) {
    uint256 length = configs.length;
    for (uint256 i; i < length; ++i) {
      _setBucketConfig(configs[i]);
    }
  }

  // View methods

  /// @notice Advisory check of whether `consume` would currently succeed for `amount`.
  /// @dev ADVISORY ONLY. MUST NOT gate a decision that needs to be deterministic across independent
  ///      callers: it reads mutable shared state they would read inconsistently. On-chain consume()
  ///      is the authoritative enforcement.
  /// @param chainId Chain id (raw)
  /// @param currency Currency (raw, VM-specific bytes)
  /// @param amount Amount that would be consumed (currency base units)
  /// @return ok True if it would currently succeed; false when the (chain, currency) is disabled, the
  ///         amount is zero, or it is over budget
  function canConsume(
    string calldata chainId,
    bytes calldata currency,
    uint256 amount
  ) external view returns (bool ok) {
    TokenBucket storage bucket = buckets[_bucketKey(chainId, currency)];
    if (!bucket.isEnabled) {
      return false;
    }
    if (amount == 0) {
      return false;
    }
    if (bucket.capacity < amount) {
      return false;
    }
    return _refilledTokens(bucket) >= amount;
  }

  /// @notice Returns the live (refilled) bucket state for a (chain, currency) without mutating
  ///         storage. The struct carries `isEnabled`: when false, the bucket is disabled (consume
  ///         returns false).
  /// @param chainId Origin chain id
  /// @param currency Origin currency (raw, VM-specific bytes)
  /// @return bucket Refilled bucket as of `block.timestamp`
  function getBucket(
    string calldata chainId,
    bytes calldata currency
  ) external view returns (TokenBucket memory bucket) {
    bucket = buckets[_bucketKey(chainId, currency)];
    if (bucket.isEnabled) {
      bucket.tokens = _refilledTokens(bucket).toUint128();
      bucket.lastUpdated = block.timestamp.toUint32();
    }
  }

  // Internal methods

  /// @notice Bucket key for a (chain, currency)
  /// @return key Storage key for the bucket
  function _bucketKey(
    string memory chainId,
    bytes memory currency
  ) internal pure returns (bytes32 key) {
    return keccak256(abi.encodePacked(chainId, currency));
  }

  /// @notice (Re)configures a bucket; new buckets start full, existing ones refill then cap to new capacity
  /// @param config Bucket configuration
  function _setBucketConfig(BucketConfig calldata config) internal {
    TokenBucket storage bucket = buckets[
      _bucketKey(config.chainId, config.currency)
    ];

    if (bucket.lastUpdated == 0) {
      // First configuration: start full so budget is immediately available up to capacity.
      bucket.tokens = config.capacity;
    } else {
      // Refill at the OLD rate up to now (a rate change is not retroactive), then cap to new capacity.
      uint256 timeDiff = block.timestamp - bucket.lastUpdated;
      if (timeDiff != 0) {
        bucket.tokens = _calculateRefill(
          bucket.capacity,
          bucket.tokens,
          timeDiff,
          bucket.rate
        ).toUint128();
      }
      bucket.tokens = FixedPointMathLib
        .min(config.capacity, bucket.tokens)
        .toUint128();
    }

    bucket.lastUpdated = block.timestamp.toUint32();
    bucket.isEnabled = config.isEnabled;
    bucket.capacity = config.capacity;
    bucket.rate = config.rate;

    emit BucketConfigSet(
      config.chainId,
      config.currency,
      config.isEnabled,
      config.capacity,
      config.rate
    );
  }

  /// @notice Live token balance of a bucket as of `block.timestamp` (does not mutate)
  /// @return tokens Refilled token balance as of `block.timestamp`
  function _refilledTokens(
    TokenBucket memory bucket
  ) private view returns (uint256 tokens) {
    return
      _calculateRefill(
        bucket.capacity,
        bucket.tokens,
        block.timestamp - bucket.lastUpdated,
        bucket.rate
      );
  }

  /// @notice Rolling refill: current tokens plus elapsed-time accrual, capped at capacity
  /// @return refilled Token balance after accrual, capped at capacity
  function _calculateRefill(
    uint256 capacity,
    uint256 tokens,
    uint256 timeDiff,
    uint256 rate
  ) private pure returns (uint256 refilled) {
    return FixedPointMathLib.min(capacity, tokens + timeDiff * rate);
  }
}
