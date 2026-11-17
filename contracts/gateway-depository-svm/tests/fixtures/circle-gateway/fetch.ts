// ABOUTME: Downloads the Circle Gateway programs and accounts the gateway depository tests run against.
// ABOUTME: Patches the minter's attester and the USDC mint authority to the test keys in constants.ts.

import { secp256k1 } from "@noble/curves/secp256k1"
import { keccak_256 } from "@noble/hashes/sha3"
import { Connection, PublicKey } from "@solana/web3.js"
import { writeFileSync } from "fs"
import { join } from "path"

import {
  GATEWAY_MINTER,
  GATEWAY_MINTER_CUSTODY,
  GATEWAY_MINTER_PROGRAM,
  GATEWAY_WALLET,
  GATEWAY_WALLET_CUSTODY,
  GATEWAY_WALLET_PROGRAM,
  TEST_ATTESTER_PRIVATE_KEY,
  TEST_MINT_AUTHORITY,
  USDC_MINT,
} from "./constants"

const connection = new Connection(
  process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com"
)

// Offset of the program bytes in an upgradeable loader program data account
const PROGRAM_DATA_HEADER_LENGTH = 45

const getAccount = async (address: PublicKey) => {
  const account = await connection.getAccountInfo(address)
  if (!account) {
    throw new Error(`Account ${address.toBase58()} not found`)
  }
  return account
}

const writeProgram = async (program: PublicKey, filename: string) => {
  const [programData] = PublicKey.findProgramAddressSync(
    [program.toBuffer()],
    new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111")
  )
  const { data } = await getAccount(programData)
  writeFileSync(
    join(__dirname, filename),
    data.subarray(PROGRAM_DATA_HEADER_LENGTH)
  )
}

const writeAccount = async (
  address: PublicKey,
  filename: string,
  patch: (data: Buffer) => void = () => {}
) => {
  const account = await getAccount(address)
  patch(account.data)
  writeFileSync(
    join(__dirname, filename),
    JSON.stringify(
      {
        pubkey: address.toBase58(),
        account: {
          lamports: account.lamports,
          data: [account.data.toString("base64"), "base64"],
          owner: account.owner.toBase58(),
          executable: false,
          rentEpoch: 0,
          space: account.data.length,
        },
      },
      null,
      2
    ) + "\n"
  )
}

const main = async () => {
  await writeProgram(GATEWAY_MINTER_PROGRAM, "gateway_minter.so")
  await writeProgram(GATEWAY_WALLET_PROGRAM, "gateway_wallet.so")

  const testAttester = Buffer.from(
    keccak_256(
      secp256k1.getPublicKey(TEST_ATTESTER_PRIVATE_KEY, false).subarray(1)
    )
  ).subarray(12)

  // The minter state holds a single attester, as a 20-byte address followed by 12 zero bytes
  const mainnetAttester = Buffer.from(
    "2d8952b876403b45529cc6ff297912665bd0ee88",
    "hex"
  )
  await writeAccount(GATEWAY_MINTER, "gateway_minter.json", (data) => {
    const offset = data.indexOf(mainnetAttester)
    if (offset < 0 || data.indexOf(mainnetAttester, offset + 1) >= 0) {
      throw new Error("Expected exactly one mainnet attester in the minter")
    }
    testAttester.copy(data, offset)
  })
  await writeAccount(GATEWAY_MINTER_CUSTODY, "gateway_minter_custody.json")
  await writeAccount(GATEWAY_WALLET, "gateway_wallet.json")
  await writeAccount(GATEWAY_WALLET_CUSTODY, "gateway_wallet_custody.json")

  // Mint authority is an optional pubkey at the start of the mint account
  await writeAccount(USDC_MINT, "usdc_mint.json", (data) => {
    data.writeUInt32LE(1, 0)
    TEST_MINT_AUTHORITY.publicKey.toBuffer().copy(data, 4)
  })
}

main()
