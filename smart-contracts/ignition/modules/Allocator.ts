import { buildModule } from '@nomicfoundation/hardhat-ignition/modules'

const AllocatorModule = buildModule('Allocator', (m) => {
  const owner = m.getParameter('owner')
  const delay = m.getParameter('delay')
  const allocator = m.contract('Allocator', [owner, delay])
  return { allocator }
})

export default AllocatorModule
