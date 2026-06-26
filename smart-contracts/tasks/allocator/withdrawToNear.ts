import { task } from "hardhat/config"
import { formatUnits } from "viem"
import { checkAndApproveWNEAR, getWNEARAddress } from "../../lib/aurora"

task("allocator:withdraw-to-near", "Withdraw balance to NEAR")
  .addParam("allocator", "The address of the allocator contract")
  .addOptionalParam("amount", "The amount of wNEAR to withdraw")
  .setAction(async ({ allocator: allocatorAddress, amount }, hre) => {
    const { viem, network } = hre
    const [signer] = await viem.getWalletClients()
    const publicClient = await viem.getPublicClient()
    const wNEARAddress = await getWNEARAddress(network.config.chainId!)

    const allocator = await viem.getContractAt(
      "RelayAllocator",
      allocatorAddress
    )

    const wNEAR = await viem.getContractAt("MyToken", wNEARAddress)

    // check wNEAR balance
    const allocatorBalance = await wNEAR.read.balanceOf([allocator.address])
    console.log(
      `Allocator wNEAR balance: ${formatUnits(allocatorBalance, 24)} wNEAR`
    )

    // remove 1 yNEAR to pay for Aurora call
    const amountToWithdraw = (amount ? BigInt(amount) : allocatorBalance) - 1n
    console.log(`Withdrawing ${formatUnits(amountToWithdraw, 24)} to NEAR...`)

    // approve 1 yNEAR to pay for Aurora call
    await checkAndApproveWNEAR(
      hre,
      publicClient,
      signer.account.address,
      allocator.address,
      1n
    )

    const withdrawalHash = await allocator.write.withdrawToNear([
      amountToWithdraw,
    ])
    await publicClient.waitForTransactionReceipt({ hash: withdrawalHash })
    console.log(`Amount withdraw successfully: ${withdrawalHash}`)
  })
