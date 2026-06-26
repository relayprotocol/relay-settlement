// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BuildPayloadParams, IPayloadBuilder} from "../RelayAllocator.sol";

/// @notice Decoded fields for a TON Highload V3 native-coin transfer payload.
/// @dev The signed payload is the cell hash of the Highload V3 `msg_inner`
///      cell (see ton-blockchain/highload-wallet-contract-v3). Only native
///      TON transfers are supported; jettons would require a different
///      `message_to_send` layout and are not implemented here.
struct TonTransferRequest {
  bytes32 receiver; /// @notice 32-byte receiver address hash (workchain 0)
  uint128 amount; /// @notice Transfer amount in nanotons; fits in VarUInteger16
  uint32 createdAt; /// @notice Highload V3 created_at, set to block.timestamp at build
  uint32 queryId; /// @notice 23-bit HighloadQueryId derived from request fields
  uint32 subwalletId; /// @notice Highload V3 subwallet_id; copied from the builder's SUBWALLET_ID immutable so off-chain SDK can recompute the cell hash from the payload alone
  uint32 timeout; /// @notice Highload V3 timeout in seconds; copied from the builder's TIMEOUT immutable
}

/// @title TonVmPayloadBuilder
/// @author Relay Protocol
/// @notice Payload builder for "ton-vm" chains backed by a Highload Wallet V3.
/// @dev The builder produces the signed-body cell hash that the allocator
///      (Ed25519) signs; off-chain assemblers wrap the result into a full
///      external message and submit it to the Highload V3 wallet on TON.
///      The deployed builder is bound to a single Highload V3 wallet via the
///      `SUBWALLET_ID` and `TIMEOUT` immutables — those must match the
///      values baked into the wallet's storage at deploy time.
contract TonVmPayloadBuilder is IPayloadBuilder {
  /// @notice Thrown when an encoded receiver does not have the expected length
  /// @param length Actual encoded receiver length
  error InvalidReceiverLength(uint256 length);

  /// @notice Thrown when an encoded currency does not have the expected length
  /// @param length Actual encoded currency length
  error InvalidCurrencyLength(uint256 length);

  /// @notice Thrown when the requested currency is not native TON
  /// @param currency Encoded currency value supplied by the allocator
  error UnsupportedCurrency(bytes32 currency);

  /// @notice Thrown when the requested amount exceeds TON's VarUInteger16 range
  /// @param amount Requested amount
  error AmountExceedsMaxCoins(uint256 amount);

  /// @notice Thrown when the constructor is passed a timeout that does not fit
  ///         in Highload V3's 22-bit `timeout` field
  /// @param timeout Provided timeout
  error TimeoutExceeds22Bits(uint32 timeout);

  /// @notice Subwallet id baked into the target Highload V3 wallet
  uint32 public immutable SUBWALLET_ID;

  /// @notice Timeout (seconds) baked into the target Highload V3 wallet.
  /// @dev Must fit in 22 bits — the field width Highload V3 uses on-chain.
  uint32 public immutable TIMEOUT;

  /// @notice Send mode applied by the Highload V3 wallet to the inner transfer.
  /// @dev The wallet additionally OR's in `SEND_MODE_IGNORE_ERRORS (2)` when
  ///      it calls `send_raw_message`, so the effective send mode is 3
  ///      (`PAY_GAS_SEPARATELY` | `IGNORE_ERRORS`). Must be part of the signed
  ///      message; keep in sync with the wallet's signed-body assumption.
  uint8 internal constant SEND_MODE = 1;

  /// @notice Bounce flag on the outgoing internal message.
  /// @dev Set to false — Highload V3 fan-out targets are user wallets, which
  ///      are typically non-bounceable. Sending bounceable to an uninitialized
  ///      user wallet would bounce and waste the deposit.
  bool internal constant BOUNCE = false;

  /// @notice Maximum value representable by TON's VarUInteger16 (2^120 - 1)
  uint128 internal constant MAX_TON_COINS = (uint128(1) << 120) - 1;

  /// @notice Encoded length of a TON address (32-byte workchain-0 hash).
  /// @dev The allocator derives the hub tokenId straight from `params.currency`,
  ///      so native TON withdrawals must carry the full native-currency
  ///      encoding (not empty bytes) to burn from the tokenId the hub credits.
  uint256 internal constant CURRENCY_LENGTH = 32;

  /// @notice Encoded native TON currency: the 32-byte all-zero address hash.
  /// @dev Matches `encodeAddress(getVmTypeNativeCurrency("ton-vm"), "ton-vm")`
  ///      in the SDK — the basechain zero address. Jettons would encode to a
  ///      non-zero hash and are not supported.
  bytes32 internal constant NATIVE_CURRENCY = bytes32(0);

  /// @notice 23-bit mask for the HighloadQueryId
  uint32 internal constant QUERY_ID_MASK = uint32((uint32(1) << 23) - 1);

  /// @notice Forbidden bit_number value rejected by Highload V3.
  /// @dev The wallet writes a replay-protection bit at position `bit_number`
  ///      in a 1024-bit cell and pads the remainder with
  ///      `store_zeroes(CELL_BITS_SIZE - bit_number - 1)`; for
  ///      `bit_number = 1023` that is `store_zeroes(-1)`, which traps with
  ///      a TVM range check. `_computeQueryId` remaps this single forbidden
  ///      value down to 0 so the on-TON wallet always accepts our queries.
  uint32 internal constant FORBIDDEN_BIT_NUMBER = 1023;

  /// @notice Creates a new TON VM payload builder bound to a Highload V3 wallet
  /// @param subwalletId Subwallet id stored in the wallet's data (any uint32)
  /// @param timeout Timeout (seconds) stored in the wallet's data; must fit in 22 bits
  constructor(uint32 subwalletId, uint32 timeout) {
    if (timeout >= (uint32(1) << 22)) {
      revert TimeoutExceeds22Bits(timeout);
    }
    SUBWALLET_ID = subwalletId;
    TIMEOUT = timeout;
  }

  /// @inheritdoc IPayloadBuilder
  /// @dev Receiver must be a 32-byte workchain-0 std-address hash. Currency
  ///      must be the 32-byte native TON sentinel (the all-zero address hash);
  ///      jettons are not supported. Amount must fit in VarUInteger16
  ///      (2^120 - 1).
  function buildPayload(
    string calldata /* chainId */,
    bytes calldata /* depository */,
    BuildPayloadParams calldata params
  ) external view override returns (bytes memory payload) {
    if (params.receiver.length != 32) {
      revert InvalidReceiverLength(params.receiver.length);
    }
    if (params.currency.length != CURRENCY_LENGTH) {
      revert InvalidCurrencyLength(params.currency.length);
    }
    bytes32 currency = bytes32(params.currency);
    if (currency != NATIVE_CURRENCY) {
      revert UnsupportedCurrency(currency);
    }
    if (params.amount > MAX_TON_COINS) {
      revert AmountExceedsMaxCoins(params.amount);
    }

    TonTransferRequest memory request = TonTransferRequest({
      receiver: bytes32(params.receiver),
      amount: uint128(params.amount),
      createdAt: uint32(block.timestamp),
      queryId: _computeQueryId(params),
      subwalletId: SUBWALLET_ID,
      timeout: TIMEOUT
    });

    return abi.encode(request);
  }

  /// @inheritdoc IPayloadBuilder
  /// @dev Returns the cell hash of the Highload V3 `msg_inner` cell. The
  ///      allocator signs this hash with Ed25519; off-chain code wraps the
  ///      inner cell plus signature into the external message for the
  ///      Highload V3 wallet to process.
  function hashesToSign(
    string calldata /* chainId */,
    bytes calldata /* depository */,
    bytes calldata payload
  ) external view override returns (bytes32[] memory hashes) {
    TonTransferRequest memory request = abi.decode(
      payload,
      (TonTransferRequest)
    );

    hashes = new bytes32[](1);
    hashes[0] = _signingMessageCellHash(request);
  }

  /// @inheritdoc IPayloadBuilder
  function curve() external pure override returns (string memory name) {
    return "Eddsa";
  }

  /// @inheritdoc IPayloadBuilder
  function family() external pure override returns (string memory name) {
    return "ton-vm";
  }

  /// @notice Computes the 23-bit HighloadQueryId from request fields.
  /// @dev Takes the low 23 bits of `keccak256(...)` and remaps the single
  ///      `bit_number == 1023` value (the low 10 bits) to 0 because
  ///      Highload V3's bitmap update traps for that bit position. The
  ///      23-bit query-id space (~8.4M slots) is uniform but not collision
  ///      free: by the birthday bound, ~3k distinct withdrawals within a
  ///      single TIMEOUT window have a noticeable collision probability.
  ///      Highload V3 rejects messages whose `(shift, bit_number)` slot is
  ///      already consumed, so the off-chain assembler is expected to
  ///      detect that rejection and re-build at a later block (which yields
  ///      a different `block.number` and a different queryId).
  /// @param params Payload builder parameters supplied by the allocator
  /// @return queryId Derived 23-bit query id with valid bit_number
  function _computeQueryId(
    BuildPayloadParams calldata params
  ) internal view returns (uint32 queryId) {
    uint32 raw = uint32(
      uint256(
        keccak256(
          abi.encode(
            block.number,
            params.nonce,
            params.currency,
            params.receiver,
            params.data,
            params.amount
          )
        )
      )
    ) & QUERY_ID_MASK;

    if ((raw & 0x3FF) == FORBIDDEN_BIT_NUMBER) {
      // Clear the low 10 bits (remap bit_number 1023 → 0). The shift bits
      // are preserved so most of the keccak entropy survives.
      raw &= uint32(~uint32(0x3FF));
    }
    queryId = raw;
  }

  // --- TON cell hashing ---

  /// @notice Computes the representation hash of the Highload V3 msg_inner cell.
  /// @dev Cell layout (149 bits, 1 ref):
  ///        subwallet_id  uint32
  ///        ref → internal MessageRelaxed (native TON transfer to receiver)
  ///        send_mode     uint8
  ///        shift         uint13   ┐  HighloadQueryId
  ///        bit_number    uint10   ┘  = (shift << 10) | bit_number
  ///        created_at    uint64
  ///        timeout       uint22
  /// @param request Decoded transfer request
  /// @return hash Cell hash signed by the allocator
  function _signingMessageCellHash(
    TonTransferRequest memory request
  ) internal pure returns (bytes32 hash) {
    bytes32 msgCellHash = _internalMessageCellHash(
      request.receiver,
      request.amount
    );

    bytes memory buf = new bytes(19); // ceil(149 / 8)
    uint256 cursor;
    cursor = _writeBits(buf, cursor, uint256(request.subwalletId), 32);
    cursor = _writeBits(buf, cursor, uint256(SEND_MODE), 8);
    cursor = _writeBits(buf, cursor, uint256(request.queryId) >> 10, 13);
    cursor = _writeBits(buf, cursor, uint256(request.queryId) & 0x3FF, 10);
    cursor = _writeBits(buf, cursor, uint256(request.createdAt), 64);
    cursor = _writeBits(buf, cursor, uint256(request.timeout), 22);

    bytes32[] memory refs = new bytes32[](1);
    refs[0] = msgCellHash;
    uint16[] memory depths = new uint16[](1); // msg cell has no refs of its own
    return _cellRepr(buf, cursor, refs, depths);
  }

  /// @notice Computes the representation hash of the internal MessageRelaxed cell.
  /// @dev Bit layout for a native TON transfer with no init/body, ihr_disabled = 1,
  ///      bounced = 0, src = addr_none, dest = workchain-0 std addr:
  ///        6 bits  : 0(int_msg_info) 1(ihr_disabled) BOUNCE 0(bounced) 00(src=addr_none)
  ///        267 bits: dest (addr_std, wc=0)
  ///        4 + 8N  : grams (VarUInteger16, N bytes)
  ///        1 bit   : extra currencies = 0 (empty)
  ///        4 bits  : ihr_fee = 0
  ///        4 bits  : fwd_fee = 0
  ///        64 bits : created_lt = 0
  ///        32 bits : created_at = 0
  ///        1 bit   : init = none
  ///        1 bit   : body = inline empty
  /// @param receiver Receiver address hash (workchain 0)
  /// @param amount Transfer amount in nanotons
  /// @return hash Internal message cell representation hash
  function _internalMessageCellHash(
    bytes32 receiver,
    uint128 amount
  ) internal pure returns (bytes32 hash) {
    uint8 amountByteLen = _coinsByteLen(amount);
    uint256 totalBits = uint256(384) + uint256(amountByteLen) * 8;

    bytes memory buf = new bytes((totalBits + 7) / 8);
    uint256 cursor;

    // Header: 0 ihr_disabled=1 BOUNCE bounced=0 src=addr_none(00)
    // 6-bit MSB-first value = 0b010_b_00_0 where b = BOUNCE
    uint256 header = (uint256(0) << 5) |
      (uint256(1) << 4) |
      (BOUNCE ? (uint256(1) << 3) : 0);
    cursor = _writeBits(buf, cursor, header, 6);

    // dest = std msg addr (workchain 0)
    cursor = _writeStdAddrWc0(buf, cursor, receiver);

    // grams = VarUInteger16
    cursor = _writeBits(buf, cursor, uint256(amountByteLen), 4);
    if (amountByteLen > 0) {
      cursor = _writeBits(
        buf,
        cursor,
        uint256(amount),
        uint256(amountByteLen) * 8
      );
    }

    // extra currencies = 0 (1 bit)
    cursor = _writeBits(buf, cursor, 0, 1);
    // ihr_fee = 0 (4 bits)
    cursor = _writeBits(buf, cursor, 0, 4);
    // fwd_fee = 0 (4 bits)
    cursor = _writeBits(buf, cursor, 0, 4);
    // created_lt = 0 (64 bits)
    cursor = _writeBits(buf, cursor, 0, 64);
    // created_at = 0 (32 bits)
    cursor = _writeBits(buf, cursor, 0, 32);
    // init = none (1 bit)
    cursor = _writeBits(buf, cursor, 0, 1);
    // body = inline empty (1 bit)
    cursor = _writeBits(buf, cursor, 0, 1);

    bytes32[] memory noRefs = new bytes32[](0);
    uint16[] memory noDepths = new uint16[](0);
    return _cellRepr(buf, cursor, noRefs, noDepths);
  }

  /// @notice Writes a 267-bit workchain-0 std msg address into the bit buffer.
  /// @dev Header is the constant 11-bit pattern `100_0_00000000` = 0x400,
  ///      followed by the 256-bit address hash.
  /// @param buf Bit buffer to write into
  /// @param cursor Current bit cursor
  /// @param hashBits 256-bit address hash
  /// @return newCursor Updated bit cursor (cursor + 267)
  function _writeStdAddrWc0(
    bytes memory buf,
    uint256 cursor,
    bytes32 hashBits
  ) internal pure returns (uint256 newCursor) {
    cursor = _writeBits(buf, cursor, 0x400, 11);
    cursor = _writeBits(buf, cursor, uint256(hashBits) >> 128, 128);
    cursor = _writeBits(
      buf,
      cursor,
      uint256(hashBits) & ((uint256(1) << 128) - 1),
      128
    );
    return cursor;
  }

  /// @notice Returns the number of bytes needed to encode `amount` as a
  ///         VarUInteger16 payload (length prefix excluded).
  /// @param amount Amount to measure
  /// @return n Number of bytes (0..15)
  function _coinsByteLen(uint128 amount) internal pure returns (uint8 n) {
    uint128 a = amount;
    while (a > 0) {
      unchecked {
        n++;
      }
      a >>= 8;
    }
  }

  /// @notice Writes `numBits` of `value` into `buf` at the current bit
  ///         cursor, MSB-first.
  /// @param buf Bit buffer
  /// @param cursor Current bit cursor (in bits)
  /// @param value Value to write; only its low `numBits` bits are used
  /// @param numBits Number of bits to write
  /// @return newCursor Updated bit cursor
  function _writeBits(
    bytes memory buf,
    uint256 cursor,
    uint256 value,
    uint256 numBits
  ) internal pure returns (uint256 newCursor) {
    unchecked {
      uint256 remaining = numBits;
      uint256 cur = cursor;
      while (remaining > 0) {
        uint256 byteIdx = cur >> 3;
        uint256 bitInByte = cur & 7;
        uint256 available = 8 - bitInByte;
        uint256 take = remaining < available ? remaining : available;
        uint256 shift = available - take;
        uint256 chunk = (value >> (remaining - take)) & ((1 << take) - 1);
        buf[byteIdx] = bytes1(uint8(buf[byteIdx]) | uint8(chunk << shift));
        remaining -= take;
        cur += take;
      }
      return cursor + numBits;
    }
  }

  /// @notice Computes the representation hash of an ordinary cell with the
  ///         given data bits, ref hashes, and ref depths.
  /// @dev Per the TVM cell representation spec the repr is
  ///      `d1 || d2 || padded_data || ref_depths || ref_hashes`.
  /// @param buf Bit buffer holding the cell's data bits
  /// @param numBits Number of valid bits in `buf`
  /// @param refHashes Hashes of referenced cells (in order)
  /// @param refDepths Depths of referenced cells (in order, same length as `refHashes`)
  /// @return hash Cell representation hash (sha256)
  function _cellRepr(
    bytes memory buf,
    uint256 numBits,
    bytes32[] memory refHashes,
    uint16[] memory refDepths
  ) internal pure returns (bytes32 hash) {
    uint256 fullBytes = numBits >> 3;
    uint256 padBytes = (numBits + 7) >> 3;

    bytes memory padded = new bytes(padBytes);
    for (uint256 i = 0; i < fullBytes; ++i) {
      padded[i] = buf[i];
    }
    if (numBits % 8 != 0) {
      uint256 remBits = numBits - fullBytes * 8;
      uint256 mask = ((uint256(1) << remBits) - 1) << (8 - remBits);
      uint8 lastByte = uint8(buf[fullBytes]) & uint8(mask);
      uint8 completionBit = uint8(1 << (7 - remBits));
      padded[fullBytes] = bytes1(lastByte | completionBit);
    }

    uint8 d1 = uint8(refHashes.length);
    uint8 d2 = uint8(fullBytes + padBytes);

    bytes memory repr = abi.encodePacked(d1, d2, padded);
    for (uint256 i = 0; i < refDepths.length; ++i) {
      repr = abi.encodePacked(repr, refDepths[i]);
    }
    for (uint256 i = 0; i < refHashes.length; ++i) {
      repr = abi.encodePacked(repr, refHashes[i]);
    }
    return sha256(repr);
  }
}
