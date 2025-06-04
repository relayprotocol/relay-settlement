import { buildModule } from '@nomicfoundation/hardhat-ignition/modules'

const AllocatorModule = buildModule('Allocator', (m) => {
  const owner = m.getParameter('owner')
  const delay = m.getParameter('delay')
  const signer = m.getParameter('signer')
  const wNEAR = m.getParameter('wNEAR')
  const Codec = m.library('Codec')
  const AuroraXccUtils = m.library('AuroraXccUtils')
  const AuroraSdk = m.library('AuroraSdk', {
    libraries: {
      AuroraXccUtils,
      Codec,
    },
  })

  const allocator = m.contract('Allocator', [owner, delay, signer, wNEAR], {
    libraries: {
      AuroraSdk,
    },
  })
  return { allocator }
})

export default AllocatorModule
