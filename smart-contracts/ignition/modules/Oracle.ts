import { buildModule } from '@nomicfoundation/hardhat-ignition/modules'

const OracleModule = buildModule('Oracle', (m) => {
  const admin = m.getParameter('admin')
  const hub = m.getParameter('hub')
  const oracle = m.contract('Oracle', [admin, hub])
  return { oracle }
})

export default OracleModule
