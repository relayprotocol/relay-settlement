import { task } from "hardhat/config"
import { Abi, toFunctionSelector, toFunctionSignature, zeroAddress } from "viem"

const showSignatures = (abi: Abi, type = "function") => {
  const functions = abi.filter((item: any) => item.type === type)
  for (const func of functions) {
    const signature = toFunctionSignature(func)
    const selector = toFunctionSelector(func)
    console.log(`${signature}: ${selector}`)
  }
}
task(
  "compute-signatures",
  "Compute function and error signatures for a contract"
)
  .addParam("contract", "The name of the contract")
  .setAction(async ({ contract: contractName }, { viem }) => {
    // Get the contract artifact
    const { abi } = await viem.getContractAt(contractName, zeroAddress)

    // Extract signatures from ABI
    console.log("Function Signatures:")
    console.log("------------------")
    showSignatures(abi)

    console.log("\nError Signatures:")
    console.log("----------------")
    showSignatures(abi, "error")

    console.log("\nEvents Signatures:")
    console.log("----------------")
    showSignatures(abi, "event")
  })
