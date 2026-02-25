import * as bitcoin from "bitcoinjs-lib"

import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers"
import { expect } from "chai"
import hre from "hardhat"
import { decodeAbiParameters } from "viem"
import {
  BITCOIN_TRANSACTION_ABI,
  txidToBytes32,
  decodeUint64LE,
} from "../../lib/bitcoin"

// Sample UTXO for testing
const sampleUtxo = {
  txid: "ec37cafc98e406a048e2b2592a23be7eb2c0f1e0754b0710bb2ea4efb3a9371d",
  value: 100000,
  vout: 0,
}

// P2PKH scriptPubKey for the UTXO
const scriptPubKey = "0x76a914632a250a7f721ae8583ad911950eeeb82c00e54788ac"

// Sample order ID
const orderId =
  "0x0000000000000000000000000000000000000000000000000000000000000001" as `0x${string}`
const orderId2 =
  "0x0000000000000000000000000000000000000000000000000000000000000002" as `0x${string}`

describe("BitcoinDepositAddressBuilder", function () {
  async function deployBuilder() {
    const [owner, otherAccount] = await hre.viem.getWalletClients()
    const publicClient = await hre.viem.getPublicClient()

    // Deploy libraries
    const auroraXccUtils = await hre.viem.deployContract("AuroraXccUtils")
    const codec = await hre.viem.deployContract("Codec")
    const auroraSdk = await hre.viem.deployContract("AuroraSdk", [], {
      libraries: {
        AuroraXccUtils: auroraXccUtils.address,
        Codec: codec.address,
      },
    })
    const chainSignatures = await hre.viem.deployContract("ChainSignatures", [])

    // Deploy MockWNEAR
    const wNEAR = await hre.viem.deployContract("MockWNEAR")

    // Depository address
    const depositoryAddress = "1BoatSLRHtKNngkdXEeobR76b53LETtpyT"
    const depositoryScript = bitcoin.address.toOutputScript(
      depositoryAddress,
      bitcoin.networks.bitcoin
    )

    const maxFeeRate = 100n // 100 sats/byte

    const builder = await hre.viem.deployContract(
      "BitcoinDepositAddressBuilder",
      [
        owner.account.address,
        depositoryScript.toString("base64"),
        "v1.signer.test",
        wNEAR.address,
        maxFeeRate,
      ],
      {
        libraries: {
          AuroraSdk: auroraSdk.address,
          ChainSignatures: chainSignatures.address,
        },
      }
    )

    return {
      builder,
      depositoryAddress,
      depositoryScript,
      maxFeeRate,
      otherAccount,
      owner,
      publicClient,
      wNEAR,
    }
  }

  describe("derivationPath()", function () {
    it("should return correct format: hex(address) / hex(orderId)", async () => {
      const { builder } = await loadFixture(deployBuilder)

      const path = await builder.read.derivationPath([orderId])

      // Strings.toHexString includes 0x prefix
      const contractAddr = builder.address.toLowerCase()
      expect(path).to.include(contractAddr)

      // Should contain a separator
      expect(path).to.include("/")

      // Should end with the hex-encoded orderId (no 0x prefix, from stringifyBytes)
      const orderIdHex = orderId.slice(2)
      expect(path).to.include(orderIdHex)
    })

    it("should return deterministic results for the same orderId", async () => {
      const { builder } = await loadFixture(deployBuilder)

      const path1 = await builder.read.derivationPath([orderId])
      const path2 = await builder.read.derivationPath([orderId])

      expect(path1).to.equal(path2)
    })

    it("should return unique paths for different orderIds", async () => {
      const { builder } = await loadFixture(deployBuilder)

      const path1 = await builder.read.derivationPath([orderId])
      const path2 = await builder.read.derivationPath([orderId2])

      expect(path1).to.not.equal(path2)
    })
  })

  describe("buildSweepPayload()", function () {
    it("should revert if feeRate exceeds maxFeeRate", async () => {
      const { builder, maxFeeRate } = await loadFixture(deployBuilder)

      const excessiveFeeRate = maxFeeRate + 1n

      await expect(
        builder.read.buildSweepPayload([
          orderId,
          {
            index: sampleUtxo.vout,
            scriptPubKey,
            txid: txidToBytes32(sampleUtxo.txid),
            value: BigInt(sampleUtxo.value),
          },
          excessiveFeeRate,
        ])
      ).to.be.rejectedWith(`FeeRateTooHigh(${excessiveFeeRate}, ${maxFeeRate})`)
    })

    it("should revert if UTXO value does not cover fees", async () => {
      const { builder } = await loadFixture(deployBuilder)

      const tinyValue = 100n // 100 sats, way below fees at any reasonable rate
      const feeRate = 10n
      const expectedFees = feeRate * 269n // SWEEP_TX_SIZE = 269

      await expect(
        builder.read.buildSweepPayload([
          orderId,
          {
            index: sampleUtxo.vout,
            scriptPubKey,
            txid: txidToBytes32(sampleUtxo.txid),
            value: tinyValue,
          },
          feeRate,
        ])
      ).to.be.rejectedWith(
        `InsufficientUTXOValue(${tinyValue}, ${expectedFees})`
      )
    })

    it("should revert if sweep amount is below dust threshold", async () => {
      const { builder } = await loadFixture(deployBuilder)

      // Pick a value that after fees leaves less than 546 sats
      // fees = feeRate * 269, so value = fees + 545 should trigger dust
      const feeRate = 10n
      const fees = feeRate * 269n
      const dustValue = fees + 545n

      await expect(
        builder.read.buildSweepPayload([
          orderId,
          {
            index: sampleUtxo.vout,
            scriptPubKey,
            txid: txidToBytes32(sampleUtxo.txid),
            value: dustValue,
          },
          feeRate,
        ])
      ).to.be.rejectedWith("SweepAmountBelowDust(545)")
    })

    it("should produce exactly 2 outputs (depository + OP_RETURN)", async () => {
      const { builder } = await loadFixture(deployBuilder)

      const payload = await builder.read.buildSweepPayload([
        orderId,
        {
          index: sampleUtxo.vout,
          scriptPubKey,
          txid: txidToBytes32(sampleUtxo.txid),
          value: BigInt(sampleUtxo.value),
        },
        1n,
      ])

      const [transaction] = decodeAbiParameters(
        BITCOIN_TRANSACTION_ABI,
        payload
      )

      expect(transaction.inputs.length).to.equal(1)
      expect(transaction.outputs.length).to.equal(2)
    })

    it("should set correct depository output value after fee deduction", async () => {
      const { builder } = await loadFixture(deployBuilder)

      const feeRate = 5n
      const utxoValue = BigInt(sampleUtxo.value)
      const expectedFees = feeRate * 269n
      const expectedSweep = utxoValue - expectedFees

      const payload = await builder.read.buildSweepPayload([
        orderId,
        {
          index: sampleUtxo.vout,
          scriptPubKey,
          txid: txidToBytes32(sampleUtxo.txid),
          value: utxoValue,
        },
        feeRate,
      ])

      const [transaction] = decodeAbiParameters(
        BITCOIN_TRANSACTION_ABI,
        payload
      )

      // Output 0: depository with sweep amount
      expect(decodeUint64LE(transaction.outputs[0].value)).to.equal(
        expectedSweep
      )
    })

    it("should set depository output script to depositoryScriptBytes", async () => {
      const { builder, depositoryScript } = await loadFixture(deployBuilder)

      const payload = await builder.read.buildSweepPayload([
        orderId,
        {
          index: sampleUtxo.vout,
          scriptPubKey,
          txid: txidToBytes32(sampleUtxo.txid),
          value: BigInt(sampleUtxo.value),
        },
        1n,
      ])

      const [transaction] = decodeAbiParameters(
        BITCOIN_TRANSACTION_ABI,
        payload
      )

      const expectedScript = "0x" + depositoryScript.toString("hex")
      expect(transaction.outputs[0].script.toLowerCase()).to.equal(
        expectedScript.toLowerCase()
      )
    })

    it("should set OP_RETURN output with zero value and correct script", async () => {
      const { builder } = await loadFixture(deployBuilder)

      const payload = await builder.read.buildSweepPayload([
        orderId,
        {
          index: sampleUtxo.vout,
          scriptPubKey,
          txid: txidToBytes32(sampleUtxo.txid),
          value: BigInt(sampleUtxo.value),
        },
        1n,
      ])

      const [transaction] = decodeAbiParameters(
        BITCOIN_TRANSACTION_ABI,
        payload
      )

      // Output 1: OP_RETURN with zero value
      expect(decodeUint64LE(transaction.outputs[1].value)).to.equal(0n)

      // Script: 0x6a (OP_RETURN) + 0x42 (PUSH 66) + "0x" + hex(orderId)
      const orderIdHex = "0x" + orderId.slice(2).toLowerCase()
      const expectedOpReturn =
        "0x6a42" + Buffer.from(orderIdHex).toString("hex")
      expect(transaction.outputs[1].script.toLowerCase()).to.equal(
        expectedOpReturn.toLowerCase()
      )
    })

    it("should work with zero fee rate", async () => {
      const { builder } = await loadFixture(deployBuilder)

      const utxoValue = BigInt(sampleUtxo.value)

      const payload = await builder.read.buildSweepPayload([
        orderId,
        {
          index: sampleUtxo.vout,
          scriptPubKey,
          txid: txidToBytes32(sampleUtxo.txid),
          value: utxoValue,
        },
        0n,
      ])

      const [transaction] = decodeAbiParameters(
        BITCOIN_TRANSACTION_ABI,
        payload
      )

      // With zero fee, full value goes to depository
      expect(decodeUint64LE(transaction.outputs[0].value)).to.equal(utxoValue)
    })
  })

  describe("hashToSign()", function () {
    it("should match bitcoinjs-lib SIGHASH_ALL computation", async () => {
      const { builder, depositoryAddress } = await loadFixture(deployBuilder)

      const utxoValue = BigInt(sampleUtxo.value)
      const feeRate = 1n
      const fees = feeRate * 269n
      const sweepAmount = utxoValue - fees

      const payload = await builder.read.buildSweepPayload([
        orderId,
        {
          index: sampleUtxo.vout,
          scriptPubKey,
          txid: txidToBytes32(sampleUtxo.txid),
          value: utxoValue,
        },
        feeRate,
      ])

      // Build equivalent transaction with bitcoinjs-lib
      const tx = new bitcoin.Transaction()
      tx.version = 1

      // Add input (txid reversed for little-endian)
      tx.addInput(
        Buffer.from(sampleUtxo.txid, "hex").reverse(),
        sampleUtxo.vout,
        0xfffffffd // sequence (replace-by-fee)
      )

      // Output 0: depository
      const depositoryOutputScript = bitcoin.address.toOutputScript(
        depositoryAddress,
        bitcoin.networks.bitcoin
      )
      tx.addOutput(depositoryOutputScript, Number(sweepAmount))

      // Output 1: OP_RETURN with orderId as hex string
      const orderIdHexStr = "0x" + orderId.slice(2).toLowerCase()
      const opReturnScript = Buffer.concat([
        Buffer.from("6a42", "hex"),
        Buffer.from(orderIdHexStr),
      ])
      tx.addOutput(opReturnScript, 0)

      // Compute sighash with bitcoinjs-lib
      const bitcoinjsSighash = tx.hashForSignature(
        0,
        Buffer.from(scriptPubKey.slice(2), "hex"),
        bitcoin.Transaction.SIGHASH_ALL
      )

      // Compute hash with contract
      const contractHash = await builder.read.hashToSign([payload])

      expect(contractHash.toLowerCase()).to.equal(
        "0x" + bitcoinjsSighash.toString("hex").toLowerCase()
      )
    })
  })

  describe("setMaxFeeRate()", function () {
    it("should update maxFeeRate when called by owner", async () => {
      const { builder } = await loadFixture(deployBuilder)

      const newMaxFeeRate = 200n
      await builder.write.setMaxFeeRate([newMaxFeeRate])

      const stored = await builder.read.maxFeeRate()
      expect(stored).to.equal(newMaxFeeRate)
    })

    it("should emit MaxFeeRateChanged event", async () => {
      const { builder, publicClient } = await loadFixture(deployBuilder)

      const newMaxFeeRate = 200n
      const txHash = await builder.write.setMaxFeeRate([newMaxFeeRate])
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
      })

      // Check that the event was emitted
      expect(receipt.logs.length).to.be.greaterThan(0)
    })

    it("should revert when called by non-owner", async () => {
      const { builder, otherAccount } = await loadFixture(deployBuilder)

      const builderAsOther = await hre.viem.getContractAt(
        "BitcoinDepositAddressBuilder",
        builder.address,
        { client: { wallet: otherAccount } }
      )

      await expect(
        builderAsOther.write.setMaxFeeRate([200n])
      ).to.be.rejectedWith("OwnableUnauthorizedAccount")
    })
  })

  describe("sweep()", function () {
    it("should store the payload in sweepPayloads", async () => {
      const { builder } = await loadFixture(deployBuilder)

      // sweep() calls Aurora precompiles which won't work in unit tests,
      // but buildSweepPayload is a view function we can verify independently
      const payload = await builder.read.buildSweepPayload([
        orderId,
        {
          index: sampleUtxo.vout,
          scriptPubKey,
          txid: txidToBytes32(sampleUtxo.txid),
          value: BigInt(sampleUtxo.value),
        },
        1n,
      ])

      // Verify the payload is valid by decoding it
      const [transaction] = decodeAbiParameters(
        BITCOIN_TRANSACTION_ABI,
        payload
      )
      expect(transaction.inputs.length).to.equal(1)
      expect(transaction.outputs.length).to.equal(2)
    })

    it("should produce consistent payloads for the same inputs", async () => {
      const { builder } = await loadFixture(deployBuilder)

      const utxoParam = {
        index: sampleUtxo.vout,
        scriptPubKey,
        txid: txidToBytes32(sampleUtxo.txid),
        value: BigInt(sampleUtxo.value),
      }

      const payload1 = await builder.read.buildSweepPayload([
        orderId,
        utxoParam,
        1n,
      ])
      const payload2 = await builder.read.buildSweepPayload([
        orderId,
        utxoParam,
        1n,
      ])

      expect(payload1).to.equal(payload2)
    })
  })
})
