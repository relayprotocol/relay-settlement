import { createHash } from "crypto"
import bs58check from "bs58check"
import { secp256k1 } from "@noble/curves/secp256k1"
import * as bitcoin from "bitcoinjs-lib"

export function txidToBytes32(txid: string): `0x${string}` {
  return `0x${Buffer.from(txid, "hex").reverse().toString("hex")}`
}

export const BITCOIN_TRANSACTION_PARAMS_ABI = {
  components: [
    {
      components: [
        { name: "txid", type: "bytes32" },
        { name: "index", type: "uint32" },
        { name: "value", type: "uint64" },
        { name: "scriptPubKey", type: "bytes" },
      ],
      name: "utxos",
      type: "tuple[]",
    },
    { name: "feeRate", type: "uint256" },
  ],
  type: "tuple",
}

export const BITCOIN_TRANSACTION_ABI = [
  {
    components: [
      {
        components: [
          { name: "txid", type: "bytes" },
          { name: "index", type: "bytes" },
          { name: "script", type: "bytes" },
          { name: "value", type: "bytes" },
        ],
        name: "inputs",
        type: "tuple[]",
      },
      {
        components: [
          { name: "value", type: "bytes" },
          { name: "script", type: "bytes" },
        ],
        name: "outputs",
        type: "tuple[]",
      },
    ],
    type: "tuple",
  },
]

async function fetchRawTx(txid: string): Promise<Buffer> {
  const res = await fetch(`https://mempool.space/testnet/api/tx/${txid}/hex`)
  const rawHex = await res.text()
  return Buffer.from(rawHex, "hex")
}

export async function fetchUtxo(allocatorAddress: string) {
  const utxoRes = await fetch(
    `https://mempool.space/testnet/api/address/${allocatorAddress}/utxo`
  )
  if (!utxoRes.ok) {
    throw new Error(`Failed to fetch UTXO: ${utxoRes.statusText}`)
  }
  const utxos = (await utxoRes.json()) as Array<{
    txid: string
    vout: number
    value: number
  }>
  const fullUtxos = await Promise.all(
    utxos.map(async (u) => {
      const raw = await fetchRawTx(u.txid)

      const tx = bitcoin.Transaction.fromBuffer(raw)
      const output = tx.outs[u.vout]
      const scriptPubKey = output.script.toString("hex")

      return {
        nonWitnessUtxo: raw,
        scriptPubKey,
        txid: u.txid,
        value: u.value,
        vout: u.vout,
      }
    })
  )
  return fullUtxos.sort((a, b) => a.value - b.value)
}

async function broadcastTx(txHex: string): Promise<string> {
  const res = await fetch("https://mempool.space/testnet/api/tx", {
    body: txHex,
    headers: { "Content-Type": "text/plain" },
    method: "POST",
  })

  if (!res.ok) {
    const error = await res.text()
    throw new Error(`Failed to broadcast: ${error}`)
  }

  return await res.text()
}

export async function getBalance(address: string) {
  const apiURL = `https://mempool.space/testnet/api/address/${address}/utxo`
  try {
    const resp = await fetch(apiURL)
    const utxos = (await resp.json()) as Array<{ value: number }>
    let totalSats = 0
    for (const utxo of utxos) {
      totalSats += utxo.value
    }
    return {
      btc: totalSats / 1e8,
      satoshis: totalSats,
    }
  } catch (err: any) {
    console.error("Error fetching UTXOs:", err.response?.data || err.message)
    throw err
  }
}

export async function estimateFeeRate(): Promise<number> {
  try {
    const res = await fetch(
      "https://mempool.space/testnet/api/v1/fees/recommended"
    )
    const fees = (await res.json()) as { fastestFee?: number }
    return fees.fastestFee || 2
  } catch {
    return 2
  }
}

export function decodeUint64LE(leHex: string): bigint {
  const hex = leHex.startsWith("0x") ? leHex.slice(2) : leHex
  if (hex.length !== 16) {
    throw new Error(`Expected 8 bytes (16 hex chars), got ${hex.length} chars`)
  }

  const buf = Buffer.from(hex, "hex")
  return buf.readBigUInt64LE(0)
}

export function buildBitcoinTransactionFromPayload(transaction: any) {
  const tx = new bitcoin.Transaction()
  tx.version = 1
  tx.locktime = 0

  transaction.inputs.forEach((input: any) => {
    const txidBytes = Buffer.from(input.txid.slice(2), "hex")
    const indexBytes = Buffer.from(input.index.slice(2), "hex")
    const vout = indexBytes.readUInt32LE(0)

    tx.addInput(txidBytes, vout, 0xffffffff)
  })

  transaction.outputs.forEach((output: any) => {
    const valueBytes = Buffer.from(output.value.slice(2), "hex")
    const value = Number(valueBytes.readBigUInt64LE(0))
    const script = Buffer.from(output.script.slice(2), "hex")

    tx.addOutput(script, value)
  })

  return tx
}

