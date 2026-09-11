import {
  Address,
  decodeAbiParameters,
  encodeAbiParameters,
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
        // Gross deposit amount; fees are charged on top of this amount
        amount: string
        // Fee calculator to call. Zero address skips fee calculation for this action.
        feeCalculator: string
        // Opaque fee calculator input.
        feeCalculatorData: string
        // Rate limiter to call; must be on the oracle's allowlist
        rateLimiter: string
        // Opaque rate limiter input.
        rateLimiterData: string
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
          "address feeCalculator",
          "bytes feeCalculatorData",
          "address rateLimiter",
          "bytes rateLimiterData",
        ]),
        [
          action.type,
          action.data.hubToAddress as `0x${string}`,
          action.data.hubTokenId,
          BigInt(action.data.amount),
          action.data.feeCalculator as `0x${string}`,
          action.data.feeCalculatorData as `0x${string}`,
          action.data.rateLimiter as `0x${string}`,
          action.data.rateLimiterData as `0x${string}`,
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
          "address feeCalculator",
          "bytes feeCalculatorData",
          "address rateLimiter",
          "bytes rateLimiterData",
        ]),
        action as Hex
      )

      return {
        type: ActionType.FAST_MINT,
        data: {
          hubToAddress: result[1].toString(),
          hubTokenId: result[2],
          amount: result[3].toString(),
          feeCalculator: result[4].toString(),
          feeCalculatorData: result[5],
          rateLimiter: result[6].toString(),
          rateLimiterData: result[7],
        },
      }
    }

    default: {
      throw new Error("Unsupported action type")
    }
  }
}
