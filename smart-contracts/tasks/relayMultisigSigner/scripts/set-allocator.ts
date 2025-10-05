import {
  createPublicClient,
  encodeFunctionData,
  http,
  parseAbi,
  parseEther,
} from "viem"

const main = async () => {
  const rpcUrls = [
    "https://rpc.mevblocker.io",
    "https://mainnet.optimism.io",
    "https://polygon-rpc.com",
    "https://api.mainnet.abs.xyz",
    "https://mainnet.base.org",
    "https://arb1.arbitrum.io/rpc",
  ]

  const txs = await Promise.all(
    rpcUrls.map(async (rpcUrl) => {
      const rpc = createPublicClient({
        transport: http(rpcUrl),
      })

      const fees = await rpc.estimateFeesPerGas()

      const txData = {
        amount: "0",
        calldata: encodeFunctionData({
          abi: parseAbi(["function setAllocator(address)"]),
          args: ["0xe40EcC02e4Ec499393876a31E4af97fa9C069814"],
          functionName: "setAllocator",
        }),
        from: "0x16c4dEEB433bde1804d8f17cd1Ba3D29a30f9671",
        to: "0x5CB1De3603A71Ac2f67b12bFbF095013FE4Ac299",
      } as const

      const gas = await rpc.estimateGas({
        account: txData.from,
        data: txData.calldata,
        to: txData.to,
        value: parseEther(txData.amount),
      })

      return {
        family: "ethereum-vm",
        gas: gas.toString(),
        maxFeePerGas: fees!.maxFeePerGas!.toString(),
        maxPriorityFeePerGas: fees!.maxPriorityFeePerGas!.toString(),
        nonce: await rpc.getTransactionCount({ address: txData.from }),
        rpc: rpcUrl,
        ...txData,
      }
    })
  )

  console.log(JSON.stringify(txs, null, 2))
}
main()
