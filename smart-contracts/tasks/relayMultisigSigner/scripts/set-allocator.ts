import * as networks from "@relay-protocol/networks"
import {
  createPublicClient,
  encodeFunctionData,
  http,
  parseAbi,
  parseEther,
} from "viem"

const main = async () => {
  const chains = ["ethereum"]

  const txs = await Promise.all(
    chains.map(async (chain) => {
      const rpc = createPublicClient({
        transport: http(networks.networks[chain].rpc[0]),
      })

      const fees = await rpc.estimateFeesPerGas()

      const txData = {
        amount: "0",
        calldata: encodeFunctionData({
          abi: parseAbi(["function setAllocator(address)"]),
          args: [(networks.networks["aurora"] as any).contracts.prod.allocator],
          functionName: "setAllocator",
        }),
        from: ((networks.networks["aurora"] as any).contracts.prod as any)
          .multisigSigner,
        to: (networks.networks[chain] as any).contracts.prod.depository,
      } as const

      const gas = await rpc.estimateGas({
        account: txData.from,
        data: txData.calldata,
        to: txData.to as any,
        value: parseEther(txData.amount),
      })

      return {
        family: "ethereum-vm",
        gas: gas.toString(),
        maxFeePerGas: fees!.maxFeePerGas!.toString(),
        maxPriorityFeePerGas: fees!.maxPriorityFeePerGas!.toString(),
        nonce: await rpc.getTransactionCount({ address: txData.from }),
        rpc: networks.networks[chain].rpc[0],
        ...txData,
      }
    })
  )

  console.log(JSON.stringify(txs, null, 2))
}
main()
