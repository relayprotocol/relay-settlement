export type DepositoryDepositMessage = {
  data: {
    chainId: string
    transactionId: string
  }
  result: {
    onchainId: string
    depository: string
    depositId: string
    depositor: string
    currency: string
    amount: string
  }
}
