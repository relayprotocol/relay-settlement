#!/usr/bin/env node

import {
  AbiCoder,
  Contract,
  FetchRequest,
  JsonRpcProvider,
  Wallet,
  concat,
  getAddress,
  getCreate2Address,
  getBytes,
  hexlify,
  keccak256,
  toBeHex,
  toUtf8Bytes,
  zeroPadValue,
} from "ethers"
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const deploymentsDirectory = path.dirname(fileURLToPath(import.meta.url))
const packageDirectory = path.dirname(deploymentsDirectory)
const depositoryAbi = [
  "function owner() view returns (address)",
  "function allocator() view returns (address)",
]

function fail(message) {
  throw new Error(message)
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"))
}

function loadDotEnv() {
  const envFile = path.join(packageDirectory, ".env")
  if (!existsSync(envFile)) return

  for (const rawLine of readFileSync(envFile, "utf8").split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue

    const separator = line.indexOf("=")
    if (separator < 1) continue

    const key = line.slice(0, separator).trim()
    let value = line.slice(separator + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (!(key in process.env)) process.env[key] = value
  }
}

export function parseArguments(argv) {
  const [command, ...tokens] = argv
  if (
    ![
      "plan",
      "deploy",
      "verify",
      "compiler-input",
      "build",
      "build-all",
    ].includes(command)
  ) {
    fail(
      "Usage: depository.mjs <plan|deploy|verify|compiler-input|build> --env <dev|stag|prod> --variant <name> [--chain-id <id>] [--rpc-url <url>], or depository.mjs build-all [--solc <path>]"
    )
  }

  const result = { command }
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === "--legacy") {
      result.legacy = true
      continue
    }
    if (
      !["--env", "--variant", "--chain-id", "--rpc-url", "--solc"].includes(
        token
      )
    ) {
      fail(`Unknown argument: ${token}`)
    }

    const value = tokens[index + 1]
    if (!value || value.startsWith("--")) fail(`Missing value for ${token}`)
    index += 1

    if (token === "--env") result.environment = value
    if (token === "--variant") result.variant = value
    if (token === "--rpc-url") result.rpcUrl = value
    if (token === "--solc") result.solc = value
    if (token === "--chain-id") {
      result.chainId = Number(value)
      if (!Number.isSafeInteger(result.chainId) || result.chainId <= 0) {
        fail("--chain-id must be a positive integer")
      }
    }
  }

  if (command === "build-all") {
    if (Object.keys(result).some((key) => !["command", "solc"].includes(key))) {
      fail("build-all only accepts --solc")
    }
    return result
  }

  if (!result.environment) fail("--env is required")
  if (!["dev", "stag", "prod"].includes(result.environment)) {
    fail("--env must be dev, stag, or prod")
  }
  if (!result.variant) fail("--variant is required")
  if (result.legacy && result.command !== "deploy") {
    fail("--legacy is only valid with deploy")
  }
  if (result.solc && result.command !== "build") {
    fail("--solc is only valid with build")
  }

  return result
}

export function selectVariant(release, variantName) {
  const variant = release.variants[variantName]
  if (!variant) {
    fail(
      `Unknown ${release.environment} variant: ${variantName}. Choose ${Object.keys(
        release.variants
      ).join(", ")}`
    )
  }
  return variant
}

export function listReleases(
  directory = path.join(deploymentsDirectory, "environments")
) {
  return readdirSync(directory)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .flatMap((file) => {
      const release = readJson(path.join(directory, file))
      return Object.keys(release.variants).map((variantName) => ({
        release,
        variantName,
      }))
    })
}

function loadEnvironment(environment) {
  return readJson(
    path.join(deploymentsDirectory, "environments", `${environment}.json`)
  )
}

function loadArtifact(variant) {
  return readJson(path.join(deploymentsDirectory, variant.artifact))
}

