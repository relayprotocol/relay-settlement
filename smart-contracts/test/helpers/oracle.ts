import { generateAddress, generateTokenId } from "@relay-protocol/hub-utils"
import { ActionType } from "@reservoir0x/relay-protocol-sdk"
import { randomBytes } from "crypto"
import { encodeAbiParameters, Hex } from "viem"

export interface MintActionData {
  hubToAddress: string
  hubTokenId: string | bigint
  amount: string | bigint
}

export interface BurnActionData {
  hubFromAddress: string
  hubTokenId: string | bigint
  amount: string | bigint
}

export interface TransferActionData {
  hubFromAddress: string
  hubToAddress: string
  hubTokenId: string | bigint
  amount: string | bigint
}

export const signExecution = async (
  idempotencyKey: Hex,
  actions: Hex[],
  oracleAddress: string,
  oracleWallet: any
) =>
  oracleWallet.signTypedData({
    domain: {
      chainId: await oracleWallet.getChainId(),
      name: "RelayOracle",
      verifyingContract: oracleAddress,
      version: "1",
    },
    message: {
      actions,
      idempotencyKey,
    },
    primaryType: "Execution",
    types: {
      Execution: [
        {
          name: "idempotencyKey",
          type: "bytes32",
        },
        {
          name: "actions",
          type: "bytes[]",
        },
      ],
    },
  })

export const mintAction = async (
  data: MintActionData,
  oracleAddress: string,
  oracleWallet: any
) => {
  // Create action
  const idempotencyKey = `0x${randomBytes(32).toString("hex")}` as Hex
  const action = createAction(ActionType.MINT, data)

  // Sign
  const signature = await signExecution(
    idempotencyKey,
    [action],
    oracleAddress,
    oracleWallet
  )

  return {
    action,
    idempotencyKey,
    signature,
  }
}

export const burnAction = async (
  data: BurnActionData,
  oracleAddress: string,
  oracleWallet: any
) => {
  // Create action
  const idempotencyKey = `0x${randomBytes(32).toString("hex")}` as Hex
  const action = createAction(ActionType.BURN, data)

  // Sign
  const signature = await signExecution(
    idempotencyKey,
    [action],
    oracleAddress,
    oracleWallet
  )

  return {
    action,
    idempotencyKey,
    signature,
  }
}

export const transferAction = async (
  data: TransferActionData,
  oracleAddress: string,
  oracleWallet: any
) => {
  // Create action
  const idempotencyKey = `0x${randomBytes(32).toString("hex")}` as Hex
  const action = createAction(ActionType.TRANSFER, data)

  // Sign
  const signature = await signExecution(
    idempotencyKey,
    [action],
    oracleAddress,
    oracleWallet
  )

  return {
    action,
    idempotencyKey,
    signature,
  }
}

// Helper function to create action data with default values
export const createAction = (
  type: ActionType,
  overrides: Partial<MintActionData | BurnActionData | TransferActionData> = {}
) => {
  // Generate default hub addresses and token ID
  const defaultCurrency = "0x6402c4c08C1F752Ac8c91beEAF226018ec1a27f2"
  const defaultFrom = "0xA98308F10b7850bDBEBcE707E70dD3A3aE832cc6"
  const defaultTo = "0xDF1417973462CB1E570AE080F36fCD4B43462aB0"

  const defaultHubTokenId = generateTokenId({
    address: defaultCurrency,
    chainId: "1",
    family: "ethereum-vm",
  })

  const defaultHubFromAddress = generateAddress({
    address: defaultFrom,
    chainId: "1",
    family: "ethereum-vm",
  })

  const defaultHubToAddress = generateAddress({
    address: defaultTo,
    chainId: "1",
    family: "ethereum-vm",
  })

  const defaultData = {
    amount: 10n ** 18n,
    hubFromAddress: defaultHubFromAddress,
    hubToAddress: defaultHubToAddress,
    hubTokenId: defaultHubTokenId,
    ...overrides,
  }

  // Manually encode the action data to match what the contract expects
  if (type === ActionType.MINT) {
    return encodeAbiParameters(
      [
        { name: "actionType", type: "uint8" },
        { name: "hubToAddress", type: "address" },
        { name: "hubTokenId", type: "uint256" },
        { name: "amount", type: "uint256" },
      ],
      [
        type,
        defaultData.hubToAddress as `0x${string}`,
        BigInt(defaultData.hubTokenId),
        BigInt(defaultData.amount),
      ]
    ) as Hex
  } else if (type === ActionType.BURN) {
    return encodeAbiParameters(
      [
        { name: "actionType", type: "uint8" },
        { name: "hubFromAddress", type: "address" },
        { name: "hubTokenId", type: "uint256" },
        { name: "amount", type: "uint256" },
      ],
      [
        type,
        defaultData.hubFromAddress as `0x${string}`,
        BigInt(defaultData.hubTokenId),
        BigInt(defaultData.amount),
      ]
    ) as Hex
  } else if (type === ActionType.TRANSFER) {
    return encodeAbiParameters(
      [
        { name: "actionType", type: "uint8" },
        { name: "hubFromAddress", type: "address" },
        { name: "hubToAddress", type: "address" },
        { name: "hubTokenId", type: "uint256" },
        { name: "amount", type: "uint256" },
      ],
      [
        type,
        defaultData.hubFromAddress as `0x${string}`,
        defaultData.hubToAddress as `0x${string}`,
        BigInt(defaultData.hubTokenId),
        BigInt(defaultData.amount),
      ]
    ) as Hex
  }

  throw new Error(`Unknown action type: ${type}`)
}
