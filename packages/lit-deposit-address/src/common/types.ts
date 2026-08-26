/**
 * Type definitions shared across the Lit Action, derivation helpers, and
 * attestation verification.
 */

export type { Order } from "./relay-sdk.js";

/** All VM families this project knows how to derive wallets for. */
export const VM_TYPES = [
  "ethereum-vm",
  "bitcoin-vm",
  "solana-vm",
  "hyperliquid-vm",
  "ton-vm",
  "tron-vm",
] as const;

/** A VM family identifier. */
export type VmType = (typeof VM_TYPES)[number];

/** Public account-level derivation root for a given VM. */
export interface AccountInfo {
  /** VM family this account belongs to. */
  vmType: VmType;
  /** Canonical account derivation path, e.g. `m/44'/60'/0'/0`. */
  accountPath: string;
  /** Hex-encoded compressed (or curve-native) account public key. */
  publicKey: string;
  /**
   * Account public root serialized as an extended public key. Can be used
   * with {@link DerivationApi.deriveWalletFromExtendedPublicKey} to derive
   * child wallets without access to the root private key.
   */
  extendedPublicKey: string;
}

/** A derived child wallet at a specific derivation path. */
export interface WalletInfo {
  /** VM family this wallet belongs to. */
  vmType: VmType;
  /** Unhardened uint31 child indexes appended to the account path. */
  indexes: number[];
  /** Full derivation path including the child indexes. */
  path: string;
  /** VM-formatted public address. */
  address: string;
  /** Hex- or base58-encoded public key, formatted per VM convention. */
  publicKey: string;
}

/**
 * EVM transaction input. The caller passes a viem-parseable serialized
 * unsigned EVM transaction; nonce, gas, fees, chain id, calldata, etc. are
 * encoded inside.
 */
export interface EthereumVmTransaction {
  /** Hex-encoded serialized unsigned EVM transaction (with `0x` prefix). */
  unsignedTransaction: string;
}

/** EVM signing output. */
export interface EthereumVmSignedTransaction {
  /** Hex-encoded serialized signed EVM transaction (with `0x` prefix). */
  rawTransaction: string;
  /** Keccak256 of `rawTransaction` (with `0x` prefix). */
  transactionHash: string;
}

/**
 * Bitcoin transaction input. The caller is responsible for UTXO selection,
 * output construction, and BIP143 sighash computation; the action validates
 * the unsigned transaction and recomputes each provided sighash before signing.
 */
export interface BitcoinVmTransaction {
  /** Hex-encoded unsigned Bitcoin transaction (no witness data). */
  unsignedTransaction: string;
  /**
   * Previous-output values, in satoshis, one per input. Required to recompute
   * BIP143 segwit sighashes for the deposit wallet's P2WPKH inputs.
   */
  inputValues: string[];
  /**
   * Pre-computed BIP143 SIGHASH_ALL digests to sign, one per input. Each entry
   * is a `0x`-prefixed 32-byte hex string and must match the digest recomputed
   * from `unsignedTransaction` + `inputValues` for the derived deposit wallet.
   */
  sighashes: string[];
}

/** Bitcoin signing output: one compact ECDSA signature per input. */
export interface BitcoinVmSignedTransaction {
  /** Compact (64-byte) ECDSA signatures, hex-encoded with `0x` prefix. */
  signatures: string[];
}

/**
 * Solana transaction input. The caller compiles the message (including a
 * recent blockhash, instructions, and signer accounts) and base64-encodes it.
 * The action signs the deposit-wallet signer slot and returns a transaction
 * with zero placeholders for any other required signer.
 */
export interface SolanaVmTransaction {
  /** Base64-encoded compiled message bytes — the part to sign. */
  message: string;
}

/** Solana signing output. */
export interface SolanaVmSignedTransaction {
  /** 64-byte Ed25519 signature, hex-encoded with `0x` prefix. */
  signature: string;
  /** Base64-encoded transaction bytes: shortvec(signature count) || signatures || message. */
  rawTransaction: string;
}

