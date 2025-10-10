import { task } from "hardhat/config"

task("hub:setup", "Deploy and setup Hub and Oracle contracts")
  .addOptionalParam("admin", "The admin address fro Oracle and Hub contracts")
  .addOptionalParam(
    "oracleSigner",
    "The address that can submit txs to the Oracle contract"
  )
  .setAction(
    async (
      { admin: adminAddress, oracleSigner: oracleSignerAddress },
      { viem, run }
    ) => {
      const [defaultAdmin] = await viem.getWalletClients()
      if (!oracleSignerAddress) {
        oracleSignerAddress = defaultAdmin.account.address
      }
      if (!adminAddress) {
        adminAddress = defaultAdmin.account.address
      }

      // deploy contracts
      const { address: hubAddress } = await run("deploy:hub", {
        admmin: adminAddress,
      })
      const { address: oracleAddress } = await run("deploy:oracle", {
        admmin: adminAddress,
        hub: hubAddress,
      })

      // set roles
      await run("hub:add-operator", {
        account: oracleAddress,
        hub: hubAddress,
      })

      await run("grant-role", {
        account: oracleSignerAddress,
        contract: oracleAddress,
        role: "ORACLE_ROLE",
      })
    }
  )
