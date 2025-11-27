# Solana Durable Nonce Support

This document explains how to use Durable Nonce with Solana transactions in the relay multisig signer.

## What is Durable Nonce?

Durable Nonce is a Solana feature that allows transactions to remain valid indefinitely, unlike regular transactions that expire after ~150 seconds. This is crucial for multisig scenarios where signature collection might take longer than the blockhash expiration time.

## Benefits

- **No Time Pressure**: Transactions don't expire, allowing unlimited time for signature collection
- **Reliable Execution**: Eliminates failed transactions due to expired blockhashes
- **Better UX**: No need to recreate transactions when signatures take too long

## Usage

### 1. Create a Nonce Account

First, create a durable nonce account:

```bash
npx hardhat relay-multisig-signer:solana-create-nonce-account \
  --rpc "https://api.devnet.solana.com" \
  --payer "YOUR_BASE58_PRIVATE_KEY" \
  --authority "NONCE_AUTHORITY_PUBKEY"
```

This will output:

- Nonce account address
- Authority public key
- Current nonce value

### 2. Update Transaction Schema

Add nonce fields to your Solana transaction JSON:

```json
{
  "family": "solana-vm",
  "from": "8ExuNrYDwCXS2Jg6Rmi7GRJg7J5VbJzNGPGh8K4xJWJz",
  "rpc": "https://api.devnet.solana.com",
  "nonceAccount": "7J4kF8CcLbJeXhJNm1XsKQpGHKjQ9Hm3dYzVwVNBQ4xZ",
  "nonceAccountAuth": "8ExuNrYDwCXS2Jg6Rmi7GRJg7J5VbJzNGPGh8K4xJWJz",
  "computeUnitLimit": "200000",
  "computeUnitPrice": "5000",
  "instructions": [...]
}
```

### 3. Required Fields

When using Durable Nonce, you must provide:

- `nonceAccount`: The public key of the nonce account
- `nonceAccountAuth`: The public key authorized to use the nonce (usually the signer)

### 4. Two-Phase Signing Process

Durable Nonce transactions require signatures from **two different entities**:

#### Phase 1: MPC Multisig Signing

- **What**: Business logic instructions (transfers, program calls, etc.)
- **Who**: Relay multisig signer (MPC-managed key)
- **When**: During transaction creation and signature collection

#### Phase 2: Nonce Authority Signing

- **What**: `SystemProgram.nonceAdvance()` instruction (first instruction)
- **Who**: Nonce account authority (regular private key)
- **When**: During transaction execution (`executeSolanaTransaction`)

### 5. Environment Configuration

Set the nonce authority private key as an environment variable:

```bash
export SOLANA_NONCE_AUTHORITY_PRIVATE_KEY="YOUR_BASE58_PRIVATE_KEY"
```

This key must match the `nonceAccountAuth` specified in your transaction data.

### 6. How It Works

1. **Build Transaction**: System checks if `nonceAccount` and `nonceAccountAuth` are provided
2. **Fetch Nonce**: Fetches current nonce value from the account
3. **Add Instructions**: Automatically adds `SystemProgram.nonceAdvance()` as the FIRST instruction
4. **Create Transaction**: Uses nonce value as the "blockhash" for the transaction
5. **MPC Signing**: Collects multisig signatures for business logic
6. **Execute Transaction**:
   - Adds MPC signature for business logic
   - Reads `SOLANA_NONCE_AUTHORITY_PRIVATE_KEY` from environment
   - Signs `nonceAdvance` instruction with nonce authority
   - Broadcasts complete transaction

## Migration from Recent Blockhash

To migrate existing transactions:

1. **Without Nonce** (expires in ~150 seconds):

```json
{
  "family": "solana-vm",
  "from": "...",
  "rpc": "...",
  "instructions": [...]
}
```

2. **With Durable Nonce** (never expires):

```json
{
  "family": "solana-vm",
  "from": "...",
  "rpc": "...",
  "nonceAccount": "NONCE_ACCOUNT_PUBKEY",
  "nonceAccountAuth": "NONCE_AUTHORITY_PUBKEY",
  "instructions": [...]
}
```

## Why Nonce Authority Doesn't Need MPC Signing?

**Security Principle**: The nonce authority is purely a **utility function**, not a security boundary.

### Key Distinctions:

