import type { AllocatorActionConfig } from "../../../index"

const config: AllocatorActionConfig = {
  name: "prod",
  allocatorAddress: "0x613d3c588f6b8f89302b463f8f19f7241b2857e2",
  hubEvmChainId: 537713,
  allowedOracles: [
    "0x2c598f73a5ab65c0510fd8efb740826d291cab0e",
    "0x5be2dd28f7810582ed6dc910fd8693878a1d90f2",
    "0xa41716ff5a7d4ad22f83b7cb74d9af9767a96a52",
    "0x23f1518173769d40bd24dae168c0879bd02d9b5f",
    "0xeae66bc5500976e6a681d3dd0112baba0ef95149",
  ],
  oracleSignatureThreshold: 2,
}

export default config
