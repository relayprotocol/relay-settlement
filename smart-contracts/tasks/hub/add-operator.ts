import { task } from "hardhat/config"
import { getViemClients } from "../../lib/viem"

task("hub:add-operator", "Grant OPERATOR_ROLE to an address")
  .addParam("hub", "The address of the Hub contract")
  .addOptionalParam("account", "The address to grant the OPERATOR_ROLE to")
  .setAction(async ({ hub: hubAddress, account }, hre) => {
    const { run } = hre
    const { walletClients } = await getViemClients(hre)
    const [admin] = walletClients

    if (!account) {
      account = admin.account.address
    }

    await run("grant-role", {
      account,
      contract: hubAddress,
      role: "OPERATOR_ROLE",
    })
  })
