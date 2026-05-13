// ABOUTME: Shared fixture for SignedPricingOracle tests.
// ABOUTME: Deploys SignedPricingOracle bound to a designated solver wallet.
import hre from "hardhat"

export async function deploySignedPricingOracle() {
  const [deployer, solver, anyone] = await hre.viem.getWalletClients()
  const publicClient = await hre.viem.getPublicClient()

  const signedPricingOracle = await hre.viem.deployContract(
    "SignedPricingOracle",
    [solver.account.address]
  )

  return {
    anyone,
    deployer,
    publicClient,
    signedPricingOracle,
    solver,
  }
}
