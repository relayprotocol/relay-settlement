import { buildModule } from "@nomicfoundation/hardhat-ignition/modules"

const RelayOracleMultisigModule = buildModule("RelayOracleMultisig", (m) => {
  const owner = m.getParameter("owner")
  const signers = m.getParameter("signers")
  const threshold = m.getParameter("threshold")
  const oracleMultisig = m.contract("RelayOracleMultisig", [
    owner,
    signers,
    threshold,
  ])
  return { oracleMultisig }
})

export default RelayOracleMultisigModule
