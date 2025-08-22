import { ethers } from 'ethers'
import { HubClient, BurnParams, SubmitTxParams } from '../client'
import { generateAddress, generateTokenId } from '@relay-protocol/hub-utils'
import { Hub } from '@relay-protocol/abis'

export const burn = async (
  params: BurnParams,
  _client: HubClient
): Promise<SubmitTxParams> => {
  // First, create a tokenId param
  const tokenId = generateTokenId({
    address: params.tokenAddress,
    chainId: params.chainId,
    family: params.family,
  })
  // then, create the owner address
  const owner = generateAddress({
    address: params.account,
    chainId: params.chainId,
  })

  const hubIface = new ethers.Interface(Hub)
  const data = hubIface.encodeFunctionData('burn', [
    owner,
    tokenId,
    params.amount,
  ])

  return {
    data,
    value: 0n,
  }
}
