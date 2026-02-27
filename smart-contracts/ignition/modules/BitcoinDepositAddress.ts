import { buildModule } from "@nomicfoundation/hardhat-ignition/modules"

const BitcoinDepositAddressModule = buildModule(
  "BitcoinDepositAddress",
  (m) => {
    const owner = m.getParameter("owner")
    const depositoryScript = m.getParameter("depositoryScript")
    const nearSigner = m.getParameter("nearSigner")
    const wNEAR = m.getParameter("wNEAR")
    const maxFeeRate = m.getParameter("maxFeeRate")

    const ChainSignatures = m.library("ChainSignatures")

    const bitcoinDepositSweepBuilder = m.contract(
      "BitcoinDepositSweepBuilder",
      [owner, depositoryScript, maxFeeRate],
      {
        libraries: {
          ChainSignatures,
        },
      }
    )

    const Codec = m.library("Codec")
    const AuroraXccUtils = m.library("AuroraXccUtils")
    const AuroraSdk = m.library("AuroraSdk", {
      libraries: {
        AuroraXccUtils,
        Codec,
      },
    })

    const bitcoinDepositAddress = m.contract(
      "BitcoinDepositAddress",
      [owner, bitcoinDepositSweepBuilder, nearSigner, wNEAR],
      {
        libraries: {
          AuroraSdk,
          ChainSignatures,
        },
      }
    )

    return { bitcoinDepositAddress, bitcoinDepositSweepBuilder }
  }
)

export default BitcoinDepositAddressModule
