// ABOUTME: Canonical Hedera identity codecs — entity ids (accounts, HTS tokens),
// ABOUTME: EVM aliases, transaction ids, transaction hashes, consensus timestamps.

import { bytesToHex, Hex, hexToBytes } from "viem"

// ====== Networks ======

export type HederaNetwork = "mainnet" | "testnet" | "previewnet" | "local-node"

// Ledger ids as defined by the Hedera network. The ledger id is the salt of the
// entity id checksum, which is what makes a checksum network-specific: the same
// `0.0.456858` yields `ojdqc` on mainnet and `xwoxl` on testnet.
export const HEDERA_LEDGER_IDS: Record<HederaNetwork, Uint8Array> = {
  mainnet: Uint8Array.from([0]),
  testnet: Uint8Array.from([1]),
  previewnet: Uint8Array.from([2]),
  "local-node": Uint8Array.from([3]),
}

const isHederaNetwork = (value: string): value is HederaNetwork =>
  Object.prototype.hasOwnProperty.call(HEDERA_LEDGER_IDS, value)

// ====== Entity ids (accounts, HTS tokens, contracts, files, ...) ======

// Hedera addresses every entity — accounts, HTS tokens, contracts, topics — in a
// single `shard.realm.num` id space, so accounts and tokens share this codec.
export interface HederaEntityId {
  shard: bigint
  realm: bigint
  num: bigint
}

export interface HederaEntityIdParseOptions {
  // Network whose ledger id an optional `-xxxxx` checksum is validated against.
  //
  // Required whenever the input carries a checksum. Accepting a checksum with
  // no network to check it against would defeat the only thing checksums exist
  // for (catching an id pasted from the wrong network), so a checksummed value
  // supplied without a network is rejected rather than trusted.
  network?: HederaNetwork
}

// Entity ids are int64 fields in the Hedera protobufs, so each component is
// bounded by the signed 64-bit maximum and may not be negative.
const HEDERA_ENTITY_COMPONENT_MAX = (1n << 63n) - 1n

// Canonical entity id: exactly three dot-separated decimal components, no
// leading zeros, with an optional five-letter checksum. Shorter forms accepted
// elsewhere in the ecosystem (`456858`, `0.456858`) are deliberately rejected —
// see `parseHederaEntityId`.
const HEDERA_ENTITY_ID_REGEX =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([a-z]{5}))?$/

const assertEntityComponent = (value: bigint, name: string, id: string) => {
  if (value > HEDERA_ENTITY_COMPONENT_MAX) {
    throw new Error(
      `Invalid Hedera entity id "${id}": ${name} exceeds the int64 maximum ${HEDERA_ENTITY_COMPONENT_MAX}`
    )
  }
}

/**
 * Parses a canonical Hedera entity id (`shard.realm.num`, e.g. `0.0.456858`),
 * optionally carrying the network checksum suffix (`0.0.456858-ojdqc`).
 *
 * Noncanonical spellings are rejected rather than normalized, because an
 * identity that has more than one accepted spelling silently breaks equality
 * comparisons and de-duplication downstream:
 *
 * - abbreviated forms (`456858`, `0.456858`) — the shard and realm must be
 *   explicit, so an id always compares equal to itself as a string;
 * - leading zeros (`0.0.0456858`), signs, whitespace, uppercase checksums;
 * - components above the int64 maximum;
 * - checksums that belong to a different network (see `options.network`).
 */
