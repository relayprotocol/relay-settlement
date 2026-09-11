import { readFileSync } from "fs"
import {
  checksumAddress,
  createPublicClient,
  encodeFunctionData,
  getAddress,
  getContract,
  http,
  keccak256,
  parseEther,
  serializeTransaction,
  encodePacked,
  fromHex,
  type PublicClient,
  type WalletClient,
} from "viem"
import { z } from "zod"
import * as bitcoin from "bitcoinjs-lib"
import { RelayMultisigSigner as RelayMultisigSignerAbi } from "@relay-protocol/settlement-abis"
import { networks } from "@relay-protocol/settlement-networks"
import {
  Connection,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
  TransactionInstruction,
  SystemProgram,
  NonceAccount,
} from "@solana/web3.js"
import * as tronweb from "tronweb"
import { buildBitcoinTransactionFromPayload } from "../crypto/bitcoin"
import { wait } from "../crypto/wait"
import { extractNearSignature } from "../crypto/near"

const ethereumAddress = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, "Must be a valid hex Ethereum address")
  .superRefine((val, ctx) => {
    try {
      getAddress(val)
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Invalid Ethereum checksum address",
      })
    }
  })
  .transform((val) => val as `0x${string}`)

const hex0x = z
  .string()
  .regex(/^0x[0-9a-fA-F]*$/, "Must be a 0x-prefixed hex string")
  .transform((val) => val as `0x${string}`)

const integerString = z
  .string()
  .regex(/^[0-9]+$/, "Must be a non-negative integer string")

const decimalString = z
  .string()
  .regex(/^[0-9]+(\.[0-9]+)?$/, "Must be a decimal number string")

export const EthereumTxSchema = z.object({
  amount: decimalString,
  calldata: hex0x,
  family: z.literal("ethereum-vm"),
  from: ethereumAddress,
  gas: integerString,
  gasPrice: integerString.optional(),
  maxFeePerGas: integerString.optional(),
  maxPriorityFeePerGas: integerString.optional(),
  nonce: z.number().int().nonnegative(),
  rpc: z.string().url(),
  to: ethereumAddress,
})

const BitcoinTxInputSchema = z.object({
  scriptPubKey: z.string(),
  txid: z.string(),
  value: z.number(),
  vout: z.number(),
})

const BitcoinTxOutputSchema = z.object({
  address: z.string(),
  value: z.number(),
})

export const BitcoinTxSchema = z.object({
  family: z.literal("bitcoin-vm"),
  feeRate: z.number().optional(),
  inputs: z.array(BitcoinTxInputSchema),
  network: z.enum(["mainnet", "testnet"]).optional(),
  outputs: z.array(BitcoinTxOutputSchema),
})

const solanaPublicKey = z
  .string()
  .regex(
    /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
    "Must be a valid base58 Solana public key"
  )
  .superRefine((val, ctx) => {
    try {
      new PublicKey(val)
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Invalid Solana public key",
      })
    }
  })

const tronAddress = z
  .string()
  .regex(
    /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
    "Must be a valid base58 Tron address starting with T"
  )
  .superRefine((val, ctx) => {
    try {
      const isValid = tronweb.utils.address.isAddress(val)
      if (!isValid) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Invalid Tron address",
        })
      }
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Invalid Tron address format",
      })
    }
  })

const TransferContractSchema = z.object({
  amount: z.number(),
  owner_address: z.string(),
  to_address: z.string(),
})

const TriggerSmartContractSchema = z.object({
  call_token_value: z.number().optional(),
  call_value: z.number().optional(),
  contract_address: z.string(),
  data: z.string().optional(),
  owner_address: z.string(),
  token_id: z.number().optional(),
})

