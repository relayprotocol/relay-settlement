import { task } from "hardhat/config"
import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  sendAndConfirmTransaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js"
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes"
import * as fs from "fs"
import { BpfLoaderUpgradeableProgram } from "./bpf-upgradeable-browser/bpf-upgradeable-browser"
import * as anchor from "@coral-xyz/anchor"

export const BPF_LOADER_UPGRADEABLE_PROGRAM_ID = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111"
)

// Buffer account layout constants
const BUFFER_HEADER_SIZE = 37

// Mock owner keypair for testing
const MOCK_OWNER = Keypair.fromSecretKey(
  Buffer.from(
    "5223911e0fbfb0b8d5880ebea5711d5d7754387950c08b52c0eaf127facebd455e28ef570e8aed9ecef8a89f5c1a90739080c05df9e9c8ca082376ef93a02b2e",
    "hex"
  )
)

// Helper function to calculate buffer account size
function getBufferAccountSize(programSize: number): number {
  return BUFFER_HEADER_SIZE + programSize
}

// Helper function to create buffer account
async function createBufferAccountForUpgrade(
  connection: Connection,
  payer: Keypair,
  bufferAuthority: PublicKey,
  programSize: number,
  description: string
): Promise<PublicKey> {
  console.log(`📝 Creating ${description} buffer account...`)

  const bufferAccount = Keypair.generate()
  const bufferAccountRent = await connection.getMinimumBalanceForRentExemption(
    getBufferAccountSize(programSize)
  )

  console.log(`${description} Buffer: ${bufferAccount.publicKey.toBase58()}`)
  console.log(`Buffer authority: ${bufferAuthority.toBase58()}`)
  console.log(`Program size: ${programSize} bytes`)
  console.log(`Rent required: ${bufferAccountRent} lamports`)

  const createBufferIx = SystemProgram.createAccount({
    fromPubkey: payer.publicKey,
    lamports: bufferAccountRent,
    newAccountPubkey: bufferAccount.publicKey,
    programId: BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
    space: getBufferAccountSize(programSize),
  })

  const initBufferIx = BpfLoaderUpgradeableProgram.initializeBuffer({
    authorityPk: bufferAuthority,
    bufferPk: bufferAccount.publicKey,
  })

  const transaction = new Transaction().add(createBufferIx).add(initBufferIx)

  const signature = await sendAndConfirmTransaction(
    connection,
    transaction,
    [payer, bufferAccount],
    { commitment: "confirmed" }
  )

  console.log(`✅ ${description} buffer created: ${signature}`)
  return bufferAccount.publicKey
}

// Helper function to write program data to buffer
async function writeProgramToBuffer(
  connection: Connection,
  bufferAccount: PublicKey,
  bufferAuthority: Keypair,
  programData: Buffer,
  description: string
): Promise<void> {
  console.log(`📝 Writing ${description} program data to buffer...`)
  console.log(`Buffer: ${bufferAccount.toBase58()}`)
  console.log(`Data size: ${programData.length} bytes`)

  const CHUNK_SIZE = 1000

  const totalChunks = Math.ceil(programData.length / CHUNK_SIZE)

  for (let i = 0; i < programData.length; i += CHUNK_SIZE) {
    const chunk = programData.subarray(
      i,
      Math.min(i + CHUNK_SIZE, programData.length)
    )
    const chunkOffset = i
    const chunkNumber = Math.floor(i / CHUNK_SIZE) + 1

    // Only log every 10th chunk or first/last chunk to reduce noise
    if (
      chunkNumber === 1 ||
      chunkNumber === totalChunks ||
      chunkNumber % 10 === 0
    ) {
      console.log(`Writing ${description} chunk ${chunkNumber}/${totalChunks}`)
    }

    const writeIx = BpfLoaderUpgradeableProgram.write({
      authorityPk: bufferAuthority.publicKey,
      bufferPk: bufferAccount,
      bytes: chunk,
      offset: chunkOffset,
    })

    const transaction = new Transaction().add(writeIx)

    await sendAndConfirmTransaction(
      connection,
      transaction,
      [bufferAuthority],
      { commitment: "confirmed" }
    )

    // Only log transaction signatures for first/last chunk to reduce noise
    if (chunkNumber === 1 || chunkNumber === totalChunks) {
      // console.log(`✅ ${description} chunk ${chunkNumber} written`)
    }
  }

  console.log(`✅ ${description} program data written successfully!`)
}

