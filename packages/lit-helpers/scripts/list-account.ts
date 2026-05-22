#!/usr/bin/env tsx
/**
 * List Chipotle resources owned by an account and the group permissions that
 * link them: usage API keys, groups, PKP wallets, and actions.
 *
 * Usage:
 *   tsx scripts/list-account.ts --account-api-key <key> [--json]
 */

import { keccak_256 } from "@noble/hashes/sha3.js"

const BASE_URL = "https://api.chipotle.litprotocol.com"

const USAGE =
  "Usage:\n  tsx scripts/list-account.ts --account-api-key <key> [--json]"

/** Read a CLI flag value accepting `--name value` or `--name=value`. */
function getOption(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name)
  if (idx !== -1) {
    return args[idx + 1]
  }
  const prefix = `${name}=`
  return args.find((a) => a.startsWith(prefix))?.slice(prefix.length)
}

async function apiCall<T>(path: string, apiKey: string): Promise<T> {
  const res = await fetch(`${BASE_URL}/core/v1${path}`, {
    method: "GET",
    headers: { "Content-Type": "application/json", "X-Api-Key": apiKey },
  })
  if (!res.ok) {
    throw new Error(`GET ${path} failed (${res.status}): ${await res.text()}`)
  }
  return (await res.json()) as T
}

async function listAll<T>(path: string, apiKey: string): Promise<T[]> {
  const results: T[] = []
  let page = 0
  const pageSize = 50
  while (true) {
    const separator = path.includes("?") ? "&" : "?"
    const items = await apiCall<T[]>(
      `${path}${separator}page_number=${page}&page_size=${pageSize}`,
      apiKey
    )
    results.push(...items)
    if (items.length < pageSize) {
      break
    }
    page++
  }
  return results
}

interface RawWalletInfo {
  id?: number | string
  wallet_address?: string
  pkp_id?: string
  name?: string
  memo?: string
  description?: string
  [key: string]: unknown
}

interface RawGroupInfo {
  id: number | string
  name?: string
  description?: string
  pkp_ids_permitted?: string[]
  pkpIdsPermitted?: string[]
  pkp_ids?: string[]
  pkpIds?: string[]
  cid_hashes_permitted?: string[]
  cidHashesPermitted?: string[]
  cid_hashes?: string[]
  cidHashes?: string[]
  ipfs_ids_permitted?: string[]
  ipfsIdsPermitted?: string[]
  action_hashes?: string[]
  actionHashes?: string[]
  [key: string]: unknown
}

interface RawActionInfo {
  id?: number | string
  name?: string
  description?: string
  ipfs_cid?: string
  action_ipfs_cid?: string
  cid?: string
  hashed_cid?: string
  cid_hash?: string
  action_ipfs_cid_hash?: string
  [key: string]: unknown
}

interface RawUsageKeyInfo {
  id?: number | string
  name?: string
  description?: string
  execute_in_groups?: Array<number | string>
  executeInGroups?: Array<number | string>
  execute_in_group_ids?: Array<number | string>
  executeInGroupIds?: Array<number | string>
  manage_ipfs_ids_in_groups?: Array<number | string>
  manageIPFSIdsInGroups?: Array<number | string>
  manage_ipfs_ids_in_group_ids?: Array<number | string>
  manageIPFSIdsInGroupIds?: Array<number | string>
  add_pkp_to_groups?: Array<number | string>
  addPkpToGroups?: Array<number | string>
  add_pkp_to_group_ids?: Array<number | string>
  addPkpToGroupIds?: Array<number | string>
  remove_pkp_from_groups?: Array<number | string>
  removePkpFromGroups?: Array<number | string>
  remove_pkp_from_group_ids?: Array<number | string>
  removePkpFromGroupIds?: Array<number | string>
  permissions?: Record<string, unknown>
  create_groups?: boolean
  can_create_groups?: boolean
  delete_groups?: boolean
  can_delete_groups?: boolean
  create_pkps?: boolean
  can_create_pkps?: boolean
  [key: string]: unknown
}

interface AccountInventory {
  wallets: RawWalletInfo[]
  groups: Array<
    RawGroupInfo & {
      wallets: RawWalletInfo[]
      actions: RawActionInfo[]
      actionHashes: string[]
    }
  >
  actions: RawActionInfo[]
  usageApiKeys: RawUsageKeyInfo[]
}

function groupId(group: RawGroupInfo): string {
  return String(group.id)
}

