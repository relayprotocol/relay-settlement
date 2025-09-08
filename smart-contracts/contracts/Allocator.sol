// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {AuroraSdk, NEAR, PromiseCreateArgs, PromiseResult, PromiseResultStatus, PromiseWithCallback} from "./aurora-xcc/AuroraSdk.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {Hub} from "./Hub.sol";
import {Utils} from "./Utils.sol";

interface ISafe {
  function isOwner(address) external view returns (bool);
}

interface PayloadBuilder {
  error InsufficientAmount(uint256 amount);

  function buildPayload(
    uint256 chainId,
    string calldata depository,
    string calldata currency,
    uint256 amount,
    string calldata receiver,
    bytes calldata data
  ) external view returns (bytes memory);

  function hashesToSign(
    uint256 chainId,
    string calldata depository,
    bytes calldata payload
  ) external view returns (bytes32[] memory);

  function curve() external pure returns (string memory);

  function family() external pure returns (string memory);
}

// Default gas settings
uint64 constant DEFAULT_SIGN_GAS = 30_000_000_000_000; // 30 Tgas
uint64 constant DEFAULT_CALLBACK_GAS = 10_000_000_000_000; // 10 Tgas

/// @title Allocator
/// @notice Manages cross-chain withdrawal requests and payload signing using NEAR MPC signer
contract Allocator is AccessControl, Ownable, EIP712 {
  using AuroraSdk for NEAR;
  using AuroraSdk for PromiseCreateArgs;
  using AuroraSdk for PromiseWithCallback;
  using AuroraSdk for PromiseResult;
  using Strings for uint256;
  using ECDSA for bytes32;

  event DelayChanged(uint256 delay);
  event DepositoryDelayChanged(
    uint256 chainId,
    string depository,
    uint256 delay
  );
  event HubSet(address hub);

  // EIP712
  string public constant SIGNING_DOMAIN = "Allocator";
  string public constant SIGNATURE_VERSION = "1";
  bytes32 public constant PAYLOAD_TYPEHASH =
    keccak256(
      "SubmitWithdrawRequest(uint256 chainId,string depository,string currency,uint256 amount,address spender,string receiver,bytes data,bytes32 nonce)"
    );

  // roles
  bytes32 public constant APPROVED_WITHDRAWER_ROLE =
    keccak256("APPROVED_WITHDRAWER_ROLE");
  bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
  
  // precompute the hash of the curve
  bytes32 private constant ECDSA_HASH = keccak256("Ecdsa");

  // NEAR signer account
  string public nearSigner;

  // Aurora SDK instance
  NEAR public near;

  // global delay
  uint256 public delay;

  // used by the MPC signer to sign the payload
  string public SIGNER_PATH;

  // Delay configuration struct
  struct DelayConfig {
    uint256 delay;
    bool isSet;
  }

  // per-depository delay mapping (chainId => depository address as string => DelayConfig)
  mapping(uint256 => mapping(string => DelayConfig)) public depositoryDelays;

  // address of the hub contract
  address public hub;

  // payload builders mapping
  mapping(uint256 => mapping(string => address)) public payloadBuilders;

  // unsigned payloads
  mapping(bytes32 => Payload) public payloads;

  // signed payloads
  mapping(bytes32 => mapping(bytes32 => bytes)) public signedPayloads;

  // payload timestamps
  mapping(bytes32 => uint256) public payloadTimestamps;

  // used nonces for replay protection
  mapping(bytes32 => bool) public usedNonces;

  // events
  event PayloadBuilderSet(
    uint256 indexed chainId,
    string indexed depository,
    address indexed builder
  );

  event PayloadBuilt(
    bytes32 indexed payloadId,
    bytes payload,
    uint256 timestamp
  );

  event PayloadWithdrawSigned(
    bytes32 indexed payloadId,
    bytes32 indexed hashToSign,
    bytes signedPayload
  );

  // errors
  error NotMultisigOwner(address account);
  error CallerIsNotApproved(address account);
  error NoPayloadBuilder(uint256 chainId, string depository);
  error PayloadNotReady(bytes32 payloadId);
  error PayloadAlreadySigned(bytes32 payloadId);
  error SignCallbackFailed(bytes32 payloadId);
  error WithdrawalRequestFailed();

  struct SubmitWithdrawRequest {
    uint256 chainId; // ChainId of the destination chain on which the user will withdraw
    string depository; // Address of the depository account as a string so we can support non EVM
    string currency; // Address of the currency to be withdrawn, as a string so we can support non EVM. Use zero address for native.
    uint256 amount; // Amount to withdraw
    address spender; // Address of the account that owns the balance in the Hub contract (can be an alias)
    string receiver; // Address of the account on the destinattion chain as a string so we can support non EVM
    bytes data; // Additional data to be passed to the payload builder
    bytes32 nonce; // Nonce for replay protection
  }

  struct Payload {
    SubmitWithdrawRequest params;
    bytes unsignedPayload;
  }

  // NEAR gas settings
  struct GasSettings {
    uint64 signGas;
    uint64 callbackGas;
  }

  constructor(
    address _owner,
    uint256 _delay,
    string memory _signer,
    address _wNEAR
  ) Ownable(_owner) EIP712(SIGNING_DOMAIN, SIGNATURE_VERSION) {
    // roles
    _setRoleAdmin(APPROVED_WITHDRAWER_ROLE, ADMIN_ROLE);
    _grantRole(ADMIN_ROLE, _owner);

    // delay
    delay = _delay;

    // set signer and Aurora SDK
    nearSigner = _signer;
    near = AuroraSdk.initNear(IERC20(_wNEAR));

    // compute path at deployment
    SIGNER_PATH = Strings.toHexString(uint160(address(this)), 20);
  }

  modifier onlyMultisigOwner() {
    if (!ISafe(owner()).isOwner(msg.sender))
      revert NotMultisigOwner(msg.sender);
    _;
  }

  /// @notice initializes XCC sub-account for the contract
  /// You need to approve 2 wNEAR for the CS Signer to init the sub-account
  /// @notice This calls the simplest possible contract on NEAR to bootstrap itself and initialize the XCC subaccount.
  function init() public onlyOwner {
    // Make a cross-contract call to trigger sub-account creation.
    // solhint-disable-next-line quotes
    PromiseCreateArgs memory initCall = near.call(
      // we are calling the "system" account with empty data on NEAR to trigger sub-account creation
      // as "system" is a special account that is not part of the chain state.
      "system",
      "",
      "",
      0,
      500_000_000_000
    );
    initCall.transact();
  }

  /// @notice prevents a withdrawer from withdrawing
  /// @param withdrawer Address to prevent from withdrawing
  function suspend(address withdrawer) public onlyMultisigOwner {
    _revokeRole(APPROVED_WITHDRAWER_ROLE, withdrawer);
  }

  /// @notice Sets the hub contract address
  /// @param _hub Hub contract address
  function setHub(address _hub) external onlyOwner {
    hub = _hub;
    emit HubSet(hub);
  }

  /// @notice Sets the global delay for withdrawal requests
  /// @param _delay Delay in seconds
  function setDelay(uint256 _delay) public onlyOwner {
    delay = _delay;
    emit DelayChanged(delay);
  }

  /// @notice sets or updates the delay for a specific chain and depository
  /// @param chainId chain ID
  /// @param depository address of the depository contract as string
  /// @param _delay delay in seconds
  function setDepositoryDelay(
    uint256 chainId,
    string calldata depository,
    uint256 _delay
  ) external onlyOwner {
    depositoryDelays[chainId][depository].delay = _delay;
    depositoryDelays[chainId][depository].isSet = true;
    emit DepositoryDelayChanged(chainId, depository, _delay);
  }

  /// @notice sets or updates the payload builder for a specific chain
  /// @param chainId chain ID
  /// @param builder address of the payload builder contract
  function setPayloadBuilder(
    uint256 chainId,
    string calldata depository,
    address builder
  ) external onlyOwner {
    payloadBuilders[chainId][depository] = builder;
    emit PayloadBuilderSet(chainId, depository, builder);
  }

  /// @notice submits a withdraw request to the payload builder, store the returned payload, and trigger its signature immediately
  /// @param params The withdraw request parameters
  /// @param signature The signature of the withdraw request, if sent on behalf of a recipient
  function submitAndSignWithdrawRequest(
    SubmitWithdrawRequest calldata params,
    bytes memory signature
  ) public returns (bytes32 payloadId) {
    payloadId = _submitWithdrawRequest(params);
    signWithdrawPayload(
      payloadId,
      signature,
      GasSettings(DEFAULT_SIGN_GAS, DEFAULT_CALLBACK_GAS)
    );
  }

  /// @notice submits a withdraw request to the payload builder, store the returned payload
  /// @param params The withdraw request parameters
  function submitWithdrawRequest(
    SubmitWithdrawRequest calldata params
  ) public returns (bytes32 payloadId) {
    return _submitWithdrawRequest(params);
  }

  /// @notice submits a withdraw request to the payload builder, store the returned payload
  /// @param params The withdraw request parameters
  function _submitWithdrawRequest(
    SubmitWithdrawRequest calldata params
  ) internal returns (bytes32 payloadId) {
    // check if the payload builder is set
    address builder = payloadBuilders[params.chainId][params.depository];
    if (builder == address(0)) {
      revert NoPayloadBuilder(params.chainId, params.depository);
    }

    bytes memory payload = PayloadBuilder(builder).buildPayload(
      params.chainId,
      params.depository,
      params.currency,
      params.amount,
      params.receiver,
      params.data
    );
    payloadId = keccak256(abi.encodePacked(payload, block.timestamp));
    payloads[payloadId] = Payload({params: params, unsignedPayload: payload});

    // Use depository-specific delay if set, otherwise fall back to global delay
    uint256 depositoryDelay = depositoryDelays[params.chainId][
      params.depository
    ].delay;
    uint256 effectiveDelay = depositoryDelays[params.chainId][params.depository]
      .isSet
      ? depositoryDelay
      : delay;

    payloadTimestamps[payloadId] = block.timestamp + effectiveDelay;

    emit PayloadBuilt(payloadId, payload, payloadTimestamps[payloadId]);
    return payloadId;
  }

  /// @notice triggers the signing of a previously submitted withdraw request
  /// @param payloadId hash of the payload to sign
  /// @param signature The signature of the withdraw request, if sent on behalf of a recipient
  /// @param gasSettings struct containing gas settings for NEAR operations
  /// @dev This function is called by the NEAR signer account to sign the payload.
  /// It checks if the payload is ready to be signed (i.e. the delay has passed) and
  /// if the payload has not already been signed. If the payload is ready, it calls
  /// the NEAR signer account to sign the payload and then calls the signWithdrawCallback
  /// function to handle the result of the signing.
  function signWithdrawPayload(
    bytes32 payloadId,
    bytes memory signature,
    GasSettings memory gasSettings
  ) public {
    Payload storage payload = payloads[payloadId];
    SubmitWithdrawRequest memory params = payload.params;
    address builder = payloadBuilders[params.chainId][params.depository];
    if (builder == address(0)) {
      revert NoPayloadBuilder(params.chainId, params.depository);
    }

    // check if the payload is ready to be signed
    if (payloadTimestamps[payloadId] > block.timestamp) {
      revert PayloadNotReady(payloadId);
    }

    PayloadBuilder payloadBuilder = PayloadBuilder(builder);

    // verify the withdrawal can be achieved
    verifyWithdrawal(payloads[payloadId], payloadBuilder, signature);

    bytes32[] memory hashesToSign = payloadBuilder.hashesToSign(
      params.chainId,
      params.depository,
      payload.unsignedPayload
    );

    for (uint256 i = 0; i < hashesToSign.length; i++) {
      _signUsingChainSignatures(payloadId, hashesToSign[i], payloadBuilder, gasSettings);
    }
  }

  function _signUsingChainSignatures(
    bytes32 payloadId,
    bytes32 hashToSign,
    PayloadBuilder payloadBuilder,
    GasSettings memory gasSettings
  ) internal {
    if (signedPayloads[payloadId][hashToSign].length > 0) {
      revert PayloadAlreadySigned(payloadId);
    }

    // Encode the JSON request for the signer
    bytes memory data = encodeJSONRequest(
      hashToSign,
      payloadBuilder.curve(),
      keccak256(abi.encodePacked(payloadBuilder.curve())) == ECDSA_HASH
        ? "0"
        : "1"
    );

    // Now get NEAR to sign the payload!
    PromiseCreateArgs memory callSign = near.call(
      nearSigner,
      "sign",
      data,
      // the docs here https://github.com/aurora-is-near/chain-signatures-signer/tree/main?tab=readme-ov-file#signing-the-payload
      // states that 1 yoctoNEAR is usually enough to sign the call successfully
      1, // attachedNear
      gasSettings.signGas
    );
    PromiseCreateArgs memory callback = near.auroraCall(
      address(this),
      abi.encodeWithSelector(
        this.signWithdrawCallback.selector,
        payloadId,
        hashToSign
      ),
      0,
      gasSettings.callbackGas
    );

    callSign.then(callback).transact();
  }

  /// @notice callback function to handle the result of the signing
  /// @param payloadId hash of the payload that was signed
  /// @dev This function is called by the NEAR signer account after the signing is complete.
  /// It checks if the signing was successful and if so, stores the signed payload in the
  /// signedPayloads mapping. It also emits an event to notify that the payload has been signed.
  function signWithdrawCallback(bytes32 payloadId, bytes32 hashToSign) public {
    if (
      msg.sender != AuroraSdk.nearRepresentitiveImplicitAddress(address(this))
    ) {
      revert AccessControlUnauthorizedAccount(
        msg.sender,
        keccak256("SIGNATURE_CALLBACK_ROLE")
      );
    }
    // triggering this function requires Aurora precompiles and therefore has no unit tests
    PromiseResult memory result = AuroraSdk.promiseResult(0);

    if (result.status != PromiseResultStatus.Successful) {
      revert SignCallbackFailed(payloadId);
    }

    signedPayloads[payloadId][hashToSign] = result.output;
    emit PayloadWithdrawSigned(payloadId, hashToSign, result.output);
  }

  /// @notice Encodes a JSON request for the signer
  /// @param payloadHashToSign The hash of the payload to sign
  /// @param curve The curve to use for signing
  /// @param domain_id The domain ID
  /// @return The encoded JSON request
  function encodeJSONRequest(
    bytes32 payloadHashToSign,
    string memory curve,
    string memory domain_id
  ) public view returns (bytes memory) {
    return
      abi.encodePacked(
        // solhint-disable-next-line quotes
        '{"request":{"payload_v2": { "',
        curve,
        // solhint-disable-next-line quotes
        '":"',
        stringifyBytes(payloadHashToSign),
        // solhint-disable-next-line quotes
        '"},"path":"',
        SIGNER_PATH,
        // solhint-disable-next-line quotes
        '","domain_id":',
        domain_id,
        // solhint-disable-next-line quotes
        "}}"
      );
  }

  /// @notice Converts a bytes32 value to its string representation
  /// @param hexBytes The bytes32 value to convert
  /// @return The string representation of the bytes32 value
  function stringifyBytes(
    bytes32 hexBytes
  ) public pure returns (string memory) {
    bytes memory alphabet = "0123456789abcdef";
    bytes memory str = new bytes(64);
    for (uint256 i = 0; i < 32; i++) {
      str[i * 2] = alphabet[uint256(uint8(hexBytes[i] >> 4))];
      str[1 + i * 2] = alphabet[uint256(uint8(hexBytes[i] & 0x0f))];
    }
    return string(str);
  }

  /// @notice Verifies if the withdrawal request can be achieved.
  /// @dev The withdrawal can be achieved if the caller is an approved withdrawer, or,
  /// if the hub is set, it will first transfer the user's token to this contract's balance.
  /// @param payload The payload containing the withdrawal details
  /// @param payloadBuilder The payload builder containing the withdrawal details
  /// @param signature A signature for the withdrawal request, if sent on behalf of a recipient
  function verifyWithdrawal(
    Payload memory payload,
    PayloadBuilder payloadBuilder,
    bytes memory signature
  ) internal {
    // Implementation for verifying the withdrawal
    if (hasRole(APPROVED_WITHDRAWER_ROLE, msg.sender)) {
      return;
    }

    string memory family = payloadBuilder.family();

    // Generate the tokenId
    uint256 tokenId = Utils.generateTokenId(
      family,
      payload.params.chainId,
      payload.params.currency
    );

    address spenderAlias = Utils.generateAddress(
      family,
      payload.params.chainId,
      payload.params.receiver
    );

    // Only an operator for the spender can trigger withdrawals or a valid signature by the recipient must be provided.
    if (
      !(payload.params.spender == msg.sender ||
        Hub(hub).isOperator(payload.params.spender, msg.sender) ||
        (spenderAlias == payload.params.spender &&
          signatureMatchesReceiver(payload.params, signature)))
    ) {
      revert CallerIsNotApproved(msg.sender);
    }

    // Actually perform the transfer
    Hub(hub).transferFrom(
      payload.params.spender,
      address(this),
      tokenId,
      payload.params.amount
    );
  }

  /// @notice Checks if the signature matches the receiver's address (for EVM destination chains)
  /// @param params The withdrawal request parameters
  /// @param signature The signature to verify
  function signatureMatchesReceiver(
    SubmitWithdrawRequest memory params,
    bytes memory signature
  ) internal returns (bool) {
    if (signature.length == 0) return false;

    address signer = Utils.toAddress(params.receiver);

    // Check if nonce has been used before
    if (usedNonces[params.nonce]) {
      return false;
    }

    // Create the digest using EIP712
    bytes32 digest = _hashTypedDataV4(
      keccak256(
        abi.encode(
          PAYLOAD_TYPEHASH,
          params.chainId,
          keccak256(bytes(params.depository)),
          keccak256(bytes(params.currency)),
          params.amount,
          params.spender,
          keccak256(bytes(params.receiver)),
          keccak256(params.data),
          params.nonce
        )
      )
    );

    if (digest.recover(signature) != signer) {
      return false;
    }

    // Mark nonce as used to prevent replay
    usedNonces[params.nonce] = true;
    return true;
  }
}