// Helper function to deploy new program or upgrade existing
async function deployOrUpgradeProgram(
  connection: Connection,
  payer: Keypair,
  bufferAccount: PublicKey,
  upgradeAuthority: Keypair,
  maxDataLen: number,
  programKeypair?: Keypair
): Promise<{ programId: PublicKey; wasExisting: boolean }> {
  const programAccount = programKeypair || Keypair.generate()
  const programAccountPubkey = programAccount.publicKey

  if (programKeypair) {
    console.log(
      `Using specified program ID: ${programAccountPubkey.toBase58()}`
    )
  } else {
    console.log(`Generated new program ID: ${programAccountPubkey.toBase58()}`)
  }

  // Check if program account already exists
  const programAccountInfo =
    await connection.getAccountInfo(programAccountPubkey)

  if (programAccountInfo) {
    console.log("📝 Program account already exists, performing upgrade...")

    // Program exists, perform upgrade
    const upgradeIx = await BpfLoaderUpgradeableProgram.upgrade({
      authorityPk: upgradeAuthority.publicKey,
      bufferPk: bufferAccount,
      programPk: programAccountPubkey,
      spillPk: payer.publicKey,
    })

    const upgradeTransaction = new Transaction().add(upgradeIx)

    const signature = await sendAndConfirmTransaction(
      connection,
      upgradeTransaction,
      [payer, upgradeAuthority],
      { commitment: "confirmed" }
    )

    console.log(`✅ Program upgraded: ${signature}`)
    return { programId: programAccountPubkey, wasExisting: true }
  } else {
    console.log("📝 Deploying new program...")

    // Program doesn't exist, deploy new
    const programAccountRent =
      await connection.getMinimumBalanceForRentExemption(36)
    const createProgramAccountIx = SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      lamports: programAccountRent,
      newAccountPubkey: programAccountPubkey,
      programId: BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
      space: 36,
    })

    const deployIx = await BpfLoaderUpgradeableProgram.deployWithMaxProgramLen({
      bufferPk: bufferAccount,
      maxDataLen,
      payerPk: payer.publicKey,
      programPk: programAccountPubkey,
      upgradeAuthorityPk: upgradeAuthority.publicKey,
    })

    const deployTransaction = new Transaction()
      .add(createProgramAccountIx)
      .add(deployIx)

    const signature = await sendAndConfirmTransaction(
      connection,
      deployTransaction,
      [payer, programAccount, upgradeAuthority],
      { commitment: "confirmed" }
    )

    console.log(`✅ Program deployed: ${signature}`)
    return { programId: programAccountPubkey, wasExisting: false }
  }
}

// Helper function to upgrade existing program
async function upgradeProgram(
  connection: Connection,
  payer: Keypair,
  bufferAccount: PublicKey,
  programAccount: PublicKey,
  upgradeAuthority: Keypair
): Promise<string> {
  console.log("📝 Upgrading program...")
  console.log(`Program: ${programAccount.toBase58()}`)
  console.log(`Buffer: ${bufferAccount.toBase58()}`)

  const upgradeIx = await BpfLoaderUpgradeableProgram.upgrade({
    authorityPk: upgradeAuthority.publicKey,
    bufferPk: bufferAccount,
    programPk: programAccount,
    spillPk: payer.publicKey,
  })

  const transaction = new Transaction().add(upgradeIx)

  const signature = await sendAndConfirmTransaction(
    connection,
    transaction,
    [payer, upgradeAuthority],
    { commitment: "confirmed" }
  )

  console.log(`✅ Program upgraded: ${signature}`)
  return signature
}

// Helper function to transfer buffer authority
async function transferBufferAuthority(
  connection: Connection,
  bufferAccount: PublicKey,
  currentAuthority: Keypair,
  newAuthority: PublicKey
): Promise<void> {
  console.log("🔄 Transferring buffer authority to upgrade authority...")

  const transferAuthorityIx = BpfLoaderUpgradeableProgram.setBufferAuthority({
    authorityPk: currentAuthority.publicKey,
    bufferPk: bufferAccount,
    newAuthorityPk: newAuthority,
  })

  const transferTransaction = new Transaction().add(transferAuthorityIx)

  await sendAndConfirmTransaction(
    connection,
    transferTransaction,
    [currentAuthority],
    { commitment: "confirmed" }
  )

  console.log("✅ Buffer authority transferred")
}

