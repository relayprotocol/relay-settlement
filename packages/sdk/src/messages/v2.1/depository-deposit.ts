import { bytesToHex, hashStruct } from "viem"

import {
  ChainIdToVmType,
  encodeAddressToHex,
  encodeBytesToHex,
  encodeTransactionIdToHex,
  getChainVmType,
} from "../../utils"

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

export const getDepositoryDepositMessageId = (
  message: DepositoryDepositMessage,
  chainsConfig: ChainIdToVmType
) => {
  const vmType = (chainId: string) => getChainVmType(chainId, chainsConfig)

  return hashStruct({
    types: {
      DepositoryDeposit: [
        { name: "data", type: "Data" },
        { name: "result", type: "Result" },
      ],
      Data: [
        { name: "chainId", type: "string" },
        { name: "transactionId", type: "bytes" },
      ],
      Result: [
        { name: "onchainId", type: "bytes32" },
        { name: "depository", type: "bytes" },
        { name: "depositId", type: "bytes32" },
        { name: "depositor", type: "bytes" },
        { name: "currency", type: "bytes" },
        { name: "amount", type: "uint256" },
      ],
    },
    primaryType: "DepositoryDeposit",
    data: {
      data: {
        chainId: message.data.chainId,
        transactionId: encodeTransactionIdToHex(
          message.data.transactionId,
          vmType(message.data.chainId)
        ),
      },
      result: {
        onchainId: encodeBytesToHex(message.result.onchainId),
        depository: encodeAddressToHex(
          message.result.depository,
          vmType(message.data.chainId)
        ),
        depositId: encodeBytesToHex(message.result.depositId),
        depositor: encodeAddressToHex(
          message.result.depositor,
          vmType(message.data.chainId)
        ),
        currency: encodeAddressToHex(
          message.result.currency,
          vmType(message.data.chainId)
        ),
        amount: BigInt(message.result.amount),
      },
    },
  })
}
