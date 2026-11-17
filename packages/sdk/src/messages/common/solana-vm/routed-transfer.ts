// ABOUTME: Routed solana-vm depository transfers: the RoutedTransferRequest payload
// ABOUTME: (type prefix ‖ borsh), its hash and the used_request PDA it consumes.

import * as anchor from "@coral-xyz/anchor"
import { BorshCoder, Idl } from "@coral-xyz/anchor"
import { PublicKey, SystemProgram } from "@solana/web3.js"
import { sha256 } from "js-sha256"
import { maxUint64 } from "viem"

import { encodeBytes } from "../../../utils"
import { RelayDepositoryIdl } from "./idls/RelayDepositoryIdl"

// Mirrors the depository: a routed request never hashes like a plain TransferRequest
export const ROUTED_TRANSFER_REQUEST_PREFIX = Buffer.from(
  "RelayDepository:RoutedTransferRequest:v1",
  "utf8"
)

// Same field conventions as the plain solana-vm withdrawal (system program = native SOL)
export type SolanaRoutedTransferRequest = {
  domain: string
  recipient: string
  token: string
  amount: string
  nonce: string
  expiration: number
  vaultAddress: string
  router: string
}

const coder = new BorshCoder(RelayDepositoryIdl as Idl)

export const toBytes32 = (value: string): Buffer => {
  const bytes = Buffer.from(encodeBytes(value))
  if (bytes.length !== 32) {
    throw new Error("Expected a 32-byte hex value")
  }
  return bytes
}

// BN silently drops signs and whitespace, so only the canonical spelling is accepted
export const toU64 = (value: string): anchor.BN => {
  if (!/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) > maxUint64) {
    throw new Error("Expected a u64 decimal string")
  }
  return new anchor.BN(value)
}

export const encodeSolanaRoutedTransferRequest = (
  request: SolanaRoutedTransferRequest
): Buffer =>
  Buffer.concat([
    ROUTED_TRANSFER_REQUEST_PREFIX,
    coder.types.encode("RoutedTransferRequest", {
      domain: toBytes32(request.domain),
      recipient: new PublicKey(request.recipient),
      token:
        request.token === SystemProgram.programId.toBase58()
          ? null
          : new PublicKey(request.token),
      amount: toU64(request.amount),
      nonce: toU64(request.nonce),
      expiration: new anchor.BN(request.expiration),
      vault_address: new PublicKey(request.vaultAddress),
      router: new PublicKey(request.router),
    }),
  ])

const isSolanaRoutedTransferRequestPayload = (payload: Uint8Array) =>
  payload.length >= ROUTED_TRANSFER_REQUEST_PREFIX.length &&
  ROUTED_TRANSFER_REQUEST_PREFIX.equals(
    Buffer.from(payload.subarray(0, ROUTED_TRANSFER_REQUEST_PREFIX.length))
  )

// Returns undefined for plain TransferRequest payloads
export const decodeSolanaRoutedTransferRequest = (
  payload: string | Uint8Array
): SolanaRoutedTransferRequest | undefined => {
  const buffer = Buffer.from(
    typeof payload === "string" ? encodeBytes(payload) : payload
  )
  if (!isSolanaRoutedTransferRequestPayload(buffer)) {
    return undefined
  }

  const raw = coder.types.decode(
    "RoutedTransferRequest",
    buffer.subarray(ROUTED_TRANSFER_REQUEST_PREFIX.length)
  )
  const request: SolanaRoutedTransferRequest = {
    domain: "0x" + Buffer.from(raw.domain).toString("hex"),
    recipient: raw.recipient.toBase58(),
    token: raw.token
      ? raw.token.toBase58()
      : SystemProgram.programId.toBase58(),
    amount: raw.amount.toString(),
    nonce: raw.nonce.toString(),
    expiration: raw.expiration.toNumber(),
    vaultAddress: raw.vault_address.toBase58(),
    router: raw.router.toBase58(),
  }

  // Borsh ignores trailing bytes, which would alias distinct payloads to one id
  if (!encodeSolanaRoutedTransferRequest(request).equals(buffer)) {
    throw new Error("Invalid routed transfer request payload")
  }

  return request
}

export const getSolanaRoutedTransferRequestHash = (
  request: SolanaRoutedTransferRequest
): string =>
  "0x" +
  Buffer.from(
    sha256.create().update(encodeSolanaRoutedTransferRequest(request)).array()
  ).toString("hex")

// Plain and routed requests share the ["used_request", id] namespace
export const getSolanaUsedRequestAddress = (
  depositoryProgramId: string,
  withdrawalId: string
): string =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("used_request"), toBytes32(withdrawalId)],
    new PublicKey(depositoryProgramId)
  )[0].toBase58()
