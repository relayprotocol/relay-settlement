import type { Command } from "commander"
import {
  Connection,
  PublicKey,
  SystemProgram,
  NONCE_ACCOUNT_LENGTH,
  Keypair,
  Transaction,
  sendAndConfirmTransaction,
  NonceAccount,
} from "@solana/web3.js"
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes"

export function registerCreateNonceAccount(program: Command) {
  program
    .command("create-nonce-account")
    .description("Create a durable nonce account for Solana transactions.")
    .requiredOption("--rpc <url>", "Solana RPC endpoint")
    .requiredOption(
      "--payer <secret>",
      "Base58 encoded private key of the payer account"
    )
    .option(
      "--authority <pubkey>",
      "Public key of the nonce authority (defaults to payer)"
    )
    .action(async ({ rpc, payer, authority }) => {
      const connection = new Connection(rpc, "confirmed")
      const payerKeypair = Keypair.fromSecretKey(bs58.decode(payer))
      const nonceAccount = Keypair.generate()
      const authorityPubkey = authority
        ? new PublicKey(authority)
        : payerKeypair.publicKey

      console.log("Creating nonce account...")
      console.log("Nonce Account:", nonceAccount.publicKey.toBase58())
      console.log("Authority:", authorityPubkey.toBase58())
      console.log("Payer:", payerKeypair.publicKey.toBase58())
      console.log(
        "Payer Balance:",
        await connection.getBalance(payerKeypair.publicKey)
      )

      const rentExemptAmount =
        await connection.getMinimumBalanceForRentExemption(NONCE_ACCOUNT_LENGTH)

      const transaction = new Transaction()

      transaction.add(
        SystemProgram.createAccount({
          fromPubkey: payerKeypair.publicKey,
          lamports: rentExemptAmount,
          newAccountPubkey: nonceAccount.publicKey,
          programId: SystemProgram.programId,
          space: NONCE_ACCOUNT_LENGTH,
        })
      )

      transaction.add(
        SystemProgram.nonceInitialize({
          authorizedPubkey: authorityPubkey,
          noncePubkey: nonceAccount.publicKey,
        })
      )

      const signature = await sendAndConfirmTransaction(
        connection,
        transaction,
        [payerKeypair, nonceAccount],
        { commitment: "confirmed" }
      )

      console.log("✅ Nonce account created successfully!")
      console.log("Transaction signature:", signature)
      console.log("Nonce account address:", nonceAccount.publicKey.toBase58())
      console.log("Authority:", authorityPubkey.toBase58())
      console.log("Rent exempt amount:", rentExemptAmount, "lamports")

      const accountInfo = await connection.getAccountInfo(
        nonceAccount.publicKey
      )
      if (accountInfo) {
        console.log("✅ Nonce account verified on-chain")
        const nonceAccountData = NonceAccount.fromAccountData(accountInfo.data)
        console.log("Current nonce value:", nonceAccountData.nonce)
        console.log("Authority:", nonceAccountData.authorizedPubkey.toBase58())
        console.log(
          "Fee calculator lamports per signature:",
          nonceAccountData.feeCalculator.lamportsPerSignature
        )
      } else {
        console.error("❌ Failed to verify nonce account")
      }
    })
}
