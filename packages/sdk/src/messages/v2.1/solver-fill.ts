import { bytesToHex, hashStruct } from "viem"

import { normalizeOrder, Order, ORDER_EIP712_TYPES } from "../../order"
import {
  ChainIdToVmType,
  encodeBytesToHex,
  encodeTransactionIdToHex,
  getChainVmType,
} from "../../utils"

export enum SolverFillStatus {
  FAILED = 0,
  SUCCESSFUL = 1,
}

export type SolverFillMessage = {
  data: {
    order: Order
    orderSignature: string
    inputs: {
      transactionId: string
      onchainId: string
      inputIndex: number
    }[]
    fill: {
      transactionId: string
    }
  }
  result: {
    orderId: string
    status: SolverFillStatus
    totalWeightedInputPaymentBpsDiff: string
  }
}

export const getSolverFillMessageId = (
  message: SolverFillMessage,
  chainsConfig: ChainIdToVmType
) => {
  const vmType = (chainId: string) => getChainVmType(chainId, chainsConfig)

  return hashStruct({
    types: {
      SolverFill: [
        { name: "data", type: "Data" },
        { name: "result", type: "Result" },
      ],
      Data: [
        { name: "order", type: "Order" },
        { name: "orderSignature", type: "bytes" },
        { name: "inputs", type: "InputEntry[]" },
        { name: "fill", type: "FillEntry" },
      ],
      Result: [
        { name: "orderId", type: "bytes32" },
        { name: "status", type: "uint8" },
        { name: "totalWeightedInputPaymentBpsDiff", type: "int256" },
      ],
      ...ORDER_EIP712_TYPES,
      InputEntry: [
        { name: "transactionId", type: "bytes" },
        { name: "onchainId", type: "bytes32" },
        { name: "inputIndex", type: "uint32" },
      ],
      FillEntry: [{ name: "transactionId", type: "bytes" }],
    },
    primaryType: "SolverFill",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: {
      data: {
        order: normalizeOrder(message.data.order, chainsConfig),
        orderSignature: encodeBytesToHex(message.data.orderSignature),
        inputs: message.data.inputs.map((input) => ({
          transactionId: encodeTransactionIdToHex(
            input.transactionId,
            vmType(message.data.order.inputs[input.inputIndex].payment.chainId)
          ),
          onchainId: encodeBytesToHex(input.onchainId),
          inputIndex: input.inputIndex,
        })),
        fill: {
          transactionId: encodeTransactionIdToHex(
            message.data.fill.transactionId,
            vmType(message.data.order.output.chainId)
          ),
        },
      },
      result: {
        orderId: encodeBytesToHex(message.result.orderId),
        status: message.result.status,
        totalWeightedInputPaymentBpsDiff: BigInt(
          message.result.totalWeightedInputPaymentBpsDiff
        ),
      },
    } as any,
  })
}
