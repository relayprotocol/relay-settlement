import * as anchor from "@coral-xyz/anchor"
import { BorshCoder, Idl } from "@coral-xyz/anchor"
import { PublicKey, SystemProgram } from "@solana/web3.js"
import { sha256 } from "js-sha256"

import { RelayDepositoryIdl } from "../../common/solana-vm/idls/RelayDepositoryIdl"
import { WithdrawalCodec } from "./codec"

export type DecodedSolanaVmWithdrawal = {
  vmType: "solana-vm"
  withdrawal: {
    domain: string
    recipient: string
    token: string
    amount: string
    nonce: string
    expiration: number
    vaultAddress: string
  }
}

type Withdrawal = DecodedSolanaVmWithdrawal["withdrawal"]

const coder = new BorshCoder(RelayDepositoryIdl as Idl)

const encodeTransferRequest = (withdrawal: Withdrawal): Buffer =>
  coder.types.encode("TransferRequest", {
    domain: Buffer.from(withdrawal.domain.slice(2), "hex"),
    recipient: new PublicKey(withdrawal.recipient),
    token:
      withdrawal.token === SystemProgram.programId.toBase58()
        ? null
        : new PublicKey(withdrawal.token),
    amount: new anchor.BN(withdrawal.amount),
    nonce: new anchor.BN(withdrawal.nonce),
    expiration: new anchor.BN(withdrawal.expiration),
    vault_address: new PublicKey(withdrawal.vaultAddress),
  })

export const solanaVmCodec: WithdrawalCodec<Withdrawal> = {
  encode: (withdrawal) =>
    "0x" + encodeTransferRequest(withdrawal).toString("hex"),

  decode: (encodedWithdrawal) => {
    const buffer = Buffer.from(encodedWithdrawal.substring(2), "hex")

    const request = coder.types.decode("TransferRequest", buffer)

    return {
      domain: "0x" + Buffer.from(request.domain).toString("hex"),
      recipient: request.recipient.toBase58(),
      token: request.token
        ? request.token.toBase58()
        : SystemProgram.programId.toBase58(),
      amount: request.amount.toString(),
      nonce: request.nonce.toString(),
      expiration: request.expiration.toNumber(),
      vaultAddress: request.vault_address.toBase58(),
    }
  },

  getId: (withdrawal) =>
    "0x" +
    Buffer.from(
      sha256.create().update(encodeTransferRequest(withdrawal)).array()
    ).toString("hex"),

  getCurrency: (withdrawal) => withdrawal.token,
  getAmount: (withdrawal) => withdrawal.amount,
  getRecipient: (withdrawal) => withdrawal.recipient,
}
