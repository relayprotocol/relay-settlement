import { Hex } from "viem"

export type Authorization = {
  expiration: bigint
  signature: Hex
}
