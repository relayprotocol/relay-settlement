import hre from "hardhat"

export async function deployGenericMapping() {
  const [owner, oracleWallet, caller, ...remainingAccounts] =
    await hre.viem.getWalletClients()

  const store = await hre.viem.deployContract("RelayGenericMapping", [
    owner.account.address,
  ])

  // Grant ORACLE_ROLE to oracleWallet
  const ORACLE_ROLE = await store.read.ORACLE_ROLE()
  await store.write.grantRole([ORACLE_ROLE, oracleWallet.account.address], {
    account: owner.account,
  })

  const publicClient = await hre.viem.getPublicClient()

  return {
    caller,
    oracleWallet,
    owner,
    publicClient,
    remainingAccounts,
    store,
  }
}
