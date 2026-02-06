import { buildModule } from "@nomicfoundation/hardhat-ignition/modules"

const BitcoinPayloadBuilderModule = buildModule(
  "BitcoinPayloadBuilder",
  (m) => {
    const bitcoinPayloadBuilder = m.contract(
      "BitcoinPayloadBuilder",
      [m.getParameter("outputScript")],
      {}
    )
    return { bitcoinPayloadBuilder }
  }
)

export default BitcoinPayloadBuilderModule
