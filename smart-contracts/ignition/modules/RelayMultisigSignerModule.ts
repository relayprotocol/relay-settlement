import { buildModule } from '@nomicfoundation/hardhat-ignition/modules'

const RelayMultisigSignerModule = buildModule('RelayMultisigSigner', (m) => {
  const multisig = m.getParameter('multisig')
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

  const relayMultisigSigner = m.contract(
    'RelayMultisigSigner',
    [multisig, signer, wNEAR],
    {
      libraries: {
        AuroraSdk,
        ChainSignatures,
      },
    }
  )
  return { relayMultisigSigner }
})

export default RelayMultisigSignerModule
