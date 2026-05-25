import { buildModule } from "@nomicfoundation/hardhat-ignition/modules"

const TonVmPayloadBuilderModule = buildModule("TonVmPayloadBuilder", (m) => {
  const subwalletId = m.getParameter("subwalletId")
  const timeout = m.getParameter("timeout")

  const tonVmPayloadBuilder = m.contract(
    "TonVmPayloadBuilder",
    [subwalletId, timeout],
    {}
  )

  return { tonVmPayloadBuilder }
})

export default TonVmPayloadBuilderModule
