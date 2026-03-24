import { task } from "hardhat/config"
import { getViemClients } from "../lib/viem"

task("accounts", "Show wallet account addresses").setAction(async (_, hre) => {
  const { walletClients } = await getViemClients(hre)
  console.log(`Network: ${hre.network.name}`)
  walletClients.forEach((wallet, i) => {
    console.log(`[${i}] ${wallet.account.address}`)
  })
})
