import { task } from "hardhat/config"
import { getViemClients } from "../../lib/viem"

task("hub:setup", "Deploy and setup Hub, Oracle, and OracleMultisig contracts")
  .addOptionalParam("admin", "The admin address for Oracle and Hub contracts")
  .addOptionalParam(
    "oracleSigner",
    "The address that can submit txs to the Oracle contract"
  )
  .addOptionalParam("hub", "The address of an existing RelayHub contract")
  .addOptionalParam("oracle", "The address of an existing RelayOracle contract")
  .addOptionalParam(
    "oracleMultisig",
    "The address of an existing RelayOracleMultisig contract"
  )
  .addOptionalParam(
    "multisigSigners",
    "Comma-separated signer addresses for the RelayOracleMultisig"
  )
  .addOptionalParam(
    "multisigThreshold",
    "Signature threshold for the RelayOracleMultisig"
  )
  .setAction(
    async (
      {
        admin: adminAddress,
        oracleSigner: oracleSignerAddress,
        hub: hubAddress,
        oracle: oracleAddress,
        oracleMultisig: oracleMultisigAddress,
        multisigSigners,
        multisigThreshold,
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

      if (!oracleMultisigAddress && multisigSigners) {
        const threshold = multisigThreshold ?? "1"
        ;({ address: oracleMultisigAddress } = await run(
          "deploy:oracle-multisig",
          {
            owner: adminAddress,
            signers: multisigSigners,
            threshold,
          }
        ))
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

      if (oracleMultisigAddress) {
        await run("grant-role", {
          account: oracleMultisigAddress,
          contract: oracleAddress,
          role: "ORACLE_ROLE",
        })
      }

      console.log("\nSetup complete:")
      console.log(`  Hub:               ${hubAddress}`)
      console.log(`  Oracle:            ${oracleAddress}`)
      if (oracleMultisigAddress) {
        console.log(`  OracleMultisig:    ${oracleMultisigAddress}`)
      }
    }
  )
