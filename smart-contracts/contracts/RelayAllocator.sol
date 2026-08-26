// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {RelayHub} from "./RelayHub.sol";
import {Utils} from "./Utils.sol";

/// @notice Parameters passed to a payload builder for constructing a withdrawal payload
struct BuildPayloadParams {
  bytes currency; /// @notice Encoded currency address
  uint256 amount; /// @notice Amount to withdraw
  bytes receiver; /// @notice Encoded receiver address
  uint256 nonce; /// @notice Request nonce
  bytes data; /// @notice Additional payload builder data
}

/// @title IPayloadBuilder
/// @author Relay Protocol
/// @notice Interface for payload builders that create withdrawal payloads for different chains
interface IPayloadBuilder {
  /// @notice Builds a withdrawal payload for the specified parameters
  /// @param chainId The destination chain id
  /// @param depository The depository address
  /// @param params Payload builder parameters
  /// @return payload The built payload
  function buildPayload(
    string calldata chainId,
    bytes calldata depository,
    BuildPayloadParams calldata params
  ) external view returns (bytes memory payload);

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

/// @title RelayAllocator
/// @author Relay Protocol
/// @notice Manages cross-chain withdrawal requests and payload signing
contract RelayAllocator is Ownable, EIP712 {
  using ECDSA for bytes32;
  using SignatureChecker for address;

  /// --- Fields ---

  /// @notice The signing domain for EIP-712 receiver-authorized withdrawals
  string public constant SIGNING_DOMAIN = "RelayAllocator";

  /// @notice The signature version for EIP-712 receiver-authorized withdrawals
  string public constant SIGNATURE_VERSION = "1";

  /// @notice The type hash for WithdrawRequest receiver signatures
  bytes32 public constant PAYLOAD_TYPEHASH =
    keccak256(
      "WithdrawRequest(string chainId,bytes depository,bytes currency,uint256 amount,string spenderChainId,bytes spender,bytes receiver,bytes data,bytes32 nonce)"
    );

  /// @notice Address of the hub contract
  address public immutable HUB;

  /// @notice RelayOracleMultisig contract used to verify spender signatures
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

  /// @notice Thrown when a payload builder returns an empty payload
  error EmptyPayload();

  // --- Structs ---

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

  /// @notice Creates a new RelayAllocator contract
  /// @param _owner Owner of the contract
  /// @param _hub Hub contract address
  /// @param _oracleMultisig RelayOracleMultisig contract address used to verify spender signatures
  constructor(
    address _owner,
    address _hub,
    address _oracleMultisig
  ) Ownable(_owner) EIP712(SIGNING_DOMAIN, SIGNATURE_VERSION) {
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

  /// @notice Submits a withdraw request to the payload builder
  /// @param params The withdraw request parameters
  /// @return withdrawRequestHash The hash of the withdrawal request
  function submitWithdrawRequest(
    WithdrawRequest calldata params
  ) public returns (bytes32 withdrawRequestHash) {
    return _submitWithdrawRequest(params, bytes(""));
  }

  /// @notice Submits a withdraw request using a receiver signature when the spender is the receiver alias
  /// @param params The withdraw request parameters
  /// @param signature EIP-712 signature produced by the receiver
  /// @return withdrawRequestHash The hash of the withdrawal request
  function submitWithdrawRequestWithSignature(
    WithdrawRequest calldata params,
    bytes calldata signature
  ) public returns (bytes32 withdrawRequestHash) {
    return _submitWithdrawRequest(params, signature);
  }

  /// @notice Internal implementation shared by signed and unsigned withdrawal submissions
  /// @param params The withdraw request parameters
  /// @param signature Optional receiver signature
  /// @return withdrawRequestHash The hash of the withdrawal request
  function _submitWithdrawRequest(
    WithdrawRequest calldata params,
    bytes memory signature
  ) internal returns (bytes32 withdrawRequestHash) {
    // Check if the payload builder is set
    address builder = payloadBuilders[params.chainId][params.depository];
    if (builder == address(0)) {
      revert NoPayloadBuilder(params.chainId, params.depository);
    }

    address spenderAlias = Utils.generateAddress(
      params.spenderChainId,
      params.spender
    );

    bool callerIsSpender = params.spender.length == 20 &&
      address(bytes20(params.spender)) == msg.sender;
    bool callerIsOperator = RelayHub(HUB).isOperator(spenderAlias, msg.sender);

    if (suspended[spenderAlias]) {
      revert SpenderSuspended(spenderAlias);
    }

    bool callerAuthorized = callerIsSpender || callerIsOperator;
    if (!callerAuthorized) {
      callerAuthorized = consumeSpenderSignature(params, signature);
    }

    // Only the spender itself, an operator, or the spender via signature can trigger withdrawals
    if (!callerAuthorized) {
      revert CallerIsNotApproved(msg.sender);
    }

    // Ensure the request wasn't already processed
    withdrawRequestHash = keccak256(abi.encode(params));
    if (payloads[withdrawRequestHash].length > 0) {
      revert WithdrawRequestAlreadyProcessed(withdrawRequestHash);
    }

    // Build payload
    bytes memory payload = _buildPayload(builder, params);
    if (payload.length == 0) {
      revert EmptyPayload();
    }

    // Mark the request as processed
    payloads[withdrawRequestHash] = payload;

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
    for (uint256 i; i < _hashesToSign.length; ++i) {
      hashesToSign[withdrawRequestHash][i] = _hashesToSign[i];
    }

    emit PayloadBuilt(withdrawRequestHash, payload, _hashesToSign);
  }

  /// @notice Verifies and consumes a spender signature for a withdrawal request
  /// @dev For 20-byte spenders, ECDSA recovery is attempted first. If recovery
  ///      fails, the configured oracle is used as a fallback.
  /// @param params The withdrawal request parameters
  /// @param signature The signature to verify
  /// @return matched True if the signature matches the spender and the nonce was unused
  function consumeSpenderSignature(
    WithdrawRequest calldata params,
    bytes memory signature
  ) internal returns (bool matched) {
    if (signature.length == 0) {
      return false;
    }

    bytes32 spenderKey = keccak256(params.spender);
    if (usedNonces[spenderKey][params.nonce]) {
      return false;
    }

    bytes32 digest = _withdrawRequestDigest(params);
    if (params.spender.length == 20) {
      address signer = address(bytes20(params.spender));

      (address recovered, ECDSA.RecoverError recoverError, ) = ECDSA.tryRecover(
        digest,
        signature
      );
      if (recoverError == ECDSA.RecoverError.NoError && recovered == signer) {
        usedNonces[spenderKey][params.nonce] = true;
        return true;
      }
    }

    if (ORACLE_MULTISIG.isValidSignatureNow(digest, signature)) {
      usedNonces[spenderKey][params.nonce] = true;
      return true;
    }

    return false;
  }

  /// @notice Computes the EIP-712 digest for a withdrawal request
  /// @param params Withdrawal request parameters
  /// @return digest EIP-712 digest signed by the spender
  function _withdrawRequestDigest(
    WithdrawRequest calldata params
  ) internal view returns (bytes32 digest) {
    return
      _hashTypedDataV4(
        keccak256(
          abi.encode(
            PAYLOAD_TYPEHASH,
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
        )
      );
  }

  /// @notice Builds a payload using the configured builder for the given request
  /// @param builder Payload builder address
  /// @param params Withdrawal request parameters
  /// @return payload Encoded withdrawal payload
  function _buildPayload(
    address builder,
    WithdrawRequest calldata params
  ) internal view returns (bytes memory payload) {
    return
      IPayloadBuilder(builder).buildPayload(
        params.chainId,
        params.depository,
        BuildPayloadParams({
          currency: params.currency,
          amount: params.amount,
          receiver: params.receiver,
          nonce: uint256(params.nonce),
          data: params.data
        })
      );
  }
}
