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
