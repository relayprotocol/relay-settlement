import { BorshCoder } from '@coral-xyz/anchor'
import bs58 from 'bs58'
import { sha256 } from 'js-sha256'

export type RelayEscrow = {
  version: '0.1.0'
  name: 'relay_escrow'
  instructions: [
    {
      name: 'initialize'
      accounts: [
        {
          name: 'relayEscrow'
          isMut: true
          isSigner: false
        },
        {
          name: 'vault'
          isMut: true
          isSigner: false
        },
        {
          name: 'owner'
          isMut: true
          isSigner: true
        },
        {
          name: 'allocator'
          isMut: false
          isSigner: false
        },
        {
          name: 'systemProgram'
          isMut: false
          isSigner: false
        },
      ]
      args: []
    },
    {
      name: 'setAllocator'
      accounts: [
        {
          name: 'relayEscrow'
          isMut: true
          isSigner: false
        },
        {
          name: 'owner'
          isMut: false
          isSigner: true
        },
      ]
      args: [
        {
          name: 'newAllocator'
          type: 'publicKey'
        },
      ]
    },
    {
      name: 'depositNative'
      accounts: [
        {
          name: 'relayEscrow'
          isMut: false
          isSigner: false
        },
        {
          name: 'sender'
          isMut: true
          isSigner: true
        },
        {
          name: 'depositor'
          isMut: false
          isSigner: false
        },
        {
          name: 'vault'
          isMut: true
          isSigner: false
        },
        {
          name: 'systemProgram'
          isMut: false
          isSigner: false
        },
      ]
      args: [
        {
          name: 'amount'
          type: 'u64'
        },
        {
          name: 'id'
          type: {
            array: ['u8', 32]
          }
        },
      ]
    },
    {
      name: 'depositToken'
      accounts: [
        {
          name: 'relayEscrow'
          isMut: false
          isSigner: false
        },
        {
          name: 'mint'
          isMut: false
          isSigner: false
        },
        {
          name: 'sender'
          isMut: true
          isSigner: true
        },
        {
          name: 'senderTokenAccount'
          isMut: true
          isSigner: false
        },
        {
          name: 'depositor'
          isMut: false
          isSigner: false
        },
        {
          name: 'vaultTokenAccount'
          isMut: true
          isSigner: false
        },
        {
          name: 'vault'
          isMut: false
          isSigner: false
        },
        {
          name: 'tokenProgram'
          isMut: false
          isSigner: false
        },
        {
          name: 'associatedTokenProgram'
          isMut: false
          isSigner: false
        },
        {
          name: 'systemProgram'
          isMut: false
          isSigner: false
        },
      ]
      args: [
        {
          name: 'amount'
          type: 'u64'
        },
        {
          name: 'id'
          type: {
            array: ['u8', 32]
          }
        },
      ]
    },
    {
      name: 'executeTransfer'
      accounts: [
        {
          name: 'relayEscrow'
          isMut: false
          isSigner: false
        },
        {
          name: 'executor'
          isMut: true
          isSigner: true
        },
        {
          name: 'recipient'
          isMut: true
          isSigner: false
        },
        {
          name: 'vault'
          isMut: true
          isSigner: false
        },
        {
          name: 'mint'
          isMut: false
          isSigner: false
          isOptional: true
        },
        {
          name: 'vaultTokenAccount'
          isMut: true
          isSigner: false
          isOptional: true
        },
        {
          name: 'recipientTokenAccount'
          isMut: true
          isSigner: false
          isOptional: true
        },
        {
          name: 'usedRequest'
          isMut: true
          isSigner: false
        },
        {
          name: 'tokenProgram'
          isMut: false
          isSigner: false
        },
        {
          name: 'associatedTokenProgram'
          isMut: false
          isSigner: false
        },
        {
          name: 'systemProgram'
          isMut: false
          isSigner: false
        },
        {
          name: 'ixSysvar'
          isMut: false
          isSigner: false
        },
      ]
      args: [
        {
          name: 'request'
          type: {
            defined: 'TransferRequest'
          }
        },
      ]
    },
  ]
  accounts: [
    {
      name: 'relayEscrow'
      type: {
        kind: 'struct'
        fields: [
          {
            name: 'owner'
            type: 'publicKey'
          },
          {
            name: 'allocator'
            type: 'publicKey'
          },
          {
            name: 'vaultBump'
            type: 'u8'
          },
        ]
      }
    },
    {
      name: 'usedRequest'
      type: {
        kind: 'struct'
        fields: [
          {
            name: 'isUsed'
            type: 'bool'
          },
        ]
      }
    },
  ]
  types: [
    {
      name: 'TransferRequest'
      type: {
        kind: 'struct'
        fields: [
          {
            name: 'recipient'
            type: 'publicKey'
          },
          {
            name: 'token'
            type: {
              option: 'publicKey'
            }
          },
          {
            name: 'amount'
            type: 'u64'
          },
          {
            name: 'nonce'
            type: 'u64'
          },
          {
            name: 'expiration'
            type: 'i64'
          },
        ]
      }
    },
  ]
  events: [
    {
      name: 'TransferExecutedEvent'
      fields: [
        {
          name: 'request'
          type: {
            defined: 'TransferRequest'
          }
          index: false
        },
        {
          name: 'executor'
          type: 'publicKey'
          index: false
        },
        {
          name: 'id'
          type: 'publicKey'
          index: false
        },
      ]
    },
    {
      name: 'DepositEvent'
      fields: [
        {
          name: 'depositor'
          type: 'publicKey'
          index: false
        },
        {
          name: 'token'
          type: {
            option: 'publicKey'
          }
          index: false
        },
        {
          name: 'amount'
          type: 'u64'
          index: false
        },
        {
          name: 'id'
          type: {
            array: ['u8', 32]
          }
          index: false
        },
      ]
    },
  ]
  errors: [
    {
      code: 6000
      name: 'TransferRequestAlreadyUsed'
      msg: 'Transfer request has already been executed'
    },
    {
      code: 6001
      name: 'InvalidMint'
      msg: 'Invalid mint'
    },
    {
      code: 6002
      name: 'Unauthorized'
      msg: 'Unauthorized'
    },
    {
      code: 6003
      name: 'AllocatorSignerMismatch'
      msg: 'Allocator signer mismatch'
    },
    {
      code: 6004
      name: 'MessageMismatch'
      msg: 'Message mismatch'
    },
    {
      code: 6005
      name: 'MalformedEd25519Data'
      msg: 'Malformed Ed25519 data'
    },
    {
      code: 6006
      name: 'MissingSignature'
      msg: 'Missing signature'
    },
    {
      code: 6007
      name: 'SignatureExpired'
      msg: 'Signature expired'
    },
  ]
}

