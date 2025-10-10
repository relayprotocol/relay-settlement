import { task } from "hardhat/config"
import { keccak256 } from "viem"

task(
  "grant-role",
  "Grant a role to an account using OpenZeppelin AccessControl"
)
  .addParam("contract", "The address of the contract with AccessControl")
  .addParam("role", "The role to grant (e.g., ADMIN_ROLE, OPERATOR_ROLE, etc.)")
  .addParam("account", "The address to grant the role to")
  .setAction(async ({ contract: contractAddress, role, account }, hre) => {
    const { viem } = hre
    const publicClient = await viem.getPublicClient()
    const contract = await viem.getContractAt("AccessControl", contractAddress)

    let roleBytes32: `0x${string}`
    if (role.startsWith("0x") && role.length === 66) {
      roleBytes32 = role as `0x${string}`
    } else {
      roleBytes32 = keccak256(role as `0x${string}`)
    }

    console.log(`Granting role ${role} (${roleBytes32}) to account ${account}`)

    // Check if the account already has the role
    const hasRole = await contract.read.hasRole([roleBytes32, account])
    if (hasRole) {
      console.log(`Account ${account} already has role ${role}`)
      return
    }

    // Grant the role
    const hash = await contract.write.grantRole([roleBytes32, account])
    console.log(`Transaction submitted: ${hash}`)

    // Wait for transaction confirmation
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    console.log(`Transaction confirmed in block: ${receipt.blockNumber}`)
    console.log(`Role ${role} successfully granted to ${account}`)
  })
