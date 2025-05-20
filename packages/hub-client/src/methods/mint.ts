import { ethers } from 'ethers'
import { HubClient, MintParams, SubmitTxParams } from '../client'
import { submitTx } from '../submitTx'
import { generateAddress, generateTokenId } from '@relay-protocol/hub-utils'
import { Hub } from '@relay-protocol/hub-abis'

export const mint = async (
  params: MintParams,
  client: HubClient
): Promise<string> => {
  const tx = await prepareMintTx(params, client)
  return submitTx(tx, client)
}

export const prepareMintTx = async (
  params: MintParams,
  _client: HubClient
): Promise<SubmitTxParams> => {
  // First, create a tokenId param
  const tokenId = generateTokenId({
    address: params.tokenAddress,
    chainId: params.chaindId,
    family: params.family,
  })
  // then, create the owner address
  const owner = generateAddress({
    address: params.account,
    chainId: params.chaindId,
    family: params.family,
  })

  const hubIface = new ethers.Interface(Hub)
  const data = hubIface.encodeFunctionData('mint', [
    owner,
    tokenId,
    params.amount,
  ])

  return {
    data,
    value: 0n,
  }
}