export const parseHederaEntityId = (
  value: string,
  options: HederaEntityIdParseOptions = {}
): HederaEntityId => {
  const match = HEDERA_ENTITY_ID_REGEX.exec(value)
  if (!match) {
    throw new Error(
      `Invalid Hedera entity id "${value}": expected the canonical shard.realm.num form (e.g. 0.0.456858) with an optional -xxxxx checksum`
    )
  }

  const [, shard, realm, num, checksum] = match
  const entityId: HederaEntityId = {
    shard: BigInt(shard),
    realm: BigInt(realm),
    num: BigInt(num),
  }
  assertEntityComponent(entityId.shard, "shard", value)
  assertEntityComponent(entityId.realm, "realm", value)
  assertEntityComponent(entityId.num, "num", value)

  if (checksum !== undefined) {
    if (options.network === undefined) {
      throw new Error(
        `Hedera entity id "${value}" carries a checksum but no network was supplied to validate it against; pass \`network\` or use the checksum-free form`
      )
    }
    const expected = getHederaEntityIdChecksum(entityId, options.network)
    if (checksum !== expected) {
      throw new Error(
        `Hedera entity id "${value}" has a checksum for a different network: expected "${expected}" on ${options.network}`
      )
    }
  }

  return entityId
}

/** Formats an entity id in its canonical checksum-free form (`0.0.456858`). */
export const formatHederaEntityId = (entityId: HederaEntityId): string =>
  `${entityId.shard}.${entityId.realm}.${entityId.num}`

/**
 * Computes the five-letter network checksum for an entity id, per HIP-15.
 *
 * Ported from the reference implementation in the Hedera JavaScript SDK
 * (`EntityIdHelper._checksum`); the vectors in `test/hedera-vm.test.ts` are
 * generated from that implementation.
 */
export const getHederaEntityIdChecksum = (
  entityId: HederaEntityId,
  network: HederaNetwork
): string => {
  if (!isHederaNetwork(network)) {
    throw new Error(`Unknown Hedera network "${network}"`)
  }

  const p3 = 26 * 26 * 26 // 3 digits in base 26
  const p5 = 26 * 26 * 26 * 26 * 26 // 5 digits in base 26
  const asciiA = "a".charCodeAt(0)
  const m = 1000003 // min prime greater than a million; final permutation
  const w = 31 // digit weight base; coprime to p5

  const address = formatHederaEntityId(entityId)

  // Ledger id followed by six zero bytes.
  const ledgerId = HEDERA_LEDGER_IDS[network]
  const h = new Uint8Array(ledgerId.length + 6)
  h.set(ledgerId, 0)

  let s = 0 // weighted sum of all digits (mod p3)
  let s0 = 0 // sum of even-position digits (mod 11)
  let s1 = 0 // sum of odd-position digits (mod 11)
  let sh = 0 // hash of the ledger id (mod p5)

  for (let i = 0; i < address.length; i++) {
    // "." counts as the digit 10.
    const digit = address[i] === "." ? 10 : Number(address[i])
    s = (w * s + digit) % p3
    if (i % 2 === 0) {
      s0 = (s0 + digit) % 11
    } else {
      s1 = (s1 + digit) % 11
    }
  }
  for (let i = 0; i < h.length; i++) {
    sh = (w * sh + h[i]) % p5
  }

  let c = ((((address.length % 5) * 11 + s0) * 11 + s1) * p3 + s + sh) % p5
  c = (c * m) % p5

  let checksum = ""
  for (let i = 0; i < 5; i++) {
    checksum = String.fromCharCode(asciiA + (c % 26)) + checksum
    c = Math.floor(c / 26)
  }
  return checksum
}

/** Formats an entity id with its network checksum (`0.0.456858-ojdqc`). */
export const formatHederaEntityIdWithChecksum = (
  entityId: HederaEntityId,
  network: HederaNetwork
): string =>
  `${formatHederaEntityId(entityId)}-${getHederaEntityIdChecksum(entityId, network)}`

// ====== HBAR and HTS token ids ======

// HBAR has no HTS token entity, so the zero entity id is its sentinel — the
// same convention the other VMs use for their native currency (a zero address
// on ethereum-vm, the system program on solana-vm). It encodes to 20 zero bytes.
export const HEDERA_HBAR_TOKEN_ID = "0.0.0"

// Native Hedera USDC on mainnet. This constant is the source of truth for the
// token id across the settlement stack; derive the EVM address from it with
// `hederaEntityIdToEvmAddress` rather than hardcoding one.
export const HEDERA_MAINNET_USDC_TOKEN_ID = "0.0.456858"

