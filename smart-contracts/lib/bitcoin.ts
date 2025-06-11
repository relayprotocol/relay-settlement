import { createHash } from 'crypto'
import bs58check from 'bs58check'

import { secp256k1 } from '@noble/curves/secp256k1'

import * as bitcoin from 'bitcoinjs-lib'

export function txidToBytes32(txid: string): `0x${string}` {
  return `0x${Buffer.from(txid, 'hex').reverse().toString('hex')}`
}

export const BITCOIN_TRANSACTION_PARAMS_ABI = {
  components: [
    {
      components: [
        { name: 'txid', type: 'bytes32' },
        { name: 'index', type: 'uint32' },
        { name: 'value', type: 'uint64' },
        { name: 'scriptPubKey', type: 'bytes' },
      ],
      name: 'utxos',
      type: 'tuple[]',
    },
    { name: 'feeRate', type: 'uint256' },
  ],
  type: 'tuple',
}

export const BITCOIN_TRANSACTION_ABI = [
  {
    components: [
      {
        components: [
          { name: 'txid', type: 'bytes' },
          { name: 'index', type: 'bytes' },
          { name: 'script', type: 'bytes' },
          { name: 'value', type: 'bytes' },
        ],
        name: 'inputs',
        type: 'tuple[]',
      },
      {
        components: [
          { name: 'value', type: 'bytes' },
          { name: 'script', type: 'bytes' },
        ],
        name: 'outputs',
        type: 'tuple[]',
      },
    ],
    type: 'tuple',
  },
]

export async function fetchRawTx(txid: string): Promise<Buffer> {
  const res = await fetch(`https://mempool.space/testnet/api/tx/${txid}/hex`)
  const rawHex = await res.text()
  return Buffer.from(rawHex, 'hex')
}

export async function fetchUtxo(allocatorAddress: string) {
  const utxoRes = await fetch(
    `https://mempool.space/testnet/api/address/${allocatorAddress}/utxo`
  )
  if (!utxoRes.ok) {
    throw new Error(`Failed to fetch UTXO: ${utxoRes.statusText}`)
  }
  const utxos = await utxoRes.json()
  return Promise.all(
    utxos.map(async (u) => {
      const raw = await fetchRawTx(u.txid)

      // Parse the transaction to get the scriptPubKey
      const tx = bitcoin.Transaction.fromBuffer(raw)
      const output = tx.outs[u.vout]
      const scriptPubKey = output.script.toString('hex')

      return {
        nonWitnessUtxo: raw,
        scriptPubKey,
        txid: u.txid,
        value: u.value,
        vout: u.vout, // Now we have the scriptPubKey!
      }
    })
  )
}

export async function broadcastTx(txHex: string): Promise<string> {
  const res = await fetch('https://mempool.space/testnet/api/tx', {
    body: txHex,
    headers: { 'Content-Type': 'text/plain' },
    method: 'POST',
  })

  if (!res.ok) {
    const error = await res.text()
    throw new Error(`Failed to broadcast: ${error}`)
  }

  return await res.text() // Returns txid
}

/**
 * Fetch UTXOs from Blockstream’s public API and sum their values.
 * @param {string} address - A bech32 or P2PKH address (e.g. "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh")
 * @returns {Promise<{ satoshis: number, btc: number }>}
 */
export async function getBalance(address: string) {
  // Blockstream’s “list unspent outputs” endpoint:
  const apiURL = `https://mempool.space/testnet/api/address/${address}/utxo`
  try {
    const resp = await fetch(apiURL)
    const utxos = await resp.json()
    // Each UTXO has fields: { txid, vout, value, status: { confirmed, block_height, block_hash, block_time } }
    // value is in satoshis.
    let totalSats = 0
    for (const utxo of utxos) {
      totalSats += utxo.value
    }
    return {
      btc: totalSats / 1e8,
      satoshis: totalSats,
    }
  } catch (err) {
    console.error('Error fetching UTXOs:', err.response?.data || err.message)
    throw err
  }
}

export async function estimateFeeRate(): Promise<number> {
  try {
    const res = await fetch(
      'https://mempool.space/testnet/api/v1/fees/recommended'
    )
    const fees = await res.json()
    return fees.fastestFee || 2 // sats/vbyte
  } catch {
    return 2 // fallback fee rate
  }
}

export function decodeUint64LE(leHex: string): bigint {
  // 1) Strip “0x” if present
  const hex = leHex.startsWith('0x') ? leHex.slice(2) : leHex
  if (hex.length !== 16) {
    throw new Error(`Expected 8 bytes (16 hex chars), got ${hex.length} chars`)
  }

  // 2) Create a Buffer from the hex, then read as little-endian BigUInt64
  const buf = Buffer.from(hex, 'hex')
  return buf.readBigUInt64LE(0)
}

