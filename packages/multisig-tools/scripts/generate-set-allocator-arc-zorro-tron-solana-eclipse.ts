/**
 * Generates a multisig manifest that calls `setAllocator` on the RelayDepository
 * of each of these chains, pointing them at the new allocator for their VM:
 *
 *   arc     (ethereum-vm) -> 0x63C1d3E9C646184529C5694630a01C00dF171b56
 *   zorro   (ethereum-vm) -> 0x63C1d3E9C646184529C5694630a01C00dF171b56
 *   tron    (tron-vm)     -> 0x5D7A4a396FB6c1170432ca22C8aC3377E99c28c5
 *   solana  (solana-vm)   -> HuAjVESMnrR2wuthKHeAsJeDsfN2jKUEi7TCcZC7eW6Z
 *   eclipse (solana-vm)   -> HuAjVESMnrR2wuthKHeAsJeDsfN2jKUEi7TCcZC7eW6Z
 *
 * `setAllocator` lives on each chain's depository (spoke side), so every
 * transaction targets that chain's own RPC. The depository owner that must
 * authorize the call was read on-chain and is the same Relay multisig in each
 * VM's address form:
 *   evm/tron owner == 0xF61A305199fa1135d76FFaB3752D42F55cBd775A
 *                  == TYQUbsiQjJoDCyP2Au22kHCGb6AbEJAbJp (tron form)
 *   solana/eclipse owner == 6Bz8AWWipCDf7XCSqNuRXrEtKZM5M4Y56uP9ZRjSaMWD
 *
 * arc and zorro are private app-chains with no public RPC in this repo; set
 * RPC_ARC / RPC_ZORRO to include them (the calldata + signer are already known,
 * the RPC is only needed to estimate gas + nonce). Chains whose required RPC is
 * missing are skipped with a warning.
 *
 * Solana durable nonce is optional here (schema-wise) but is required to
 * *execute* a Solana tx via the multisig signer; provide
 * SOLANA_NONCE_ACCOUNT / SOLANA_NONCE_AUTH (and the Eclipse equivalents) to
 * embed one.
 *
 * Usage:
 *   RPC_ARC=... RPC_ZORRO=... yarn workspace @relay-settlement/multisig-tools \
 *     tsx scripts/generate-set-allocator-arc-zorro-tron-solana-eclipse.ts \
 *     > transactions/051-set-allocator-arc-zorro-tron-solana-eclipse.json
 */
import { PublicKey } from "@solana/web3.js"
import bs58 from "bs58"
import {
  createPublicClient,
  encodeFunctionData,
  getAddress,
  http,
  parseAbi,
  parseEther,
} from "viem"

// --- New allocators, per VM family -----------------------------------------

const EVM_ALLOCATOR = getAddress("0x63C1d3E9C646184529C5694630a01C00dF171b56")
const TRON_ALLOCATOR = getAddress("0x5D7A4a396FB6c1170432ca22C8aC3377E99c28c5")
const SOLANA_ALLOCATOR = "HuAjVESMnrR2wuthKHeAsJeDsfN2jKUEi7TCcZC7eW6Z"

// --- Depositories + owners (read from chains.txt / on-chain) ----------------

const EVM_DEPOSITORY = getAddress("0x4cD00E387622C35bDDB9b4c962C136462338BC31")
const EVM_OWNER = getAddress("0xF61A305199fa1135d76FFaB3752D42F55cBd775A")

const TRON_DEPOSITORY = "TXtEs6t2oUWQsNos7m68gbHdE9Q5n6x2oN"
const TRON_OWNER = "TYQUbsiQjJoDCyP2Au22kHCGb6AbEJAbJp"
const TRON_RPC = "https://api.trongrid.io"

// Same depository program id + owner on Solana and Eclipse.
const SOLANA_DEPOSITORY_PROGRAM = "99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2"
const SOLANA_OWNER = "6Bz8AWWipCDf7XCSqNuRXrEtKZM5M4Y56uP9ZRjSaMWD"

// Anchor `set_allocator` discriminator (RelayDepository IDL).
const SET_ALLOCATOR_DISCRIMINATOR = Buffer.from([
  92, 128, 130, 234, 227, 249, 182, 17,
])

const SET_ALLOCATOR_ABI = parseAbi(["function setAllocator(address allocator)"])

// --- Builders ---------------------------------------------------------------

const REDACTED_RPC = "[REDACTED-INTERNAL-RPC]"