// ====== EVM addresses (long-zero entity ids and account aliases) ======

const EVM_ADDRESS_BYTE_LENGTH = 20
// A "long-zero" address encodes an entity id: 4-byte shard, 8-byte realm and
// 8-byte num, big-endian. Because mainnet and testnet only ever use shard 0 and
// realm 0, every real long-zero address starts with 12 zero bytes — which is
// what distinguishes it from an account's EVM alias.
const LONG_ZERO_PREFIX_BYTE_LENGTH = 12

const EVM_ADDRESS_REGEX = /^(?:0x)?([0-9a-fA-F]{40})$/

// An account alias is a 20-byte EVM address adopted by an account (the "hollow
// account" flow), so it occupies the same slot as a long-zero entity id and is
// told apart by its nonzero prefix.
export type HederaAddress =
  | { kind: "entity-id"; entityId: HederaEntityId }
  | { kind: "evm-alias"; address: Hex }

// Entity ids only fit the long-zero layout unambiguously when shard and realm
// are zero: a nonzero shard or realm sets bytes inside the 12-byte prefix, and
// the result would decode back as an account's EVM alias rather than as the
// entity. Shard 0 / realm 0 covers every entity on mainnet, testnet and
// previewnet today; anything else is rejected instead of silently aliased.
const assertZeroShardAndRealm = (entityId: HederaEntityId) => {
  if (entityId.shard !== 0n || entityId.realm !== 0n) {
    throw new Error(
      `Hedera entity id ${formatHederaEntityId(entityId)} is not representable as a 20-byte address: only shard 0 / realm 0 entities fit the long-zero layout`
    )
  }
}

/**
 * Converts an entity id to its long-zero EVM address, e.g. USDC's `0.0.456858`
 * to `0x000000000000000000000000000000000006f89a`.
 *
 * Addresses are emitted lowercase, matching the Hedera mirror node; compare
 * them case-insensitively (or through viem's `getAddress`) if a caller needs
 * the EIP-55 spelling.
 */
export const hederaEntityIdToEvmAddress = (
  entityId: HederaEntityId | string
): Hex => {
  const parsed =
    typeof entityId === "string" ? parseHederaEntityId(entityId) : entityId
  assertZeroShardAndRealm(parsed)

  const bytes = new Uint8Array(EVM_ADDRESS_BYTE_LENGTH)
  // Note: the num field is a full 8 bytes. The Hedera JavaScript SDK's
  // `toSolidityAddress` writes it with `setUint32` and therefore truncates ids
  // above 2^32; its `fromSolidityAddress` reads all 8 bytes, so the 8-byte
  // layout used here is the one that round-trips.
  let num = parsed.num
  for (
    let i = EVM_ADDRESS_BYTE_LENGTH - 1;
    i >= LONG_ZERO_PREFIX_BYTE_LENGTH;
    i--
  ) {
    bytes[i] = Number(num & 0xffn)
    num >>= 8n
  }
  return bytesToHex(bytes)
}

/**
 * Reads the entity id out of a long-zero EVM address. Throws for addresses that
 * are not long-zero: those are account aliases, which carry no entity id and
 * must be resolved against the network instead.
 */
export const evmAddressToHederaEntityId = (address: string): HederaEntityId => {
  const bytes = parseEvmAddressBytes(address)
  if (!isLongZeroAddressBytes(bytes)) {
    throw new Error(
      `EVM address ${address} is not a long-zero address, so it carries no Hedera entity id; resolve the account alias against the network first`
    )
  }
  return longZeroBytesToEntityId(bytes)
}

