// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {Authorization} from "./Authorization.sol";
import {RelayHub} from "./RelayHub.sol";
import {Utils} from "./Utils.sol";

/// @notice Parameters for a withdrawal request
struct WithdrawRequest {
  string chainId; /// @notice Chain id of the withdrawal chain
  bytes depository; /// @notice Encoded address of the depository on the withdrawal chain
  bytes currency; /// @notice Encoded address of the currency to be withdrawn
  uint256 amount; /// @notice Amount to withdraw
  string spenderChainId; /// @notice Chain id of the spender
  bytes spender; /// @notice Encoded address of the spender
  bytes receiver; /// @notice Encoded address of the receiver of the withdrawn funds
  bytes data; /// @notice Additional data to be passed to the payload builder
  bytes32 nonce; /// @notice Nonce for replay protection
}

/// @notice Withdrawal request and the spender signature authorizing it.
struct WithdrawRequestAuthorization {
  WithdrawRequest withdrawRequest;
  Authorization authorization;
}

/// @notice Fee collected from the designated payer on the withdrawal chain.
struct WithdrawFee {
  bytes currency;
  uint256 amount;
}

/// @notice Oracle-authorized fee debit from a payer independent of the spender.
struct WithdrawFeePayment {
  string payerChainId;
  bytes payer;
  bytes currency;
  uint256 maxAmount;
}

/// @notice Fee payment terms and the oracle signature authorizing them.
struct WithdrawFeePaymentAuthorization {
  WithdrawFeePayment withdrawFeePayment;
  Authorization authorization;
}

/// @title IPayloadBuilder
/// @author Relay Protocol
/// @notice Interface for payload builders that create withdrawal payloads for different chains
interface IPayloadBuilder {
  /// @notice Builds a withdrawal payload for the specified request
  /// @dev Builders that can bind a destination id to the request derive it from
  ///      `keccak256(abi.encode(request))`, the hash the allocator accepts a request
  ///      under and therefore unique per accepted request.
  /// @param chainId The destination chain id
  /// @param depository The depository address
  /// @param request The withdrawal request
  /// @return payload The built payload
  /// @return withdrawFee Additional Hub debit required for this payload
  function buildPayload(
    string calldata chainId,
    bytes calldata depository,
    WithdrawRequest calldata request
  )
    external
    view
    returns (bytes memory payload, WithdrawFee memory withdrawFee);

  /// @notice Returns an array of hashes that need to be signed for the payload
  /// @param chainId The destination chain id
  /// @param depository The depository address
  /// @param payload The corresponding payload
  /// @return hashes Array of hashes to be signed
  function hashesToSign(
    string calldata chainId,
    bytes calldata depository,
    bytes calldata payload
  ) external view returns (bytes32[] memory hashes);

  /// @notice Returns the curve used for signing
  /// @return name The curve name
  function curve() external pure returns (string memory name);

  /// @notice Returns the family of the payload builder
  /// @return name The family name
  function family() external pure returns (string memory name);
}

/// @title IWithdrawalCounter
/// @author Relay Protocol
/// @notice Per-chain withdrawal count a payload builder can read from the allocator calling it
interface IWithdrawalCounter {
  /// @notice Returns the withdrawals the allocator accepted for the chain in the current block second
  /// @dev `(block.timestamp, withdrawalsThisSecond(chainId))` differs for every withdrawal of a chain,
  ///      so a builder can encode it into a destination id that the caller cannot steer.
  /// @param chainId Relay chain id
  /// @return withdrawals Withdrawals accepted for the chain earlier in this second
  function withdrawalsThisSecond(
    string calldata chainId
  ) external view returns (uint256 withdrawals);
}

