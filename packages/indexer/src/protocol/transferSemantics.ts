import { ZeroAddress } from "ethers"

export type ProtocolTransferType = "mint" | "transfer" | "burn"
export type RelayOperation = ProtocolTransferType | "mixed"
const ZERO_ADDRESS_LOWERCASE = ZeroAddress.toLowerCase()

export const isZeroAddress = (address: string) =>
  address.toLowerCase() === ZERO_ADDRESS_LOWERCASE

export const getProtocolTransferType = (
  fromAddress: string,
  toAddress: string
): ProtocolTransferType => {
  if (isZeroAddress(fromAddress)) {
    return "mint"
  }
  if (isZeroAddress(toAddress)) {
    return "burn"
  }
  return "transfer"
}

export const deriveRelayOperation = (
  transfers: Array<{ type: ProtocolTransferType }>
): RelayOperation => {
  const transferTypes = new Set(transfers.map((transfer) => transfer.type))
  if (transferTypes.size === 1) {
    return transfers[0].type
  }
  return "mixed"
}
