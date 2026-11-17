import { isAddress, toHex, type Address, type Hex } from "viem"

import type { GatewayChainName } from "../../configs/gateway-vm"
import {
  buildGatewayConfigEntries,
  gatewayChainId,
} from "../payload-builders/configure-gateway-vm-payload-builder"
import {
  parseLabelList,
  planLighterConfigWrites,
  readConfigValue,
  type ReadClient,
} from "../payload-builders/lighter-vm-config-plan"
import {
  getLighterAppChainId,
  getLighterCurrencySet,
} from "../payload-builders/lighter-vm-currency-sets"
import {
  builderAbi,
  configAbi,
  log,
  ownableAbi,
  publicClient,
  type ChainTarget,
  type RedeployState,
} from "./common"

// The Config values the new builders need, computed the way the helper scripts
// compute them. Each list holds only what is not on-chain yet, so the council
// manifests and the deployer's checks both skip what is done.

// One Config.setConfigValues call
export type ConfigWrite = { label: string; keys: Hex[]; values: Hex[] }

// Same batch size as the Gateway helper's CONFIG_BATCH_SIZE default
const CONFIG_BATCH_SIZE = 100

// Config's admin is the owner of the allocator it points at. The deployer
// never holds it in the normal ordering: Config keeps pointing at the previous
// allocator (council-owned) until the council owns the new one.
export async function configAdmin(state: RedeployState) {
  const client = publicClient(state.chainId)
  const allocator = (await client.readContract({
    abi: configAbi,
    address: state.config,
    functionName: "allocator",
  })) as Address
  const owner = (await client.readContract({
    abi: ownableAbi,
    address: allocator,
    functionName: "owner",
  })) as Address
  return { allocator, owner }
}

// Lighter changed its Config key derivation (#927): every Lighter instance's
// values move to the new builder's keys. The new keys are read only by the new
// builder, so they can be written any time before its registration.
export async function lighterConfigWrites(
  state: RedeployState
): Promise<ConfigWrite[]> {
  const client = publicClient(state.chainId) as unknown as ReadClient
  const writes: ConfigWrite[] = []
  for (const chain of state.chains.filter((c) => c.vmType === "lighter-vm")) {
    log(`\n==> Lighter Config for ${chain.id}`)
    const { keys, values } = await planLighterConfigWrites({
      client,
      config: state.config,
      payloadBuilder: state.deployed.lighterVmPayloadBuilder,
      previousPayloadBuilder: state.previous.lighterVmPayloadBuilder,
      chainId: chain.id,
      currencies: getLighterCurrencySet(chain.id),
      instance: {
        fromAccountIndex: BigInt(chain.depository),
        lighterChainId: getLighterAppChainId(chain.id),
      },
      // Same opt-ins as configure-lighter-vm-payload-builder.ts
      reenableCurrencies: parseLabelList(process.env.REENABLE_CURRENCIES),
      migrationReviewed: process.env.MIGRATION_REVIEWED === "1",
      confirmDisableAll: process.env.CONFIRM_DISABLE_ALL === "1",
      log: (line) => log(`  ${line}`),
    })
    if (keys.length > 0) {
      writes.push({ label: `Lighter Config ${chain.id}`, keys, values })
    }
  }
  return writes
}

// TON_VM_GAS_FEE, the fee the TON builder reports to the allocator. The
// previous builder predates it, so the key is new (#934). TON_GAS_FEE is only
// needed while the value is unset or to change it.
export async function tonConfigWrites(
  state: RedeployState,
  only?: ChainTarget
): Promise<ConfigWrite[]> {
  const client = publicClient(state.chainId)
  const fee = process.env.TON_GAS_FEE
  const writes: ConfigWrite[] = []
  for (const chain of state.chains.filter(
    (c) => c.vmType === "ton-vm" && (!only || c.id === only.id)
  )) {
    const key = (await client.readContract({
      abi: builderAbi,
      address: state.deployed.tonVmPayloadBuilder,
      functionName: "getGasFeeKey",
      args: [chain.id],
    })) as Hex
    const current = await readConfigValue(
      client as unknown as ReadClient,
      state.config,
      key
    )
    if (fee === undefined) {
      if (current === undefined) {
        throw new Error(
          "Set TON_GAS_FEE (the per-withdrawal TON gas fee, in nanotons) for TON_VM_GAS_FEE"
        )
      }
      continue
    }
    const value = toHex(BigInt(fee), { size: 32 })
    if (current?.toLowerCase() === value.toLowerCase()) continue
    writes.push({
      label: `TON_VM_GAS_FEE ${chain.id}`,
      keys: [key],
      values: [value],
    })
  }
  return writes
}

