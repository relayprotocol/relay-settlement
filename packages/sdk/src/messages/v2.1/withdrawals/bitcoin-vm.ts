import * as bitcoin from "bitcoinjs-lib"
import { sha256 } from "js-sha256"

import { getVmTypeNativeCurrency } from "../../../utils"
import { WithdrawalCodec } from "./codec"

export type DecodedBitcoinVmWithdrawal = {
  vmType: "bitcoin-vm"
  withdrawal: {
    psbt: string
  }
}

type Withdrawal = DecodedBitcoinVmWithdrawal["withdrawal"]

export const bitcoinVmCodec: WithdrawalCodec<Withdrawal> = {
  encode: (withdrawal) => "0x" + withdrawal.psbt,

  decode: (encodedWithdrawal) => ({
    psbt: encodedWithdrawal.slice(2),
  }),

  // Hashes the 0x-prefixed hex string (not the raw PSBT bytes).
  getId: (withdrawal) =>
    "0x" +
    sha256
      .create()
      .update("0x" + withdrawal.psbt)
      .hex(),

  getCurrency: () => getVmTypeNativeCurrency("bitcoin-vm"),

  getAmount: (withdrawal) => {
    const psbt = bitcoin.Psbt.fromHex(withdrawal.psbt)
    const fee = psbt.finalizeAllInputs().getFee()
    return (psbt.txOutputs[0].value + fee).toString()
  },

  getRecipient: (withdrawal) => {
    const psbt = bitcoin.Psbt.fromHex(withdrawal.psbt)
    const firstOutput = psbt.txOutputs[0]
    return bitcoin.address.fromOutputScript(firstOutput.script)
  },
}
