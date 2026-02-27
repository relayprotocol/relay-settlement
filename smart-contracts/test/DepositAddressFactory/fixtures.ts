// ABOUTME: Shared test fixtures for DepositAddressFactory tests.
// ABOUTME: Deploys RelayDepository, DepositAddressFactory (which deploys DepositAddress), and test tokens.
import hre from "hardhat"
import { keccak256, toHex } from "viem"

export async function deployDepositAddressFactory() {
  const [deployer, depositor, anyone] = await hre.viem.getWalletClients()
  const publicClient = await hre.viem.getPublicClient()

  // Deploy real RelayDepository (owner=deployer, allocator=deployer)
  const depository = await hre.viem.deployContract("RelayDepository", [
    deployer.account.address,
    deployer.account.address,
  ])

  // Deploy factory (internally deploys DepositAddress implementation)
  const factory = await hre.viem.deployContract("DepositAddressFactory", [
    depository.address,
  ])

  // Get the implementation address created by the factory
  const implementationAddress = await factory.read.IMPLEMENTATION()
  const sweeper = await hre.viem.getContractAt(
    "DepositAddress",
    implementationAddress
  )

  // Deploy test ERC20
  const token = await hre.viem.deployContract("MyToken")

  const orderId = keccak256(toHex("order-1"))

  return {
    anyone,
    deployer,
    depositor,
    depository,
    factory,
    orderId,
    publicClient,
    sweeper,
    token,
  }
}
