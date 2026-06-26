// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {
  AuroraSdk,
  NEAR,
  PromiseCreateArgs,
  PromiseResult,
  PromiseResultStatus,
  PromiseWithCallback
} from "./aurora-xcc/AuroraSdk.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {ChainSignatures} from "./ChainSignatures.sol";

/// @title Relay Multisig Signer
/// @author Relay
/// @notice This contract allows for multisig signing of messages on the NEAR blockchain using Chain Signatures.
/// Importantly, this contract has an owner to make sure only it can spend the (w)NEAR needed for signatures.
contract RelayMultisigSigner is Ownable {
  using AuroraSdk for NEAR;
  using AuroraSdk for PromiseCreateArgs;
  using AuroraSdk for PromiseWithCallback;
  using AuroraSdk for PromiseResult;
  using Strings for uint256;

  uint256 private constant PENDING_SIGNATURE_TIMEOUT = 5 minutes;

  /// @notice NEAR account of the Chain Signatures signer
  string public nearSigner;

  /// @notice Aurora SDK instance
  NEAR public near;

  /// @notice Signer path
  string public signerPath;

  /// @notice Emitted when a message is approved
  /// @param dataHash The hash of the data to sign
  /// @param curve The curve used for signing
  /// @param data The complete data that was approved (hash or raw data)
  event Approved(bytes32 indexed dataHash, string indexed curve, bytes data);

  /// @notice Emitted when a message is signed
  /// @param dataHash The hash of the message that was signed
  /// @param curve The curve used for signing (0=ECDSA, 1=EDDSA)
  /// @param signature The signature of the data
  event Signed(bytes32 indexed dataHash, string indexed curve, bytes signature);

  error AccessControlUnauthorizedAccount(address account, bytes32 role);
  error SignatureNotApproved();
  error SignCallbackFailed(bytes32 payloadId);

  /// @notice Stores approved signatures
  mapping(bytes32 => mapping(string => bool)) public approvedSignatures;

  /// @notice Stores signatures for hashes
  mapping(bytes32 => mapping(string => bytes)) public signatures;

  /// @notice Stores pending signatures for hashes
  mapping(bytes32 => mapping(string => uint256)) public pendingSignatures;

  /// @notice Constructor for the RelayMultisigSigner contract
  /// @param _multisig The address of the multisig wallet that will own this contract
  /// @param _nearSigner The NEAR account of the Chain Signatures signer
  /// @param _wNEAR The address of the wrapped NEAR token
  constructor(
    address _multisig,
    string memory _nearSigner,
    address _wNEAR
  ) Ownable(_multisig) {
    nearSigner = _nearSigner;
    near = AuroraSdk.initNear(IERC20(_wNEAR));
    signerPath = Strings.toHexString(uint160(address(this)), 20);
  }

  /// @notice initializes XCC sub-account for the contract
  /// You need to approve 2 wNEAR for the CS Signer to init the sub-account
  /// @notice This calls the simplest possible contract on NEAR to bootstrap itself and initialize the XCC subaccount.
  function init() public onlyOwner {
    // slither-disable-next-line unchecked-transfer
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

  /// @notice Approves data for signing (supports both hashes and raw data)
  /// @param data The data to be signed (any length)
  /// @param curve The curve to use for signing (Ecdsa or Eddsa)
  function approveSignature(
    bytes memory data,
    string memory curve
  ) public onlyOwner {
    bytes32 key = keccak256(data);
    approvedSignatures[key][curve] = true;
    emit Approved(key, curve, data);
  }

  /// @notice Requests a signature for a given message from the NEAR Chain Signatures signer
  /// @param data The data to sign (any length)
  /// @param curve The curve to use for signing (Ecdsa or Eddsa)
  /// @param signGas The amount of NEAR gas to use for the signing request (use 30_000_000_000_000 by default)
  /// @param callbackGas The amount of NEAR gas to use for the callback (use 10_000_000_000_000 by default)
  function sign(
    bytes memory data,
    string memory curve,
    uint64 signGas,
    uint64 callbackGas
  ) public {
    bytes32 key = keccak256(data);

    if (!approvedSignatures[key][curve]) {
      revert SignatureNotApproved();
    }
    if (signatures[key][curve].length != 0) {
      // already signed
      return;
    }
    if (
      pendingSignatures[key][curve] >
      block.timestamp - PENDING_SIGNATURE_TIMEOUT
    ) {
      // pending signature request in last 5 minutes
      return;
    }
    pendingSignatures[key][curve] = block.timestamp;

    // Get the domainId
    string memory domainId = keccak256(abi.encodePacked(curve)) ==
      keccak256(abi.encodePacked("Ecdsa"))
      ? "0"
      : "1";

    // Encode the JSON request for the signer
    bytes memory signatureRequest = ChainSignatures.encodeJSONRequest(
      ChainSignatures.stringifyBytes(data),
      curve,
      signerPath,
      domainId
    );

    // Now get NEAR to sign the payload!
    PromiseCreateArgs memory callSign = near.call(
      nearSigner,
      "sign",
      signatureRequest,
      // the docs here https://github.com/aurora-is-near/chain-signatures-signer/tree/main?tab=readme-ov-file#signing-the-payload
      // states that 1 yoctoNEAR is usually enough to sign the call successfully
      1, // attachedNear
      signGas
    );
    PromiseCreateArgs memory callback = near.auroraCall(
      address(this),
      abi.encodeWithSelector(this.signatureCallback.selector, curve, key),
      0,
      callbackGas
    );

    callSign.then(callback).transact();
  }

  /// @notice Callback function that is called by the NEAR runtime when the signature is ready
  /// @param curve The curve used for signing
  /// @param dataHash The hash of the data that was signed
  function signatureCallback(string memory curve, bytes32 dataHash) public {
    if (
      msg.sender != AuroraSdk.nearRepresentitiveImplicitAddress(address(this))
    ) {
      revert AccessControlUnauthorizedAccount(
        msg.sender,
        keccak256("SIGNATURE_CALLBACK_ROLE")
      );
    }
    PromiseResult memory result = AuroraSdk.promiseResult(0);

    if (result.status != PromiseResultStatus.Successful) {
      revert SignCallbackFailed(dataHash);
    }

    signatures[dataHash][curve] = result.output;
    emit Signed(dataHash, curve, result.output);
  }
}
