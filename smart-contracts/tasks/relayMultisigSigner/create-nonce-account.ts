import { task } from "hardhat/config"
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

task(
  "relay-multisig-signer:solana-create-nonce-account",
  "Create a durable nonce account for Solana transactions"
)
  .addParam("rpc", "Solana RPC endpoint")
  .addParam("payer", "Base58 encoded private key of the payer account")
  .addOptionalParam(
    "authority",
    "Public key of the nonce authority (defaults to payer)"
  )
  .setAction(async ({ rpc, payer, authority }) => {
    const connection = new Connection(rpc, "confirmed")

    // Parse payer keypair
    const payerKeypair = Keypair.fromSecretKey(bs58.decode(payer))

    // Generate new nonce account
    const nonceAccount = Keypair.generate()

    // Authority defaults to payer if not specified
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

    // Calculate minimum rent for nonce account
    const rentExemptAmount =
      await connection.getMinimumBalanceForRentExemption(NONCE_ACCOUNT_LENGTH)

    // Create transaction to create and initialize nonce account
    const transaction = new Transaction()

    // Create account instruction
    transaction.add(
      SystemProgram.createAccount({
        fromPubkey: payerKeypair.publicKey,
        lamports: rentExemptAmount,
        newAccountPubkey: nonceAccount.publicKey,
        programId: SystemProgram.programId,
        space: NONCE_ACCOUNT_LENGTH,
      })
    )

    // Initialize nonce account instruction
    transaction.add(
      SystemProgram.nonceInitialize({
        authorizedPubkey: authorityPubkey,
        noncePubkey: nonceAccount.publicKey,
      })
    )

    // Send and confirm transaction
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

    // Verify nonce account was created
    const accountInfo = await connection.getAccountInfo(nonceAccount.publicKey)
    if (accountInfo) {
      console.log("✅ Nonce account verified on-chain")

      // Parse and display nonce account data
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

    return {
      authority: authorityPubkey.toBase58(),
      nonceAccount: nonceAccount.publicKey.toBase58(),
      rentExemptAmount,
      signature,
    }
  })
