import { RelayHub } from "@relay-settlement/abis"
import {
  generateAddress,
  generateTokenId,
} from "@relay-protocol/settlement-sdk"
import { ethers } from "ethers"
import { BurnParams, SubmitTxParams } from "../client"

export const burn = async (params: BurnParams): Promise<SubmitTxParams> => {
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

  const hubIface = new ethers.Interface(RelayHub)
  const data = hubIface.encodeFunctionData("burn", [
    owner,
    tokenId,
    params.amount,
  ])

  return {
    data,
    value: 0n,
  }
}
