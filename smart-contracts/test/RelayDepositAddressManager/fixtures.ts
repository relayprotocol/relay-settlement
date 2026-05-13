// ABOUTME: Shared fixtures for RelayDepositAddressManager tests.
// ABOUTME: Deploys MockPricingOracle and RelayDepositAddressManager.
import hre from "hardhat"

export async function deployRelayDepositAddressManager() {
  const [deployer, anyone] = await hre.viem.getWalletClients()
  const publicClient = await hre.viem.getPublicClient()

  const oracle = await hre.viem.deployContract("MockPricingOracle")
  const relayDepositAddress = await hre.viem.deployContract(
    "RelayDepositAddressManager"
  )

  return {
    anyone,
    deployer,
    oracle,
    publicClient,
    relayDepositAddress,
  }
}
