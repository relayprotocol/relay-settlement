import { buildModule } from '@nomicfoundation/hardhat-ignition/modules'

const AllocatorModule = buildModule('Allocator', (m) => {
  const owner = m.getParameter('owner')
  const delay = m.getParameter('delay')
  const signer = m.getParameter('signer')
  const wNEAR = m.getParameter('wNEAR')
  const Codec = m.library('Codec')
  const AuroraXccUtils = m.library('AuroraXccUtils')
  const ChainSignatures = m.library('ChainSignatures')
  const AuroraSdk = m.library('AuroraSdk', {
    libraries: {
      AuroraXccUtils,
      Codec,
    },
  })

  const Utils = m.library('Utils')

  const allocator = m.contract('Allocator', [owner, delay, signer, wNEAR], {
    libraries: {
      AuroraSdk,
      ChainSignatures,
      Utils,
    },
  })
  return { allocator }
})

export default AllocatorModule
