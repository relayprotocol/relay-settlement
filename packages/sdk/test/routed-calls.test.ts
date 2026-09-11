// ABOUTME: Routed Call / RoutedWithdrawalData codec tests: roundtrips, guard rails,
// ABOUTME: and EIP-712 digest consistency for committed CallRequests.

import {
  Address,
  concat,
  encodeAbiParameters,
  encodeFunctionData,
  hashDomain,
  hashTypedData,
  Hex,
  keccak256,
  parseAbiParameters,
} from "viem"
import { describe, it, expect } from "vitest"

import {
  decodeRoutedWithdrawalData,
  encodeRoutedWithdrawalData,
  hashRoutedCalls,
  multicallRouterAbi,
  routedWithdrawalDataAbiParams,
  RoutedCall,
} from "../src/messages/common/ethereum-vm/routed"
import { toExecutableCallRequest } from "../src/messages/v2.1/withdrawals/ethereum-vm"
import {
  decodeWithdrawal,
  encodeWithdrawal,
  getDecodedWithdrawalId,
  DecodedEthereumVmWithdrawal,
} from "../src/messages/v2.1/depository-withdrawal"
import { getWithdrawalCodec } from "../src/messages/v2.1/withdrawals"

const codec = getWithdrawalCodec("ethereum-vm")

// Solver swap call + settlement call + user-intent suffix
const calls: RoutedCall[] = [
  {
    to: "0x1111111111111111111111111111111111111111",
    data: "0xdeadbeef0000000000000000000000000000000000000000000000000000000000000001",
    value: "123456789",
    allowFailure: true,
  },
  {
    to: "0x2222222222222222222222222222222222222222",
    data: "0xc0fe563200000000000000000000000000000000000000000000000000000000004c4b40",
    value: "0",
    allowFailure: false,
  },
  {
    to: "0x3333333333333333333333333333333333333333",
    data: "0x",
    value: "1000000000000000000",
    allowFailure: false,
  },
]

const ROUTER = "0x4444444444444444444444444444444444444444"
const ZERO_HASH =
  "0x0000000000000000000000000000000000000000000000000000000000000000"

const multicallData = encodeFunctionData({
  abi: multicallRouterAbi,
  functionName: "multicall",
  args: [
    calls.map((call) => ({
      to: call.to as Address,
      data: call.data as Hex,
      value: BigInt(call.value),
      allowFailure: call.allowFailure,
    })),
  ],
})

describe("routed calls commitment", () => {
  it("matches the Solidity abi.encodeCall fingerprint", () => {
    // Keep in sync with RoutedCallEncoding.t.sol (same fixture,
    // keccak256(abi.encodeCall(IMulticallRouter.multicall, (calls))))
    expect(hashRoutedCalls(calls)).toBe(
      "0xef4da15da66cc4e722d177a40f2c6fdafe93a4803f68cd6e6bac6b80d6c0ae17"
    )
  })
})

describe("routed withdrawal data codec", () => {
  const routed = {
    version: 1,
    router: ROUTER,
    dataHash: hashRoutedCalls(calls),
  }

  it("roundtrips encode/decode", () => {
    expect(
      decodeRoutedWithdrawalData(encodeRoutedWithdrawalData(routed))
    ).toEqual(routed)
  })

  it("matches the Solidity abi.encode fingerprint", () => {
    // Keep in sync with RoutedCallEncoding.t.sol (same fixture, keccak256(abi.encode(routed)))
    expect(keccak256(encodeRoutedWithdrawalData(routed) as Hex)).toBe(
      "0x0327bd943b2b64a89574a7661f64a5b71105d69f5bb57dfd44b0d58d390327a2"
    )
  })

  it("rejects a zero calls hash", () => {
    expect(() =>
      encodeRoutedWithdrawalData({ ...routed, dataHash: ZERO_HASH })
    ).toThrow("Routed withdrawal data requires a non-zero data hash")

    // Same check on the decode path (externally constructed payloads)
    const zeroHashData = encodeAbiParameters(routedWithdrawalDataAbiParams, [
      {
        version: 1,
        router: ROUTER as Address,
        dataHash: ZERO_HASH as Hex,
      },
    ])
    expect(() => decodeRoutedWithdrawalData(zeroHashData)).toThrow(
      "Routed withdrawal data requires a non-zero data hash"
    )
  })

  it("rejects unsupported versions", () => {
    expect(() => encodeRoutedWithdrawalData({ ...routed, version: 2 })).toThrow(
      "Unsupported routed withdrawal data version"
    )

    // The inline-calls layout published as 0.0.131: its leading offset word reads
    // as the version, so it fails closed rather than mis-decoding
    const inlineCallsData = encodeAbiParameters(
      parseAbiParameters([
        "(uint8 version, address router, (address to, bytes data, uint256 value, bool allowFailure)[] calls)",
      ]),
      [
        {
          version: 1,
          router: ROUTER as Address,
          calls: calls.map((call) => ({
            to: call.to as Address,
            data: call.data as Hex,
            value: BigInt(call.value),
            allowFailure: call.allowFailure,
          })),
        },
      ]
    )
    expect(() => decodeRoutedWithdrawalData(inlineCallsData)).toThrow(
      "Unsupported routed withdrawal data version"
    )
  })

  it("rejects an empty bundle at the commitment", () => {
    expect(() => hashRoutedCalls([])).toThrow(
      "Routed withdrawal data requires at least one call"
    )
  })
})

