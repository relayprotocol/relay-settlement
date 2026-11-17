// ABOUTME: Gateway transfer requests for the Solana Gateway depository program: the
// ABOUTME: execution payload (type prefix ‖ borsh), its hash and the destination codec.

import { PublicKey } from "@solana/web3.js"
import { sha256 } from "js-sha256"

import { encodeBytes } from "../../../../utils"
import { toBytes32, toU64 } from "../../../common/solana-vm/routed-transfer"
import type { GatewayDestinationWithdrawalCodec } from "./destination"

// Circle's GatewayMinter program on Solana (GATEm5SoBJiSw1v2Pz1iPBgUYkXzCUJ27XSXhDfSyzVZ).
export const SOLANA_VM_GATEWAY_MINTER =
  "0xe14b329dba52e324a7a85f52d16d7ef309ff24aa5d7421b0316b568c0e27d78c"

// Mirror the depository: a routed request never hashes like a plain one
export const GATEWAY_TRANSFER_REQUEST_PREFIX = Buffer.from(
  "RelayGatewayDepository:TransferRequest:v1",
  "utf8"
)
export const GATEWAY_ROUTED_TRANSFER_REQUEST_PREFIX = Buffer.from(
  "RelayGatewayDepository:RoutedTransferRequest:v1",
  "utf8"
)

// Mirrors `GatewayTransferRequest` / `GatewayRoutedTransferRequest` in relay-gateway-depository
export type GatewaySolanaVmTransferRequest = {
  domain: string
  transferSpecHash: string
  recipient: string
  token: string
  amount: string
  nonce: string
  expiration: number
  // Set only for routed requests, which carry their own type prefix
  router?: string
}

const PLAIN_REQUEST_LENGTH = 152
const ROUTED_REQUEST_LENGTH = PLAIN_REQUEST_LENGTH + 32

const toI64 = (value: number): Buffer => {
  if (!Number.isSafeInteger(value)) {
    throw new Error("Expected an i64 integer")
  }
  const buffer = Buffer.alloc(8)
  buffer.writeBigInt64LE(BigInt(value))
  return buffer
}

export const encodeGatewaySolanaVmTransferRequest = (
  request: GatewaySolanaVmTransferRequest
): Buffer =>
  Buffer.concat([
    request.router !== undefined
      ? GATEWAY_ROUTED_TRANSFER_REQUEST_PREFIX
      : GATEWAY_TRANSFER_REQUEST_PREFIX,
    toBytes32(request.domain),
    toBytes32(request.transferSpecHash),
    new PublicKey(request.recipient).toBuffer(),
    new PublicKey(request.token).toBuffer(),
    toU64(request.amount).toArrayLike(Buffer, "le", 8),
    toU64(request.nonce).toArrayLike(Buffer, "le", 8),
    toI64(request.expiration),
    ...(request.router !== undefined
      ? [new PublicKey(request.router).toBuffer()]
      : []),
  ])

const hasPrefix = (payload: Buffer, prefix: Buffer) =>
  prefix.equals(payload.subarray(0, prefix.length))

// The two prefixes share no common head, so the prefix alone selects the layout
export const decodeGatewaySolanaVmTransferRequest = (
  payload: string | Uint8Array
): GatewaySolanaVmTransferRequest => {
  const buffer = Buffer.from(
    typeof payload === "string" ? encodeBytes(payload) : payload
  )
  const routed = hasPrefix(buffer, GATEWAY_ROUTED_TRANSFER_REQUEST_PREFIX)
  const prefix = routed
    ? GATEWAY_ROUTED_TRANSFER_REQUEST_PREFIX
    : GATEWAY_TRANSFER_REQUEST_PREFIX
  const body = buffer.subarray(prefix.length)
  if (
    !hasPrefix(buffer, prefix) ||
    body.length !== (routed ? ROUTED_REQUEST_LENGTH : PLAIN_REQUEST_LENGTH)
  ) {
    throw new Error("Invalid Gateway transfer request payload")
  }

  const expiration = body.readBigInt64LE(144)
  if (
    expiration > BigInt(Number.MAX_SAFE_INTEGER) ||
    expiration < BigInt(Number.MIN_SAFE_INTEGER)
  ) {
    throw new Error("Invalid Gateway transfer request expiration")
  }

  return {
    domain: "0x" + body.subarray(0, 32).toString("hex"),
    transferSpecHash: "0x" + body.subarray(32, 64).toString("hex"),
    recipient: new PublicKey(body.subarray(64, 96)).toBase58(),
    token: new PublicKey(body.subarray(96, 128)).toBase58(),
    amount: body.readBigUInt64LE(128).toString(),
    nonce: body.readBigUInt64LE(136).toString(),
    expiration: Number(expiration),
    ...(routed
      ? { router: new PublicKey(body.subarray(152, 184)).toBase58() }
      : {}),
  }
}

export const getGatewaySolanaVmTransferRequestHash = (
  request: GatewaySolanaVmTransferRequest
): string =>
  "0x" +
  Buffer.from(
    sha256
      .create()
      .update(encodeGatewaySolanaVmTransferRequest(request))
      .array()
  ).toString("hex")

export const gatewaySolanaVmDestinationCodec: GatewayDestinationWithdrawalCodec =
  {
    vmType: "solana-vm",
    matches: (spec) =>
      spec.destinationContract.toLowerCase() === SOLANA_VM_GATEWAY_MINTER,
    getId: (executionPayload) =>
      getGatewaySolanaVmTransferRequestHash(
        decodeGatewaySolanaVmTransferRequest(executionPayload)
      ),
    getRecipient: (executionPayload) =>
      decodeGatewaySolanaVmTransferRequest(executionPayload).recipient,
    getExpiration: (executionPayload) =>
      decodeGatewaySolanaVmTransferRequest(executionPayload).expiration,
  }
