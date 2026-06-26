import { Connection, PublicKey } from "@solana/web3.js"
import { SolanaTxSchema } from "../src/builders/utils"
import { z } from "zod"

// set_owner instruction discriminator
const SET_OWNER_DISCRIMINATOR = Buffer.from([
  72, 202, 120, 52, 77, 128, 96, 197,
])

// relay_depository PDA seed
const RELAY_DEPOSITORY_SEED = Buffer.from("relay_depository")

const main = async () => {
  const args = process.argv.slice(2)
  const getArg = (name: string) => {
    const index = args.indexOf(name)
    return index !== -1 ? args[index + 1] : undefined
  }

  const rpc = getArg("--rpc") || "https://api.mainnet-beta.solana.com"
  const currentOwner = getArg("--current-owner") || ""
  const newOwner = getArg("--new-owner") || ""
  const nonceAccount = getArg("--nonce-account")
  const nonceAuthority = getArg("--nonce-authority")
  const programIdOverride = getArg("--program-id")

  if (!currentOwner || !newOwner) {
    console.log("Missing required parameters: --current-owner and --new-owner")
    process.exit(1)
  }

  const connection = new Connection(rpc, "confirmed")

  console.log(`Connecting to ${rpc}`)

  // Validate public keys
  const currentOwnerPubkey = new PublicKey(currentOwner)
  const newOwnerPubkey = new PublicKey(newOwner)

  // Get program ID
  const programId = new PublicKey(programIdOverride!)
  console.log(`Program ID: ${programId.toBase58()}`)

  // Derive relay_depository PDA
  const [relayDepositoryPda] = PublicKey.findProgramAddressSync(
    [RELAY_DEPOSITORY_SEED],
    programId
  )
  console.log(`RelayDepository PDA: ${relayDepositoryPda.toBase58()}`)

  // Verify the relay_depository account exists
  const accountInfo = await connection.getAccountInfo(relayDepositoryPda)
  if (!accountInfo) {
    throw new Error(
      `RelayDepository account not found at ${relayDepositoryPda.toBase58()}`
    )
  }

  // Parse account data to verify current owner
  // Account layout: discriminator (8 bytes) + owner (32 bytes) + allocator (32 bytes) + vault_bump (1 byte)
  const accountData = accountInfo.data
  const storedOwner = new PublicKey(accountData.slice(8, 40))
  console.log(`Current stored owner: ${storedOwner.toBase58()}`)

  if (!storedOwner.equals(currentOwnerPubkey)) {
    console.log(
      `⚠️  Warning: Owner mismatch! Stored: ${storedOwner.toBase58()}, Provided: ${currentOwnerPubkey.toBase58()}`
    )
  }

  // Build instruction data: discriminator + new_owner
  const instructionData = Buffer.concat([
    SET_OWNER_DISCRIMINATOR,
    newOwnerPubkey.toBuffer(),
  ])

  // Build the transaction
  const transaction: z.infer<typeof SolanaTxSchema> = {
    computeUnitLimit: "100000",
    computeUnitPrice: "5000",
    family: "solana-vm",
    from: currentOwner,
    instructions: [
      {
        data: instructionData.toString("hex"),
        keys: [
          {
            isSigner: false,
            isWritable: true,
            pubkey: relayDepositoryPda.toBase58(),
          },
          {
            isSigner: true,
            isWritable: false,
            pubkey: currentOwner,
          },
        ],
        programId: programId.toBase58(),
      },
    ],
    rpc,
  }

  if (nonceAccount) {
    transaction.nonceAccount = nonceAccount
    transaction.nonceAccountAuth = nonceAuthority || currentOwner
  }

  console.log("Transaction ready")
  console.log(JSON.stringify([transaction], null, 2))
}

main().catch(console.log)