describe("committed CallRequest", () => {
  const transferCall = {
    to: "0x6666666666666666666666666666666666666666",
    data: "0xa9059cbb00000000000000000000000044444444444444444444444444444444444444440000000000000000000000000000000000000000000000487a9a304539440000",
    dataHash: ZERO_HASH,
    value: "0",
    allowFailure: false,
  }

  const decoded: DecodedEthereumVmWithdrawal = {
    vmType: "ethereum-vm",
    withdrawal: {
      calls: [
        transferCall,
        {
          to: ROUTER,
          data: "0x",
          dataHash: hashRoutedCalls(calls),
          value: "0",
          allowFailure: false,
        },
      ],
      nonce: BigInt(
        "0x9400f1b21cb527d7fa3d3eabba93557a18ebe7a2ca4e471cfe5e4c5b4ca7f767"
      ).toString(),
      expiration: 1774878936,
    },
  }

  const domain = {
    name: "RelayDepository",
    version: "1",
    chainId: 8453,
    verifyingContract: "0x5555555555555555555555555555555555555555" as Address,
  }

  const domainDigest = (structHash: string) =>
    keccak256(
      concat([
        "0x1901",
        hashDomain({
          domain,
          types: {
            EIP712Domain: [
              { name: "name", type: "string" },
              { name: "version", type: "string" },
              { name: "chainId", type: "uint256" },
              { name: "verifyingContract", type: "address" },
            ],
          },
        }),
        structHash as Hex,
      ])
    )

  it("roundtrips encode/decode", () => {
    expect(decodeWithdrawal(encodeWithdrawal(decoded), "ethereum-vm")).toEqual(
      decoded
    )
  })

  it("withdrawal id recomposes to the EIP-712 digest", () => {
    // The withdrawal id is the CallRequest struct hash; wrapping it with the
    // RelayDepository domain must equal the full typed-data digest
    const digest = domainDigest(getDecodedWithdrawalId(decoded))

    // Keep in sync with RoutedCallEncoding.t.sol (same fixture, hashCallRequest output)
    expect(digest).toBe(
      "0xcc7e1d7b168a0ac06417315f32576a393e96e064c5d528799d113c9f31106eb8"
    )
  })

  it("hashes a committed call exactly like the executable one", () => {
    // The executor supplies the calldata without changing the signed digest
    const executable = toExecutableCallRequest(
      decoded.withdrawal,
      multicallData
    )

    expect(domainDigest(getDecodedWithdrawalId(decoded))).toBe(
      hashTypedData({
        domain,
        types: {
          CallRequest: [
            { name: "calls", type: "Call[]" },
            { name: "nonce", type: "uint256" },
            { name: "expiration", type: "uint256" },
          ],
          Call: [
            { name: "to", type: "address" },
            { name: "data", type: "bytes" },
            { name: "value", type: "uint256" },
            { name: "allowFailure", type: "bool" },
          ],
        },
        primaryType: "CallRequest",
        message: {
          calls: executable.calls.map((call) => ({
            to: call.to as Hex,
            data: call.data as Hex,
            value: BigInt(call.value),
            allowFailure: call.allowFailure,
          })),
          nonce: BigInt(executable.nonce),
          expiration: BigInt(executable.expiration),
        },
      })
    )
  })

  it("rejects calldata that does not match the commitment", () => {
    expect(() =>
      toExecutableCallRequest(decoded.withdrawal, "0xdeadbeef")
    ).toThrow("Calldata does not match the call commitment")
  })

  it("strips the commitment column from a non-routed request", () => {
    const nonRouted = { ...decoded.withdrawal, calls: [transferCall] }

    expect(toExecutableCallRequest(nonRouted)).toEqual({
      calls: [
        {
          to: transferCall.to,
          data: transferCall.data,
          value: transferCall.value,
          allowFailure: transferCall.allowFailure,
        },
      ],
      nonce: nonRouted.nonce,
      expiration: nonRouted.expiration,
    })

    expect(() => toExecutableCallRequest(nonRouted, multicallData)).toThrow(
      "Calldata supplied for a request with no committed call"
    )
  })

  it("rejects a routed request submitted without its preimage", () => {
    expect(() => toExecutableCallRequest(decoded.withdrawal)).toThrow(
      "Missing calldata for the committed call"
    )
  })

  it("matches the Solidity abi.encode of the same CallRequest", () => {
    // Produced by EthereumVmPayloadBuilder's struct via forge, same fixture.
    // Keep in sync with RoutedCallEncoding.t.sol.
    const solidityEncoded =
      "0x000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000609400f1b21cb527d7fa3d3eabba93557a18ebe7a2ca4e471cfe5e4c5b4ca7f7670000000000000000000000000000000000000000000000000000000069ca80d8000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000160000000000000000000000000666666666666666666666666666666666666666600000000000000000000000000000000000000000000000000000000000000a00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000044a9059cbb00000000000000000000000044444444444444444444444444444444444444440000000000000000000000000000000000000000000000487a9a30453944000000000000000000000000000000000000000000000000000000000000000000000000000000000000444444444444444444444444444444444444444400000000000000000000000000000000000000000000000000000000000000a0ef4da15da66cc4e722d177a40f2c6fdafe93a4803f68cd6e6bac6b80d6c0ae17000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"

    expect(encodeWithdrawal(decoded)).toBe(solidityEncoded)
    expect(decodeWithdrawal(solidityEncoded, "ethereum-vm")).toEqual(decoded)
  })

  it("still decodes a payload without the commitment column", () => {
    // `allocator.payloads` is write-once, so rejecting the 4-member shape would leave
    // those withdrawals unreadable forever
    const legacyNative =
      "0x000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000006774600000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000020000000000000000000000000987654321098765432109876543210987654321000000000000000000000000000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000de0b6b3a764000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
    const legacyErc20 =
      "0x00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000677460000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000002000000000000000000000000012345678901234567890123456789012345678900000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000044a9059cbb000000000000000000000000987654321098765432109876543210987654321000000000000000000000000000000000000000000000000000000000004c4b4000000000000000000000000000000000000000000000000000000000"

    const native = decodeWithdrawal(legacyNative, "ethereum-vm")
    expect(native.withdrawal.calls[0].dataHash).toBe(ZERO_HASH)
    expect(codec.getAmount(native.withdrawal)).toBe("1000000000000000000")
    // Same id the 4-member codec produces for this payload
    expect(getDecodedWithdrawalId(native)).toBe(
      "0xd7005099805c5e730f534f546e309475b5611975fadfc9451a96a421b58409f3"
    )

    const erc20 = decodeWithdrawal(legacyErc20, "ethereum-vm")
    expect(erc20.withdrawal.calls[0].dataHash).toBe(ZERO_HASH)
    expect(getDecodedWithdrawalId(erc20)).toBe(
      "0xacc729e7b128bb96d590c3ea8d3ad77de4595d20177ebef2451770a049b2f04d"
    )
  })

  it("throws on a payload that is neither shape", () => {
    expect(() => decodeWithdrawal("0xdeadbeef", "ethereum-vm")).toThrow(
      "Failed to decode ethereum-vm CallRequest"
    )
  })

  it("reads the transfer leg for currency, amount and recipient", () => {
    // The routed call is appended after the transfer, so these still read `calls[0]`
    expect(codec.getRecipient(decoded.withdrawal)).toBe(ROUTER)
    expect(codec.getAmount(decoded.withdrawal)).toBe(
      (1337n * 10n ** 18n).toString()
    )
  })

  it("rejects a request with more than one committed call", () => {
    const twoCommitted = {
      ...decoded.withdrawal,
      calls: [decoded.withdrawal.calls[1], decoded.withdrawal.calls[1]],
    }

    expect(() => toExecutableCallRequest(twoCommitted, multicallData)).toThrow(
      "Expected at most one committed call, found 2"
    )
  })

  it("rejects a call carrying both calldata and a commitment", () => {
    expect(() =>
      getDecodedWithdrawalId({
        ...decoded,
        withdrawal: {
          ...decoded.withdrawal,
          calls: [
            { ...transferCall, dataHash: hashRoutedCalls(calls) },
            decoded.withdrawal.calls[1],
          ],
        },
      })
    ).toThrow("Call carries both calldata and a commitment to it")
  })
})
