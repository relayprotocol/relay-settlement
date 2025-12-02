import { task } from "hardhat/config"

task("hub:add-editors", "Grant EDITOR_ROLE to a list of addresses")
  .addParam("hub", "The address of the Hub contract")
  .addParam(
    "accounts",
    "A coma-separated list of addresses (that will be granted the EDITOR_ROLE)"
  )
  .setAction(async ({ hub: hubAddress, accounts: accountsList }, hre) => {
    const { run } = hre

    const accounts = accountsList.split(",")
    if (!accounts.length) {
      throw Error(
        `Failed to parse accounts - should be a coma-separated list of addresses. \n Got instead: ${accountsList}`
      )
    }

    await Promise.all(
      accounts.map((account) =>
        run("grant-role", {
          account,
          contract: hubAddress,
          role: "OPERATOR_ROLE",
        })
      )
    )
  })
