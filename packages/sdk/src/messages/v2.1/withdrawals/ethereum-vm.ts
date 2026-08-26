import {
  Address,
  concat,
  decodeAbiParameters,
  encodeAbiParameters,
  Hex,
  keccak256,
  parseAbiParameters,
  stringToHex,
} from "viem"

import { getVmTypeNativeCurrency } from "../../../utils"
import { defineAbiWithdrawalCodec, WithdrawalCodec } from "./codec"

export type DecodedEthereumVmWithdrawal = {
  vmType: "ethereum-vm"
  withdrawal: {
    calls: {
      to: string
      data: string
      // Commitment to `data`, zero when the calldata itself is supplied
      dataHash: string
      value: string
      allowFailure: boolean
    }[]
    nonce: string
    expiration: number
  }
}

// The committed CallRequest payload the ethereum-vm payload builder emits.
export type CommittedCallRequestWithdrawal =
  DecodedEthereumVmWithdrawal["withdrawal"]

// The executable CallRequest the depository consumes, i.e. without commitments.
// Also the payload shape tron-vm and the gateway destination builders emit.
export type CallRequestWithdrawal = {
  calls: {
    to: string
    data: string
    value: string
    allowFailure: boolean
  }[]
  nonce: string
  expiration: number
}

// Mirrors `CallRequest` in RelayDepository.sol / TronVmPayloadBuilder.sol.
export const callRequestAbiParams = parseAbiParameters([
  "((address to, bytes data, uint256 value, bool allowFailure)[] calls, uint256 nonce, uint256 expiration)",
])

// Mirrors `CallRequest` in EthereumVmPayloadBuilder.sol, whose `Call` carries the commitment.
export const committedCallRequestAbiParams = parseAbiParameters([
  "((address to, bytes data, bytes32 dataHash, uint256 value, bool allowFailure)[] calls, uint256 nonce, uint256 expiration)",
])

const ZERO_DATA_HASH =
  "0x0000000000000000000000000000000000000000000000000000000000000000"

// Shared with tron-vm: the withdrawal transfer is always `calls[0]`, either native
// (empty calldata) or an ERC20/TRC20 `transfer`. Routed payloads append a second call.

type TransferCallRequest = {
  calls: { to: string; data: string; value: string }[]
}

export const getCallRequestCurrency = (
  withdrawal: TransferCallRequest,
  vmType: "ethereum-vm" | "tron-vm"
): string => {
  const firstCall = withdrawal.calls[0]
  return firstCall.data === "0x"
    ? getVmTypeNativeCurrency(vmType)
    : firstCall.to
}

const decodeERC20TransferParams = (data: string) => {
  // ERC20 / TRC20 `transfer(address,uint256)` selector is 0xa9059cbb
  const TRANSFER_SELECTOR = "0xa9059cbb"
  if (data.toLowerCase().startsWith(TRANSFER_SELECTOR.toLowerCase())) {
    const paramsData = ("0x" + data.slice(TRANSFER_SELECTOR.length)) as Hex
    const params = decodeAbiParameters(
      parseAbiParameters(["address", "uint256"]),
      paramsData
    )
    return params
  } else {
    throw new Error(`Unsupported function call data: ${data}`)
  }
}

export const getCallRequestAmount = (
  withdrawal: TransferCallRequest
): string => {
  const firstCall = withdrawal.calls[0]
  if (firstCall.data === "0x") {
    return firstCall.value
  } else {
    const [, amount] = decodeERC20TransferParams(firstCall.data)
    return amount.toString()
  }
}

export const getCallRequestRecipient = (
  withdrawal: TransferCallRequest
): string => {
  const firstCall = withdrawal.calls[0]
  if (firstCall.data === "0x") {
    return firstCall.to
  } else {
    const [to] = decodeERC20TransferParams(firstCall.data)
    return to
  }
}

// As declared by RelayDepository.sol: the `Call` type has no `dataHash` member
const CALL_TYPEHASH = keccak256(
  stringToHex("Call(address to,bytes data,uint256 value,bool allowFailure)")
)
const CALL_REQUEST_TYPEHASH = keccak256(
  stringToHex(
    "CallRequest(Call[] calls,uint256 nonce,uint256 expiration)Call(address to,bytes data,uint256 value,bool allowFailure)"
  )
)

// Mirrors `hashCallRequest` in EthereumVmPayloadBuilder.sol; `hashStruct` cannot express
// substituting `dataHash` for `keccak256(data)`
export const getCommittedCallRequestId = (
  withdrawal: CommittedCallRequestWithdrawal
): string => {
  const callHashes = withdrawal.calls.map((call) => {
    if (call.dataHash !== ZERO_DATA_HASH && call.data !== "0x") {
      throw new Error("Call carries both calldata and a commitment to it")
    }
    const dataHash =
      call.dataHash === ZERO_DATA_HASH
        ? keccak256(call.data as Hex)
        : (call.dataHash as Hex)

    return keccak256(
      encodeAbiParameters(
        parseAbiParameters(["bytes32, address, bytes32, uint256, bool"]),
        [
          CALL_TYPEHASH,
          call.to as Address,
          dataHash,
          BigInt(call.value),
          call.allowFailure,
        ]
      )
    )
  })

  return keccak256(
    encodeAbiParameters(
      parseAbiParameters(["bytes32, bytes32, uint256, uint256"]),
      [
        CALL_REQUEST_TYPEHASH,
        keccak256(concat(callHashes)),
        BigInt(withdrawal.nonce),
        BigInt(withdrawal.expiration),
      ]
    )
  )
}

