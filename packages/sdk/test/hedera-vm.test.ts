// ABOUTME: Round-trip and invalid-input tests for the Hedera identity codecs in
// ABOUTME: src/hedera-vm.ts, plus the hedera-vm cases in src/utils.ts.

import { describe, expect, test } from "vitest"

import {
  decodeHederaAddress,
  encodeHederaAddress,
  evmAddressToHederaEntityId,
  formatHederaEntityId,
  formatHederaEntityIdWithChecksum,
  formatHederaTimestamp,
  formatHederaTransactionId,
  getHederaEntityIdChecksum,
  HEDERA_HBAR_TOKEN_ID,
  HEDERA_MAINNET_USDC_TOKEN_ID,
  HEDERA_TRANSACTION_HASH_BYTE_LENGTH,
  HederaNetwork,
  hederaEntityIdToEvmAddress,
  normalizeHederaTransactionReference,
  parseHederaAddress,
  parseHederaEntityId,
  parseHederaTimestamp,
  parseHederaTransactionHash,
  parseHederaTransactionId,
  toHederaMirrorNodeTransactionId,
} from "../src/hedera-vm"
import {
  decodeAddress,
  encodeAddress,
  getVmTypeNativeCurrency,
} from "../src/utils"

// Pinned vectors generated from the Hedera JavaScript SDK v2.81.0
// (`EntityIdHelper._checksum(LedgerId.<NETWORK>.toBytes(), id)`), which is the
// reference implementation of the HIP-15 checksum.
const CHECKSUM_VECTORS: {
  id: string
  mainnet: string
  testnet: string
  previewnet: string
  "local-node": string
}[] = [
  {
    id: "0.0.0",
    mainnet: "uvnqa",
    testnet: "eiyxj",
    previewnet: "nwkes",
    "local-node": "xjvmb",
  },
  {
    id: "0.0.2",
    mainnet: "lpifi",
    testnet: "vctmr",
    previewnet: "eqeua",
    "local-node": "odqbj",
  },
  {
    id: "0.0.123",
    mainnet: "vfmkw",
    testnet: "esxsf",
    previewnet: "ogizo",
    "local-node": "xtugx",
  },
  {
    id: "0.0.456858",
    mainnet: "ojdqc",
    testnet: "xwoxl",
    previewnet: "hkaeu",
    "local-node": "qxlmd",
  },
  {
    id: "0.0.3991",
    mainnet: "fobyk",
    testnet: "pbnft",
    previewnet: "yoync",
    "local-node": "icjul",
  },
  {
    id: "1.2.3",
    mainnet: "islfi",
    testnet: "sfwmr",
    previewnet: "bthua",
    "local-node": "lgtbj",
  },
  {
    id: "0.0.9223372036854775807",
    mainnet: "eaglu",
    testnet: "nnrtd",
    previewnet: "xbdam",
    "local-node": "goohv",
  },
]

const NETWORKS: HederaNetwork[] = [
  "mainnet",
  "testnet",
  "previewnet",
  "local-node",
]

// Native mainnet USDC. The long-zero address is the value published for the
// token; deriving it from the token id is the check that the conversion is right.
const USDC_EVM_ADDRESS = "0x000000000000000000000000000000000006f89a"

describe("hedera-vm entity ids", () => {
  test.each([
    "0.0.0",
    "0.0.2",
    "0.0.456858",
    "1.2.3",
    "0.0.9223372036854775807",
  ])("round-trips %s", (id) => {
    expect(formatHederaEntityId(parseHederaEntityId(id))).toBe(id)
  })

  test("parses the components", () => {
    expect(parseHederaEntityId("1.2.456858")).toEqual({
      shard: 1n,
      realm: 2n,
      num: 456858n,
    })
  })

  test.each([
    ["456858", "abbreviated to the entity num"],
    ["0.456858", "abbreviated to realm.num"],
    ["0.0.0456858", "leading zeros in num"],
    ["00.0.456858", "leading zeros in shard"],
    ["0.0.456858.1", "four components"],
    ["0.0.-1", "negative num"],
    ["0.0.+1", "signed num"],
    [" 0.0.456858", "leading whitespace"],
    ["0.0.456858 ", "trailing whitespace"],
    ["0.0.", "missing num"],
    ["0.0.abc", "non-numeric num"],
    ["0.0.456858-OJDQC", "uppercase checksum"],
    ["0.0.456858-ojdq", "short checksum"],
    ["0.0.9223372036854775808", "num above the int64 maximum"],
  ])("rejects %s (%s)", (id) => {
    expect(() => parseHederaEntityId(id)).toThrow()
  })
})

