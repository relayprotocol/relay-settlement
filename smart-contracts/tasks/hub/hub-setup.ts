import { task } from "hardhat/config"
import { getViemClients } from "../../lib/viem"

task("hub:setup", "Deploy and setup Hub and Oracle contracts")
  .addOptionalParam("admin", "The admin address for Oracle and Hub contracts")
  .addOptionalParam(
    "oracleSigner",
    "The address that can submit txs to the Oracle contract"
  )
  .addOptionalParam("hub", "The address of an existing RelayHub contract")
  .addOptionalParam("oracle", "The address of an existing RelayOracle contract")
  .setAction(
    async (
      {
        admin: adminAddress,
        oracleSigner: oracleSignerAddress,
        hub: hubAddress,
        oracle: oracleAddress,
      },
      hre
    ) => {
      const { run } = hre
      const { walletClients } = await getViemClients(hre)
      const [defaultAdmin] = walletClients

      if (!oracleSignerAddress) {
        oracleSignerAddress = defaultAdmin.account.address
      }
      if (!adminAddress) {
        adminAddress = defaultAdmin.account.address
      }
      // deploy contracts
      if (!hubAddress) {
        ;({ address: hubAddress } = await run("deploy:hub", {
          admin: adminAddress,
        }))
      }

      if (!oracleAddress) {
        ;({ address: oracleAddress } = await run("deploy:oracle", {
          admin: adminAddress,
          hub: hubAddress,
        }))
      }

      await run("deploy:erc20View")

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
