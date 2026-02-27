// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {
  AuroraSdk,
  NEAR,
  PromiseCreateArgs,
  PromiseResult,
  PromiseResultStatus,
  PromiseWithCallback
} from "./aurora-xcc/AuroraSdk.sol";
import {ChainSignatures} from "./ChainSignatures.sol";
import {GasSettings} from "./RelayAllocator.sol";
import {IBitcoinDepositSweepBuilder} from "./interfaces/IBitcoinDepositSweepBuilder.sol";

/// @title BitcoinDepositAddress
/// @author Relay Protocol
/// @notice Manages deterministic Bitcoin deposit addresses via NEAR MPC path derivation,
/// delegates sweep payload building to a separate builder contract, and handles MPC signing.
contract BitcoinDepositAddress is Ownable {
  using AuroraSdk for NEAR;
  using AuroraSdk for PromiseCreateArgs;
  using AuroraSdk for PromiseWithCallback;
  using AuroraSdk for PromiseResult;

  // ── Errors ──────────────────────────────────────────────────────────
  error SignatureAlreadyComplete(bytes32 orderId, bytes32 hashToSign);
  error SignaturePending(bytes32 orderId, uint256 expiration);
  error SignCallbackFailed(bytes32 orderId);

  // ── Events ──────────────────────────────────────────────────────────

  /// @notice Emitted when the sweep builder is changed
  event SweepBuilderChanged(address sweepBuilder);
  /// @notice Emitted when a sweep payload is submitted
  event SweepSubmitted(
    bytes32 indexed orderId,
    bytes payload,
    uint64 sweepAmount
  );
  /// @notice Emitted when a sweep payload is signed by the MPC
  event SweepSigned(
    bytes32 indexed orderId,
    bytes32 indexed hashToSign,
    bytes signature
  );

  // ── Constants ───────────────────────────────────────────────────────

  /// @dev Cooldown period for pending MPC signature requests
  uint256 private constant PENDING_SIGNATURE_COOLDOWN = 5 minutes;

  // ── Storage ─────────────────────────────────────────────────────────

  /// @notice Sweep payload builder contract
  IBitcoinDepositSweepBuilder public sweepBuilder;

  /// @notice NEAR MPC signer account
  string public nearSigner;

  /// @notice Aurora SDK instance
  NEAR public near;

  /// @notice orderId -> hashToSign -> encoded sweep payload
  mapping(bytes32 => mapping(bytes32 => bytes)) public sweepPayloads;

  /// @notice orderId -> hashToSign -> signature
  mapping(bytes32 => mapping(bytes32 => bytes)) public signedPayloads;

  /// @notice orderId -> hashToSign -> expiration timestamp
  mapping(bytes32 => mapping(bytes32 => uint256)) public pendingSignatures;

  // ── Constructor ─────────────────────────────────────────────────────

  /// @notice Initializes the contract with builder, signer, and NEAR config
  /// @param _owner Contract owner
  /// @param _sweepBuilder Address of the sweep builder contract
  /// @param _nearSigner NEAR MPC signer account
  /// @param _wNEAR Wrapped NEAR token address
  constructor(
    address _owner,
    address _sweepBuilder,
    string memory _nearSigner,
    address _wNEAR
  ) Ownable(_owner) {
    sweepBuilder = IBitcoinDepositSweepBuilder(_sweepBuilder);
    nearSigner = _nearSigner;
    near = AuroraSdk.initNear(IERC20(_wNEAR));
  }

  // ── External / Public Functions ─────────────────────────────────────

  /// @notice Bootstrap XCC sub-account on NEAR (costs 2 wNEAR)
  function init() external onlyOwner {
    near.wNEAR.transferFrom(
      msg.sender,
      address(this),
      uint256(2_000_000_000_000_000_000_000_000)
    );

    PromiseCreateArgs memory initCall = near.call(
      "system",
      "",
      "",
      0,
      500_000_000_000
    );
    initCall.transact();
  }

  /// @notice Updates the sweep builder contract address
  /// @param _sweepBuilder New sweep builder address
  function setSweepBuilder(address _sweepBuilder) external onlyOwner {
    sweepBuilder = IBitcoinDepositSweepBuilder(_sweepBuilder);
    emit SweepBuilderChanged(_sweepBuilder);
  }

  /// @notice Returns the NEAR MPC derivation path for a given order
  /// @param orderId The 32-byte order identifier
  /// @return The derivation path: hex(address(this)) + "/" + hex(orderId)
  function derivationPath(bytes32 orderId) public view returns (string memory) {
    return
      string.concat(
        Strings.toHexString(uint160(address(this)), 20),
        "/",
        ChainSignatures.stringifyBytes(abi.encodePacked(orderId))
      );
  }

  /// @notice Combined submit-and-sign: builds payload via builder, stores it, computes hash, calls NEAR MPC.
  /// @dev Permissionless — anyone can call. Re-callable after the pending signature cooldown
  /// expires to prevent griefing via low gas settings.
  /// @param orderId The 32-byte order identifier
  /// @param data Builder-specific encoded parameters
  /// @param gasSettings Gas settings for NEAR MPC call
  function sweep(
    bytes32 orderId,
    bytes calldata data,
    GasSettings calldata gasSettings
  ) external {
    (bytes memory payload, uint64 sweepAmount) = sweepBuilder.buildSweepPayload(
      orderId,
      data
    );
    bytes32 hash = sweepBuilder.hashToSign(payload);

    sweepPayloads[orderId][hash] = payload;

    emit SweepSubmitted(orderId, payload, sweepAmount);

    _requestSignature(orderId, hash, gasSettings);
  }

  /// @notice NEAR callback — stores the resulting signature
  /// @param orderId The order identifier
  /// @param _hashToSign The hash that was signed
  function sweepCallback(bytes32 orderId, bytes32 _hashToSign) external {
    if (
      msg.sender != AuroraSdk.nearRepresentitiveImplicitAddress(address(this))
    ) {
      revert SignCallbackFailed(orderId);
    }

    PromiseResult memory result = AuroraSdk.promiseResult(0);

    if (result.status != PromiseResultStatus.Successful) {
      revert SignCallbackFailed(orderId);
    }

    signedPayloads[orderId][_hashToSign] = result.output;
    emit SweepSigned(orderId, _hashToSign, result.output);
  }

  // ── Internal Functions ──────────────────────────────────────────────

  /// @notice Validates signature state and sends the signing request to NEAR MPC
  function _requestSignature(
    bytes32 orderId,
    bytes32 hash,
    GasSettings calldata gasSettings
  ) internal {
    // Check signature state
    if (signedPayloads[orderId][hash].length > 0) {
      revert SignatureAlreadyComplete(orderId, hash);
    }

    uint256 expiration = pendingSignatures[orderId][hash];
    if (block.timestamp < expiration) {
      revert SignaturePending(orderId, expiration);
    }

    pendingSignatures[orderId][hash] =
      block.timestamp + PENDING_SIGNATURE_COOLDOWN;

    // Compute per-order derivation path
    string memory path = derivationPath(orderId);

    // Encode JSON request for NEAR MPC
    bytes memory data = ChainSignatures.encodeJSONRequest(
      ChainSignatures.stringifyBytes(abi.encodePacked(hash)),
      "Ecdsa",
      path,
      "0"
    );

    // Call NEAR MPC to sign
    PromiseCreateArgs memory callSign = near.call(
      nearSigner,
      "sign",
      data,
      1, // 1 yoctoNEAR
      gasSettings.signGas
    );
    PromiseCreateArgs memory callback = near.auroraCall(
      address(this),
      abi.encodeWithSelector(this.sweepCallback.selector, orderId, hash),
      0,
      gasSettings.callbackGas
    );
    callSign.then(callback).transact();
  }
}
