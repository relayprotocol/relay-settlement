import { buildModule } from "@nomicfoundation/hardhat-ignition/modules"

const SolanaPayloadBuilderModule = buildModule("SolanaPayloadBuilder", (m) => {
  const solanaPayloadBuilder = m.contract(
    "SolanaPayloadBuilder",
    [
      m.getParameter(
        "_allocator",
        "0x7EdA04920F22ba6A2b9f2573fd9a6F6F1946Ff9f"
      ),
    ],
    {}
  )
  return { solanaPayloadBuilder }
})

export default SolanaPayloadBuilderModule