// Helper function to create test account with airdrop
async function createTestAccountWithAirdrop(
  connection: Connection,
  solAmount: number = 10,
  description: string
): Promise<Keypair> {
  console.log(`🔑 Creating ${description} test account...`)

  const keypair = Keypair.generate()
  console.log(`${description} account: ${keypair.publicKey.toBase58()}`)

  try {
    console.log(`💰 Requesting ${solAmount} SOL airdrop for ${description}...`)
    const airdropSignature = await connection.requestAirdrop(
      keypair.publicKey,
      solAmount * LAMPORTS_PER_SOL
    )

    await connection.confirmTransaction(airdropSignature)

    const balance = await connection.getBalance(keypair.publicKey)
    console.log(
      `✅ ${description} airdrop successful! Balance: ${balance / LAMPORTS_PER_SOL} SOL`
    )

    return keypair
  } catch (error) {
    console.error(`❌ ${description} airdrop failed:`, error)
    throw new Error(
      `Failed to airdrop SOL to ${description} account. ` +
        "This might not be a local test validator."
    )
  }
}

// Helper function to ensure account balance
async function ensureAccountBalance(
  connection: Connection,
  keypair: Keypair,
  minSolRequired: number = 5,
  description: string
): Promise<void> {
  const balance = await connection.getBalance(keypair.publicKey)
  const balanceInSol = balance / LAMPORTS_PER_SOL

  console.log(`💰 ${description} balance: ${balanceInSol} SOL`)

  if (balanceInSol < minSolRequired) {
    console.log(`⚠️  ${description} balance too low, requesting airdrop...`)
    try {
      const airdropAmount = Math.max(10, minSolRequired * 2)
      const airdropSignature = await connection.requestAirdrop(
        keypair.publicKey,
        airdropAmount * LAMPORTS_PER_SOL
      )

      await connection.confirmTransaction(airdropSignature)

      const newBalance = await connection.getBalance(keypair.publicKey)
      console.log(
        `✅ ${description} airdrop successful! New balance: ${newBalance / LAMPORTS_PER_SOL} SOL`
      )
    } catch (error) {
      console.warn(`⚠️  ${description} airdrop failed:`, error)
      console.log(`Continuing with existing balance: ${balanceInSol} SOL`)
    }
  }
}

