import HubClient from './client'

// Mostly copied from ethers.js
export interface SubmitTxParamsOpts {
  gasPrice?: string
  maxFeePerBlobGas?: string
  maxPriorityFeePerGas?: string
  gasLimit?: string
  maxFeePerGas?: string
  nonce?: string
}
export interface SubmitTxParams {
  chainId: string
  to: string
  from?: string
  data: string
  value?: string
  opts?: SubmitTxParamsOpts
}

export const submitTx = async ({
  chainId,
  to,
  from,
  data,
  value,
  opts,
}: SubmitTxParams) => {
  console.log('Submitting transaction')
  console.log('to:', to)
  console.log('chainId:', chainId)
  console.log('from:', from)
  console.log('data:', data)
  console.log('value:', value)
  console.log('opts:', opts)
  return 'txHash'
}

HubClient.prototype.submitTx = submitTx
