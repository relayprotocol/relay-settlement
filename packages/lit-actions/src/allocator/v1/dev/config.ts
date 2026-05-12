import type { AllocatorActionConfig } from "../../../index"

const config: AllocatorActionConfig = {
  name: "dev",
  allocatorAddress: "0x357dfbec07a628e934bdb3642056fd72f10a7902",
  hubEvmChainId: 421614,
  allowedOracles: [
    "0xcda3c24706c1a5eea958a988693e8a838d520af9",
    "0xf24a399259f47c6360d00da3793eca9cc6ad1caa",
  ],
  oracleSignatureThreshold: 2,
}

export default config
