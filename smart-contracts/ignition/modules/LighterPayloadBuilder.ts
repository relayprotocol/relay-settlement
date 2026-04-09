import { buildModule } from "@nomicfoundation/hardhat-ignition/modules"

const LighterPayloadBuilderModule = buildModule(
  "LighterPayloadBuilder",
  (m) => {
    const lighterPayloadBuilder = m.contract(
      "LighterPayloadBuilder",
      [
        m.getParameter("_allocator"),
        m.getParameter("_fromAccountIndex"),
        m.getParameter("_lighterGateway"),
        m.getParameter("_gatewayChainId"),
      ],
      {}
    )

    return { lighterPayloadBuilder }
  }
)

export default LighterPayloadBuilderModule
