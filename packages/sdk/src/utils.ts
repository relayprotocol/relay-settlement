import { bytesToHex, Hex, hexToBytes } from "viem"
import { bech32, bech32m } from "bech32"
import * as bitcoin from "bitcoinjs-lib"
import bs58 from "bs58"
import { Address as TonAddress } from "@ton/core"
import * as tronweb from "tronweb"
import {
  decodeAccountID,
  encodeAccountID,
  isValidClassicAddress,
  isValidXAddress,
  xAddressToClassicAddress,
} from "ripple-address-codec"

import {
  decodeHederaAddress,
  encodeHederaAddress,
  HEDERA_HBAR_TOKEN_ID,
} from "./hedera-vm"

export type VmType =
  | "bitcoin-vm"
  | "ethereum-vm"
  | "gateway-vm"
  | "hedera-vm"
  | "hyperliquid-vm"
  | "solana-vm"
  | "ton-vm"
  | "tron-vm"
  | "lighter-vm"
  | "xrp-vm"

export type ChainIdToVmType = Record<string, VmType>

export const getChainVmType = (
  chainId: string,
  chainsConfig: ChainIdToVmType
) => {
  if (!chainsConfig[chainId]) {
    throw new Error(`Unknown vm type for chain ${chainId}`)
  }

  return chainsConfig[chainId]
}

// Native currencies

export const getVmTypeNativeCurrency = (vmType: VmType) => {
  switch (vmType) {
    case "bitcoin-vm":
      return "bc1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqmql8k8"
    case "ethereum-vm":
    case "gateway-vm":
      return "0x0000000000000000000000000000000000000000"
    case "hedera-vm":
      // HBAR has no HTS token entity, so the zero entity id stands in for it
      // (mirroring the zero-address sentinel used by the other VMs). Encodes to
      // 20 zero bytes via `encodeAddress`.
      return HEDERA_HBAR_TOKEN_ID
    case "hyperliquid-vm":
      return "0x00000000000000000000000000000000"
    case "solana-vm":
      return "11111111111111111111111111111111"
    case "ton-vm":
      return "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c"
    case "tron-vm":
      return "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb"
    case "lighter-vm":
      return "0"
    case "xrp-vm":
      // ACCOUNT_ZERO: the classic address for the all-zero 20-byte account id.
      // Native XRP has no issuer/currency contract, so the zero account is used
      // as the native-currency sentinel (mirrors the zero-address sentinel used
      // by the other VMs). Encodes to 20 zero bytes via `encodeAddress`.
      return "rrrrrrrrrrrrrrrrrrrrrhoLvTp"
    default:
      throw new Error(`Native currency not available for vm type ${vmType}`)
  }
}

const _toHexString = (arr: Uint8Array): Hex => {
  return `0x${Buffer.from(arr).toString("hex")}`
}

// Bytes encoding

export const encodeBytesToHex = (bytes: string) =>
  _toHexString(encodeBytes(bytes))

export const encodeBytes = (bytes: string) => hexToBytes(bytes as Hex)

// Address encoding

export const encodeAddressToHex = (address: string, vmType: VmType): Hex => {
  return _toHexString(encodeAddress(address, vmType))
}

export const encodeAddress = (address: string, vmType: VmType): Uint8Array => {
  switch (vmType) {
    case "bitcoin-vm": {
      const LEGACY_BITCOIN_ADDRESS_DISCRIMINATOR = 0xff

      const getBitcoinAddressType = (
        address: string
      ): "p2pkh" | "p2sh" | "bech32" | "bech32m" => {
        if (address.startsWith("1")) {
          return "p2pkh"
        }

        if (address.startsWith("3")) {
          return "p2sh"
        }

        if (address.startsWith("bc1")) {
          const lower = address.toLowerCase()

          // Try Bech32 first (v0)
          try {
            const decoded = bech32.decode(lower, 90)
            if (decoded.prefix === "bc" && decoded.words[0] === 0) {
              return "bech32"
            }
          } catch (_) {}

          // Try Bech32m (v1+)
          try {
            const decoded = bech32m.decode(lower, 90)
            if (decoded.prefix === "bc" && decoded.words[0] >= 1) {
              return "bech32m"
            }
          } catch (_) {}
        }

        throw new Error("Unsupported address format")
      }

      const type = getBitcoinAddressType(address)
      if (type === "p2pkh" || type === "p2sh") {
        const decoded = bs58.decode(address)
        // Strip the checksum and prefix with a discriminator so legacy
        // Base58Check addresses don't collide with witness-version encodings
        // (notably P2PKH 0x00 || hash160 vs P2WPKH v0 || 20-byte program).
        return Uint8Array.from([
          LEGACY_BITCOIN_ADDRESS_DISCRIMINATOR,
          ...decoded.slice(0, -4),
        ])
      } else {
        const decoder = type === "bech32" ? bech32 : bech32m
        const { words } = decoder.decode(address)
        const version = words[0]
        const program = bech32.fromWords(words.slice(1))
        return Uint8Array.from([version, ...program])
      }
    }

    case "ethereum-vm": {
      return hexToBytes(address as Hex)
    }

    case "gateway-vm": {
      throw new Error(
        "Address encoding is intentionally unsupported for gateway-vm because this VM type will not be supported for order creation"
      )
    }

    case "hedera-vm": {
      // 20-byte encoding: entity ids (`0.0.456858`) as their long-zero address,
      // account EVM aliases as themselves. See ./hedera-vm.ts for the accepted
      // address forms and why checksummed input is rejected here.
      return encodeHederaAddress(address)
    }

    case "hyperliquid-vm": {
      return hexToBytes(address as Hex)
    }

    case "solana-vm": {
      return bs58.decode(address)
    }

    case "ton-vm": {
      // 32-byte hash-only encoding (fits the bytes32 order slot used across
      // all VMs). Workchain is a chain-level property — each Relay chainId
      // maps to a single TON workchain (current chains all target basechain).
      // Cross-workchain addresses on a single chainId are a mismatch.
      const parsed = TonAddress.parse(address)
      if (parsed.workChain !== 0) {
        throw new Error(
          `TON address on workchain ${parsed.workChain} does not match the expected basechain (workchain 0) for this chainId`
        )
      }
      return new Uint8Array(parsed.hash)
    }

    case "tron-vm": {
      return hexToBytes(`0x${tronweb.utils.address.toHex(address)}`)
    }

    case "lighter-vm": {
      return hexToBytes(`0x${Number(address).toString(16).padStart(32, "0")}`)
    }

    case "xrp-vm": {
      // 20-byte AccountID encoding. Classic ("r...") addresses decode directly;
      // X-addresses are accepted only when they carry no destination tag — a
      // tag is not part of the account and must be conveyed as a separate
      // DestinationTag field, not folded into the 20-byte account slot.
      let classicAddress = address
      if (isValidXAddress(address)) {
        const decoded = xAddressToClassicAddress(address)
        if (decoded.tag !== false) {
          throw new Error(
            "XRP X-address carries a destination tag; supply the tag separately and use the classic address"
          )
        }
        classicAddress = decoded.classicAddress
      }
      if (!isValidClassicAddress(classicAddress)) {
        throw new Error(`Invalid XRP address: ${address}`)
      }
      return Uint8Array.from(decodeAccountID(classicAddress))
    }

    default: {
      throw new Error(`Vm type not implemented (encodeAddress)`)
    }
  }
}