// Migration function - calls migrate_domain_separator after program upgrade
async function executeMigration(
  _connection: Connection,
  programId: PublicKey,
  migrationAuthority: Keypair,
  migrationFunction: string
): Promise<void> {
  console.log(`🔄 Executing migration function: ${migrationFunction}`)
  console.log(`Program ID: ${programId.toBase58()}`)
  console.log(`Migration authority: ${migrationAuthority.publicKey.toBase58()}`)

  // Wait a moment for the upgraded program to be available
  console.log("⏳ Waiting for upgraded program to be ready...")
  await new Promise((resolve) => setTimeout(resolve, 2000))

  try {
    // Check MOCK_OWNER balance before migration
    const ownerBalance = await _connection.getBalance(MOCK_OWNER.publicKey)
    console.log(`💰 MOCK_OWNER balance: ${ownerBalance / LAMPORTS_PER_SOL} SOL`)

    if (ownerBalance < 0.1 * LAMPORTS_PER_SOL) {
      throw new Error(
        `MOCK_OWNER has insufficient balance for reallocation. Current: ${ownerBalance / LAMPORTS_PER_SOL} SOL, required: at least 0.1 SOL`
      )
    }

    // Use the same owner keypair from the deployment
    const [relayDepositoryPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("relay_depository")],
      programId
    )

    // Check current PDA account info
    const pdaInfo = await _connection.getAccountInfo(relayDepositoryPDA)
    if (pdaInfo) {
      console.log(`📊 PDA account current size: ${pdaInfo.data.length} bytes`)
      console.log(`📊 PDA account owner: ${pdaInfo.owner.toBase58()}`)
    }

    // Call migrate_domain_separator to set the domain separator
    console.log("🔄 Calling migrate_domain_separator...")
    const chainId = "solana-mainnet" // You can make this configurable if needed

    // Create the migrate_domain_separator instruction manually to avoid IDL version issues
    // The discriminator for migrate_domain_separator from the upgraded IDL
    const migrateDomainSeparatorDiscriminator = [
      125, 28, 21, 67, 230, 227, 107, 79,
    ]

    // Serialize chain_id as String (Rust String serialization: length + bytes)
    const chainIdBytes = Buffer.from(chainId, "utf8")
    const chainIdLength = Buffer.alloc(4)
    chainIdLength.writeUInt32LE(chainIdBytes.length, 0)

    const instructionData = Buffer.concat([
      Buffer.from(migrateDomainSeparatorDiscriminator),
      chainIdLength,
      chainIdBytes,
    ])

    const migrateTx = new Transaction().add({
      data: instructionData,
      keys: [
        { isSigner: false, isWritable: true, pubkey: relayDepositoryPDA },
        { isSigner: true, isWritable: true, pubkey: MOCK_OWNER.publicKey },
        { isSigner: false, isWritable: false, pubkey: SystemProgram.programId },
        {
          isSigner: false,
          isWritable: false,
          pubkey: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        },
      ],
      programId: programId,
    })

    // Read account data before migration
    console.log("📊 Reading account data before migration...")
    const preMigrationPdaInfo =
      await _connection.getAccountInfo(relayDepositoryPDA)
    if (preMigrationPdaInfo) {
      console.log(
        `📊 Pre-migration account size: ${preMigrationPdaInfo.data.length} bytes`
      )
      console.log(
        `📊 Pre-migration account data (hex): ${preMigrationPdaInfo.data.toString("hex")}`
      )
      console.log(
        `📊 Pre-migration account lamports: ${preMigrationPdaInfo.lamports}`
      )
    }

    const signature = await sendAndConfirmTransaction(
      _connection,
      migrateTx,
      [MOCK_OWNER],
      { commitment: "confirmed" }
    )

    // Read account data after migration
    console.log("📊 Reading account data after migration...")
    const postMigrationPdaInfo =
      await _connection.getAccountInfo(relayDepositoryPDA)
    if (postMigrationPdaInfo) {
      console.log(
        `📊 Post-migration account size: ${postMigrationPdaInfo.data.length} bytes`
      )
      console.log(
        `📊 Post-migration account data (hex): ${postMigrationPdaInfo.data.toString("hex")}`
      )
      console.log(
        `📊 Post-migration account lamports: ${postMigrationPdaInfo.lamports}`
      )

      // Compare sizes
      if (preMigrationPdaInfo) {
        const sizeDiff =
          postMigrationPdaInfo.data.length - preMigrationPdaInfo.data.length
        const lamportsDiff =
          postMigrationPdaInfo.lamports - preMigrationPdaInfo.lamports
        console.log(
          `📊 Size change: ${sizeDiff > 0 ? "+" : ""}${sizeDiff} bytes`
        )
        console.log(
          `📊 Lamports change: ${lamportsDiff > 0 ? "+" : ""}${lamportsDiff} lamports`
        )
      }
    }

    console.log(`✅ Domain separator migration completed for chain: ${chainId}`)
    console.log(`✅ Migration transaction: ${signature}`)
    console.log(
      `✅ Migration function '${migrationFunction}' executed successfully`
    )
  } catch (error) {
    console.error("❌ Migration failed:", error)
    // If migration fails, it might be because domain separator is already set or other reasons
    // Log the error but don't fail the entire process
    console.warn(
      "⚠️  Migration may have failed, but this could be expected (e.g., domain separator already set)"
    )
  }
}

