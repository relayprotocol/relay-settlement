import { createPublicClient, http, parseEther } from "viem"

import axios from "axios"
import { ErrorType } from "viem/_types/errors/utils"

const main = async () => {
  const chainIds = [1101, 42170]

  const chains = await axios("https://api.relay.link/chains").then(
    (r) => r.data.chains
  )

  const txs = await Promise.all(
    chainIds.map(async (chainId) => {
      try {
        const chain = chains.find((c: any) => c.id === chainId)
        if (chainId === 480)
          chain.httpRpcUrl = "https://worldchain-mainnet.g.alchemy.com/public"

        const rpc = createPublicClient({
          transport: http(chain.httpRpcUrl),
        })

        const fees = await rpc.estimateFeesPerGas().catch(async (error) => {
          if (
            (error as ErrorType).name?.includes("Eip1559FeesNotSupportedError")
          ) {
            return {
              gasPrice: await rpc.getGasPrice(),
              maxFeePerGas: undefined,
              maxPriorityFeePerGas: undefined,
            }
          }

          throw error
        })

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
          gasPrice: fees.gasPrice
            ? ((fees.gasPrice! * 110n) / 100n).toString()
            : undefined,
          maxFeePerGas: fees.maxFeePerGas
            ? ((fees.maxFeePerGas * 110n) / 100n).toString()
            : undefined,
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas
            ? ((fees.maxPriorityFeePerGas * 110n) / 100n).toString()
            : undefined,
          nonce: await rpc.getTransactionCount({ address: txData.from }),
          rpc: chain.httpRpcUrl,
          ...txData,
        }
      } catch (error) {
        console.error(chainId, error)
        throw error
      }
    })
  )

  console.log(JSON.stringify(txs, null, 2))
}
main()