describe("hedera-vm entity id checksums", () => {
  test.each(CHECKSUM_VECTORS)(
    "matches the reference vectors for $id",
    (row) => {
      const entityId = parseHederaEntityId(row.id)
      for (const network of NETWORKS) {
        expect(getHederaEntityIdChecksum(entityId, network)).toBe(row[network])
        expect(formatHederaEntityIdWithChecksum(entityId, network)).toBe(
          `${row.id}-${row[network]}`
        )
      }
    }
  )

  test("accepts a checksum that matches the requested network", () => {
    expect(
      parseHederaEntityId("0.0.456858-ojdqc", { network: "mainnet" })
    ).toEqual({ shard: 0n, realm: 0n, num: 456858n })
  })

  test("rejects a checksum from another network", () => {
    // `ojdqc` is the mainnet checksum for 0.0.456858; on testnet it is `xwoxl`.
    for (const network of ["testnet", "previewnet", "local-node"] as const) {
      expect(() =>
        parseHederaEntityId("0.0.456858-ojdqc", { network })
      ).toThrow(/different network/i)
    }
  })

  test("rejects a corrupted checksum on the right network", () => {
    expect(() =>
      parseHederaEntityId("0.0.456858-ojdqd", { network: "mainnet" })
    ).toThrow(/different network/i)
  })

  test("rejects a checksum when no network is supplied to validate it", () => {
    expect(() => parseHederaEntityId("0.0.456858-ojdqc")).toThrow(
      /no network was supplied/i
    )
  })

  test("rejects an unknown network", () => {
    expect(() =>
      getHederaEntityIdChecksum(
        parseHederaEntityId("0.0.123"),
        "mainnet2" as unknown as HederaNetwork
      )
    ).toThrow(/unknown hedera network/i)
  })
})