// Produces the request `execute` consumes: drops the commitment column and substitutes the
// preimage where a call carries one. Only a routed payload needs `calldata`.
export const toExecutableCallRequest = (
  withdrawal: CommittedCallRequestWithdrawal,
  calldata?: string
): CallRequestWithdrawal => {
  const committedIndexes = withdrawal.calls
    .map((call, index) => (call.dataHash === ZERO_DATA_HASH ? -1 : index))
    .filter((index) => index !== -1)
  if (committedIndexes.length > 1) {
    throw new Error(
      `Expected at most one committed call, found ${committedIndexes.length}`
    )
  }

  const committedIndex = committedIndexes[0]
  if (
    committedIndex !== undefined &&
    withdrawal.calls[committedIndex].data !== "0x"
  ) {
    throw new Error("Call carries both calldata and a commitment to it")
  }
  if (committedIndex === undefined) {
    if (calldata !== undefined) {
      throw new Error("Calldata supplied for a request with no committed call")
    }
  } else {
    if (calldata === undefined) {
      throw new Error("Missing calldata for the committed call")
    }
    if (
      keccak256(calldata as Hex).toLowerCase() !==
      withdrawal.calls[committedIndex].dataHash.toLowerCase()
    ) {
      throw new Error("Calldata does not match the call commitment")
    }
  }

  return {
    calls: withdrawal.calls.map((call, index) => ({
      to: call.to,
      data:
        index === committedIndex
          ? (calldata as string).toLowerCase()
          : call.data,
      value: call.value,
      allowFailure: call.allowFailure,
    })),
    nonce: withdrawal.nonce,
    expiration: withdrawal.expiration,
  }
}

const abiCodec = defineAbiWithdrawalCodec({
  params: committedCallRequestAbiParams,
  toAbi: (withdrawal: CommittedCallRequestWithdrawal) => [
    {
      calls: withdrawal.calls.map((call) => ({
        to: call.to as Address,
        data: call.data as Hex,
        dataHash: call.dataHash as Hex,
        value: BigInt(call.value),
        allowFailure: call.allowFailure,
      })),
      nonce: BigInt(withdrawal.nonce),
      expiration: BigInt(withdrawal.expiration),
    },
  ],
  fromAbi: ([result]) => ({
    calls: result.calls.map((call) => ({
      to: call.to.toLowerCase(),
      data: call.data.toLowerCase(),
      dataHash: call.dataHash.toLowerCase(),
      value: call.value.toString(),
      allowFailure: call.allowFailure,
    })),
    nonce: result.nonce.toString(),
    expiration: Number(result.expiration.toString()),
  }),
})

// The 4-member payload, still emitted by builders without the commitment column
const legacyAbiCodec = defineAbiWithdrawalCodec({
  params: callRequestAbiParams,
  toAbi: (withdrawal: CallRequestWithdrawal) => [
    {
      calls: withdrawal.calls.map((call) => ({
        to: call.to as Address,
        data: call.data as Hex,
        value: BigInt(call.value),
        allowFailure: call.allowFailure,
      })),
      nonce: BigInt(withdrawal.nonce),
      expiration: BigInt(withdrawal.expiration),
    },
  ],
  fromAbi: ([result]) => ({
    calls: result.calls.map((call) => ({
      to: call.to.toLowerCase(),
      data: call.data.toLowerCase(),
      value: call.value.toString(),
      allowFailure: call.allowFailure,
    })),
    nonce: result.nonce.toString(),
    expiration: Number(result.expiration.toString()),
  }),
})

// Neither shape can be told from the other by decoding alone, so a candidate only
// counts if it re-encodes to its own input
const decodeUnderSchema = <W>(
  codec: { encode: (w: W) => string; decode: (encoded: string) => W },
  encodedWithdrawal: string
): W | undefined => {
  try {
    const withdrawal = codec.decode(encodedWithdrawal)
    return codec.encode(withdrawal).toLowerCase() ===
      encodedWithdrawal.toLowerCase()
      ? withdrawal
      : undefined
  } catch {
    return undefined
  }
}

export const ethereumVmCodec: WithdrawalCodec<CommittedCallRequestWithdrawal> =
  {
    ...abiCodec,

    decode: (encodedWithdrawal) => {
      const committed = decodeUnderSchema(abiCodec, encodedWithdrawal)
      if (committed) {
        return committed
      }

      // An uncommitted call hashes identically either way, so the id is preserved
      const legacy = decodeUnderSchema(legacyAbiCodec, encodedWithdrawal)
      if (legacy) {
        return {
          ...legacy,
          calls: legacy.calls.map((call) => ({
            ...call,
            dataHash: ZERO_DATA_HASH,
          })),
        }
      }

      throw new Error("Failed to decode ethereum-vm CallRequest")
    },

    getId: getCommittedCallRequestId,

    getCurrency: (withdrawal) =>
      getCallRequestCurrency(withdrawal, "ethereum-vm"),
    getAmount: getCallRequestAmount,
    getRecipient: getCallRequestRecipient,
  }
