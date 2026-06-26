import { task } from "hardhat/config"

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
      const { run, viem } = hre
      const [defaultAdmin] = await viem.getWalletClients()

      if (!oracleSignerAddress) {
        oracleSignerAddress = defaultAdmin.account.address
      }
      if (!adminAddress) {
        adminAddress = defaultAdmin.account.address
      }

      if (!hubAddress) {
        const hub = await viem.deployContract("RelayHub", [adminAddress])
        hubAddress = hub.address
        console.log(`RelayHub deployed to: ${hubAddress}`)
      }

      if (!oracleAddress) {
        const oracle = await viem.deployContract("RelayOracle", [
          adminAddress,
          hubAddress,
        ])
        oracleAddress = oracle.address
        console.log(`RelayOracle deployed to: ${oracleAddress}`)
      }

      if (!oracleMultisigAddress && multisigSigners) {
        const signerList = multisigSigners
          .split(",")
          .map((s: string) => s.trim())
        const threshold = Number(multisigThreshold ?? "1")
        const oracleMultisig = await viem.deployContract(
          "RelayOracleMultisig",
          [adminAddress, signerList, threshold]
        )
        oracleMultisigAddress = oracleMultisig.address
        console.log(`RelayOracleMultisig deployed to: ${oracleMultisigAddress}`)
      }

      const erc20View = await viem.deployContract("ERC20View", [0n])
      console.log(`ERC20View deployed to: ${erc20View.address}`)

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
