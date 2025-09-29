// SPDX-License-Identifier: MIT
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
import {ChainSignatures} from "./ChainSignatures.sol";

/// @title IEvmERC20
/// @notice Interface for EVM ERC20 tokens that support withdrawal to NEAR
// solhint-disable-next-line use-natspec
interface IEvmERC20 is IERC20 {
  /// @notice Withdraws tokens to NEAR network
  /// @param recipient The recipient address on NEAR
  /// @param amount The amount to withdraw
  function withdrawToNear(bytes memory recipient, uint256 amount) external;
}

/// @title ISafe
/// @notice Interface for Safe multisig contract
// solhint-disable-next-line use-natspec
interface ISafe {
  /// @notice Checks if an address is an owner of the Safe
  /// @param owner The address to check
  /// @return True if the address is an owner
  function isOwner(address owner) external view returns (bool);
}

/// @title IPayloadBuilder
/// @author Relay Protocol
/// @notice Interface for payload builders that create withdrawal payloads for different chains
interface IPayloadBuilder {
  error InsufficientAmount(uint256 amount);

  /// @notice Builds a withdrawal payload for the specified parameters
  /// @param chainId The destination chain ID
  /// @param depository The depository address
  /// @param currency The currency address
  /// @param amount The amount to withdraw
  /// @param receiver The receiver address
  /// @param data Additional data
  /// @return The built payload
  function buildPayload(
    uint256 chainId,
    string calldata depository,
    string calldata currency,
    uint256 amount,
    string calldata receiver,
    bytes calldata data
  ) external view returns (bytes memory);

  /// @notice Returns the hashes that need to be signed for the payload
  /// @param chainId The destination chain ID
  /// @param depository The depository address
  /// @param payload The payload to sign
  /// @return Array of hashes to sign
  function hashToSign(
    uint256 chainId,
    string calldata depository,
    bytes calldata payload,
    uint32 hashIndex
  ) external view returns (bytes32);

  /// @notice Returns the curve used for signing
  /// @return The curve name
  function curve() external pure returns (string memory);

  /// @notice Returns the family of the payload builder
  /// @return The family name
  function family() external pure returns (string memory);
}

// NEAR gas settings
struct GasSettings {
  uint64 signGas;
  uint64 callbackGas;
}