export const SolanaTxSchema = z
  .object({
    addressLookupTableAddresses: z.array(solanaPublicKey).optional(),
    computeUnitLimit: integerString.optional(),
    computeUnitPrice: integerString.optional(),
    family: z.literal("solana-vm"),
    from: solanaPublicKey,
    instructions: z.array(
      z.object({
        data: z.string(),
        keys: z.array(
          z.object({
            isSigner: z.boolean(),
            isWritable: z.boolean(),
            pubkey: solanaPublicKey,
          })
        ),
        programId: solanaPublicKey,
      })
    ),
    nonceAccount: solanaPublicKey.optional(),
    nonceAccountAuth: solanaPublicKey.optional(),
    rpc: z.string().url(),
  })
  .refine(
    (data) => {
      const hasNonceAccount = !!data.nonceAccount
      const hasNonceAuth = !!data.nonceAccountAuth
      return hasNonceAccount === hasNonceAuth
    },
    {
      message:
        "nonceAccount and nonceAccountAuth must both be provided when using Durable Nonce",
      path: ["nonceAccount"],
    }
  )

const TronTxBaseSchema = z.object({
  expiration: z.number().int().optional(),
  family: z.literal("tron-vm"),
  feeLimit: integerString.optional(),
  from: tronAddress,
  memo: z.string().optional(),
  permissionId: z.number().int().nonnegative().default(0),
  refBlockBytes: z.string().optional(),
  refBlockHash: z.string().optional(),
  rpc: z.string().url(),
  timestamp: z.number().int().optional(),
})

export const TronTxSchema = z.discriminatedUnion("contractType", [
  TronTxBaseSchema.extend({
    contractType: z.literal("TransferContract"),
    parameter: TransferContractSchema,
  }),
  TronTxBaseSchema.extend({
    contractType: z.literal("TriggerSmartContract"),
    parameter: TriggerSmartContractSchema,
  }),
])

export const TransactionSchema = z.discriminatedUnion("family", [
  EthereumTxSchema,
  SolanaTxSchema,
  BitcoinTxSchema,
  TronTxSchema,
])

export type Transaction = z.infer<typeof TransactionSchema>

export const TransactionsSchema = z.array(TransactionSchema)

// Highest nonce built per (sender, chain) in this process: the pre-check below must
// stay correct whether earlier txs were awaited (on-chain count already moved) or
// fired without waiting (count still lags) -- a running offset double counts the former.
const nextNonces: Record<string, Record<number, number>> = {}

export type BuildTransactionResult = {
  hashesToSign: readonly `0x${string}`[]
  payload: `0x${string}`
  transaction: any
}

export const hasEvmTransactionBeenExecuted = async (
  tx: z.infer<typeof EthereumTxSchema>
) => {
  const networkClient = createPublicClient({
    transport: http(tx.rpc),
  })

  const nonce = await networkClient.getTransactionCount({
    address: tx.from,
  })

  return nonce > tx.nonce
}

export const hasBitcoinTransactionBeenExecuted = async (
  tx: z.infer<typeof BitcoinTxSchema>
) => {
  const baseUrl =
    tx.network === "mainnet"
      ? "https://mempool.space/api"
      : "https://mempool.space/testnet/api"

  for (const input of tx.inputs) {
    const utxoRes = await fetch(
      `${baseUrl}/tx/${input.txid}/outspend/${input.vout}`
    )
    if (!utxoRes.ok) {
      return false
    }

    const spendData = (await utxoRes.json()) as { spent: boolean }
    if (spendData.spent) {
      return true
    }
  }

  return false
}

