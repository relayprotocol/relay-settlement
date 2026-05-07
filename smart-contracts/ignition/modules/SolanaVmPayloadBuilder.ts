import { buildModule } from "@nomicfoundation/hardhat-ignition/modules"

const SolanaVmPayloadBuilderModule = buildModule(
  "SolanaVmPayloadBuilder",
  (m) => {
    const config = m.getParameter("config")

    const solanaVmPayloadBuilder = m.contract(
      "SolanaVmPayloadBuilder",
      [config],
      {}
    )

    return { solanaVmPayloadBuilder }
  }
)

export default SolanaVmPayloadBuilderModule