export function buildBitcoinTransactionFromPayload(transaction) {
  // Build transaction manually without PSBT
  const tx = new bitcoin.Transaction()
  tx.version = 1
  tx.locktime = 0

  // Add inputs (txid is already in little-endian in transaction.inputs)
  transaction.inputs.forEach((input) => {
    const txidBytes = Buffer.from(input.txid.slice(2), 'hex')
    const indexBytes = Buffer.from(input.index.slice(2), 'hex')
    const vout = indexBytes.readUInt32LE(0)

    // Add input with the already-reversed txid
    tx.addInput(txidBytes, vout, 0xffffffff)
  })

  // Add outputs
  transaction.outputs.forEach((output) => {
    const valueBytes = Buffer.from(output.value.slice(2), 'hex')
    const value = Number(valueBytes.readBigUInt64LE(0))
    const script = Buffer.from(output.script.slice(2), 'hex')

    tx.addOutput(script, value)
  })

  // Calculate total input and output values
  const totalInput = transaction.inputs.reduce((sum, input, i) => {
    const valueBytes = Buffer.from(input.value.slice(2), 'hex')
    const value = valueBytes.readBigUInt64LE(0)
    return sum + value
  }, 0n)

  const totalOutput = transaction.outputs.reduce((sum, output) => {
    const valueBytes = Buffer.from(output.value.slice(2), 'hex')
    const value = valueBytes.readBigUInt64LE(0)
    return sum + value
  }, 0n)

  const totalFees = totalInput - totalOutput
  console.log('\n📦 Transaction Summary:')
  console.log(`   Total Input: ${totalInput} sats`)
  console.log(`   Total Output: ${totalOutput} sats`)
  console.log(`   Total Fees: ${totalFees} sats`)

  return tx
}

export async function addSignedInputsToTransaction(tx, hashes, signedHashes) {
  for (let i = 0; i < hashes.length; i++) {
    // 1) Reassemble the 64-byte compact signature (= r‖s):
    const { r, s, v } = signedHashes[i]

    // Convert hex strings to Uint8Arrays
    const rBytes = new Uint8Array(
      r.match(/.{1,2}/g).map((byte) => parseInt(byte, 16))
    )
    const sBytes = new Uint8Array(
      s.match(/.{1,2}/g).map((byte) => parseInt(byte, 16))
    )

    // Reassemble the compact signature (r‖s)
    const compact = new Uint8Array(64)
    compact.set(rBytes, 0)
    compact.set(sBytes, 32)

    // 2) Create a Signature object (this automatically enforces "low-S"):
    const sigObj = secp256k1.Signature.fromCompact(compact)

    // 3) Pull out canonical DER bytes:
    const derBytes = sigObj.toDERRawBytes() // Uint8Array

    // 4) Append the SIGHASH-ALL byte (0x01):
    const derPlusHashType = new Uint8Array(derBytes.length + 1)
    derPlusHashType.set(derBytes, 0)
    derPlusHashType[derBytes.length] = bitcoin.Transaction.SIGHASH_ALL // = 0x01

    // 5) Recover the compressed pubKey (33 bytes) from (hash, compact, v):
    // Convert hash from hex string to Uint8Array
    let hashBytes
    if (typeof hashes[i] === 'string') {
      // Remove '0x' prefix if present
      const hexHash = hashes[i].startsWith('0x')
        ? hashes[i].slice(2)
        : hashes[i]
      // Convert hex string to Uint8Array
      hashBytes = new Uint8Array(
        hexHash.match(/.{1,2}/g).map((byte) => parseInt(byte, 16))
      )
    } else {
      // If it's already a Uint8Array or Buffer, use as is
      hashBytes = new Uint8Array(hashes[i])
    }

    // Normalize recovery parameter
    let recoveryParam = v
    if (v >= 27) {
      recoveryParam = v - 27
    }
    if (recoveryParam >= 2) {
      recoveryParam = recoveryParam % 2
    }

    // Create signature object with recovery parameter
    const signature = sigObj.addRecoveryBit(recoveryParam)

    // Recover the public key from the message hash and signature
    const recoveredPubKey = signature.recoverPublicKey(hashBytes)

    // Get the compressed public key bytes (33 bytes)
    const publicKeyCompressed = recoveredPubKey.toRawBytes(true) // true = compressed

    // 6) Build the P2PKH scriptSig: push <DER∥0x01> then <pubKeyCompressed>.
    tx.ins[i].script = bitcoin.script.compile([
      Buffer.from(derPlusHashType), // DER‐encoded (r,s) ∥ SIGHASH_ALL
      Buffer.from(publicKeyCompressed), // recovered public key
    ])
  }

  console.log('\n📝 Allocator transaction signed successfully!')
}

export async function broadcastTransaction(tx) {
  // Build the final transaction hex
  const txHex = tx.toHex()
  console.log(`\n📄 Transaction Hex: ${txHex}`)
  console.log(`   Transaction ID: ${tx.getId()}`)
  console.log(`   Transaction Size: ${tx.virtualSize()} vbytes`)

  // Optionally verify the transaction is valid
  try {
    bitcoin.Transaction.fromHex(txHex)
    console.log('\n✅ Transaction is valid!')
  } catch (e) {
    console.error('\n❌ Transaction validation failed:', e)
    process.exit(1)
  }

  // Broadcast the transaction
  console.log('\n📡 Broadcasting transaction...')
  const txid = await broadcastTx(txHex)
  console.log('\n🎉 Transaction broadcast successfully!')
  console.log(`   Transaction ID: ${txid}`)
  console.log(`   View on explorer: https://mempool.space/testnet/tx/${txid}`)
  return txid
}

export function bitcoinAddressfromHexPublicKey(hexPublicKey: string): string {
  const raw = Buffer.from(hexPublicKey.slice(2), 'hex')
  const x = raw.slice(1, 33)
  const y = raw.slice(33, 65)
  const prefix = y[y.length - 1] % 2 === 0 ? 0x02 : 0x03

  const pubkeyCompressed = Buffer.concat([Buffer.from([prefix]), x]) // <Buffer 02… or 03…>

  // 5. Build a P2PKH address from that compressed key:
  const sha256 = createHash('sha256').update(pubkeyCompressed).digest()
  const ripe160 = createHash('ripemd160').update(sha256).digest()
  const versioned = Buffer.concat([Buffer.from([0x6f]), ripe160]) // 0x6f = testnet, 0x00 = mainnet
  return bs58check.encode(versioned)
}