export const buildEvmTransaction = async (
  tx: z.infer<typeof EthereumTxSchema>
): Promise<BuildTransactionResult> => {
  const networkClient = createPublicClient({
    transport: http(tx.rpc),
  })
  const chainId = await networkClient.getChainId()

  const nonce = await networkClient.getTransactionCount({
    address: tx.from,
  })
  if (!nextNonces[tx.from]) {
    nextNonces[tx.from] = {}
  }
  const expectedNonce = Math.max(nonce, nextNonces[tx.from][chainId] ?? 0)
  if (tx.nonce < expectedNonce) {
    // A nonce below the expected one is already used and can never execute.
    throw new Error(
      `❌ Nonce too low: the transaction nonce is ${tx.nonce} but the current nonce is ${expectedNonce}. This tx will not be executed!`
    )
  }
  if (tx.nonce > expectedNonce) {
    // A nonce ahead of the expected one is valid as long as the gap is filled
    // by earlier transactions queued from the same sender (e.g. a prior
    // manifest that has not been executed yet).
    console.warn(
      `⚠️  Transaction nonce ${tx.nonce} is ahead of the current nonce ${expectedNonce} for ${tx.from} on chain ${chainId}. This relies on ${tx.nonce - expectedNonce} earlier queued transaction(s) executing first.`
    )
  }
  const raw = {
    chainId,
    data: tx.calldata,
    from: tx.from,
    gas: BigInt(tx.gas),
    nonce: tx.nonce,
    to: tx.to,
    value: parseEther(tx.amount),
  }

  try {
    await networkClient.estimateGas({
      account: tx.from,
      ...raw,
      // Estimate against the current on-chain nonce rather than this tx's
      // (possibly future) nonce. Some nodes reject eth_estimateGas when the
      // supplied nonce isn't the expected next one, which would break every
      // bundled tx after the first.
      nonce,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `❌ Ethereum transaction failed: ${JSON.stringify(tx)}, ${message}`
    )
  }

  nextNonces[tx.from][chainId] = Math.max(
    nextNonces[tx.from][chainId] ?? 0,
    tx.nonce + 1
  )

  // Pick the correct transaction type from the manifest's fee fields. Not
  // every chain supports EIP-1559 (e.g. Metis), and those chains can only
  // process legacy transactions priced with `gasPrice`. The manifest signals
  // this: a `gasPrice` means a legacy (type 0) transaction, otherwise an
  // EIP-1559 (type 2) transaction. We must forward only the fields matching
  // the chosen type — mixing them makes viem infer the wrong type, producing a
  // signed payload that can never be broadcast.
  const feeFields: {
    gasPrice?: bigint
    maxFeePerGas?: bigint
    maxPriorityFeePerGas?: bigint
  } = tx.gasPrice
    ? { gasPrice: BigInt(tx.gasPrice) }
    : {
        maxFeePerGas: tx.maxFeePerGas ? BigInt(tx.maxFeePerGas) : undefined,
        maxPriorityFeePerGas: tx.maxPriorityFeePerGas
          ? BigInt(tx.maxPriorityFeePerGas)
          : undefined,
      }

  const transaction = {
    ...raw,
    ...feeFields,
  }

  const payload = serializeTransaction(transaction as any)
  const hashToSign = keccak256(payload)

  return {
    hashesToSign: [hashToSign],
    payload,
    transaction,
  }
}

type BitcoinTransactionPayload = {
  fee: number
  feeRate: number
  inputs: Array<{
    index: `0x${string}`
    script: `0x${string}`
    txid: `0x${string}`
    value: `0x${string}`
  }>
  locktime: number
  outputs: Array<{
    script: `0x${string}`
    value: `0x${string}`
  }>
  version: number
}

export async function buildBitcoinTransaction(
  schema: z.infer<typeof BitcoinTxSchema>
): Promise<BuildTransactionResult> {
  const network =
    schema.network === "mainnet"
      ? bitcoin.networks.bitcoin
      : bitcoin.networks.testnet

  if (schema.inputs.length === 0) {
    throw new Error("Transaction must have at least one input")
  }

  if (schema.outputs.length === 0) {
    throw new Error("Transaction must have at least one output")
  }

  for (const input of schema.inputs) {
    if (!/^[0-9a-fA-F]+$/.test(input.scriptPubKey)) {
      throw new Error(
        `Invalid scriptPubKey format for input ${input.txid}:${input.vout}`
      )
    }
  }

  for (const input of schema.inputs) {
    if (!/^[0-9a-fA-F]{64}$/.test(input.txid)) {
      throw new Error(`Invalid transaction ID format: ${input.txid}`)
    }
  }

  const baseUrl =
    schema.network === "mainnet"
      ? "https://mempool.space/api"
      : "https://mempool.space/testnet/api"

  for (const input of schema.inputs) {
    const txRes = await fetch(`${baseUrl}/tx/${input.txid}`)
    if (!txRes.ok) {
      throw new Error(`Transaction ${input.txid} not found`)
    }

    const txData = (await txRes.json()) as {
      vout: Array<{ value: number; scriptpubkey: string }>
      status?: { confirmed?: boolean }
    }

    if (input.vout >= txData.vout.length) {
      throw new Error(
        `Output ${input.vout} does not exist in transaction ${input.txid}`
      )
    }

    const output = txData.vout[input.vout]

    if (output.value !== input.value) {
      throw new Error(
        `Value mismatch for ${input.txid}:${input.vout} - expected ${input.value}, found ${output.value}`
      )
    }

    if (output.scriptpubkey !== input.scriptPubKey) {
      throw new Error(
        `scriptPubKey mismatch for ${input.txid}:${input.vout} - expected ${input.scriptPubKey}, found ${output.scriptpubkey}`
      )
    }

    const utxoRes = await fetch(
      `${baseUrl}/tx/${input.txid}/outspend/${input.vout}`
    )
    if (utxoRes.ok) {
      const spendData = (await utxoRes.json()) as {
        spent: boolean
        txid?: string
      }
      if (spendData.spent) {
        throw new Error(
          `UTXO ${input.txid}:${input.vout} is already spent in transaction ${spendData.txid}`
        )
      }
    }

    if (!txData.status?.confirmed) {
      console.log(`  ⚠️  UTXO ${input.txid}:${input.vout} is unconfirmed`)
    }
  }

  const totalInputValue = schema.inputs.reduce(
    (sum, input) => sum + input.value,
    0
  )

  const totalOutputValue = schema.outputs.reduce(
    (sum, output) => sum + output.value,
    0
  )

  const fee = totalInputValue - totalOutputValue

  if (fee < 0) {
    throw new Error("Insufficient funds: output value exceeds input value")
  }

  const estimatedInputSize = schema.inputs.length * 148
  const estimatedOutputSize = schema.outputs.length * 34
  const estimatedSize = 10 + estimatedInputSize + estimatedOutputSize
  const feeRate = schema.feeRate || 1
  const recommendedFee = Math.ceil(estimatedSize * feeRate)

  if (fee < recommendedFee) {
    console.log(
      `  ⚠️  Fee (${fee} sats) is below recommended (${recommendedFee} sats) for ${feeRate} sat/vByte`
    )
  }

  for (const output of schema.outputs) {
    try {
      bitcoin.address.toOutputScript(output.address, network)
    } catch {
      throw new Error(
        `Invalid Bitcoin address: ${output.address}. Are you sure this is the correct network?`
      )
    }
  }

  const transaction: BitcoinTransactionPayload = {
    fee,
    feeRate: schema.feeRate || 1,
    inputs: schema.inputs.map((input) => {
      const indexBuffer = Buffer.alloc(4)
      indexBuffer.writeUInt32LE(input.vout, 0)

      const valueBuffer = Buffer.alloc(8)
      valueBuffer.writeBigUInt64LE(BigInt(input.value), 0)

      return {
        index: `0x${indexBuffer.toString("hex")}`,
        script: `0x${input.scriptPubKey}`,
        txid: `0x${Buffer.from(input.txid, "hex").reverse().toString("hex")}`,
        value: `0x${valueBuffer.toString("hex")}`,
      }
    }),
    locktime: 0,
    outputs: schema.outputs.map((output) => {
      let script: Buffer
      try {
        script = bitcoin.address.toOutputScript(output.address, network)
      } catch {
        const fallbackNetwork =
          network === bitcoin.networks.bitcoin
            ? bitcoin.networks.testnet
            : bitcoin.networks.bitcoin
        script = bitcoin.address.toOutputScript(output.address, fallbackNetwork)
      }

      const valueBuffer = Buffer.alloc(8)
      valueBuffer.writeBigUInt64LE(BigInt(output.value), 0)

      return {
        script: `0x${script.toString("hex")}`,
        value: `0x${valueBuffer.toString("hex")}`,
      }
    }),
    version: 1,
  }
  const tx = buildBitcoinTransactionFromPayload(transaction)

  const hashesToSign = transaction.inputs.map((input, index) => {
    const scriptPubKey = Buffer.from(schema.inputs[index].scriptPubKey, "hex")
    const sighash = tx.hashForSignature(
      index,
      scriptPubKey,
      bitcoin.Transaction.SIGHASH_ALL
    )
    return `0x${sighash.toString("hex")}` as const
  })

  const unsignedTransaction = `0x${tx.toHex()}` as const

  return {
    hashesToSign,
    payload: unsignedTransaction,
    transaction,
  }
}

export const buildSolanaTransaction = async (
  tx: z.infer<typeof SolanaTxSchema>
): Promise<BuildTransactionResult> => {
  const connection = new Connection(tx.rpc, "confirmed")

  console.log(tx)

  const instructions = tx.instructions.map(
    (instruction) =>
      new TransactionInstruction({
        data: Buffer.from(instruction.data, "hex"),
        keys: instruction.keys.map((key) => ({
          isSigner: key.isSigner,
          isWritable: key.isWritable,
          pubkey: new PublicKey(key.pubkey),
        })),
        programId: new PublicKey(instruction.programId),
      })
  )

  const addressLookupTableAccounts = tx.addressLookupTableAddresses
    ? await Promise.all(
        tx.addressLookupTableAddresses.map(async (address) => {
          const result = await connection.getAddressLookupTable(
            new PublicKey(address)
          )
          if (!result.value) {
            throw new Error(`Address lookup table not found: ${address}`)
          }
          return result.value
        })
      )
    : []

  let blockhash: string
  let nonceInfo: { account: PublicKey; authority: PublicKey } | null = null

  if (tx.nonceAccount && tx.nonceAccountAuth) {
    const nonceAccount = new PublicKey(tx.nonceAccount)
    const nonceAccountAuth = new PublicKey(tx.nonceAccountAuth)

    const nonceAccountInfo = await connection.getAccountInfo(nonceAccount)
    if (!nonceAccountInfo) {
      throw new Error(`Nonce account not found: ${tx.nonceAccount}`)
    }

    const nonceAccountData = NonceAccount.fromAccountData(nonceAccountInfo.data)

    if (nonceAccountData.authorizedPubkey.toBase58() !== tx.nonceAccountAuth) {
      throw new Error(
        `Nonce authority mismatch. Account authority: ${nonceAccountData.authorizedPubkey.toBase58()}, Expected: ${tx.nonceAccountAuth}`
      )
    }

    blockhash = nonceAccountData.nonce

    nonceInfo = { account: nonceAccount, authority: nonceAccountAuth }
  } else {
    throw new Error(
      "❌ Durable nonce is required for Solana transactions. Please provide nonceAccount and nonceAccountAuth fields."
    )
  }

  const allInstructions = []

  if (nonceInfo) {
    allInstructions.push(
      SystemProgram.nonceAdvance({
        authorizedPubkey: nonceInfo.authority,
        noncePubkey: nonceInfo.account,
      })
    )
  }

  if (tx.computeUnitLimit) {
    allInstructions.push(
      ComputeBudgetProgram.setComputeUnitLimit({
        units: parseInt(tx.computeUnitLimit),
      })
    )
  }
  if (tx.computeUnitPrice) {
    allInstructions.push(
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: parseInt(tx.computeUnitPrice),
      })
    )
  }

  allInstructions.push(...instructions)

  const messageV0 = new TransactionMessage({
    instructions: allInstructions,
    payerKey: new PublicKey(tx.from),
    recentBlockhash: blockhash,
  }).compileToV0Message(addressLookupTableAccounts)

  const versionedTransaction = new VersionedTransaction(messageV0)

  try {
    const simulationResult =
      await connection.simulateTransaction(versionedTransaction)
    if (simulationResult.value.err) {
      throw new Error(
        `Simulation failed: ${JSON.stringify(simulationResult.value.err)}`
      )
    }
  } catch (error: any) {
    console.error("❌ Solana transaction simulation failed:", tx, error.message)
  }

  const messageBytes = versionedTransaction.message.serialize()
  const payload = ("0x" +
    Buffer.from(messageBytes).toString("hex")) as `0x${string}`
  return {
    hashesToSign: [payload],
    payload: payload,
    transaction: versionedTransaction,
  }
}

