import { buildModule } from '@nomicfoundation/hardhat-ignition/modules'

const HubModule = buildModule('Hub', (m) => {
  const admin = m.getParameter('admin')
  const hub = m.contract('Hub', [admin])
  return { hub }
})

export default HubModule
