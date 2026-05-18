import { task } from "hardhat/config"
import { getViemClients } from "../../lib/viem"
import { mintAction } from "./helpers/oracle"

// 01 Dec 2025 - this was useful to test changes in ABI
// can be safely removed once the new oracle with `executeMultiple` support
// is deployed in production
const OLD_ABI = [
  {
    inputs: [
      {
        components: [
          { internalType: "bytes32", name: "idempotencyKey", type: "bytes32" },
          { internalType: "bytes[]", name: "actions", type: "bytes[]" },
        ],
        internalType: "struct RelayOracle.Execution",
        name: "execution",
        type: "tuple",
      },
      { internalType: "address", name: "oracle", type: "address" },
      { internalType: "bytes", name: "signature", type: "bytes" },
    ],
    name: "execute",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
]

task("oracle:test", "Send some test traffic to oracle")
  .addParam("oracle", "The address of the RelayOracle contract")
  // this `edge` param can be safely deleted when new oracle is deployed (see above)
  .addFlag("edge", "Is latest deployment version")
  .setAction(async ({ oracle: oracleAddress, edge }, hre) => {
    const { walletClients } = await getViemClients(hre)
    const [signer] = walletClients
    const { viem } = hre
    console.log(
      `Signing from ${signer.account.address} on the ${edge ? "latest" : "previous"} version of the oracle`
    )

    let executeTxHash: string

    // Start with just a MINT action to test
    // The TRANSFER will fail because we're trying to transfer from an address with no balance
    const { idempotencyKey, action, signature } = await mintAction(
      {},
      oracleAddress,
      signer
    )

    if (edge) {
      const oracle = await viem.getContractAt("RelayOracle", oracleAddress)
      executeTxHash = await oracle.write.execute([
        {
          actions: [action],
          idempotencyKey,
        },
        signature,
      ])
    } else {
      executeTxHash = await signer.writeContract({
        abi: OLD_ABI,
        address: oracleAddress as `0x${string}`,
        args: [
          {
            actions: [action],
            idempotencyKey,
          },
          signer.account.address,
          signature,
        ],
        functionName: "execute",
      })
    }

    console.log(`MINT Executed: ${executeTxHash}`)
  })