/// @title RelayAllocator
/// @author Relay Protocol
/// @notice Manages cross-chain withdrawal requests and payload signing
/// @dev The owner holds three emergency levers over new submissions: `pause()`
///      halts all of them, `pauseChains(chainIds)` halts those bound for the
///      given destination chains, and `suspend(alias)` blocks one spender
///      alias. None of them invalidates payloads or signing hashes already
///      recorded.
contract RelayAllocator is Ownable, EIP712, Pausable, IWithdrawalCounter {
  using ECDSA for bytes32;
  using SignatureChecker for address;

  /// --- Fields ---

  /// @notice The signing domain for EIP-712 receiver-authorized withdrawals
  string public constant SIGNING_DOMAIN = "RelayAllocator";

  /// @notice The signature version for EIP-712 receiver-authorized withdrawals
  string public constant SIGNATURE_VERSION = "1";

  /// @notice The type hash for WithdrawRequestAuthorization spender signatures
  bytes32 public constant WITHDRAW_REQUEST_AUTHORIZATION_TYPEHASH =
    keccak256(
      "WithdrawRequestAuthorization(WithdrawRequest request,uint256 expiration)WithdrawRequest(string chainId,bytes depository,bytes currency,uint256 amount,string spenderChainId,bytes spender,bytes receiver,bytes data,bytes32 nonce)"
    );

  /// @notice The type hash for the nested withdrawal request
  bytes32 public constant WITHDRAW_REQUEST_TYPEHASH =
    keccak256(
      "WithdrawRequest(string chainId,bytes depository,bytes currency,uint256 amount,string spenderChainId,bytes spender,bytes receiver,bytes data,bytes32 nonce)"
    );

  /// @notice Fee authorizations bind the request with its runtime amount set to zero.
  bytes32 public constant WITHDRAW_FEE_PAYMENT_AUTHORIZATION_TYPEHASH =
    keccak256(
      "WithdrawFeePaymentAuthorization(WithdrawRequest request,WithdrawFeePayment withdrawFeePayment,uint256 expiration)WithdrawFeePayment(string payerChainId,bytes payer,bytes currency,uint256 maxAmount)WithdrawRequest(string chainId,bytes depository,bytes currency,uint256 amount,string spenderChainId,bytes spender,bytes receiver,bytes data,bytes32 nonce)"
    );

  bytes32 private constant _WITHDRAW_FEE_PAYMENT_TYPEHASH =
    keccak256(
      "WithdrawFeePayment(string payerChainId,bytes payer,bytes currency,uint256 maxAmount)"
    );

  /// @notice A fee authorization can fund only one withdrawal, regardless of its runtime amount.
  mapping(bytes32 => bool) public usedWithdrawFeePaymentAuthorizations;

  /// @notice Spender chain id whose 20-byte spenders may submit as msg.sender
  string public constant LOCAL_CHAIN_ID = "relay";

  /// @notice Address of the hub contract
  address public immutable HUB;

  /// @notice RelayInboxMultisig contract used to verify spender signatures
  address public immutable ORACLE_MULTISIG;

  /// @notice Mapping of payload builders: chain id => depository => payload builder address
  mapping(string => mapping(bytes => address)) public payloadBuilders;

  /// @notice Unsigned payloads: withdrawal request hash => payload
  mapping(bytes32 => bytes) public payloads;

  /// @notice Signed payloads: withdrawal request hash => hash index => hash to be signed
  mapping(bytes32 => mapping(uint256 => bytes32)) public hashesToSign;

  /// @notice Used nonces for replay protection: spender id hash => nonce => whether it has been used
  /// @dev Nonces are shared by spender across direct ECDSA and oracle-verified signatures.
  mapping(bytes32 => mapping(bytes32 => bool)) public usedNonces;

  /// @notice Tracks spender aliases that have been suspended by the owner
  mapping(address => bool) public suspended;

  /// @notice Tracks destination chains whose withdrawals are paused by the owner:
  ///         chain id => whether new submissions to it are paused
  mapping(string => bool) public pausedChains;

  /// @notice Withdrawals per chain in its latest block second: keccak256(chain id) => second << 64 | count
  mapping(bytes32 => uint256) internal withdrawalCounts;

  /// @notice Number of depositories with a payload builder: chain id => count
  mapping(string => uint256) public payloadBuilderCounts;

  /// @notice Emitted when the hub contract is set
  /// @param hub Hub contract address
  event HubSet(address indexed hub);

  /// @notice Emitted when the oracle contract is set
  /// @param oracle Oracle contract address
  event OracleSet(address indexed oracle);

  // --- Events ---

  /// @notice Emitted when a payload builder is set for a chain and depository
  /// @param chainId Chain id
  /// @param depository Encoded depository address
  /// @param builder Payload builder address
  event PayloadBuilderSet(
    string indexed chainId,
    bytes indexed depository,
    address indexed builder
  );

  /// @notice Emitted when a payload is built
  /// @param withdrawRequestHash Withdrawal request hash
  /// @param payload Encoded withdrawal payload
  /// @param hashesToSign Hashes that must be signed for the payload
  event PayloadBuilt(
    bytes32 indexed withdrawRequestHash,
    bytes payload,
    bytes32[] hashesToSign
  );

  /// @notice Emitted when a spender alias is suspended
  /// @param spender Spender alias address
  event Suspended(address indexed spender);

  /// @notice Emitted when a spender alias is unsuspended
  /// @param spender Spender alias address
  event Unsuspended(address indexed spender);

  /// @notice Emitted when new withdrawals to a destination chain are paused
  /// @param chainId Destination chain id
  /// @param hasPayloadBuilder Whether any depository on the chain has a payload builder
  event ChainPaused(string chainId, bool hasPayloadBuilder);

  /// @notice Emitted when new withdrawals to a destination chain are resumed
  /// @param chainId Destination chain id
  event ChainUnpaused(string chainId);

  // --- Errors ---

  /// @notice Thrown when the caller is neither the spender nor an approved operator
  /// @param account Caller address
  error CallerIsNotApproved(address account);

  /// @notice Thrown when no payload builder is configured for a chain and depository pair
  /// @param chainId Chain id
  /// @param depository Encoded depository address
  error NoPayloadBuilder(string chainId, bytes depository);

  /// @notice Thrown when a withdrawal request hash has already been processed
  /// @param withdrawRequestHash Withdrawal request hash
  error WithdrawRequestAlreadyProcessed(bytes32 withdrawRequestHash);

  /// @notice Thrown when burning funds in the hub unexpectedly returns false
  /// @param from Spender alias whose balance was targeted
  /// @param tokenId Token id burned from the hub
  /// @param amount Amount attempted to burn
  error WithdrawRequestTransferFailed(
    address from,
    uint256 tokenId,
    uint256 amount
  );

  /// @notice Thrown when a withdrawal is attempted for a suspended spender alias
  /// @param spender Suspended spender alias address
  error SpenderSuspended(address spender);

  /// @notice Thrown when a withdrawal is attempted to a paused destination chain
  /// @param chainId Paused destination chain id
  error DestinationChainPaused(string chainId);

  /// @notice Thrown when a payload builder returns an empty payload
  error EmptyPayload();

  /// @notice Thrown when a payload builder returns no hashes to sign
  error NoHashesToSign();

  /// @notice Thrown when a spender signature is submitted after its expiration
  /// @param expiration Last valid Unix timestamp in seconds
  error SignatureExpired(uint256 expiration);

  /// @notice Thrown when a required constructor address is zero
  error ZeroAddress();

  /// @notice The builder's fee exceeds the authorized additional debit.
  error WithdrawFeeExceedsLimit(uint256 amount, uint256 maximum);

  /// @notice The builder requested a different fee currency than authorized.
  error WithdrawFeeCurrencyMismatch();

  /// @notice The oracle did not authorize the supplied fee payment.
  error InvalidWithdrawFeePaymentAuthorization();
  /// @notice The fee authorization has already funded a withdrawal.
  error WithdrawFeePaymentAuthorizationUsed(bytes32 digest);
  /// @notice The oracle fee authorization is past its last valid timestamp.
  error WithdrawFeePaymentAuthorizationExpired(uint256 expiration);

  /// @notice Fee burned from the oracle-authorized payer, independently of the principal.
  event WithdrawFeePaid(
    bytes32 indexed withdrawRequestHash,
    address indexed feePayerAlias,
    uint256 indexed tokenId,
    uint256 amount
  );

  /// @notice Creates a new RelayAllocator contract
  /// @param _owner Owner of the contract
  /// @param _hub Hub contract address
  /// @param _oracleMultisig RelayInboxMultisig contract address used to verify spender signatures
  constructor(
    address _owner,
    address _hub,
    address _oracleMultisig
  ) Ownable(_owner) EIP712(SIGNING_DOMAIN, SIGNATURE_VERSION) {
    if (_hub == address(0) || _oracleMultisig == address(0)) {
      revert ZeroAddress();
    }
    HUB = _hub;
    ORACLE_MULTISIG = _oracleMultisig;
    emit HubSet(_hub);
    emit OracleSet(_oracleMultisig);
  }

  /// @notice Sets or updates the payload builder for a specific chain and depository
  /// @param chainId Chain id
  /// @param depository Encoded depository address
  /// @param builder Address of the payload builder contract
  function setPayloadBuilder(
    string calldata chainId,
    bytes calldata depository,
    address builder
  ) external onlyOwner {
    address previous = payloadBuilders[chainId][depository];
    if (previous == address(0) && builder != address(0)) {
      ++payloadBuilderCounts[chainId];
    } else if (previous != address(0) && builder == address(0)) {
      --payloadBuilderCounts[chainId];
    }
    payloadBuilders[chainId][depository] = builder;
    emit PayloadBuilderSet(chainId, depository, builder);
  }

  /// @notice Suspends a spender alias from submitting future withdrawals
  /// @param spender Spender alias address derived from the request spender fields
  function suspend(address spender) external onlyOwner {
    suspended[spender] = true;
    emit Suspended(spender);
  }

  /// @notice Unsuspends a spender alias so withdrawals can resume
  /// @param spender Spender alias address derived from the request spender fields
  function unsuspend(address spender) external onlyOwner {
    suspended[spender] = false;
    emit Unsuspended(spender);
  }

  /// @notice Pauses all new withdrawal submissions
  /// @dev Emergency stop for the withdrawal path. While paused, both
  ///      `submitWithdrawRequest` and `submitWithdrawRequestWithSignature`
  ///      revert with `EnforcedPause` before any authorization, payload build,
  ///      or hub burn. Payloads and signing hashes already recorded are not
  ///      touched; off-chain signers must consult `paused()` to cover those.
  ///      Administration (`suspend`, `unsuspend`, `pauseChains`,
  ///      `unpauseChains`, `setPayloadBuilder`) keeps working while paused.
  function pause() external onlyOwner {
    _pause();
  }

  /// @notice Resumes withdrawal submissions
  function unpause() external onlyOwner {
    _unpause();
  }

  /// @notice Pauses new withdrawal submissions to the given destination chains
  /// @dev Scoped counterpart of `pause()` for chain-bound incidents: submissions
  ///      to every other chain keep working. Takes a list so one transaction can
  ///      cover several chains. Idempotent, like `suspend`. Reverts happen
  ///      before the payload builder lookup, so a chain can be paused before it
  ///      has a builder. Already-recorded payloads are not touched; off-chain
  ///      signers must consult `pausedChains(chainId)` to cover those.
  ///      `ChainPaused` reports whether the chain id has a payload builder, so
  ///      a pause under a mistyped chain id can be told apart from a live one.
  /// @param chainIds Destination chain ids as used in `WithdrawRequest.chainId`
  function pauseChains(string[] calldata chainIds) external onlyOwner {
    for (uint256 i; i < chainIds.length; ++i) {
      pausedChains[chainIds[i]] = true;
      emit ChainPaused(chainIds[i], payloadBuilderCounts[chainIds[i]] > 0);
    }
  }

  /// @notice Resumes new withdrawal submissions to the given destination chains
  /// @param chainIds Destination chain ids as used in `WithdrawRequest.chainId`
  function unpauseChains(string[] calldata chainIds) external onlyOwner {
    for (uint256 i; i < chainIds.length; ++i) {
      pausedChains[chainIds[i]] = false;
      emit ChainUnpaused(chainIds[i]);
    }
  }

  /// @notice Submits a withdraw request to the payload builder
  /// @param params The withdraw request parameters
  /// @return withdrawRequestHash The hash of the withdrawal request
  function submitWithdrawRequest(
    WithdrawRequest calldata params
  ) public returns (bytes32 withdrawRequestHash) {
    WithdrawFeePaymentAuthorization memory withdrawFeePaymentAuthorization;
    return
      _submitWithdrawRequest(
        params,
        withdrawFeePaymentAuthorization,
        Authorization(0, bytes(""))
      );
  }

  /// @notice Submits a withdrawal with an independently funded, oracle-authorized fee.
  /// @return withdrawRequestHash Canonical hash including the full withdrawal amount
  function submitWithdrawRequest(
    WithdrawRequest calldata params,
    WithdrawFeePaymentAuthorization calldata withdrawFeePaymentAuthorization
  ) external returns (bytes32 withdrawRequestHash) {
    return
      _submitWithdrawRequest(
        params,
        withdrawFeePaymentAuthorization,
        Authorization(0, bytes(""))
      );
  }

  /// @notice Submits a withdrawal authorized by an expiring spender signature, without an additional fee.
  /// @return withdrawRequestHash Canonical withdrawal hash
  function submitWithdrawRequestWithSignature(
    WithdrawRequestAuthorization calldata withdrawRequestAuthorization
  ) public returns (bytes32 withdrawRequestHash) {
    WithdrawFeePaymentAuthorization memory withdrawFeePaymentAuthorization;
    return
      _submitWithdrawRequest(
        withdrawRequestAuthorization.withdrawRequest,
        withdrawFeePaymentAuthorization,
        withdrawRequestAuthorization.authorization
      );
  }

  /// @notice Combines an expiring spender signature with an independent oracle fee authorization.
  /// @return withdrawRequestHash Canonical withdrawal hash
  function submitWithdrawRequestWithSignature(
    WithdrawRequestAuthorization calldata withdrawRequestAuthorization,
    WithdrawFeePaymentAuthorization calldata withdrawFeePaymentAuthorization
  ) external returns (bytes32 withdrawRequestHash) {
    return
      _submitWithdrawRequest(
        withdrawRequestAuthorization.withdrawRequest,
        withdrawFeePaymentAuthorization,
        withdrawRequestAuthorization.authorization
      );
  }

  /// @notice Oracle digest for a single fee payment covering a withdrawal with a runtime amount.
  /// @dev Only this authorization sets request.amount to zero. Canonical request hashes,
  ///      spender signatures and destination identifiers always retain the actual amount.
  ///      Every other request field, the payer, fee currency, ceiling and expiration are signed.
  /// @return digest EIP-712 fee authorization digest
  function hashWithdrawFeePaymentAuthorization(
    WithdrawRequest calldata params,
    WithdrawFeePayment memory withdrawFeePayment,
    uint256 expiration
  ) public view returns (bytes32 digest) {
    WithdrawRequest memory dynamicRequest = params;
    dynamicRequest.amount = 0;
    bytes32 withdrawFeePaymentHash = keccak256(
      abi.encode(
        _WITHDRAW_FEE_PAYMENT_TYPEHASH,
        keccak256(bytes(withdrawFeePayment.payerChainId)),
        keccak256(withdrawFeePayment.payer),
        keccak256(withdrawFeePayment.currency),
        withdrawFeePayment.maxAmount
      )
    );
    return
      _hashTypedDataV4(
        keccak256(
          abi.encode(
            WITHDRAW_FEE_PAYMENT_AUTHORIZATION_TYPEHASH,
            _withdrawRequestStructHash(dynamicRequest),
            withdrawFeePaymentHash,
            expiration
          )
        )
      );
  }

  /// @notice Internal implementation shared by signed and unsigned withdrawal submissions
  /// @param params The withdraw request parameters
  /// @param authorization Optional spender signature and expiration
  /// @return withdrawRequestHash The hash of the withdrawal request
  function _submitWithdrawRequest(
    WithdrawRequest calldata params,
    WithdrawFeePaymentAuthorization memory withdrawFeePaymentAuthorization,
    Authorization memory authorization
  ) internal whenNotPaused returns (bytes32 withdrawRequestHash) {
    if (pausedChains[params.chainId]) {
      revert DestinationChainPaused(params.chainId);
    }

    // Check if the payload builder is set
    address builder = payloadBuilders[params.chainId][params.depository];
    if (builder == address(0)) {
      revert NoPayloadBuilder(params.chainId, params.depository);
    }

    address spenderAlias = _authorizeWithdrawal(params, authorization);

    // Ensure the request wasn't already processed
    withdrawRequestHash = keccak256(abi.encode(params));
    if (payloads[withdrawRequestHash].length > 0) {
      revert WithdrawRequestAlreadyProcessed(withdrawRequestHash);
    }

    // Build payload
    (bytes memory payload, WithdrawFee memory withdrawFee) = _buildPayload(
      builder,
      params
    );
    if (payload.length == 0) {
      revert EmptyPayload();
    }

    // Mark the request as processed
    payloads[withdrawRequestHash] = payload;

    _collectWithdrawFee(
      params,
      withdrawRequestHash,
      withdrawFee,
      withdrawFeePaymentAuthorization
    );

    // Burn the funds from the spender. RelayHub.burn currently either reverts or returns true,
    // so the false branch below is retained only as a defensive guard against future hub changes.
    uint256 tokenId = Utils.generateTokenId(params.chainId, params.currency);
    bool result = RelayHub(HUB).burn(spenderAlias, tokenId, params.amount);
    if (!result) {
      revert WithdrawRequestTransferFailed(
        spenderAlias,
        tokenId,
        params.amount
      );
    }

    // Store the hashes to be signed in contract storage
    bytes32[] memory _hashesToSign = IPayloadBuilder(builder).hashesToSign(
      params.chainId,
      params.depository,
      payload
    );
    if (_hashesToSign.length == 0) {
      revert NoHashesToSign();
    }
    for (uint256 i; i < _hashesToSign.length; ++i) {
      hashesToSign[withdrawRequestHash][i] = _hashesToSign[i];
    }

    emit PayloadBuilt(withdrawRequestHash, payload, _hashesToSign);
  }

  /// @notice Verifies the spender, operator or exact-request signature.
  /// @return spenderAlias Hub alias whose balance funds the withdrawal principal
  function _authorizeWithdrawal(
    WithdrawRequest calldata params,
    Authorization memory authorization
  ) internal returns (address spenderAlias) {
    spenderAlias = Utils.generateAddress(params.spenderChainId, params.spender);

    bool callerIsSpender = params.spender.length == 20 &&
      address(bytes20(params.spender)) == msg.sender &&
      keccak256(bytes(params.spenderChainId)) ==
        keccak256(bytes(LOCAL_CHAIN_ID));
    bool callerIsOperator = RelayHub(HUB).isOperator(spenderAlias, msg.sender);

    if (suspended[spenderAlias]) {
      revert SpenderSuspended(spenderAlias);
    }

    bool callerAuthorized = callerIsSpender || callerIsOperator;
    if (!callerAuthorized) {
      callerAuthorized = consumeSpenderSignature(params, authorization);
    }

    // Only the Relay-local spender itself, an operator, or the spender via signature can trigger withdrawals
    if (!callerAuthorized) {
      revert CallerIsNotApproved(msg.sender);
    }
  }

  /// @notice Verifies and consumes a spender signature for a withdrawal request
  /// @dev For 20-byte spenders, ECDSA recovery is attempted first. If recovery
  ///      fails, the configured oracle is used as a fallback.
  /// @param params The withdrawal request parameters
  /// @param authorization Spender signature and its expiration
  /// @return matched True if the signature matches the spender and the nonce was unused
  function consumeSpenderSignature(
    WithdrawRequest calldata params,
    Authorization memory authorization
  ) internal returns (bool matched) {
    if (authorization.signature.length == 0) {
      return false;
    }

    if (block.timestamp > authorization.expiration)
      revert SignatureExpired(authorization.expiration);

    bytes32 spenderKey = keccak256(params.spender);
    if (usedNonces[spenderKey][params.nonce]) {
      return false;
    }

    bytes32 digest = hashWithdrawRequestAuthorization(
      params,
      authorization.expiration
    );
    if (params.spender.length == 20) {
      address signer = address(bytes20(params.spender));

      (address recovered, ECDSA.RecoverError recoverError, ) = ECDSA.tryRecover(
        digest,
        authorization.signature
      );
      if (recoverError == ECDSA.RecoverError.NoError && recovered == signer) {
        usedNonces[spenderKey][params.nonce] = true;
        return true;
      }
    }

    if (ORACLE_MULTISIG.isValidSignatureNow(digest, authorization.signature)) {
      usedNonces[spenderKey][params.nonce] = true;
      return true;
    }

    return false;
  }

  /// @notice Computes the EIP-712 WithdrawRequestAuthorization digest
  /// @param params Withdrawal request parameters
  /// @param expiration Last valid Unix timestamp in seconds for the signature
  /// @return digest EIP-712 digest signed by the spender
  function hashWithdrawRequestAuthorization(
    WithdrawRequest calldata params,
    uint256 expiration
  ) public view returns (bytes32 digest) {
    return
      _hashTypedDataV4(
        keccak256(
          abi.encode(
            WITHDRAW_REQUEST_AUTHORIZATION_TYPEHASH,
            _withdrawRequestStructHash(params),
            expiration
          )
        )
      );
  }

  /// @notice Computes the typed hash of the original withdrawal tuple.
  /// @return hash EIP-712 struct hash without the domain separator
  function _withdrawRequestStructHash(
    WithdrawRequest memory params
  ) internal pure returns (bytes32 hash) {
    return
      keccak256(
        abi.encode(
          WITHDRAW_REQUEST_TYPEHASH,
          keccak256(bytes(params.chainId)),
          keccak256(params.depository),
          keccak256(params.currency),
          params.amount,
          keccak256(bytes(params.spenderChainId)),
          keccak256(params.spender),
          keccak256(params.receiver),
          keccak256(params.data),
          params.nonce
        )
      );
  }

  /// @notice Charges only the designated payer after validating a single-use oracle authorization.
  function _collectWithdrawFee(
    WithdrawRequest calldata params,
    bytes32 requestHash,
    WithdrawFee memory withdrawFee,
    WithdrawFeePaymentAuthorization memory withdrawFeePaymentAuthorization
  ) internal {
    if (
      withdrawFee.amount == 0 &&
      withdrawFeePaymentAuthorization.authorization.signature.length == 0
    ) return;
    WithdrawFeePayment
      memory withdrawFeePayment = withdrawFeePaymentAuthorization
        .withdrawFeePayment;
    if (withdrawFee.amount > withdrawFeePayment.maxAmount)
      revert WithdrawFeeExceedsLimit(
        withdrawFee.amount,
        withdrawFeePayment.maxAmount
      );
    if (
      withdrawFee.amount != 0 &&
      keccak256(withdrawFee.currency) != keccak256(withdrawFeePayment.currency)
    ) revert WithdrawFeeCurrencyMismatch();
    if (
      block.timestamp > withdrawFeePaymentAuthorization.authorization.expiration
    )
      revert WithdrawFeePaymentAuthorizationExpired(
        withdrawFeePaymentAuthorization.authorization.expiration
      );
    bytes32 digest = hashWithdrawFeePaymentAuthorization(
      params,
      withdrawFeePayment,
      withdrawFeePaymentAuthorization.authorization.expiration
    );
    if (usedWithdrawFeePaymentAuthorizations[digest])
      revert WithdrawFeePaymentAuthorizationUsed(digest);
    if (
      !ORACLE_MULTISIG.isValidSignatureNow(
        digest,
        withdrawFeePaymentAuthorization.authorization.signature
      )
    ) revert InvalidWithdrawFeePaymentAuthorization();
    usedWithdrawFeePaymentAuthorizations[digest] = true;
    if (withdrawFee.amount == 0) return;
    address feePayerAlias = Utils.generateAddress(
      withdrawFeePayment.payerChainId,
      withdrawFeePayment.payer
    );
    if (suspended[feePayerAlias]) revert SpenderSuspended(feePayerAlias);
    uint256 tokenId = Utils.generateTokenId(
      params.chainId,
      withdrawFee.currency
    );
    if (!RelayHub(HUB).burn(feePayerAlias, tokenId, withdrawFee.amount))
      revert WithdrawRequestTransferFailed(
        feePayerAlias,
        tokenId,
        withdrawFee.amount
      );
    emit WithdrawFeePaid(
      requestHash,
      feePayerAlias,
      tokenId,
      withdrawFee.amount
    );
  }

  /// @inheritdoc IWithdrawalCounter
  function withdrawalsThisSecond(
    string calldata chainId
  ) public view returns (uint256 withdrawals) {
    uint256 packed = withdrawalCounts[keccak256(bytes(chainId))];
    // slither-disable-next-line incorrect-equality
    return packed >> 64 == block.timestamp ? uint64(packed) : 0;
  }

  /// @notice Builds a payload using the configured builder for the given request
  /// @dev Forwards the whole request so builders can bind destination ids to it where the VM
  ///      allows it, instead of only to parameters two spenders may submit identically.
  ///      The withdrawal is counted after the builder returns, so the builder reads the count before it.
  /// @param builder Payload builder address
  /// @param params Withdrawal request parameters
  /// @return payload Encoded withdrawal payload
  /// @return withdrawFee Additional Hub debit required for the payload
  function _buildPayload(
    address builder,
    WithdrawRequest calldata params
  ) internal returns (bytes memory payload, WithdrawFee memory withdrawFee) {
    (payload, withdrawFee) = IPayloadBuilder(builder).buildPayload(
      params.chainId,
      params.depository,
      params
    );
    withdrawalCounts[keccak256(bytes(params.chainId))] =
      (block.timestamp << 64) | (withdrawalsThisSecond(params.chainId) + 1);
  }
}
