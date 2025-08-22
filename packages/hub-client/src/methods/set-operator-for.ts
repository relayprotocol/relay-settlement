import { ethers } from 'ethers'
import { HubClient, SetOperatorForParams, SubmitTxParams } from '../client'
import { generateAddress } from '@relay-protocol/hub-utils'
import { Hub } from '@relay-protocol/abis'

export const setOperatorFor = async (
  params: SetOperatorForParams,
  _client: HubClient
): Promise<SubmitTxParams> => {
  // Create the owner address
  const owner = generateAddress({
    address: params.account,
    chainId: params.chainId,
  })
  // then, create the recipient address
  const operator = generateAddress({
    address: params.operatorAddress,
    chainId: params.chainId,
  })

  const hubIface = new ethers.Interface(Hub)
  const data = hubIface.encodeFunctionData('setOperatorFor', [
    owner,
    operator,
    params.approved,
  ])

  return {
    data,
    value: 0n,
  }
}
