import { describe, expect, it } from "vitest"
import {
  Address,
  encodeAbiParameters,
  encodeFunctionData,
  Hex,
  keccak256,
  parseAbiParameters,
  zeroAddress,
  zeroHash,
} from "viem"

import {
  DecodedGatewayVmWithdrawal,
  decodeAddress,
  decodeWithdrawal,
  encodeAddress,
  encodeWithdrawal,
  getDecodedWithdrawalId,
  getGatewayDestinationExpiration,
  getGatewayDestinationVmType,
  getVmTypeNativeCurrency,
} from "../src"
import {
  decodeGatewaySolanaVmTransferRequest,
  encodeGatewaySolanaVmTransferRequest,
  GatewaySolanaVmTransferRequest,
  getGatewaySolanaVmTransferRequestHash,
  getSolanaUsedRequestAddress,
  SOLANA_VM_GATEWAY_MINTER,
} from "../src"
import { getWithdrawalCodec } from "../src/messages/v2.1/withdrawals"

const codec = getWithdrawalCodec("gateway-vm")

const ADDRESS = "0x1234567890123456789012345678901234567890"
const USDC = "0x9876543210987654321098765432109876543210"
const BYTES32_ADDRESS = `0x${ADDRESS.slice(2).padStart(64, "0")}`
const TRANSFER_SPEC_HASH =
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const SALT =
  "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
const ETHEREUM_VM_GATEWAY_MINTER =
  "0x0000000000000000000000002222222d7164433c4c09b0b0d809a9b52c04c205"

const gatewayEthereumVmCallRequestAbiParams = parseAbiParameters([
  "(bytes32 transferSpecHash, (address to, bytes data, bytes32 dataHash, uint256 value, bool allowFailure)[] calls, uint256 nonce, uint256 expiration)",
])

type GatewayEthereumVmCallRequest = {
  transferSpecHash: string
  calls: {
    to: string
    data: string
    dataHash: string
    value: string
    allowFailure: boolean
  }[]
  nonce: string
  expiration: number
}

const encodeGatewayEthereumVmCallRequest = (
  request: GatewayEthereumVmCallRequest
): Hex =>
  encodeAbiParameters(gatewayEthereumVmCallRequestAbiParams, [
    {
      transferSpecHash: request.transferSpecHash as Hex,
      calls: request.calls.map((call) => ({
        to: call.to as Address,
        data: call.data as Hex,
        dataHash: call.dataHash as Hex,
        value: BigInt(call.value),
        allowFailure: call.allowFailure,
      })),
      nonce: BigInt(request.nonce),
      expiration: BigInt(request.expiration),
    },
  ])

const transferData = encodeFunctionData({
  abi: [
    {
      type: "function",
      name: "transfer",
      stateMutability: "nonpayable",
      inputs: [
        { name: "to", type: "address" },
        { name: "amount", type: "uint256" },
      ],
      outputs: [{ name: "", type: "bool" }],
    },
  ],
  functionName: "transfer",
  args: [ADDRESS, 500000n],
})
const gatewayCallRequest: GatewayEthereumVmCallRequest = {
  transferSpecHash: TRANSFER_SPEC_HASH,
  calls: [
    {
      to: USDC,
      data: transferData,
      dataHash: zeroHash,
      value: "0",
      allowFailure: false,
    },
  ],
  nonce: "1",
  expiration: 1735680000,
}
const executionPayload = encodeGatewayEthereumVmCallRequest(gatewayCallRequest)

const gatewayWithdrawal: DecodedGatewayVmWithdrawal = {
  vmType: "gateway-vm",
  withdrawal: {
    destinationChainId: "ethereum",
    executionPayload,
    burnIntent: {
      maxBlockHeight: "12345678",
      maxFee: "1000",
      spec: {
        version: 1,
        sourceDomain: 0,
        destinationDomain: 1,
        sourceContract: TRANSFER_SPEC_HASH,
        destinationContract: ETHEREUM_VM_GATEWAY_MINTER,
        sourceToken: BYTES32_ADDRESS,
        destinationToken: BYTES32_ADDRESS,
        sourceDepositor: BYTES32_ADDRESS,
        destinationRecipient: BYTES32_ADDRESS,
        sourceSigner: BYTES32_ADDRESS,
        destinationCaller: BYTES32_ADDRESS,
        value: "500000",
        salt: SALT,
        hookData: SALT,
      },
    },
  },
}

const withExecutionPayload = (
  executionPayload: string
): DecodedGatewayVmWithdrawal => ({
  ...gatewayWithdrawal,
  withdrawal: {
    ...gatewayWithdrawal.withdrawal,
    executionPayload,
  },
})