const buildEvmTx = async (estimateRpc: string, publishRpc: string) => {
  const client = createPublicClient({ transport: http(estimateRpc) })
  const calldata = encodeFunctionData({
    abi: SET_ALLOCATOR_ABI,
    args: [EVM_ALLOCATOR],
    functionName: "setAllocator",
  })
  const [fees, nonce, gas] = await Promise.all([
    client.estimateFeesPerGas(),
    client.getTransactionCount({ address: EVM_OWNER }),
    client.estimateGas({
      account: EVM_OWNER,
      data: calldata,
      to: EVM_DEPOSITORY,
      value: parseEther("0"),
    }),
  ])
  return {
    amount: "0",
    calldata,
    family: "ethereum-vm" as const,
    from: EVM_OWNER,
    gas: gas.toString(),
    maxFeePerGas: fees.maxFeePerGas!.toString(),
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas!.toString(),
    nonce,
    rpc: publishRpc,
    to: EVM_DEPOSITORY,
  }
}

const buildTronTx = () => {
  // ABI-encoded setAllocator(address); Tron expects the data without 0x prefix.
  const data = encodeFunctionData({
    abi: SET_ALLOCATOR_ABI,
    args: [TRON_ALLOCATOR],
    functionName: "setAllocator",
  }).slice(2)
  return {
    contractType: "TriggerSmartContract" as const,
    family: "tron-vm" as const,
    feeLimit: "100000000",
    from: TRON_OWNER,
    parameter: {
      contract_address: TRON_DEPOSITORY,
      data,
      owner_address: TRON_OWNER,
    },
    rpc: TRON_RPC,
  }
}

const buildSolanaTx = (
  rpc: string,
  nonceAccount?: string,
  nonceAuth?: string
) => {
  const programId = new PublicKey(SOLANA_DEPOSITORY_PROGRAM)
  const [relayDepository] = PublicKey.findProgramAddressSync(
    [Buffer.from("relay_depository")],
    programId
  )
  const data = Buffer.concat([
    SET_ALLOCATOR_DISCRIMINATOR,
    Buffer.from(bs58.decode(SOLANA_ALLOCATOR)),
  ]).toString("hex")

  const tx: Record<string, unknown> = {
    computeUnitLimit: "100000",
    computeUnitPrice: "5000",
    family: "solana-vm" as const,
    from: SOLANA_OWNER,
    instructions: [
      {
        data,
        keys: [
          {
            isSigner: false,
            isWritable: true,
            pubkey: relayDepository.toBase58(),
          },
          { isSigner: true, isWritable: false, pubkey: SOLANA_OWNER },
        ],
        programId: SOLANA_DEPOSITORY_PROGRAM,
      },
    ],
    rpc,
  }
  if (nonceAccount && nonceAuth) {
    tx.nonceAccount = nonceAccount
    tx.nonceAccountAuth = nonceAuth
  }
  return tx
}

// --- Assembly ---------------------------------------------------------------

const main = async () => {
  const txs: unknown[] = []

  // arc + zorro (ethereum-vm) — need their RPC to estimate gas + nonce.
  for (const [name, envKey] of [
    ["arc", "RPC_ARC"],
    ["zorro", "RPC_ZORRO"],
  ] as const) {
    const rpc = process.env[envKey]
    if (!rpc) {
      console.error(
        `⚠️  Skipping ${name}: set ${envKey} to its RPC (needed for gas + nonce).`
      )
      continue
    }
    const publishRpc = process.env.REDACT_RPC === "0" ? rpc : REDACTED_RPC
    txs.push(await buildEvmTx(rpc, publishRpc))
    console.error(
      `✓ ${name}: setAllocator(${EVM_ALLOCATOR}) on ${EVM_DEPOSITORY} (rpc: ${publishRpc})`
    )
  }

  // tron (tron-vm)
  txs.push(buildTronTx())
  console.error(`✓ tron: setAllocator(${TRON_ALLOCATOR}) on ${TRON_DEPOSITORY}`)

  // solana + eclipse (solana-vm)
  for (const [name, rpc, nonceEnv, authEnv] of [
    [
      "solana",
      process.env.RPC_SOLANA ?? "https://api.mainnet-beta.solana.com",
      "SOLANA_NONCE_ACCOUNT",
      "SOLANA_NONCE_AUTH",
    ],
    [
      "eclipse",
      process.env.RPC_ECLIPSE ?? "https://mainnetbeta-rpc.eclipse.xyz",
      "ECLIPSE_NONCE_ACCOUNT",
      "ECLIPSE_NONCE_AUTH",
    ],
  ] as const) {
    const nonceAccount = process.env[nonceEnv]
    const nonceAuth = process.env[authEnv]
    txs.push(buildSolanaTx(rpc, nonceAccount, nonceAuth))
    const nonceNote =
      nonceAccount && nonceAuth
        ? "with durable nonce"
        : "NO durable nonce (set for execution)"
    console.error(
      `✓ ${name}: set_allocator(${SOLANA_ALLOCATOR}) — ${nonceNote}`
    )
  }

  console.log(JSON.stringify(txs, null, 2))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