export function validateVariant(release, variantName, artifact) {
  const variant = selectVariant(release, variantName)
  if (!artifact || !variant.artifact) {
    fail(`${variantName}: no deployable bytecode artifact`)
  }

  const actualInitCodeHash = keccak256(artifact.initCode)
  if (actualInitCodeHash !== artifact.initCodeHash) {
    fail(`${variantName}: init code does not match its recorded hash`)
  }

  const encodedConstructor = AbiCoder.defaultAbiCoder().encode(
    ["address", "address"],
    [release.constructor.owner, release.constructor.allocator]
  )
  if (
    !artifact.initCode
      .toLowerCase()
      .endsWith(encodedConstructor.slice(2).toLowerCase())
  ) {
    fail(
      `${variantName}: init code does not contain the recorded constructor arguments`
    )
  }

  const predictedAddress = getCreate2Address(
    getAddress(release.factory),
    release.salt,
    artifact.initCodeHash
  )
  if (predictedAddress !== getAddress(variant.address)) {
    fail(
      `${variantName}: CREATE2 predicts ${predictedAddress}, expected ${variant.address}`
    )
  }

  const provenanceRuntimeHash = keccak256(
    expectedRuntimeCode(
      artifact,
      artifact.provenance.address,
      artifact.provenance.chainId
    )
  )
  if (provenanceRuntimeHash !== artifact.provenance.runtimeCodeHash) {
    fail(`${variantName}: runtime template does not match its provenance hash`)
  }

  return predictedAddress
}

export function expectedRuntimeCode(artifact, address, chainId) {
  if (!artifact.runtimeCode || !artifact.immutableReferences) {
    fail("release does not contain a runtime template")
  }

  const nameHash = keccak256(toUtf8Bytes("RelayDepository"))
  const versionHash = keccak256(toUtf8Bytes("1"))
  const domainTypeHash = keccak256(
    toUtf8Bytes(
      "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    )
  )
  const values = {
    _cachedThis: zeroPadValue(getAddress(address), 32),
    _cachedChainId: toBeHex(chainId, 32),
    _cachedNameHash: nameHash,
    _cachedVersionHash: versionHash,
    _cachedDomainSeparator: keccak256(
      AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "bytes32", "bytes32", "uint256", "address"],
        [domainTypeHash, nameHash, versionHash, chainId, address]
      )
    ),
  }
  const runtime = getBytes(artifact.runtimeCode)

  for (const [name, references] of Object.entries(
    artifact.immutableReferences
  )) {
    const value = values[name]
    if (!value) fail(`unsupported runtime immutable: ${name}`)
    const bytes = getBytes(value)
    for (const reference of references) {
      if (reference.length !== bytes.length) {
        fail(`${name}: immutable reference has the wrong length`)
      }
      runtime.set(bytes, reference.start)
    }
  }

  return hexlify(runtime)
}

export function compilerInput(artifact) {
  if (!artifact?.build) fail("release does not contain a source build")

  const { snapshots } = readJson(
    path.join(deploymentsDirectory, "sources.json")
  )
  const snapshot = artifact.build.sourceSnapshot
  if (!Object.hasOwn(snapshots, snapshot)) {
    fail(`Unknown source snapshot: ${snapshot}`)
  }

  return {
    language: "Solidity",
    sources: snapshots[snapshot],
    settings: {
      evmVersion: artifact.build.evmVersion,
      libraries: {},
      metadata: {
        appendCBOR: true,
        bytecodeHash: "ipfs",
        useLiteralContent: false,
      },
      optimizer: {
        enabled: false,
        runs: 200,
      },
      outputSelection: {
        "*": {
          "": ["*"],
          "*": ["*"],
        },
      },
      remappings: ["solady/=lib/solady/src/", "forge-std/=lib/forge-std/src/"],
      viaIR: true,
    },
  }
}

function compilerCandidates(artifact, explicitCompiler) {
  const version = artifact.build.compilerVersion
  return [
    explicitCompiler,
    process.env.SOLC_PATH,
    path.join(homedir(), ".svm", version, `solc-${version}`),
    "solc",
  ].filter(Boolean)
}

function compile(artifact, explicitCompiler) {
  const input = JSON.stringify(compilerInput(artifact))
  let result
  let compiler

  for (const candidate of compilerCandidates(artifact, explicitCompiler)) {
    result = spawnSync(candidate, ["--standard-json"], {
      encoding: "utf8",
      input,
      maxBuffer: 50 * 1024 * 1024,
    })
    if (!result.error || result.error.code !== "ENOENT") {
      compiler = candidate
      break
    }
  }

  if (!compiler) {
    fail(
      `solc ${artifact.build.compilerVersion} was not found; set SOLC_PATH or pass --solc`
    )
  }
  if (result.error) fail(`could not run ${compiler}: ${result.error.message}`)
  if (result.status !== 0) {
    fail(`${compiler} exited with status ${result.status}: ${result.stderr}`)
  }

  const output = JSON.parse(result.stdout)
  const errors = (output.errors ?? []).filter(
    (error) => error.severity === "error"
  )
  if (errors.length > 0) {
    fail(errors.map((error) => error.formattedMessage).join("\n"))
  }

  const [source, contract] = artifact.build.target.split(":")
  const compiled = output.contracts?.[source]?.[contract]
  if (!compiled)
    fail(`compiler output does not contain ${artifact.build.target}`)

  return { compiler, compiled }
}

