# Relay Settlement SDK

TypeScript SDK for encoding/decoding and passing messages accross the Relay Settlement Protocol.

## Installation

```bash
npm install @relay-protocol/settlement-sdk
# or
yarn add @relay-protocol/settlement-sdk
```

## Usage

### Orders

```typescript
import {
  encodeOrderCall,
  decodeOrderCall,
  getOrderId,
} from "@relay-protocol/settlement-sdk"

// Encode an order call
const encoded = encodeOrderCall({
  vmType: "ethereum-vm",
  call: {
    to: "0x...",
    data: "0x...",
    value: "1000000000000000000",
  },
})

// Decode an order call
const decoded = decodeOrderCall(encoded, "ethereum-vm")

// Get order ID
const orderId = getOrderId(order, chainsConfig)
```

### Address Encoding

```typescript
import {
  encodeAddress,
  decodeAddress,
  VmType,
} from "@relay-protocol/settlement-sdk"

// Encode address for a specific VM type
const encoded = encodeAddress("bc1q...", "bitcoin-vm")
const decoded = decodeAddress(encoded, "bitcoin-vm")
```

### Hub Contract utils

```typescript
import {
  generateAddress,
  generateTokenId,
} from "@relay-protocol/settlement-sdk"

// Generate virtual address
const virtualAddress = generateAddress({
  family: "ethereum-vm",
  chainId: 1n,
  address: "0x...",
})

// Generate token ID
const tokenId = generateTokenId({
  family: "ethereum-vm",
  chainId: 1n,
  address: "0x...",
})
```

### Depository Contracts utils

```typescript
import {
  encodeWithdrawal,
  decodeWithdrawal,
  getDepositoryDepositMessageId,
  getExecutionMessageId,
} from "@relay-protocol/settlement-sdk"

// Encode/decode withdrawal messages
const encoded = encodeWithdrawal(withdrawal, vmType)
const decoded = decodeWithdrawal(encoded, vmType)

// Get message IDs
const depositId = getDepositoryDepositMessageId(message)
const executionId = getExecutionMessageId(message)
```

## Supported VM Types

- `bitcoin-vm`
- `ethereum-vm`
- `solana-vm`
- `sui-vm`
- `hyperliquid-vm`
- `tron-vm`
- `lighter-vm`

## API Reference

See the [TypeScript definitions](./dist/index.d.ts) for complete API documentation.
