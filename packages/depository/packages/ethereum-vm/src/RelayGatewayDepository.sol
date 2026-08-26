// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Ownable} from "solady/auth/Ownable.sol";
import {ERC20} from "solady/tokens/ERC20.sol";
import {EIP712} from "solady/utils/EIP712.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {SignatureCheckerLib} from "solady/utils/SignatureCheckerLib.sol";

import {
  ICircleGatewayMinter,
  ICircleGatewayWallet
} from "./interfaces/ICircleGateway.sol";
import {Call, CallResult} from "./utils/RelayDepositoryStructs.sol";
import {CallRequest} from "./utils/RelayGatewayDepositoryStructs.sol";

/// @title RelayGatewayDepository
/// @author Relay Protocol
/// @notice Provides secure Circle Gateway deposit functionality and execution of allocator-signed withdrawal requests
/// @dev EVM implementation using EIP-712 for structured data signing and Circle Gateway for unified USDC liquidity
contract RelayGatewayDepository is Ownable, EIP712 {
  using SafeTransferLib for address;
  using SignatureCheckerLib for address;

  /// @notice Revert if the address is zero
  error AddressCannotBeZero();

  /// @notice Revert if USDC has already been initialized
  error UsdcAlreadyInitialized();

  /// @notice Revert if the token is not the configured USDC
  error InvalidToken(address token);

  /// @notice Revert if the signature is invalid
  error InvalidSignature();

  /// @notice Revert if the call request is expired
  error CallRequestExpired();

  /// @notice Revert if the call request has already been used
  error CallRequestAlreadyUsed();

  /// @notice Revert if Circle already consumed the requested transfer spec
  error TransferSpecHashAlreadyUsed(bytes32 transferSpecHash);

  /// @notice Revert if the mint did not consume the requested transfer spec
  error InvalidGatewayAttestation(bytes32 transferSpecHash);

  /// @notice Revert if the Circle Gateway attestation encoding is invalid
  error InvalidGatewayAttestationEncoding();

  /// @notice Revert if the Circle Gateway payload contains an attestation set
  error GatewayAttestationSetsNotSupported();

  /// @notice Revert if the attestation's transfer spec does not match the call request
  error GatewayAttestationTransferSpecMismatch(
    bytes32 expectedTransferSpecHash,
    bytes32 actualTransferSpecHash
  );

  /// @notice Revert if deposits are disabled
  error DepositsDisabled();

  /// @notice Revert if a call fails
  /// @param returnData The data returned from the failed call
  error CallFailed(bytes returnData);

  /// @notice Emit event when an erc20 deposit is made
  /// @param from The address that made the deposit
  /// @param token The address of the ERC20 token
  /// @param amount The amount of tokens deposited
  /// @param id The unique identifier associated with the deposit
  event RelayErc20Deposit(
    address from,
    address token,
    uint256 amount,
    bytes32 id
  );

  /// @notice Emit event when a call is executed
  /// @param id The identifier of the call request
  /// @param call The call details that were executed
  event RelayCallExecuted(bytes32 id, Call call);

  /// @notice Emit event when the chain-specific USDC address is initialized
  /// @param usdc The USDC token address
  event UsdcInitialized(address usdc);

  /// @notice Emit event when deposits are enabled or disabled
  /// @param enabled Whether deposits are enabled
  event DepositsEnabledSet(bool enabled);

  /// @notice The EIP-712 typehash for the Call struct
  /// @dev Used in structured data hashing for signature verification
  bytes32 public constant _CALL_TYPEHASH =
    keccak256("Call(address to,bytes data,uint256 value,bool allowFailure)");

  /// @notice The EIP-712 typehash for the CallRequest struct
  /// @dev Used in structured data hashing for signature verification
  bytes32 public constant _CALL_REQUEST_TYPEHASH =
    keccak256(
      "CallRequest(bytes32 transferSpecHash,Call[] calls,uint256 nonce,uint256 expiration)Call(address to,bytes data,uint256 value,bool allowFailure)"
    );

  /// @notice Circle Gateway's packed single-attestation type marker
  bytes4 private constant _GATEWAY_ATTESTATION_MAGIC = 0xff6fb334;

  /// @notice Circle Gateway's packed attestation-set type marker
  bytes4 private constant _GATEWAY_ATTESTATION_SET_MAGIC = 0x1e12db71;

  /// @notice Size of Circle Gateway's packed single-attestation header
  uint256 private constant _GATEWAY_ATTESTATION_HEADER_LENGTH = 40;

  /// @notice USDC deposited into and minted from Circle Gateway
  address public USDC;

  /// @notice Circle GatewayWallet shared by supported EVM chains
  address public constant GATEWAY_WALLET =
    0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE;

  /// @notice Circle GatewayMinter shared by supported EVM chains
  address public constant GATEWAY_MINTER =
    0x2222222d7164433c4C09B0b0D809a9b52C04C205;

  /// @notice Set of executed call requests
  /// @dev Maps the hash of a call request to whether it has been executed
  mapping(bytes32 => bool) public callRequests;

  /// @notice The allocator address
  /// @dev Owns the Circle Gateway balance and signs withdrawal requests
  address public allocator;

  /// @notice Whether deposits into Circle Gateway are enabled
  bool public depositsEnabled;

  /// @notice Initializes the contract with chain-independent configuration
  /// @param _owner The address that will own the contract
  /// @param _allocator The address authorized to sign withdrawal requests and Circle burn intents
  constructor(address _owner, address _allocator) {
    _initializeOwner(_owner);
    allocator = _allocator;
  }

  /// @notice Initializes the chain-specific USDC address
  /// @param usdc The USDC token address
  /// @dev Can only be called once by the contract owner
  function initializeUsdc(address usdc) external onlyOwner {
    if (USDC != address(0)) {
      revert UsdcAlreadyInitialized();
    }
    if (usdc == address(0)) {
      revert AddressCannotBeZero();
    }

    USDC = usdc;

    emit UsdcInitialized(usdc);
  }

  /// @notice Set the allocator address
  /// @param _allocator The new allocator address
  /// @dev Only callable by the contract owner; existing Gateway funds remain owned by the previous allocator
  function setAllocator(address _allocator) external onlyOwner {
    if (_allocator == address(0)) {
      revert AddressCannotBeZero();
    }

    allocator = _allocator;
  }

  /// @notice Enable or disable deposits into Circle Gateway
  /// @param enabled Whether deposits should be enabled
  /// @dev Only callable by the contract owner
  function setDepositsEnabled(bool enabled) external onlyOwner {
    depositsEnabled = enabled;

    emit DepositsEnabledSet(enabled);
  }

  /// @notice Deposit erc20 tokens and emit an `RelayErc20Deposit` event
  /// @param depositor The address of the depositor - set to `address(0)` to credit `msg.sender`
  /// @param token The erc20 token to deposit - must be the configured USDC
  /// @param amount The amount to deposit
  /// @param id The identifier associated with the deposit
  /// @dev Transfers tokens from msg.sender into the allocator's Gateway balance and emits a RelayErc20Deposit event
  function depositErc20(
    address depositor,
    address token,
    uint256 amount,
    bytes32 id
  ) public {
    if (!depositsEnabled) {
      revert DepositsDisabled();
    }

    if (USDC == address(0) || token != USDC) {
      revert InvalidToken(token);
    }

    // Transfer the tokens to the contract
    token.safeTransferFrom(msg.sender, address(this), amount);

    // Approve and deposit the exact amount into the allocator's Gateway balance
    token.safeApprove(GATEWAY_WALLET, amount);
    ICircleGatewayWallet(GATEWAY_WALLET).depositFor(token, allocator, amount);

    address depositorAddress = depositor == address(0) ? msg.sender : depositor;

    // Emit the `RelayErc20Deposit` event
    emit RelayErc20Deposit(depositorAddress, token, amount, id);
  }

  /// @notice Deposit erc20 tokens and emit an `RelayErc20Deposit` event
  /// @param depositor The address of the depositor - set to `address(0)` to credit `msg.sender`
  /// @param token The erc20 token to deposit - must be the configured USDC
  /// @param id The identifier associated with the deposit
  /// @dev Uses the full allowance granted to this contract and calls depositErc20
  function depositErc20(address depositor, address token, bytes32 id) external {
    if (USDC == address(0) || token != USDC) {
      revert InvalidToken(token);
    }

    uint256 amount = ERC20(USDC).allowance(msg.sender, address(this));

    depositErc20(depositor, token, amount, id);
  }

  /// @notice Execute a `CallRequest` signed by the allocator using a Circle Gateway attestation
  /// @param request The `CallRequest` to execute
  /// @param signature The signature from the allocator
  /// @param attestationPayload The Circle Gateway attestation payload
  /// @param attestationSignature The Circle signature over the attestation payload
  /// @return results The results of the calls
  /// @dev Verifies the allocator signature, expiration, uniqueness, and Circle transfer-spec binding before execution
  function execute(
    CallRequest calldata request,
    bytes calldata signature,
    bytes calldata attestationPayload,
    bytes calldata attestationSignature
  ) external returns (CallResult[] memory results) {
    (bytes32 structHash, bytes32 eip712Hash) = _hashCallRequest(request);

    // Validate the call request expiration
    if (request.expiration < block.timestamp) {
      revert CallRequestExpired();
    }

    // Validate the allocator signature
    if (!allocator.isValidSignatureNow(eip712Hash, signature)) {
      revert InvalidSignature();
    }

    _validateGatewayAttestation(attestationPayload, request.transferSpecHash);

    // Revert if the call request has already been used
    if (callRequests[structHash]) {
      revert CallRequestAlreadyUsed();
    }

    // Revert if Circle already consumed the requested transfer spec
    if (
      ICircleGatewayMinter(GATEWAY_MINTER).isTransferSpecHashUsed(
        request.transferSpecHash
      )
    ) {
      revert TransferSpecHashAlreadyUsed(request.transferSpecHash);
    }

    // Mark the call request as used
    callRequests[structHash] = true;

    // Mint USDC into this contract using Circle's attestation
    ICircleGatewayMinter(GATEWAY_MINTER).gatewayMint(
      attestationPayload,
      attestationSignature
    );

    // Ensure the supplied attestation consumed the requested transfer spec
    if (
      !ICircleGatewayMinter(GATEWAY_MINTER).isTransferSpecHashUsed(
        request.transferSpecHash
      )
    ) {
      revert InvalidGatewayAttestation(request.transferSpecHash);
    }

    // Execute the calls
    results = _executeCalls(structHash, request.calls);
  }

  /// @notice Validate that a Circle payload contains exactly the requested transfer spec
  /// @param payload The packed Circle Gateway attestation
  /// @param expectedTransferSpecHash The allocator-signed transfer-spec hash
  function _validateGatewayAttestation(
    bytes calldata payload,
    bytes32 expectedTransferSpecHash
  ) internal pure {
    if (payload.length < _GATEWAY_ATTESTATION_HEADER_LENGTH) {
      revert InvalidGatewayAttestationEncoding();
    }

    bytes4 magic = bytes4(payload[:4]);
    if (magic == _GATEWAY_ATTESTATION_SET_MAGIC) {
      revert GatewayAttestationSetsNotSupported();
    }
    if (magic != _GATEWAY_ATTESTATION_MAGIC) {
      revert InvalidGatewayAttestationEncoding();
    }

    uint32 transferSpecLength = uint32(bytes4(payload[36:40]));
    if (
      payload.length !=
      _GATEWAY_ATTESTATION_HEADER_LENGTH + uint256(transferSpecLength)
    ) {
      revert InvalidGatewayAttestationEncoding();
    }

    bytes32 actualTransferSpecHash = keccak256(
      payload[_GATEWAY_ATTESTATION_HEADER_LENGTH:]
    );
    if (actualTransferSpecHash != expectedTransferSpecHash) {
      revert GatewayAttestationTransferSpecMismatch(
        expectedTransferSpecHash,
        actualTransferSpecHash
      );
    }
  }

  /// @notice Internal function to execute a list of calls
  /// @param id The identifier of the call request
  /// @param calls The array of calls to execute
  /// @return returnData The results of each executed call
  /// @dev Handles multiple calls and properly manages failures based on allowFailure flag
  function _executeCalls(
    bytes32 id,
    Call[] calldata calls
  ) internal returns (CallResult[] memory returnData) {
    unchecked {
      uint256 length = calls.length;

      // Initialize the return data array
      returnData = new CallResult[](length);

      // Iterate over the calls
      for (uint256 i; i < length; i++) {
        Call memory c = calls[i];

        // Execute the call
        // slither-disable-next-line arbitrary-send-eth,calls-loop
        (bool success, bytes memory data) = c.to.call{value: c.value}(c.data);

        // Revert if the call failed and failure is not allowed
        if (!success && !c.allowFailure) {
          revert CallFailed(data);
        }

        // Store the success status and return data
        returnData[i] = CallResult({success: success, returnData: data});

        // Emit the `RelayCallExecuted` event if the call was successful
        if (success) {
          emit RelayCallExecuted(id, c);
        }
      }
    }
  }

  /// @notice Helper function to hash a `CallRequest` and return the EIP-712 digest
  /// @param request The `CallRequest` to hash
  /// @return structHash The struct hash
  /// @return eip712Hash The EIP712 hash
  /// @dev Implements EIP-712 structured data hashing for the Gateway CallRequest type
  function _hashCallRequest(
    CallRequest calldata request
  ) internal view returns (bytes32 structHash, bytes32 eip712Hash) {
    // Initialize the array of call hashes
    bytes32[] memory callHashes = new bytes32[](request.calls.length);

    // Iterate over the underlying calls
    for (uint256 i = 0; i < request.calls.length; i++) {
      // Hash the call
      bytes32 callHash = keccak256(
        abi.encode(
          _CALL_TYPEHASH,
          request.calls[i].to,
          keccak256(request.calls[i].data),
          request.calls[i].value,
          request.calls[i].allowFailure
        )
      );

      // Store the hash in the array
      callHashes[i] = callHash;
    }

    // Get the struct hash
    structHash = keccak256(
      abi.encode(
        _CALL_REQUEST_TYPEHASH,
        request.transferSpecHash,
        keccak256(abi.encodePacked(callHashes)),
        request.nonce,
        request.expiration
      )
    );

    // Get the EIP-712 hash
    eip712Hash = _hashTypedData(structHash);
  }

  /// @notice Returns the domain name and version of the contract to be used in the domain separator
  /// @return name The domain name
  /// @return version The version
  /// @dev Implements required function from EIP712 base contract
  function _domainNameAndVersion()
    internal
    pure
    override
    returns (string memory name, string memory version)
  {
    name = "RelayGatewayDepository";
    version = "1";
  }
}
