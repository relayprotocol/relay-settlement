import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { AbiCoder, Wallet, keccak256 } from "ethers"

import {
  compilerInput,
  deploy,
  listReleases,
  expectedRuntimeCode,
  parseArguments,
  selectVariant,
  validateVariant,
} from "./depository.mjs"

const fixture = {
  environment: "dev",
  factory: "0x4e59b44847b379578588920ca78fbf26c0b4956c",
  salt: "0x0000000000000000000000000000000000000000000000000000000000000001",
  constructor: {
    owner: "0xf3d63166f0ca56c3c1a3508fce03ff0cf3fb691e",
    allocator: "0x3ddb9b2297027681357e1e35680867d5dc27b63d",
  },
  variants: {
    cancun: {
      address: "0x5cb1de3603a71ac2f67b12bfbf095013fe4ac299",
      artifact: "releases/dev-cancun.json",
    },
  },
}

test("environment and variant are required", () => {
  assert.throws(() => parseArguments(["deploy", "--env", "prod"]), /variant/u)
  assert.throws(() => parseArguments(["plan", "--variant", "cancun"]), /env/u)
})

test("network arguments describe one explicit target", () => {
  assert.deepEqual(
    parseArguments([
      "deploy",
      "--env",
      "stag",
      "--variant",
      "london",
      "--chain-id",
      "25",
      "--rpc-url",
      "https://example.invalid",
      "--legacy",
    ]),
    {
      command: "deploy",
      environment: "stag",
      variant: "london",
      chainId: 25,
      rpcUrl: "https://example.invalid",
      legacy: true,
    }
  )
})

test("variant selection rejects unknown names", () => {
  assert.equal(selectVariant(fixture, "cancun"), fixture.variants.cancun)
  assert.throws(() => selectVariant(fixture, "london"), /Unknown dev variant/u)
})

test("the frozen dev artifact predicts the configured address", async () => {
  const artifact = JSON.parse(
    await readFile(
      new URL("./releases/dev-cancun.json", import.meta.url),
      "utf8"
    )
  )

  assert.equal(
    validateVariant(fixture, "cancun", artifact),
    "0x5CB1De3603A71Ac2f67b12bFbF095013FE4Ac299"
  )
})

test("all deployable variants reproduce their CREATE2 address", async () => {
  for (const environment of ["dev", "stag", "prod"]) {
    const release = JSON.parse(
      await readFile(
        new URL(`./environments/${environment}.json`, import.meta.url),
        "utf8"
      )
    )
    assert.equal("chains" in release, false)

    for (const [variantName, variant] of Object.entries(release.variants)) {
      const artifact = JSON.parse(
        await readFile(
          new URL(`./${variant.artifact}`, import.meta.url),
          "utf8"
        )
      )
      assert.equal(
        validateVariant(release, variantName, artifact).toLowerCase(),
        variant.address.toLowerCase()
      )
    }
  }
})

test("compiler input contains the frozen sources and settings", async () => {
  const artifact = JSON.parse(
    await readFile(
      new URL("./releases/stag-london.json", import.meta.url),
      "utf8"
    )
  )
  const input = compilerInput(artifact)

  assert.equal(input.settings.evmVersion, "london")
  assert.equal(input.settings.viaIR, true)
  assert.match(
    input.sources["src/RelayDepository.sol"].content,
    /contract RelayDepository/u
  )
  assert.equal(Object.keys(input.sources).length, 7)
})

test("compiler input rejects an unknown source snapshot", () => {
  assert.throws(
    () => compilerInput({ build: { sourceSnapshot: "missing" } }),
    /Unknown source snapshot: missing/u
  )
})

test("runtime bytecode is derived for the target chain", async () => {
  const artifact = JSON.parse(
    await readFile(
      new URL("./releases/prod-cancun.json", import.meta.url),
      "utf8"
    )
  )
  const address = artifact.provenance.address
  const ethereumHash = keccak256(expectedRuntimeCode(artifact, address, 1))
  const baseHash = keccak256(expectedRuntimeCode(artifact, address, 8453))

  assert.equal(ethereumHash, artifact.provenance.runtimeCodeHash)
  assert.notEqual(baseHash, ethereumHash)
})

async function environment(name) {
  return JSON.parse(
    await readFile(
      new URL(`./environments/${name}.json`, import.meta.url),
      "utf8"
    )
  )
}

