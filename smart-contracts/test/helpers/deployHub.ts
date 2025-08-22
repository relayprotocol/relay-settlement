import hre from 'hardhat'

export async function deployHub(options?: { owner?: `0x${string}` }) {
  const [owner] = await hre.viem.getWalletClients()

  const hub = await hre.viem.deployContract('Hub', [
    options?.owner ?? owner.account.address,
  ])

  return {
    hub,
  }
}