export const decodeAddress = (address: Uint8Array, vmType: VmType): string => {
  switch (vmType) {
    case "bitcoin-vm": {
      const LEGACY_BITCOIN_ADDRESS_DISCRIMINATOR = 0xff
      if (address[0] === LEGACY_BITCOIN_ADDRESS_DISCRIMINATOR) {
        // Discriminated Base58Check (P2PKH/P2SH)
        const payload = address.slice(1)
        if (
          payload.length !== 21 ||
          (payload[0] !== 0x00 && payload[0] !== 0x05)
        ) {
          throw new Error("Unsupported legacy bitcoin address encoding")
        }
        const checksum = bitcoin.crypto
          .hash256(Buffer.from(payload))
          .slice(0, 4)
        const full = Buffer.concat([Buffer.from(payload), checksum])
        return bs58.encode(full)
      } else {
        // Bech32/Bech32m. The first byte is the witness version and the
        // remaining bytes are the witness program.
        const version = address[0]
        const program = Array.from(address.slice(1))
        const words = [version, ...bech32.toWords(Uint8Array.from(program))]
        if (version === 0) {
          return bech32.encode("bc", words)
        } else {
          return bech32m.encode("bc", words)
        }
      }
    }

    case "ethereum-vm": {
      return bytesToHex(address)
    }

    case "gateway-vm": {
      throw new Error(
        "Address decoding is intentionally unsupported for gateway-vm because this VM type will not be supported for order creation"
      )
    }

    case "hedera-vm": {
      // Long-zero values decode back to their entity id; anything else is an
      // account EVM alias. Twenty zero bytes decode to `0.0.0`, the HBAR
      // sentinel.
      return decodeHederaAddress(address)
    }

    case "hyperliquid-vm": {
      return bytesToHex(address)
    }

    case "solana-vm": {
      return bs58.encode(address)
    }

    case "ton-vm": {
      if (address.length !== 32) {
        throw new Error(
          `Invalid TON address byte length ${address.length}; expected 32`
        )
      }
      // Workchain implied = 0 (basechain); see comment on encodeAddress's
      // ton-vm case for why workchain is chain-level, not address-level.
      return new TonAddress(0, Buffer.from(address)).toRawString()
    }

    case "tron-vm": {
      return tronweb.utils.address.fromHex(bytesToHex(address).slice(2))
    }

    case "lighter-vm": {
      return Number("0x" + Buffer.from(address).toString("hex")).toString()
    }

    case "xrp-vm": {
      if (address.length !== 20) {
        throw new Error(
          `Invalid XRP account id byte length ${address.length}; expected 20`
        )
      }
      return encodeAccountID(Buffer.from(address))
    }

    default: {
      throw new Error(`Vm type not implemented (decodeAddress)`)
    }
  }
}

// Decomposes an XRP destination into its account and optional destination tag.
// Classic ("r...") addresses carry no tag; X-addresses may embed one. The tag
// is payment-critical (it identifies the end user for custodial/exchange
// deposits) and must travel in the transaction's DestinationTag field, never
// folded into the 20-byte account. Callers should therefore set both
// `destination = account` and `destinationTag = tag` from the result, rather
// than passing an X-address straight into `encodeAddress` (which is
// account-only and rejects tagged X-addresses to prevent a silent tag drop).
export const decodeXrpDestination = (
  address: string
): { account: string; tag?: number } => {
  if (isValidXAddress(address)) {
    const { classicAddress, tag } = xAddressToClassicAddress(address)
    return { account: classicAddress, tag: tag === false ? undefined : tag }
  }
  if (!isValidClassicAddress(address)) {
    throw new Error(`Invalid XRP address: ${address}`)
  }
  return { account: address }
}
