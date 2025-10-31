import { expect } from "chai"
import hre from "hardhat"

const SIGN_GAS = 30_000_000_000_000n
const CALLBACK_GAS = 10_000_000_000_000n
const HASH_TO_SIGN =
  "0x5d3d45f0a5ae26873aa88714ab7636f63953326819151dd6e00296de98122963"
const CURVE = "Eddsa"

describe("RelayMultisigSigner - signature guards", function () {
  let owner: any
  let relayMultisigSigner: any
  let publicClient: any

  beforeEach(async function () {
    ;[owner] = await hre.viem.getWalletClients()
    publicClient = await hre.viem.getPublicClient()

    const wNear = await hre.viem.deployContract("MockWNEAR")
    const auroraXccUtils = await hre.viem.deployContract("AuroraXccUtils")
    const codec = await hre.viem.deployContract("Codec")
    const auroraSdk = await hre.viem.deployContract("AuroraSdk", [], {
      libraries: {
        AuroraXccUtils: auroraXccUtils.address,
        Codec: codec.address,
      },
    })
    const chainSignatures = await hre.viem.deployContract("ChainSignatures")

    relayMultisigSigner = await hre.viem.deployContract(
      "RelayMultisigSignerHarness",
      [owner.account.address, "signer.testnet", wNear.address],
      {
        libraries: {
          AuroraSdk: auroraSdk.address,
          ChainSignatures: chainSignatures.address,
        },
      }
    )
  })

  it("short circuits when signature already stored", async function () {
    const approvalTx = await relayMultisigSigner.write.approveSignature(
      [HASH_TO_SIGN, CURVE],
      { account: owner.account }
    )
    await publicClient.waitForTransactionReceipt({ hash: approvalTx })

    const presetSignature = "0x1234"
    const presetTx = await relayMultisigSigner.write.__setSignature(
      [HASH_TO_SIGN, CURVE, presetSignature],
      { account: owner.account }
    )
    await publicClient.waitForTransactionReceipt({ hash: presetTx })

    const signTx = await relayMultisigSigner.write.sign(
      [HASH_TO_SIGN, CURVE, SIGN_GAS, CALLBACK_GAS],
      { account: owner.account }
    )
    await publicClient.waitForTransactionReceipt({ hash: signTx })

    const storedSignature = await relayMultisigSigner.read.signatures([
      HASH_TO_SIGN,
      CURVE,
    ])
    expect(storedSignature).to.equal(presetSignature)
  })

  it("skips signing when there is a recent pending request", async function () {
    const approvalTx = await relayMultisigSigner.write.approveSignature(
      [HASH_TO_SIGN, CURVE],
      { account: owner.account }
    )
    await publicClient.waitForTransactionReceipt({ hash: approvalTx })

    const pendingTimestamp = 2_000_000_000_000n
    const pendingTx = await relayMultisigSigner.write.__setPendingTimestamp(
      [HASH_TO_SIGN, CURVE, pendingTimestamp],
      { account: owner.account }
    )
    await publicClient.waitForTransactionReceipt({ hash: pendingTx })

    const signTx = await relayMultisigSigner.write.sign(
      [HASH_TO_SIGN, CURVE, SIGN_GAS, CALLBACK_GAS],
      { account: owner.account }
    )
    await publicClient.waitForTransactionReceipt({ hash: signTx })

    const storedSignature = await relayMultisigSigner.read.signatures([
      HASH_TO_SIGN,
      CURVE,
    ])
    expect(storedSignature).to.equal("0x")
  })

  it("allows requesting a signature again once the throttle window passes", async function () {
    const approvalTx = await relayMultisigSigner.write.approveSignature(
      [HASH_TO_SIGN, CURVE],
      { account: owner.account }
    )
    await publicClient.waitForTransactionReceipt({ hash: approvalTx })

    const latestBlock = await publicClient.getBlock({ blockTag: "latest" })
    const setPendingTx = await relayMultisigSigner.write.__setPendingTimestamp(
      [HASH_TO_SIGN, CURVE, latestBlock.timestamp],
      { account: owner.account }
    )
    await publicClient.waitForTransactionReceipt({ hash: setPendingTx })

    const immediateCheck =
      await relayMultisigSigner.simulate.__tryMarkPendingSignature(
        [HASH_TO_SIGN, CURVE],
        { account: owner.account }
      )
    expect(immediateCheck.result).to.equal(false)

    await hre.network.provider.send("evm_increaseTime", [60 * 5 + 1])
    await hre.network.provider.send("evm_mine")

    const readyCheck =
      await relayMultisigSigner.simulate.__tryMarkPendingSignature(
        [HASH_TO_SIGN, CURVE],
        { account: owner.account }
      )
    expect(readyCheck.result).to.equal(true)

    const markTx = await relayMultisigSigner.write.__tryMarkPendingSignature(
      [HASH_TO_SIGN, CURVE],
      { account: owner.account }
    )
    await publicClient.waitForTransactionReceipt({ hash: markTx })

    const pendingTimestamp = await relayMultisigSigner.read.pendingSignatures([
      HASH_TO_SIGN,
      CURVE,
    ])
    const updatedBlock = await publicClient.getBlock({ blockTag: "latest" })
    expect(pendingTimestamp).to.equal(updatedBlock.timestamp)
  })
})
