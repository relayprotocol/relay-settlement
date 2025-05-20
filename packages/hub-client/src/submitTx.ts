import { HubClient, SubmitTxParams } from './client'

export const submitTx = async (
  { from, data, value, opts }: SubmitTxParams,
  client: HubClient
) => {
  console.log('Submitting transaction')
  console.log('to:', client.address)
  console.log('chainId:', client.chainId)
  console.log('from:', from)
  console.log('data:', data)
  console.log('value:', value)
  console.log('opts:', opts)
  return 'txHash'
}