const longZeroBytesToEntityId = (bytes: Uint8Array): HederaEntityId => {
  let num = 0n
  for (let i = LONG_ZERO_PREFIX_BYTE_LENGTH; i < EVM_ADDRESS_BYTE_LENGTH; i++) {
    num = (num << 8n) | BigInt(bytes[i])
  }
  // The long-zero layout carries a full 8 bytes, but Hedera declares entity
  // numbers as `int64`, so the top bit is never legitimately set. Rejecting
  // here keeps the address path as strict as `parseHederaEntityId`: a value
  // above the signed maximum would otherwise serialize to a varint the network
  // reads back as a negative entity number.
  if (num > HEDERA_ENTITY_COMPONENT_MAX) {
    throw new Error(
      `Invalid Hedera long-zero address: entity number ${num} exceeds the int64 maximum ${HEDERA_ENTITY_COMPONENT_MAX}`
    )
  }
  return { shard: 0n, realm: 0n, num }
}

const parseEvmAddressBytes = (address: string): Uint8Array => {
  const match = EVM_ADDRESS_REGEX.exec(address)
  if (!match) {
    throw new Error(
      `Invalid EVM address "${address}": expected 20 hex-encoded bytes`
    )
  }
  return hexToBytes(`0x${match[1].toLowerCase()}`)
}

const isLongZeroAddressBytes = (bytes: Uint8Array): boolean =>
  bytes.subarray(0, LONG_ZERO_PREFIX_BYTE_LENGTH).every((byte) => byte === 0)

// `shard.realm.<40 hex>` — the form the mirror node uses when it reports an
// entity by EVM address. The 40-hex-digit tail can never be mistaken for a
// decimal entity num (a 40-digit decimal is far past the int64 maximum), so
// this form stays unambiguous alongside `shard.realm.num`.
const HEDERA_PREFIXED_EVM_ADDRESS_REGEX =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.([0-9a-fA-F]{40})$/

/**
 * Parses any approved Hedera address form into a canonical identity:
 *
 * - a canonical entity id, `0.0.1234` (optionally checksummed — see
 *   `HederaEntityIdParseOptions.network`);
 * - an EVM address, `0x…`, in either the bare or `shard.realm.<40 hex>` form.
 *   Long-zero addresses normalize to the entity id they encode, so `0.0.1234`
 *   and its long-zero address parse to the same identity;
 * - anything else — notably the RFC 4648 base32 public-key aliases the mirror
 *   node reports for ED25519 / ECDSA accounts — is rejected. Those aliases are
 *   32+ bytes and do not fit the protocol's address slot; resolve them to an
 *   account id or EVM alias before handing them to the settlement stack.
 */
export const parseHederaAddress = (
  value: string,
  options: HederaEntityIdParseOptions = {}
): HederaAddress => {
  if (EVM_ADDRESS_REGEX.test(value)) {
    return fromEvmAddressBytes(parseEvmAddressBytes(value))
  }

  const prefixed = HEDERA_PREFIXED_EVM_ADDRESS_REGEX.exec(value)
  if (prefixed) {
    const [, shard, realm, hex] = prefixed
    if (shard !== "0" || realm !== "0") {
      throw new Error(
        `Invalid Hedera address "${value}": only shard 0 / realm 0 EVM addresses are supported`
      )
    }
    return fromEvmAddressBytes(parseEvmAddressBytes(hex))
  }

  return {
    kind: "entity-id",
    entityId: parseHederaEntityId(value, options),
  }
}

const fromEvmAddressBytes = (bytes: Uint8Array): HederaAddress =>
  isLongZeroAddressBytes(bytes)
    ? { kind: "entity-id", entityId: longZeroBytesToEntityId(bytes) }
    : { kind: "evm-alias", address: bytesToHex(bytes) }

/** Formats a parsed address back to its canonical string form. */
export const formatHederaAddress = (address: HederaAddress): string =>
  address.kind === "entity-id"
    ? formatHederaEntityId(address.entityId)
    : address.address

// ====== Address slot encoding ======

/**
 * Encodes a Hedera address into the protocol's 20-byte address slot: the
 * long-zero form for entity ids, the alias itself for EVM aliases.
 *
 * Checksummed input is rejected here on purpose. The wire encoding has no
 * network parameter, so a checksum could only be dropped unvalidated — exactly
 * the wrong-network mistake checksums are meant to catch. Validate and strip
 * checksums at the boundary where the network is known, with
 * `parseHederaAddress(value, { network })`, then encode the canonical form.
 */