export const buildTronTransaction = async (
  tx: z.infer<typeof TronTxSchema>
): Promise<BuildTransactionResult> => {
  const tronWeb = new tronweb.TronWeb({
    fullHost: tx.rpc,
    fullNode: new tronweb.providers.HttpProvider(tx.rpc),
  })

  const options: any = {}

  if (
    !tx.refBlockBytes ||
    !tx.refBlockHash ||
    !tx.timestamp ||
    !tx.expiration
  ) {
    const block = await tronWeb.trx.getCurrentBlock()
    const blockNum = block.block_header.raw_data.number
    options.ref_block_bytes =
      tx.refBlockBytes || blockNum.toString(16).slice(-4).padStart(4, "0")
    options.ref_block_hash = tx.refBlockHash || block.blockID.slice(16, 32)
    const blockTimestamp = block.block_header.raw_data.timestamp
    options.timestamp = tx.timestamp || blockTimestamp
    options.expiration = tx.expiration || blockTimestamp + 60 * 60 * 5 * 1000
  } else {
    options.ref_block_bytes = tx.refBlockBytes
    options.ref_block_hash = tx.refBlockHash
    options.timestamp = tx.timestamp
    options.expiration = tx.expiration
  }

  options.fee_limit = parseInt(tx.feeLimit || "1000000")

  if (tx.memo) {
    options.data = Buffer.from(tx.memo).toString("hex")
  }

  const parameterValue: Record<string, any> = { ...tx.parameter }

  Object.keys(parameterValue).forEach((key) => {
    const value = parameterValue[key]
    if (typeof value === "string" && value.startsWith("T")) {
      parameterValue[key] = tronWeb.address.toHex(value)
    }
  })

  const transaction: any = {
    raw_data: {
      contract: [
        {
          parameter: {
            type_url: `type.googleapis.com/protocol.${tx.contractType}`,
            value: parameterValue,
          },
          type: tx.contractType,
        },
      ],
      ...options,
    },
    raw_data_hex: "",
    txID: "",
    visible: false,
  }

  if (tx.permissionId && tx.permissionId > 0) {
    transaction.raw_data.contract[0].Permission_id = tx.permissionId
  }

  const pb = tronweb.utils.transaction.txJsonToPb(transaction)
  transaction.txID = tronweb.utils.transaction.txPbToTxID(pb).replace(/^0x/, "")
  transaction.raw_data_hex = tronweb.utils.transaction
    .txPbToRawDataHex(pb)
    .toLowerCase()

  try {
    const account = await tronWeb.trx.getAccount(tx.from)
    if (!account || !account.address) {
      throw new Error(`Account ${tx.from} does not exist`)
    }

    const accountResources = await tronWeb.trx.getAccountResources(tx.from)
    console.log("📊 Account resources:", {
      EnergyLimit: accountResources.EnergyLimit || 0,
      EnergyUsed: accountResources.EnergyUsed || 0,
      NetLimit: accountResources.NetLimit || 0,
      NetUsed: accountResources.NetUsed || 0,
      freeNetLimit: accountResources.freeNetLimit || 0,
      freeNetUsed: accountResources.freeNetUsed || 0,
    })

    if (tx.contractType === "TriggerSmartContract") {
      const { contract_address, data } = tx.parameter
      if (contract_address && data) {
        try {
          await tronWeb.transactionBuilder.triggerConstantContract(
            contract_address,
            "",
            {
              callValue: tx.parameter.call_value ?? 0,
              input: data,
            },
            [],
            tx.from
          )
          console.log("✅ Smart contract call simulation passed")
        } catch (error: any) {
          console.warn("⚠️  Smart contract simulation warning:", error.message)
        }
      }
    }
  } catch (error: any) {
    console.error("❌ Tron transaction simulation failed:", tx, error.message)
    throw new Error(`Tron transaction validation failed: ${error.message}`)
  }

  const hashToSign = `0x${transaction.txID}` as const
  const payload = `0x${transaction.raw_data_hex}` as const

  return {
    hashesToSign: [hashToSign],
    payload,
    transaction,
  }
}