#### Business Logic (Requires MPC)

- **Controls funds**: Transfer SOL, tokens, or interact with programs
- **Financial impact**: Direct access to valuable assets
- **Security critical**: Must be protected by multisig
- **Example**: `SystemProgram.transfer()`, token transfers, DeFi interactions

#### Nonce Advance (Does NOT require MPC)

- **Utility function**: Only advances nonce counter
- **No financial access**: Cannot move funds or access assets
- **Infrastructure only**: Enables transaction validity, not asset control
- **Analogy**: Like a sequence counter - important for ordering, but not for security

### Design Benefits:

1. **Operational Efficiency**: No need to coordinate MPC signatures for utility operations
2. **Separation of Concerns**: Financial security vs. transaction infrastructure
3. **Reduced Complexity**: Simpler key management for non-financial operations
4. **Better Performance**: Faster execution without additional MPC coordination

### Security Model:

```
┌─────────────────────────────────────────────────────┐
│                 SOLANA TRANSACTION                  │
├─────────────────────────────────────────────────────┤
│ 1. nonceAdvance() ← Nonce Authority (Regular Key)  │
│    └─ Purpose: Enable durable transactions          │
│    └─ Risk: None (cannot access funds)             │
├─────────────────────────────────────────────────────┤
│ 2. transfer() ← MPC Multisig Signer                │
│    └─ Purpose: Move funds                          │
│    └─ Risk: HIGH (controls valuable assets)        │
└─────────────────────────────────────────────────────┘
```

**Bottom Line**: Nonce authority is like a "transaction enabler" - it makes transactions work, but it cannot steal funds or compromise security.

## Important Notes

- **Atomic Operation**: `nonceAdvance` and business instructions are executed in the same transaction
- **First Instruction**: `SystemProgram.nonceAdvance()` is automatically added as the first instruction
- **Authority Signature**: The nonce authority must be included in the transaction signers
- **One Transaction Per Nonce**: Each nonce value can only be used once
- **Rent Exemption**: The nonce account must have enough SOL to remain rent-exempt
- **Reusability**: Same nonce account can be used for multiple transactions (nonce advances each time)
- **Environmental Security**: Store nonce authority private key securely (environment variable)

## Cost

Creating a nonce account requires:

- Rent exemption: ~0.00144 SOL (refundable when closed)
- Transaction fees: ~0.000005 SOL per transaction

## Complete Workflow Example

### Setup (One-time)

```bash
# 1. Create nonce account
npx hardhat relay-multisig-signer:solana-create-nonce-account \
  --rpc "https://api.devnet.solana.com" \
  --payer "BASE58_PAYER_PRIVATE_KEY" \
  --authority "NONCE_AUTHORITY_PUBKEY"

# 2. Set environment variable for execution
export SOLANA_NONCE_AUTHORITY_PRIVATE_KEY="NONCE_AUTHORITY_PRIVATE_KEY"
```

### Transaction Execution

```bash
# 1. Create transaction manifest with nonce fields
cat > transactions.json << EOF
[
  {
    "family": "solana-vm",
    "from": "MPC_SIGNER_PUBKEY",
    "rpc": "https://api.devnet.solana.com",
    "nonceAccount": "NONCE_ACCOUNT_PUBKEY",
    "nonceAccountAuth": "NONCE_AUTHORITY_PUBKEY",
    "instructions": [
      {
        "programId": "11111111111111111111111111111111",
        "data": "02000000...",
        "keys": [...]
      }
    ]
  }
]
EOF

# 2. Execute transaction (handles both MPC + nonce authority signatures)
npx hardhat relay-multisig-signer:execute-transactions \
  --transactions transactions.json \
  --relay-multisig-signer "0x123..."
```

### What Happens:

1. **MPC Phase**: Business logic signed by multisig
2. **Nonce Phase**: `nonceAdvance` signed by nonce authority
3. **Broadcast**: Complete transaction sent to Solana network
4. **Result**: Transaction executes atomically, nonce advances for next use

### Key Benefits:

- **No Expiration**: Transaction valid indefinitely during MPC signature collection
- **Atomic Execution**: Both nonce advance and business logic in single transaction
- **Efficient**: Nonce authority doesn't require MPC coordination
- **Reusable**: Same nonce account works for all future transactions
