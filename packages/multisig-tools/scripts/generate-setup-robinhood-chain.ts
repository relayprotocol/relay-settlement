/**
 * Generates a multisig manifest that re-sets up the chain previously wired as
 * `zorro`, this time under the relay chain id `robinhood`. The underlying chain
 * is unchanged (same numeric EVM chain id, depository and payload builder); only
 * the relay chain id string used as the on-chain key differs.
 *
 * Relay-chain (hub-side) calls, sent by the relay-chain multisig signer which is
 * the Config admin and RelayAllocator owner:
 *   1. Config.setConfigValue(ETHEREUM_VM_CHAIN_ID[robinhood], 4663)
 *        Numeric EVM chain id the EthereumVmPayloadBuilder reads when building
 *        EIP-712 payloads. Mirrors the value already set for `zorro`.
 *   2. Allocator.setPayloadBuilder(robinhood, depository, EthereumVmPayloadBuilder)
 *        Registers the payload builder under the new chain id key.
 *
 * The depository-side `setAllocator` wiring is keyed by address, not by the
 * relay chain id, so it does not need to be redone for the rename.
 *
 * Values verified on-chain against the existing `zorro` configuration:
 *   ETHEREUM_VM_CHAIN_ID[zorro] = 4663
 *   payloadBuilders[zorro][depository] = 0x982b49de82a3ea5B8c42895482D9dD9bfefaDf82
 *
 * Usage:
 *   yarn workspace @relay-settlement/multisig-tools \
 *     tsx scripts/generate-setup-robinhood-chain.ts \
 *     > transactions/055-setup-robinhood-chain.json
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

// --- Prod Relay Chain (537713) deployment -----------------------------------

const RELAY_RPC = "https://rpc.chain.relay.link"
const CONFIG = getAddress("0x8162BeeC776442afd262B672730Bb5d0d8af16A1")
const ALLOCATOR = getAddress("0x613D3c588F6B8f89302b463F8F19f7241B2857E2")
// Config admin == RelayAllocator owner == multisig signer that sends these txs.
const FROM = getAddress("0xF61A305199fa1135d76FFaB3752D42F55cBd775A")

const ETHEREUM_VM_PAYLOAD_BUILDER = getAddress(
  "0x982b49de82a3ea5B8c42895482D9dD9bfefaDf82"
)

// New relay chain id and the (unchanged) chain it points at.
const CHAIN_ID = "robinhood"
const EVM_CHAIN_ID = 4663n
const DEPOSITORY = getAddress("0x4cD00E387622C35bDDB9b4c962C136462338BC31")

// --- ABIs -------------------------------------------------------------------

const CONFIG_ABI = parseAbi([
  "function setConfigValue(bytes32 key, bytes32 value)",
])
const ALLOCATOR_ABI = parseAbi([
  "function setPayloadBuilder(string chainId, bytes depository, address builder)",
])

// --- Config key derivation (must match EthereumVmPayloadBuilder) ------------
// key = keccak256(abi.encodePacked(keccak256("ETHEREUM_VM_CHAIN_ID"), chainId))

const ethereumVmChainIdKey = (chainId: string): Hex =>
  keccak256(
    encodePacked(
      ["bytes32", "string"],
      [keccak256(toBytes("ETHEREUM_VM_CHAIN_ID")), chainId]
    )
  )

const uint256Value = (v: bigint): Hex => toHex(v, { size: 32 })

// --- Manifest assembly ------------------------------------------------------

type Call = { description: string; to: Hex; calldata: Hex }

const buildCalls = (): Call[] => [
  {
    calldata: encodeFunctionData({
      abi: CONFIG_ABI,
      args: [ethereumVmChainIdKey(CHAIN_ID), uint256Value(EVM_CHAIN_ID)],
      functionName: "setConfigValue",
    }),
    description: `Config.setConfigValue ETHEREUM_VM_CHAIN_ID[${CHAIN_ID}] = ${EVM_CHAIN_ID}`,
    to: CONFIG,
  },
  {
    calldata: encodeFunctionData({
      abi: ALLOCATOR_ABI,
      args: [
        CHAIN_ID,
        bytesToHex(encodeAddress(DEPOSITORY, "ethereum-vm")),
        ETHEREUM_VM_PAYLOAD_BUILDER,
      ],
      functionName: "setPayloadBuilder",
    }),
    description: `Allocator.setPayloadBuilder(${CHAIN_ID}, EthereumVmPayloadBuilder)`,
    to: ALLOCATOR,
  },
]

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
