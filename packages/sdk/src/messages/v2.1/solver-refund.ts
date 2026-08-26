import { Order } from "../../order"

export enum SolverRefundStatus {
  FAILED = 0,
  SUCCESSFUL = 1,
}

export type SolverRefundMessage = {
  data: {
    order: Order
    orderSignature: string
    inputs: {
      transactionId: string
      onchainId: string
      inputIndex: number
    }[]
    refunds: {
      transactionId: string
      inputIndex: number
      refundIndex: number
    }[]
  }
  result: {
    orderId: string
    status: SolverRefundStatus
    totalWeightedInputPaymentBpsDiff: string
  }
}
