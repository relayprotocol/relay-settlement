import { Hex, encodeAbiParameters, parseAbiParameters, keccak256 } from "viem"

import { encodeAddressToHex, VmType } from "../../utils"

export interface WithdrawRequest {
  chainId: string // The chain id to withdraw on
  depository: string // Standard-encoded address of the depository on the withdrawal chain
  currency: string // Standard-encoded address of the currency to be withdrawn
  amount: string // The amount to withdraw
  spenderChainId: string // The chain id of the spender
  spender: string // Standard-encoded address of the spender
  receiver: string // Payload-builder custom-encoded address of the receiver of the withdrawn funds
  nonce: string // Nonce for replay protection
  data: string // Additional data
}

export type DenormalizedWithdrawRequest = Omit<WithdrawRequest, "data"> & {
  additionalData?: {}
}

export const getWithdrawRequestHash = (request: WithdrawRequest) => {
  const encoded = encodeAbiParameters(
    parseAbiParameters([
      "(string chainId, bytes depository, bytes currency, uint256 amount, string spenderChainId, bytes spender, bytes receiver, bytes data, bytes32 nonce)",
    ]),
    [
      {
        chainId: request.chainId,
        depository: request.depository as Hex,
        currency: request.currency as Hex,
        amount: BigInt(request.amount),
        spenderChainId: request.spenderChainId,
        spender: request.spender as Hex,
        receiver: request.receiver as Hex,
        data: request.data as Hex,
        nonce: request.nonce as Hex,
      },
    ]
  )

  return keccak256(encoded)
}

export function normalizeWithdrawRequest(
  request: DenormalizedWithdrawRequest & {
    vmType: VmType
    spenderVmType: VmType
  }
): WithdrawRequest {
  switch (request.vmType) {
    case "ethereum-vm": {
      return {
        chainId: request.chainId,
        depository: encodeAddressToHex(request.depository, request.vmType),
        currency: encodeAddressToHex(request.currency, request.vmType),
        amount: request.amount,
        spenderChainId: request.spenderChainId,
        spender: encodeAddressToHex(request.spender, request.spenderVmType),
        receiver: encodeAddressToHex(request.receiver, request.vmType),
        data: "0x",
        nonce: request.nonce,
      }
    }

    case "solana-vm": {
      return {
        chainId: request.chainId,
        depository: encodeAddressToHex(request.depository, request.vmType),
        currency: encodeAddressToHex(request.currency, request.vmType),
        amount: request.amount,
        spenderChainId: request.spenderChainId,
        spender: encodeAddressToHex(request.spender, request.spenderVmType),
        receiver: encodeAddressToHex(request.receiver, request.vmType),
        data: "0x",
        nonce: request.nonce,
      }
    }

    default: {
      throw new Error("Vm type not implemented normalizeWithdrawRequest")
    }
  }
}