// Gateway values the redeploy changes on purpose: the new destination
// builder, the operator's GATEWAY_ALLOCATORS allowlist and, when given,
// MAX_BLOCK_HEIGHT. Every other Gateway key is only written while unset.
const GATEWAY_DELIBERATE_FIELDS = new Set([
  "destinationBuilder",
  "allocatorAllowed",
  "maxBlockHeight",
])

// The Gateway Config, from configure-gateway-vm-payload-builder.ts, for every
// gateway-vm chain or only `only`. Every Gateway key is shared with the live
// Gateway builder, so a set value that differs from the helper's (for example
// a gas fee tuned on-chain against the GAS_FEE_USDC_<SUFFIX> default) is kept
// and logged, not rewritten. The writes land in the same manifest-register
// manifest as the Gateway registration.
export async function gatewayConfigWrites(
  state: RedeployState,
  only?: ChainTarget
): Promise<ConfigWrite[]> {
  const chains = state.chains.filter(
    (c) => c.vmType === "gateway-vm" && (!only || c.id === only.id)
  )
  if (chains.length === 0) return []
  if (!process.env.GATEWAY_ALLOCATORS)
    throw new Error("Set GATEWAY_ALLOCATORS for the Gateway Config")
  const gatewayAllocators = parseGatewayAllocators(
    process.env.GATEWAY_ALLOCATORS
  )
  // Optional, as in the helper: unset leaves the on-chain ceiling unchanged
  const maxBlockHeight = process.env.MAX_BLOCK_HEIGHT
    ? BigInt(process.env.MAX_BLOCK_HEIGHT)
    : undefined
  const client = publicClient(state.chainId)
  const writes: ConfigWrite[] = []
  for (const chain of chains) {
    const sourceChain = (chain.gatewaySource ?? "") as GatewayChainName
    if (gatewayChainId(sourceChain) !== chain.id) {
      throw new Error(
        `Gateway chain ${chain.id} has source ${chain.gatewaySource}: expected ${chain.id.replace(/-gateway$/, "")}`
      )
    }
    const entries = await buildGatewayConfigEntries(
      {
        payloadBuilder: state.deployed.gatewayVmPayloadBuilder,
        destinationPayloadBuilder:
          state.deployed.gatewayEthereumVmDestinationPayloadBuilder,
        depository: chain.depository as Address,
        chainId: chain.id,
        sourceChain,
        gatewayAllocators,
        maxBlockHeight,
      },
      client
    )
    const missing = []
    for (const entry of entries) {
      const current = await readConfigValue(
        client as unknown as ReadClient,
        state.config,
        entry.key
      )
      if (current?.toLowerCase() === entry.value.toLowerCase()) continue
      if (
        current !== undefined &&
        !GATEWAY_DELIBERATE_FIELDS.has(entry.field)
      ) {
        log(
          `  [keep] ${entry.label} is ${current} on-chain (default ${entry.value}): shared with the live builder, not rewritten`
        )
        continue
      }
      log(
        `  [set ] ${entry.label} key=${entry.key} value=${entry.value} (was ${current ?? "unset"})`
      )
      missing.push(entry)
    }
    for (let start = 0; start < missing.length; start += CONFIG_BATCH_SIZE) {
      const batch = missing.slice(start, start + CONFIG_BATCH_SIZE)
      writes.push({
        label: `Gateway Config ${chain.id} (${start + 1}-${start + batch.length} of ${missing.length})`,
        keys: batch.map((entry) => entry.key),
        values: batch.map((entry) => entry.value),
      })
    }
  }
  return writes
}

// "0xA, 0xB" -> unique addresses, like the Gateway helper's parsing
export function parseGatewayAllocators(value: string): Address[] {
  const unique = new Map<string, Address>()
  for (const entry of value.split(",").map((part) => part.trim())) {
    if (!isAddress(entry, { strict: false })) {
      throw new Error(`GATEWAY_ALLOCATORS: ${entry} is not an address`)
    }
    unique.set(entry.toLowerCase(), entry)
  }
  return [...unique.values()]
}
