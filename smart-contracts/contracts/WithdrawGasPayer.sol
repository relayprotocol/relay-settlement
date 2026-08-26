// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

import {BuildPayloadParams, RelayAllocator} from "./RelayAllocator.sol";
import {RelayHub} from "./RelayHub.sol";
import {Utils} from "./Utils.sol";
import {WithdrawParams} from "./payload-builders/GasPaidPayloadBuilder.sol";

/// @title WithdrawGasPayer
/// @author Relay Protocol
/// @notice Collects out-of-band gas payments for withdrawals on chains where
///         the allocator or depository pays network fees from its own funds
///         (e.g. Circle Gateway, TON, and XRPL). Authorized by an oracle
///         per-chain gas fee from the withdrawer's hub funds and records the
///         payment keyed by the withdraw params hash — atomically, so one
///         burn maps to exactly one payment record — unlocking payload builds
///         in the builders that inherit `GasPaidPayloadBuilder`.
/// @dev Each payment is gated on an oracle signature over the exact withdraw
///      request and gas fee. Requires `OPERATOR_ROLE` on the hub to burn the
///      payer's funds. The oracle is expected to be the oracle multisig
///      (ERC-1271); EOA oracles are also supported via ECDSA. Anyone can submit
///      a payment carrying a valid oracle signature — the signature, not the
///      caller, is the authority, mirroring the oracle execution flow.
///
///      A gas payment is bound to the withdraw parameters, not the spender:
///      if two spenders submit byte-identical parameters (same nonce,
///      receiver, amount, ...) they share one record — the second payment
///      reverts with `GasAlreadyPaid` and a single payment unlocks both
///      allocator submissions. Payments are non-refundable and records are
///      permanent: if the withdrawal is never submitted the burned funds are
///      not recoverable, and a mistakenly authorized withdrawal must be
///      stopped at the allocator (`suspend`), not here.
contract WithdrawGasPayer is EIP712 {
  using SignatureChecker for address;

  // --- Fields ---

  /// @notice The signing domain for EIP-712 oracle-authorized gas payments
  string public constant SIGNING_DOMAIN = "WithdrawGasPayer";

  /// @notice The signature version for EIP-712 oracle-authorized gas payments
  string public constant SIGNATURE_VERSION = "1";

  /// @notice The type hash for PayGas oracle signatures
  bytes32 public constant PAY_GAS_TYPEHASH =
    keccak256(
      "PayGas(string chainId,bytes depository,bytes currency,uint256 amount,string spenderChainId,bytes spender,bytes receiver,bytes data,bytes32 nonce,bytes feeCurrency,uint256 feeAmount)"
    );

  /// @notice Address of the hub contract
  address public immutable HUB;

  /// @notice Oracle whose signature authorizes gas payments
  address public immutable ORACLE_MULTISIG;

  /// @notice Gas payments: withdraw params hash => amount burned (0 = unpaid)
  /// @dev The recorded amount lets the payload builders bound the fee the
  ///      depository actually spends by the amount that was pre-paid. Gas fees
  ///      are always non-zero (enforced by `payGas`), so a zero amount reliably
  ///      means "unpaid".
  mapping(bytes32 => uint256) public gasPayments;

  /// @notice Gas payment payers: withdraw params hash => spender alias
  /// @dev Records the alias whose hub funds were burned for the payment.
  mapping(bytes32 => address) public gasPayers;

  // --- Events ---

  /// @notice Emitted when the hub contract is set
  /// @param hub Hub contract address
  event HubSet(address indexed hub);

  /// @notice Emitted when the oracle contract is set
  /// @param oracle Oracle contract address
  event OracleSet(address indexed oracle);

  /// @notice Emitted when a gas payment is recorded
  /// @param withdrawParamsHash Hash of the paid withdrawal parameters
  /// @param chainId Destination chain id
  /// @param depository Encoded depository address
  /// @param spenderAlias Spender alias whose hub funds were burned
  /// @param tokenId Token id burned from the hub
  /// @param amount Amount burned
  event GasPaid(
    bytes32 indexed withdrawParamsHash,
    string chainId,
    bytes depository,
    address indexed spenderAlias,
    uint256 tokenId,
    uint256 amount
  );

  // --- Errors ---

  /// @notice Thrown when the oracle signature does not authorize the payment
  /// @param oracle Oracle address the signature was checked against
  error InvalidOracleSignature(address oracle);

  /// @notice Thrown when an oracle-authorized gas fee is zero
  /// @param chainId Chain id
  error InvalidGasFeeAmount(string chainId);

  /// @notice Thrown when a gas payment was already recorded for the parameters
  /// @param withdrawParamsHash Hash of the already-paid withdrawal parameters
  error GasAlreadyPaid(bytes32 withdrawParamsHash);

  /// @notice Thrown when burning funds in the hub unexpectedly returns false
  /// @param from Spender alias whose balance was targeted
  /// @param tokenId Token id burned from the hub
  /// @param amount Amount attempted to burn
  error GasPaymentTransferFailed(address from, uint256 tokenId, uint256 amount);

  /// @notice Creates a new WithdrawGasPayer contract
  /// @param _hub Hub contract address
  /// @param _oracleMultisig Oracle whose signature authorizes gas payments
  constructor(
    address _hub,
    address _oracleMultisig
  ) EIP712(SIGNING_DOMAIN, SIGNATURE_VERSION) {
    HUB = _hub;
    ORACLE_MULTISIG = _oracleMultisig;
    emit HubSet(_hub);
    emit OracleSet(_oracleMultisig);
  }

  /// @notice Pays the gas fee for a withdrawal request
  /// @dev Takes the same struct as `RelayAllocator.submitWithdrawRequest` so
  ///      the oracle signs over the exact request the allocator will process,
  ///      together with the currency and amount to burn. Callable by anyone
  ///      with a valid oracle signature. Replay is prevented by the write-once
  ///      payment record itself: the signature commits to the request, whose
  ///      params hash can only be paid once.
  /// @param request The withdraw request parameters the gas payment covers
  /// @param feeCurrency Encoded currency burned as the gas payment
  /// @param feeAmount Amount burned as the gas payment
  /// @param oracleSignature EIP-712 oracle signature over the request and fee
  /// @return withdrawParamsHash Hash of the paid withdrawal parameters
  function payGas(
    RelayAllocator.WithdrawRequest calldata request,
    bytes calldata feeCurrency,
    uint256 feeAmount,
    bytes calldata oracleSignature
  ) external returns (bytes32 withdrawParamsHash) {
    if (feeAmount == 0) {
      revert InvalidGasFeeAmount(request.chainId);
    }

    bytes32 digest = _payGasDigest(request, feeCurrency, feeAmount);
    if (!ORACLE_MULTISIG.isValidSignatureNow(digest, oracleSignature)) {
      revert InvalidOracleSignature(ORACLE_MULTISIG);
    }

    withdrawParamsHash = WithdrawParams.hash(
      request.chainId,
      request.depository,
      BuildPayloadParams({
        currency: request.currency,
        amount: request.amount,
        receiver: request.receiver,
        nonce: uint256(request.nonce),
        data: request.data
      })
    );

    if (gasPayments[withdrawParamsHash] != 0) {
      revert GasAlreadyPaid(withdrawParamsHash);
    }

    address spenderAlias = Utils.generateAddress(
      request.spenderChainId,
      request.spender
    );

    // Burn the gas fee from the spender. RelayHub.burn currently either reverts
    // or returns true, so the false branch below is retained only as a defensive
    // guard against future hub changes.
    uint256 tokenId = Utils.generateTokenId(request.chainId, feeCurrency);
    bool result = RelayHub(HUB).burn(spenderAlias, tokenId, feeAmount);
    if (!result) {
      revert GasPaymentTransferFailed(spenderAlias, tokenId, feeAmount);
    }

    gasPayments[withdrawParamsHash] = feeAmount;
    gasPayers[withdrawParamsHash] = spenderAlias;

    emit GasPaid(
      withdrawParamsHash,
      request.chainId,
      request.depository,
      spenderAlias,
      tokenId,
      feeAmount
    );
  }

  /// @notice Computes the hash a gas payment is recorded under
  /// @dev Matches the tuple `RelayAllocator._buildPayload` passes to
  ///      `IPayloadBuilder.buildPayload` for the same withdraw request.
  /// @param chainId The destination chain id
  /// @param depository The encoded depository address
  /// @param params Payload builder parameters
  /// @return withdrawParamsHash Hash identifying the withdrawal parameters
  function hashWithdrawParams(
    string calldata chainId,
    bytes calldata depository,
    BuildPayloadParams calldata params
  ) external pure returns (bytes32 withdrawParamsHash) {
    return WithdrawParams.hash(chainId, depository, params);
  }

  /// @notice Computes the EIP-712 digest the oracle signs for a gas payment
  /// @param request The withdraw request parameters the gas payment covers
  /// @param feeCurrency Encoded currency burned as the gas payment
  /// @param feeAmount Amount burned as the gas payment
  /// @return digest EIP-712 digest signed by the oracle
  function _payGasDigest(
    RelayAllocator.WithdrawRequest calldata request,
    bytes calldata feeCurrency,
    uint256 feeAmount
  ) internal view returns (bytes32 digest) {
    return
      _hashTypedDataV4(
        keccak256(
          abi.encode(
            PAY_GAS_TYPEHASH,
            keccak256(bytes(request.chainId)),
            keccak256(request.depository),
            keccak256(request.currency),
            request.amount,
            keccak256(bytes(request.spenderChainId)),
            keccak256(request.spender),
            keccak256(request.receiver),
            keccak256(request.data),
            request.nonce,
            keccak256(feeCurrency),
            feeAmount
          )
        )
      );
  }
}