// Replaces manifest `rpc` values at load time using the comma-separated
// `from=to` URL pairs in RPC_OVERRIDES (the replacement must serve the same chain).
const applyRpcOverrides = (
  transactions: z.infer<typeof TransactionsSchema>
) => {
  const spec = process.env.RPC_OVERRIDES
  if (!spec) return transactions

  const overrides = new Map<string, string>()
  for (const pair of spec.split(",")) {
    const separator = pair.indexOf("=")
    const from = pair.slice(0, separator).trim()
    const to = pair.slice(separator + 1).trim()
    if (separator < 1 || !from || !to) {
      throw new Error(
        `RPC_OVERRIDES entry "${pair}" must be "<fromUrl>=<toUrl>"`
      )
    }
    overrides.set(from, to)
  }

  return transactions.map((tx) => {
    if ("rpc" in tx && overrides.has(tx.rpc)) {
      const rpc = overrides.get(tx.rpc)!
      console.log(`🔁 RPC override: ${tx.rpc} -> ${rpc}`)
      return { ...tx, rpc }
    }
    return tx
  })
}

export function loadTransactions(path: string) {
  const raw = readFileSync(path, "utf8")
  const data: unknown = JSON.parse(raw)

  return applyRpcOverrides(TransactionsSchema.parse(data))
}