describe("hedera-vm long-zero EVM addresses", () => {
  test("converts the mainnet USDC token id to its published EVM address", () => {
    expect(hederaEntityIdToEvmAddress(HEDERA_MAINNET_USDC_TOKEN_ID)).toBe(
      USDC_EVM_ADDRESS
    )
    expect(
      formatHederaEntityId(evmAddressToHederaEntityId(USDC_EVM_ADDRESS))
    ).toBe(HEDERA_MAINNET_USDC_TOKEN_ID)
  })

  test.each([
    ["0.0.0", "0x0000000000000000000000000000000000000000"],
    ["0.0.123", "0x000000000000000000000000000000000000007b"],
    ["0.0.456858", USDC_EVM_ADDRESS],
    // The full 8-byte num field: the Hedera JavaScript SDK's `toSolidityAddress`
    // truncates this to 32 bits, its `fromSolidityAddress` does not.
    ["0.0.9223372036854775807", "0x0000000000000000000000007fffffffffffffff"],
  ])("round-trips %s <-> %s", (id, address) => {
    expect(hederaEntityIdToEvmAddress(id)).toBe(address)
    expect(formatHederaEntityId(evmAddressToHederaEntityId(address))).toBe(id)
  })

  test("accepts EVM addresses without the 0x prefix and in mixed case", () => {
    expect(
      formatHederaEntityId(
        evmAddressToHederaEntityId(USDC_EVM_ADDRESS.slice(2).toUpperCase())
      )
    ).toBe(HEDERA_MAINNET_USDC_TOKEN_ID)
  })

  test("rejects entity ids outside shard 0 / realm 0", () => {
    expect(() => hederaEntityIdToEvmAddress("1.0.5")).toThrow(/long-zero/i)
    expect(() => hederaEntityIdToEvmAddress("0.1.5")).toThrow(/long-zero/i)
  })

  // Hedera declares entity numbers as `int64`, so the top bit of the long-zero
  // layout's 8-byte field is never legitimately set; a larger value would
  // serialize to a varint the network reads back as negative.
  test("rejects a long-zero address above the int64 maximum", () => {
    expect(() =>
      evmAddressToHederaEntityId("0x0000000000000000000000008000000000000000")
    ).toThrow(/int64 maximum/i)
    expect(() =>
      parseHederaAddress("0x000000000000000000000000ffffffffffffffff")
    ).toThrow(/int64 maximum/i)
  })

  test("accepts a long-zero address at the int64 maximum", () => {
    expect(
      formatHederaEntityId(
        evmAddressToHederaEntityId("0x0000000000000000000000007fffffffffffffff")
      )
    ).toBe("0.0.9223372036854775807")
  })

  test("rejects an EVM alias, which carries no entity id", () => {
    expect(() =>
      evmAddressToHederaEntityId("0x5e7b112523f68d2f5e879db4eac51c6698a69304")
    ).toThrow(/not a long-zero address/i)
  })

  test.each([
    "0x000000000000000000000000000000000006f89",
    "0x000000000000000000000000000000000006f89a1",
    "0xzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz06f89a",
    "",
  ])("rejects malformed EVM address %s", (address) => {
    expect(() => evmAddressToHederaEntityId(address)).toThrow()
  })
})

describe("hedera-vm addresses", () => {
  test("parses a canonical entity id", () => {
    expect(parseHederaAddress("0.0.456858")).toEqual({
      kind: "entity-id",
      entityId: { shard: 0n, realm: 0n, num: 456858n },
    })
  })

  test("normalizes a long-zero address to the entity id it encodes", () => {
    expect(parseHederaAddress(USDC_EVM_ADDRESS)).toEqual({
      kind: "entity-id",
      entityId: { shard: 0n, realm: 0n, num: 456858n },
    })
  })

  test("parses an account EVM alias", () => {
    const alias = "0x5e7b112523f68d2f5e879db4eac51c6698a69304"
    expect(parseHederaAddress(alias.toUpperCase().replace("0X", "0x"))).toEqual(
      {
        kind: "evm-alias",
        address: alias,
      }
    )
  })

  test("parses the mirror node shard.realm.<evm address> form", () => {
    expect(parseHederaAddress(`0.0.${USDC_EVM_ADDRESS.slice(2)}`)).toEqual({
      kind: "entity-id",
      entityId: { shard: 0n, realm: 0n, num: 456858n },
    })
  })

  test("rejects the shard.realm.<evm address> form outside shard 0 / realm 0", () => {
    expect(() =>
      parseHederaAddress(`1.2.${USDC_EVM_ADDRESS.slice(2)}`)
    ).toThrow(/shard 0 \/ realm 0/i)
  })

  test("rejects a base32 public-key alias", () => {
    // The alias form the mirror node reports for ED25519 / ECDSA accounts; it is
    // 32+ bytes and has to be resolved to an account id first.
    expect(() =>
      parseHederaAddress(
        "HIQQEXWKW53RKN4W6XXC4Q232SYNZ3SZANVZZSUME5B5PRGXL663UAQA"
      )
    ).toThrow()
  })
})

