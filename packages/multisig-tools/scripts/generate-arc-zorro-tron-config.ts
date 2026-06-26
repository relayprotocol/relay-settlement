/**
 * Generates a multisig manifest that finishes wiring up the `arc`, `zorro` and
 * `tron` chains on the prod Relay Chain deployment:
 *
 *   - Sets the per-chain Config values their payload builders read:
 *       arc   (evm)  -> ETHEREUM_VM_CHAIN_ID
 *       zorro (evm)  -> ETHEREUM_VM_CHAIN_ID
 *       tron  (tvm)  -> TRON_VM_CHAIN_ID, TRON_VM_EXPIRATION
 *     (ETHEREUM_VM_EXPIRATION is global and already set, so it is not touched.)
 *
 *   - Registers payload builders on the RelayAllocator where missing:
 *       arc   -> EthereumVmPayloadBuilder
 *       tron  -> TronVmPayloadBuilder
 *     (zorro already has its payload builder set, so it is skipped.)
 *
 * Only what `scripts/verify-chain-configs.ts` reports as missing is emitted.
 *
 * IMPORTANT: the numeric EVM chain ids for `arc` and `zorro` are NOT known to
 * this repo. They MUST be filled into `EVM_CHAIN_IDS` below before the
 * ETHEREUM_VM_CHAIN_ID transactions can be generated — a wrong value silently
 * breaks EIP-712 signature verification. Chains left as `null` are skipped
 * (with a warning) so the rest of the manifest can still be produced.
 *
 * Usage:
 *   yarn workspace @relay-settlement/multisig-tools \
 *     tsx scripts/generate-arc-zorro-tron-config.ts > transactions/050-arc-zorro-tron-config.json
 */
import { encodeAddress } from "@relay-protocol/settlement-sdk"
import {
  bytesToHex,
  createPublicClient,
  encodeFunctionData,
  encodePacked,
  getAddress,
  http,
  keccak256,
  parseAbi,
  parseEther,
  toBytes,
  toHex,
  type Hex,
} from "viem"

// --- Prod Relay Chain (537713) deployment ----------------------------------

const RELAY_RPC = "https://rpc.chain.relay.link"
const CONFIG = getAddress("0x8162BeeC776442afd262B672730Bb5d0d8af16A1")
const ALLOCATOR = getAddress("0x613D3c588F6B8f89302b463F8F19f7241B2857E2")
// RelayAllocator owner == Config admin == multisig signer that sends these txs.
const FROM = getAddress("0xF61A305199fa1135d76FFaB3752D42F55cBd775A")

const ETHEREUM_VM_PAYLOAD_BUILDER = getAddress(
  "0x982b49de82a3ea5B8c42895482D9dD9bfefaDf82"
)
const TRON_VM_PAYLOAD_BUILDER = getAddress(
  "0xFd6704CD8471e582754a322DEACdeff49331DcD7"
)

// Default request expiration delay (seconds) — mirrors the existing
// ETHEREUM_VM_EXPIRATION value already configured on-chain (0xe10 = 3600).
const TRON_EXPIRATION_SECONDS = 3600n

// Numeric EVM chain ids, keyed by Relay chainId string. `null` => skip.
// FILL THESE IN with the real values before generating the chain-id txs.
const EVM_CHAIN_IDS: Record<string, bigint | null> = {
  arc: 5042n,
  zorro: 4663n,
}

const TRON_NUMERIC_CHAIN_ID = 728126428n

// Depositories (from chains.txt), encoded to the bytes the allocator keys on.
const ARC_DEPOSITORY = "0x4cD00E387622C35bDDB9b4c962C136462338BC31"
const TRON_DEPOSITORY = "TXtEs6t2oUWQsNos7m68gbHdE9Q5n6x2oN"

// --- ABIs -------------------------------------------------------------------

const CONFIG_ABI = parseAbi([
  "function setConfigValue(bytes32 key, bytes32 value)",
])
const ALLOCATOR_ABI = parseAbi([
  "function setPayloadBuilder(string chainId, bytes depository, address builder)",
])

// --- Config key derivation (must match the Solidity payload builders) -------

const prefix = (label: string): Hex => keccak256(toBytes(label))
const namespacedKey = (label: string, chainId: string): Hex =>
  keccak256(encodePacked(["bytes32", "string"], [prefix(label), chainId]))

