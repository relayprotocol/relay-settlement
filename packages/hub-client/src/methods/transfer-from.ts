import { RelayHub } from "@relay-protocol/abis"
import { generateAddress, generateTokenId } from "@relay-protocol/hub-utils"
import { ethers } from "ethers"
import { SubmitTxParams, TransferFromParams } from "../client"

export const transferFrom = async (
  params: TransferFromParams
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
    family: params.family,
  })
  // then, create the recipient address
  const recipient = generateAddress({
    address: params.recipientAddress,
    chainId: params.chainId,
    family: params.family,
  })

  const hubIface = new ethers.Interface(RelayHub)
  const data = hubIface.encodeFunctionData("transferFrom", [
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
