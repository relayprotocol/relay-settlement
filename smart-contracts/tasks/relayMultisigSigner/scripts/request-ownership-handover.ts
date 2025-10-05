import { createPublicClient, http, parseEther } from "viem"
import axios from "axios"
const main = async () => {
  const chainIds = [
    146, 324, 360, 747, 1514, 1868, 2818, 5000, 33139, 55244, 57073, 80094,
    98866, 534352, 747474, 984122, 7777777,
  ]

  const chains = await axios("https://api.relay.link/chains").then(
    (r) => r.data.chains
  )

  const txs = await Promise.all(
    chainIds.map(async (chainId) => {
      const chain = chains.find((c: any) => c.id === chainId)
      if (chainId === 98866) chain.httpRpcUrl = "https://rpc.plume.org"
      if (chainId === 7777777) chain.httpRpcUrl = "https://rpc.zora.energy"

      const rpc = createPublicClient({
        transport: http(chain.httpRpcUrl),
      })

      const fees = await rpc.estimateFeesPerGas()

      const txData = {
        amount: "0",
        calldata: "0x25692962",
        from: "0x16c4dEEB433bde1804d8f17cd1Ba3D29a30f9671",
        to: chain.protocol.v2.depository,
      } as const

      const gas = await rpc.estimateGas({
        account: txData.from,
        data: txData.calldata,
        to: txData.to,
        value: parseEther(txData.amount),
      })

      return {
        family: "ethereum-vm",
        gas: ((gas * 110n) / 100n).toString(),
        maxFeePerGas: ((fees.maxFeePerGas * 110n) / 100n).toString(),
        maxPriorityFeePerGas: (
          (fees.maxPriorityFeePerGas * 110n) /
          100n
        ).toString(),
        nonce: await rpc.getTransactionCount({ address: txData.from }),
        rpc: chain.httpRpcUrl,
        ...txData,
      }
    })
  )

  console.log(JSON.stringify(txs, null, 2))
}
main()