export const encodeHederaAddress = (address: string): Uint8Array => {
  const parsed = parseHederaAddress(address)
  if (parsed.kind === "evm-alias") {
    return hexToBytes(parsed.address)
  }
  return hexToBytes(hederaEntityIdToEvmAddress(parsed.entityId))
}

/**
 * Decodes the protocol's 20-byte address slot. Long-zero values decode to their
 * entity id (`0.0.456858`); everything else decodes to a lowercase EVM alias.
 * Twenty zero bytes therefore decode to `0.0.0`, the HBAR sentinel.
 */
export const decodeHederaAddress = (address: Uint8Array): string => {
  if (address.length !== EVM_ADDRESS_BYTE_LENGTH) {
    throw new Error(
      `Invalid Hedera address byte length ${address.length}; expected ${EVM_ADDRESS_BYTE_LENGTH}`
    )
  }
  return formatHederaAddress(fromEvmAddressBytes(address))
}

// ====== Consensus timestamps ======

// Consensus timestamps and transaction valid-start times share one format:
// `seconds.nanoseconds`, with the nanoseconds always spelled out in full.
export interface HederaTimestamp {
  seconds: bigint
  nanos: number
}

const NANOS_PER_SECOND = 1_000_000_000

// Nanoseconds must be exactly nine digits. A shortened fraction is genuinely
// ambiguous — `1616167056.5` is 5 nanoseconds to the Hedera SDK but reads as
// half a second — and a timestamp misread by 500ms is a real settlement hazard,
// so the padded form is required rather than guessed at.
const HEDERA_TIMESTAMP_REGEX = /^(0|[1-9][0-9]*)\.([0-9]{9})$/

/** Parses a consensus timestamp / valid start (`1618591023.997420021`). */
export const parseHederaTimestamp = (value: string): HederaTimestamp => {
  const match = HEDERA_TIMESTAMP_REGEX.exec(value)
  if (!match) {
    throw new Error(
      `Invalid Hedera timestamp "${value}": expected seconds.nanoseconds with exactly 9 nanosecond digits (e.g. 1618591023.997420021)`
    )
  }
  return { seconds: BigInt(match[1]), nanos: Number(match[2]) }
}

/** Formats a timestamp in its canonical form, nanoseconds zero-padded to 9. */
export const formatHederaTimestamp = (timestamp: HederaTimestamp): string => {
  assertValidTimestamp(timestamp)
  return `${timestamp.seconds}.${String(timestamp.nanos).padStart(9, "0")}`
}

const assertValidTimestamp = (timestamp: HederaTimestamp) => {
  if (timestamp.seconds < 0n) {
    throw new Error(`Invalid Hedera timestamp: seconds may not be negative`)
  }
  if (
    !Number.isInteger(timestamp.nanos) ||
    timestamp.nanos < 0 ||
    timestamp.nanos >= NANOS_PER_SECOND
  ) {
    throw new Error(
      `Invalid Hedera timestamp: nanos must be an integer in [0, ${NANOS_PER_SECOND})`
    )
  }
}

// ====== Transaction ids ======

/**
 * A Hedera transaction id: the payer account plus the transaction's valid start
 * time, optionally flagged as scheduled and/or carrying a child-transaction
 * nonce. The payer assigns it before submission, and it is the identifier
 * explorers and the mirror node key transactions by.
 *
 * This is a distinct field from the transaction hash — see
 * `HederaTransactionReference`.
 */
export interface HederaTransactionId {
  payer: HederaEntityId
  validStart: HederaTimestamp
  scheduled: boolean
  nonce: number
}

// Native form: `payer@seconds.nanos`, with an optional `?scheduled` flag and an
// optional `/nonce` suffix, e.g. `0.0.1234@1616167056.535000000?scheduled/3`.
const HEDERA_TRANSACTION_ID_REGEX =
  /^([0-9]+\.[0-9]+\.[0-9]+(?:-[a-z]{5})?)@([0-9]+\.[0-9]{9})(\?scheduled)?(?:\/(0|[1-9][0-9]*))?$/

