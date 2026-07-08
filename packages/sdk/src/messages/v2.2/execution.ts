import {
  Address,
  decodeAbiParameters,
  encodeAbiParameters,
  hashStruct,
  Hex,
  parseAbiParameters,
} from "viem"

import { VmType } from "../../utils"

export enum ActionType {
  MINT,
  BURN,
  TRANSFER,
  FAST_MINT,
}

export type ExecutionMessageMetadata = {
  hubTokenId: bigint
  origin: {
    address: string
    chainId: string
    family: VmType
  }
  oracleChainId: string
  oracleContract: Address
}

export type ExecutionMessage = {
  idempotencyKey: string
  actions: string[]
  metadata?: ExecutionMessageMetadata[]
}

export type ExecutionMetadata = Omit<
  ExecutionMessageMetadata,
  "oracleContract" | "oracleChainId"
>

export const getExecutionMessageId = (message: ExecutionMessage) => {
  return hashStruct({
    types: {
      Execution: [
        { name: "idempotencyKey", type: "bytes32" },
        { name: "actions", type: "bytes[]" },
      ],
    },
    primaryType: "Execution",
    data: {
      idempotencyKey: message.idempotencyKey as Hex,
      actions: message.actions as Hex[],
    },
  })
}

export type DecodedAction =
  | {
      type: ActionType.MINT
      data: {
        hubToAddress: string
        hubTokenId: bigint
        amount: string
      }
    }
  | {
      type: ActionType.BURN
      data: {
        hubFromAddress: string
        hubTokenId: bigint
        amount: string
      }
    }
  | {
      type: ActionType.TRANSFER
      data: {
        hubFromAddress: string
        hubToAddress: string
        hubTokenId: bigint
        amount: string
      }
    }
  | {
      type: ActionType.FAST_MINT
      data: {
        hubToAddress: string
        // Hub token id (both mint legs use it); same value MINT carries
        hubTokenId: bigint
        // Gross deposit amount; the contract splits it into the net amount (amount-fee) + fee
        amount: string
        // Fee as a 1e18-scaled fraction of amount (1% = 1e16); fee = amount * feeBps / 1e18
        feeBps: string
        feeRecipient: string
        // Rate limiter to call; must be on the oracle's allowlist
        limiter: string
        // Opaque limiter input; for RelayAmountRateLimiter use encodeAmountLimiterData()
        limiterData: string
      }
    }

export const encodeAction = (action: DecodedAction): string => {
  switch (action.type) {
    case ActionType.MINT: {
      return encodeAbiParameters(
        parseAbiParameters([
          "uint8 type",
          "address hubToAddress",
          "uint256 hubTokenId",
          "uint256 amount",
        ]),
        [
          action.type,
          action.data.hubToAddress as `0x${string}`,
          action.data.hubTokenId,
          BigInt(action.data.amount),
        ]
      )
    }

    case ActionType.BURN: {
      return encodeAbiParameters(
        parseAbiParameters([
          "uint8 type",
          "address hubFromAddress",
          "uint256 hubTokenId",
          "uint256 amount",
        ]),
        [
          action.type,
          action.data.hubFromAddress as `0x${string}`,
          action.data.hubTokenId,
          BigInt(action.data.amount),
        ]
      )
    }

    case ActionType.TRANSFER: {
      return encodeAbiParameters(
        parseAbiParameters([
          "uint8 type",
          "address hubFromAddress",
          "address hubToAddress",
          "uint256 hubTokenId",
          "uint256 amount",
        ]),
        [
          action.type,
          action.data.hubFromAddress as `0x${string}`,
          action.data.hubToAddress as `0x${string}`,
          action.data.hubTokenId,
          BigInt(action.data.amount),
        ]
      )
    }

    case ActionType.FAST_MINT: {
      return encodeAbiParameters(
        parseAbiParameters([
          "uint8 type",
          "address hubToAddress",
          "uint256 hubTokenId",
          "uint256 amount",
          "uint256 feeBps",
          "address feeRecipient",
          "address limiter",
          "bytes limiterData",
        ]),
        [
          action.type,
          action.data.hubToAddress as `0x${string}`,
          action.data.hubTokenId,
          BigInt(action.data.amount),
          BigInt(action.data.feeBps),
          action.data.feeRecipient as `0x${string}`,
          action.data.limiter as `0x${string}`,
          action.data.limiterData as `0x${string}`,
        ]
      )
    }

    default: {
      throw new Error("Unsupported action type")
    }
  }
}

export const decodeAction = (action: string): DecodedAction => {
  // decode just the uint8 type
  const [type] = decodeAbiParameters(
    parseAbiParameters(["uint8 type"]),
    action as Hex
  )

  switch (type) {
    case ActionType.MINT: {
      const result = decodeAbiParameters(
        parseAbiParameters([
          "uint8 type",
          "address hubToAddress",
          "uint256 hubTokenId",
          "uint256 amount",
        ]),
        action as Hex
      )

      return {
        type: ActionType.MINT,
        data: {
          hubToAddress: result[1].toString(),
          hubTokenId: result[2],
          amount: result[3].toString(),
        },
      }
    }

    case ActionType.BURN: {
      const result = decodeAbiParameters(
        parseAbiParameters([
          "uint8 type",
          "address hubFromAddress",
          "uint256 hubTokenId",
          "uint256 amount",
        ]),
        action as Hex
      )

      return {
        type: ActionType.BURN,
        data: {
          hubFromAddress: result[1].toString(),
          hubTokenId: result[2],
          amount: result[3].toString(),
        },
      }
    }

    case ActionType.TRANSFER: {
      const result = decodeAbiParameters(
        parseAbiParameters([
          "uint8 type",
          "address hubFromAddress",
          "address hubToAddress",
          "uint256 hubTokenId",
          "uint256 amount",
        ]),
        action as Hex
      )

      return {
        type: ActionType.TRANSFER,
        data: {
          hubFromAddress: result[1].toString(),
          hubToAddress: result[2].toString(),
          hubTokenId: result[3],
          amount: result[4].toString(),
        },
      }
    }

    case ActionType.FAST_MINT: {
      const result = decodeAbiParameters(
        parseAbiParameters([
          "uint8 type",
          "address hubToAddress",
          "uint256 hubTokenId",
          "uint256 amount",
          "uint256 feeBps",
          "address feeRecipient",
          "address limiter",
          "bytes limiterData",
        ]),
        action as Hex
      )

      return {
        type: ActionType.FAST_MINT,
        data: {
          hubToAddress: result[1].toString(),
          hubTokenId: result[2],
          amount: result[3].toString(),
          feeBps: result[4].toString(),
          feeRecipient: result[5].toString(),
          limiter: result[6].toString(),
          limiterData: result[7],
        },
      }
    }

    default: {
      throw new Error("Unsupported action type")
    }
  }
}

// Encodes the `data` blob for RelayAmountRateLimiter's consume(bytes) —
// abi.encode(string chainId, bytes currency, uint256 amount). The oracle and the limiter MUST agree
// on this layout; a roundtrip test pins it.
export const encodeAmountLimiterData = (
  chainId: string,
  currency: string,
  amount: string
): string =>
  encodeAbiParameters(
    parseAbiParameters(["string chainId", "bytes currency", "uint256 amount"]),
    [chainId, currency as `0x${string}`, BigInt(amount)]
  )
