import { networks } from "@relay-protocol/settlement-networks"
import { getContract, type PublicClient, type WalletClient } from "viem"

const ERC20_ABI = [
  {
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    name: "allowance",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    name: "approve",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const

export function getWNEARAddress(chainId: bigint | number): `0x${string}` {
  const networkConfig = networks[chainId.toString()]
  const address = networkConfig?.assets?.wNEAR
  if (!address) {
    throw new Error(`No wNEAR address configured for chain ID ${chainId}`)
  }
  return address as `0x${string}`
}

export async function checkAndApproveWNEAR(
  publicClient: PublicClient,
  walletClient: WalletClient,
  chainId: bigint | number,
  from: `0x${string}`,
  to: `0x${string}`,
  allowance: bigint = 1n
) {
  const wNEARAddress = getWNEARAddress(chainId)
  const wNEAR = getContract({
    abi: ERC20_ABI,
    address: wNEARAddress,
    client: { public: publicClient, wallet: walletClient },
  })

  const currentAllowance = (await wNEAR.read.allowance([from, to])) as bigint

  if (currentAllowance < allowance) {
    console.log(`Current wNEAR allowance: ${currentAllowance}`)
    console.log(`Approving ${allowance} wNEAR for ${to}...`)
    const approveHash = await wNEAR.write.approve([to, allowance], {} as any)
    await publicClient.waitForTransactionReceipt({ hash: approveHash })
    console.log(`✅ wNEAR approval tx: ${approveHash}`)
  }
}
