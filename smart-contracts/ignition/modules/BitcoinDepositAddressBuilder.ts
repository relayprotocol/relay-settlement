import { buildModule } from "@nomicfoundation/hardhat-ignition/modules"

const BitcoinDepositAddressBuilderModule = buildModule(
  "BitcoinDepositAddressBuilder",
  (m) => {
    const owner = m.getParameter("owner")
    const depositoryScript = m.getParameter("depositoryScript")
    const nearSigner = m.getParameter("nearSigner")
    const wNEAR = m.getParameter("wNEAR")
    const maxFeeRate = m.getParameter("maxFeeRate")

    const Codec = m.library("Codec")
    const AuroraXccUtils = m.library("AuroraXccUtils")
    const ChainSignatures = m.library("ChainSignatures")
    const AuroraSdk = m.library("AuroraSdk", {
      libraries: {
        AuroraXccUtils,
        Codec,
      },
    })

    const bitcoinDepositAddressBuilder = m.contract(
      "BitcoinDepositAddressBuilder",
      [owner, depositoryScript, nearSigner, wNEAR, maxFeeRate],
      {
        libraries: {
          AuroraSdk,
          ChainSignatures,
        },
      }
    )
    return { bitcoinDepositAddressBuilder }
  }
)

export default BitcoinDepositAddressBuilderModule
