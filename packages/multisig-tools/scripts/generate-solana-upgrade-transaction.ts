import {
  Connection,
  PublicKey,
  Keypair,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js"
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes"
import * as fs from "fs"
import { BpfLoaderUpgradeableProgram } from "../src/commands/bpf-upgradeable-browser/bpf-upgradeable-browser"
import { SolanaTxSchema } from "../src/builders/utils"
import { z } from "zod"

const BPF_LOADER_UPGRADEABLE_PROGRAM_ID = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111"
)

const BUFFER_HEADER_SIZE = 37

function getBufferAccountSize(programSize: number): number {
  return BUFFER_HEADER_SIZE + programSize
}

const main = async () => {
  const args = process.argv.slice(2)
  const getArg = (name: string) => {
    const index = args.indexOf(name)
    return index !== -1 ? args[index + 1] : undefined
  }

  const rpc = getArg("--rpc") || "https://api.devnet.solana.com"
  const programPath = getArg("--program-path") || ""
  const programId = getArg("--program-id")
  const programKeypair = getArg("--program-keypair")
  const upgradeAuthority = getArg("--upgrade-authority") || ""
  const nonceAccount = getArg("--nonce-account")
  const bufferAuthority = getArg("--buffer-authority")
  const spillAccount = getArg("--spill-account")
  const maxDataLen = getArg("--max-data-len")

  if (!programPath || !upgradeAuthority) {
    console.log("Missing required parameters")
    process.exit(1)
  }

  const connection = new Connection(rpc, "confirmed")

  console.log(`Connecting to ${rpc}`)

  if (!fs.existsSync(programPath)) {
    throw new Error(`Program file not found: ${programPath}`)
  }

  const programData = fs.readFileSync(programPath)
  console.log(`Loaded program: ${programData.length} bytes`)

  // Parse buffer authority - for buffer operations only
  let bufferAuthorityKeypair: Keypair
  if (bufferAuthority) {
    bufferAuthorityKeypair = Keypair.fromSecretKey(bs58.decode(bufferAuthority))
  } else if (process.env.SOLANA_BUFFER_AUTHORITY) {
    bufferAuthorityKeypair = Keypair.fromSecretKey(
      bs58.decode(process.env.SOLANA_BUFFER_AUTHORITY)
    )
  } else if (process.env.SOLANA_NONCE_AUTHORITY_PRIVATE_KEY) {
    bufferAuthorityKeypair = Keypair.fromSecretKey(
      bs58.decode(process.env.SOLANA_NONCE_AUTHORITY_PRIVATE_KEY)
    )
  } else {
    throw new Error("Buffer authority required")
  }

  // Airdrop for buffer authority if running on localnet
  if (rpc.includes("127.0.0.1")) {
    const airdropSignature = await connection.requestAirdrop(
      bufferAuthorityKeypair.publicKey,
      10 * LAMPORTS_PER_SOL
    )
    await connection.confirmTransaction(airdropSignature)
    const airdropSignature2 = await connection.requestAirdrop(
      new PublicKey(upgradeAuthority),
      10 * LAMPORTS_PER_SOL
    )
    await connection.confirmTransaction(airdropSignature2)
  }

  // Parse upgrade authority - this is the multisig wallet
  const upgradeAuthorityPubkey = new PublicKey(upgradeAuthority)

  // Spill account should be the buffer authority (who paid for operations)
  const spillAccountPubkey = spillAccount
    ? new PublicKey(spillAccount)
    : bufferAuthorityKeypair.publicKey

  // Determine program account
  let programAccountPubkey: PublicKey

  if (programKeypair) {
    const keypairJson = JSON.parse(fs.readFileSync(programKeypair, "utf8"))
    const programAccount = Keypair.fromSecretKey(new Uint8Array(keypairJson))
    programAccountPubkey = programAccount.publicKey
  } else if (programId) {
    programAccountPubkey = new PublicKey(programId)
  } else {
    throw new Error("Either --program-id or --program-keypair must be provided")
  }

  console.log(programAccountPubkey.toBase58())

  // Check if program already exists
  const programAccountInfo =
    await connection.getAccountInfo(programAccountPubkey)
  const isUpgrade = !!programAccountInfo

  const balance = await connection.getBalance(bufferAuthorityKeypair.publicKey)
  console.log(
    `Buffer authority balance: ${balance / LAMPORTS_PER_SOL} SOL, ${bufferAuthorityKeypair.publicKey.toBase58()}`
  )

  // Create buffer account
  const bufferAccount = Keypair.generate()
  console.log(`Buffer account: ${bufferAccount.publicKey.toBase58()}`)
  const bufferAccountRent = await connection.getMinimumBalanceForRentExemption(
    getBufferAccountSize(programData.length)
  )

  if (balance < bufferAccountRent + 0.1 * LAMPORTS_PER_SOL) {
    throw new Error(
      `Insufficient balance require=${bufferAccountRent / LAMPORTS_PER_SOL} balance=${balance / LAMPORTS_PER_SOL}`
    )
  }

  // Create and initialize buffer
  console.log("Creating buffer account...")
  const createBufferIx = SystemProgram.createAccount({
    fromPubkey: bufferAuthorityKeypair.publicKey,
    lamports: bufferAccountRent,
    newAccountPubkey: bufferAccount.publicKey,
    programId: BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
    space: getBufferAccountSize(programData.length),
  })

  const initBufferIx = BpfLoaderUpgradeableProgram.initializeBuffer({
    authorityPk: bufferAuthorityKeypair.publicKey,
    bufferPk: bufferAccount.publicKey,
  })

  const tx = new Transaction().add(createBufferIx).add(initBufferIx)
  console.log("Sending buffer creation transaction...")
  await sendAndConfirmTransaction(
    connection,
    tx,
    [bufferAuthorityKeypair, bufferAccount],
    { commitment: "confirmed" }
  )

  // Write program data
  const CHUNK_SIZE = 1000
  const totalChunks = Math.ceil(programData.length / CHUNK_SIZE)
  console.log(`Writing ${totalChunks} chunks...`)

  for (let i = 0; i < programData.length; i += CHUNK_SIZE) {
    const chunk = programData.subarray(
      i,
      Math.min(i + CHUNK_SIZE, programData.length)
    )
    const chunkNumber = Math.floor(i / CHUNK_SIZE) + 1

    if (
      chunkNumber % 50 === 0 ||
      chunkNumber === 1 ||
      chunkNumber === totalChunks
    ) {
      console.log(`Chunk ${chunkNumber}/${totalChunks}`)
    }

    const writeIx = BpfLoaderUpgradeableProgram.write({
      authorityPk: bufferAuthorityKeypair.publicKey,
      bufferPk: bufferAccount.publicKey,
      bytes: chunk,
      offset: i,
    })

    const writeTx = new Transaction().add(writeIx)
    await sendAndConfirmTransaction(
      connection,
      writeTx,
      [bufferAuthorityKeypair],
      { commitment: "confirmed" }
    )
  }

  // For deploy, create the program account before transferring authority
  if (!isUpgrade && programKeypair) {
    const keypairJson = JSON.parse(fs.readFileSync(programKeypair, "utf8"))
    const programAccount = Keypair.fromSecretKey(new Uint8Array(keypairJson))

    const programAccountRent =
      await connection.getMinimumBalanceForRentExemption(36)

    console.log("Creating program account...")
    const createProgramAccountIx = SystemProgram.createAccount({
      fromPubkey: bufferAuthorityKeypair.publicKey,
      lamports: programAccountRent,
      newAccountPubkey: programAccount.publicKey,
      programId: BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
      space: 36,
    })

    const createProgramTx = new Transaction().add(createProgramAccountIx)
    await sendAndConfirmTransaction(
      connection,
      createProgramTx,
      [bufferAuthorityKeypair, programAccount],
      { commitment: "confirmed" }
    )
    console.log("Program account created")
  }

  // Transfer buffer authority to upgrade authority
  console.log("Transferring buffer authority...")
  const transferAuthorityIx = BpfLoaderUpgradeableProgram.setBufferAuthority({
    authorityPk: bufferAuthorityKeypair.publicKey,
    bufferPk: bufferAccount.publicKey,
    newAuthorityPk: upgradeAuthorityPubkey,
  })

  const transferTx = new Transaction().add(transferAuthorityIx)
  console.log("Sending authority transfer transaction...")
  await sendAndConfirmTransaction(
    connection,
    transferTx,
    [bufferAuthorityKeypair],
    { commitment: "confirmed" }
  )

  let transaction: z.infer<typeof SolanaTxSchema>

  if (isUpgrade) {
    // Generate upgrade transaction
    console.log("Generating upgrade transaction...")
    const upgradeIx = await BpfLoaderUpgradeableProgram.upgrade({
      authorityPk: upgradeAuthorityPubkey,
      bufferPk: bufferAccount.publicKey,
      programPk: programAccountPubkey,
      spillPk: spillAccountPubkey,
    })

    transaction = {
      computeUnitLimit: "300000",
      computeUnitPrice: "5000",
      family: "solana-vm",
      from: upgradeAuthority,
      instructions: [
        {
          data: Buffer.from(upgradeIx.data).toString("hex"),
          keys: upgradeIx.keys.map((key) => ({
            isSigner: key.isSigner,
            isWritable: key.isWritable,
            pubkey: key.pubkey.toBase58(),
          })),
          programId: upgradeIx.programId.toBase58(),
        },
      ],
      rpc,
    }
  } else {
    // Generate deploy transaction
    console.log("Generating deploy transaction...")
    const maxLen = maxDataLen ? parseInt(maxDataLen) : programData.length * 2

    const deployIx = await BpfLoaderUpgradeableProgram.deployWithMaxProgramLen({
      bufferPk: bufferAccount.publicKey,
      maxDataLen: maxLen,
      payerPk: upgradeAuthorityPubkey,
      programPk: programAccountPubkey,
      upgradeAuthorityPk: upgradeAuthorityPubkey,
    })

    transaction = {
      computeUnitLimit: "500000",
      computeUnitPrice: "5000",
      family: "solana-vm",
      from: upgradeAuthority,
      instructions: [
        {
          data: Buffer.from(deployIx.data).toString("hex"),
          keys: deployIx.keys.map((key) => ({
            isSigner: key.isSigner,
            isWritable: key.isWritable,
            pubkey: key.pubkey.toBase58(),
          })),
          programId: deployIx.programId.toBase58(),
        },
      ],
      rpc,
    }
  }

  if (nonceAccount) {
    transaction.nonceAccount = nonceAccount
    // nonceAccountAuth should be the buffer authority
    transaction.nonceAccountAuth = bufferAuthorityKeypair.publicKey.toBase58()
  }

  console.log("Transaction ready")
  console.log(JSON.stringify([transaction], null, 2))
}

main().catch(console.log)