// Mirror node / explorer form: the same id with `@` and `.` replaced by `-`,
// e.g. `0.0.19789-1618591023-997420021`. It cannot express the scheduled flag
// or the nonce; those travel as separate query parameters.
const HEDERA_MIRROR_NODE_TRANSACTION_ID_REGEX =
  /^([0-9]+\.[0-9]+\.[0-9]+(?:-[a-z]{5})?)-([0-9]+)-([0-9]{9})$/

/**
 * Parses a transaction id in either the native `payer@seconds.nanos` form or the
 * mirror node's `payer-seconds-nanos` form. The mirror node form carries neither
 * the scheduled flag nor the nonce, so both default to their unset values.
 */
export const parseHederaTransactionId = (
  value: string,
  options: HederaEntityIdParseOptions = {}
): HederaTransactionId => {
  const native = HEDERA_TRANSACTION_ID_REGEX.exec(value)
  if (native) {
    const [, payer, validStart, scheduled, nonce] = native
    return {
      payer: parseHederaEntityId(payer, options),
      validStart: parseHederaTimestamp(validStart),
      scheduled: scheduled !== undefined,
      nonce: nonce === undefined ? 0 : parseNonce(nonce, value),
    }
  }

  const mirrorNode = HEDERA_MIRROR_NODE_TRANSACTION_ID_REGEX.exec(value)
  if (mirrorNode) {
    const [, payer, seconds, nanos] = mirrorNode
    return {
      payer: parseHederaEntityId(payer, options),
      validStart: parseHederaTimestamp(`${seconds}.${nanos}`),
      scheduled: false,
      nonce: 0,
    }
  }

  throw new Error(
    `Invalid Hedera transaction id "${value}": expected payer@seconds.nanos (e.g. 0.0.1234@1616167056.535000000) or the mirror node form payer-seconds-nanos`
  )
}

/** Formats a transaction id in the native canonical form. */
export const formatHederaTransactionId = (
  transactionId: HederaTransactionId
): string => {
  assertValidNonce(transactionId.nonce)
  const scheduled = transactionId.scheduled ? "?scheduled" : ""
  const nonce = transactionId.nonce === 0 ? "" : `/${transactionId.nonce}`
  return `${formatHederaEntityId(transactionId.payer)}@${formatHederaTimestamp(
    transactionId.validStart
  )}${scheduled}${nonce}`
}

// Hedera declares `TransactionID.nonce` as a protobuf `int32`, so anything
// above the signed 32-bit maximum is not a nonce the network can represent.
const HEDERA_MAX_NONCE = 2147483647

const assertValidNonce = (nonce: number) => {
  if (!Number.isInteger(nonce) || nonce < 0 || nonce > HEDERA_MAX_NONCE) {
    throw new Error(
      `Invalid Hedera transaction id: nonce must be an integer in [0, ${HEDERA_MAX_NONCE}]`
    )
  }
}

const parseNonce = (nonce: string, transactionId: string): number => {
  const parsed = Number(nonce)
  if (!Number.isInteger(parsed) || parsed > HEDERA_MAX_NONCE) {
    throw new Error(
      `Invalid Hedera transaction id "${transactionId}": nonce ${nonce} exceeds the int32 maximum ${HEDERA_MAX_NONCE}`
    )
  }
  return parsed
}

/**
 * Renders a transaction id the way the mirror node addresses it: the dashed id
 * plus the scheduled flag and nonce, which the dashed string cannot carry and
 * which must be sent as separate query parameters. Returning all three keeps the
 * conversion lossless — two transaction ids differing only by nonce share a
 * dashed string.
 */