function normalizeId(id: number | string): string {
  try {
    return BigInt(id).toString(10)
  } catch {
    return String(id)
  }
}

function idsEqual(a: number | string, b: number | string): boolean {
  return normalizeId(a) === normalizeId(b)
}

function groupIdForApi(group: RawGroupInfo): string {
  return normalizeId(group.id)
}

function walletAddress(wallet: RawWalletInfo): string {
  return wallet.wallet_address ?? wallet.pkp_id ?? "(unknown wallet)"
}

function actionCid(action: RawActionInfo): string | undefined {
  return action.action_ipfs_cid ?? action.ipfs_cid ?? action.cid
}

function actionHash(action: RawActionInfo): string | undefined {
  const explicit =
    action.hashed_cid ?? action.cid_hash ?? action.action_ipfs_cid_hash
  if (explicit) {
    return String(explicit)
  }
  if (typeof action.id === "string" && /^0x[0-9a-fA-F]{64}$/.test(action.id)) {
    return action.id
  }
  const cid = actionCid(action)
  if (cid) {
    return `0x${Buffer.from(keccak_256(new TextEncoder().encode(cid))).toString("hex")}`
  }
  return undefined
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.map(String)
}

function firstStringArray(...values: unknown[]): string[] {
  for (const value of values) {
    const items = asStringArray(value)
    if (items.length > 0) {
      return items
    }
  }
  return []
}

function usageKeyGroups(
  key: RawUsageKeyInfo,
  ...names: Array<keyof RawUsageKeyInfo>
): string[] {
  for (const name of names) {
    const values = asStringArray(key[name])
    if (values.length > 0) {
      return values
    }
    const permissionValues = asStringArray(key.permissions?.[String(name)])
    if (permissionValues.length > 0) {
      return permissionValues
    }
  }
  return []
}

function groupPkpIds(group: RawGroupInfo): string[] {
  return firstStringArray(
    group.pkp_ids_permitted,
    group.pkpIdsPermitted,
    group.pkp_ids,
    group.pkpIds
  )
}

function groupCidHashes(group: RawGroupInfo): string[] {
  return firstStringArray(
    group.cid_hashes_permitted,
    group.cidHashesPermitted,
    group.cid_hashes,
    group.cidHashes,
    group.ipfs_ids_permitted,
    group.ipfsIdsPermitted,
    group.action_hashes,
    group.actionHashes
  )
}

function usageKeyName(key: RawUsageKeyInfo): string {
  return `${key.name ?? "(unnamed)"}${key.id !== undefined ? ` (id=${key.id})` : ""}`
}

function usageKeysForGroup(
  usageApiKeys: RawUsageKeyInfo[],
  group: RawGroupInfo,
  names: Array<keyof RawUsageKeyInfo>,
  inferFromSetupName = false
): string[] {
  const id = groupIdForApi(group)
  return usageApiKeys
    .filter((key) => {
      const explicit = usageKeyGroups(key, ...names).some((groupIdValue) =>
        idsEqual(groupIdValue, id)
      )
      if (explicit) {
        return true
      }
      return inferFromSetupName && key.name === `${group.name}-usage-key`
    })
    .map(usageKeyName)
}

async function optionalListAll<T>(
  path: string,
  apiKey: string
): Promise<T[] | undefined> {
  try {
    return await listAll<T>(path, apiKey)
  } catch {
    return undefined
  }
}

async function loadGroupActions(
  apiKey: string,
  group: RawGroupInfo,
  actionsByHash: Map<string, RawActionInfo>
): Promise<{ actions: RawActionInfo[]; actionHashes: string[] }> {
  const id = groupIdForApi(group)

  // Prefer explicit group fields when the API includes them.
  const hashes = groupCidHashes(group)
  if (hashes.length > 0) {
    return {
      actionHashes: hashes,
      actions: hashes.flatMap((hash) => {
        const action = actionsByHash.get(hash.toLowerCase())
        return action ? [action] : []
      }),
    }
  }

  // Some Chipotle deployments expose a group-specific action endpoint. Treat
  // it as best-effort because it is not available everywhere.
  const candidates = [
    `/list_actions_in_group?group_id=${id}`,
    `/list_group_actions?group_id=${id}`,
  ]
  for (const path of candidates) {
    const groupActions = await optionalListAll<RawActionInfo>(path, apiKey)
    if (groupActions && groupActions.length > 0) {
      return {
        actions: groupActions,
        actionHashes: groupActions.flatMap((action) => {
          const hash = actionHash(action)
          return hash ? [hash] : []
        }),
      }
    }
  }

  // Fallback for the setup convention used by this repository's Lit packages:
  // action names are `<group-name>-action-<vm-type>`. This is not a historical
  // usage signal; it is only a best-effort way to render intended group
  // permissions when Chipotle's list endpoints omit CID permission arrays.
  const prefix = group.name ? `${group.name}-action-` : undefined
  const inferredActions = prefix
    ? [...actionsByHash.values()].filter((action) =>
        action.name?.startsWith(prefix)
      )
    : []
  return {
    actions: inferredActions,
    actionHashes: inferredActions.flatMap((action) => {
      const hash = actionHash(action)
      return hash ? [hash] : []
    }),
  }
}