test("build-all discovers additional manifests and variants", async (t) => {
  assert.deepEqual(parseArguments(["build-all", "--solc", "/custom/solc"]), {
    command: "build-all",
    solc: "/custom/solc",
  })
  assert.throws(
    () => parseArguments(["build-all", "--env", "prod"]),
    /only accepts/u
  )
  const directory = await mkdtemp(path.join(tmpdir(), "depository-releases-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const release = await environment("prod")
  release.variants.future = release.variants.cancun
  await writeFile(path.join(directory, "future.json"), JSON.stringify(release))
  assert.deepEqual(
    listReleases(directory).map(({ variantName }) => variantName),
    ["cancun", "london", "future"]
  )
})

async function deploymentFixture(t, postDeploymentCode, chainId = 8453) {
  const release = await environment("dev")
  const variant = release.variants.cancun
  const artifact = JSON.parse(
    await readFile(new URL(`./${variant.artifact}`, import.meta.url), "utf8")
  )
  const runtime = expectedRuntimeCode(artifact, variant.address, chainId)
  const receiptRoot = await mkdtemp(path.join(tmpdir(), "depository-receipts-"))
  t.after(() => rm(receiptRoot, { recursive: true, force: true }))
  const previousKey = process.env.DEPLOYER_PRIVATE_KEY
  process.env.DEPLOYER_PRIVATE_KEY = Wallet.createRandom().privateKey
  t.after(() => {
    if (previousKey === undefined) delete process.env.DEPLOYER_PRIVATE_KEY
    else process.env.DEPLOYER_PRIVATE_KEY = previousKey
  })
  const transaction = {
    hash: `0x${"ab".repeat(32)}`,
    blockNumber: 42,
    status: 1,
  }
  let deployed = false
  const codeRequests = []
  const provider = {
    getNetwork: async () => ({ chainId: BigInt(chainId) }),
    getCode: async (address, blockTag) => {
      if (address.toLowerCase() === release.factory) return "0x01"
      codeRequests.push(blockTag)
      if (!deployed) return "0x"
      if (postDeploymentCode instanceof Error) throw postDeploymentCode
      return postDeploymentCode ?? runtime
    },
    call: async () =>
      AbiCoder.defaultAbiCoder().encode(
        ["address"],
        [release.constructor.owner]
      ),
  }
  const send = t.mock.method(Wallet.prototype, "sendTransaction", async () => ({
    hash: transaction.hash,
    wait: async () => {
      deployed = true
      return transaction
    },
  }))
  const run = () =>
    deploy(
      release,
      "cancun",
      variant,
      artifact,
      {},
      provider,
      chainId,
      receiptRoot
    )
  const receipt = async () =>
    JSON.parse(
      await readFile(path.join(receiptRoot, "dev", `${chainId}.json`), "utf8")
    )
  return {
    run,
    receipt,
    transaction,
    send,
    codeRequests,
    provider,
    recover: () => {
      postDeploymentCode = runtime
    },
    alreadyDeployed: () => {
      deployed = true
    },
  }
}

for (const failure of ["0x", "0x1234", new Error("RPC unavailable")]) {
  test(`mined receipt survives post-deployment verification failure: ${failure}`, async (t) => {
    const fixture = await deploymentFixture(t, failure)
    await assert.rejects(
      fixture.run,
      /receipt saved|code hash|RPC unavailable/u
    )
    const pending = await fixture.receipt()
    assert.equal(pending.transactionHash, fixture.transaction.hash)
    assert.equal(pending.blockNumber, fixture.transaction.blockNumber)
    assert.equal(pending.verification, "pending")
    assert.deepEqual(fixture.codeRequests, ["latest", 42])

    fixture.recover()
    await fixture.run()
    const recovered = await fixture.receipt()
    assert.equal(recovered.verification, "verified")
    assert.equal(recovered.transactionHash, pending.transactionHash)
    assert.equal(recovered.blockNumber, pending.blockNumber)
    assert.equal(fixture.send.mock.callCount(), 1)
  })
}

test("already deployed targets get a receipt without inventing a transaction", async (t) => {
  const fixture = await deploymentFixture(t)
  fixture.alreadyDeployed()
  await fixture.run()
  assert.equal(fixture.send.mock.callCount(), 0)
  const receipt = await fixture.receipt()
  assert.equal(receipt.verification, "verified")
  assert.equal(receipt.transactionHash, null)
  assert.equal(receipt.blockNumber, null)
})

test("successful deployment records verified bytecode and preserves its transaction on rerun", async (t) => {
  const fixture = await deploymentFixture(t)
  await fixture.run()
  const initial = await fixture.receipt()
  assert.equal(initial.verification, "verified")
  assert.equal(initial.transactionHash, fixture.transaction.hash)
  await fixture.run()
  assert.deepEqual(await fixture.receipt(), initial)
  assert.equal(fixture.send.mock.callCount(), 1)
})

test("deploy accepts an unlisted chain but rejects an RPC chain-ID mismatch", async (t) => {
  const chainId = 999999
  const fixture = await deploymentFixture(t, undefined, chainId)
  const getNetwork = fixture.provider.getNetwork
  fixture.provider.getNetwork = async () => ({ chainId: 8453n })
  await assert.rejects(
    fixture.run,
    /RPC returned chain ID 8453, expected 999999/u
  )
  assert.equal(fixture.send.mock.callCount(), 0)

  fixture.provider.getNetwork = getNetwork
  await fixture.run()
  const receipt = await fixture.receipt()
  assert.equal(receipt.chainId, chainId)
  assert.equal(receipt.verification, "verified")
})
