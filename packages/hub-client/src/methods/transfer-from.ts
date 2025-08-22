import { ethers } from 'ethers'
import { HubClient, TransferFromParams, SubmitTxParams } from '../client'
import { generateAddress, generateTokenId } from '@relay-protocol/hub-utils'
import { Hub } from '@relay-protocol/abis'

export const transferFrom = async (
  params: TransferFromParams,
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
  // then, create the recipient address
  const recipient = generateAddress({
    address: params.recipientAddress,
    chainId: params.chainId,
  })

  const hubIface = new ethers.Interface(Hub)
  const data = hubIface.encodeFunctionData('transferFrom', [
    owner,
    recipient,
    tokenId,
    params.amount,
  ])

  return {
    data,
    value: 0n,
  }
}