const getChainNameFromTransaction = (tx: Transaction): string => {
  if ("rpc" in tx) {
    for (const [, network] of Object.entries(networks)) {
      if (network.rpc.includes(tx.rpc)) {
        return network.name || network.slug
      }
    }
    const url = new URL(tx.rpc)
    return url.hostname.split(".")[0] || "unknown"
  }
  if (tx.family === "bitcoin-vm") {
    return tx.network === "mainnet" ? "Bitcoin" : "Bitcoin Testnet"
  }
  return "unknown"
}

export const createTransactionBundle = async (
  transactionsPath: string,
  relayMultisigSignerAddress: `0x${string}`
) => {
  const transactions = loadTransactions(transactionsPath)

  const transactionBundle: Array<{
    data: `0x${string}`
    to: `0x${string}`
    value: string
  }> = []

  for (let i = 0; i < transactions.length; i++) {
    const tx = transactions[i]
    let result
    let curve: "Ecdsa" | "Eddsa"
    if (tx.family === "ethereum-vm") {
      result = await buildEvmTransaction(EthereumTxSchema.parse(tx))
      curve = "Ecdsa"
    } else if (tx.family === "bitcoin-vm") {
      result = await buildBitcoinTransaction(BitcoinTxSchema.parse(tx))
      curve = "Ecdsa"
    } else if (tx.family === "solana-vm") {
      result = await buildSolanaTransaction(
        tx as z.infer<typeof SolanaTxSchema>
      )
      curve = "Eddsa"
    } else if (tx.family === "tron-vm") {
      result = await buildTronTransaction(tx as z.infer<typeof TronTxSchema>)
      curve = "Ecdsa"
    } else {
      throw new Error(
        `Unsupported transaction family: ${(tx as Transaction).family}. Please add support!`
      )
    }

    const chainName = getChainNameFromTransaction(tx)
    result.hashesToSign.forEach((hash, index) => {
      const useRawData = tx.family === "solana-vm"
      console.log(
        `🏗️  Building ${useRawData ? "raw data" : "hash"} #${index} for tx #${i} (${chainName} - ${tx.family}) : ${hash}`
      )
      const transactionForBundle = encodeSignatureCall(
        hash,
        curve,
        relayMultisigSignerAddress,
        useRawData
      )
      transactionBundle.push(transactionForBundle)
    })
  }
  return transactionBundle
}