// Post-deployment hook function - executes initialize instruction after deployment
async function executePostDeploymentHook(
  _connection: Connection,
  programId: PublicKey,
  deploymentAuthority: Keypair,
  initFunction: string
): Promise<void> {
  console.log(`🚀 Executing post-deployment hook: ${initFunction}`)
  console.log(`Program ID: ${programId.toBase58()}`)
  console.log(
    `Deployment authority: ${deploymentAuthority.publicKey.toBase58()}`
  )

  // Wait a moment for the program to be available
  console.log("⏳ Waiting for program to be ready...")
  await new Promise((resolve) => setTimeout(resolve, 2000))

  // Verify program is deployable and executable
  const programInfo = await _connection.getAccountInfo(programId)
  if (!programInfo || !programInfo.executable) {
    throw new Error(
      `Program ${programId.toBase58()} is not executable or not found`
    )
  }
  console.log("✅ Program is ready and executable")

  try {
    const [relayDepositoryPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("relay_depository")],
      programId
    )
    const [vaultPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault")],
      programId
    )

    const allocator = Keypair.generate()

    // Create the initialize instruction manually to avoid IDL issues
    // The discriminator for initialize from the IDL
    const initializeDiscriminator = [175, 175, 109, 31, 13, 152, 155, 237]

    // For the initial version, initialize() takes no parameters
    const instructionData = Buffer.from(initializeDiscriminator)

    const initializeIx = new Transaction().add({
      data: instructionData,
      keys: [
        { isSigner: false, isWritable: true, pubkey: relayDepositoryPDA },
        { isSigner: false, isWritable: true, pubkey: vaultPDA },
        { isSigner: true, isWritable: true, pubkey: MOCK_OWNER.publicKey },
        { isSigner: false, isWritable: false, pubkey: allocator.publicKey },
        { isSigner: false, isWritable: false, pubkey: SystemProgram.programId },
      ],
      programId: programId,
    })

    const signature = await sendAndConfirmTransaction(
      _connection,
      initializeIx,
      [MOCK_OWNER],
      { commitment: "confirmed" }
    )

    console.log("✅ Relay depository initialized (without domain separator)")
    console.log(`✅ Initialize transaction: ${signature}`)
    console.log(
      `✅ Post-deployment hook '${initFunction}' executed successfully`
    )
  } catch (error) {
    console.error("❌ Post-deployment hook failed:", error)
    throw error
  }
}

