// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title Sha512
/// @author Relay Protocol
/// @notice Pure-Solidity SHA-512 (FIPS 180-4). The EVM only exposes SHA-256 as
///         a precompile, but XRPL signing hashes are SHA-512Half, so
///         `XrpVmPayloadBuilder` needs its own implementation. Word arithmetic
///         is 64-bit and wraps modulo 2^64; correctness is pinned by the
///         known-answer tests in test/PayloadBuilders/Sha512.t.sol.
library Sha512 {
  /// @notice The 80 round constants, concatenated big-endian (80 * 8 bytes).
  bytes internal constant K =
    hex"428a2f98d728ae227137449123ef65cdb5c0fbcfec4d3b2fe9b5dba58189dbbc3956c25bf348b53859f111f1b605d019923f82a4af194f9bab1c5ed5da6d8118d807aa98a303024212835b0145706fbe243185be4ee4b28c550c7dc3d5ffb4e272be5d74f27b896f80deb1fe3b1696b19bdc06a725c71235c19bf174cf692694e49b69c19ef14ad2efbe4786384f25e30fc19dc68b8cd5b5240ca1cc77ac9c652de92c6f592b02754a7484aa6ea6e4835cb0a9dcbd41fbd476f988da831153b5983e5152ee66dfaba831c66d2db43210b00327c898fb213fbf597fc7beef0ee4c6e00bf33da88fc2d5a79147930aa72506ca6351e003826f142929670a0e6e7027b70a8546d22ffc2e1b21385c26c9264d2c6dfc5ac42aed53380d139d95b3df650a73548baf63de766a0abb3c77b2a881c2c92e47edaee692722c851482353ba2bfe8a14cf10364a81a664bbc423001c24b8b70d0f89791c76c51a30654be30d192e819d6ef5218d69906245565a910f40e35855771202a106aa07032bbd1b819a4c116b8d2d0c81e376c085141ab532748774cdf8eeb9934b0bcb5e19b48a8391c0cb3c5c95a634ed8aa4ae3418acb5b9cca4f7763e373682e6ff3d6b2b8a3748f82ee5defb2fc78a5636f43172f6084c87814a1f0ab728cc702081a6439ec90befffa23631e28a4506cebde82bde9bef9a3f7b2c67915c67178f2e372532bca273eceea26619cd186b8c721c0c207eada7dd6cde0eb1ef57d4f7fee6ed17806f067aa72176fba0a637dc5a2c898a6113f9804bef90dae1b710b35131c471b28db77f523047d8432caab7b40c724933c9ebe0a15c9bebc431d67c49c100d4c4cc5d4becb3e42b6597f299cfc657e2a5fcb6fab3ad6faec6c44198c4a475817";

  /// @notice First 32 bytes of SHA-512(message).
  /// @param message The message to hash
  /// @return out First 32 bytes of the SHA-512 digest
  function hashHalf(bytes memory message) internal pure returns (bytes32 out) {
    bytes memory digest = hash(message);
    assembly {
      out := mload(add(digest, 0x20))
    }
  }

  /// @notice Full 64-byte SHA-512 digest of `message`.
  /// @param message The message to hash
  /// @return digest 64-byte SHA-512 digest
  function hash(
    bytes memory message
  ) internal pure returns (bytes memory digest) {
    uint256 len = message.length;

    // Pad to a multiple of 128 bytes: message || 0x80 || 0x00... || 128-bit
    // big-endian bit length (the high 64 bits are always zero here).
    uint256 withOne = len + 1;
    uint256 rem = withOne % 128;
    uint256 padZeros = rem <= 112 ? (112 - rem) : (112 + 128 - rem);
    uint256 total = withOne + padZeros + 16;

    bytes memory m = new bytes(total);
    for (uint256 i = 0; i < len; ++i) {
      m[i] = message[i];
    }
    m[len] = 0x80;
    uint256 bitLen = len * 8;
    for (uint256 i = 0; i < 8; ++i) {
      m[total - 1 - i] = bytes1(uint8(bitLen >> (8 * i)));
    }

    uint64[8] memory h;
    h[0] = 0x6a09e667f3bcc908;
    h[1] = 0xbb67ae8584caa73b;
    h[2] = 0x3c6ef372fe94f82b;
    h[3] = 0xa54ff53a5f1d36f1;
    h[4] = 0x510e527fade682d1;
    h[5] = 0x9b05688c2b3e6c1f;
    h[6] = 0x1f83d9abfb41bd6b;
    h[7] = 0x5be0cd19137e2179;

    bytes memory kmem = K;

    for (uint256 off = 0; off < total; off += 128) {
      uint64[80] memory w;
      for (uint256 t = 0; t < 16; ++t) {
        w[t] = _readU64(m, off + t * 8);
      }
      for (uint256 t = 16; t < 80; ++t) {
        uint64 s0 = _rotr(w[t - 15], 1) ^
          _rotr(w[t - 15], 8) ^
          (w[t - 15] >> 7);
        uint64 s1 = _rotr(w[t - 2], 19) ^ _rotr(w[t - 2], 61) ^ (w[t - 2] >> 6);
        unchecked {
          w[t] = w[t - 16] + s0 + w[t - 7] + s1;
        }
      }

      // Working variables a..h in a memory array so the round fits the stack.
      uint64[8] memory v = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7]];
      for (uint256 t = 0; t < 80; ++t) {
        _round(v, _readU64(kmem, t * 8), w[t]);
      }

      unchecked {
        h[0] += v[0];
        h[1] += v[1];
        h[2] += v[2];
        h[3] += v[3];
        h[4] += v[4];
        h[5] += v[5];
        h[6] += v[6];
        h[7] += v[7];
      }
    }

    digest = new bytes(64);
    for (uint256 i = 0; i < 8; ++i) {
      uint64 hv = h[i];
      for (uint256 j = 0; j < 8; ++j) {
        digest[i * 8 + j] = bytes1(uint8(hv >> (8 * (7 - j))));
      }
    }
  }

  /// @notice One compression round applied in place to `v` = [a..h].
  /// @param v Working variables [a..h], updated in place
  /// @param kt Round constant K[t]
  /// @param wt Message schedule word W[t]
  function _round(uint64[8] memory v, uint64 kt, uint64 wt) private pure {
    uint64 e = v[4];
    uint64 a = v[0];
    uint64 bigS1 = _rotr(e, 14) ^ _rotr(e, 18) ^ _rotr(e, 41);
    uint64 ch = (e & v[5]) ^ (~e & v[6]);
    uint64 bigS0 = _rotr(a, 28) ^ _rotr(a, 34) ^ _rotr(a, 39);
    uint64 maj = (a & v[1]) ^ (a & v[2]) ^ (v[1] & v[2]);
    unchecked {
      uint64 t1 = v[7] + bigS1 + ch + kt + wt;
      uint64 t2 = bigS0 + maj;
      v[7] = v[6];
      v[6] = v[5];
      v[5] = v[4];
      v[4] = v[3] + t1;
      v[3] = v[2];
      v[2] = v[1];
      v[1] = v[0];
      v[0] = t1 + t2;
    }
  }

  /// @notice Rotate-right of a 64-bit word (0 < n < 64).
  /// @param x Value to rotate
  /// @param n Rotation amount
  /// @return Rotated value
  function _rotr(uint64 x, uint256 n) private pure returns (uint64) {
    unchecked {
      return (x >> n) | (x << uint64(64 - n));
    }
  }

  /// @notice Reads a big-endian uint64 from `b` at byte `offset`. Bytes read
  ///         past the value are shifted out, so end-of-buffer reads are safe.
  /// @param b Source buffer
  /// @param offset Byte offset of the 8-byte word
  /// @return v The decoded 64-bit word
  function _readU64(
    bytes memory b,
    uint256 offset
  ) private pure returns (uint64 v) {
    assembly {
      v := shr(192, mload(add(add(b, 0x20), offset)))
    }
  }
}
