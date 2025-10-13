import { RelayHub } from "@relay-protocol/abis"
import { generateAddress } from "@relay-protocol/hub-utils"
import { ethers } from "ethers"
import { SetOperatorForParams, SubmitTxParams } from "../client"

export const setOperatorFor = async (
  params: SetOperatorForParams
): Promise<SubmitTxParams> => {
  // Create the owner address
  const owner = generateAddress({
    address: params.account,
    chainId: params.chainId,
    family: params.family,
  })
  // then, create the recipient address
  const operator = generateAddress({
    address: params.operatorAddress,
    chainId: params.chainId,
    family: params.family,
  })

  const hubIface = new ethers.Interface(RelayHub)
  const data = hubIface.encodeFunctionData("setOperatorFor", [
    owner,
    operator,
    params.approved,
  ])

  return {
    data,
    value: 0n,
  }
}
