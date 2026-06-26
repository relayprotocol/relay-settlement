import { task } from "hardhat/config"
import { keccak256 } from "viem"
import { getViemClients } from "../lib/viem"

task(
  "renounce-role",
  "Renounce a role from the sender account using OpenZeppelin AccessControl"
)
  .addParam("contract", "The address of the contract with AccessControl")
  .addParam(
    "role",
    "The role to renounce (e.g., ADMIN_ROLE, OPERATOR_ROLE, etc.)"
  )
  .setAction(async ({ contract: contractAddress, role }, hre) => {
    const { viem } = hre
    const { publicClient, walletClients } = await getViemClients(hre)
    const [wallet] = walletClients
    const account = wallet.account.address
    const contract = await viem.getContractAt(
      "AccessControl",
      contractAddress,
      {
        client: {
          public: publicClient,
          wallet,
        },
      }
    )

    let roleBytes32: `0x${string}`
    if (role.startsWith("0x") && role.length === 66) {
      roleBytes32 = role as `0x${string}`
    } else {
      roleBytes32 = keccak256(role as `0x${string}`)
    }

    console.log(
      `Renouncing role ${role} (${roleBytes32}) from account ${account}`
    )

    // Check if the account has the role
    const hasRole = await contract.read.hasRole([roleBytes32, account])
    if (!hasRole) {
      console.log(`Account ${account} does not have role ${role}`)
      return
    }

    const hash = await contract.write.renounceRole([roleBytes32, account])
    console.log(`Transaction submitted: ${hash}`)

    // Wait for transaction confirmation
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    console.log(`Transaction confirmed in block: ${receipt.blockNumber}`)
    console.log(`Role ${role} successfully renounced from ${account}`)
  })
