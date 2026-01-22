import {
  Hex,
  Address,
  encodeAbiParameters,
  parseAbiParameters,
  encodePacked,
  keccak256,
} from "viem"

import { arrayToHex } from "../../hub/hub-utils"
import { encodeAddress, VmType } from "../../utils"

export interface SubmitWithdrawRequest {
  chainId: string // The chain id to withdraw on
  depository: string // The depository contract address on the withdrawal chain
  currency: string // The currency to withdraw
  amount: string // The amount to withdraw
  spender: string // The address of the account that owns the balance in the Hub contract (can be an alias)
  receiver: string // The withdrawal recipient
  data: string // Additional data
  nonce: string // Nonce for replay protection
}

export const getSubmitWithdrawRequestHash = (
  request: SubmitWithdrawRequest
) => {
  const encoded = encodeAbiParameters(
    parseAbiParameters([
      "(uint256 chainId, string depository, string currency, uint256 amount, address spender, string receiver, bytes data, bytes32 nonce)",
    ]),
    [
      {
        chainId: BigInt(request.chainId),
        depository: request.depository,
        currency: request.currency,
        amount: BigInt(request.amount),
        spender: request.spender as Address,
        receiver: request.receiver,
        data: request.data as Hex,
        nonce: request.nonce as Hex,
      },
    ]
  )

  return keccak256(encoded)
}

export type WithdrawalAddressParams = {
  depository: string
  depositoryChainId: string
  currency: string
  recipient: string
  withdrawerAlias: string
  withdrawalNonce: string
}

/**
 * Compute deterministic withdrawal address
 *
 * @param depository the depository contract holding the funds on origin chain (as string)
 * @param depositoryChainId the chain id of the depository contract currently holding the funds
 * @param currency the id of the currency as expressed on origin chain (string)
 * @param recipient the address that will receive the withdrawn funds on destination chain
 * @param withdrawerAlias the address that owns the balance on the settlement chain
 * before the withdrawal is initiated
 * @param withdrawalNonce nonce to prevent collisions for similar withdrawals
 * @returns withdrawal address (in lower case)
 */
export function getWithdrawalAddress(
  withdrawalParams: WithdrawalAddressParams & { depositoryVmType: VmType }
): string {
  const hash = keccak256(
    encodePacked(
      ["string", "bytes", "bytes", "bytes", "address", "bytes32"],
      [
        withdrawalParams.depositoryChainId,
        arrayToHex(
          encodeAddress(
            withdrawalParams.depository,
            withdrawalParams.depositoryVmType
          )
        ),
        arrayToHex(
          encodeAddress(
            withdrawalParams.currency,
            withdrawalParams.depositoryVmType
          )
        ),
        arrayToHex(
          encodeAddress(
            withdrawalParams.recipient,
            withdrawalParams.depositoryVmType
          )
        ),
        withdrawalParams.withdrawerAlias as `0x${string}`,
        `0x${BigInt(withdrawalParams.withdrawalNonce).toString(16).padStart(64, "0")}`,
      ]
    )
  )

  // get 40 bytes for an address
  const withdrawalAddress = hash.slice(2).slice(-40).toLowerCase()
  return `0x${withdrawalAddress}` as `0x${string}`
}

export function getOrderAddress(data: {
  depositChainVmType: VmType
  depositChainId: string
  depositor: string
  depositTimestamp: bigint
  depositId: string
}): string {
  const hash = keccak256(
    encodePacked(
      ["string", "bytes", "uint256", "bytes32"],
      [
        data.depositChainId,
        arrayToHex(encodeAddress(data.depositor, data.depositChainVmType)),
        BigInt(data.depositTimestamp),
        data.depositId as Hex,
      ]
    )
  )

  const orderAddress = hash.slice(2).slice(-40)
  return `0x${orderAddress}` as `0x${string}`
}

// compute a message about withdrawer balance
// to be signed as auth proof for the oracle
export function computeWithdrawerBalanceMessage(
  withdrawerAlias: string,
  amount: bigint,
  withdrawalNonce: string
) {
  return keccak256(
    encodePacked(
      ["address", "uint256", "bytes32"],
      [
        withdrawerAlias as `0x${string}`,
        BigInt(amount),
        withdrawalNonce as `0x${string}`,
      ]
    )
  )
}

// for oracle requests, we replace the hub chain id by a slug used in the oracle (e.g. 'base')
// nb: withdrawer is called 'owner' on the solver
export type WithdrawalAddressRequest = Omit<
  WithdrawalAddressParams,
  "depositoryChainId" | "amount" | "depository" | "withdrawerAlias"
> & {
  withdrawer: string
  withdrawerChainId: string
  chainId: string
}

// types for oracle routes
export type WithdrawalInitiationMessage = {
  data: WithdrawalAddressRequest & {
    expectedAmount: string
    settlementChainId: string
    signature: string
  }
  result: {
    withdrawalAddress: string
  }
}

export type WithdrawalInitiatedMessage = {
  data: WithdrawalAddressRequest & {
    expectedAmount: string
    settlementChainId: string
  }
  result: {
    proofOfWithdrawalAddressBalance: string
    withdrawalAddress: string
  }
}

// types for Hub routes
export type OnChainWithdrawalQuery = {
  data: {
    chainId: string
    payloadId: string
    payloadParams: SubmitWithdrawRequest
  }
  result: {
    encodedData: string
    signature?: string
    signer?: string
  }
}

export type OnchainWithdrawalRequest = {
  data: {
    chainId: string
    currency: string
    amount: string
    recipient: string
    spender: string
    nonce: string
    additionalData?: {
      "hyperliquid-vm"?: {
        currencyHyperliquidSymbol: string
      }
    }
    signature: string
    owner: string
    ownerChainId: string // not needed
  }
  result: {
    id: string
    encodedData: string
    payloadId: string
    submitWithdrawalRequestParams: SubmitWithdrawRequest
    signer: string
  }
}

export type OnchainWithdrawalSignatureRequest = {
  data: {
    chainId: string
    payloadId: string
    payloadParams: SubmitWithdrawRequest
  }
  result: {
    message: string
  }
}
