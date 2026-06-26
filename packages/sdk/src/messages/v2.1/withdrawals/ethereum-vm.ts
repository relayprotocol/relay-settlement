import { Address, hashStruct, Hex, parseAbiParameters } from "viem"

import { getVmTypeNativeCurrency } from "../../../utils"
import {
  decodeERC20TransferParams,
  defineAbiWithdrawalCodec,
  WithdrawalCodec,
} from "./codec"

export type DecodedEthereumVmWithdrawal = {
  vmType: "ethereum-vm"
  withdrawal: {
    calls: {
      to: string
      data: string
      value: string
      allowFailure: boolean
    }[]
    nonce: string
    expiration: number
  }
}

// The CallRequest payload shape, shared byte-for-byte with tron-vm.
export type CallRequestWithdrawal = DecodedEthereumVmWithdrawal["withdrawal"]

// Mirrors `CallRequest` in EthereumVmPayloadBuilder.sol / RelayDepository.sol.
export const callRequestAbiParams = parseAbiParameters([
  "((address to, bytes data, uint256 value, bool allowFailure)[] calls, uint256 nonce, uint256 expiration)",
])

// Currency / amount / recipient extraction shared by ethereum-vm and tron-vm:
// a CallRequest is either a single native transfer (empty calldata) or a
// single ERC20/TRC20 `transfer(address,uint256)` call.

export const getCallRequestCurrency = (
  withdrawal: CallRequestWithdrawal,
  vmType: "ethereum-vm" | "tron-vm"
): string => {
  const firstCall = withdrawal.calls[0]
  return firstCall.data === "0x"
    ? getVmTypeNativeCurrency(vmType)
    : firstCall.to
}

export const getCallRequestAmount = (
  withdrawal: CallRequestWithdrawal
): string => {
  const firstCall = withdrawal.calls[0]
  if (firstCall.data === "0x") {
    return firstCall.value
  } else {
    const [, amount] = decodeERC20TransferParams(firstCall.data)
    return amount.toString()
  }
}

export const getCallRequestRecipient = (
  withdrawal: CallRequestWithdrawal
): string => {
  const firstCall = withdrawal.calls[0]
  if (firstCall.data === "0x") {
    return firstCall.to
  } else {
    const [to] = decodeERC20TransferParams(firstCall.data)
    return to
  }
}

export const ethereumVmCodec: WithdrawalCodec<CallRequestWithdrawal> = {
  ...defineAbiWithdrawalCodec({
    params: callRequestAbiParams,
    toAbi: (withdrawal: CallRequestWithdrawal) => [
      {
        calls: withdrawal.calls.map((call) => ({
          to: call.to as Address,
          data: call.data as Hex,
          value: BigInt(call.value),
          allowFailure: call.allowFailure,
        })),
        nonce: BigInt(withdrawal.nonce),
        expiration: BigInt(withdrawal.expiration),
      },
    ],
    fromAbi: ([result]) => ({
      calls: result.calls.map((call) => ({
        to: call.to.toLowerCase(),
        data: call.data.toLowerCase(),
        value: call.value.toString(),
        allowFailure: call.allowFailure,
      })),
      nonce: result.nonce.toString(),
      expiration: Number(result.expiration.toString()),
    }),
  }),

  getId: (withdrawal) =>
    hashStruct({
      types: {
        CallRequest: [
          { name: "calls", type: "Call[]" },
          { name: "nonce", type: "uint256" },
          { name: "expiration", type: "uint256" },
        ],
        Call: [
          { name: "to", type: "address" },
          { name: "data", type: "bytes" },
          { name: "value", type: "uint256" },
          { name: "allowFailure", type: "bool" },
        ],
      },
      primaryType: "CallRequest",
      data: {
        calls: withdrawal.calls.map((c) => ({
          to: c.to as Hex,
          data: c.data as Hex,
          value: BigInt(c.value),
          allowFailure: c.allowFailure,
        })),
        nonce: BigInt(withdrawal.nonce),
        expiration: BigInt(withdrawal.expiration),
      },
    }),

  getCurrency: (withdrawal) =>
    getCallRequestCurrency(withdrawal, "ethereum-vm"),
  getAmount: getCallRequestAmount,
  getRecipient: getCallRequestRecipient,
}