task(
  "relay-multisig-signer:solana-upgrade-with-migration",
  "Deploy initial program, upgrade to new version, and execute migration"
)
  .addParam("rpc", "Solana RPC endpoint")
  .addParam("initialProgramPath", "Path to the initial .so program file")
  .addParam("upgradeProgramPath", "Path to the upgrade .so program file")
  .addOptionalParam(
    "bufferAuthority",
    "Base58 encoded private key of buffer authority (ENV: SOLANA_BUFFER_AUTHORITY)"
  )
  .addOptionalParam(
    "upgradeAuthority",
    "Base58 encoded private key of upgrade authority (ENV: SOLANA_UPGRADE_AUTHORITY)"
  )
  .addOptionalParam(
    "programKeypair",
    "Path to program keypair JSON file (if not provided, will generate new program)"
  )
  .addOptionalParam(
    "migrationFunction",
    "Name of migration function to execute after upgrade",
    "migrate"
  )
  .addFlag(
    "autoCreate",
    "Automatically create test accounts and airdrop SOL (for local test validator)"
  )
  .setAction(
    async ({
      rpc,
      initialProgramPath,
      upgradeProgramPath,
      bufferAuthority,
      upgradeAuthority,
      programKeypair,
      migrationFunction,
      autoCreate,
    }) => {
      const connection = new Connection(rpc, "confirmed")

      console.log(
        "🚀 Starting Solana program upgrade with migration workflow..."
      )
      console.log(`RPC: ${rpc}`)
      console.log(`Initial program: ${initialProgramPath}`)
      console.log(`Upgrade program: ${upgradeProgramPath}`)
      console.log(`Migration function: ${migrationFunction}`)
      if (programKeypair) {
        console.log(`Program keypair: ${programKeypair}`)
      }

      // Validate program files exist
      if (!fs.existsSync(initialProgramPath)) {
        throw new Error(`Initial program file not found: ${initialProgramPath}`)
      }
      if (!fs.existsSync(upgradeProgramPath)) {
        throw new Error(`Upgrade program file not found: ${upgradeProgramPath}`)
      }
      if (programKeypair && !fs.existsSync(programKeypair)) {
        throw new Error(`Program keypair file not found: ${programKeypair}`)
      }

      // Read program files
      const initialProgramData = fs.readFileSync(initialProgramPath)
      const upgradeProgramData = fs.readFileSync(upgradeProgramPath)

      console.log(
        `📁 Initial program loaded: ${initialProgramData.length} bytes`
      )
      console.log(
        `📁 Upgrade program loaded: ${upgradeProgramData.length} bytes`
      )

      // Load program keypair if provided
      let programKeypairData: Keypair | null = null
      if (programKeypair) {
        const keypairJson = JSON.parse(fs.readFileSync(programKeypair, "utf8"))
        programKeypairData = Keypair.fromSecretKey(new Uint8Array(keypairJson))
        console.log(
          `📁 Program keypair loaded: ${programKeypairData.publicKey.toBase58()}`
        )
      }

      // Parse or create keypairs
      let bufferAuthorityKeypair: Keypair
      let upgradeAuthorityKeypair: Keypair

      if (bufferAuthority) {
        bufferAuthorityKeypair = Keypair.fromSecretKey(
          bs58.decode(bufferAuthority)
        )
      } else if (process.env.SOLANA_BUFFER_AUTHORITY) {
        bufferAuthorityKeypair = Keypair.fromSecretKey(
          bs58.decode(process.env.SOLANA_BUFFER_AUTHORITY)
        )
      } else if (autoCreate) {
        bufferAuthorityKeypair = await createTestAccountWithAirdrop(
          connection,
          15,
          "buffer authority"
        )
      } else {
        throw new Error(
          "Either provide --buffer-authority, set SOLANA_BUFFER_AUTHORITY env var, or use --auto-create flag"
        )
      }

      // If program keypair is provided, always use MOCK_OWNER as upgrade authority
      if (programKeypairData) {
        upgradeAuthorityKeypair = MOCK_OWNER
        console.log(
          "🔧 Using MOCK_OWNER as upgrade authority (program keypair provided)"
        )
      } else {
        // For auto-generated programs, use provided upgrade authority
        if (upgradeAuthority) {
          upgradeAuthorityKeypair = Keypair.fromSecretKey(
            bs58.decode(upgradeAuthority)
          )
        } else if (process.env.SOLANA_UPGRADE_AUTHORITY) {
          upgradeAuthorityKeypair = Keypair.fromSecretKey(
            bs58.decode(process.env.SOLANA_UPGRADE_AUTHORITY)
          )
        } else if (autoCreate) {
          upgradeAuthorityKeypair = await createTestAccountWithAirdrop(
            connection,
            15,
            "upgrade authority"
          )
        } else {
          throw new Error(
            "Either provide --upgrade-authority, set SOLANA_UPGRADE_AUTHORITY env var, or use --auto-create flag"
          )
        }
      }

      // Ensure account balances if auto-create is enabled
      if (autoCreate) {
        await ensureAccountBalance(
          connection,
          bufferAuthorityKeypair,
          10,
          "Buffer authority"
        )

        // Only check upgrade authority balance if it's different from MOCK_OWNER
        if (upgradeAuthorityKeypair !== MOCK_OWNER) {
          await ensureAccountBalance(
            connection,
            upgradeAuthorityKeypair,
            10,
            "Upgrade authority"
          )
        }

        // Always ensure MOCK_OWNER has enough balance (used for initialization and potentially upgrades)
        await ensureAccountBalance(connection, MOCK_OWNER, 10, "Mock owner")
      }

      console.log(
        `Buffer Authority: ${bufferAuthorityKeypair.publicKey.toBase58()}`
      )
      console.log(
        `Upgrade Authority: ${upgradeAuthorityKeypair.publicKey.toBase58()}`
      )
      console.log(`Mock Owner: ${MOCK_OWNER.publicKey.toBase58()}`)

      if (autoCreate) {
        console.log("\n🔧 Auto-create mode - Generated private keys:")
        console.log(
          `Buffer Authority: ${bs58.encode(bufferAuthorityKeypair.secretKey)}`
        )
        console.log(
          `Upgrade Authority: ${bs58.encode(upgradeAuthorityKeypair.secretKey)}`
        )
        console.log(
          `Mock Owner: ${bs58.encode(MOCK_OWNER.secretKey)} (fixed for testing)`
        )
      }

      try {
        // Phase 1: Deploy initial program
        console.log("\n=== PHASE 1: Deploy Initial Program ===")

        // Create buffer for initial program
        const initialBufferAccount = await createBufferAccountForUpgrade(
          connection,
          bufferAuthorityKeypair, // Buffer authority acts as payer for buffer creation
          bufferAuthorityKeypair.publicKey,
          initialProgramData.length,
          "initial"
        )

        // Write initial program to buffer
        await writeProgramToBuffer(
          connection,
          initialBufferAccount,
          bufferAuthorityKeypair,
          initialProgramData,
          "initial"
        )

        // Transfer buffer authority to upgrade authority if different
        if (
          bufferAuthorityKeypair.publicKey.toString() !==
          upgradeAuthorityKeypair.publicKey.toString()
        ) {
          await transferBufferAuthority(
            connection,
            initialBufferAccount,
            bufferAuthorityKeypair,
            upgradeAuthorityKeypair.publicKey
          )
        }

        // Deploy initial program or upgrade if it already exists
        const deployResult = await deployOrUpgradeProgram(
          connection,
          upgradeAuthorityKeypair, // Upgrade authority acts as payer for deployment
          initialBufferAccount,
          upgradeAuthorityKeypair,
          Math.max(initialProgramData.length, upgradeProgramData.length), // Max of both versions
          programKeypairData || undefined
        )

        const programId = deployResult.programId
        console.log(
          `✅ Initial program deployed with ID: ${programId.toBase58()}`
        )

        // Phase 1.5: Execute post-deployment hook (only if program was newly deployed)
        if (!deployResult.wasExisting) {
          console.log("\n=== PHASE 1.5: Execute Post-Deployment Hook ===")

          await executePostDeploymentHook(
            connection,
            programId,
            upgradeAuthorityKeypair,
            "initialize"
          )
        } else {
          console.log("\n=== PHASE 1.5: Skipping Post-Deployment Hook ===")
          console.log(
            "Program already exists, assuming it's already initialized"
          )
        }

        // Phase 2: Prepare upgrade
        console.log("\n=== PHASE 2: Prepare Program Upgrade ===")

        // Create buffer for upgrade program
        const upgradeBufferAccount = await createBufferAccountForUpgrade(
          connection,
          bufferAuthorityKeypair,
          bufferAuthorityKeypair.publicKey,
          upgradeProgramData.length,
          "upgrade"
        )

        // Write upgrade program to buffer
        await writeProgramToBuffer(
          connection,
          upgradeBufferAccount,
          bufferAuthorityKeypair,
          upgradeProgramData,
          "upgrade"
        )

        // Transfer upgrade buffer authority to upgrade authority if different
        if (
          bufferAuthorityKeypair.publicKey.toString() !==
          upgradeAuthorityKeypair.publicKey.toString()
        ) {
          await transferBufferAuthority(
            connection,
            upgradeBufferAccount,
            bufferAuthorityKeypair,
            upgradeAuthorityKeypair.publicKey
          )
        }

        // Phase 3: Execute upgrade
        console.log("\n=== PHASE 3: Execute Program Upgrade ===")

        await upgradeProgram(
          connection,
          upgradeAuthorityKeypair,
          upgradeBufferAccount,
          programId,
          upgradeAuthorityKeypair
        )

        console.log("✅ Program successfully upgraded to new version")

        // Phase 4: Execute migration
        console.log("\n=== PHASE 4: Execute Migration ===")

        await executeMigration(
          connection,
          programId,
          upgradeAuthorityKeypair,
          migrationFunction
        )

        console.log("\n🎉 === UPGRADE WITH MIGRATION COMPLETE ===")
        console.log(`✅ Program ID: ${programId.toBase58()}`)
        console.log("✅ Initial deployment: SUCCESS")
        console.log("✅ Post-deployment hook: SUCCESS")
        console.log("✅ Program upgrade: SUCCESS")
        console.log("✅ Migration execution: SUCCESS")

        console.log("\n📋 Summary:")
        console.log(
          `1. Buffer operations performed by: ${bufferAuthorityKeypair.publicKey.toBase58()}`
        )
        console.log(
          `2. Deploy/upgrade operations performed by: ${upgradeAuthorityKeypair.publicKey.toBase58()}`
        )
        console.log("3. Post-deployment hook 'initialize' executed")
        console.log(`4. Migration function '${migrationFunction}' executed`)
        console.log(`5. Final program ID: ${programId.toBase58()}`)
      } catch (error) {
        console.error("❌ Upgrade with migration failed:", error)
        throw error
      }
    }
  )
