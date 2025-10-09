import { task } from "hardhat/config"
import { decodeFunctionData, parseAbi } from "viem"
import {
  getPendingSafeTxActionsByNonce,
  createSafeClientWithConfig,
} from "../helpers/safe"

task(
  "safe:decode-multicall",
  "Decode multicall transaction data from a Safe transaction"
)
  .addOptionalParam("safeAddress", "Address of the safeAddress")
  .addOptionalParam("nonce", "Nonce of the safe transaction to decode")
  .setAction(async ({ safeAddress, nonce }, hre) => {
    if (safeAddress && nonce) {
      const safe = await createSafeClientWithConfig(hre, safeAddress)

      const safeTransactionActions = await getPendingSafeTxActionsByNonce(
        safe.apiKit,
        safeAddress,
        nonce
      )

      console.log(
        `Found ${safeTransactionActions.length} actions in Safe transaction\n`
      )

      for (let i = 0; i < safeTransactionActions.length; i++) {
        const action = safeTransactionActions[i]
        if (action.data && action.data !== "0x") {
          try {
            const abi = parseAbi([
              "function setPayloadBuilder(uint256 chainId, string depository, address builder)",
            ])
            const decoded = decodeFunctionData({
              abi,
              data: action.data,
              functionName: "setPayloadBuilder",
            })
            console.log(
              "setPayloadBuilder: \n",
              decoded.args
                .map((d, i) => ` - ${abi[0].inputs[i].name}: ${d}`)
                .join(" \n")
            )
          } catch (err) {
            console.error("Failed to decode `setPayloadBuilder`:", err)
          }
        } else {
          console.log("No data to decode")
        }
      }
      console.log(
        "Please check corrsponding addresses at https://docs.relay.link/references/protocol/depository/addresses"
      )
    } else {
      throw new Error("Need to provide both 'safeAddress' and 'nonce'")
    }
  })