describe("hedera-vm address slot encoding", () => {
  test.each([
    HEDERA_HBAR_TOKEN_ID,
    "0.0.123",
    HEDERA_MAINNET_USDC_TOKEN_ID,
    "0.0.9223372036854775807",
    "0x5e7b112523f68d2f5e879db4eac51c6698a69304",
  ])("round-trips %s through encode/decode", (address) => {
    const bytes = encodeHederaAddress(address)
    expect(bytes).toHaveLength(20)
    expect(decodeHederaAddress(bytes)).toBe(address)
  })

  test("an entity id and its long-zero address encode identically", () => {
    expect(encodeHederaAddress(HEDERA_MAINNET_USDC_TOKEN_ID)).toEqual(
      encodeHederaAddress(USDC_EVM_ADDRESS)
    )
    // Decoding always yields the entity id; the long-zero spelling is dropped.
    expect(decodeHederaAddress(encodeHederaAddress(USDC_EVM_ADDRESS))).toBe(
      HEDERA_MAINNET_USDC_TOKEN_ID
    )
  })

  test("rejects checksummed input, which cannot be validated without a network", () => {
    expect(() => encodeHederaAddress("0.0.456858-ojdqc")).toThrow(
      /no network was supplied/i
    )
  })

  test("decode rejects the wrong byte length", () => {
    expect(() => decodeHederaAddress(new Uint8Array(19))).toThrow(/length/i)
    expect(() => decodeHederaAddress(new Uint8Array(21))).toThrow(/length/i)
  })
})

describe("hedera-vm encodeAddress / decodeAddress", () => {
  test.each([
    HEDERA_HBAR_TOKEN_ID,
    HEDERA_MAINNET_USDC_TOKEN_ID,
    "0x5e7b112523f68d2f5e879db4eac51c6698a69304",
  ])("round-trips %s through the VM dispatcher", (address) => {
    const bytes = encodeAddress(address, "hedera-vm")
    expect(bytes).toHaveLength(20)
    expect(decodeAddress(bytes, "hedera-vm")).toBe(address)
  })

  test("native currency is the zero entity id and encodes to 20 zero bytes", () => {
    const native = getVmTypeNativeCurrency("hedera-vm")
    expect(native).toBe(HEDERA_HBAR_TOKEN_ID)
    expect(
      Buffer.from(encodeAddress(native, "hedera-vm")).toString("hex")
    ).toBe("0".repeat(40))
  })
})

describe("hedera-vm consensus timestamps", () => {
  test.each(["0.000000000", "1618591023.997420021", "1616167056.000000005"])(
    "round-trips %s",
    (timestamp) => {
      expect(formatHederaTimestamp(parseHederaTimestamp(timestamp))).toBe(
        timestamp
      )
    }
  )

  test("parses the components", () => {
    expect(parseHederaTimestamp("1618591023.997420021")).toEqual({
      seconds: 1618591023n,
      nanos: 997420021,
    })
  })

  test.each([
    ["1618591023", "no nanosecond part"],
    // `.5` is 5 nanoseconds to Hedera but reads as half a second; requiring the
    // padded form removes the ambiguity instead of guessing.
    ["1618591023.5", "unpadded nanoseconds"],
    ["1618591023.99742002", "8 nanosecond digits"],
    ["1618591023.9974200211", "10 nanosecond digits"],
    ["01618591023.997420021", "leading zeros in seconds"],
    ["-1618591023.997420021", "negative seconds"],
    ["1618591023.997420021 ", "trailing whitespace"],
  ])("rejects %s (%s)", (timestamp) => {
    expect(() => parseHederaTimestamp(timestamp)).toThrow()
  })

  test("format rejects out-of-range values", () => {
    expect(() => formatHederaTimestamp({ seconds: -1n, nanos: 0 })).toThrow(
      /negative/i
    )
    expect(() =>
      formatHederaTimestamp({ seconds: 1n, nanos: 1_000_000_000 })
    ).toThrow(/nanos/i)
    expect(() => formatHederaTimestamp({ seconds: 1n, nanos: -1 })).toThrow(
      /nanos/i
    )
    expect(() => formatHederaTimestamp({ seconds: 1n, nanos: 1.5 })).toThrow(
      /nanos/i
    )
  })
})

