// ABOUTME: Canonical codecs for routed ethereum-vm withdrawals: single Call values
// ABOUTME: and the versioned RoutedWithdrawalData payload.

import {
  Address,
  decodeAbiParameters,
  encodeAbiParameters,
  encodeFunctionData,
  Hex,
  keccak256,
  parseAbiParameters,
} from "viem"

// Mirrors `Call` in IMulticallRouter.sol
export type RoutedCall = {
  to: string
  data: string
  value: string
  allowFailure: boolean
}

// Mirrors `multicall` in IMulticallRouter.sol
export const multicallRouterAbi = [
  {
    type: "function",
    name: "multicall",
    stateMutability: "payable",
    inputs: [
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "to", type: "address" },
          { name: "data", type: "bytes" },
          { name: "value", type: "uint256" },
          { name: "allowFailure", type: "bool" },
        ],
      },
    ],
    outputs: [],
  },
] as const

// The bytes a routed withdrawal commits to
export const encodeRoutedCallsCalldata = (calls: RoutedCall[]): Hex => {
  // An empty bundle would leave the withdrawal sitting on the router
  if (calls.length === 0) {
    throw new Error("Routed withdrawal data requires at least one call")
  }

  return encodeFunctionData({
    abi: multicallRouterAbi,
    functionName: "multicall",
    args: [
      calls.map((call) => ({
        to: call.to as Address,
        data: call.data as Hex,
        value: BigInt(call.value),
        allowFailure: call.allowFailure,
      })),
    ],
  })
}

export const hashRoutedCalls = (calls: RoutedCall[]): Hex =>
  keccak256(encodeRoutedCallsCalldata(calls))

export const ROUTED_WITHDRAWAL_DATA_VERSION = 1

// Routed withdrawal data per the depository arbitrary calldata tech spec
export type RoutedWithdrawalData = {
  version: number
  router: string
  dataHash: string
}

export const routedWithdrawalDataAbiParams = parseAbiParameters([
  "(uint8 version, address router, bytes32 dataHash)",
])

// Zero marks a call as uncommitted, so it would resolve to keccak256("")
const ZERO_DATA_HASH =
  "0x0000000000000000000000000000000000000000000000000000000000000000"

export const encodeRoutedWithdrawalData = (data: RoutedWithdrawalData): Hex => {
  if (data.version !== ROUTED_WITHDRAWAL_DATA_VERSION) {
    throw new Error(`Unsupported routed withdrawal data version`)
  }
  if (data.dataHash.toLowerCase() === ZERO_DATA_HASH) {
    throw new Error("Routed withdrawal data requires a non-zero data hash")
  }

  return encodeAbiParameters(routedWithdrawalDataAbiParams, [
    {
      version: data.version,
      router: data.router as Address,
      dataHash: data.dataHash as Hex,
    },
  ])
}

export const decodeRoutedWithdrawalData = (
  data: string
): RoutedWithdrawalData => {
  let result
  try {
    ;[result] = decodeAbiParameters(routedWithdrawalDataAbiParams, data as Hex)
  } catch {
    throw new Error("Failed to decode routed withdrawal data")
  }

  if (result.version !== ROUTED_WITHDRAWAL_DATA_VERSION) {
    throw new Error(`Unsupported routed withdrawal data version`)
  }
  if (result.dataHash.toLowerCase() === ZERO_DATA_HASH) {
    throw new Error("Routed withdrawal data requires a non-zero data hash")
  }

  return {
    version: result.version,
    router: result.router.toLowerCase(),
    dataHash: result.dataHash.toLowerCase(),
  }
}