export const toHederaMirrorNodeTransactionId = (
  transactionId: HederaTransactionId
): { transactionId: string; scheduled: boolean; nonce: number } => {
  assertValidNonce(transactionId.nonce)
  const { seconds, nanos } = transactionId.validStart
  assertValidTimestamp(transactionId.validStart)
  return {
    transactionId: `${formatHederaEntityId(
      transactionId.payer
    )}-${seconds}-${String(nanos).padStart(9, "0")}`,
    scheduled: transactionId.scheduled,
    nonce: transactionId.nonce,
  }
}

// ====== Transaction hashes ======

// Hedera transaction hashes are the SHA-384 digest of the signed transaction
// bytes, so 48 bytes rather than the 32 of an EVM transaction hash.
export const HEDERA_TRANSACTION_HASH_BYTE_LENGTH = 48

const HEDERA_TRANSACTION_HASH_HEX_REGEX = /^(?:0x)?([0-9a-fA-F]{96})$/
// Mirror node's `/api/v1/transactions` reports the hash base64-encoded; other
// endpoints report hex. 48 bytes is 96 hex digits or exactly 64 unpadded base64
// characters, so the two forms can never be confused for one another.
const HEDERA_TRANSACTION_HASH_BASE64_REGEX = /^[A-Za-z0-9+/]{64}$/

/**
 * Normalizes a transaction hash to lowercase `0x`-prefixed hex. Accepts the hex
 * form (with or without the prefix) and the base64 form the mirror node returns.
 */
export const parseHederaTransactionHash = (value: string): Hex => {
  const hex = HEDERA_TRANSACTION_HASH_HEX_REGEX.exec(value)
  if (hex) {
    return `0x${hex[1].toLowerCase()}`
  }

  if (HEDERA_TRANSACTION_HASH_BASE64_REGEX.test(value)) {
    const bytes = Buffer.from(value, "base64")
    if (bytes.length === HEDERA_TRANSACTION_HASH_BYTE_LENGTH) {
      return bytesToHex(bytes)
    }
  }

  throw new Error(
    `Invalid Hedera transaction hash "${value}": expected ${HEDERA_TRANSACTION_HASH_BYTE_LENGTH} bytes (SHA-384) as hex or base64`
  )
}

// ====== Transaction references ======

/**
 * The transaction fields the settlement stack records for a Hedera transaction.
 *
 * The transaction id and the transaction hash are kept as separate fields
 * because they are not interchangeable:
 *
 * - `transactionId` is assigned by the payer (payer account + valid start) and
 *   is stable across the network. It is the public identifier: the mirror node
 *   and explorers key transactions by it, so it is the value to expose in APIs
 *   and to log alongside solver, oracle and allocator activity.
 * - `transactionHash` is the SHA-384 digest of the signed transaction bytes.
 *   Those bytes include the node account the transaction was submitted to, so
 *   the same logical transaction submitted to two nodes has two different
 *   hashes. Treat it as submission evidence, not as an identity.
 * - `consensusTimestamp` is assigned by the network at consensus and is
 *   therefore only known after the transaction succeeds — unlike the valid
 *   start embedded in the transaction id, which the payer chooses up front.
 */
export interface HederaTransactionReference {
  transactionId: string
  transactionHash?: string
  consensusTimestamp?: string
}

/**
 * Validates and canonicalizes a transaction reference so every consumer —
 * solver, oracle, allocator, explorer — stores the same spelling of the same
 * transaction. Accepts either transaction id form and either hash encoding, and
 * always emits the native transaction id and lowercase `0x` hash.
 */
export const normalizeHederaTransactionReference = (
  reference: HederaTransactionReference,
  options: HederaEntityIdParseOptions = {}
): HederaTransactionReference => ({
  transactionId: formatHederaTransactionId(
    parseHederaTransactionId(reference.transactionId, options)
  ),
  ...(reference.transactionHash !== undefined
    ? { transactionHash: parseHederaTransactionHash(reference.transactionHash) }
    : {}),
  ...(reference.consensusTimestamp !== undefined
    ? {
        consensusTimestamp: formatHederaTimestamp(
          parseHederaTimestamp(reference.consensusTimestamp)
        ),
      }
    : {}),
})
