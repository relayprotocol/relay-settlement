import { buildModule } from "@nomicfoundation/hardhat-ignition/modules"

const EthereumVmPayloadBuilderModule = buildModule(
  "EthereumVmPayloadBuilder",
  (m) => {
    const config = m.getParameter("config")

    const ethereumVmPayloadBuilder = m.contract(
      "EthereumVmPayloadBuilder",
      [config],
      {}
    )

    return { ethereumVmPayloadBuilder }
  }
)

export default EthereumVmPayloadBuilderModule