function verifyBuild(release, variantName, artifact, explicitCompiler) {
  const { compiler, compiled } = compile(artifact, explicitCompiler)
  const constructor = AbiCoder.defaultAbiCoder().encode(
    ["address", "address"],
    [release.constructor.owner, release.constructor.allocator]
  )
  const rebuiltInitCode = concat([
    `0x${compiled.evm.bytecode.object}`,
    constructor,
  ])

  if (rebuiltInitCode.toLowerCase() !== artifact.initCode.toLowerCase()) {
    fail(
      `${variantName}: compiled init code does not match the frozen bytecode`
    )
  }
  if (
    `0x${compiled.evm.deployedBytecode.object}`.toLowerCase() !==
    artifact.runtimeCode.toLowerCase()
  ) {
    fail(
      `${variantName}: compiled runtime template does not match the frozen bytecode`
    )
  }

  console.log(
    `✓ ${variantName}: ${compiler} reproduces the init code and runtime template exactly`
  )
}

async function inspectTarget(
  release,
  variant,
  artifact,
  provider,
  chainId,
  blockTag = "latest"
) {
  const network = await provider.getNetwork()
  if (network.chainId !== BigInt(chainId)) {
    fail(`RPC returned chain ID ${network.chainId}, expected ${chainId}`)
  }

  const factoryCode = await provider.getCode(release.factory)
  if (factoryCode === "0x") fail("CREATE2 factory is not deployed")

  const address = getAddress(variant.address)
  const code = await provider.getCode(address, blockTag)
  if (code === "0x") {
    return { address, codeStatus: "not deployed", provider }
  }

  const actualRuntimeHash = keccak256(code)
  const wantedRuntimeHash = keccak256(
    expectedRuntimeCode(artifact, address, chainId)
  )
  if (actualRuntimeHash !== wantedRuntimeHash) {
    fail(`code hash ${actualRuntimeHash} does not match ${wantedRuntimeHash}`)
  }

  const depository = new Contract(address, depositoryAbi, provider)
  const inspected = {
    address,
    codeStatus: "exact bytecode",
    provider,
  }
  try {
    const [owner, allocator] = await Promise.all([
      depository.owner(),
      depository.allocator(),
    ])
    inspected.owner = owner
    inspected.allocator = allocator
  } catch (error) {
    inspected.stateError = error.shortMessage ?? error.message
  }
  return inspected
}

function plan(release, variantName, variant, artifact) {
  console.log(`${release.environment}/${variantName}: create2`)
  console.log(`address: ${getAddress(variant.address)}`)
  console.log(`init code hash: ${artifact.initCodeHash}`)
  console.log(
    `provenance runtime code hash (chain ${artifact.provenance.chainId}): ${artifact.provenance.runtimeCodeHash}`
  )
  console.log(`owner: ${getAddress(release.constructor.owner)}`)
  console.log(`allocator: ${getAddress(release.constructor.allocator)}`)
  console.log(
    `constructor arguments: ${AbiCoder.defaultAbiCoder().encode(
      ["address", "address"],
      [release.constructor.owner, release.constructor.allocator]
    )}`
  )
  console.log(
    `source snapshot: ${artifact.build.sourceSnapshot}; solc ${artifact.build.compilerVersion}; EVM ${artifact.build.evmVersion}`
  )
}

async function verify(release, variant, artifact, provider, chainId) {
  const inspected = await inspectTarget(
    release,
    variant,
    artifact,
    provider,
    chainId
  )
  if (inspected.codeStatus !== "exact bytecode") {
    fail(`depository is not deployed at ${inspected.address}`)
  }

  const state = inspected.owner
    ? `owner=${inspected.owner} allocator=${inspected.allocator}`
    : `state unavailable: ${inspected.stateError}`
  console.log(`✓ chain ${chainId} ${inspected.address} ${state}`)
}

