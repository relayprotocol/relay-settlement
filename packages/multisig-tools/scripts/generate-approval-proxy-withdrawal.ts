// Generate an ApprovalProxy withdrawal and optional onward ERC-20 transfer.
// All RPC operations are read-only; no key, signature, or broadcast is involved.
import { Command } from "commander"
import { mkdirSync, renameSync, writeFileSync } from "fs"
import { dirname, resolve } from "path"
import {
  createPublicClient,
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  http,
  parseAbi,
  zeroAddress,
} from "viem"
import { stringifyJsonWithBigInt } from "./helpers/manifest"
import { simulateEvmSequence } from "../src/helpers/evmSimulation"

type WithdrawalOptions = {
  chainId: number
  expectedBalance: bigint
  expectedOwner: string
  proxy: string
  recipient?: string
  rpc: string
  token: string
}

const abi = parseAbi([
  "function owner() view returns (address)",
  "function balanceOf(address) view returns (uint256)",
  "function withdraw(address)",
  "function transfer(address,uint256) returns (bool)",
])

export async function generateWithdrawal(options: WithdrawalOptions) {
  if (!Number.isSafeInteger(options.chainId) || options.chainId <= 0) {
    throw new Error("Chain ID must be a positive safe integer")
  }
  if (options.expectedBalance <= 0n) {
    throw new Error("Expected balance must be positive (token base units)")
  }
  const proxy = getAddress(options.proxy)
  const token = getAddress(options.token)
  const expectedOwner = getAddress(options.expectedOwner)
  const recipient = options.recipient
    ? getAddress(options.recipient)
    : undefined
  if (
    recipient &&
    [zeroAddress, proxy, token, expectedOwner].includes(recipient)
  ) {
    throw new Error("Recipient must differ from zero, proxy, token, and owner")
  }
  const client = createPublicClient({ transport: http(options.rpc) })
  const chainId = await client.getChainId()
  if (chainId !== options.chainId) {
    throw new Error(
      `Chain ID mismatch: expected ${options.chainId}, got ${chainId}`
    )
  }

  const block = await client.getBlock()
  const [proxyCode, tokenCode, owner, balance] = await Promise.all([
    client.getCode({ address: proxy, blockNumber: block.number }),
    client.getCode({ address: token, blockNumber: block.number }),
    client.readContract({
      abi,
      address: proxy,
      blockNumber: block.number,
      functionName: "owner",
    }),
    client.readContract({
      abi,
      address: token,
      args: [proxy],
      blockNumber: block.number,
      functionName: "balanceOf",
    }),
  ])
  if (!proxyCode || proxyCode === "0x" || !tokenCode || tokenCode === "0x") {
    throw new Error("Proxy and token must both have deployed code")
  }
  if (getAddress(owner) !== expectedOwner) {
    throw new Error(`Owner mismatch: expected ${expectedOwner}, got ${owner}`)
  }
  if (balance !== options.expectedBalance) {
    throw new Error(
      `Balance mismatch: expected ${options.expectedBalance}, got ${balance}`
    )
  }

  const calldata = encodeFunctionData({
    abi,
    args: [token],
    functionName: "withdraw",
  })
  const [nonce, gasEstimate, fees] = await Promise.all([
    client.getTransactionCount({ address: expectedOwner, blockTag: "pending" }),
    client.estimateGas({
      account: expectedOwner,
      data: calldata,
      to: proxy,
      value: 0n,
    }),
    block.baseFeePerGas == null
      ? client.estimateFeesPerGas({ chain: null, type: "legacy" })
      : client.estimateFeesPerGas(),
  ])
  const feeFields =
    fees.gasPrice != null
      ? { gasPrice: fees.gasPrice.toString() }
      : {
          maxFeePerGas: fees.maxFeePerGas!.toString(),
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas!.toString(),
        }
  const transaction = {
    amount: "0",
    calldata,
    family: "ethereum-vm" as const,
    from: expectedOwner,
    // 20% headroom, rounded up, for execution after the estimate.
    gas: ((gasEstimate * 120n + 99n) / 100n).toString(),
    ...feeFields,
    nonce,
    rpc: options.rpc,
    to: proxy,
  }
  const transactions = [transaction]
  if (recipient) {
    const transferData = encodeFunctionData({
      abi,
      args: [recipient, options.expectedBalance],
      functionName: "transfer",
    })
    // The owner may have no tokens until withdraw runs. Simulate the real
    // withdrawal before estimating the transfer, without spoofing balances.
    const results = await simulateEvmSequence(
      client,
      [
        {
          data: calldata,
          from: expectedOwner,
          gas: BigInt(transaction.gas),
          to: proxy,
          value: 0n,
        },
        { data: transferData, from: expectedOwner, to: token, value: 0n },
      ],
      block.number
    )
    if (
      !decodeFunctionResult({
        abi,
        data: results[1].data,
        functionName: "transfer",
      })
    ) {
      throw new Error("ERC-20 transfer returned false")
    }
    transactions.push({
      ...transaction,
      calldata: transferData,
      gas: ((results[1].gasUsed * 120n + 99n) / 100n).toString(),
      nonce: nonce + 1,
      to: token,
    })
    // gasUsed includes refunds, so headroom alone is not proof that a limit
    // is sufficient. Replay with the final limits before writing the output.
    const finalResults = await simulateEvmSequence(
      client,
      transactions.map((tx) => ({
        data: tx.calldata,
        from: tx.from,
        gas: BigInt(tx.gas),
        to: tx.to,
        value: 0n,
      })),
      block.number
    )
    if (
      !decodeFunctionResult({
        abi,
        data: finalResults[1].data,
        functionName: "transfer",
      })
    ) {
      throw new Error("ERC-20 transfer returned false")
    }
  }
  return {
    balance,
    blockNumber: block.number,
    chainId,
    gasEstimate,
    transactions,
  }
}

async function main() {
  const options = new Command()
    .description(
      "Generate an ERC-20 ApprovalProxy full-balance withdrawal manifest"
    )
    .requiredOption(
      "--rpc <url>",
      "Destination chain RPC URL stored in the manifest"
    )
    .requiredOption("--chain-id <number>", "Expected destination EVM chain ID")
    .requiredOption("--proxy <address>", "ApprovalProxy to withdraw from")
    .requiredOption("--token <address>", "ERC-20 token to withdraw")
    .option(
      "--recipient <address>",
      "Append a transfer of the expected balance to this recipient"
    )
    .requiredOption(
      "--expected-owner <address>",
      "Expected derived EVM sender / proxy owner"
    )
    .requiredOption(
      "--expected-balance <integer>",
      "Expected full token balance in base units"
    )
    .requiredOption(
      "--output <path>",
      "Manifest path to create or replace after validation"
    )
    .parse()
    .opts<{
      chainId: string
      expectedBalance: string
      expectedOwner: string
      output: string
      proxy: string
      recipient?: string
      rpc: string
      token: string
    }>()
  if (!/^[0-9]+$/.test(options.expectedBalance)) {
    throw new Error("Expected balance must be an integer in token base units")
  }
  const result = await generateWithdrawal({
    ...options,
    chainId: Number(options.chainId),
    expectedBalance: BigInt(options.expectedBalance),
  })
  const output = resolve(options.output)
  mkdirSync(dirname(output), { recursive: true })
  const temporaryPath = `${output}.${process.pid}.tmp`
  writeFileSync(
    temporaryPath,
    `${stringifyJsonWithBigInt(result.transactions)}\n`
  )
  renameSync(temporaryPath, output)
  console.info(`Generated ${output}`)
  console.info(stringifyJsonWithBigInt(result))
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