export const IDL: RelayEscrow = {
  accounts: [
    {
      name: 'relayEscrow',
      type: {
        fields: [
          {
            name: 'owner',
            type: 'publicKey',
          },
          {
            name: 'allocator',
            type: 'publicKey',
          },
          {
            name: 'vaultBump',
            type: 'u8',
          },
        ],
        kind: 'struct',
      },
    },
    {
      name: 'usedRequest',
      type: {
        fields: [
          {
            name: 'isUsed',
            type: 'bool',
          },
        ],
        kind: 'struct',
      },
    },
  ],
  errors: [
    {
      code: 6000,
      msg: 'Transfer request has already been executed',
      name: 'TransferRequestAlreadyUsed',
    },
    {
      code: 6001,
      msg: 'Invalid mint',
      name: 'InvalidMint',
    },
    {
      code: 6002,
      msg: 'Unauthorized',
      name: 'Unauthorized',
    },
    {
      code: 6003,
      msg: 'Allocator signer mismatch',
      name: 'AllocatorSignerMismatch',
    },
    {
      code: 6004,
      msg: 'Message mismatch',
      name: 'MessageMismatch',
    },
    {
      code: 6005,
      msg: 'Malformed Ed25519 data',
      name: 'MalformedEd25519Data',
    },
    {
      code: 6006,
      msg: 'Missing signature',
      name: 'MissingSignature',
    },
    {
      code: 6007,
      msg: 'Signature expired',
      name: 'SignatureExpired',
    },
  ],
  events: [
    {
      fields: [
        {
          index: false,
          name: 'request',
          type: {
            defined: 'TransferRequest',
          },
        },
        {
          index: false,
          name: 'executor',
          type: 'publicKey',
        },
        {
          index: false,
          name: 'id',
          type: 'publicKey',
        },
      ],
      name: 'TransferExecutedEvent',
    },
    {
      fields: [
        {
          index: false,
          name: 'depositor',
          type: 'publicKey',
        },
        {
          index: false,
          name: 'token',
          type: {
            option: 'publicKey',
          },
        },
        {
          index: false,
          name: 'amount',
          type: 'u64',
        },
        {
          index: false,
          name: 'id',
          type: {
            array: ['u8', 32],
          },
        },
      ],
      name: 'DepositEvent',
    },
  ],
  instructions: [
    {
      accounts: [
        {
          isMut: true,
          isSigner: false,
          name: 'relayEscrow',
        },
        {
          isMut: true,
          isSigner: false,
          name: 'vault',
        },
        {
          isMut: true,
          isSigner: true,
          name: 'owner',
        },
        {
          isMut: false,
          isSigner: false,
          name: 'allocator',
        },
        {
          isMut: false,
          isSigner: false,
          name: 'systemProgram',
        },
      ],
      args: [],
      name: 'initialize',
    },
    {
      accounts: [
        {
          isMut: true,
          isSigner: false,
          name: 'relayEscrow',
        },
        {
          isMut: false,
          isSigner: true,
          name: 'owner',
        },
      ],
      args: [
        {
          name: 'newAllocator',
          type: 'publicKey',
        },
      ],
      name: 'setAllocator',
    },
    {
      accounts: [
        {
          isMut: false,
          isSigner: false,
          name: 'relayEscrow',
        },
        {
          isMut: true,
          isSigner: true,
          name: 'sender',
        },
        {
          isMut: false,
          isSigner: false,
          name: 'depositor',
        },
        {
          isMut: true,
          isSigner: false,
          name: 'vault',
        },
        {
          isMut: false,
          isSigner: false,
          name: 'systemProgram',
        },
      ],
      args: [
        {
          name: 'amount',
          type: 'u64',
        },
        {
          name: 'id',
          type: {
            array: ['u8', 32],
          },
        },
      ],
      name: 'depositNative',
    },
    {
      accounts: [
        {
          isMut: false,
          isSigner: false,
          name: 'relayEscrow',
        },
        {
          isMut: false,
          isSigner: false,
          name: 'mint',
        },
        {
          isMut: true,
          isSigner: true,
          name: 'sender',
        },
        {
          isMut: true,
          isSigner: false,
          name: 'senderTokenAccount',
        },
        {
          isMut: false,
          isSigner: false,
          name: 'depositor',
        },
        {
          isMut: true,
          isSigner: false,
          name: 'vaultTokenAccount',
        },
        {
          isMut: false,
          isSigner: false,
          name: 'vault',
        },
        {
          isMut: false,
          isSigner: false,
          name: 'tokenProgram',
        },
        {
          isMut: false,
          isSigner: false,
          name: 'associatedTokenProgram',
        },
        {
          isMut: false,
          isSigner: false,
          name: 'systemProgram',
        },
      ],
      args: [
        {
          name: 'amount',
          type: 'u64',
        },
        {
          name: 'id',
          type: {
            array: ['u8', 32],
          },
        },
      ],
      name: 'depositToken',
    },
    {
      accounts: [
        {
          isMut: false,
          isSigner: false,
          name: 'relayEscrow',
        },
        {
          isMut: true,
          isSigner: true,
          name: 'executor',
        },
        {
          isMut: true,
          isSigner: false,
          name: 'recipient',
        },
        {
          isMut: true,
          isSigner: false,
          name: 'vault',
        },
        {
          isMut: false,
          isOptional: true,
          isSigner: false,
          name: 'mint',
        },
        {
          isMut: true,
          isOptional: true,
          isSigner: false,
          name: 'vaultTokenAccount',
        },
        {
          isMut: true,
          isOptional: true,
          isSigner: false,
          name: 'recipientTokenAccount',
        },
        {
          isMut: true,
          isSigner: false,
          name: 'usedRequest',
        },
        {
          isMut: false,
          isSigner: false,
          name: 'tokenProgram',
        },
        {
          isMut: false,
          isSigner: false,
          name: 'associatedTokenProgram',
        },
        {
          isMut: false,
          isSigner: false,
          name: 'systemProgram',
        },
        {
          isMut: false,
          isSigner: false,
          name: 'ixSysvar',
        },
      ],
      args: [
        {
          name: 'request',
          type: {
            defined: 'TransferRequest',
          },
        },
      ],
      name: 'executeTransfer',
    },
  ],
  name: 'relay_escrow',
  types: [
    {
      name: 'TransferRequest',
      type: {
        fields: [
          {
            name: 'recipient',
            type: 'publicKey',
          },
          {
            name: 'token',
            type: {
              option: 'publicKey',
            },
          },
          {
            name: 'amount',
            type: 'u64',
          },
          {
            name: 'nonce',
            type: 'u64',
          },
          {
            name: 'expiration',
            type: 'i64',
          },
        ],
        kind: 'struct',
      },
    },
  ],
  version: '0.1.0',
}

export const hashRequest = (request: any) => {
  const coder = new BorshCoder(IDL)
  const message = coder.types.encode('TransferRequest', request)
  const hashData = sha256.create()
  hashData.update(message)
  return {
    bytes: '0x' + message.toString('hex'),
    hash: '0x' + Buffer.from(hashData.array()).toString('hex'),
  }
}

export const decodeEscrowRequest = (payload: string) => {
  if (payload.startsWith('0x')) {
    payload = payload.substring(2)
  }
  const encoded = Buffer.from(payload, 'hex')
  const coder = new BorshCoder(IDL)
  const message = coder.types.decode('TransferRequest', encoded)
  return message
}

// Helper function to convert base58 to bytes32
export const base58ToBytes32 = (b58: string): string => {
  const decoded = bs58.decode(b58)
  // Pad with zeros if needed to ensure 32 bytes
  const padded = Buffer.alloc(32, 0)
  // Copy the decoded bytes into the padded buffer
  padded.set(decoded, padded.length - decoded.length)
  return '0x' + padded.toString('hex')
}

export const bytes32ToBase58 = (hex: string): string => {
  const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex
  const buffer = Buffer.from(cleanHex, 'hex')

  // Convert to base58
  return bs58.encode(buffer)
}
