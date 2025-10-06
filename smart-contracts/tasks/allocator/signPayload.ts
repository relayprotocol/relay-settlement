import { task } from "hardhat/config"
import { parseUnits, zeroAddress } from "viem"
import { checkAndApproveWNEAR, getWNEARAddress } from "../../lib/aurora"

task("allocator:sign-payload", "Sign payload on allocator")
  .addParam("allocator", "The address of the allocator contract")
  .addParam("chainId", "The chain id of the destination address")
  .addParam("depository", "The depository contract on destination chain")
  .addParam("nonce", "The nonce for the request submitted earlier")
  .addOptionalParam("currency", "default to zero", zeroAddress)
  .addOptionalParam("amount", "Amount to withdraw", "1")
  .addOptionalParam("receiver", "account to receive tokens (default to signer)")
  .addOptionalParam("data", "additional data", "0x")
  .addOptionalParam("wnear", "The address of the wNEAR contract")
  .addOptionalParam(
    "spender",
    "the address that spends tokens on the hub",
    zeroAddress
  )
  .setAction(
    async (
      {
        allocator: allocatorAddress,
        chainId,
        depository,
        currency,
        amount,
        receiver,
        data,
        wnear: wNEARAddress,
        nonce,
        spender,
      },
      hre
    ) => {
      const { viem, network } = hre
      const [signer] = await viem.getWalletClients()
      const publicClient = await viem.getPublicClient()

      const allocator = await viem.getContractAt(
        "RelayAllocator",
        allocatorAddress
      )

      if (!wNEARAddress) {
        wNEARAddress = await getWNEARAddress(network.config.chainId!)
      }

      // check wNEAR approval amount
      const allowance = parseUnits("1", 24)
      await checkAndApproveWNEAR(
        hre,
        signer.account.address,
        allocatorAddress,
        allowance
      )

      const submitWithdrawRequestParams = {
        amount,
        chainId,
        currency,
        data,
        depository,
        nonce,
        receiver: receiver || signer.account.address,
        spender: spender || receiver || signer.account.address,
      }

      // approve sig fee
      const signatureFee = await allocator.read.signatureFee()

      if (signatureFee > 0n) {
        await checkAndApproveWNEAR(
          hre,
          signer.account.address,
          allocatorAddress,
          signatureFee
        )
      }

      console.log("Signing payload", submitWithdrawRequestParams)

      const wNEAR = await hre.viem.getContractAt("MyToken", wNEARAddress)
      // Funding a bit more for the signatures!
      const balance = await wNEAR.read.balanceOf([allocatorAddress])
      if (balance === 0n) {
        console.log(
          "Funding allocator with 1 1yoctoNear for the signature calls"
        )
        const fundTx = await wNEAR.write.transfer([allocatorAddress, 1n])
        await publicClient.waitForTransactionReceipt({
          hash: fundTx,
        })
      }

      const txHash = await allocator.write.signWithdrawPayload(
        [
          submitWithdrawRequestParams,
          "0x",
          {
            callbackGas: 50_000_000_000_000n,
            signGas: 10_000_000_000_000n,
          },
        ],
        {
          account: signer.account,
        }
      )
      console.log(txHash)

      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
      })
      console.log("Signing Transaction:", receipt.transactionHash)
    }
  )