describe("hedera-vm transaction ids", () => {
  test.each([
    "0.0.1234@1616167056.535000000",
    "0.0.9@1616167056.000000001?scheduled",
    "0.0.9@1616167056.000000001/3",
    "0.0.9@1616167056.000000001?scheduled/3",
  ])("round-trips the native form %s", (transactionId) => {
    expect(
      formatHederaTransactionId(parseHederaTransactionId(transactionId))
    ).toBe(transactionId)
  })

  test("parses the components", () => {
    expect(
      parseHederaTransactionId("0.0.9@1616167056.000000001?scheduled/3")
    ).toEqual({
      payer: { shard: 0n, realm: 0n, num: 9n },
      validStart: { seconds: 1616167056n, nanos: 1 },
      scheduled: true,
      nonce: 3,
    })
  })

  test("parses the mirror node dashed form", () => {
    expect(parseHederaTransactionId("0.0.19789-1618591023-997420021")).toEqual({
      payer: { shard: 0n, realm: 0n, num: 19789n },
      validStart: { seconds: 1618591023n, nanos: 997420021 },
      scheduled: false,
      nonce: 0,
    })
  })

  test("converts both forms to the same native identifier", () => {
    expect(
      formatHederaTransactionId(
        parseHederaTransactionId("0.0.19789-1618591023-997420021")
      )
    ).toBe("0.0.19789@1618591023.997420021")
  })

  test("renders the mirror node form with scheduled and nonce alongside it", () => {
    // The dashed string cannot carry either flag, so they are returned as the
    // separate values the mirror node expects as query parameters.
    expect(
      toHederaMirrorNodeTransactionId(
        parseHederaTransactionId("0.0.9@1616167056.000000001?scheduled/3")
      )
    ).toEqual({
      transactionId: "0.0.9-1616167056-000000001",
      scheduled: true,
      nonce: 3,
    })
  })

  test.each([
    ["0.0.1234@1616167056", "no nanoseconds"],
    ["0.0.1234@1616167056.5", "unpadded nanoseconds"],
    ["0.0.1234-1616167056-5", "unpadded nanoseconds in the mirror node form"],
    ["0.0.1234", "no valid start"],
    ["1616167056.535000000", "no payer"],
    ["0.0.1234@1616167056.535000000?scheduled?scheduled", "repeated flag"],
    ["0.0.1234@1616167056.535000000/", "empty nonce"],
    ["0.0.1234@1616167056.535000000/03", "leading zeros in nonce"],
    ["0.0.1234@1616167056.535000000/-1", "negative nonce"],
    ["0.0.01234@1616167056.535000000", "noncanonical payer"],
    ["0.0.1234@1616167056.535000000 ", "trailing whitespace"],
  ])("rejects %s (%s)", (transactionId) => {
    expect(() => parseHederaTransactionId(transactionId)).toThrow()
  })

  test("validates a checksummed payer against the network", () => {
    expect(
      formatHederaTransactionId(
        parseHederaTransactionId("0.0.123-vfmkw@1616167056.535000000", {
          network: "mainnet",
        })
      )
    ).toBe("0.0.123@1616167056.535000000")
    expect(() =>
      parseHederaTransactionId("0.0.123-vfmkw@1616167056.535000000", {
        network: "testnet",
      })
    ).toThrow(/different network/i)
  })

  test("format rejects an invalid nonce", () => {
    const transactionId = parseHederaTransactionId("0.0.9@1616167056.000000001")
    expect(() =>
      formatHederaTransactionId({ ...transactionId, nonce: -1 })
    ).toThrow(/nonce/i)
    expect(() =>
      formatHederaTransactionId({ ...transactionId, nonce: 1.5 })
    ).toThrow(/nonce/i)
    // `TransactionID.nonce` is an int32 in the Hedera protobufs.
    expect(() =>
      formatHederaTransactionId({ ...transactionId, nonce: 2147483648 })
    ).toThrow(/nonce/i)
  })

  test("round-trips a nonce at the int32 maximum", () => {
    const transactionId = "0.0.9@1616167056.000000001/2147483647"
    expect(
      formatHederaTransactionId(parseHederaTransactionId(transactionId))
    ).toBe(transactionId)
  })

  test("rejects a nonce above the int32 maximum", () => {
    expect(() =>
      parseHederaTransactionId("0.0.9@1616167056.000000001/2147483648")
    ).toThrow(/int32 maximum/i)
  })
})