describe("gateway-vm", () => {
  it("uses the zero address as its canonical currency", () => {
    expect(getVmTypeNativeCurrency("gateway-vm")).toBe(zeroAddress)
  })

  it("requires callers to use the physical subchain VM for addresses", () => {
    expect(() => encodeAddress(ADDRESS, "gateway-vm")).toThrow(
      "Address encoding is intentionally unsupported for gateway-vm because this VM type will not be supported for order creation"
    )
    expect(() => decodeAddress(new Uint8Array(20), "gateway-vm")).toThrow(
      "Address decoding is intentionally unsupported for gateway-vm because this VM type will not be supported for order creation"
    )
  })

  it("decodes the payload shape emitted by GatewayVmPayloadBuilder", () => {
    const encodedByContract = encodeAbiParameters(
      parseAbiParameters([
        "(string destinationChainId, bytes executionPayload, (uint256 maxBlockHeight, uint256 maxFee, (uint32 version, uint32 sourceDomain, uint32 destinationDomain, bytes32 sourceContract, bytes32 destinationContract, bytes32 sourceToken, bytes32 destinationToken, bytes32 sourceDepositor, bytes32 destinationRecipient, bytes32 sourceSigner, bytes32 destinationCaller, uint256 value, bytes32 salt, bytes hookData) spec) burnIntent)",
      ]),
      [
        {
          destinationChainId: gatewayWithdrawal.withdrawal.destinationChainId,
          executionPayload,
          burnIntent: {
            maxBlockHeight: 12345678n,
            maxFee: 1000n,
            spec: {
              ...gatewayWithdrawal.withdrawal.burnIntent.spec,
              value: 500000n,
            },
          },
        },
      ]
    )

    expect(decodeWithdrawal(encodedByContract, "gateway-vm")).toEqual(
      gatewayWithdrawal
    )
  })

  it("encodes the Gateway payload and extracts its settlement fields", () => {
    const encoded = encodeWithdrawal(gatewayWithdrawal)

    expect(decodeWithdrawal(encoded, "gateway-vm")).toEqual(gatewayWithdrawal)
    expect(getGatewayDestinationVmType(gatewayWithdrawal.withdrawal)).toBe(
      "ethereum-vm"
    )
    expect(getGatewayDestinationExpiration(gatewayWithdrawal.withdrawal)).toBe(
      1735680000
    )
    expect(getDecodedWithdrawalId(gatewayWithdrawal)).toMatchInlineSnapshot(
      `"0x6ad16f316f63a851d90c575c3b6885300c09864417079194731d6c04e216735f"`
    )
    expect(codec.getCurrency(gatewayWithdrawal.withdrawal)).toBe(zeroAddress)
    expect(codec.getAmount(gatewayWithdrawal.withdrawal)).toBe("500000")
    expect(codec.getRecipient(gatewayWithdrawal.withdrawal)).toBe(ADDRESS)
  })

  it("does not decode the pre-dataHash Gateway format", () => {
    const oldExecutionPayload = encodeAbiParameters(
      parseAbiParameters([
        "(bytes32 transferSpecHash, (address to, bytes data, uint256 value, bool allowFailure)[] calls, uint256 nonce, uint256 expiration)",
      ]),
      [
        {
          transferSpecHash: gatewayCallRequest.transferSpecHash,
          calls: gatewayCallRequest.calls.map((call) => ({
            to: call.to,
            data: call.data,
            value: BigInt(call.value),
            allowFailure: call.allowFailure,
          })),
          nonce: BigInt(gatewayCallRequest.nonce),
          expiration: BigInt(gatewayCallRequest.expiration),
        },
      ]
    )

    expect(() =>
      getDecodedWithdrawalId(withExecutionPayload(oldExecutionPayload))
    ).toThrow()
  })

  it("rejects Gateway EVM calls with data and dataHash", () => {
    const ambiguousExecutionPayload = encodeGatewayEthereumVmCallRequest({
      ...gatewayCallRequest,
      calls: [
        {
          ...gatewayCallRequest.calls[0],
          dataHash: keccak256(transferData),
        },
      ],
    })

    expect(() =>
      getDecodedWithdrawalId(withExecutionPayload(ambiguousExecutionPayload))
    ).toThrow("Gateway EVM call contains both data and dataHash")
  })

  it("derives the same id from committed and executable router calldata", () => {
    const routerData = "0xdeadbeef"
    const routerDataHash = keccak256(routerData)
    const committed = encodeGatewayEthereumVmCallRequest({
      ...gatewayCallRequest,
      calls: [
        ...gatewayCallRequest.calls,
        {
          to: ADDRESS,
          data: "0x",
          dataHash: routerDataHash,
          value: "0",
          allowFailure: false,
        },
      ],
    })
    const executable = encodeGatewayEthereumVmCallRequest({
      ...gatewayCallRequest,
      calls: [
        ...gatewayCallRequest.calls,
        {
          to: ADDRESS,
          data: routerData,
          dataHash: zeroHash,
          value: "0",
          allowFailure: false,
        },
      ],
    })

    expect(getDecodedWithdrawalId(withExecutionPayload(committed))).toBe(
      getDecodedWithdrawalId(withExecutionPayload(executable))
    )
  })

  it("rejects an unregistered destination VM without affecting outer decoding", () => {
    const unsupported: DecodedGatewayVmWithdrawal = {
      ...gatewayWithdrawal,
      withdrawal: {
        ...gatewayWithdrawal.withdrawal,
        burnIntent: {
          ...gatewayWithdrawal.withdrawal.burnIntent,
          spec: {
            ...gatewayWithdrawal.withdrawal.burnIntent.spec,
            destinationContract: SALT,
          },
        },
      },
    }
    const decoded = decodeWithdrawal(
      encodeWithdrawal(unsupported),
      "gateway-vm"
    )

    expect(decoded).toEqual(unsupported)
    expect(() => getGatewayDestinationVmType(decoded.withdrawal)).toThrow(
      /unsupported gateway destination contract/i
    )
    expect(() => getGatewayDestinationExpiration(decoded.withdrawal)).toThrow(
      /unsupported gateway destination contract/i
    )
  })
})