const uint256Value = (v: bigint): Hex => toHex(v, { size: 32 })

// --- Manifest assembly ------------------------------------------------------

type Call = { description: string; to: Hex; calldata: Hex }

const buildCalls = (): Call[] => {
  const calls: Call[] = []

  // ETHEREUM_VM_CHAIN_ID for evm chains (arc, zorro) — only if id is known.
  for (const [chainId, numericId] of Object.entries(EVM_CHAIN_IDS)) {
    if (numericId === null) {
      console.error(
        `⚠️  Skipping ETHEREUM_VM_CHAIN_ID for "${chainId}": numeric EVM chain id not set in EVM_CHAIN_IDS.`
      )
      continue
    }
    calls.push({
      calldata: encodeFunctionData({
        abi: CONFIG_ABI,
        args: [
          namespacedKey("ETHEREUM_VM_CHAIN_ID", chainId),
          uint256Value(numericId),
        ],
        functionName: "setConfigValue",
      }),
      description: `Config.setConfigValue ETHEREUM_VM_CHAIN_ID[${chainId}] = ${numericId}`,
      to: CONFIG,
    })
  }

  // TRON_VM_CHAIN_ID + TRON_VM_EXPIRATION for tron.
  calls.push({
    calldata: encodeFunctionData({
      abi: CONFIG_ABI,
      args: [
        namespacedKey("TRON_VM_CHAIN_ID", "tron"),
        uint256Value(TRON_NUMERIC_CHAIN_ID),
      ],
      functionName: "setConfigValue",
    }),
    description: `Config.setConfigValue TRON_VM_CHAIN_ID[tron] = ${TRON_NUMERIC_CHAIN_ID}`,
    to: CONFIG,
  })
  calls.push({
    calldata: encodeFunctionData({
      abi: CONFIG_ABI,
      args: [
        prefix("TRON_VM_EXPIRATION"),
        uint256Value(TRON_EXPIRATION_SECONDS),
      ],
      functionName: "setConfigValue",
    }),
    description: `Config.setConfigValue TRON_VM_EXPIRATION = ${TRON_EXPIRATION_SECONDS}`,
    to: CONFIG,
  })

  // Payload builders: arc (evm) + tron (tvm). zorro already set.
  calls.push({
    calldata: encodeFunctionData({
      abi: ALLOCATOR_ABI,
      args: [
        "arc",
        bytesToHex(encodeAddress(ARC_DEPOSITORY, "ethereum-vm")),
        ETHEREUM_VM_PAYLOAD_BUILDER,
      ],
      functionName: "setPayloadBuilder",
    }),
    description: "Allocator.setPayloadBuilder(arc, EthereumVmPayloadBuilder)",
    to: ALLOCATOR,
  })
  calls.push({
    calldata: encodeFunctionData({
      abi: ALLOCATOR_ABI,
      args: [
        "tron",
        bytesToHex(encodeAddress(TRON_DEPOSITORY, "tron-vm")),
        TRON_VM_PAYLOAD_BUILDER,
      ],
      functionName: "setPayloadBuilder",
    }),
    description: "Allocator.setPayloadBuilder(tron, TronVmPayloadBuilder)",
    to: ALLOCATOR,
  })

  return calls
}

const main = async () => {
  const client = createPublicClient({ transport: http(RELAY_RPC) })
  const calls = buildCalls()

  const fees = await client.estimateFeesPerGas()
  let nonce = await client.getTransactionCount({ address: FROM })

  const txs = []
  for (const call of calls) {
    // estimateGas also validates the call succeeds from the owner account.
    const gas = await client.estimateGas({
      account: FROM,
      data: call.calldata,
      to: call.to,
      value: parseEther("0"),
    })
    txs.push({
      amount: "0",
      calldata: call.calldata,
      family: "ethereum-vm",
      from: FROM,
      gas: gas.toString(),
      maxFeePerGas: fees.maxFeePerGas!.toString(),
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas!.toString(),
      nonce: nonce++,
      rpc: RELAY_RPC,
      to: call.to,
    })
    console.error(`✓ ${call.description}`)
  }

  console.log(JSON.stringify(txs, null, 2))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
