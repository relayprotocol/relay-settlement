import { buildModule } from "@nomicfoundation/hardhat-ignition/modules"

const HyperliquidPayloadBuilderModule = buildModule(
  "HyperLiquidPayloadBuilder",
  (m) => {
    const hyperliquidPayloadBuilder = m.contract(
      "HyperLiquidPayloadBuilder",
      [
        m.getParameter("_hyperliquidChain", "Mainnet"),
        m.getParameter(
          "_allocator",
          "0x7EdA04920F22ba6A2b9f2573fd9a6F6F1946Ff9f"
        ),
      ],
      {}
    )
    return { hyperliquidPayloadBuilder }
  }
)

export default HyperliquidPayloadBuilderModule
