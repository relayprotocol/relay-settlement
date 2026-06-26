import crypto from "crypto"
import { hashStruct, Hex } from "viem"

export type GenericMappingMessage = {
  user: string
  id: string
  data: string
  nonce: string
}

export const getNonceMappingMessage = (
  user: string,
  nonce: string,
  depositId: string,
  depositor?: string
): GenericMappingMessage => {
  return {
    user,
    id:
      "0x" +
      crypto
        .createHash("sha256")
        .update(`NONCE_MAPPING:${nonce}`)
        .digest()
        .toString("hex"),
    data: depositId + (depositor ? depositor.slice(2) : ""),
    nonce:
      "0x" +
      crypto
        .createHash("sha256")
        .update(`${user}:${nonce}`)
        .digest()
        .toString("hex"),
  }
}

export const getNoFillOrRefundMessage = (
  solver: string,
  orderId: string
): GenericMappingMessage => {
  return {
    user: solver,
    id:
      "0x" +
      crypto
        .createHash("sha256")
        .update(`NO_FILL_OR_REFUND:${orderId}`)
        .digest()
        .toString("hex"),
    data: "0x01",
    nonce:
      "0x" +
      crypto
        .createHash("sha256")
        .update(`${solver}:${orderId}`)
        .digest()
        .toString("hex"),
  }
}

export const getGenericMappingMessageId = (message: GenericMappingMessage) => {
  return hashStruct({
    types: {
      SetEntry: [
        { name: "user", type: "address" },
        { name: "id", type: "bytes32" },
        { name: "data", type: "bytes" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "SetEntry",
    data: {
      user: message.user as Hex,
      id: message.id as Hex,
      data: message.data as Hex,
      nonce: message.nonce as Hex,
    },
  })
}