/**
 * Hyperliquid `sendAsset` action payload. This is not an EVM transaction; the
 * signed result is wrapped into Hyperliquid's `/exchange` request body by the
 * solver.
 */
export interface HyperliquidVmSendAsset {
  /** Hyperliquid action discriminator. Only `sendAsset` is supported. */
  type: "sendAsset";
  /** Hyperliquid EIP-712 domain chain id, e.g. `0xa4b1` for mainnet. */
  signatureChainId: string;
  /** Hyperliquid environment. Currently only mainnet is accepted by policy. */
  hyperliquidChain: "Mainnet";
  /** Destination depository address on Hyperliquid. */
  destination: string;
  /** Source DEX: empty for native USDC perp, `spot` for spot tokens. */
  sourceDex: "" | "spot";
  /** Destination DEX: empty for native USDC perp, `spot` for spot tokens. */
  destinationDex: "" | "spot";
  /** Hyperliquid token descriptor, formatted as `SYMBOL:0x<16-byte-token>`. */
  token: string;
  /** Decimal amount string in whole-token units. */
  amount: string;
  /** Hyperliquid sub-account selector. Deposit sweeps require the root account. */
  fromSubAccount: string;
  /** Hyperliquid action nonce. Must equal the Relay nonce mapping nonce. */
  nonce: number;
}

/** Relay nonce mapping signed by the Hyperliquid deposit wallet. */
export interface HyperliquidVmNonceMapping {
  /** Protocol chain id string that the solver/oracle use for the wallet chain. */
  walletChainId: string;
  /** Derived Hyperliquid deposit wallet address. */
  wallet: string;
  /** Depositor associated with the Relay order. */
  depositor: string;
  /** Relay order id bound to this Hyperliquid nonce. */
  id: string;
  /** Hyperliquid action nonce, decimal string. */
  nonce: string;
}

/** Hyperliquid signing input: a nonce mapping plus the matching sendAsset. */
export interface HyperliquidVmTransaction {
  nonceMapping: HyperliquidVmNonceMapping;
  sendAsset: HyperliquidVmSendAsset;
}

/** EIP-712 digests and signatures returned for Hyperliquid signing. */
export interface HyperliquidVmSignedTransaction {
  nonceMapping: { digest: string; signature: string };
  sendAsset: { digest: string; signature: string };
}

/**
 * TON deposit-sweep input. The deposit wallet is a Wallet V5R1 contract;
 * the caller describes the single native-TON transfer that forwards the
 * deposited funds to the depository with the order id (and depositor) carried
 * in a text-comment body. The action builds the canonical Wallet V5R1
 * external message from these fields, signs it, and returns a ready-to-
 * broadcast bag-of-cells.
 */
export interface TonVmTransaction {
  /** Recipient (the input depository) as a raw `0:<hex>` or friendly address. */
  to: string;
  /** Nanoton amount to deliver to the depository, decimal string. */
  amount: string;
  /** Text-comment body: `trigger.orderId` followed by `|depositor=<addr>|`. */
  comment: string;
  /** Must be `false` for deposits (a bounce would auto-refund the credit). */
  bounce: boolean;
  /** Wallet V5R1 seqno; `0` includes the StateInit so the first spend deploys. */
  seqno: number;
  /** `valid_until` unix seconds; ignored when `seqno === 0` (uses the max). */
  validUntil: number;
  /** TON send mode. Must not carry the remaining balance so `amount` is exact. */
  sendMode: number;
}

/** TON signing output. */
export interface TonVmSignedTransaction {
  /** 64-byte Ed25519 signature over the signed-request cell hash, `0x`-prefixed. */
  signature: string;
  /** The signed-request cell hash that was signed, `0x`-prefixed. */
  signingHash: string;
  /** Base64 bag-of-cells of the external-in message, ready to broadcast. */
  externalMessage: string;
}

