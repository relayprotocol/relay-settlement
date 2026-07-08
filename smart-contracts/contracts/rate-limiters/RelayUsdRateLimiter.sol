// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {SafeCastLib} from "solady/utils/SafeCastLib.sol";
import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";
import {IRateLimiter} from "./IRateLimiter.sol";

/// @title RelayUsdRateLimiter
/// @author Relay Protocol
/// @notice Per-chain token-bucket rate limiter. It caps the RATE at which USD-denominated value can
///         be consumed per chain — it is NOT a flat ceiling: over a window T, peak in-flight
///         consumption is ~ capacity + rate*T. Size `rate` accordingly (e.g. rate <= capacity /
///         (k * T)). One bucket per chain; all consumption on a chain shares the budget.
/// @dev    Budget is USD scaled by USD_DECIMALS. The USD value is priced off-chain by the caller and
///         passed in — there is no on-chain pricing. `consume` decodes (chainId, usdValue) from the
///         opaque `data` the oracle passes. The bucket key is the raw `chainId` string with no
///         normalization — config and callers MUST use one canonical chainId form, else a lookup miss
///         returns false. Fail-closed: consumption requires an enabled bucket AND a nonzero usdValue;
///         an unconfigured/disabled chain (or a zero usdValue) returns false. "Unlimited" = a
///         deliberately high capacity. Implements the generic `IRateLimiter`, so it is a drop-in
///         behind RelayOracleV2's limiter allowlist with no oracle/SDK change.
contract RelayUsdRateLimiter is AccessControl, IRateLimiter {
  using SafeCastLib for uint256;

  // Structs

  /// @notice Live token-bucket state for one chain (USD, scaled by USD_DECIMALS)
  struct TokenBucket {
    uint128 tokens; // available USD budget, as of `lastUpdated`
    uint32 lastUpdated; // unix seconds of the last refill checkpoint
    bool isEnabled; // false => not enabled for this chain (consume returns false)
    uint128 capacity; // max USD budget / burst size
    uint128 rate; // USD refilled per second
  }

  /// @notice Admin-supplied bucket configuration for one chain
  struct BucketConfig {
    string chainId;
    bool isEnabled;
    uint128 capacity;
    uint128 rate;
  }

  // Roles

  /// @notice Administers configuration and role grants
  bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

  /// @notice May consume budget (granted to the consumer contract)
  bytes32 public constant CONSUMER_ROLE = keccak256("CONSUMER_ROLE");

  // Constants

  /// @notice Fixed-point precision the bucket budget (tokens/capacity/rate) is denominated in
  uint256 public constant USD_DECIMALS = 18;

  // Fields

  /// @notice Token-bucket state keyed by keccak256(chainId)
  mapping(bytes32 => TokenBucket) private chainBuckets;

  // Events

  /// @notice Emitted when budget is consumed
  /// @param chainId Origin chain id
  /// @param usdAmount USD value consumed (scaled by USD_DECIMALS)
  /// @param remaining USD budget left after consumption
  event TokensConsumed(
    string indexed chainId,
    uint256 usdAmount,
    uint256 remaining
  );

  /// @notice Emitted when a chain bucket is (re)configured
  /// @param chainId Origin chain id
  /// @param isEnabled Whether the bucket rate-limits
  /// @param capacity Max USD budget (scaled by USD_DECIMALS)
  /// @param rate USD refilled per second (scaled by USD_DECIMALS)
  event BucketConfigSet(
    string indexed chainId,
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

  /// @notice Try to consume USD budget for a fast deposit; returns whether it was consumed.
  /// @dev Authoritative, trustless enforcement. Does NOT revert on rejection: the caller owns the
  ///      revert decision so it can carry its own context. Returns false (no deduct) when the budget
  ///      is unavailable — disabled chain, zero usdValue, or over budget (fail-closed). A zero
  ///      usdValue is rejected (NOT a no-op): with no on-chain pricing, a 0 on an enabled bucket
  ///      would consume nothing and always pass = unlimited. A caller's accept/reject choice must
  ///      NOT depend on live budget (see canConsume).
  /// @param data abi.encode(string chainId, uint256 usdValue) — the oracle constructs it; usdValue is
  ///        off-chain priced (trusted), chainId is the attested origin chain.
  /// @return consumed True if the budget was consumed; false otherwise
  function consume(
    bytes calldata data
  ) external override onlyRole(CONSUMER_ROLE) returns (bool consumed) {
    (string memory chainId, uint256 usdValue) = abi.decode(
      data,
      (string, uint256)
    );
    TokenBucket storage bucket = chainBuckets[_chainKey(chainId)];
    if (!bucket.isEnabled) {
      // Fail-closed: requires an explicitly enabled budget; otherwise return false.
      return false;
    }
    if (usdValue == 0) {
      // Fail-closed: a zero usdValue on an enabled bucket would otherwise consume nothing and always
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
    if (capacity < usdValue || tokens < usdValue) {
      return false;
    }

    unchecked {
      tokens -= usdValue;
    }
    bucket.tokens = tokens.toUint128();
    emit TokensConsumed(chainId, usdValue, tokens);
    return true;
  }

  // Admin methods

  /// @notice Configures a single chain bucket
  /// @param config Bucket configuration
  function setBucketConfig(
    BucketConfig calldata config
  ) external onlyRole(ADMIN_ROLE) {
    _setBucketConfig(config);
  }

  /// @notice Configures many chain buckets in one call (e.g. seeding the threshold table)
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

  /// @notice Advisory check of whether `consume` would currently succeed for `usdValue`.
  /// @dev ADVISORY ONLY. MUST NOT gate a decision that needs to be deterministic across independent
  ///      callers: it reads mutable shared state they would read inconsistently. On-chain consume()
  ///      is the authoritative enforcement.
  /// @param chainId Chain id (raw)
  /// @param usdValue USD value that would be consumed (scaled by USD_DECIMALS)
  /// @return ok True if it would currently succeed; false when the chain is disabled, the usdValue
  ///         is zero, or it is over budget
  function canConsume(
    string calldata chainId,
    uint256 usdValue
  ) external view returns (bool ok) {
    TokenBucket storage bucket = chainBuckets[_chainKey(chainId)];
    if (!bucket.isEnabled) {
      return false;
    }
    if (usdValue == 0) {
      return false;
    }
    if (bucket.capacity < usdValue) {
      return false;
    }
    return _refilledTokens(bucket) >= usdValue;
  }

  /// @notice Returns the live (refilled) bucket state for a chain without mutating storage. The
  ///         struct carries `isEnabled`: when false, the chain is disabled (consume returns false).
  /// @param chainId Origin chain id
  /// @return bucket Refilled bucket as of `block.timestamp`
  function getBucket(
    string calldata chainId
  ) external view returns (TokenBucket memory bucket) {
    bucket = chainBuckets[_chainKey(chainId)];
    if (bucket.isEnabled) {
      bucket.tokens = _refilledTokens(bucket).toUint128();
      bucket.lastUpdated = block.timestamp.toUint32();
    }
  }

  // Internal methods

  /// @notice Bucket key for a chain
  /// @return key Storage key for the chain's bucket
  function _chainKey(
    string memory chainId
  ) internal pure returns (bytes32 key) {
    return keccak256(bytes(chainId));
  }

  /// @notice (Re)configures a bucket; new buckets start full, existing ones refill then cap to new capacity
  /// @param config Bucket configuration
  function _setBucketConfig(BucketConfig calldata config) internal {
    TokenBucket storage bucket = chainBuckets[_chainKey(config.chainId)];

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
