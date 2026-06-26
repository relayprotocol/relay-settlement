// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../utils/BaseTest.sol";
import {Eip712} from "../utils/Eip712.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";

import {RelayHub} from "../../contracts/RelayHub.sol";
import {RelayOracle} from "../../contracts/RelayOracle.sol";
import {RelayOracleV2} from "../../contracts/RelayOracleV2.sol";
import {RelayFastRateLimiter} from "../../contracts/RelayFastRateLimiter.sol";

/// @notice Scenario coverage for RelayOracleV2's FAST_MINT action: fee/input split (incl. dust),
///         rate-limit integration (consume the off-chain-priced usdValue; revert leaves no key →
///         slow re-attest), fail-closed paths (limiter unset, fast disabled, zero usdValue, bad
///         fee), dual-key dedup against the old oracle, MINT/BURN/TRANSFER parity, split-inv fuzz.
contract RelayOracleV2Test is BaseTest {
  RelayHub internal hub;
  RelayOracle internal oldOracle;
  RelayOracleV2 internal v2;
  RelayFastRateLimiter internal limiter;

  address internal admin;
  address internal oracleSigner;
  uint256 internal oracleSignerPk;
  address internal orderAddr;
  address internal feeRecipient;
  address internal otherAddr;

  bytes32 internal v2Domain;
  bytes32 internal oldDomain;

  // EIP-712 typehash matching contracts/RelayOracleV2.sol (same as RelayOracle)
  bytes32 internal constant EXECUTION_TYPEHASH =
    keccak256("Execution(bytes32 idempotencyKey,bytes[] actions)");

  string internal constant CHAIN_ID = "8453"; // base
  // 8-dec currency priced at identity $1 => usdValue(amount) == amount
  bytes internal constant CURRENCY =
    hex"833589fcd6edb6e08f4c7c32d4f71b54bda02913";

  function setUp() public override {
    super.setUp();
    vm.warp(1_700_000_000);

    admin = owner;
    (oracleSigner, oracleSignerPk) = makeAddrAndKey("oracleSigner");
    orderAddr = makeAddr("orderAddr");
    feeRecipient = makeAddr("feeRecipient");
    otherAddr = makeAddr("otherAddr");

    hub = new RelayHub(admin);
    oldOracle = new RelayOracle(admin, address(hub));
    v2 = new RelayOracleV2(admin, address(hub), address(oldOracle));

    limiter = new RelayFastRateLimiter(admin);

    bytes32 operatorRole = hub.OPERATOR_ROLE();
    vm.startPrank(admin);
    hub.grantRole(operatorRole, address(v2));
    hub.grantRole(operatorRole, address(oldOracle));
    v2.grantRole(v2.ORACLE_ROLE(), oracleSigner);
    oldOracle.grantRole(oldOracle.ORACLE_ROLE(), oracleSigner);
    limiter.grantRole(limiter.CONSUMER_ROLE(), address(v2));
    limiter.setBucketConfig(
      RelayFastRateLimiter.BucketConfig({
        chainId: CHAIN_ID,
        isEnabled: true,
        capacity: type(uint128).max,
        rate: 0
      })
    );
    v2.setRateLimiter(address(limiter));
    vm.stopPrank();

    v2Domain = Eip712.domainSeparator(
      "RelayOracle",
      "2",
      block.chainid,
      address(v2)
    );
    oldDomain = Eip712.domainSeparator(
      "RelayOracle",
      "1",
      block.chainid,
      address(oldOracle)
    );
  }

  // Helpers

  function _tokenId(
    string memory chainId,
    bytes memory currency
  ) internal pure returns (uint256) {
    return uint256(keccak256(abi.encodePacked(chainId, currency)));
  }

  function _mintAction(
    address hubToAddress,
    uint256 hubTokenId,
    uint256 amount
  ) internal pure returns (bytes memory) {
    return
      abi.encode(
        uint8(RelayOracleV2.ActionType.MINT),
        hubToAddress,
        hubTokenId,
        amount
      );
  }

  function _burnAction(
    address hubFromAddress,
    uint256 hubTokenId,
    uint256 amount
  ) internal pure returns (bytes memory) {
    return
      abi.encode(
        uint8(RelayOracleV2.ActionType.BURN),
        hubFromAddress,
        hubTokenId,
        amount
      );
  }

  function _transferAction(
    address hubFromAddress,
    address hubToAddress,
    uint256 hubTokenId,
    uint256 amount
  ) internal pure returns (bytes memory) {
    return
      abi.encode(
        uint8(RelayOracleV2.ActionType.TRANSFER),
        hubFromAddress,
        hubToAddress,
        hubTokenId,
        amount
      );
  }

  function _fastMintAction(
    address hubToAddress,
    string memory chainId,
    bytes memory currency,
    uint256 amount,
    uint256 feeBps,
    address recipient
  ) internal pure returns (bytes memory) {
    // Default usdValue = amount (nonzero so the limiter consumes; a zero usdValue is rejected).
    return
      _fastMintActionUsd(
        hubToAddress,
        chainId,
        currency,
        amount,
        feeBps,
        recipient,
        amount
      );
  }

  function _fastMintActionUsd(
    address hubToAddress,
    string memory chainId,
    bytes memory currency,
    uint256 amount,
    uint256 feeBps,
    address recipient,
    uint256 usdValue
  ) internal pure returns (bytes memory) {
    // The action carries the hub token id (both mint legs use it) + chainId (limiter bucket key);
    // currency is just the test's convenience input to derive the same token id the oracle would.
    return
      abi.encode(
        uint8(RelayOracleV2.ActionType.FAST_MINT),
        hubToAddress,
        _tokenId(chainId, currency),
        chainId,
        amount,
        feeBps,
        recipient,
        usdValue
      );
  }

  function _sign(
    uint256 pk,
    bytes32 domain,
    bytes32 idempotencyKey,
    bytes[] memory actions
  ) internal pure returns (bytes memory) {
    bytes32[] memory actionHashes = new bytes32[](actions.length);
    for (uint256 i = 0; i < actions.length; i++) {
      actionHashes[i] = keccak256(actions[i]);
    }
    bytes32 structHash = keccak256(
      abi.encode(
        EXECUTION_TYPEHASH,
        idempotencyKey,
        keccak256(abi.encodePacked(actionHashes))
      )
    );
    return Eip712.sign(pk, domain, structHash);
  }

  function _v2Exec(
    bytes32 idempotencyKey,
    bytes[] memory actions
  ) internal pure returns (RelayOracleV2.Execution memory) {
    return
      RelayOracleV2.Execution({
        idempotencyKey: idempotencyKey,
        actions: actions
      });
  }

  function _runFast(bytes32 idempotencyKey, bytes[] memory actions) internal {
    bytes memory sig = _sign(oracleSignerPk, v2Domain, idempotencyKey, actions);
    v2.execute(_v2Exec(idempotencyKey, actions), oracleSigner, sig);
  }

  // FAST_MINT — split

  function test_fastMint_splitsFeeAndInput() public {
    bytes32 key = keccak256("fast-split");
    uint256 amount = 100e8; // 1% fee → 1 fee, 99 order input
    uint256 feeBps = 1e16; // 1% (1e16 / 1e18)
    uint256 tokenId = _tokenId(CHAIN_ID, CURRENCY);

    bytes[] memory actions = new bytes[](1);
    actions[0] = _fastMintAction(
      orderAddr,
      CHAIN_ID,
      CURRENCY,
      amount,
      feeBps,
      feeRecipient
    );

    vm.expectEmit(true, false, false, true, address(v2));
    emit RelayOracleV2.Executed(key, actions);

    _runFast(key, actions);

    uint256 fee = 1e8; // 100e8 * 1e16 / 1e18
    assertEq(hub.balanceOf(feeRecipient, tokenId), fee);
    assertEq(hub.balanceOf(orderAddr, tokenId), amount - fee);
    assertEq(
      hub.balanceOf(feeRecipient, tokenId) + hub.balanceOf(orderAddr, tokenId),
      amount
    );
    assertTrue(v2.isExecuted(key));
  }

  function test_fastMint_emitsFastMintEvent() public {
    bytes32 key = keccak256("fast-event");
    uint256 amount = 100e8;
    uint256 feeBps = 1e16; // 1%

    bytes[] memory actions = new bytes[](1);
    actions[0] = _fastMintAction(
      orderAddr,
      CHAIN_ID,
      CURRENCY,
      amount,
      feeBps,
      feeRecipient
    );

    // Observability only — settlement uses the attested order input directly, not this event.
    vm.expectEmit(true, false, false, true, address(v2));
    emit RelayOracleV2.FastMint(
      key,
      orderAddr,
      _tokenId(CHAIN_ID, CURRENCY),
      amount,
      feeBps,
      feeRecipient
    );

    _runFast(key, actions);
  }

  function test_fastMint_zeroFee_allToInput() public {
    bytes32 key = keccak256("fast-zero-fee");
    uint256 amount = 50e8;
    uint256 tokenId = _tokenId(CHAIN_ID, CURRENCY);

    bytes[] memory actions = new bytes[](1);
    // recipient == 0 is allowed when feeBps == 0 (free fast)
    actions[0] = _fastMintAction(
      orderAddr,
      CHAIN_ID,
      CURRENCY,
      amount,
      0,
      address(0)
    );

    _runFast(key, actions);

    assertEq(hub.balanceOf(orderAddr, tokenId), amount);
    assertEq(hub.balanceOf(feeRecipient, tokenId), 0);
  }

  function test_fastMint_maxFeeRate_allToFee() public {
    bytes32 key = keccak256("fast-max-fee-rate");
    uint256 amount = 60e8; // 100% fee → all to fee, zero order input
    uint256 tokenId = _tokenId(CHAIN_ID, CURRENCY);

    bytes[] memory actions = new bytes[](1);
    actions[0] = _fastMintAction(
      orderAddr,
      CHAIN_ID,
      CURRENCY,
      amount,
      1e18, // 100% (= BPS_DENOMINATOR, the max allowed)
      feeRecipient
    );

    _runFast(key, actions);

    assertEq(hub.balanceOf(feeRecipient, tokenId), amount);
    assertEq(hub.balanceOf(orderAddr, tokenId), 0);
  }

  function test_fastMint_feeRoundsDown_noDust() public {
    bytes32 key = keccak256("fast-dust");
    uint256 amount = 1e18 + 7; // not divisible by the fee rate
    uint256 feeBps = 333e13; // 0.333% (333e13 / 1e18)
    uint256 fee = FixedPointMathLib.fullMulDiv(amount, feeBps, 1e18);
    uint256 orderInput = amount - fee;
    uint256 tokenId = _tokenId(CHAIN_ID, CURRENCY);

    bytes[] memory actions = new bytes[](1);
    actions[0] = _fastMintAction(
      orderAddr,
      CHAIN_ID,
      CURRENCY,
      amount,
      feeBps,
      feeRecipient
    );

    _runFast(key, actions);

    assertEq(hub.balanceOf(feeRecipient, tokenId), fee);
    assertEq(hub.balanceOf(orderAddr, tokenId), orderInput);
    // no dust: the two mints reconstruct the full amount exactly
    assertEq(
      hub.balanceOf(feeRecipient, tokenId) + hub.balanceOf(orderAddr, tokenId),
      amount
    );
  }

  // FAST_MINT — rate limiter integration

  function test_fastMint_consumesProvidedUsdValue() public {
    RelayFastRateLimiter.TokenBucket memory before_ = limiter.getBucket(
      CHAIN_ID
    );

    bytes32 key = keccak256("fast-consume");
    uint256 amount = 101e8; // 100 order input + 1 fee
    uint256 usdValue = 50e8; // off-chain-priced value, independent of the gross amount
    bytes[] memory actions = new bytes[](1);
    actions[0] = _fastMintActionUsd(
      orderAddr,
      CHAIN_ID,
      CURRENCY,
      amount,
      100, // fee does NOT change what is consumed
      feeRecipient,
      usdValue
    );

    _runFast(key, actions);

    RelayFastRateLimiter.TokenBucket memory after_ = limiter.getBucket(
      CHAIN_ID
    );
    // The limiter consumes exactly the off-chain-priced usdValue carried in the action.
    assertEq(before_.tokens - after_.tokens, usdValue);
    // The mint still splits on the gross amount.
    assertEq(
      hub.balanceOf(orderAddr, _tokenId(CHAIN_ID, CURRENCY)) +
        hub.balanceOf(feeRecipient, _tokenId(CHAIN_ID, CURRENCY)),
      amount
    );
  }

  function test_fastMint_overBudget_reverts_leavesNoKey_slowReattestWorks()
    public
  {
    // Shrink the bucket so the request exceeds capacity outright.
    vm.prank(admin);
    limiter.setBucketConfig(
      RelayFastRateLimiter.BucketConfig({
        chainId: CHAIN_ID,
        isEnabled: true,
        capacity: 1e8, // $1
        rate: 0
      })
    );

    bytes32 key = keccak256("fast-overbudget");
    uint256 amount = 1000e8; // $1000 > $1 capacity
    uint256 tokenId = _tokenId(CHAIN_ID, CURRENCY);

    bytes[] memory fast = new bytes[](1);
    fast[0] = _fastMintAction(
      orderAddr,
      CHAIN_ID,
      CURRENCY,
      amount,
      100,
      feeRecipient
    );
    bytes memory sig = _sign(oracleSignerPk, v2Domain, key, fast);

    // The limiter returns false (over budget); V2 reverts FastMintRejected so the whole execution
    // rolls back (nothing minted, key not consumed) and the deposit can be re-attested as slow.
    vm.expectRevert(RelayOracleV2.FastMintRejected.selector);
    v2.execute(_v2Exec(key, fast), oracleSigner, sig);

    // A reverted FAST_MINT leaves no idempotency key and mints nothing.
    assertFalse(v2.isExecuted(key));
    assertEq(hub.balanceOf(orderAddr, tokenId), 0);
    assertEq(hub.balanceOf(feeRecipient, tokenId), 0);

    // The same deposit can be re-attested as a slow MINT (full gross) under the same key.
    bytes[] memory slow = new bytes[](1);
    slow[0] = _mintAction(orderAddr, tokenId, amount);
    bytes memory slowSig = _sign(oracleSignerPk, v2Domain, key, slow);
    v2.execute(_v2Exec(key, slow), oracleSigner, slowSig);

    assertTrue(v2.isExecuted(key));
    assertEq(hub.balanceOf(orderAddr, tokenId), amount);
  }

  function test_executeMultiple_overBudgetFastMint_emitsFailure_continues()
    public
  {
    vm.prank(admin);
    limiter.setBucketConfig(
      RelayFastRateLimiter.BucketConfig({
        chainId: CHAIN_ID,
        isEnabled: true,
        capacity: 1e8,
        rate: 0
      })
    );

    uint256 tokenId = _tokenId(CHAIN_ID, CURRENCY);
    bytes32 keyFast = keccak256("batch-fast");
    bytes32 keyMint = keccak256("batch-mint");

    bytes[] memory fast = new bytes[](1);
    fast[0] = _fastMintAction(
      orderAddr,
      CHAIN_ID,
      CURRENCY,
      1000e8,
      100,
      feeRecipient
    );
    bytes[] memory mint = new bytes[](1);
    mint[0] = _mintAction(otherAddr, tokenId, 7e8);

    RelayOracleV2.Execution[] memory execs = new RelayOracleV2.Execution[](2);
    execs[0] = _v2Exec(keyFast, fast);
    execs[1] = _v2Exec(keyMint, mint);
    bytes[] memory sigs = new bytes[](2);
    sigs[0] = _sign(oracleSignerPk, v2Domain, keyFast, fast);
    sigs[1] = _sign(oracleSignerPk, v2Domain, keyMint, mint);

    // The over-budget fast Execution is isolated as ExecutionFailed (key not consumed, nothing
    // minted), so the batch continues and the deposit can be re-attested as slow.
    vm.expectEmit(true, false, false, true, address(v2));
    emit RelayOracleV2.ExecutionFailed(keyFast, fast);

    v2.executeMultiple(execs, oracleSigner, sigs);

    assertFalse(v2.isExecuted(keyFast));
    assertTrue(v2.isExecuted(keyMint));
    assertEq(hub.balanceOf(otherAddr, tokenId), 7e8);
    assertEq(hub.balanceOf(orderAddr, tokenId), 0);

    // After full finality, the same deposit re-attests as a slow plain MINT (full gross) under the
    // same key; the user receives the would-be fee back as larger solver output.
    bytes[] memory slow = new bytes[](1);
    slow[0] = _mintAction(orderAddr, tokenId, 1000e8);
    bytes memory slowSig = _sign(oracleSignerPk, v2Domain, keyFast, slow);
    v2.execute(_v2Exec(keyFast, slow), oracleSigner, slowSig);

    assertTrue(v2.isExecuted(keyFast));
    assertEq(hub.balanceOf(orderAddr, tokenId), 1000e8);
  }

  // FAST_MINT — fail-closed

  function test_fastMint_revertsWhenRateLimiterUnset() public {
    vm.prank(admin);
    v2.setRateLimiter(address(0));

    bytes32 key = keccak256("fast-no-limiter");
    bytes[] memory actions = new bytes[](1);
    actions[0] = _fastMintAction(
      orderAddr,
      CHAIN_ID,
      CURRENCY,
      10e8,
      100,
      feeRecipient
    );
    bytes memory sig = _sign(oracleSignerPk, v2Domain, key, actions);

    vm.expectRevert(RelayOracleV2.RateLimiterNotSet.selector);
    v2.execute(_v2Exec(key, actions), oracleSigner, sig);
    assertFalse(v2.isExecuted(key));
  }

  function test_fastMint_revertsWhenFastDisabledForChain() public {
    bytes32 key = keccak256("fast-disabled");
    // chain "1" has no bucket configured => fail-closed: limiter returns false, V2 reverts.
    bytes[] memory actions = new bytes[](1);
    actions[0] = _fastMintAction(
      orderAddr,
      "1",
      CURRENCY,
      10e8,
      100,
      feeRecipient
    );
    bytes memory sig = _sign(oracleSignerPk, v2Domain, key, actions);

    vm.expectRevert(RelayOracleV2.FastMintRejected.selector);
    v2.execute(_v2Exec(key, actions), oracleSigner, sig);
    assertFalse(v2.isExecuted(key));
  }

  function test_fastMint_revertsWhenUsdValueZero() public {
    // Fail-closed: a zero usdValue (the producer's placeholder until the off-chain price source is
    // live) makes the limiter reject → V2 reverts → the deposit re-attests slow. Without this, a 0
    // usdValue on an enabled bucket would be unlimited fast.
    bytes32 key = keccak256("fast-zero-usd");
    bytes[] memory actions = new bytes[](1);
    actions[0] = _fastMintActionUsd(
      orderAddr,
      CHAIN_ID,
      CURRENCY,
      10e8,
      100,
      feeRecipient,
      0 // usdValue
    );
    bytes memory sig = _sign(oracleSignerPk, v2Domain, key, actions);

    vm.expectRevert(RelayOracleV2.FastMintRejected.selector);
    v2.execute(_v2Exec(key, actions), oracleSigner, sig);
    assertFalse(v2.isExecuted(key));
  }

  function test_fastMint_revertsInvalidFeeBps() public {
    bytes32 key = keccak256("fast-bad-bps");
    uint256 feeBps = 1e18 + 1; // > BPS_DENOMINATOR (100%)
    bytes[] memory actions = new bytes[](1);
    actions[0] = _fastMintAction(
      orderAddr,
      CHAIN_ID,
      CURRENCY,
      10e8,
      feeBps,
      feeRecipient
    );
    bytes memory sig = _sign(oracleSignerPk, v2Domain, key, actions);

    vm.expectRevert(
      abi.encodeWithSelector(RelayOracleV2.InvalidFeeBps.selector, feeBps)
    );
    v2.execute(_v2Exec(key, actions), oracleSigner, sig);
  }

  function test_fastMint_revertsInvalidFeeRecipient() public {
    bytes32 key = keccak256("fast-no-recipient");
    bytes[] memory actions = new bytes[](1);
    actions[0] = _fastMintAction(
      orderAddr,
      CHAIN_ID,
      CURRENCY,
      10e8,
      1e16, // 1% → fee > 0 with zero recipient
      address(0)
    );
    bytes memory sig = _sign(oracleSignerPk, v2Domain, key, actions);

    vm.expectRevert(RelayOracleV2.InvalidFeeRecipient.selector);
    v2.execute(_v2Exec(key, actions), oracleSigner, sig);
  }

  // Dual-key idempotency

  function test_execute_revertsWhenKeyAlreadyExecutedOnOldOracle() public {
    bytes32 key = keccak256("shared-key");
    uint256 tokenId = _tokenId(CHAIN_ID, CURRENCY);

    // Execute the key on the OLD oracle first.
    bytes[] memory oldActions = new bytes[](1);
    oldActions[0] = abi.encode(
      uint8(RelayOracle.ActionType.MINT),
      orderAddr,
      tokenId,
      uint256(1e8)
    );
    bytes memory oldSig = _sign(oracleSignerPk, oldDomain, key, oldActions);
    oldOracle.execute(
      RelayOracle.Execution({idempotencyKey: key, actions: oldActions}),
      oracleSigner,
      oldSig
    );
    assertTrue(oldOracle.isExecuted(key));

    // The same key must be rejected on v2 (migration safety).
    bytes[] memory v2Actions = new bytes[](1);
    v2Actions[0] = _mintAction(otherAddr, tokenId, 2e8);
    bytes memory v2Sig = _sign(oracleSignerPk, v2Domain, key, v2Actions);

    vm.expectRevert(
      abi.encodeWithSelector(RelayOracleV2.AlreadyExecuted.selector, key)
    );
    v2.execute(_v2Exec(key, v2Actions), oracleSigner, v2Sig);
    assertEq(hub.balanceOf(otherAddr, tokenId), 0);
  }

  function test_executeMultiple_skipsKeyAlreadyExecutedOnOldOracle() public {
    bytes32 oldKey = keccak256("old-key");
    bytes32 freshKey = keccak256("fresh-key");
    uint256 tokenId = _tokenId(CHAIN_ID, CURRENCY);
    address oldRecipient = makeAddr("oldRecipient");

    bytes[] memory oldActions = new bytes[](1);
    oldActions[0] = abi.encode(
      uint8(RelayOracle.ActionType.MINT),
      oldRecipient,
      tokenId,
      uint256(1e8)
    );
    bytes memory oldSig = _sign(oracleSignerPk, oldDomain, oldKey, oldActions);
    oldOracle.execute(
      RelayOracle.Execution({idempotencyKey: oldKey, actions: oldActions}),
      oracleSigner,
      oldSig
    );

    // Batch: the old key is silently skipped; the fresh key executes.
    bytes[] memory skipped = new bytes[](1);
    skipped[0] = _mintAction(orderAddr, tokenId, 5e8);
    bytes[] memory fresh = new bytes[](1);
    fresh[0] = _mintAction(otherAddr, tokenId, 9e8);

    RelayOracleV2.Execution[] memory execs = new RelayOracleV2.Execution[](2);
    execs[0] = _v2Exec(oldKey, skipped);
    execs[1] = _v2Exec(freshKey, fresh);
    bytes[] memory sigs = new bytes[](2);
    sigs[0] = _sign(oracleSignerPk, v2Domain, oldKey, skipped);
    sigs[1] = _sign(oracleSignerPk, v2Domain, freshKey, fresh);

    v2.executeMultiple(execs, oracleSigner, sigs);

    assertFalse(v2.isExecuted(oldKey)); // skipped, not re-executed on v2
    assertTrue(v2.isExecuted(freshKey));
    assertEq(hub.balanceOf(otherAddr, tokenId), 9e8);
    // the skipped mint never happened on v2
    assertEq(hub.balanceOf(orderAddr, tokenId), 0);
  }

  function test_execute_revertsAlreadyExecutedOnOwnReplay() public {
    bytes32 key = keccak256("own-replay");
    bytes[] memory actions = new bytes[](1);
    actions[0] = _fastMintAction(
      orderAddr,
      CHAIN_ID,
      CURRENCY,
      10e8,
      100,
      feeRecipient
    );
    _runFast(key, actions);

    bytes memory sig = _sign(oracleSignerPk, v2Domain, key, actions);
    vm.expectRevert(
      abi.encodeWithSelector(RelayOracleV2.AlreadyExecuted.selector, key)
    );
    v2.execute(_v2Exec(key, actions), oracleSigner, sig);
  }

  function test_execute_withZeroOldOracle_onlyChecksOwnKeys() public {
    RelayOracleV2 v2b = new RelayOracleV2(admin, address(hub), address(0));
    vm.startPrank(admin);
    hub.grantRole(hub.OPERATOR_ROLE(), address(v2b));
    v2b.grantRole(v2b.ORACLE_ROLE(), oracleSigner);
    vm.stopPrank();

    bytes32 domainB = Eip712.domainSeparator(
      "RelayOracle",
      "2",
      block.chainid,
      address(v2b)
    );
    bytes32 key = keccak256("own-key-no-old");
    uint256 tokenId = _tokenId(CHAIN_ID, CURRENCY);
    bytes[] memory actions = new bytes[](1);
    actions[0] = _mintAction(orderAddr, tokenId, 5e8);
    bytes memory sig = _sign(oracleSignerPk, domainB, key, actions);

    // Must not revert from calling isExecuted on a zero old-oracle address.
    v2b.execute(
      RelayOracleV2.Execution({idempotencyKey: key, actions: actions}),
      oracleSigner,
      sig
    );
    assertTrue(v2b.isExecuted(key));

    vm.expectRevert(
      abi.encodeWithSelector(RelayOracleV2.AlreadyExecuted.selector, key)
    );
    v2b.execute(
      RelayOracleV2.Execution({idempotencyKey: key, actions: actions}),
      oracleSigner,
      sig
    );
  }

  // Constructor validation

  function test_constructorRevertsZeroAdmin() public {
    vm.expectRevert(RelayOracleV2.ZeroAddress.selector);
    new RelayOracleV2(address(0), address(hub), address(oldOracle));
  }

  function test_constructorRevertsZeroHub() public {
    vm.expectRevert(RelayOracleV2.ZeroAddress.selector);
    new RelayOracleV2(admin, address(0), address(oldOracle));
  }

  function test_constructorRevertsWrongTypeOldOracle() public {
    // A non-zero oldOracle that is not a live RelayOracle (here a RelayHub, which has no
    // isExecuted) is rejected at deploy, so a misconfigured immutable predecessor cannot brick
    // every execution later.
    vm.expectRevert(
      abi.encodeWithSelector(
        RelayOracleV2.InvalidOldOracle.selector,
        address(hub)
      )
    );
    new RelayOracleV2(admin, address(hub), address(hub));
  }

  function test_constructorRevertsCodelessOldOracle() public {
    // A non-zero codeless address (EOA) is rejected at deploy with the documented error. The
    // try/catch alone cannot do this — a high-level call to a codeless target fails the existence
    // check in the constructor frame (outside the try), so without the explicit code.length guard
    // the revert would carry no data instead of InvalidOldOracle.
    address eoa = makeAddr("codelessOldOracle");
    assertEq(eoa.code.length, 0, "precondition: codeless");
    vm.expectRevert(
      abi.encodeWithSelector(RelayOracleV2.InvalidOldOracle.selector, eoa)
    );
    new RelayOracleV2(admin, address(hub), eoa);
  }

  function test_constructorRevertsOldOracleHubMismatch() public {
    // A live RelayOracle from a DIFFERENT environment (different hub) is rejected. Its
    // environment-independent idempotency keys would otherwise make _isExecuted silently skip
    // legitimate executions here.
    RelayHub otherHub = new RelayHub(admin);
    RelayOracle foreignOracle = new RelayOracle(admin, address(otherHub));
    vm.expectRevert(
      abi.encodeWithSelector(
        RelayOracleV2.OldOracleHubMismatch.selector,
        address(foreignOracle)
      )
    );
    new RelayOracleV2(admin, address(hub), address(foreignOracle));
  }

  function test_constructorAcceptsZeroOldOracle() public {
    // Zero predecessor is valid (only this contract's keys apply) and must not be probed.
    RelayOracleV2 v2c = new RelayOracleV2(admin, address(hub), address(0));
    assertEq(address(v2c.OLD_ORACLE()), address(0));
  }

  // MINT / BURN / TRANSFER parity + composition

  function test_parity_mintBurnTransfer() public {
    uint256 tokenId = _tokenId(CHAIN_ID, CURRENCY);

    // mint
    bytes[] memory mint = new bytes[](1);
    mint[0] = _mintAction(orderAddr, tokenId, 10e8);
    _runFast(keccak256("p-mint"), mint);
    assertEq(hub.balanceOf(orderAddr, tokenId), 10e8);

    // transfer
    bytes[] memory transfer = new bytes[](1);
    transfer[0] = _transferAction(orderAddr, otherAddr, tokenId, 4e8);
    _runFast(keccak256("p-transfer"), transfer);
    assertEq(hub.balanceOf(orderAddr, tokenId), 6e8);
    assertEq(hub.balanceOf(otherAddr, tokenId), 4e8);

    // burn
    bytes[] memory burn = new bytes[](1);
    burn[0] = _burnAction(orderAddr, tokenId, 6e8);
    _runFast(keccak256("p-burn"), burn);
    assertEq(hub.balanceOf(orderAddr, tokenId), 0);
  }

  function test_executesFastMintAndMintInOneExecution() public {
    bytes32 key = keccak256("compose");
    uint256 tokenId = _tokenId(CHAIN_ID, CURRENCY);

    bytes[] memory actions = new bytes[](2);
    actions[0] = _fastMintAction(
      orderAddr,
      CHAIN_ID,
      CURRENCY,
      100e8,
      1e16, // 1%
      feeRecipient
    );
    actions[1] = _mintAction(otherAddr, tokenId, 3e8);
    _runFast(key, actions);

    assertEq(hub.balanceOf(feeRecipient, tokenId), 1e8);
    assertEq(hub.balanceOf(orderAddr, tokenId), 99e8);
    assertEq(hub.balanceOf(otherAddr, tokenId), 3e8);
  }

  function test_revertsInvalidActionType() public {
    bytes32 key = keccak256("bad-action-type");
    bytes[] memory actions = new bytes[](1);
    actions[0] = abi.encode(uint8(99), orderAddr, uint256(1), uint256(1));
    bytes memory sig = _sign(oracleSignerPk, v2Domain, key, actions);

    vm.expectRevert(
      abi.encodeWithSelector(
        RelayOracleV2.InvalidActionType.selector,
        uint8(99)
      )
    );
    v2.execute(_v2Exec(key, actions), oracleSigner, sig);
  }

  // Auth / signature parity

  function test_revertsUnauthorizedOracle() public {
    (address rogue, uint256 roguePk) = makeAddrAndKey("rogue");
    bytes32 key = keccak256("rogue");
    bytes[] memory actions = new bytes[](1);
    actions[0] = _mintAction(orderAddr, _tokenId(CHAIN_ID, CURRENCY), 1e8);
    bytes memory sig = _sign(roguePk, v2Domain, key, actions);

    vm.expectRevert(
      abi.encodeWithSelector(RelayOracleV2.UnauthorizedOracle.selector, rogue)
    );
    v2.execute(_v2Exec(key, actions), rogue, sig);
  }

  function test_revertsInvalidSignature() public {
    (, uint256 otherPk) = makeAddrAndKey("other-signer");
    bytes32 key = keccak256("mismatch");
    bytes[] memory actions = new bytes[](1);
    actions[0] = _mintAction(orderAddr, _tokenId(CHAIN_ID, CURRENCY), 1e8);
    bytes memory sigByOther = _sign(otherPk, v2Domain, key, actions);

    vm.expectRevert(
      abi.encodeWithSelector(
        RelayOracleV2.InvalidSignature.selector,
        oracleSigner
      )
    );
    v2.execute(_v2Exec(key, actions), oracleSigner, sigByOther);
  }

  // Admin

  function test_setRateLimiter_revertsForNonAdmin() public {
    address rando = makeAddr("rando");
    vm.expectRevert(
      abi.encodeWithSelector(
        IAccessControl.AccessControlUnauthorizedAccount.selector,
        rando,
        v2.ADMIN_ROLE()
      )
    );
    vm.prank(rando);
    v2.setRateLimiter(address(0));
  }

  function test_setRateLimiter_setsAndEmits() public {
    address newLimiter = makeAddr("newLimiter");
    vm.expectEmit(false, false, false, true, address(v2));
    emit RelayOracleV2.RateLimiterSet(newLimiter);
    vm.prank(admin);
    v2.setRateLimiter(newLimiter);
    assertEq(address(v2.rateLimiter()), newLimiter);
  }

  // Fuzz

  function testFuzz_fastMint_recoversInputAndFee(
    uint256 amount,
    uint256 feeBps
  ) public {
    // amount >= 1 so the gross (and the helper's default usdValue) is nonzero; a zero-amount fast
    // mint is rejected by the limiter (fail-closed). feeBps in [0, 1e18] = [0%, 100%].
    amount = bound(amount, 1, 1e24);
    feeBps = bound(feeBps, 0, 1e18);
    uint256 tokenId = _tokenId(CHAIN_ID, CURRENCY);

    uint256 expectedFee = FixedPointMathLib.fullMulDiv(amount, feeBps, 1e18);
    uint256 expectedInput = amount - expectedFee;

    bytes32 key = keccak256(abi.encode("fuzz", amount, feeBps));
    bytes[] memory actions = new bytes[](1);
    actions[0] = _fastMintAction(
      orderAddr,
      CHAIN_ID,
      CURRENCY,
      amount,
      feeBps,
      feeRecipient
    );
    _runFast(key, actions);

    assertEq(hub.balanceOf(feeRecipient, tokenId), expectedFee);
    assertEq(hub.balanceOf(orderAddr, tokenId), expectedInput);
    assertEq(
      hub.balanceOf(feeRecipient, tokenId) + hub.balanceOf(orderAddr, tokenId),
      amount
    );
  }
}