/** Tron protocol.Transaction.raw input authorized for a deposit stage. */
export interface TronVmTransaction {
  purpose: "native-deposit" | "trc20-pre-approval" | "trc20-approval" | "trc20-deposit";
  /** Hex-encoded canonical Tron protocol.Transaction.raw protobuf bytes. */
  rawData: string;
}

/** Signed Tron protocol.Transaction returned by the action. */
export interface TronVmSignedTransaction {
  /** Hex-encoded signed Tron protocol.Transaction protobuf bytes. */
  rawTransaction: string;
  /** Lowercase SHA-256 hash of the exact raw_data protobuf bytes. */
  transactionHash: string;
}

/** Maps each VM family to the transaction shape its signer expects. */
export interface VmTransactionMap {
  "ethereum-vm": EthereumVmTransaction;
  "bitcoin-vm": BitcoinVmTransaction;
  "solana-vm": SolanaVmTransaction;
  "hyperliquid-vm": HyperliquidVmTransaction;
  "ton-vm": TonVmTransaction;
  "tron-vm": TronVmTransaction;
}

/** Maps each VM family to the signed-transaction shape its signer returns. */
export interface VmSignedTransactionMap {
  "ethereum-vm": EthereumVmSignedTransaction;
  "bitcoin-vm": BitcoinVmSignedTransaction;
  "solana-vm": SolanaVmSignedTransaction;
  "hyperliquid-vm": HyperliquidVmSignedTransaction;
  "ton-vm": TonVmSignedTransaction;
  "tron-vm": TronVmSignedTransaction;
}

/** Source-side description of the funds being deposited. */
export interface DepositAddressTriggerInput {
  vmType: VmType;
  chainId: string;
  currency: string;
  amount: string;
}

/** Inputs that deterministically derive the deposit wallet's path. */
export interface DepositAddressTriggerDerivationFields {
  inputVmType: VmType;
  outputVmType: VmType;
  outputChainId: string;
  outputCurrency: string;
  outputRecipient: string;
  solver: string;
  pricingOracle: string;
  depositor: string;
  refundRecipient: string;
  priceImpactBps: string;
  salt: string;
}

/** Currency captured in the trigger hash for pricing purposes. */
export interface DepositAddressTriggerCurrency {
  chainId: string;
  currency: string;
}

/** USD price captured for a currency in the trigger hash. */
export interface DepositAddressTriggerPrice {
  /** USD price of one whole unit of the currency, scaled by `10 ** usdPriceDecimals`. */
  usdPrice: string;
  /** Fixed-point precision of `usdPrice`. */
  usdPriceDecimals: number;
  /** Number of decimals the currency itself uses (e.g. 18 for ETH, 6 for USDC). */
  currencyDecimals: number;
  /** Unix timestamp in seconds when the price was published. */
  publishTime: string;
  expiration: string;
}

/** Full deposit-address trigger payload that gets hashed by the oracle. */
export interface DepositAddressTrigger {
  input: DepositAddressTriggerInput;
  derivationFields: DepositAddressTriggerDerivationFields;
  orderId: string;
  nonce: string;
  currencies: DepositAddressTriggerCurrency[];
  prices: DepositAddressTriggerPrice[];
  extraData: string;
}

/** A single oracle EIP-712 signature over a deposit-address trigger hash. */
export interface DepositAddressTriggerSignature {
  oracleSigner: string;
  signature: string;
}

/** Oracle-signed attestation that a trigger hash maps to the bound order. */
export interface DepositAddressTriggerAttestation {
  /** Hub EVM chain id the trigger was attested for. */
  chainId: number;
  /** Hub deposit-address manager contract address. */
  depositAddressManager: string;
  /** Opaque, VM-specific encoding of the depository on the input chain. */
  inputDepository: string;
  /** EIP-712 deposit-address trigger hash. */
  triggerHash: string;
  /** Oracle EIP-712 signatures attesting the trigger hash. */
  signatures: DepositAddressTriggerSignature[];
}
