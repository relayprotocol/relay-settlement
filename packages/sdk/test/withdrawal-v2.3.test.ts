// ABOUTME: Tests v2.3 withdrawal request normalization for VM-specific address codecs.
// ABOUTME: Pins VMs that share withdrawal shape while still using VM-specific codecs.

import { describe, expect, it } from "vitest"
import * as bitcoin from "bitcoinjs-lib"
import { classicAddressToXAddress } from "ripple-address-codec"
import { decodeAbiParameters, parseAbiParameters } from "viem"

import {
  decodeRoutedWithdrawalData,
  encodeRoutedWithdrawalData,
  hashRoutedCalls,
} from "../src/messages/common/ethereum-vm/routed"
import {
  encodeWithdrawRequestAdditionalData,
  normalizeWithdrawRequest,
  DenormalizedWithdrawRequest,
} from "../src/messages/v2.3/withdrawal"
import {
  encodeAddressToHex,
  getVmTypeNativeCurrency,
  VmType,
} from "../src/utils"

describe("normalizeWithdrawRequest", () => {
  const expectNormalizedWithdrawRequest = (
    request: DenormalizedWithdrawRequest,
    vmType: VmType,
    spenderVmType: VmType,
    expectedCurrency: string = encodeAddressToHex(request.currency, vmType)
  ) => {
    expect(
      normalizeWithdrawRequest({
        ...request,
        vmType,
        spenderVmType,
      })
    ).toEqual({
      chainId: request.chainId,
      depository: encodeAddressToHex(request.depository, vmType),
      currency: expectedCurrency,
      amount: request.amount,
      spenderChainId: request.spenderChainId,
      spender: encodeAddressToHex(request.spender, spenderVmType),
      receiver: encodeAddressToHex(request.receiver, vmType),
      data: "0x",
      nonce: request.nonce,
    })
  }

  it("normalizes ethereum-vm withdrawal requests", () => {
    expectNormalizedWithdrawRequest(
      {
        chainId: "8453",
        depository: "0x1111111111111111111111111111111111111111",
        currency: getVmTypeNativeCurrency("ethereum-vm"),
        amount: "1000000000000000000",
        spenderChainId: "1",
        spender: "0x000000000000000000000000000000000000dEaD",
        receiver: "0x2222222222222222222222222222222222222222",
        nonce:
          "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
      "ethereum-vm",
      "ethereum-vm"
    )
  })

  it("normalizes routed ethereum-vm withdrawal requests", () => {
    const router = "0x4444444444444444444444444444444444444444"
    const calls = [
      {
        to: "0x1111111111111111111111111111111111111111",
        data: "0xdeadbeef",
        value: "123",
        allowFailure: true,
      },
      {
        to: "0x2222222222222222222222222222222222222222",
        data: "0x",
        value: "1000000000000000000",
        allowFailure: false,
      },
    ]

    const normalized = normalizeWithdrawRequest({
      chainId: "8453",
      depository: "0x1111111111111111111111111111111111111111",
      currency: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      amount: "1000000",
      spenderChainId: "1",
      spender: "0x000000000000000000000000000000000000dEaD",
      receiver: router,
      nonce:
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      additionalData: {
        "ethereum-vm": { router, calls },
      },
      vmType: "ethereum-vm",
      spenderVmType: "ethereum-vm",
    })

    // Only the commitment is normalized on-chain; the calls stay off-chain
    expect(normalized.data).toBe(
      encodeRoutedWithdrawalData({
        version: 1,
        router,
        dataHash: hashRoutedCalls(calls),
      })
    )
    expect(decodeRoutedWithdrawalData(normalized.data)).toEqual({
      version: 1,
      router,
      dataHash: hashRoutedCalls(calls),
    })
    expect(normalized.receiver).toBe(encodeAddressToHex(router, "ethereum-vm"))
  })

  it("normalizes a routed request whose receiver is not the router", () => {
    // A withdrawal may fund a smart wallet and have the router act on it
    const router = "0x4444444444444444444444444444444444444444"
    const receiver = "0x9876543210987654321098765432109876543210"
    const calls = [
      {
        to: "0x1111111111111111111111111111111111111111",
        data: "0xdeadbeef",
        value: "0",
        allowFailure: false,
      },
    ]

    const normalized = normalizeWithdrawRequest({
      chainId: "8453",
      depository: "0x1111111111111111111111111111111111111111",
      currency: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      amount: "1000000",
      spenderChainId: "1",
      spender: "0x000000000000000000000000000000000000dEaD",
      receiver,
      nonce:
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      additionalData: { "ethereum-vm": { router, calls } },
      vmType: "ethereum-vm",
      spenderVmType: "ethereum-vm",
    })

    expect(normalized.receiver).toBe(
      encodeAddressToHex(receiver, "ethereum-vm")
    )
    expect(decodeRoutedWithdrawalData(normalized.data).router).toBe(
      router.toLowerCase()
    )
  })

  it("normalizes solana-vm withdrawal requests", () => {
    expectNormalizedWithdrawRequest(
      {
        chainId: "solana",
        depository: "11111111111111111111111111111111",
        currency: getVmTypeNativeCurrency("solana-vm"),
        amount: "1000000000",
        spenderChainId: "8453",
        spender: "0x000000000000000000000000000000000000dEaD",
        receiver: "So11111111111111111111111111111111111111112",
        nonce:
          "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
      "solana-vm",
      "ethereum-vm"
    )
  })

  it("normalizes bitcoin-vm withdrawal requests with fee UTXOs", () => {
    const toAddress = (byte: number) =>
      bitcoin.payments.p2wpkh({
        hash: Buffer.alloc(20, byte),
        network: bitcoin.networks.bitcoin,
      }).address!
    const depository = toAddress(1)
    const feeAddress = bitcoin.payments.p2sh({
      hash: Buffer.alloc(20, 2),
      network: bitcoin.networks.bitcoin,
    }).address!
    const receiver = bitcoin.payments.p2pkh({
      hash: Buffer.alloc(20, 3),
      network: bitcoin.networks.bitcoin,
    }).address!

    const normalized = normalizeWithdrawRequest({
      chainId: "bitcoin-mainnet",
      depository,
      currency: getVmTypeNativeCurrency("bitcoin-vm"),
      amount: "9000",
      spenderChainId: "8453",
      spender: "0x000000000000000000000000000000000000dEaD",
      receiver,
      nonce:
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      additionalData: {
        "bitcoin-vm": {
          allocatorUtxos: [{ txid: "11".repeat(32), vout: 0, value: "10000" }],
          feeUtxos: [
            {
              txid: "22".repeat(32),
              vout: 1,
              value: "20000",
              address: feeAddress,
            },
          ],
          feeRate: 2,
          feeChangeAddress: feeAddress,
        },
      },
      vmType: "bitcoin-vm",
      spenderVmType: "ethereum-vm",
    })

    expect(normalized.depository).toBe(
      encodeAddressToHex(depository, "bitcoin-vm")
    )
    const depositoryScript = `0x${bitcoin.address
      .toOutputScript(depository, bitcoin.networks.bitcoin)
      .toString("hex")}`
    const feeScript = `0x${bitcoin.address
      .toOutputScript(feeAddress, bitcoin.networks.bitcoin)
      .toString("hex")}`

    expect(normalized.receiver).toBe(encodeAddressToHex(receiver, "bitcoin-vm"))
    expect(normalized.data).not.toBe("0x")

    const [decoded] = decodeAbiParameters(
      [
        {
          type: "tuple",
          components: [
            {
              type: "tuple[]",
              name: "allocatorUtxos",
              components: [
                { type: "bytes32", name: "txid" },
                { type: "uint32", name: "index" },
                { type: "uint64", name: "value" },
                { type: "bytes", name: "scriptPubKey" },
              ],
            },
            {
              type: "tuple[]",
              name: "feeUtxos",
              components: [
                { type: "bytes32", name: "txid" },
                { type: "uint32", name: "index" },
                { type: "uint64", name: "value" },
                { type: "bytes", name: "scriptPubKey" },
              ],
            },
            { type: "bytes", name: "feeChangeScript" },
            { type: "uint64", name: "feeRate" },
          ],
        },
      ],
      normalized.data
    )
    expect(decoded.allocatorUtxos).toHaveLength(1)
    expect(decoded.allocatorUtxos[0].scriptPubKey).toBe(depositoryScript)
    expect(decoded.feeUtxos).toHaveLength(1)
    expect(decoded.feeUtxos[0].scriptPubKey).toBe(feeScript)
    expect(decoded.feeChangeScript).toBe(feeScript)
    expect(decoded.feeRate).toBe(2n)
  })

  it("rejects bitcoin-vm withdrawal requests with non-P2WPKH allocator addresses", () => {
    const toP2wpkhAddress = (byte: number) =>
      bitcoin.payments.p2wpkh({
        hash: Buffer.alloc(20, byte),
        network: bitcoin.networks.bitcoin,
      }).address!
    const legacyAddress = bitcoin.payments.p2pkh({
      hash: Buffer.alloc(20, 3),
      network: bitcoin.networks.bitcoin,
    }).address!

    expect(() =>
      normalizeWithdrawRequest({
        chainId: "bitcoin-mainnet",
        depository: legacyAddress,
        currency: getVmTypeNativeCurrency("bitcoin-vm"),
        amount: "9000",
        spenderChainId: "8453",
        spender: "0x000000000000000000000000000000000000dEaD",
        receiver: legacyAddress,
        nonce:
          "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        additionalData: {
          "bitcoin-vm": {
            allocatorUtxos: [
              { txid: "11".repeat(32), vout: 0, value: "10000" },
            ],
            feeUtxos: [
              {
                txid: "22".repeat(32),
                vout: 1,
                value: "20000",
                address: toP2wpkhAddress(2),
              },
            ],
            feeRate: 2,
            feeChangeAddress: toP2wpkhAddress(2),
          },
        },
        vmType: "bitcoin-vm",
        spenderVmType: "ethereum-vm",
      })
    ).toThrow("bitcoin-vm allocator must be a P2WPKH address")
  })

  it("normalizes hyperliquid-vm native withdrawal requests with nonce additionalData", () => {
    const normalized = normalizeWithdrawRequest({
      chainId: "hyperliquid",
      depository: "0x00000000000000000000000000000000000000dd",
      currency: getVmTypeNativeCurrency("hyperliquid-vm"),
      amount: "123456789",
      spenderChainId: "8453",
      spender: "0x000000000000000000000000000000000000dEaD",
      receiver: "0x000000000000000000000000000000000000beef",
      nonce:
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      additionalData: {
        "hyperliquid-vm": {
          nonce: 123456789,
        },
      },
      vmType: "hyperliquid-vm",
      spenderVmType: "ethereum-vm",
    })

    expect(normalized.currency).toBe(
      encodeAddressToHex(
        getVmTypeNativeCurrency("hyperliquid-vm"),
        "hyperliquid-vm"
      )
    )
    const decoded = decodeAbiParameters(
      parseAbiParameters("uint64"),
      normalized.data
    )
    expect(decoded[0]).toBe(123456789n)
  })

  it("normalizes hyperliquid-vm sendAsset withdrawal requests with nonce additionalData", () => {
    const normalized = normalizeWithdrawRequest({
      chainId: "hyperliquid",
      depository: "0x00000000000000000000000000000000000000dd",
      currency: "0x11111111111111111111111111111111",
      amount: "25000",
      spenderChainId: "8453",
      spender: "0x000000000000000000000000000000000000dEaD",
      receiver: "0x000000000000000000000000000000000000beef",
      nonce:
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      additionalData: {
        "hyperliquid-vm": {
          nonce: "987654321",
        },
      },
      vmType: "hyperliquid-vm",
      spenderVmType: "ethereum-vm",
    })

    expect(normalized.currency).toBe("0x11111111111111111111111111111111")
    const decoded = decodeAbiParameters(
      parseAbiParameters("uint64"),
      normalized.data
    )
    expect(decoded[0]).toBe(987654321n)
  })

  it("normalizes lighter-vm withdrawal requests with additionalData", () => {
    const normalized = normalizeWithdrawRequest({
      chainId: "lighter",
      depository: "42",
      currency: "77",
      amount: "2000000",
      spenderChainId: "8453",
      spender: "0x000000000000000000000000000000000000dEaD",
      receiver: "99",
      nonce:
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      additionalData: {
        "lighter-vm": {
          nonce: "123",
          apiKeyIndex: 5,
          usdcFee: 100,
        },
      },
      vmType: "lighter-vm",
      spenderVmType: "ethereum-vm",
    })

    expect(normalized.depository).toBe(encodeAddressToHex("42", "lighter-vm"))
    expect(normalized.currency).toBe(encodeAddressToHex("77", "lighter-vm"))
    expect(normalized.receiver).toBe(encodeAddressToHex("99", "lighter-vm"))

    const decoded = decodeAbiParameters(
      parseAbiParameters("uint64, uint64, uint64"),
      normalized.data
    )
    expect(decoded[0]).toBe(123n)
    expect(decoded[1]).toBe(5n)
    expect(decoded[2]).toBe(100n)
  })

  it("requires lighter-vm additionalData", () => {
    expect(() =>
      normalizeWithdrawRequest({
        chainId: "lighter",
        depository: "42",
        currency: "3",
        amount: "2000000",
        spenderChainId: "8453",
        spender: "0x000000000000000000000000000000000000dEaD",
        receiver: "99",
        nonce:
          "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        vmType: "lighter-vm",
        spenderVmType: "ethereum-vm",
      })
    ).toThrow("Additional data is required for lighter-vm")
  })

  it("normalizes ton-vm withdrawal requests", () => {
    const depository =
      "0:f37b9f6f11111111111111111111111111111111111111111111111111111111"
    expectNormalizedWithdrawRequest(
      {
        chainId: "ton-mainnet",
        depository,
        currency: getVmTypeNativeCurrency("ton-vm"),
        amount: "100000000",
        spenderChainId: "8453",
        spender: "0x000000000000000000000000000000000000dEaD",
        receiver:
          "0:1122334455667788990011223344556677889900112233445566778899001122",
        nonce:
          "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
      "ton-vm",
      "ethereum-vm"
    )
  })

  const xrpRequestDataAbiParams = parseAbiParameters([
    "(uint32 sequence, uint64 fee, uint32 lastLedgerSequence, uint32 flags, uint32 destinationTag, bool hasDestinationTag)",
  ])

  const xrpRequestBase = {
    chainId: "xrp",
    depository: "rEgPcf61jqzyxHMqStaX7GsC9Swb1srgur",
    currency: getVmTypeNativeCurrency("xrp-vm"),
    amount: "1000000",
    spenderChainId: "8453",
    spender: "0x000000000000000000000000000000000000dEaD",
    receiver: "rDg96xs4mPNW7oz19igxbtgQ5ES5GiYdLM",
    nonce: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    vmType: "xrp-vm" as const,
    spenderVmType: "ethereum-vm" as const,
  }

  it("normalizes xrp-vm withdrawal requests, encoding additionalData as XrpRequestData", () => {
    const normalized = normalizeWithdrawRequest({
      ...xrpRequestBase,
      additionalData: {
        "xrp-vm": {
          sequence: 42,
          fee: "12",
          lastLedgerSequence: 90000000,
          destinationTag: 0,
        },
      },
    })

    expect(normalized.depository).toBe(
      encodeAddressToHex(xrpRequestBase.depository, "xrp-vm")
    )
    expect(normalized.currency).toBe(
      encodeAddressToHex(xrpRequestBase.currency, "xrp-vm")
    )
    expect(normalized.receiver).toBe(
      encodeAddressToHex(xrpRequestBase.receiver, "xrp-vm")
    )

    const [decoded] = decodeAbiParameters(
      xrpRequestDataAbiParams,
      normalized.data as `0x${string}`
    )
    expect(decoded.sequence).toBe(42)
    expect(decoded.fee).toBe(12n)
    expect(decoded.lastLedgerSequence).toBe(90000000)
    expect(decoded.flags).toBe(0)
    // A tag of 0 is a real tag — presence is a separate flag
    expect(decoded.destinationTag).toBe(0)
    expect(decoded.hasDestinationTag).toBe(true)
  })

  it("encodes an absent xrp-vm destination tag as hasDestinationTag=false", () => {
    const normalized = normalizeWithdrawRequest({
      ...xrpRequestBase,
      additionalData: {
        "xrp-vm": {
          sequence: 42,
          fee: "12",
          lastLedgerSequence: 90000000,
        },
      },
    })

    const [decoded] = decodeAbiParameters(
      xrpRequestDataAbiParams,
      normalized.data as `0x${string}`
    )
    expect(decoded.destinationTag).toBe(0)
    expect(decoded.hasDestinationTag).toBe(false)
  })

  it("requires xrp-vm additionalData", () => {
    expect(() => normalizeWithdrawRequest(xrpRequestBase)).toThrow(
      "Additional data is required for xrp-vm"
    )
  })

  it("rejects xrp-vm withdrawal requests with a tagged X-address receiver", () => {
    const taggedReceiver = classicAddressToXAddress(
      "rDg96xs4mPNW7oz19igxbtgQ5ES5GiYdLM",
      12345,
      false
    )
    expect(() =>
      normalizeWithdrawRequest({
        ...xrpRequestBase,
        receiver: taggedReceiver,
        additionalData: {
          "xrp-vm": {
            sequence: 42,
            fee: "12",
            lastLedgerSequence: 90000000,
          },
        },
      })
    ).toThrow("destination tag")
  })

  const hederaRequestDataAbiParams = parseAbiParameters([
    "(uint64 payerNum, uint64 nodeAccountNum, uint64 validStartSeconds, uint32 validDurationSeconds, uint64 maxTransactionFee)",
  ])

  const hederaRequestBase = {
    chainId: "hedera",
    depository: "0.0.10811639",
    currency: getVmTypeNativeCurrency("hedera-vm"),
    amount: "250000000",
    spenderChainId: "8453",
    spender: "0x000000000000000000000000000000000000dEaD",
    receiver: "0.0.1234",
    nonce: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    vmType: "hedera-vm" as const,
    spenderVmType: "ethereum-vm" as const,
  }

  it("normalizes hedera-vm withdrawal requests, encoding additionalData as HederaRequestData", () => {
    const normalized = normalizeWithdrawRequest({
      ...hederaRequestBase,
      additionalData: {
        "hedera-vm": {
          payerNum: "999",
          nodeAccountNum: 3,
          validStartSeconds: "1787119027",
          validDurationSeconds: 180,
          maxTransactionFee: "100000000",
        },
      },
    })

    expect(normalized.depository).toBe(
      encodeAddressToHex(hederaRequestBase.depository, "hedera-vm")
    )
    expect(normalized.currency).toBe(
      encodeAddressToHex(hederaRequestBase.currency, "hedera-vm")
    )
    expect(normalized.receiver).toBe(
      encodeAddressToHex(hederaRequestBase.receiver, "hedera-vm")
    )

    const [decoded] = decodeAbiParameters(
      hederaRequestDataAbiParams,
      normalized.data as `0x${string}`
    )
    expect(decoded.payerNum).toBe(999n)
    expect(decoded.nodeAccountNum).toBe(3n)
    expect(decoded.validStartSeconds).toBe(1787119027n)
    expect(decoded.validDurationSeconds).toBe(180)
    expect(decoded.maxTransactionFee).toBe(100000000n)
  })

  it("requires hedera-vm additionalData", () => {
    expect(() => normalizeWithdrawRequest(hederaRequestBase)).toThrow(
      "Additional data is required for hedera-vm"
    )
  })

  const gatewayRequestDataAbiParams = parseAbiParameters([
    "(address allocator, string destinationChainId, uint256 maxBlockHeight, bytes destinationData)",
  ])

  const gatewayRequestBase = {
    chainId: "gateway",
    depository: "0x15de2575afa440f7ee86850c2899b8f1f6173b01",
    currency: "0x0000000000000000000000000000000000000000",
    amount: "10000",
    spenderChainId: "relay",
    spender: "0x8e4740962E0B8fF64A3AE44409572F33f34D97AE",
    receiver: "0xf3d63166f0ca56c3c1a3508fce03ff0cf3fb691e",
    nonce: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    vmType: "gateway-vm" as const,
    spenderVmType: "ethereum-vm" as const,
  }

  it("normalizes gateway-vm withdrawal requests with additionalData", () => {
    const normalized = normalizeWithdrawRequest({
      ...gatewayRequestBase,
      additionalData: {
        "gateway-vm": {
          allocator: "0x1111111111111111111111111111111111111111",
          destinationChainId: "polygon",
          maxBlockHeight: "90932551",
        },
      },
    })

    expect(normalized).toMatchObject({
      chainId: gatewayRequestBase.chainId,
      depository: gatewayRequestBase.depository,
      currency: gatewayRequestBase.currency,
      amount: gatewayRequestBase.amount,
      spenderChainId: gatewayRequestBase.spenderChainId,
      spender: encodeAddressToHex(gatewayRequestBase.spender, "ethereum-vm"),
      receiver: gatewayRequestBase.receiver,
      nonce: gatewayRequestBase.nonce,
    })

    const [decoded] = decodeAbiParameters(
      gatewayRequestDataAbiParams,
      normalized.data as `0x${string}`
    )
    expect(decoded.allocator.toLowerCase()).toBe(
      "0x1111111111111111111111111111111111111111"
    )
    expect(decoded.destinationChainId).toBe("polygon")
    expect(decoded.maxBlockHeight).toBe(90932551n)
    expect(decoded.destinationData).toBe("0x")
  })

  it("requires gateway-vm additionalData", () => {
    expect(() => normalizeWithdrawRequest(gatewayRequestBase)).toThrow(
      "Additional data is required for gateway-vm"
    )
  })
})

describe("encodeWithdrawRequestAdditionalData", () => {
  it("returns 0x for VMs without additional withdrawal data", () => {
    expect(
      encodeWithdrawRequestAdditionalData({
        vmType: "ethereum-vm",
      })
    ).toBe("0x")
  })

  it("encodes gateway-vm additionalData", () => {
    const data = encodeWithdrawRequestAdditionalData({
      vmType: "gateway-vm",
      additionalData: {
        "gateway-vm": {
          allocator: "0x1111111111111111111111111111111111111111",
          destinationChainId: "polygon",
          maxBlockHeight: "90932551",
        },
      },
    })

    const [decoded] = decodeAbiParameters(
      parseAbiParameters([
        "(address allocator, string destinationChainId, uint256 maxBlockHeight, bytes destinationData)",
      ]),
      data
    )
    expect(decoded.allocator.toLowerCase()).toBe(
      "0x1111111111111111111111111111111111111111"
    )
    expect(decoded.destinationChainId).toBe("polygon")
    expect(decoded.maxBlockHeight).toBe(90932551n)
    expect(decoded.destinationData).toBe("0x")
  })

  it("encodes gateway-vm destination data", () => {
    const destinationData = {
      vmType: "ethereum-vm" as const,
      router: "0x4444444444444444444444444444444444444444",
      calls: [
        {
          to: "0x1111111111111111111111111111111111111111",
          data: "0xdeadbeef",
          value: "0",
          allowFailure: false,
        },
      ],
    }
    const data = encodeWithdrawRequestAdditionalData({
      vmType: "gateway-vm",
      additionalData: {
        "gateway-vm": {
          allocator: "0x1111111111111111111111111111111111111111",
          destinationChainId: "polygon",
          maxBlockHeight: "90932551",
          destinationData,
        },
      },
    })

    const [decoded] = decodeAbiParameters(
      parseAbiParameters([
        "(address allocator, string destinationChainId, uint256 maxBlockHeight, bytes destinationData)",
      ]),
      data
    )
    expect(decodeRoutedWithdrawalData(decoded.destinationData)).toEqual({
      version: 1,
      router: destinationData.router,
      dataHash: hashRoutedCalls(destinationData.calls),
    })
  })

  it("matches normalizeWithdrawRequest data encoding", () => {
    const additionalData = {
      "gateway-vm": {
        allocator: "0x1111111111111111111111111111111111111111",
        destinationChainId: "polygon",
        maxBlockHeight: "90932551",
      },
    }

    const encoded = encodeWithdrawRequestAdditionalData({
      vmType: "gateway-vm",
      additionalData,
    })
    const normalized = normalizeWithdrawRequest({
      chainId: "gateway",
      depository: "0x15de2575afa440f7ee86850c2899b8f1f6173b01",
      currency: "0x0000000000000000000000000000000000000000",
      amount: "10000",
      spenderChainId: "relay",
      spender: "0x8e4740962E0B8fF64A3AE44409572F33f34D97AE",
      receiver: "0xf3d63166f0ca56c3c1a3508fce03ff0cf3fb691e",
      nonce:
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      additionalData,
      vmType: "gateway-vm",
      spenderVmType: "ethereum-vm",
    })

    expect(encoded).toBe(normalized.data)
  })

  it("requires bitcoin-vm depository to encode allocator UTXO script data", () => {
    expect(() =>
      encodeWithdrawRequestAdditionalData({
        vmType: "bitcoin-vm",
        additionalData: {
          "bitcoin-vm": {
            allocatorUtxos: [
              { txid: "11".repeat(32), vout: 0, value: "10000" },
            ],
            feeUtxos: [],
            feeRate: 2,
            feeChangeAddress: bitcoin.payments.p2wpkh({
              hash: Buffer.alloc(20, 2),
              network: bitcoin.networks.bitcoin,
            }).address!,
          },
        },
      })
    ).toThrow("depository is required for bitcoin-vm additionalData")
  })
})
