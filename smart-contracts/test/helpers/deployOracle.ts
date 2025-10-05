import hre from "hardhat"

import { deployHub } from "./deployHub"

export async function deployOracle() {
  // We first need to deploy the Hub
  const { hub } = await deployHub()

  const [admin] = await hre.viem.getWalletClients()

  // Deploy required libraries
  const utils = await hre.viem.deployContract("Utils", [])

  // Deploy the Oracle
  const oracle = await hre.viem.deployContract(
    "Oracle",
    [admin.account.address, hub.address],
    {
      libraries: {
        Utils: utils.address,
      },
    }
  )

  // Give the Oracle permissions on the Hub
  await hub.write.grantRole([await hub.read.OPERATOR_ROLE(), oracle.address])

  return {
    admin,
    hub,
    oracle,
    utils,
  }
}
