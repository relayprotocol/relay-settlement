// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {AuroraSdk, NEAR, PromiseCreateArgs, PromiseResult, PromiseResultStatus, PromiseWithCallback} from "./aurora-xcc/AuroraSdk.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

interface ISafe {
  function isOwner(address) external view returns (bool);
}

interface PayloadBuilder {
  function buildPayload(
    uint256 chainId,
    address escrow,
    string calldata currency,
    uint256 amount,
    string calldata receiver,
    bytes calldata data
  ) external view returns (bytes memory);

  function hashesToSign(
    uint256 chainId,
    address escrow,
    bytes calldata payload
  ) external view returns (bytes32[] memory);

  function curve() external pure returns (string memory);
}

// NEAR gas settings
struct GasSettings {
  uint64 signGas;
  uint64 callbackGas;
}

// Default gas settings
uint64 constant DEFAULT_SIGN_GAS = 30_000_000_000_000; // 30 Tgas
uint64 constant DEFAULT_CALLBACK_GAS = 10_000_000_000_000; // 10 Tgas

contract Allocator is AccessControl {
  using AuroraSdk for NEAR;
  using AuroraSdk for PromiseCreateArgs;
  using AuroraSdk for PromiseWithCallback;
  using AuroraSdk for PromiseResult;
  using Strings for uint256;

  event Enabled(bool enabled);
  event DelayChanged(uint256 delay);

  // roles
  bytes32 public constant HUB_ROLE = keccak256("HUB_ROLE");
  bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
  bytes32 public constant CALLBACK_ROLE = keccak256("CALLBACK_ROLE");

  // enable/disable withdrawals
  bool public enabled;

  // NEAR signer account
  string public nearSigner;

  // Aurora SDK instance
  NEAR public near;

  // delay
  uint256 public delay;

  // owner of the contract
  address public owner;

  // payload builders mapping
  mapping(uint256 => mapping(address => address)) public payloadBuilders;

  // unsigned payloads
  mapping(bytes32 => bytes) public unsignedPayloads;

  // signed payloads
  mapping(bytes32 => mapping(bytes32 => bytes)) public signedPayloads;

  // payload timestamps
  mapping(bytes32 => uint256) public payloadTimestamps;

  // events
  event PayloadBuilderSet(
    uint256 indexed chainId,
    address indexed escrow,
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
  error CallerIsNotHub(address account);
  error NoPayloadBuilder(uint256 chainId, address escrow);
  error PayloadNotReady(bytes32 payloadId);
  error PayloadAlreadySigned(bytes32 payloadId);
  error WithdrawalDisabled();
  error SignCallbackFailed(bytes32 payloadId);

  constructor(
    address _owner,
    uint256 _delay,
    string memory _signer,
    address _wNEAR
  ) {
    // roles
    _setRoleAdmin(HUB_ROLE, ADMIN_ROLE);
    _grantRole(ADMIN_ROLE, _owner);
    _grantRole(
      CALLBACK_ROLE,
      AuroraSdk.nearRepresentitiveImplicitAddress(address(this))
    );

    // disabled by default. enable on init()
    enabled = false;

    // delay
    delay = _delay;

    // set signer and Aurora SDK
    nearSigner = _signer;
    near = AuroraSdk.initNear(IERC20(_wNEAR));

    // TODO:  check if is _owner is a valid multisig
    owner = _owner;
  }

  modifier onlyMultisigOwner() {
    if (!ISafe(owner).isOwner(msg.sender)) revert NotMultisigOwner(msg.sender);
    _;
  }

  /**
   * @notice initializes XCC sub-account for the contract
   * You need to approve 2 wNEAR for the CS Signer to init the sub-account
   * @notice This calls the simplest possible contract on NEAR to bootstrap itself and initialize the XCC subaccount.
   */
  function init() public onlyRole(ADMIN_ROLE) {
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
    enable(); // enable the contract after initialization
  }

  function disable() public onlyMultisigOwner {
    enabled = false;
    emit Enabled(enabled);
  }

  function enable() public onlyRole(ADMIN_ROLE) {
    enabled = true;
    emit Enabled(enabled);
  }

  function setDelay(uint256 _delay) public onlyRole(ADMIN_ROLE) {
    delay = _delay;
    emit DelayChanged(delay);
  }

  /**
   * @notice sets or updates the payload builder for a specific chain
   * @param chainId chain ID
   * @param builder address of the payload builder contract
   */
  function setPayloadBuilder(
    uint256 chainId,
    address escrow,
    address builder
  ) external onlyRole(ADMIN_ROLE) {
    payloadBuilders[chainId][escrow] = builder;
    emit PayloadBuilderSet(chainId, escrow, builder);
  }

  /**
   * @notice submits a withdraw request to the payload builder, store the payload
   * @param chainId chain ID
   * @param escrow address of the escrow contract
   * @param currency address of the currency contract (or zero address for native)
   * @param amount amount to withdraw
   * @param receiver address of the receiver
   * @param data additional data to pass to the payload builder
   */
  function submitWithdrawRequest(
    uint256 chainId,
    address escrow,
    string calldata currency,
    uint256 amount,
    string calldata receiver,
    bytes calldata data
  ) public returns (bytes32 payloadId) {
    // Check that the calling address has the hub role
    if (!hasRole(HUB_ROLE, msg.sender)) {
      revert CallerIsNotHub(msg.sender);
    }
    // check if the payload builder is set
    address builder = payloadBuilders[chainId][escrow];
    if (builder == address(0)) {
      revert NoPayloadBuilder(chainId, escrow);
    }

    bytes memory payload = PayloadBuilder(builder).buildPayload(
      chainId,
      escrow,
      currency,
      amount,
      receiver,
      data
    );
    payloadId = keccak256(abi.encodePacked(payload, block.timestamp));
    unsignedPayloads[payloadId] = payload;
    payloadTimestamps[payloadId] = block.timestamp + delay;
    emit PayloadBuilt(payloadId, payload, block.timestamp);
    if (delay == 0) {
      // if delay is 0, sign the payload immediately
      signWithdrawPayload(
        chainId,
        escrow,
        payloadId,
        GasSettings(DEFAULT_SIGN_GAS, DEFAULT_CALLBACK_GAS)
      );
    }
    return payloadId;
  }

  /**
   * @notice triggers the signing of a previously  submitted withdraw request
   * @param chainId chain ID
   * @param escrow address of the escrow contract
   * @param payloadId hash of the payload to sign
   * @param gasSettings struct containing gas settings for NEAR operations
   * @dev This function is called by the NEAR signer account to sign the payload.
   * It checks if the payload is ready to be signed (i.e. the delay has passed) and
   * if the payload has not already been signed. If the payload is ready, it calls
   * the NEAR signer account to sign the payload and then calls the signWithdrawCallback
   * function to handle the result of the signing.
   */
  function signWithdrawPayload(
    uint256 chainId,
    address escrow,
    bytes32 payloadId,
    GasSettings memory gasSettings
  ) public {
    address builder = payloadBuilders[chainId][escrow];
    if (builder == address(0)) {
      revert NoPayloadBuilder(chainId, escrow);
    }

    // check if the payload is ready to be signed
    if (payloadTimestamps[payloadId] > block.timestamp) {
      revert PayloadNotReady(payloadId);
    }

    if (!enabled) {
      revert WithdrawalDisabled();
    }

    string memory path = Strings.toHexString(uint160(address(this)), 20);
    PayloadBuilder payloadBuilder = PayloadBuilder(builder);

    bytes32[] memory hashesToSign = payloadBuilder.hashesToSign(
      chainId,
      escrow,
      unsignedPayloads[payloadId]
    );
    for (uint256 i = 0; i < hashesToSign.length; i++) {
      if (signedPayloads[payloadId][hashesToSign[i]].length > 0) {
        revert PayloadAlreadySigned(payloadId);
      }

      // Encode the JSON request for the signer
      bytes memory data = encodeJSONRequest(
        hashesToSign[i],
        payloadBuilder.curve(),
        path,
        0
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
          hashesToSign[i]
        ),
        0,
        gasSettings.callbackGas
      );

      callSign.then(callback).transact();
    }
  }

  /**
   * @notice callback function to handle the result of the signing
   * @param payloadId hash of the payload that was signed
   * @dev This function is called by the NEAR signer account after the signing is complete.
   * It checks if the signing was successful and if so, stores the signed payload in the
   * signedPayloads mapping. It also emits an event to notify that the payload has been signed.
   */
  function signWithdrawCallback(
    bytes32 payloadId,
    bytes32 hashToSign
  ) public onlyRole(CALLBACK_ROLE) {
    // triggering this function requires Aurora precompiles and therefore has no unit tests
    PromiseResult memory result = AuroraSdk.promiseResult(0);

    if (result.status != PromiseResultStatus.Successful) {
      revert SignCallbackFailed(payloadId);
    }

    signedPayloads[payloadId][hashToSign] = result.output;
    emit PayloadWithdrawSigned(payloadId, hashToSign, result.output);
  }

  /*
   * @notice Encodes a JSON request for the signer
   * @param payloadHashToSign The hash of the payload to sign
   * @return The encoded JSON request
   */
  function encodeJSONRequest(
    bytes32 payloadHashToSign,
    string memory curve,
    string memory path,
    uint256 version
  ) public pure returns (bytes memory) {
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
        path,
        // solhint-disable-next-line quotes
        '","domain_id":',
        Strings.toString(version),
        // solhint-disable-next-line quotes
        "}}"
      );
  }

  /**
   * @notice Converts a bytes32 value to its string representation
   * @param hexBytes The bytes32 value to convert
   * @return The string representation of the bytes32 value
   */
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
}
