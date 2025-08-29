/* eslint-disable sort-keys-fix/sort-keys-fix */

import { sha256 } from 'js-sha256'
import { bcs } from '@mysten/sui/bcs'

// Define BCS struct for Sui TransferRequest matching the Sui contract
const TransferRequestStruct = bcs.struct('TransferRequest', {
  recipient: bcs.Address,
  amount: bcs.u64(),
  coin_type: bcs.struct('TypeName', {
    name: bcs.string(),
  }),
  nonce: bcs.u64(),
  expiration: bcs.u64(),
})

// Create a hash of the BCS encoded request
export function hashRequest(request) {
  // Prepare the request object for BCS serialization
  const requestObj = {
    recipient: request.recipient,
    amount: BigInt(request.amount),
    coin_type: request.coin_type,
    nonce: BigInt(request.nonce),
    expiration: BigInt(request.expiration),
  }

  // Serialize the request using BCS
  const serialized = TransferRequestStruct.serialize(requestObj).toBytes()

  // Hash the serialized data with SHA-256
  const hash = sha256.create()
  hash.update(serialized)

  return {
    bytes: '0x' + Buffer.from(serialized).toString('hex'),
    hash: '0x' + hash.hex(),
  }
}

// Decode a BCS encoded payload
export function decodeDepositoryRequest(payload) {
  try {
    // Remove 0x prefix if present
    const hex = payload.startsWith('0x') ? payload.substring(2) : payload
    const bytes = Buffer.from(hex, 'hex')

    // Deserialize using BCS
    const deserialized = TransferRequestStruct.parse(new Uint8Array(bytes))

    return {
      amount: deserialized.amount,
      coin_type: {
        name: deserialized.coin_type.name,
      },
      expiration: deserialized.expiration,
      nonce: deserialized.nonce,
      recipient: deserialized.recipient,
    }
  } catch (error) {
    console.error('Error decoding request:', error)
    throw error
  }
}

// Helper for normalizing Sui type format (mirrors the Sui test function)
export function normalizeType(type) {
  const parts = type.split('::')
  if (parts.length < 2) {
    throw new Error('Invalid type format')
  }

  let address = parts[0].toLowerCase().replace('0x', '')
  if (address.length < 64) {
    address = address.padStart(64, '0')
  } else if (address.length > 64) {
    throw new Error('Invalid address length')
  }

  parts[0] = address
  return parts.join('::')
}