export async function verifySighashMatches(
  tx: any,
  transaction: any,
  hashes: any
) {
  for (let i = 0; i < transaction.inputs.length; i++) {
    const scriptPubKey = Buffer.from(
      transaction.inputs[i].script.slice(2),
      "hex"
    )
    const bitcoinjsSighash = tx.hashForSignature(
      i,
      scriptPubKey,
      bitcoin.Transaction.SIGHASH_ALL
    )
    const ourHash = Buffer.from(hashes[i].slice(2), "hex")

    if (!bitcoinjsSighash.equals(ourHash)) {
      throw new Error(
        `SIGHASH mismatch for input ${i}: expected ${bitcoinjsSighash.toString("hex")}, got ${ourHash.toString("hex")}`
      )
    }
  }
}

export async function addSignedInputsToTransaction(
  tx: any,
  hashes: any,
  signedHashes: any,
  transaction: any = null
) {
  for (let i = 0; i < hashes.length; i++) {
    const { r, s, v } = signedHashes[i]

    const rBytes = new Uint8Array(
      r.match(/.{1,2}/g).map((byte: string) => parseInt(byte, 16))
    )
    const sBytes = new Uint8Array(
      s.match(/.{1,2}/g).map((byte: string) => parseInt(byte, 16))
    )
    const compact = new Uint8Array(64)
    compact.set(rBytes, 0)
    compact.set(sBytes, 32)

    const sigObj = secp256k1.Signature.fromCompact(compact)
    const derBytes = sigObj.toDERRawBytes()
    const derPlusHashType = new Uint8Array(derBytes.length + 1)
    derPlusHashType.set(derBytes, 0)
    derPlusHashType[derBytes.length] = bitcoin.Transaction.SIGHASH_ALL

    const hashBytes =
      typeof hashes[i] === "string"
        ? new Uint8Array(
            (hashes[i].startsWith("0x") ? hashes[i].slice(2) : hashes[i])
              .match(/.{1,2}/g)
              .map((byte: string) => parseInt(byte, 16))
          )
        : new Uint8Array(hashes[i])

    let expectedAddress: string | null = null
    if (transaction?.inputs?.[i]) {
      expectedAddress = bitcoin.address.fromOutputScript(
        Buffer.from(transaction.inputs[i].script.slice(2), "hex"),
        bitcoin.networks.testnet
      )
    }

    let recoveredPubKey: any = null
    for (
      let testRecoveryParam = 0;
      testRecoveryParam < 4;
      testRecoveryParam++
    ) {
      const signature = sigObj.addRecoveryBit(testRecoveryParam)
      const testPubKey = signature.recoverPublicKey(hashBytes)
      const isValid = secp256k1.verify(
        sigObj,
        hashBytes,
        testPubKey.toRawBytes(true)
      )

      if (isValid) {
        if (expectedAddress) {
          const recoveredAddress = bitcoin.payments.p2pkh({
            network: bitcoin.networks.testnet,
            pubkey: Buffer.from(testPubKey.toRawBytes(true)),
          }).address

          if (recoveredAddress === expectedAddress) {
            recoveredPubKey = testPubKey
            break
          }
        } else if (!recoveredPubKey) {
          recoveredPubKey = testPubKey
        }
      }
    }

    if (!recoveredPubKey) {
      let recoveryParam = v >= 27 ? v - 27 : v
      if (recoveryParam >= 2) recoveryParam = recoveryParam % 2

      const signature = sigObj.addRecoveryBit(recoveryParam)
      recoveredPubKey = signature.recoverPublicKey(hashBytes)
    }

    const publicKeyCompressed = recoveredPubKey.toRawBytes(true)
    tx.ins[i].script = bitcoin.script.compile([
      Buffer.from(derPlusHashType),
      Buffer.from(publicKeyCompressed),
    ])
  }
}

export async function broadcastTransaction(tx: any) {
  const txHex = tx.toHex()

  try {
    bitcoin.Transaction.fromHex(txHex)
  } catch (e: any) {
    throw new Error(`Invalid transaction: ${e.message}`)
  }

  try {
    const txid = await broadcastTx(txHex)
    console.log(`🎉 Transaction broadcast: ${txid}`)
    console.log(`   Explorer: https://mempool.space/testnet/tx/${txid}`)
    return txid
  } catch (error: any) {
    if (error.message.includes("mandatory-script-verify-flag-failed")) {
      throw new Error(
        "Script verification failed - signature/public key mismatch"
      )
    }
    throw error
  }
}

export function bitcoinAddressfromHexPublicKey(hexPublicKey: string): string {
  const raw = Buffer.from(hexPublicKey.slice(2), "hex")
  const x = raw.slice(1, 33)
  const y = raw.slice(33, 65)
  const prefix = y[y.length - 1] % 2 === 0 ? 0x02 : 0x03

  const pubkeyCompressed = Buffer.concat([Buffer.from([prefix]), x])

  const sha256 = createHash("sha256").update(pubkeyCompressed).digest()
  const ripe160 = createHash("ripemd160").update(sha256).digest()
  const versioned = Buffer.concat([Buffer.from([0x6f]), ripe160])
  return bs58check.encode(versioned)
}