async function loadInventory(apiKey: string): Promise<AccountInventory> {
  const [wallets, groups, actions, usageApiKeys] = await Promise.all([
    listAll<RawWalletInfo>("/list_wallets", apiKey),
    listAll<RawGroupInfo>("/list_groups", apiKey),
    listAll<RawActionInfo>("/list_actions", apiKey),
    listAll<RawUsageKeyInfo>("/list_api_keys", apiKey),
  ])

  const actionsByHash = new Map<string, RawActionInfo>()
  for (const action of actions) {
    const hash = actionHash(action)
    if (hash) {
      actionsByHash.set(hash.toLowerCase(), action)
    }
  }

  const groupsWithLinks = await Promise.all(
    groups.map(async (group) => {
      const id = groupIdForApi(group)
      const [groupWallets, groupActions] = await Promise.all([
        optionalListAll<RawWalletInfo>(
          `/list_wallets_in_group?group_id=${id}`,
          apiKey
        ),
        loadGroupActions(apiKey, group, actionsByHash),
      ])
      return {
        ...group,
        wallets: groupWallets ?? [],
        actions: groupActions.actions,
        actionHashes: groupActions.actionHashes,
      }
    })
  )

  return { wallets, groups: groupsWithLinks, actions, usageApiKeys }
}

function printList(label: string, values: string[]): void {
  console.log(
    `    ${label}: ${values.length > 0 ? values.join(", ") : "(none)"}`
  )
}