async function writeReceipt(
  release,
  variantName,
  variant,
  artifact,
  chainId,
  transactionReceipt,
  verification,
  receiptRoot
) {
  const receiptDirectory = path.join(receiptRoot, release.environment)
  await mkdir(receiptDirectory, { recursive: true })
  const receiptFile = path.join(receiptDirectory, `${chainId}.json`)
  const previous = existsSync(receiptFile) ? readJson(receiptFile) : undefined
  const receipt = {
    environment: release.environment,
    chainId,
    address: getAddress(variant.address),
    variant: variantName,
    initCodeHash: artifact.initCodeHash,
    runtimeCodeHash: keccak256(
      expectedRuntimeCode(artifact, variant.address, chainId)
    ),
  }
  const matchesPrevious =
    previous &&
    Object.entries(receipt).every(([key, value]) => previous[key] === value)
  receipt.transactionHash =
    transactionReceipt?.hash ??
    (matchesPrevious ? previous.transactionHash : null) ??
    null
  receipt.blockNumber =
    transactionReceipt?.blockNumber ??
    (matchesPrevious ? previous.blockNumber : null) ??
    null
  receipt.verification = verification
  await writeFile(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`)
}

export async function deploy(
  release,
  variantName,
  variant,
  artifact,
  options,
  provider,
  chainId,
  receiptRoot = path.join(deploymentsDirectory, "receipts")
) {
  const privateKey = process.env.DEPLOYER_PRIVATE_KEY
  if (!privateKey) fail("DEPLOYER_PRIVATE_KEY is required")

  const inspected = await inspectTarget(
    release,
    variant,
    artifact,
    provider,
    chainId
  )
  if (inspected.codeStatus === "exact bytecode") {
    await writeReceipt(
      release,
      variantName,
      variant,
      artifact,
      chainId,
      null,
      "verified",
      receiptRoot
    )
    console.log(`✓ already deployed at ${inspected.address}`)
    return
  }

  const wallet = new Wallet(privateKey, inspected.provider)
  const transaction = {
    data: concat([release.salt, artifact.initCode]),
    to: release.factory,
  }
  if (options.legacy) {
    transaction.type = 0
    transaction.gasPrice = await inspected.provider
      .getFeeData()
      .then((fees) => fees.gasPrice)
    if (transaction.gasPrice === null) {
      fail("RPC did not return a legacy gas price")
    }
  }

  console.log(`deploying ${inspected.address} from ${wallet.address}`)
  const response = await wallet.sendTransaction(transaction)
  console.log(`transaction: ${response.hash}`)
  const receipt = await response.wait()
  if (!receipt || receipt.status !== 1) fail("deployment reverted")

  // Persist the mined transaction before any RPC read can fail or lag behind it.
  await writeReceipt(
    release,
    variantName,
    variant,
    artifact,
    chainId,
    receipt,
    "pending",
    receiptRoot
  )

  const verified = await inspectTarget(
    release,
    variant,
    artifact,
    provider,
    chainId,
    receipt.blockNumber
  )
  if (verified.codeStatus !== "exact bytecode") {
    fail(
      "deployment mined and receipt saved, but bytecode is not yet visible; rerun deploy to verify"
    )
  }
  await writeReceipt(
    release,
    variantName,
    variant,
    artifact,
    chainId,
    receipt,
    "verified",
    receiptRoot
  )
  console.log(`✓ deployed and verified ${verified.address}`)
}

export async function main(argv = process.argv.slice(2)) {
  loadDotEnv()
  const options = parseArguments(argv)
  if (options.command === "build-all") {
    for (const { release, variantName } of listReleases()) {
      const variant = selectVariant(release, variantName)
      const artifact = loadArtifact(variant)
      validateVariant(release, variantName, artifact)
      verifyBuild(release, variantName, artifact, options.solc)
    }
    return
  }
  const release = loadEnvironment(options.environment)
  const variant = selectVariant(release, options.variant)
  const artifact = loadArtifact(variant)

  validateVariant(release, options.variant, artifact)

  if (options.command === "compiler-input") {
    console.log(JSON.stringify(compilerInput(artifact), null, 2))
    return
  }
  if (options.command === "build") {
    verifyBuild(release, options.variant, artifact, options.solc)
    return
  }
  if (options.command === "plan") {
    plan(release, options.variant, variant, artifact)
    return
  }

  const rpcUrl = options.rpcUrl ?? process.env.RPC_URL
  if (!rpcUrl) fail("set RPC_URL or pass --rpc-url")
  const chainId = options.chainId
  if (!chainId) fail("--chain-id is required")

  console.log(
    `${release.environment}/${options.variant}: chain ${chainId}; factory ${release.factory}; salt ${BigInt(release.salt)}`
  )
  const request = new FetchRequest(rpcUrl)
  request.timeout = 20_000
  const provider = new JsonRpcProvider(request)
  try {
    if (options.command === "verify") {
      await verify(release, variant, artifact, provider, chainId)
    } else {
      await deploy(
        release,
        options.variant,
        variant,
        artifact,
        options,
        provider,
        chainId
      )
    }
  } finally {
    provider.destroy()
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`Error: ${error.message}`)
    process.exitCode = 1
  })
}
