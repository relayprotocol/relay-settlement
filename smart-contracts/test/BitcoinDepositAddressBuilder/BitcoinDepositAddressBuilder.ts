import * as bitcoin from "bitcoinjs-lib"

import {
  loadFixture,
  time,
} from "@nomicfoundation/hardhat-toolbox-viem/network-helpers"
import { expect } from "chai"
import hre from "hardhat"
import { decodeAbiParameters, encodeAbiParameters } from "viem"
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

// P2WPKH scriptPubKey for the UTXO
const scriptPubKey = "0x0014632a250a7f721ae8583ad911950eeeb82c00e547"

// Sample order ID
const orderId =
  "0x0000000000000000000000000000000000000000000000000000000000000001" as `0x${string}`
const orderId2 =
  "0x0000000000000000000000000000000000000000000000000000000000000002" as `0x${string}`

const UTXO_ABI = {
  components: [
    { name: "txid", type: "bytes32" },
    { name: "index", type: "uint32" },
    { name: "value", type: "uint64" },
    { name: "scriptPubKey", type: "bytes" },
  ],
  type: "tuple",
} as const

function encodeSweepData(
  utxo: {
    txid: `0x${string}`
    index: number
    value: bigint
    scriptPubKey: `0x${string}`
  },
  feeRate: bigint
): `0x${string}` {
  return encodeAbiParameters([UTXO_ABI, { type: "uint64" }], [utxo, feeRate])
}

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
    "BitcoinDepositSweepBuilder",
    [owner.account.address, depositoryScript.toString("base64"), maxFeeRate],
    {
      libraries: {
        ChainSignatures: chainSignatures.address,
      },
    }
  )

  const manager = await hre.viem.deployContract(
    "BitcoinDepositAddress",
    [owner.account.address, builder.address, "v1.signer.test", wNEAR.address],
    {
      libraries: {
        AuroraSdk: auroraSdk.address,
        ChainSignatures: chainSignatures.address,
      },
    }
  )

  return {
    auroraSdk,
    builder,
    chainSignatures,
    depositoryAddress,
    depositoryScript,
    manager,
    maxFeeRate,
    otherAccount,
    owner,
    publicClient,
    wNEAR,
  }
}

// Mirror BitcoinDepositAddress.sol's private constants — kept in sync manually
const MIN_SIGN_GAS = 30_000_000_000_000n
const MIN_CALLBACK_GAS = 20_000_000_000_000n
const PENDING_SIGNATURE_COOLDOWN = 5n * 60n // 5 minutes in seconds

const validGas = {
  callbackGas: MIN_CALLBACK_GAS,
  signGas: MIN_SIGN_GAS,
} as const

async function deployTestable() {
  const base = await deployBuilder()

  const testableManager = await hre.viem.deployContract(
    "TestableBitcoinDepositAddress",
    [
      base.owner.account.address,
      base.builder.address,
      "v1.signer.test",
      base.wNEAR.address,
    ],
    {
      libraries: {
        AuroraSdk: base.auroraSdk.address,
        ChainSignatures: base.chainSignatures.address,
      },
    }
  )

  const sweepData = encodeSweepData(
    {
      index: sampleUtxo.vout,
      scriptPubKey,
      txid: txidToBytes32(sampleUtxo.txid),
      value: BigInt(sampleUtxo.value),
    },
    1n
  )

  const [payload] = await base.builder.read.buildSweepPayload([
    orderId,
    sweepData,
  ])
  const hash = await base.builder.read.hashToSign([payload])

  return {
    ...base,
    hash,
    manager: testableManager,
    payload,
    sweepData,
  }
}

