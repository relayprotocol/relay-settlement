// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {SafeCastLib} from "solady/utils/SafeCastLib.sol";

import {Config} from "../Config.sol";
import {
  IPayloadBuilder,
  WithdrawRequest,
  WithdrawFee
} from "../RelayAllocator.sol";

/// @notice Header of an Atlas signed transaction: its EIP-712 domain, `Transaction` nonce and action type
/// @dev A payload is `abi.encode(AtlasPayloadHeader, <action>)`, the action struct selected by
///      `actionType` following the header inline
struct AtlasPayloadHeader {
  uint256 domainChainId; /// @notice EIP-712 domain chain id of the Atlas deployment
  bytes32 domainSalt; /// @notice EIP-712 deployment salt
  address signer; /// @notice Main account owner signing the transaction
  uint64 nonce; /// @notice Gapless owner nonce: one above the last one the signer's wallet accepted
  uint64 expiresAt; /// @notice Unix seconds after which Atlas no longer books the transaction
  uint8 actionType;
} /// @notice Action type (0 = Transfer)

/// @notice Atlas transfer action, exactly as signed
struct AtlasTransfer {
  address fromAccountAddress; /// @notice Depository account the funds leave
  address toAccountAddress; /// @notice Receiving Atlas account
  uint32 assetId; /// @notice Atlas asset id
  int128 amount; /// @notice Amount × 10^12, the fixed signing scale of every Atlas asset
  bytes32 memoHead; /// @notice Memo bytes 0-31: hash binding the transfer to its withdraw request
  bytes32 memoTail;
} /// @notice Memo bytes 32-63: the transaction nonce