describe("hedera-vm transaction hashes", () => {
  // The hex/base64 pair the Hedera mirror node reports for the same 48-byte
  // SHA-384 transaction hash.
  const HASH_HEX =
    "be283329ed89edfbf892d1c16cd4d2cd098aabb2f376ad7f9493261d3f9ad8a82f76102e69d96f4b878a7aa2a3211996"
  const HASH_BASE64 =
    "vigzKe2J7fv4ktHBbNTSzQmKq7Lzdq1/lJMmHT+a2KgvdhAuadlvS4eKeqKjIRmW"

  test("is 48 bytes, not the 32 of an EVM hash", () => {
    expect(HEDERA_TRANSACTION_HASH_BYTE_LENGTH).toBe(48)
    expect(parseHederaTransactionHash(HASH_HEX)).toHaveLength(2 + 96)
  })

  test.each([
    HASH_HEX,
    `0x${HASH_HEX}`,
    `0x${HASH_HEX.toUpperCase()}`,
    HASH_HEX.toUpperCase(),
  ])("normalizes the hex form %s", (hash) => {
    expect(parseHederaTransactionHash(hash)).toBe(`0x${HASH_HEX}`)
  })

  test("decodes the base64 form the mirror node returns", () => {
    expect(parseHederaTransactionHash(HASH_BASE64)).toBe(`0x${HASH_HEX}`)
  })

  test.each([
    ["", "empty"],
    [HASH_HEX.slice(0, 94), "too short"],
    [`${HASH_HEX}00`, "too long"],
    [
      "0x397022d1e5baeb89d0ab66e6bf602640610e6fb7e55d78638db861e2c6339aa9",
      "a 32-byte EVM hash",
    ],
    [HASH_BASE64.slice(0, 60), "truncated base64"],
    [HASH_HEX.replace("be", "zz"), "non-hex characters"],
  ])("rejects %s (%s)", (hash) => {
    expect(() => parseHederaTransactionHash(hash)).toThrow()
  })
})

describe("hedera-vm transaction references", () => {
  test("keeps the transaction id and hash as separate fields", () => {
    expect(
      normalizeHederaTransactionReference({
        transactionId: "0.0.19789-1618591023-997420021",
        transactionHash:
          "vigzKe2J7fv4ktHBbNTSzQmKq7Lzdq1/lJMmHT+a2KgvdhAuadlvS4eKeqKjIRmW",
        consensusTimestamp: "1618591024.000000001",
      })
    ).toEqual({
      transactionId: "0.0.19789@1618591023.997420021",
      transactionHash:
        "0xbe283329ed89edfbf892d1c16cd4d2cd098aabb2f376ad7f9493261d3f9ad8a82f76102e69d96f4b878a7aa2a3211996",
      consensusTimestamp: "1618591024.000000001",
    })
  })

  test("omits the optional fields when they are absent", () => {
    expect(
      normalizeHederaTransactionReference({
        transactionId: "0.0.19789@1618591023.997420021",
      })
    ).toEqual({ transactionId: "0.0.19789@1618591023.997420021" })
  })

  test("rejects a reference whose hash is an EVM transaction hash", () => {
    expect(() =>
      normalizeHederaTransactionReference({
        transactionId: "0.0.19789@1618591023.997420021",
        transactionHash:
          "0x397022d1e5baeb89d0ab66e6bf602640610e6fb7e55d78638db861e2c6339aa9",
      })
    ).toThrow(/transaction hash/i)
  })
})
