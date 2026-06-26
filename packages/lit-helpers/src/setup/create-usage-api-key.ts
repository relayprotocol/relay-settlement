import { createApiKeyBackend } from "./backend-api-key.js"
import { createChainSecuredBackend } from "./backend-chain-secured.js"
import type { SetupBackend, SetupMode } from "./backend.js"

export interface CreateUsageApiKeyCliOptions {
  args: string[]
  envName: string
  groupPrefix: string
  displayName: string
  chainSecuredPkpName: string
  chainSecuredPkpDescription: string
  scriptPath?: string
}

function getOption(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name)
  if (idx !== -1) {
    return args[idx + 1]
  }
  const prefix = `${name}=`
  return args.find((a) => a.startsWith(prefix))?.slice(prefix.length)
}

function usage(scriptPath: string): string {
  return (
    "Usage:\n" +
    `  tsx ${scriptPath} --env <name> --mode api-key       --account-api-key <key> --name <usage-key-name> --description <text>\n` +
    `  tsx ${scriptPath} --env <name> --mode chain-secured --account-api-key <key> --private-key 0x... --name <usage-key-name> --description <text>`
  )
}

function buildBackend(opts: CreateUsageApiKeyCliOptions): SetupBackend {
  const mode = getOption(opts.args, "--mode") as SetupMode | undefined
  if (mode !== "api-key" && mode !== "chain-secured") {
    throw new Error(
      "create-usage-api-key requires --mode api-key or --mode chain-secured"
    )
  }

  const accountApiKey = getOption(opts.args, "--account-api-key")
  if (!accountApiKey) {
    throw new Error("create-usage-api-key requires --account-api-key <key>")
  }

  if (mode === "api-key") {
    return createApiKeyBackend(accountApiKey)
  }

  const privateKey = getOption(opts.args, "--private-key")
  if (!privateKey) {
    throw new Error("--mode chain-secured requires --private-key <hex>")
  }

  return createChainSecuredBackend({
    privateKey,
    accountApiKey,
    pkpName: opts.chainSecuredPkpName,
    pkpDescription: opts.chainSecuredPkpDescription,
  })
}

export async function runCreateUsageApiKeyCli(
  opts: CreateUsageApiKeyCliOptions
): Promise<void> {
  const scriptUsage = usage(
    opts.scriptPath ?? "scripts/create-usage-api-key.ts"
  )
  const groupName = `${opts.groupPrefix}-${opts.envName}`
  const usageKeyName = getOption(opts.args, "--name")
  const description = getOption(opts.args, "--description")
  if (!usageKeyName) {
    throw new Error(
      `create-usage-api-key requires --name <usage-key-name>\n\n${scriptUsage}`
    )
  }
  if (!description) {
    throw new Error(
      `create-usage-api-key requires --description <text>\n\n${scriptUsage}`
    )
  }

  let backend: SetupBackend
  try {
    backend = buildBackend(opts)
  } catch (e) {
    throw new Error(`${e instanceof Error ? e.message : e}\n\n${scriptUsage}`, {
      cause: e,
    })
  }

  console.log(`🔑 Creating ${opts.displayName} usage API key`)
  console.log(`   Environment: ${opts.envName}`)
  console.log(`   Mode:        ${backend.mode}`)
  console.log(`   Group:       ${groupName}`)
  console.log(`   Key name:    ${usageKeyName}`)
  console.log()

  const groups = await backend.listGroups()
  const group = groups.find((g) => g.name === groupName)
  if (!group) {
    throw new Error(`group not found: ${groupName}. Run setup first.`)
  }

  const existingKeys = await backend.listUsageApiKeys()
  if (existingKeys.some((k) => k.name === usageKeyName)) {
    throw new Error(
      `usage API key already exists: ${usageKeyName}. Choose a different --name.`
    )
  }

  const usageApiKey = await backend.createUsageApiKey(
    usageKeyName,
    description,
    [group.id]
  )

  console.log("✓ Usage API key created")
  console.log(`⚠️  SAVE THIS NOW — it won't be shown again: ${usageApiKey}`)
  console.log()
  console.log(`export LIT_API_KEY="${usageApiKey}"`)
}