function printInventory(inventory: AccountInventory): void {
  const groupsById = new Map(
    inventory.groups.map((group) => [normalizeId(groupId(group)), group])
  )

  console.log("Lit account inventory")
  console.log()

  console.log(`Usage API keys (${inventory.usageApiKeys.length})`)
  for (const key of inventory.usageApiKeys) {
    console.log(
      `  - ${key.name ?? "(unnamed)"}${key.id !== undefined ? ` (id=${key.id})` : ""}`
    )
    const explicitExecuteGroups = usageKeyGroups(
      key,
      "execute_in_groups",
      "executeInGroups",
      "execute_in_group_ids",
      "executeInGroupIds"
    )
    const executeGroups =
      explicitExecuteGroups.length > 0
        ? explicitExecuteGroups
        : inventory.groups
            .filter((group) => key.name === `${group.name}-usage-key`)
            .map(groupIdForApi)
    printList(
      "execute groups",
      executeGroups.map((id) => {
        const group = groupsById.get(normalizeId(id))
        return group?.name ? `${group.name} (${id})` : id
      })
    )
    printList(
      "manage action groups",
      usageKeyGroups(
        key,
        "manage_ipfs_ids_in_groups",
        "manageIPFSIdsInGroups",
        "manage_ipfs_ids_in_group_ids",
        "manageIPFSIdsInGroupIds"
      )
    )
    printList(
      "add PKP groups",
      usageKeyGroups(
        key,
        "add_pkp_to_groups",
        "addPkpToGroups",
        "add_pkp_to_group_ids",
        "addPkpToGroupIds"
      )
    )
    printList(
      "remove PKP groups",
      usageKeyGroups(
        key,
        "remove_pkp_from_groups",
        "removePkpFromGroups",
        "remove_pkp_from_group_ids",
        "removePkpFromGroupIds"
      )
    )
    console.log(
      `    create groups: ${Boolean(key.can_create_groups ?? key.create_groups)}, delete groups: ${Boolean(
        key.can_delete_groups ?? key.delete_groups
      )}, create PKPs: ${Boolean(key.can_create_pkps ?? key.create_pkps)}`
    )
  }
  console.log()

  console.log(`Group permissions (${inventory.groups.length})`)
  for (const group of inventory.groups) {
    console.log(`  - ${group.name ?? "(unnamed)"} (id=${groupId(group)})`)
    if (group.description) {
      console.log(`    description: ${group.description}`)
    }

    const allowedPkps =
      group.wallets.length > 0
        ? group.wallets.map(walletAddress)
        : groupPkpIds(group)
    const actionLabels = group.actions.map((action) => {
      const cid = actionCid(action)
      const hash = actionHash(action)
      return `${action.name ?? cid ?? hash ?? "(unnamed action)"}${hash ? ` (${hash})` : ""}`
    })
    const allowedActions =
      actionLabels.length > 0 ? actionLabels : group.actionHashes

    console.log("    allowed to execute in this group:")
    printList("PKPs", allowedPkps)
    printList("actions", allowedActions)
    console.log("    usage key permissions for this group:")
    printList(
      "execute",
      usageKeysForGroup(
        inventory.usageApiKeys,
        group,
        [
          "execute_in_groups",
          "executeInGroups",
          "execute_in_group_ids",
          "executeInGroupIds",
        ],
        true
      )
    )
    printList(
      "manage actions",
      usageKeysForGroup(inventory.usageApiKeys, group, [
        "manage_ipfs_ids_in_groups",
        "manageIPFSIdsInGroups",
        "manage_ipfs_ids_in_group_ids",
        "manageIPFSIdsInGroupIds",
      ])
    )
    printList(
      "add PKPs",
      usageKeysForGroup(inventory.usageApiKeys, group, [
        "add_pkp_to_groups",
        "addPkpToGroups",
        "add_pkp_to_group_ids",
        "addPkpToGroupIds",
      ])
    )
    printList(
      "remove PKPs",
      usageKeysForGroup(inventory.usageApiKeys, group, [
        "remove_pkp_from_groups",
        "removePkpFromGroups",
        "remove_pkp_from_group_ids",
        "removePkpFromGroupIds",
      ])
    )
  }
  console.log()

  console.log(`Actions (${inventory.actions.length})`)
  for (const action of inventory.actions) {
    console.log(`  - ${action.name ?? "(unnamed)"}`)
    const cid = actionCid(action)
    const hash = actionHash(action)
    if (cid) {
      console.log(`    cid: ${cid}`)
    }
    if (hash) {
      console.log(`    hash: ${hash}`)
      printList(
        "groups",
        inventory.groups
          .filter((group) =>
            group.actionHashes
              .map((h) => h.toLowerCase())
              .includes(hash.toLowerCase())
          )
          .map((group) => `${group.name ?? "(unnamed)"} (${groupId(group)})`)
      )
    }
    if (action.description) {
      console.log(`    description: ${action.description}`)
    }
  }
  console.log()

  const linkedWallets = inventory.wallets.filter((wallet) => {
    const address = walletAddress(wallet).toLowerCase()
    return inventory.groups.some((group) =>
      group.wallets.some(
        (groupWallet) => walletAddress(groupWallet).toLowerCase() === address
      )
    )
  })

  console.log(
    `PKP wallets linked to groups (${linkedWallets.length} of ${inventory.wallets.length})`
  )
  for (const wallet of linkedWallets) {
    const address = walletAddress(wallet)
    console.log(`  - ${address}`)
    if (wallet.name ?? wallet.description ?? wallet.memo) {
      console.log(`    ${wallet.name ?? wallet.description ?? wallet.memo}`)
    }
    printList(
      "groups",
      inventory.groups
        .filter((group) =>
          group.wallets.some(
            (groupWallet) =>
              walletAddress(groupWallet).toLowerCase() === address.toLowerCase()
          )
        )
        .map((group) => `${group.name ?? "(unnamed)"} (${groupId(group)})`)
    )
  }
}

async function main() {
  const args = process.argv.slice(2)
  const accountApiKey = getOption(args, "--account-api-key")
  const json = args.includes("--json")
  if (!accountApiKey) {
    console.error(`Missing --account-api-key <key>.\n\n${USAGE}`)
    process.exit(1)
  }

  const inventory = await loadInventory(accountApiKey)
  if (json) {
    console.log(JSON.stringify(inventory, null, 2))
  } else {
    printInventory(inventory)
  }
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err)
  process.exit(1)
})
