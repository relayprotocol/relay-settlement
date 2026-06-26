import {
  generateAddress,
  generateTokenId,
} from "@relay-protocol/settlement-sdk"
import { ActionType } from "@relay-protocol/settlement-sdk"
import { randomBytes } from "crypto"
import { encodeAbiParameters, Hex } from "viem"

export interface MintActionData {
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
  data: Partial<MintActionData>,
  oracleAddress: string,
  oracleWallet: any
) => {
  const idempotencyKey = `0x${randomBytes(32).toString("hex")}` as Hex
  const action = createMintAction(data)

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

const createMintAction = (overrides: Partial<MintActionData> = {}) => {
  const defaultCurrency = "0x6402c4c08C1F752Ac8c91beEAF226018ec1a27f2"
  const defaultTo = "0xDF1417973462CB1E570AE080F36fCD4B43462aB0"

  const defaultHubTokenId = generateTokenId({
    address: defaultCurrency,
    chainId: "1",
    family: "ethereum-vm",
  })

  const defaultHubToAddress = generateAddress({
    address: defaultTo,
    chainId: "1",
    family: "ethereum-vm",
  })

  const data = {
    amount: 10n ** 18n,
    hubToAddress: defaultHubToAddress,
    hubTokenId: defaultHubTokenId,
    ...overrides,
  }

  return encodeAbiParameters(
    [
      { name: "actionType", type: "uint8" },
      { name: "hubToAddress", type: "address" },
      { name: "hubTokenId", type: "uint256" },
      { name: "amount", type: "uint256" },
    ],
    [
      ActionType.MINT,
      data.hubToAddress as `0x${string}`,
      BigInt(data.hubTokenId),
      BigInt(data.amount),
    ]
  ) as Hex
}
