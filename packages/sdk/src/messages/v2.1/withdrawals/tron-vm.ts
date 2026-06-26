import * as tronweb from "tronweb"
import { Address, Hex } from "viem"

import { defineAbiWithdrawalCodec, WithdrawalCodec } from "./codec"
import {
  callRequestAbiParams,
  CallRequestWithdrawal,
  getCallRequestAmount,
  getCallRequestCurrency,
  getCallRequestRecipient,
} from "./ethereum-vm"

export type DecodedTronVmWithdrawal = {
  vmType: "tron-vm"
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

// Same CallRequest ABI layout as ethereum-vm; only the address representation
// differs (`41`-prefixed hex instead of `0x`-prefixed).
export const tronVmCodec: WithdrawalCodec<CallRequestWithdrawal> = {
  ...defineAbiWithdrawalCodec({
    params: callRequestAbiParams,
    toAbi: (withdrawal: CallRequestWithdrawal) => [
      {
        calls: withdrawal.calls.map((call) => ({
          to: call.to.replace(
            tronweb.utils.address.ADDRESS_PREFIX_REGEX,
            "0x"
          ) as Address,
          data: call.data as Hex,
          value: BigInt(call.value),
          allowFailure: Boolean(call.allowFailure),
        })),
        nonce: BigInt(withdrawal.nonce),
        expiration: BigInt(withdrawal.expiration),
      },
    ],
    fromAbi: ([result]) => ({
      calls: result.calls.map((call) => ({
        to: call.to
          .toLowerCase()
          .replace("0x", tronweb.utils.address.ADDRESS_PREFIX),
        data: call.data.toLowerCase(),
        value: call.value.toString(),
        allowFailure: Boolean(call.allowFailure),
      })),
      nonce: result.nonce.toString(),
      expiration: Number(result.expiration.toString()),
    }),
  }),

  getId: (withdrawal) =>
    tronweb.utils._TypedDataEncoder.hashStruct(
      "CallRequest",
      {
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
      {
        calls: withdrawal.calls,
        nonce: withdrawal.nonce,
        expiration: withdrawal.expiration,
      }
    ),

  getCurrency: (withdrawal) => getCallRequestCurrency(withdrawal, "tron-vm"),
  getAmount: getCallRequestAmount,
  getRecipient: getCallRequestRecipient,
}