/// @title Allocator
/// @author Relay Protocol
/// @notice Manages cross-chain withdrawal requests and payload signing using NEAR MPC signer
contract Allocator is AccessControl, Ownable, EIP712 {
  using AuroraSdk for NEAR;
  using AuroraSdk for PromiseCreateArgs;
  using AuroraSdk for PromiseWithCallback;
  using AuroraSdk for PromiseResult;
  using Strings for uint256;
  using ECDSA for bytes32;

  /// @notice Emitted when the global delay is changed
  event DelayChanged(uint256 delay);
  /// @notice Emitted when a depository-specific delay is changed
  event DepositoryDelayChanged(
    uint256 chainId,
    string depository,
    uint256 delay
  );
  /// @notice Emitted when the hub contract is set
  event HubSet(address hub);
  /// @notice Emitted when the signature fee is changed
  event SignatureFeeChanged(uint256 fee);

  // EIP712
  /// @notice The signing domain for EIP712
  string public constant SIGNING_DOMAIN = "Allocator";
  /// @notice The signature version for EIP712
  string public constant SIGNATURE_VERSION = "1";
  /// @notice The type hash for SubmitWithdrawRequest
  bytes32 public constant PAYLOAD_TYPEHASH =
    keccak256(
      "SubmitWithdrawRequest(uint256 chainId,string depository,string currency,uint256 amount,address spender,string receiver,bytes data,bytes32 nonce)"
    );

  // roles
  /// @notice Role for approved withdrawers
  bytes32 public constant APPROVED_WITHDRAWER_ROLE =
    keccak256("APPROVED_WITHDRAWER_ROLE");
  /// @notice Role for administrators
  bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

  /// @notice Precompute the hash of the curve
  bytes32 private constant ECDSA_HASH = keccak256("Ecdsa");

  /// @notice Gas for withdrawals to NEAR
  uint64 public immutable NEAR_WITHDRAW_GAS = 2_000_000_000_000;

  /// @notice The NEAR signer account address
  string public nearSigner;

  /// @notice The Aurora SDK NEAR instance
  NEAR public near;

  /// @notice Global delay for withdrawal requests
  uint256 public delay;

  /// @notice Path used by the MPC signer to sign the payload
  string public signerPath;

  /// @notice Fee in wNEAR to cover gas on NEAR
  uint256 public signatureFee;

  /// @notice Delay configuration struct
  struct DelayConfig {
    uint256 delay;
    bool isSet;
  }

  /// @notice Mapping of delays per-depository : chain ID => depository => delay
  mapping(uint256 => mapping(string => DelayConfig)) public depositoryDelays;

  /// @notice Address of the hub contract
  address public hub;

  /// @notice Mapping of payload builders: chain ID => depository => payload builder address
  mapping(uint256 => mapping(string => address)) public payloadBuilders;

  /// @notice Signed payloads: withdrawal request hash => hash to sign => signed payload
  mapping(bytes32 => mapping(bytes32 => bytes)) public signedPayloads;

  /// @notice Payload timestamps: withdrawal request hash => timestamp when payload becomes ready
  mapping(bytes32 => uint256) public payloadTimestamps;

  /// @notice Unsigned payloads: withdrawal request hash => payload
  mapping(bytes32 => bytes) public payloads;

  /// @notice Used nonces for replay protection: nonce => whether it has been used
  mapping(bytes32 => bool) public usedNonces;

  /// @notice Emitted when a payload builder is set for a chain and depository
  event PayloadBuilderSet(
    uint256 indexed chainId,
    string indexed depository,
    address indexed builder
  );

  /// @notice Emitted when a payload is built
  event PayloadBuilt(
    bytes32 indexed withdrawRequestHash,
    bytes payload,
    uint256 timestamp
  );

  /// @notice Emitted when a payload is signed
  event PayloadWithdrawSigned(
    bytes32 indexed withdrawRequestHash,
    bytes32 indexed hashToSign,
    bytes signedPayload
  );

  // errors
  error NotMultisigOwner(address account);
  error CallerIsNotApproved(address account);
  error NoPayloadBuilder(uint256 chainId, string depository);
  error PayloadNotReady(bytes32 withdrawRequestHash);
  error PayloadAlreadySigned(bytes32 withdrawRequestHash);
  error SignCallbackFailed(bytes32 withdrawRequestHash);
  error WithdrawalRequestFailed();

  struct SubmitWithdrawRequest {
    uint256 chainId; // ChainId of the destination chain on which the user will withdraw
    string depository; // Address of the depository account as a string so we can support non EVM
    string currency; // Address of the currency to be withdrawn, as a string so we can support non EVM. Use zero address for native.
    uint256 amount; // Amount to withdraw
    address spender; // Address of the account that owns the balance in the Hub contract (can be an alias)
    string receiver; // Address of the account on the destination chain as a string so we can support non EVM
    bytes data; // Additional data to be passed to the payload builder
    bytes32 nonce; // Nonce for replay protection
  }

  /// @notice Constructor for Allocator contract
  /// @param _owner The owner of the contract
  /// @param _delay The global delay for withdrawal requests
  /// @param _signer The NEAR signer account
  /// @param _wNEAR The wNEAR token address
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
    near = AuroraSdk.initNear(IERC20(_wNEAR)); // this does an unlimited approval for wNEAR for the precompile.

    // compute path at deployment
    signerPath = Strings.toHexString(uint160(address(this)), 20);

    // Fee - default to 0
    signatureFee = 0;
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
    // this will initialize the XCC sub-account on NEAR
    // 2 Near are required for storage staking
    near.wNEAR.transferFrom(
      msg.sender,
      address(this),
      uint256(2_000_000_000_000_000_000_000_000)
    );

    // Make a cross-contract call to trigger sub-account creation.
    // we are calling the "system" account with empty data on NEAR to trigger sub-account creation
    // as "system" is a special account that is not part of the chain state.
    PromiseCreateArgs memory initCall = near.call(
      "system",
      "",
      "",
      0,
      500_000_000_000
    );
    initCall.transact();
  }

  /// @notice Grants a role to an address
  /// @param role The role to grant
  /// @param newOwner The address to grant the role to
  function grantRole(bytes32 role, address newOwner) public override onlyOwner {
    _grantRole(role, newOwner);
  }

  /// @notice Revokes a role from an address
  /// @param role The role to revoke
  /// @param newOwner The address to revoke the role from
  function revokeRole(
    bytes32 role,
    address newOwner
  ) public override onlyOwner {
    _revokeRole(role, newOwner);
  }

  /// @notice prevents a withdrawer from withdrawing
  /// @param withdrawer Address to prevent from withdrawing
  function suspend(address withdrawer) public onlyMultisigOwner {
    _revokeRole(APPROVED_WITHDRAWER_ROLE, withdrawer);
  }

  /// @notice Sets the hub contract address
  /// @param _fee Signature fee in wNEAR
  function setSignatureFee(uint256 _fee) external onlyOwner {
    signatureFee = _fee;
    emit SignatureFeeChanged(signatureFee);
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

  /// @notice submits a withdraw request to the payload builder, stores the returned payload, and triggers its signature immediately. This will only work for payloads that require a single signature (including Bitcoin, which is now supported via the hashIndex parameter).
  /// @param params The withdraw request parameters
  /// @param signature The signature of the withdraw request, if sent on behalf of a recipient
  function submitAndSignWithdrawRequest(
    SubmitWithdrawRequest calldata params,
    bytes memory signature,
    GasSettings memory gasSettings
  ) public {
    _submitWithdrawRequest(params);
    signWithdrawPayloadHash(params, signature, gasSettings, 0);
  }

  /// @notice submits a withdraw request to the payload builder, store the returned payload
  /// @param params The withdraw request parameters
  /// @return withdrawRequestHash The hash of the withdrawal request
  function submitWithdrawRequest(
    SubmitWithdrawRequest calldata params
  ) public returns (bytes32 withdrawRequestHash) {
    return _submitWithdrawRequest(params);
  }

  /// @notice submits a withdraw request to the payload builder, store the returned payload
  /// @param params The withdraw request parameters
  /// @return withdrawRequestHash The hash of the withdrawal request
  function _submitWithdrawRequest(
    SubmitWithdrawRequest calldata params
  ) internal returns (bytes32 withdrawRequestHash) {
    // check if the payload builder is set
    address builder = payloadBuilders[params.chainId][params.depository];

    if (builder == address(0)) {
      revert NoPayloadBuilder(params.chainId, params.depository);
    }

    // build payload
    bytes memory payload = IPayloadBuilder(builder).buildPayload(
      params.chainId,
      params.depository,
      params.currency,
      params.amount,
      params.receiver,
      params.data
    );

    // Store the hash of the request for deduplication and verification
    withdrawRequestHash = keccak256(abi.encode(params));
    payloads[withdrawRequestHash] = payload;

    // Use depository-specific delay if set, otherwise fall back to global delay
    uint256 depositoryDelay = depositoryDelays[params.chainId][
      params.depository
    ].delay;
    uint256 effectiveDelay = depositoryDelays[params.chainId][params.depository]
      .isSet
      ? depositoryDelay
      : delay;

    payloadTimestamps[withdrawRequestHash] = block.timestamp + effectiveDelay;

    emit PayloadBuilt(
      withdrawRequestHash,
      payload,
      payloadTimestamps[withdrawRequestHash]
    );
    return withdrawRequestHash;
  }

  /// @notice triggers the signing of a previously submitted withdraw request
  /// @param params The withdraw request parameters (must match the stored hash)
  /// @param signature The signature of the withdraw request, if sent on behalf of a recipient
  /// @param gasSettings struct containing gas settings for NEAR operations
  /// @param hashIndex index of the hash to sign for this request
  /// @dev This function is called by the NEAR signer account to sign the payload.
  /// It checks if the payload is ready to be signed (i.e. the delay has passed) and
  /// if the payload has not already been signed. If the payload is ready, it calls
  /// the NEAR signer account to sign the payload and then calls the signWithdrawCallback
  /// function to handle the result of the signing.
  function signWithdrawPayloadHash(
    SubmitWithdrawRequest calldata params,
    bytes memory signature,
    GasSettings memory gasSettings,
    uint32 hashIndex
  ) public {
    if (signatureFee > 0) {
      // We capture the fee for ourselves first
      near.wNEAR.transferFrom(msg.sender, address(this), signatureFee);
    }

    bytes32 withdrawRequestHash = keccak256(abi.encode(params));

    // make sure the payload exists
    bytes memory payload = payloads[withdrawRequestHash];
    if (payload.length == 0) {
      revert PayloadNotReady(withdrawRequestHash);
    }

    // check if the payload is ready to be signed
    if (payloadTimestamps[withdrawRequestHash] > block.timestamp) {
      revert PayloadNotReady(withdrawRequestHash);
    }

    address builder = payloadBuilders[params.chainId][params.depository];
    IPayloadBuilder payloadBuilder = IPayloadBuilder(builder);

    // verify the withdrawal can be achieved
    verifyWithdrawal(params, payloadBuilder, signature);

    // get the hash to sign
    bytes32 hashToSign = payloadBuilder.hashToSign(
      params.chainId,
      params.depository,
      payload,
      hashIndex
    );

    _signUsingChainSignatures(
      withdrawRequestHash,
      hashToSign,
      payloadBuilder,
      gasSettings
    );
  }

  /// @notice withdraws the wNEAR balance of this contract
  /// from the Aurora contract to the NEAR network
  function withdrawToNear(uint256 amount) external {
    // withdraw wNEAR to the NEAR network
    IEvmERC20(address(near.wNEAR)).withdrawToNear(
      bytes(AuroraSdk.nearRepresentative(address(this))),
      amount
    );

    // unwrap the wNEAR on the NEAR network
    PromiseCreateArgs memory unwrapCall = near.call(
      "wrap.testnet",
      "near_withdraw",
      abi.encodePacked(
        // solhint-disable-next-line quotes
        '{"amount": "',
        Strings.toString(amount),
        // solhint-disable-next-line quotes
        '"}'
      ),
      1, // requires attached deposit of exactly 1 yoctoNEAR
      NEAR_WITHDRAW_GAS // nearGas
    );

    unwrapCall.transact();
  }

  /// @notice Signs a hash using chain signatures
  /// @param withdrawRequestHash The withdrawal request hash
  /// @param hashToSign The hash to sign
  /// @param payloadBuilder The payload builder
  /// @param gasSettings The gas settings for NEAR operations
  function _signUsingChainSignatures(
    bytes32 withdrawRequestHash,
    bytes32 hashToSign,
    IPayloadBuilder payloadBuilder,
    GasSettings memory gasSettings
  ) internal {
    if (signedPayloads[withdrawRequestHash][hashToSign].length > 0) {
      revert PayloadAlreadySigned(withdrawRequestHash);
    }
    // Encode the JSON request for the signer
    bytes memory data = ChainSignatures.encodeJSONRequest(
      hashToSign,
      payloadBuilder.curve(),
      signerPath,
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
        withdrawRequestHash,
        hashToSign
      ),
      0,
      gasSettings.callbackGas
    );
    callSign.then(callback).transact();
  }

  /// @notice callback function to handle the result of the signing
  /// @param withdrawRequestHash hash of the requested withdrawal payload that was signed
  /// @dev This function is called by the NEAR signer account after the signing is complete.
  /// It checks if the signing was successful and if so, stores the signed payload in the
  /// signedPayloads mapping. It also emits an event to notify that the payload has been signed.
  function signWithdrawCallback(
    bytes32 withdrawRequestHash,
    bytes32 hashToSign
  ) public {
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
      revert SignCallbackFailed(withdrawRequestHash);
    }

    signedPayloads[withdrawRequestHash][hashToSign] = result.output;
    emit PayloadWithdrawSigned(withdrawRequestHash, hashToSign, result.output);
  }

  /// @notice Verifies if the withdrawal request can be achieved.
  /// @dev The withdrawal can be achieved if the caller is an approved withdrawer, or,
  /// if the hub is set, it will first transfer the user's token to this contract's balance.
  /// @param params The withdrawal request parameters
  /// @param payloadBuilder The payload builder containing the withdrawal details
  /// @param signature A signature for the withdrawal request, if sent on behalf of a recipient
  function verifyWithdrawal(
    SubmitWithdrawRequest calldata params,
    IPayloadBuilder payloadBuilder,
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
      params.chainId,
      params.currency
    );

    address spenderAlias = Utils.generateAddress(
      family,
      params.chainId,
      params.receiver
    );

    // Only an operator for the spender can trigger withdrawals or a valid signature by the recipient must be provided.
    if (
      !(params.spender == msg.sender ||
        Hub(hub).isOperator(params.spender, msg.sender) ||
        (spenderAlias == params.spender &&
          signatureMatchesReceiver(params, signature)))
    ) {
      revert CallerIsNotApproved(msg.sender);
    }

    // Actually perform the transfer
    Hub(hub).transferFrom(
      params.spender,
      address(this),
      tokenId,
      params.amount
    );
  }

  /// @notice Checks if the signature matches the receiver's address (for EVM destination chains)
  /// @param params The withdrawal request parameters
  /// @param signature The signature to verify
  /// @return True if the signature matches the receiver
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