// Vectors shared with the relay-gateway-depository program's unit test and the Hub builder test
describe("gateway-vm solana-vm destination", () => {
  const VECTOR_MINT = "5nUXHYLUrYv9PmeN4RKZ1iwUFBGWmoqMTajEiKNsXRdE"
  const DEVNET_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
  const plainRequest: GatewaySolanaVmTransferRequest = {
    domain:
      "0x5fe7f977e71dba2ea1a68e21057beebb9be2ac30c6410aa38d4f3fbe41dcffd2",
    transferSpecHash:
      "0x2a01f5587e9faf2b2908b6bb19b2e4f295638407d27de3b5a16ac4f11d355440",
    recipient: "FDx39MbXSupLUaxmN3SQ9x3G6mtTjemZVcWgz7jkcvTD",
    token: VECTOR_MINT,
    amount: "1000000",
    nonce: "14041958522398838600",
    expiration: 1700000300,
  }
  const routedRequest: GatewaySolanaVmTransferRequest = {
    ...plainRequest,
    router: "9QybjuydfDYwJkdDLMJJaHEcQPaYeRoiJ5cYj7qLd5Su",
  }
  const PLAIN_ID =
    "0xbfb5e4a075619aac92f01c9f769184a34bbc34dd08b5ea708f05242dd8739592"
  const ROUTED_ID =
    "0xd52494471653adc327e82464c67862cf00e8e5c163dacd727457ddfdd1dc9dc6"

  const toHex = (request: GatewaySolanaVmTransferRequest) =>
    "0x" + encodeGatewaySolanaVmTransferRequest(request).toString("hex")

  const solanaWithdrawal = (
    executionPayload: string
  ): DecodedGatewayVmWithdrawal => ({
    ...gatewayWithdrawal,
    withdrawal: {
      ...gatewayWithdrawal.withdrawal,
      destinationChainId: "solana",
      executionPayload,
      burnIntent: {
        ...gatewayWithdrawal.withdrawal.burnIntent,
        spec: {
          ...gatewayWithdrawal.withdrawal.burnIntent.spec,
          destinationContract: SOLANA_VM_GATEWAY_MINTER,
        },
      },
    },
  })

  it("matches Circle's Solana GatewayMinter program", () => {
    expect(SOLANA_VM_GATEWAY_MINTER).toBe(
      "0x" +
        Buffer.from(
          encodeAddress(
            "GATEm5SoBJiSw1v2Pz1iPBgUYkXzCUJ27XSXhDfSyzVZ",
            "solana-vm"
          )
        ).toString("hex")
    )
  })

  it("hashes a plain request like the depository program", () => {
    expect(encodeGatewaySolanaVmTransferRequest(plainRequest).length).toBe(193)
    expect(getGatewaySolanaVmTransferRequestHash(plainRequest)).toBe(PLAIN_ID)
    expect(decodeGatewaySolanaVmTransferRequest(toHex(plainRequest))).toEqual(
      plainRequest
    )
  })

  it("hashes a routed request like the depository program", () => {
    expect(encodeGatewaySolanaVmTransferRequest(routedRequest).length).toBe(231)
    expect(getGatewaySolanaVmTransferRequestHash(routedRequest)).toBe(ROUTED_ID)
    expect(decodeGatewaySolanaVmTransferRequest(toHex(routedRequest))).toEqual(
      routedRequest
    )
  })

  it("extracts the settlement fields through the gateway-vm codec", () => {
    const decoded = decodeWithdrawal(
      encodeWithdrawal(solanaWithdrawal(toHex(routedRequest))),
      "gateway-vm"
    )

    expect(getGatewayDestinationVmType(decoded.withdrawal)).toBe("solana-vm")
    expect(getDecodedWithdrawalId(decoded)).toBe(ROUTED_ID)
    expect(codec.getRecipient(decoded.withdrawal)).toBe(routedRequest.recipient)
    expect(getGatewayDestinationExpiration(decoded.withdrawal)).toBe(
      routedRequest.expiration
    )
    expect(getDecodedWithdrawalId(solanaWithdrawal(toHex(plainRequest)))).toBe(
      PLAIN_ID
    )
  })

  // Requests executed on devnet by program DAt1pZms…: the derived account is in each transaction
  it("derives the used_request account of executed requests", () => {
    const program = "DAt1pZmsCkKJ3WETGZPrtLhZq9inV3DrBSeZu12EKSe8"
    const executed: GatewaySolanaVmTransferRequest = {
      domain:
        "0x3326d36c4912d92d05c27e3ab8f3fe5c1ea4a6d398259e4400ae3334bc12efa7",
      transferSpecHash:
        "0xc436eb60711d7bed412bd2c10b181ba96c06ae7403188f24764174ee0009a553",
      recipient: "6bQ9SKSgTV1xGoew78yohwrZegNfayfQ3Ga3389yWApT",
      token: DEVNET_USDC_MINT,
      amount: "400000",
      nonce: "12558930276402148191",
      expiration: 1794822636,
    }
    const executedRouted: GatewaySolanaVmTransferRequest = {
      ...executed,
      transferSpecHash:
        "0x3c4fe108edce037e416001ad7e43390546a487447bfe1c9f9dc9f296f2af368a",
      recipient: "B7PRJXW9jiWUogE3tdHcQ9WX6wrsNsmJoojMcC459Ge8",
      amount: "60000",
      nonce: "10493884260752859522",
      expiration: 1794874744,
      router: "9QybjuydfDYwJkdDLMJJaHEcQPaYeRoiJ5cYj7qLd5Su",
    }

    expect(
      getSolanaUsedRequestAddress(
        program,
        getGatewaySolanaVmTransferRequestHash(executed)
      )
    ).toBe("8D1nEKJ4Eyvut5JvCsw8rVLpMJjvq23avkeDSenGCwsh")
    expect(
      getSolanaUsedRequestAddress(
        program,
        getGatewaySolanaVmTransferRequestHash(executedRouted)
      )
    ).toBe("3n5Cz6jvTQ6HDDJZ1JTgFEtZDQPU18MT2hSDfiiRhgtJ")
  })

  it("rejects payloads that are not exactly one request", () => {
    const plain = toHex(plainRequest)
    const routed = toHex(routedRequest)

    for (const payload of [
      plain + "00",
      plain.slice(0, -2),
      routed + "00",
      // a plain body under the routed prefix and the reverse
      "0x" +
        Buffer.from("RelayGatewayDepository:RoutedTransferRequest:v1").toString(
          "hex"
        ) +
        plain.slice(2 + 41 * 2),
      "0x" +
        Buffer.from("RelayGatewayDepository:TransferRequest:v1").toString(
          "hex"
        ) +
        routed.slice(2 + 47 * 2),
      "0x" + plain.slice(4),
      "0x",
    ]) {
      expect(() => getDecodedWithdrawalId(solanaWithdrawal(payload))).toThrow(
        /invalid gateway transfer request payload/i
      )
    }
  })

  it("rejects non-canonical amounts", () => {
    expect(() =>
      encodeGatewaySolanaVmTransferRequest({ ...plainRequest, amount: "01" })
    ).toThrow(/u64/)
    expect(() =>
      encodeGatewaySolanaVmTransferRequest({
        ...plainRequest,
        nonce: "18446744073709551616",
      })
    ).toThrow(/u64/)
  })
})
