#!/usr/bin/env ts-node
/**
 * Recompile Safe's deployment metadata with the exact solc installed by the
 * pinned upstream package-lock and compare each runtime with the chain.
 *
 * Required env:
 *   RPC_URL
 *   SAFE_DEPLOYMENTS_DIR     Upstream hardhat-deploy directory
 *   SAFE_SMART_ACCOUNT_DIR   Pinned upstream checkout after `npm ci`
 */

import { readFileSync } from "fs"
import { createRequire } from "module"
import { resolve } from "path"
import { createPublicClient, hexToBytes, http, keccak256, type Hex } from "viem"
import {
  asAddress,
  readHardhatDeployments,
  requireEnv,
  REQUIRED_SAFE_CORE_CONTRACTS,
  SAFE_SMART_ACCOUNT_VERSION,
} from "./safe-core-common"

type Solc = {
  compile(_input: string): string
  version(): string
}

type CompilerMetadata = {
  compiler?: { version: string }
  output?: unknown
  settings: {
    compilationTarget?: Record<string, string>
    outputSelection: Record<string, Record<string, string[]>>
  }
  sources: Record<string, Record<string, unknown>>
  version?: unknown
}

type CompilerOutput = {
  contracts?: Record<
    string,
    Record<
      string,
      {
        evm: {
          deployedBytecode: {
            immutableReferences: Record<
              string,
              { length: number; start: number }[]
            >
            object: string
          }
        }
      }
    >
  >
  errors?: { formattedMessage?: string; message: string; severity: string }[]
}

type HardhatDeployment = {
  address: unknown
  metadata?: unknown
}

function parseMetadata(value: unknown, name: string): CompilerMetadata {
  if (typeof value !== "string") {
    throw new Error(`${name} deployment does not contain compiler metadata`)
  }
  const metadata = JSON.parse(value) as CompilerMetadata
  if (
    typeof metadata.compiler?.version !== "string" ||
    !metadata.settings?.compilationTarget ||
    !metadata.sources
  ) {
    throw new Error(`${name} deployment metadata is incomplete`)
  }
  return metadata
}

async function main() {
  const rpcUrl = requireEnv("RPC_URL")
  const deploymentsDirectory = resolve(requireEnv("SAFE_DEPLOYMENTS_DIR"))
  const upstreamDirectory = resolve(requireEnv("SAFE_SMART_ACCOUNT_DIR"))
  const deployments = readHardhatDeployments(deploymentsDirectory)
  const upstreamRequire = createRequire(
    resolve(upstreamDirectory, "package.json")
  )
  const solc = upstreamRequire("solc") as Solc
  const solcVersion = solc.version()
  const client = createPublicClient({ transport: http(rpcUrl) })

  console.log(`Verifying Safe core v${SAFE_SMART_ACCOUNT_VERSION} sources`)
  console.log(`  compiler: ${solcVersion}`)

  for (const name of REQUIRED_SAFE_CORE_CONTRACTS) {
    const path = resolve(deploymentsDirectory, `${name}.json`)
    const deployment = JSON.parse(
      readFileSync(path, "utf8")
    ) as HardhatDeployment
    const address = asAddress(deployment.address, `${name}.address`)
    if (address.toLowerCase() !== deployments[name].address.toLowerCase()) {
      throw new Error(`${name} deployment address changed while verifying`)
    }

    const metadata = parseMetadata(deployment.metadata, name)
    const compilerVersion = metadata.compiler!.version
    if (!solcVersion.startsWith(compilerVersion)) {
      throw new Error(
        `${name} requires solc ${compilerVersion}, but upstream installed ${solcVersion}`
      )
    }

    delete metadata.compiler
    delete metadata.output
    delete metadata.version
    for (const source of Object.values(metadata.sources)) {
      for (const key of Object.keys(source)) {
        if (key !== "content" && key !== "keccak256") {
          delete source[key]
        }
      }
    }

    const targets = Object.entries(metadata.settings.compilationTarget!)
    metadata.settings.outputSelection = {}
    for (const [sourceName, contractName] of targets) {
      metadata.settings.outputSelection[sourceName] = {
        [contractName]: [
          "evm.deployedBytecode.object",
          "evm.deployedBytecode.immutableReferences",
        ],
      }
    }
    delete metadata.settings.compilationTarget

    const output = JSON.parse(
      solc.compile(JSON.stringify(metadata))
    ) as CompilerOutput
    const errors = (output.errors ?? []).filter(
      (error) => error.severity === "error"
    )
    if (errors.length > 0) {
      throw new Error(
        `${name} recompilation failed:\n${errors
          .map((error) => error.formattedMessage ?? error.message)
          .join("\n")}`
      )
    }

    const onChainCode = await client.getCode({ address })
    if (!onChainCode || onChainCode === "0x") {
      throw new Error(`${name} has no code at ${address}`)
    }
    const normalizedOnChainCode = hexToBytes(onChainCode)

    for (const [sourceName, contractName] of targets) {
      const compiled = output.contracts?.[sourceName]?.[contractName]
      if (!compiled) {
        throw new Error(`${name} compiler output is missing ${contractName}`)
      }
      for (const references of Object.values(
        compiled.evm.deployedBytecode.immutableReferences
      )) {
        for (const { length, start } of references) {
          normalizedOnChainCode.fill(0, start, start + length)
        }
      }

      const localBytecode = `0x${compiled.evm.deployedBytecode.object}` as Hex
      const onChainHash = keccak256(normalizedOnChainCode)
      const localHash = keccak256(localBytecode)
      if (onChainHash !== localHash) {
        throw new Error(`${name} runtime does not match the pinned source`)
      }
    }
    console.log(`  ${name}: source matches ${address}`)
  }

  console.log("Safe core source verification passed")
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