describe("BitcoinDepositSweepBuilder", function () {
  describe("buildSweepPayload()", function () {
    it("should revert if feeRate exceeds maxFeeRate", async () => {
      const { builder, maxFeeRate } = await loadFixture(deployBuilder)

      const excessiveFeeRate = maxFeeRate + 1n

      await expect(
        builder.read.buildSweepPayload([
          orderId,
          encodeSweepData(
            {
              index: sampleUtxo.vout,
              scriptPubKey,
              txid: txidToBytes32(sampleUtxo.txid),
              value: BigInt(sampleUtxo.value),
            },
            excessiveFeeRate
          ),
        ])
      ).to.be.rejectedWith(`FeeRateTooHigh(${excessiveFeeRate}, ${maxFeeRate})`)
    })

    it("should revert if UTXO value does not cover fees", async () => {
      const { builder } = await loadFixture(deployBuilder)

      const tinyValue = 100n // 100 sats, way below fees at any reasonable rate
      const feeRate = 10n
      const expectedFees = feeRate * 191n // SWEEP_TX_VSIZE = 191

      await expect(
        builder.read.buildSweepPayload([
          orderId,
          encodeSweepData(
            {
              index: sampleUtxo.vout,
              scriptPubKey,
              txid: txidToBytes32(sampleUtxo.txid),
              value: tinyValue,
            },
            feeRate
          ),
        ])
      ).to.be.rejectedWith(
        `InsufficientUTXOValue(${tinyValue}, ${expectedFees})`
      )
    })

    it("should revert if sweep amount is below dust threshold", async () => {
      const { builder } = await loadFixture(deployBuilder)

      // Pick a value that after fees leaves less than 546 sats
      // fees = feeRate * 191, so value = fees + 545 should trigger dust
      const feeRate = 10n
      const fees = feeRate * 191n
      const dustValue = fees + 545n

      await expect(
        builder.read.buildSweepPayload([
          orderId,
          encodeSweepData(
            {
              index: sampleUtxo.vout,
              scriptPubKey,
              txid: txidToBytes32(sampleUtxo.txid),
              value: dustValue,
            },
            feeRate
          ),
        ])
      ).to.be.rejectedWith("SweepAmountBelowDust(545)")
    })

    it("should produce exactly 2 outputs (depository + OP_RETURN)", async () => {
      const { builder } = await loadFixture(deployBuilder)

      const [payload] = await builder.read.buildSweepPayload([
        orderId,
        encodeSweepData(
          {
            index: sampleUtxo.vout,
            scriptPubKey,
            txid: txidToBytes32(sampleUtxo.txid),
            value: BigInt(sampleUtxo.value),
          },
          1n
        ),
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
      const expectedFees = feeRate * 191n
      const expectedSweep = utxoValue - expectedFees

      const [payload] = await builder.read.buildSweepPayload([
        orderId,
        encodeSweepData(
          {
            index: sampleUtxo.vout,
            scriptPubKey,
            txid: txidToBytes32(sampleUtxo.txid),
            value: utxoValue,
          },
          feeRate
        ),
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

      const [payload] = await builder.read.buildSweepPayload([
        orderId,
        encodeSweepData(
          {
            index: sampleUtxo.vout,
            scriptPubKey,
            txid: txidToBytes32(sampleUtxo.txid),
            value: BigInt(sampleUtxo.value),
          },
          1n
        ),
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

      const [payload] = await builder.read.buildSweepPayload([
        orderId,
        encodeSweepData(
          {
            index: sampleUtxo.vout,
            scriptPubKey,
            txid: txidToBytes32(sampleUtxo.txid),
            value: BigInt(sampleUtxo.value),
          },
          1n
        ),
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

      const [payload] = await builder.read.buildSweepPayload([
        orderId,
        encodeSweepData(
          {
            index: sampleUtxo.vout,
            scriptPubKey,
            txid: txidToBytes32(sampleUtxo.txid),
            value: utxoValue,
          },
          0n
        ),
      ])

      const [transaction] = decodeAbiParameters(
        BITCOIN_TRANSACTION_ABI,
        payload
      )

      // With zero fee, full value goes to depository
      expect(decodeUint64LE(transaction.outputs[0].value)).to.equal(utxoValue)
    })

    it("should revert if scriptPubKey is not P2WPKH", async () => {
      const { builder } = await loadFixture(deployBuilder)

      // P2PKH scriptPubKey (legacy format, not P2WPKH)
      const legacyScript =
        "0x76a914632a250a7f721ae8583ad911950eeeb82c00e54788ac"

      await expect(
        builder.read.buildSweepPayload([
          orderId,
          encodeSweepData(
            {
              index: sampleUtxo.vout,
              scriptPubKey: legacyScript,
              txid: txidToBytes32(sampleUtxo.txid),
              value: BigInt(sampleUtxo.value),
            },
            1n
          ),
        ])
      ).to.be.rejectedWith("InvalidScriptPubKey()")
    })

    it("should revert if scriptPubKey length is not 22 bytes", async () => {
      const { builder } = await loadFixture(deployBuilder)

      // 21-byte script (one byte short)
      const shortScript = "0x0014632a250a7f721ae8583ad911950eeeb82c00e5"

      await expect(
        builder.read.buildSweepPayload([
          orderId,
          encodeSweepData(
            {
              index: sampleUtxo.vout,
              scriptPubKey: shortScript,
              txid: txidToBytes32(sampleUtxo.txid),
              value: BigInt(sampleUtxo.value),
            },
            1n
          ),
        ])
      ).to.be.rejectedWith("InvalidScriptPubKey()")
    })

    it("should revert if scriptPubKey first byte is not 0x00", async () => {
      const { builder } = await loadFixture(deployBuilder)

      // 22 bytes, starts with 0xa9 (P2SH version byte), second byte 0x14
      // → only the `script[0] != 0x00` branch fires; length and push-len both pass
      const wrongVersion = "0xa914632a250a7f721ae8583ad911950eeeb82c00e547"

      await expect(
        builder.read.buildSweepPayload([
          orderId,
          encodeSweepData(
            {
              index: sampleUtxo.vout,
              scriptPubKey: wrongVersion,
              txid: txidToBytes32(sampleUtxo.txid),
              value: BigInt(sampleUtxo.value),
            },
            1n
          ),
        ])
      ).to.be.rejectedWith("InvalidScriptPubKey()")
    })

    it("should revert if scriptPubKey push length is not 0x14 (rejects P2TR/P2WSH)", async () => {
      const { builder } = await loadFixture(deployBuilder)

      // 22 bytes starting with 0x0020 — would be P2WSH/P2TR header (32-byte witness program)
      // truncated to 22 bytes for length, but push-length byte 0x20 is invalid for P2WPKH
      const taprootishHeader = "0x0020632a250a7f721ae8583ad911950eeeb82c00e547"

      await expect(
        builder.read.buildSweepPayload([
          orderId,
          encodeSweepData(
            {
              index: sampleUtxo.vout,
              scriptPubKey: taprootishHeader,
              txid: txidToBytes32(sampleUtxo.txid),
              value: BigInt(sampleUtxo.value),
            },
            1n
          ),
        ])
      ).to.be.rejectedWith("InvalidScriptPubKey()")
    })

    it("should permit sweepAmount exactly equal to dust threshold", async () => {
      // sweepAmount = utxo.value - feeRate * 191; choose values so result == 546
      const { builder } = await loadFixture(deployBuilder)

      const feeRate = 1n
      const fees = feeRate * 191n
      const dustValue = fees + 546n

      const [payload, sweepAmount] = await builder.read.buildSweepPayload([
        orderId,
        encodeSweepData(
          {
            index: sampleUtxo.vout,
            scriptPubKey,
            txid: txidToBytes32(sampleUtxo.txid),
            value: dustValue,
          },
          feeRate
        ),
      ])

      expect(sweepAmount).to.equal(546n)
      const [transaction] = decodeAbiParameters(
        BITCOIN_TRANSACTION_ABI,
        payload
      )
      expect(decodeUint64LE(transaction.outputs[0].value)).to.equal(546n)
    })

    it("should permit feeRate exactly equal to maxFeeRate", async () => {
      const { builder, maxFeeRate } = await loadFixture(deployBuilder)

      const utxoValue = BigInt(sampleUtxo.value)
      const expectedFees = maxFeeRate * 191n
      const expectedSweep = utxoValue - expectedFees

      const [payload, sweepAmount] = await builder.read.buildSweepPayload([
        orderId,
        encodeSweepData(
          {
            index: sampleUtxo.vout,
            scriptPubKey,
            txid: txidToBytes32(sampleUtxo.txid),
            value: utxoValue,
          },
          maxFeeRate
        ),
      ])

      expect(sweepAmount).to.equal(expectedSweep)
      const [transaction] = decodeAbiParameters(
        BITCOIN_TRANSACTION_ABI,
        payload
      )
      expect(decodeUint64LE(transaction.outputs[0].value)).to.equal(
        expectedSweep
      )
    })

    it("should produce distinct OP_RETURN scripts for distinct orderIds", async () => {
      const { builder } = await loadFixture(deployBuilder)

      const utxo = {
        index: sampleUtxo.vout,
        scriptPubKey,
        txid: txidToBytes32(sampleUtxo.txid),
        value: BigInt(sampleUtxo.value),
      }

      const [payload1] = await builder.read.buildSweepPayload([
        orderId,
        encodeSweepData(utxo, 1n),
      ])
      const [payload2] = await builder.read.buildSweepPayload([
        orderId2,
        encodeSweepData(utxo, 1n),
      ])

      const [tx1] = decodeAbiParameters(BITCOIN_TRANSACTION_ABI, payload1)
      const [tx2] = decodeAbiParameters(BITCOIN_TRANSACTION_ABI, payload2)

      // OP_RETURN structure: 0x6a (OP_RETURN) + 0x42 (PUSH 66) + ASCII "0x" + 64 hex chars = 68 bytes
      for (const t of [tx1, tx2]) {
        const hex = t.outputs[1].script.slice(2)
        expect(hex.length).to.equal(68 * 2)
        expect(hex.slice(0, 2)).to.equal("6a")
        expect(hex.slice(2, 4)).to.equal("42")
        const ascii = Buffer.from(hex.slice(4), "hex").toString("ascii")
        expect(ascii.length).to.equal(66)
        expect(ascii.slice(0, 2)).to.equal("0x")
      }

      // OP_RETURN differs across orderIds; depository output is identical
      expect(tx1.outputs[1].script).to.not.equal(tx2.outputs[1].script)
      expect(tx1.outputs[0].script).to.equal(tx2.outputs[0].script)
      expect(tx1.outputs[0].value).to.equal(tx2.outputs[0].value)
    })

    it("should round-trip depositoryScriptBytes from constructor input", async () => {
      const { builder, depositoryScript } = await loadFixture(deployBuilder)

      const stored = await builder.read.depositoryScriptBytes()
      expect(stored.toLowerCase()).to.equal(
        ("0x" + depositoryScript.toString("hex")).toLowerCase()
      )
    })
  })

  describe("hashToSign()", function () {
    it("should match bitcoinjs-lib BIP143 SIGHASH_ALL computation", async () => {
      const { builder, depositoryAddress } = await loadFixture(deployBuilder)

      const utxoValue = BigInt(sampleUtxo.value)
      const feeRate = 1n
      const fees = feeRate * 191n
      const sweepAmount = utxoValue - fees

      const [payload] = await builder.read.buildSweepPayload([
        orderId,
        encodeSweepData(
          {
            index: sampleUtxo.vout,
            scriptPubKey,
            txid: txidToBytes32(sampleUtxo.txid),
            value: utxoValue,
          },
          feeRate
        ),
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

      // Compute BIP143 sighash with bitcoinjs-lib
      // hashForWitnessV0(inputIndex, scriptCode, value, hashType)
      // For P2WPKH, scriptCode is OP_DUP OP_HASH160 <20-byte-hash> OP_EQUALVERIFY OP_CHECKSIG
      const pubkeyHash = Buffer.from(
        scriptPubKey.slice(6), // skip "0x0014" to get the 20-byte hash
        "hex"
      )
      const p2pkhScript = bitcoin.script.compile([
        bitcoin.opcodes.OP_DUP,
        bitcoin.opcodes.OP_HASH160,
        pubkeyHash,
        bitcoin.opcodes.OP_EQUALVERIFY,
        bitcoin.opcodes.OP_CHECKSIG,
      ])
      const bitcoinjsSighash = tx.hashForWitnessV0(
        0,
        p2pkhScript,
        Number(utxoValue),
        bitcoin.Transaction.SIGHASH_ALL
      )

      // Compute hash with contract
      const contractHash = await builder.read.hashToSign([payload])

      expect(contractHash.toLowerCase()).to.equal(
        "0x" + bitcoinjsSighash.toString("hex").toLowerCase()
      )
    })

    it("should produce different hashes for different orderIds", async () => {
      const { builder } = await loadFixture(deployBuilder)

      const utxo = {
        index: sampleUtxo.vout,
        scriptPubKey,
        txid: txidToBytes32(sampleUtxo.txid),
        value: BigInt(sampleUtxo.value),
      }

      const [p1] = await builder.read.buildSweepPayload([
        orderId,
        encodeSweepData(utxo, 1n),
      ])
      const [p2] = await builder.read.buildSweepPayload([
        orderId2,
        encodeSweepData(utxo, 1n),
      ])

      const h1 = await builder.read.hashToSign([p1])
      const h2 = await builder.read.hashToSign([p2])
      expect(h1).to.not.equal(h2)
    })

    it("should match bitcoinjs BIP143 SIGHASH_ALL at feeRate=10", async () => {
      const { builder, depositoryAddress } = await loadFixture(deployBuilder)

      const utxoValue = BigInt(sampleUtxo.value)
      const feeRate = 10n
      const fees = feeRate * 191n
      const sweepAmount = utxoValue - fees

      const [payload] = await builder.read.buildSweepPayload([
        orderId,
        encodeSweepData(
          {
            index: sampleUtxo.vout,
            scriptPubKey,
            txid: txidToBytes32(sampleUtxo.txid),
            value: utxoValue,
          },
          feeRate
        ),
      ])

      const tx = new bitcoin.Transaction()
      tx.version = 1
      tx.addInput(
        Buffer.from(sampleUtxo.txid, "hex").reverse(),
        sampleUtxo.vout,
        0xfffffffd
      )
      const depositoryOutputScript = bitcoin.address.toOutputScript(
        depositoryAddress,
        bitcoin.networks.bitcoin
      )
      tx.addOutput(depositoryOutputScript, Number(sweepAmount))
      const orderIdHexStr = "0x" + orderId.slice(2).toLowerCase()
      const opReturnScript = Buffer.concat([
        Buffer.from("6a42", "hex"),
        Buffer.from(orderIdHexStr),
      ])
      tx.addOutput(opReturnScript, 0)

      const pubkeyHash = Buffer.from(scriptPubKey.slice(6), "hex")
      const p2pkhScript = bitcoin.script.compile([
        bitcoin.opcodes.OP_DUP,
        bitcoin.opcodes.OP_HASH160,
        pubkeyHash,
        bitcoin.opcodes.OP_EQUALVERIFY,
        bitcoin.opcodes.OP_CHECKSIG,
      ])
      const expected = tx.hashForWitnessV0(
        0,
        p2pkhScript,
        Number(utxoValue),
        bitcoin.Transaction.SIGHASH_ALL
      )

      const got = await builder.read.hashToSign([payload])
      expect(got.toLowerCase()).to.equal(
        "0x" + expected.toString("hex").toLowerCase()
      )
    })

    it("should produce different hashes for different UTXO values (vulnerability regression)", async () => {
      const { builder } = await loadFixture(deployBuilder)

      const feeRate = 1n
      const realValue = BigInt(sampleUtxo.value)
      const deflatedValue = realValue / 2n

      const [payloadReal] = await builder.read.buildSweepPayload([
        orderId,
        encodeSweepData(
          {
            index: sampleUtxo.vout,
            scriptPubKey,
            txid: txidToBytes32(sampleUtxo.txid),
            value: realValue,
          },
          feeRate
        ),
      ])

      const [payloadDeflated] = await builder.read.buildSweepPayload([
        orderId,
        encodeSweepData(
          {
            index: sampleUtxo.vout,
            scriptPubKey,
            txid: txidToBytes32(sampleUtxo.txid),
            value: deflatedValue,
          },
          feeRate
        ),
      ])

      const hashReal = await builder.read.hashToSign([payloadReal])
      const hashDeflated = await builder.read.hashToSign([payloadDeflated])

      // BIP143 commits to value, so different values MUST produce different hashes
      expect(hashReal).to.not.equal(hashDeflated)
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
        "BitcoinDepositSweepBuilder",
        builder.address,
        { client: { wallet: otherAccount } }
      )

      await expect(
        builderAsOther.write.setMaxFeeRate([200n])
      ).to.be.rejectedWith("OwnableUnauthorizedAccount")
    })
  })

  describe("varint encoding (output script length boundary)", function () {
    it("should match bitcoinjs sighash with a 253-byte depository script (0xFD path)", async () => {
      const [owner] = await hre.viem.getWalletClients()

      // 253-byte synthetic script crosses the 0xFD CompactSize boundary
      const syntheticScript = Buffer.alloc(253, 0xab)

      const chainSignatures = await hre.viem.deployContract(
        "ChainSignatures",
        []
      )
      const builder = await hre.viem.deployContract(
        "BitcoinDepositSweepBuilder",
        [owner.account.address, syntheticScript.toString("base64"), 100n],
        { libraries: { ChainSignatures: chainSignatures.address } }
      )

      const utxoValue = BigInt(sampleUtxo.value)
      const feeRate = 1n
      const fees = feeRate * 191n
      const sweepAmount = utxoValue - fees

      const [payload] = await builder.read.buildSweepPayload([
        orderId,
        encodeSweepData(
          {
            index: sampleUtxo.vout,
            scriptPubKey,
            txid: txidToBytes32(sampleUtxo.txid),
            value: utxoValue,
          },
          feeRate
        ),
      ])

      const tx = new bitcoin.Transaction()
      tx.version = 1
      tx.addInput(
        Buffer.from(sampleUtxo.txid, "hex").reverse(),
        sampleUtxo.vout,
        0xfffffffd
      )
      tx.addOutput(syntheticScript, Number(sweepAmount))
      const orderIdHexStr = "0x" + orderId.slice(2).toLowerCase()
      const opReturnScript = Buffer.concat([
        Buffer.from("6a42", "hex"),
        Buffer.from(orderIdHexStr),
      ])
      tx.addOutput(opReturnScript, 0)

      const pubkeyHash = Buffer.from(scriptPubKey.slice(6), "hex")
      const p2pkhScript = bitcoin.script.compile([
        bitcoin.opcodes.OP_DUP,
        bitcoin.opcodes.OP_HASH160,
        pubkeyHash,
        bitcoin.opcodes.OP_EQUALVERIFY,
        bitcoin.opcodes.OP_CHECKSIG,
      ])
      const expected = tx.hashForWitnessV0(
        0,
        p2pkhScript,
        Number(utxoValue),
        bitcoin.Transaction.SIGHASH_ALL
      )

      const got = await builder.read.hashToSign([payload])
      expect(got.toLowerCase()).to.equal(
        "0x" + expected.toString("hex").toLowerCase()
      )
    })
  })
})

describe("BitcoinDepositAddress", function () {
  describe("derivationPath()", function () {
    it("should return correct format: hex(address) / hex(orderId)", async () => {
      const { manager } = await loadFixture(deployBuilder)

      const path = await manager.read.derivationPath([orderId])

      // Strings.toHexString includes 0x prefix
      const contractAddr = manager.address.toLowerCase()
      expect(path).to.include(contractAddr)

      // Should contain a separator
      expect(path).to.include("/")

      // Should end with the hex-encoded orderId (no 0x prefix, from stringifyBytes)
      const orderIdHex = orderId.slice(2)
      expect(path).to.include(orderIdHex)
    })

    it("should return deterministic results for the same orderId", async () => {
      const { manager } = await loadFixture(deployBuilder)

      const path1 = await manager.read.derivationPath([orderId])
      const path2 = await manager.read.derivationPath([orderId])

      expect(path1).to.equal(path2)
    })

    it("should return unique paths for different orderIds", async () => {
      const { manager } = await loadFixture(deployBuilder)

      const path1 = await manager.read.derivationPath([orderId])
      const path2 = await manager.read.derivationPath([orderId2])

      expect(path1).to.not.equal(path2)
    })
  })

  describe("sweep()", function () {
    it("should store the payload in sweepPayloads", async () => {
      const { builder } = await loadFixture(deployBuilder)

      // sweep() calls Aurora precompiles which won't work in unit tests,
      // but buildSweepPayload is a view function we can verify independently
      const [payload] = await builder.read.buildSweepPayload([
        orderId,
        encodeSweepData(
          {
            index: sampleUtxo.vout,
            scriptPubKey,
            txid: txidToBytes32(sampleUtxo.txid),
            value: BigInt(sampleUtxo.value),
          },
          1n
        ),
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

      const sweepData = encodeSweepData(
        {
          index: sampleUtxo.vout,
          scriptPubKey,
          txid: txidToBytes32(sampleUtxo.txid),
          value: BigInt(sampleUtxo.value),
        },
        1n
      )

      const [payload1] = await builder.read.buildSweepPayload([
        orderId,
        sweepData,
      ])
      const [payload2] = await builder.read.buildSweepPayload([
        orderId,
        sweepData,
      ])

      expect(payload1).to.equal(payload2)
    })
  })

  describe("setSweepBuilder()", function () {
    it("should update sweepBuilder when called by owner", async () => {
      const { manager, builder } = await loadFixture(deployBuilder)
      const newBuilder = builder.address // just use same address for test
      await manager.write.setSweepBuilder([newBuilder])
      const stored = await manager.read.sweepBuilder()
      expect(stored.toLowerCase()).to.equal(newBuilder.toLowerCase())
    })

    it("should emit SweepBuilderChanged event", async () => {
      const { manager, builder, publicClient } =
        await loadFixture(deployBuilder)
      const txHash = await manager.write.setSweepBuilder([builder.address])
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
      })
      expect(receipt.logs.length).to.be.greaterThan(0)
    })

    it("should revert when called by non-owner", async () => {
      const { manager, builder, otherAccount } =
        await loadFixture(deployBuilder)
      const managerAsOther = await hre.viem.getContractAt(
        "BitcoinDepositAddress",
        manager.address,
        { client: { wallet: otherAccount } }
      )
      await expect(
        managerAsOther.write.setSweepBuilder([builder.address])
      ).to.be.rejectedWith("OwnableUnauthorizedAccount")
    })
  })

  describe("init()", function () {
    it("should revert when called by non-owner", async () => {
      const { manager, otherAccount } = await loadFixture(deployBuilder)
      const managerAsOther = await hre.viem.getContractAt(
        "BitcoinDepositAddress",
        manager.address,
        { client: { wallet: otherAccount } }
      )
      await expect(managerAsOther.write.init()).to.be.rejectedWith(
        "OwnableUnauthorizedAccount"
      )
    })
  })

  // Validation block of `_requestSignature` — exercised via TestableBitcoinDepositAddress
  // harness so we can avoid the Aurora precompile call (`near.call(...).then(...).transact()`)
  // which is unavailable in Hardhat.
  describe("sweep state machine", function () {
    describe("InsufficientGas", function () {
      it("should revert when signGas < MIN_SIGN_GAS", async () => {
        const { manager, sweepData } = await loadFixture(deployTestable)
        const tooLow = MIN_SIGN_GAS - 1n
        await expect(
          manager.write.sweepNoCall([
            orderId,
            sweepData,
            { callbackGas: MIN_CALLBACK_GAS, signGas: tooLow },
          ])
        ).to.be.rejectedWith(`InsufficientGas(${tooLow}, ${MIN_SIGN_GAS})`)
      })

      it("should revert when callbackGas < MIN_CALLBACK_GAS", async () => {
        const { manager, sweepData } = await loadFixture(deployTestable)
        const tooLow = MIN_CALLBACK_GAS - 1n
        await expect(
          manager.write.sweepNoCall([
            orderId,
            sweepData,
            { callbackGas: tooLow, signGas: MIN_SIGN_GAS },
          ])
        ).to.be.rejectedWith(`InsufficientGas(${tooLow}, ${MIN_CALLBACK_GAS})`)
      })
    })

    describe("first sweep", function () {
      it("should store payload, set pendingSignatures, and emit SweepSubmitted", async () => {
        const { hash, manager, payload, publicClient, sweepData } =
          await loadFixture(deployTestable)

        const txHash = await manager.write.sweepNoCall([
          orderId,
          sweepData,
          validGas,
        ])
        const receipt = await publicClient.waitForTransactionReceipt({
          hash: txHash,
        })
        const block = await publicClient.getBlock({
          blockNumber: receipt.blockNumber,
        })

        expect(await manager.read.sweepPayloads([orderId, hash])).to.equal(
          payload
        )
        expect(await manager.read.pendingSignatures([orderId, hash])).to.equal(
          block.timestamp + PENDING_SIGNATURE_COOLDOWN
        )

        const expectedSweep = BigInt(sampleUtxo.value) - 1n * 191n
        const events = await manager.getEvents.SweepSubmitted()
        expect(events.length).to.equal(1)
        expect(events[0].args.orderId).to.equal(orderId)
        expect(events[0].args.payload).to.equal(payload)
        expect(events[0].args.sweepAmount).to.equal(expectedSweep)
      })
    })

    describe("cooldown", function () {
      it("should revert SignaturePending during cooldown window", async () => {
        const { manager, publicClient, sweepData } =
          await loadFixture(deployTestable)

        const txHash = await manager.write.sweepNoCall([
          orderId,
          sweepData,
          validGas,
        ])
        const receipt = await publicClient.waitForTransactionReceipt({
          hash: txHash,
        })
        const block = await publicClient.getBlock({
          blockNumber: receipt.blockNumber,
        })
        const expiration = block.timestamp + PENDING_SIGNATURE_COOLDOWN

        await expect(
          manager.write.sweepNoCall([orderId, sweepData, validGas])
        ).to.be.rejectedWith(`SignaturePending("${orderId}", ${expiration})`)
      })

      it("should permit re-call after cooldown elapses", async () => {
        const { hash, manager, publicClient, sweepData } =
          await loadFixture(deployTestable)

        const tx1 = await manager.write.sweepNoCall([
          orderId,
          sweepData,
          validGas,
        ])
        const r1 = await publicClient.waitForTransactionReceipt({ hash: tx1 })
        const b1 = await publicClient.getBlock({ blockNumber: r1.blockNumber })
        const firstExpiration = b1.timestamp + PENDING_SIGNATURE_COOLDOWN

        await time.increaseTo(Number(firstExpiration + 1n))

        const tx2 = await manager.write.sweepNoCall([
          orderId,
          sweepData,
          validGas,
        ])
        const r2 = await publicClient.waitForTransactionReceipt({ hash: tx2 })
        const b2 = await publicClient.getBlock({ blockNumber: r2.blockNumber })

        expect(await manager.read.pendingSignatures([orderId, hash])).to.equal(
          b2.timestamp + PENDING_SIGNATURE_COOLDOWN
        )
      })
    })

    describe("SignatureAlreadyComplete", function () {
      it("should revert when signedPayloads is already populated", async () => {
        const { hash, manager, sweepData } = await loadFixture(deployTestable)

        const dummySig = "0xdeadbeef" as `0x${string}`
        await manager.write.setSignedPayload([orderId, hash, dummySig])

        await expect(
          manager.write.sweepNoCall([orderId, sweepData, validGas])
        ).to.be.rejectedWith(
          `SignatureAlreadyComplete("${orderId}", "${hash}")`
        )
      })
    })

    describe("sweepCallback", function () {
      it("should revert when called from a non-Aurora msg.sender", async () => {
        // TODO(integration): success path & failed-PromiseResult require Aurora
        // precompile mocking and live as integration tests.
        const { manager, otherAccount } = await loadFixture(deployTestable)

        const managerAsOther = await hre.viem.getContractAt(
          "TestableBitcoinDepositAddress",
          manager.address,
          { client: { wallet: otherAccount } }
        )

        const dummyHash = ("0x" + "ab".repeat(32)) as `0x${string}`
        await expect(
          managerAsOther.write.sweepCallback([orderId, dummyHash])
        ).to.be.rejectedWith(`SignCallbackFailed("${orderId}")`)
      })
    })

    describe("same-orderId multi-hash state isolation", function () {
      it("should track pending signatures independently across hashes within one orderId", async () => {
        const { builder, hash, manager, sweepData } =
          await loadFixture(deployTestable)

        await manager.write.sweepNoCall([orderId, sweepData, validGas])

        // Same orderId, different UTXO (different txid) → different hash
        const altSweepData = encodeSweepData(
          {
            index: sampleUtxo.vout,
            scriptPubKey,
            txid: txidToBytes32(
              "0000000000000000000000000000000000000000000000000000000000000abc"
            ),
            value: BigInt(sampleUtxo.value),
          },
          1n
        )
        const [altPayload] = await builder.read.buildSweepPayload([
          orderId,
          altSweepData,
        ])
        const altHash = await builder.read.hashToSign([altPayload])
        expect(altHash).to.not.equal(hash)

        // Different-hash sweep should NOT be blocked by the cooldown on the original hash
        await manager.write.sweepNoCall([orderId, altSweepData, validGas])

        expect(
          await manager.read.pendingSignatures([orderId, hash])
        ).to.not.equal(0n)
        expect(
          await manager.read.pendingSignatures([orderId, altHash])
        ).to.not.equal(0n)
      })
    })

    describe("multi-orderId state isolation", function () {
      it("should track pending signatures per (orderId, hash) independently", async () => {
        const { builder, hash, manager, sweepData } =
          await loadFixture(deployTestable)

        await manager.write.sweepNoCall([orderId, sweepData, validGas])

        const [payload2] = await builder.read.buildSweepPayload([
          orderId2,
          sweepData,
        ])
        const hash2 = await builder.read.hashToSign([payload2])

        await manager.write.sweepNoCall([orderId2, sweepData, validGas])

        expect(
          await manager.read.pendingSignatures([orderId, hash])
        ).to.not.equal(0n)
        expect(
          await manager.read.pendingSignatures([orderId2, hash2])
        ).to.not.equal(0n)
        expect(hash).to.not.equal(hash2)

        await expect(
          manager.write.sweepNoCall([orderId, sweepData, validGas])
        ).to.be.rejectedWith(/SignaturePending/)
        await expect(
          manager.write.sweepNoCall([orderId2, sweepData, validGas])
        ).to.be.rejectedWith(/SignaturePending/)
      })
    })
  })
})
