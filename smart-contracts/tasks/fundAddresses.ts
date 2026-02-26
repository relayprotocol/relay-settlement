import { task } from "hardhat/config"
import { parseEther } from "viem"
import { getViemClients } from "../lib/viem"

const ADDRESSES = [
  "0x1478879e95Cb06664b3dA041736203cB368fbaFa",
  "0xB22db39094DF3973373467b07eA2001f8dbadd24",
  "0x1E9bde9864148d8ce133851Cb320F2b1e4fA2355",
  "0xE3a12E9b6E3202258Ae3E8A5f2a0DD21bE0f45Dc",
  "0x8D33f0b7cF8A95b94ba5bab5624Dd533984E1458",
  "0x59e5ca486368b281B2d7b5082754A0eD6e08b43c",
  "0x8A5519468AfdFd6999b99AF6823816868E8a2222",
  "0xd2e2DC14eb8cE093A9d00e18be0C609BBaE9A4CA",
  "0xD3134257f8d3a0E0AA43578319FFE92709cB6Fe4",
  "0x7921239FB6421e17fd7680086d41E10C4092c9d1",
]

task("fund-addresses", "Fund multiple addresses with ETH")
  .addOptionalParam(
    "amount",
    "Amount in ETH to send to each address (default: 0.1)",
    "0.1"
  )
  .setAction(async ({ amount }, hre) => {
    const { publicClient, walletClients } = await getViemClients(hre)
    const [wallet] = walletClients
    const sender = wallet.account.address

    const sendAmount = parseEther(amount || "0.1")

    console.log(`Funding ${ADDRESSES.length} addresses with ${amount} ETH each`)
    console.log(`Sender: ${sender}`)
    console.log(`Network: ${hre.network.name}`)
    console.log("")

    // Check sender balance
    const balance = await publicClient.getBalance({ address: sender })
    const totalNeeded = sendAmount * BigInt(ADDRESSES.length)
    console.log(`Sender balance: ${balance / parseEther("1")} ETH`)
    console.log(`Total needed: ${totalNeeded / parseEther("1")} ETH`)
    console.log("")

    if (balance < totalNeeded) {
      throw new Error(
        `Insufficient balance. Need ${totalNeeded / parseEther("1")} ETH but have ${balance / parseEther("1")} ETH`
      )
    }

    // Send ETH to each address
    for (let i = 0; i < ADDRESSES.length; i++) {
      const address = ADDRESSES[i] as `0x${string}`
      console.log(
        `[${i + 1}/${ADDRESSES.length}] Sending ${amount} ETH to ${address}...`
      )

      try {
        const hash = await wallet.sendTransaction({
          to: address,
          value: sendAmount,
        })
        console.log(`  Transaction hash: ${hash}`)

        const receipt = await publicClient.waitForTransactionReceipt({ hash })
        console.log(`  ✓ Confirmed in block ${receipt.blockNumber}`)
      } catch (error) {
        console.error(`  ✗ Failed to send to ${address}:`, error)
        throw error
      }
    }

    console.log("")
    console.log(`✓ Successfully funded all ${ADDRESSES.length} addresses`)
  })
