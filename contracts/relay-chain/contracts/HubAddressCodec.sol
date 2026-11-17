// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {Base58} from "solady/utils/Base58.sol";

/// @title HubAddressCodec
/// @author Relay Protocol
/// @notice Converts human-readable origin-chain addresses into the byte form
/// the Hub hashes into aliases and token ids, mirroring the SDK's
/// `encodeAddress`.
/// @dev Supported inputs:
/// - `0x` hex of any length: ethereum-vm, hyperliquid-vm, or pre-encoded bytes
///   for any other family
/// - base58 decoding to 32 bytes: solana-vm
/// - base58check with version 0x41: tron-vm, returns the 21-byte payload
/// - base58check with version 0x00 or 0x05: legacy bitcoin-vm, returns 0xff
///   followed by the 21-byte payload
/// - `bc1` bech32 or bech32m: bitcoin-vm, returns the witness version followed
///   by the witness program
library HubAddressCodec {
  /// @notice Revert when a `0x` string has an odd length, a non-hex character
  /// or more than 32 bytes
  error InvalidHexAddress(string addr);

  /// @notice Revert when a base58check checksum does not match its payload
  error InvalidBase58Checksum(string addr);

  /// @notice Revert when the decoded length or version matches no known family
  error UnsupportedAddress(string addr);

  uint8 private constant TRON_VERSION = 0x41;
  uint8 private constant BITCOIN_P2PKH_VERSION = 0x00;
  uint8 private constant BITCOIN_P2SH_VERSION = 0x05;
  uint8 private constant BITCOIN_LEGACY_DISCRIMINATOR = 0xff;
  uint256 private constant BECH32_CONST = 1;
  uint256 private constant BECH32M_CONST = 0x2bc830a3;
  bytes private constant BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

  /// @notice Encode an origin-chain address into its Hub byte form
  /// @return encoded The bytes the Hub hashes for this address
  function encode(
    string memory addr
  ) internal pure returns (bytes memory encoded) {
    bytes memory s = bytes(addr);
    if (s.length >= 2 && s[0] == "0" && (s[1] == "x" || s[1] == "X")) {
      return _decodeHex(addr, s.length);
    }
    if (_hasBech32Prefix(s)) {
      (bool ok, bytes memory witness) = _decodeBech32(s);
      if (ok) {
        return witness;
      }
      // A base58 address can also start with "bc1"; fall through.
    }
    bytes memory decoded = Base58.decode(addr);
    if (decoded.length == 32) {
      return decoded;
    }
    if (decoded.length == 25) {
      return _decodeBase58Check(addr, decoded);
    }
    revert UnsupportedAddress(addr);
  }

  /// @notice Decode a `0x`-prefixed hex string of up to 32 bytes
  /// @return out The decoded bytes, preserving the input length
  function _decodeHex(
    string memory addr,
    uint256 stringLength
  ) private pure returns (bytes memory out) {
    uint256 byteLength = (stringLength - 2) / 2;
    (bool ok, uint256 value) = Strings.tryParseHexUint(addr, 2, stringLength);
    if (!ok || stringLength % 2 != 0 || byteLength > 32) {
      revert InvalidHexAddress(addr);
    }
    out = new bytes(byteLength);
    for (uint256 i = 0; i < byteLength; ++i) {
      out[i] = bytes1(uint8(value >> (8 * (byteLength - 1 - i))));
    }
  }

  /// @notice Split a 25-byte base58check decoding into payload and checksum
  /// and map its version byte to a Hub family
  /// @return The Hub byte form: the 21-byte payload for Tron, or 0xff followed
  /// by the payload for legacy Bitcoin
  function _decodeBase58Check(
    string memory addr,
    bytes memory decoded
  ) private pure returns (bytes memory) {
    bytes memory payload = new bytes(21);
    for (uint256 i = 0; i < 21; ++i) {
      payload[i] = decoded[i];
    }
    bytes32 digest = sha256(abi.encodePacked(sha256(payload)));
    for (uint256 i = 0; i < 4; ++i) {
      if (decoded[21 + i] != digest[i]) {
        revert InvalidBase58Checksum(addr);
      }
    }
    uint8 version = uint8(payload[0]);
    if (version == TRON_VERSION) {
      return payload;
    }
    if (version == BITCOIN_P2PKH_VERSION || version == BITCOIN_P2SH_VERSION) {
      return abi.encodePacked(BITCOIN_LEGACY_DISCRIMINATOR, payload);
    }
    revert UnsupportedAddress(addr);
  }

  /// @notice Whether the string starts with "bc1", ignoring case
  /// @return True for a bitcoin mainnet segwit prefix
  function _hasBech32Prefix(bytes memory s) private pure returns (bool) {
    return
      s.length > 3 &&
      (s[0] == "b" || s[0] == "B") &&
      (s[1] == "c" || s[1] == "C") &&
      s[2] == "1";
  }

  /// @notice Decode a "bc1" bech32 or bech32m segwit address
  /// @dev Returns `ok == false` instead of reverting on any malformed input so
  /// the caller can fall back to base58.
  /// @return ok Whether the input is a valid segwit address
  /// @return witness The witness version followed by the witness program
  function _decodeBech32(
    bytes memory s
  ) private pure returns (bool ok, bytes memory witness) {
    // 3 prefix chars, at least 1 data char, 6 checksum chars; max 90 total
    if (s.length < 10 || s.length > 90) {
      return (false, witness);
    }
    uint256 dataLength = s.length - 3;
    uint8[] memory words = new uint8[](dataLength);
    for (uint256 i = 0; i < dataLength; ++i) {
      (bool valid, uint8 word) = _bech32Word(s[i + 3]);
      if (!valid) {
        return (false, witness);
      }
      words[i] = word;
    }
    uint8 version = words[0];
    if (version > 16) {
      return (false, witness);
    }
    uint256 expected = version == 0 ? BECH32_CONST : BECH32M_CONST;
    if (_bech32Polymod(words) != expected) {
      return (false, witness);
    }
    // Regroup the 5-bit words between version and checksum into bytes
    uint256 programWords = dataLength - 7;
    uint256 programLength = (programWords * 5) / 8;
    if ((programWords * 5) % 8 >= 5 || programLength == 0) {
      return (false, witness);
    }
    witness = new bytes(1 + programLength);
    witness[0] = bytes1(version);
    uint256 acc;
    uint256 bits;
    uint256 out = 1;
    for (uint256 i = 1; i <= programWords; ++i) {
      acc = (acc << 5) | words[i];
      bits += 5;
      if (bits >= 8) {
        bits -= 8;
        witness[out++] = bytes1(uint8(acc >> bits));
      }
    }
    if (acc & ((1 << bits) - 1) != 0) {
      return (false, witness);
    }
    return (true, witness);
  }

  /// @notice Value of one bech32 character, accepting upper or lower case
  /// @return valid Whether the character is in the charset
  /// @return word The 5-bit value
  function _bech32Word(bytes1 c) private pure returns (bool valid, uint8 word) {
    uint8 b = uint8(c);
    if (b >= 0x41 && b <= 0x5a) {
      b += 32;
    }
    for (uint8 i = 0; i < 32; ++i) {
      if (uint8(BECH32_CHARSET[i]) == b) {
        return (true, i);
      }
    }
    return (false, 0);
  }

  /// @notice BIP-173 checksum over the "bc" prefix and the data words
  /// @return chk The polymod value, 1 for bech32 and 0x2bc830a3 for bech32m
  function _bech32Polymod(
    uint8[] memory words
  ) private pure returns (uint256 chk) {
    uint32[5] memory generator = [
      0x3b6a57b2,
      0x26508e6d,
      0x1ea119fa,
      0x3d4233dd,
      0x2a1462b3
    ];
    // Expanded human-readable part for "bc": high bits, separator, low bits
    uint8[5] memory hrp = [3, 3, 0, 2, 3];
    chk = 1;
    for (uint256 i = 0; i < hrp.length + words.length; ++i) {
      uint256 v = i < hrp.length ? hrp[i] : words[i - hrp.length];
      uint256 top = chk >> 25;
      chk = ((chk & 0x1ffffff) << 5) ^ v;
      for (uint256 j = 0; j < 5; ++j) {
        if ((top >> j) & 1 == 1) {
          chk ^= generator[j];
        }
      }
    }
  }
}
