import { hashTypedData, Hex, parseAbiParameters } from "viem"

import {
  AbiValues,
  decodeUnderSchema,
  defineAbiWithdrawalCodec,
  WithdrawalCodec,
} from "./codec"

export type AtlasTransferParams = {
  type: "Transfer"
  fromAccountAddress: string
  toAccountAddress: string
  assetId: string
  // Amount × 10^12, the fixed signing scale of every Atlas asset
  amount: string
  memoHead: string
  memoTail: string
}

export type DecodedAtlasVmWithdrawal = {
  vmType: "atlas-vm"
  withdrawal: {
    domainChainId: string
    domainSalt: string
    signer: string
    // Gapless owner nonce: one above the last one the depository's wallet accepted
    nonce: string
    // Unix seconds after which Atlas no longer books the transfer
    expiresAt: string
    actionType: number
    parameters: AtlasTransferParams
  }
}

type Withdrawal = DecodedAtlasVmWithdrawal["withdrawal"]

const HEADER_TUPLE =
  "(uint256 domainChainId, bytes32 domainSalt, address signer, uint64 nonce, uint64 expiresAt, uint8 actionType)"

const TRANSFER_TUPLE =
  "(address fromAccountAddress, address toAccountAddress, uint32 assetId, int128 amount, bytes32 memoHead, bytes32 memoTail)"

// Mirrors AtlasVmPayloadBuilder.sol `abi.encode(AtlasPayloadHeader, AtlasTransfer)`:
// both are static, so the transfer follows the header inline
const payloadAbiParams = parseAbiParameters(
  `${HEADER_TUPLE} header, ${TRANSFER_TUPLE} action` as const
)

type HeaderAbi = AbiValues<typeof payloadAbiParams>[0]
type TransferAbi = AbiValues<typeof payloadAbiParams>[1]

const headerToAbi = (withdrawal: Withdrawal): HeaderAbi => ({
  domainChainId: BigInt(withdrawal.domainChainId),
  domainSalt: withdrawal.domainSalt as Hex,
  signer: withdrawal.signer as Hex,
  nonce: BigInt(withdrawal.nonce),
  expiresAt: BigInt(withdrawal.expiresAt),
  actionType: withdrawal.actionType,
})

const headerFromAbi = (header: HeaderAbi): Omit<Withdrawal, "parameters"> => ({
  domainChainId: header.domainChainId.toString(),
  domainSalt: header.domainSalt,
  signer: header.signer.toLowerCase(),
  nonce: header.nonce.toString(),
  expiresAt: header.expiresAt.toString(),
  actionType: header.actionType,
})

const transferToAbi = (parameters: AtlasTransferParams): TransferAbi => ({
  fromAccountAddress: parameters.fromAccountAddress as Hex,
  toAccountAddress: parameters.toAccountAddress as Hex,
  assetId: Number(parameters.assetId),
  amount: BigInt(parameters.amount),
  memoHead: parameters.memoHead as Hex,
  memoTail: parameters.memoTail as Hex,
})

const transferFromAbi = (result: TransferAbi): AtlasTransferParams => ({
  type: "Transfer" as const,
  fromAccountAddress: result.fromAccountAddress.toLowerCase(),
  toAccountAddress: result.toAccountAddress.toLowerCase(),
  assetId: result.assetId.toString(),
  amount: result.amount.toString(),
  memoHead: result.memoHead as string,
  memoTail: result.memoTail as string,
})

const abiCodec = defineAbiWithdrawalCodec({
  params: payloadAbiParams,
  toAbi: (withdrawal: Withdrawal) => [
    headerToAbi(withdrawal),
    transferToAbi(withdrawal.parameters),
  ],
  fromAbi: ([header, action]): Withdrawal => ({
    ...headerFromAbi(header),
    parameters: transferFromAbi(action),
  }),
})

/** The Atlas transferId of a withdrawal: the EIP-712 digest of its signed transfer. */
const getAtlasTransferId = (withdrawal: Withdrawal): string => {
  const { parameters } = withdrawal

  return hashTypedData({
    domain: {
      name: "atlas",
      version: "1",
      chainId: BigInt(withdrawal.domainChainId),
      salt: withdrawal.domainSalt as Hex,
    },
    types: {
      Transaction: [
        { name: "signer", type: "address" },
        { name: "nonce", type: "NonceGapless" },
        { name: "action", type: "Transfer" },
      ],
      NonceGapless: [
        { name: "gapless_nonce", type: "uint64" },
        { name: "expires_at", type: "uint64" },
      ],
      Transfer: [
        { name: "account", type: "address" },
        { name: "toAccount", type: "address" },
        { name: "asset", type: "uint32" },
        { name: "amount", type: "int128" },
        { name: "memoHead", type: "bytes32" },
        { name: "memoTail", type: "bytes32" },
      ],
    },
    primaryType: "Transaction",
    message: {
      signer: withdrawal.signer as Hex,
      nonce: {
        gapless_nonce: BigInt(withdrawal.nonce),
        expires_at: BigInt(withdrawal.expiresAt),
      },
      action: {
        account: parameters.fromAccountAddress as Hex,
        toAccount: parameters.toAccountAddress as Hex,
        asset: Number(parameters.assetId),
        amount: BigInt(parameters.amount),
        memoHead: parameters.memoHead as Hex,
        memoTail: parameters.memoTail as Hex,
      },
    },
  })
}

export const atlasVmCodec: WithdrawalCodec<Withdrawal> = {
  encode: abiCodec.encode,

  decode: (encodedWithdrawal) => {
    const withdrawal = decodeUnderSchema(abiCodec, encodedWithdrawal)
    if (!withdrawal) {
      throw new Error("Failed to decode atlas-vm payload")
    }

    if (withdrawal.actionType !== 0) {
      throw new Error(`Unsupported Atlas action type: ${withdrawal.actionType}`)
    }

    return withdrawal
  },

  getId: getAtlasTransferId,
  getCurrency: (withdrawal) => withdrawal.parameters.assetId,
  getAmount: (withdrawal) => withdrawal.parameters.amount,
  getRecipient: (withdrawal) => withdrawal.parameters.toAccountAddress,
}