const encodeSignatureCall = (
  hashToSign: `0x${string}`,
  curve: "Ecdsa" | "Eddsa",
  relayMultisigSignerAddress: `0x${string}`,
  useRawData: boolean = false
) => {
  const data = useRawData ? hashToSign : encodePacked(["bytes32"], [hashToSign])

  const callData = encodeFunctionData({
    abi: RelayMultisigSignerAbi,
    args: [data, curve],
    functionName: "approveSignature",
  })

  return {
    data: callData,
    to: checksumAddress(relayMultisigSignerAddress),
    value: "0",
  }
}

const signGas = 50_000_000_000_000n
const callbackGas = 30_000_000_000_000n

export const getSignatureForHash = async (
  relayMultisigSignerAddress: `0x${string}`,
  hashToSign: string,
  curve: string,
  clients: { publicClient: PublicClient; walletClient: WalletClient },
  raw: boolean = false
): Promise<string> => {
  const multisigSigner = getContract({
    abi: RelayMultisigSignerAbi,
    address: relayMultisigSignerAddress,
    client: { public: clients.publicClient, wallet: clients.walletClient },
  })

  const data = raw
    ? (hashToSign as `0x${string}`)
    : encodePacked(["bytes32"], [hashToSign as `0x${string}`])

  const signatureKey = keccak256(data)
  let nearSignature = (await multisigSigner.read.signatures([
    signatureKey,
    curve,
  ])) as `0x${string}`

  if (nearSignature === "0x") {
    const approved = (await multisigSigner.read.approvedSignatures([
      signatureKey,
      curve,
    ])) as boolean
    if (!approved) {
      throw new Error(
        `❌ ${raw ? "Raw data" : "Hash"} signature not approved...`
      )
    }

    console.log(`📝 Requesting ${raw ? "raw data" : "hash"} signature...`, {
      curve,
      [raw ? "rawData" : "hashToSign"]: hashToSign,
      ...(raw ? { dataHash: signatureKey } : {}),
    })

    const txHash = await multisigSigner.write.sign([
      data,
      curve,
      signGas,
      callbackGas,
    ])

    await clients.publicClient.waitForTransactionReceipt({
      hash: txHash,
    })
  }

  while (nearSignature === "0x") {
    console.log(`Waiting for signed ${raw ? "raw data" : "hash"}...`)
    await wait(1)
    nearSignature = (await multisigSigner.read.signatures([
      signatureKey,
      curve,
    ])) as `0x${string}`
  }

  const jsonSignature = JSON.parse(fromHex(nearSignature, "string"))
  if (jsonSignature.scheme === "Ed25519") {
    return "0x" + Buffer.from(jsonSignature.signature).toString("hex")
  }

  const { r, s, v } = extractNearSignature(nearSignature)
  const hexSignature =
    `0x${r}${s}${v.toString(16).padStart(2, "0")}` as `0x${string}`

  return hexSignature
}
