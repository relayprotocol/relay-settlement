import { PublicKey } from "@solana/web3.js"
import { SolanaTxSchema } from "../utils"
import { z } from "zod"

// BPF Loader Upgradeable Program ID
const BPF_LOADER_UPGRADEABLE_PROGRAM_ID = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111"
)

// relay_depository set_owner discriminator
const SET_OWNER_DISCRIMINATOR = Buffer.from([
  72, 202, 120, 52, 77, 128, 96, 197,
])

// relay_depository PDA seed
const RELAY_DEPOSITORY_SEED = Buffer.from("relay_depository")

// SetAuthority instruction for BPF Loader Upgradeable (instruction index = 4)
// Based on BpfLoaderUpgradeableProgram.setUpgradeAuthority
function createSetUpgradeAuthorityInstruction(
  programId: PublicKey,
  currentAuthority: PublicKey,
  newAuthority: PublicKey
) {
  // SetAuthority instruction data
  const data = Buffer.alloc(4)
  data.writeUInt32LE(4, 0) // SetAuthority instruction index

  // Get program data account (PDA of BPF Loader)
  const [programDataAccount] = PublicKey.findProgramAddressSync(
    [programId.toBuffer()],
    BPF_LOADER_UPGRADEABLE_PROGRAM_ID
  )

  return {
    data: data.toString("hex"),
    keys: [
      {
        isSigner: false,
        isWritable: true,
        pubkey: programDataAccount.toBase58(),
      },
      {
        isSigner: true,
        isWritable: false,
        pubkey: currentAuthority.toBase58(),
      },
      { isSigner: false, isWritable: false, pubkey: newAuthority.toBase58() },
    ],
    programId: BPF_LOADER_UPGRADEABLE_PROGRAM_ID.toBase58(),
  }
}

const main = async () => {
  const args = process.argv.slice(2)
  const getArg = (name: string) => {
    const index = args.indexOf(name)
    return index !== -1 ? args[index + 1] : undefined
  }

  const rpc = getArg("--rpc") || "https://api.mainnet-beta.solana.com"
  const currentAuthority = getArg("--current-authority") || ""
  const newAuthority = getArg("--new-authority") || ""
  const nonceAccount = getArg("--nonce-account")
  const nonceAuthority = getArg("--nonce-authority")
  const relayDepositoryProgramId = getArg("--relay-depository")
  const relayForwarderProgramId = getArg("--relay-forwarder")

  if (!currentAuthority || !newAuthority) {
    console.log(
      "Missing required parameters: --current-authority and --new-authority"
    )
    process.exit(1)
  }

  console.log(`RPC: ${rpc}`)

  const currentAuthorityPubkey = new PublicKey(currentAuthority)
  const newAuthorityPubkey = new PublicKey(newAuthority)

  const instructions: any[] = []

  // 1. relay_depository set_owner (if program ID provided)
  if (relayDepositoryProgramId) {
    const programId = new PublicKey(relayDepositoryProgramId)
    const [relayDepositoryPda] = PublicKey.findProgramAddressSync(
      [RELAY_DEPOSITORY_SEED],
      programId
    )

    console.log(`RelayDepository PDA: ${relayDepositoryPda.toBase58()}`)

    // set_owner instruction
    const setOwnerData = Buffer.concat([
      SET_OWNER_DISCRIMINATOR,
      newAuthorityPubkey.toBuffer(),
    ])

    instructions.push({
      data: setOwnerData.toString("hex"),
      keys: [
        {
          isSigner: false,
          isWritable: true,
          pubkey: relayDepositoryPda.toBase58(),
        },
        { isSigner: true, isWritable: false, pubkey: currentAuthority },
      ],
      programId: programId.toBase58(),
    })
    console.log("Added: relay_depository set_owner")

    // relay_depository upgrade authority
    const depositoryUpgradeIx = createSetUpgradeAuthorityInstruction(
      programId,
      currentAuthorityPubkey,
      newAuthorityPubkey
    )
    instructions.push(depositoryUpgradeIx)
    console.log("Added: relay_depository upgrade authority")
  }

  // 2. relay_forwarder upgrade authority (if program ID provided)
  if (relayForwarderProgramId) {
    const programId = new PublicKey(relayForwarderProgramId)
    const forwarderUpgradeIx = createSetUpgradeAuthorityInstruction(
      programId,
      currentAuthorityPubkey,
      newAuthorityPubkey
    )
    instructions.push(forwarderUpgradeIx)
    console.log("Added: relay_forwarder upgrade authority")
  }

  if (instructions.length === 0) {
    console.log(
      "No instructions to generate. Provide --relay-depository and/or --relay-forwarder"
    )
    process.exit(1)
  }

  // Build the transaction
  const transaction: z.infer<typeof SolanaTxSchema> = {
    computeUnitLimit: (100000 * instructions.length).toString(),
    computeUnitPrice: "5000",
    family: "solana-vm",
    from: currentAuthority,
    instructions,
    rpc,
  }

  if (nonceAccount) {
    transaction.nonceAccount = nonceAccount
    transaction.nonceAccountAuth = nonceAuthority || currentAuthority
  }

  console.log("\n=== Transaction Details ===")
  console.log(`Current Authority: ${currentAuthority}`)
  console.log(`New Authority: ${newAuthority}`)
  console.log(`Instructions: ${instructions.length}`)
  if (nonceAccount) {
    console.log(`Nonce Account: ${nonceAccount}`)
    console.log(`Nonce Authority: ${transaction.nonceAccountAuth}`)
  }

  console.log("\nTransaction ready")
  console.log(JSON.stringify([transaction], null, 2))
}

main().catch(console.log)