/// @title AtlasVmPayloadBuilder
/// @author Relay Protocol
/// @notice Payload builder for "atlas-vm" chains
/// @dev Atlas signs one EIP-712 `Transaction(address signer,NonceGapless nonce,Transfer action)`
///      whose amount is the transferred quantity scaled to 12 decimals. A Transfer payload is
///      `abi.encode(AtlasPayloadHeader, AtlasTransfer)`, a fully static 12-word encoding.
contract AtlasVmPayloadBuilder is IPayloadBuilder {
  using SafeCastLib for uint256;

  /// @notice Thrown when a payload encodes an unsupported action type
  /// @param actionType Encoded action type
  error UnsupportedActionType(uint8 actionType);

  /// @notice Thrown when an encoded value has an unexpected length
  /// @param length Actual encoded length
  error InvalidLength(uint256 length);

  /// @notice Thrown when the receiver is the zero address or the depository itself
  /// @param receiver Decoded receiver
  error InvalidReceiver(address receiver);

  /// @notice Thrown when the amount is zero or does not fit Atlas's signed amount
  /// @param amount Requested amount in base units
  error InvalidAmount(uint256 amount);

  /// @notice Thrown when an asset's configured decimals exceed Atlas's signed scale
  /// @param decimals Configured decimals
  error InvalidDecimals(uint256 decimals);

  /// @notice Thrown when the requested gapless nonce is below the first one a withdrawal may use
  /// @param nonce Requested gapless nonce
  error InvalidNonce(uint64 nonce);

  /// @notice Thrown when the configured expiration delay exceeds what Atlas accepts
  /// @param expirationDelay Configured expiration delay in seconds
  error InvalidExpirationDelay(uint256 expirationDelay);

  /// @notice Transfer action type
  uint8 public constant TRANSFER_ACTION_TYPE = 0;

  /// @notice The EIP-712 domain name for Atlas transactions
  string public constant SIGNING_DOMAIN = "atlas";

  /// @notice The EIP-712 domain version for Atlas transactions
  string public constant SIGNATURE_VERSION = "1";

  /// @notice Decimal places of the amount Atlas signs, whatever the asset
  uint8 public constant SIGNED_AMOUNT_DECIMALS = 12;

  /// @notice First gapless nonce a withdrawal may use: the wallet-opening bind takes nonce 1
  uint64 public constant MIN_NONCE = 2;

  /// @notice Longest expiration delay Atlas accepts for a gapless nonce
  uint256 public constant MAX_EXPIRATION_DELAY = 14 days;

  /// @notice EIP-712 typehash of the gapless nonce
  bytes32 public constant NONCE_GAPLESS_TYPEHASH =
    keccak256("NonceGapless(uint64 gapless_nonce,uint64 expires_at)");

  /// @notice EIP-712 typehash of the Atlas transfer action
  bytes32 public constant TRANSFER_TYPEHASH =
    keccak256(
      "Transfer(address account,address toAccount,uint32 asset,int128 amount,bytes32 memoHead,bytes32 memoTail)"
    );

  /// @notice EIP-712 typehash of the transaction envelope around a transfer
  bytes32 public constant TRANSFER_TRANSACTION_TYPEHASH =
    keccak256(
      "Transaction(address signer,NonceGapless nonce,Transfer action)NonceGapless(uint64 gapless_nonce,uint64 expires_at)Transfer(address account,address toAccount,uint32 asset,int128 amount,bytes32 memoHead,bytes32 memoTail)"
    );

  /// @notice Config contract used to resolve Atlas instance metadata
  Config public immutable CONFIG;

  /// @notice Prefix used when deriving config keys for EIP-712 domain chain id lookups
  bytes32 internal constant ATLAS_VM_DOMAIN_CHAIN_ID_PREFIX =
    keccak256("ATLAS_VM_DOMAIN_CHAIN_ID");

  /// @notice Prefix used when deriving config keys for EIP-712 domain salt lookups
  bytes32 internal constant ATLAS_VM_DOMAIN_SALT_PREFIX =
    keccak256("ATLAS_VM_DOMAIN_SALT");

  /// @notice Prefix used when deriving config keys for asset decimals lookups
  bytes32 internal constant ATLAS_VM_ASSET_DECIMALS_PREFIX =
    keccak256("ATLAS_VM_ASSET_DECIMALS");

  /// @notice Prefix used when deriving config keys for transaction expiration lookups
  bytes32 internal constant ATLAS_VM_EXPIRATION_PREFIX =
    keccak256("ATLAS_VM_EXPIRATION");

  /// @notice Creates a new Atlas VM payload builder
  /// @dev Instance-specific values (signing domain, asset decimals, expiration delay) are
  ///      read from `CONFIG` per Relay chain id.
  /// @param _config Config contract address
  constructor(address _config) {
    CONFIG = Config(_config);
  }

  /// @inheritdoc IPayloadBuilder
  /// @dev The allocator routes by `(chainId, depository)`, so `depository` is the
  ///      registered source account. The memo binds the builder and the whole request, so two
  ///      requests never share a transfer. `request.data` must encode `(uint64 nonce)`, the
  ///      depository wallet's next gapless owner nonce: Atlas books a transaction only while
  ///      its nonce is exactly the next one and it has not expired.
  function buildPayload(
    string calldata chainId,
    bytes calldata depository,
    WithdrawRequest calldata request
  )
    external
    view
    override
    returns (bytes memory payload, WithdrawFee memory withdrawFee)
  {
    bytes32 requestHash = keccak256(abi.encode(address(this), request));
    uint64 nonce = abi.decode(request.data, (uint64));
    if (nonce < MIN_NONCE) {
      revert InvalidNonce(nonce);
    }

    return (
      abi.encode(
        AtlasPayloadHeader({
          domainChainId: getDomainChainId(chainId),
          domainSalt: getDomainSalt(chainId),
          signer: _bytesToAddress(depository),
          nonce: nonce,
          expiresAt: (block.timestamp + getExpirationDelay(chainId)).toUint64(),
          actionType: TRANSFER_ACTION_TYPE
        }),
        _buildTransferAction(chainId, depository, request, requestHash, nonce)
      ),
      withdrawFee
    );
  }

  /// @inheritdoc IPayloadBuilder
  /// @dev The single hash is the Atlas transferId of the signed transfer. The header is
  ///      decoded alone first, so an unsupported action type reverts before its action is decoded.
  function hashesToSign(
    string calldata /* chainId */,
    bytes calldata /* depository */,
    bytes calldata payload
  ) external pure override returns (bytes32[] memory hashes) {
    AtlasPayloadHeader memory header = abi.decode(
      payload,
      (AtlasPayloadHeader)
    );
    if (header.actionType != TRANSFER_ACTION_TYPE) {
      revert UnsupportedActionType(header.actionType);
    }

    (, AtlasTransfer memory transfer) = abi.decode(
      payload,
      (AtlasPayloadHeader, AtlasTransfer)
    );

    hashes = new bytes32[](1);
    hashes[0] = _transactionDigest(
      header,
      TRANSFER_TRANSACTION_TYPEHASH,
      hashTransfer(transfer)
    );
  }

  /// @inheritdoc IPayloadBuilder
  function curve() external pure override returns (string memory name) {
    return "Ecdsa";
  }

  /// @inheritdoc IPayloadBuilder
  function family() external pure override returns (string memory name) {
    return "atlas-vm";
  }

  /// @notice Returns the config key used to look up the EIP-712 domain chain id for a chain
  /// @param chainId Relay chain id
  /// @return key Config key
  function getDomainChainIdKey(
    string calldata chainId
  ) public pure returns (bytes32 key) {
    return
      keccak256(abi.encodePacked(ATLAS_VM_DOMAIN_CHAIN_ID_PREFIX, chainId));
  }

  /// @notice Returns the config key used to look up the EIP-712 domain salt for a chain
  /// @param chainId Relay chain id
  /// @return key Config key
  function getDomainSaltKey(
    string calldata chainId
  ) public pure returns (bytes32 key) {
    return keccak256(abi.encodePacked(ATLAS_VM_DOMAIN_SALT_PREFIX, chainId));
  }

  /// @notice Returns the config key used to look up the decimals of a currency
  /// @param chainId Relay chain id
  /// @param currency Encoded currency
  /// @return key Config key
  function getAssetDecimalsKey(
    string calldata chainId,
    bytes calldata currency
  ) public pure returns (bytes32 key) {
    return
      keccak256(
        abi.encodePacked(ATLAS_VM_ASSET_DECIMALS_PREFIX, chainId, currency)
      );
  }

  /// @notice Returns the config key used to look up the transaction expiration delay for a chain
  /// @param chainId Relay chain id
  /// @return key Config key
  function getExpirationKey(
    string calldata chainId
  ) public pure returns (bytes32 key) {
    return keccak256(abi.encodePacked(ATLAS_VM_EXPIRATION_PREFIX, chainId));
  }

  /// @notice Returns the configured EIP-712 domain chain id of the Atlas deployment
  /// @dev Reverts when the key is unset
  /// @param chainId Relay chain id
  /// @return domainChainId Configured domain chain id
  function getDomainChainId(
    string calldata chainId
  ) public view returns (uint256 domainChainId) {
    return uint256(CONFIG.getConfigValue(getDomainChainIdKey(chainId)));
  }

  /// @notice Returns the configured EIP-712 domain salt of the Atlas deployment
  /// @dev Reverts when the key is unset
  /// @param chainId Relay chain id
  /// @return domainSalt Configured domain salt
  function getDomainSalt(
    string calldata chainId
  ) public view returns (bytes32 domainSalt) {
    return CONFIG.getConfigValue(getDomainSaltKey(chainId));
  }

  /// @notice Returns the configured decimals of a currency
  /// @dev Reverts when the key is unset, so unconfigured currencies cannot be withdrawn
  /// @param chainId Relay chain id
  /// @param currency Encoded currency
  /// @return decimals Configured decimals
  function getAssetDecimals(
    string calldata chainId,
    bytes calldata currency
  ) public view returns (uint8 decimals) {
    uint256 value = uint256(
      CONFIG.getConfigValue(getAssetDecimalsKey(chainId, currency))
    );
    if (value > SIGNED_AMOUNT_DECIMALS) {
      revert InvalidDecimals(value);
    }
    return uint8(value);
  }

  /// @notice Returns the configured transaction expiration delay in seconds
  /// @dev Reverts when the key is unset or the delay exceeds `MAX_EXPIRATION_DELAY`
  /// @param chainId Relay chain id
  /// @return expirationDelay Configured expiration delay
  function getExpirationDelay(
    string calldata chainId
  ) public view returns (uint256 expirationDelay) {
    expirationDelay = uint256(CONFIG.getConfigValue(getExpirationKey(chainId)));
    if (expirationDelay > MAX_EXPIRATION_DELAY) {
      revert InvalidExpirationDelay(expirationDelay);
    }
  }

  /// @notice Hashes an Atlas transfer according to its EIP-712 schema
  /// @param transfer Transfer action
  /// @return structHash EIP-712 struct hash
  function hashTransfer(
    AtlasTransfer memory transfer
  ) public pure returns (bytes32 structHash) {
    return
      keccak256(
        abi.encode(
          TRANSFER_TYPEHASH,
          transfer.fromAccountAddress,
          transfer.toAccountAddress,
          transfer.assetId,
          transfer.amount,
          transfer.memoHead,
          transfer.memoTail
        )
      );
  }

  /// @notice Builds the Transfer action
  /// @param chainId Relay chain id
  /// @param depository Encoded depository account the request is routed under
  /// @param request Withdrawal request
  /// @param requestHash Hash binding the transfer to this request
  /// @param nonce Transaction nonce
  /// @return transfer Transfer action
  function _buildTransferAction(
    string calldata chainId,
    bytes calldata depository,
    WithdrawRequest calldata request,
    bytes32 requestHash,
    uint64 nonce
  ) internal view returns (AtlasTransfer memory transfer) {
    address account = _bytesToAddress(depository);
    address receiver = _bytesToAddress(request.receiver);
    if (receiver == address(0) || receiver == account) {
      revert InvalidReceiver(receiver);
    }
    if (request.amount == 0) {
      revert InvalidAmount(request.amount);
    }

    transfer = AtlasTransfer({
      fromAccountAddress: account,
      toAccountAddress: receiver,
      assetId: _currencyToAssetId(request.currency),
      amount: _toSignedAmount(
        request.amount,
        getAssetDecimals(chainId, request.currency)
      ),
      memoHead: requestHash,
      memoTail: bytes32(uint256(nonce))
    });
  }

  /// @notice Returns the EIP-712 digest Atlas verifies for a transaction
  /// @param header Atlas payload header carrying the domain, nonce and expiry
  /// @param transactionTypehash Typehash of `Transaction(address signer,NonceGapless nonce,<Action> action)` with the referenced types appended
  /// @param actionHash EIP-712 struct hash of the payload's action
  /// @return digest EIP-712 typed-data digest
  function _transactionDigest(
    AtlasPayloadHeader memory header,
    bytes32 transactionTypehash,
    bytes32 actionHash
  ) internal pure returns (bytes32 digest) {
    return
      MessageHashUtils.toTypedDataHash(
        keccak256(
          abi.encode(
            keccak256(
              "EIP712Domain(string name,string version,uint256 chainId,bytes32 salt)"
            ),
            keccak256(bytes(SIGNING_DOMAIN)),
            keccak256(bytes(SIGNATURE_VERSION)),
            header.domainChainId,
            header.domainSalt
          )
        ),
        keccak256(
          abi.encode(
            transactionTypehash,
            header.signer,
            keccak256(
              abi.encode(NONCE_GAPLESS_TYPEHASH, header.nonce, header.expiresAt)
            ),
            actionHash
          )
        )
      );
  }

  /// @notice Scales a base-unit amount to the 12-decimal amount Atlas signs
  /// @param amount Amount in base units
  /// @param decimals Decimals of the base unit
  /// @return signedAmount Amount with 12 decimals
  function _toSignedAmount(
    uint256 amount,
    uint8 decimals
  ) internal pure returns (int128 signedAmount) {
    uint256 scale = 10 ** (SIGNED_AMOUNT_DECIMALS - decimals);
    if (amount > uint256(int256(type(int128).max)) / scale) {
      revert InvalidAmount(amount);
    }
    return int128(int256(amount * scale));
  }

  /// @notice Decodes a 16-byte big-endian currency into its Atlas asset id
  /// @param currency Encoded currency
  /// @return assetId Atlas asset id
  function _currencyToAssetId(
    bytes calldata currency
  ) internal pure returns (uint32 assetId) {
    if (currency.length != 16) {
      revert InvalidLength(currency.length);
    }
    return uint256(uint128(bytes16(currency))).toUint32();
  }

  /// @notice Decodes a 20-byte Atlas account address
  /// @param value Encoded address
  /// @return decoded Decoded address
  function _bytesToAddress(
    bytes calldata value
  ) internal pure returns (address decoded) {
    if (value.length != 20) {
      revert InvalidLength(value.length);
    }
    return address(bytes20(value));
  }
}
