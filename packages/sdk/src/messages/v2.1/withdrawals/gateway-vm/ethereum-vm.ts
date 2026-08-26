import {
  Address,
  concatHex,
  decodeAbiParameters,
  encodeAbiParameters,
  Hex,
  keccak256,
  parseAbiParameters,
  stringToHex,
  zeroHash,
} from "viem"

import { CallRequestWithdrawal, getCallRequestRecipient } from "../ethereum-vm"
import type { GatewayDestinationWithdrawalCodec } from "./destination"

// Circle uses the same GatewayMinter address on every supported Ethereum VM chain.
export const ETHEREUM_VM_GATEWAY_MINTER =
  "0x0000000000000000000000002222222d7164433c4c09b0b0d809a9b52c04c205"

// Mirrors `CallRequest` in GatewayEthereumVmDestinationPayloadBuilder.sol.
const gatewayEthereumVmCallRequestAbiParams = parseAbiParameters([
  "(bytes32 transferSpecHash, (address to, bytes data, bytes32 dataHash, uint256 value, bool allowFailure)[] calls, uint256 nonce, uint256 expiration)",
])

type GatewayEthereumVmCall = {
  to: string
  data: string
  dataHash: string
  value: string
  allowFailure: boolean
}

type GatewayEthereumVmCallRequest = Omit<CallRequestWithdrawal, "calls"> & {
  transferSpecHash: string
  calls: GatewayEthereumVmCall[]
}

const validateGatewayEthereumVmCallRequest = (
  request: GatewayEthereumVmCallRequest
): GatewayEthereumVmCallRequest => {
  for (const call of request.calls) {
    if (call.dataHash !== zeroHash && call.data !== "0x") {
      throw new Error("Gateway EVM call contains both data and dataHash")
    }
  }
  return request
}

const decodeGatewayEthereumVmCallRequest = (
  executionPayload: string
): GatewayEthereumVmCallRequest => {
  const [request] = decodeAbiParameters(
    gatewayEthereumVmCallRequestAbiParams,
    executionPayload as Hex
  )

  return validateGatewayEthereumVmCallRequest({
    transferSpecHash: request.transferSpecHash,
    calls: request.calls.map((call) => ({
      to: call.to.toLowerCase(),
      data: call.data.toLowerCase(),
      dataHash: call.dataHash,
      value: call.value.toString(),
      allowFailure: call.allowFailure,
    })),
    nonce: request.nonce.toString(),
    expiration: Number(request.expiration),
  })
}

const getGatewayEthereumVmCallRequestId = (
  request: GatewayEthereumVmCallRequest
): string => {
  const callTypehash = keccak256(
    stringToHex("Call(address to,bytes data,uint256 value,bool allowFailure)")
  )
  const requestTypehash = keccak256(
    stringToHex(
      "CallRequest(bytes32 transferSpecHash,Call[] calls,uint256 nonce,uint256 expiration)Call(address to,bytes data,uint256 value,bool allowFailure)"
    )
  )
  const callHashes = request.calls.map((call) => {
    const dataHash =
      call.dataHash === zeroHash
        ? keccak256(call.data as Hex)
        : (call.dataHash as Hex)

    return keccak256(
      encodeAbiParameters(
        parseAbiParameters([
          "bytes32",
          "address",
          "bytes32",
          "uint256",
          "bool",
        ]),
        [
          callTypehash,
          call.to as Address,
          dataHash,
          BigInt(call.value),
          call.allowFailure,
        ]
      )
    )
  })

  return keccak256(
    encodeAbiParameters(
      parseAbiParameters([
        "bytes32",
        "bytes32",
        "bytes32",
        "uint256",
        "uint256",
      ]),
      [
        requestTypehash,
        request.transferSpecHash as Hex,
        keccak256(concatHex(callHashes)),
        BigInt(request.nonce),
        BigInt(request.expiration),
      ]
    )
  )
}

export const gatewayEthereumVmDestinationCodec: GatewayDestinationWithdrawalCodec =
  {
    vmType: "ethereum-vm",
    matches: (spec) =>
      spec.destinationContract.toLowerCase() === ETHEREUM_VM_GATEWAY_MINTER,
    getId: (executionPayload) =>
      getGatewayEthereumVmCallRequestId(
        decodeGatewayEthereumVmCallRequest(executionPayload)
      ),
    getRecipient: (executionPayload) =>
      getCallRequestRecipient(
        decodeGatewayEthereumVmCallRequest(executionPayload)
      ),
    getExpiration: (executionPayload) =>
      decodeGatewayEthereumVmCallRequest(executionPayload).expiration,
  }
