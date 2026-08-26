import { Order } from "../../order"

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
