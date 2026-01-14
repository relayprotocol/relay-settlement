import networks from "@relay-protocol/settlement-networks"
import { task } from "hardhat/config"
import RelayMultisigSignerModule from "../../ignition/modules/RelayMultisigSignerModule"
import { parseUnits } from "viem"
import { checkAndApproveWNEAR } from "../../lib/aurora"
import { derivePublicKey } from "../../lib/near"
import { publicKeyToAddress } from "viem/accounts"
import { base58 } from "@scure/base"

task("deploy:relay-multisigs-signer", "Deploy the RelayMultisigSigner contract")
  .addOptionalParam("signer", "The address of the signer")
  .addOptionalParam("multisig", "The address of the multisig wallet")
  .addOptionalParam("wnear", "The address of the wNEAR token")
  .setAction(async ({ signer, wnear: wNEARAddress, multisig }, hre) => {
    const { ignition, network, viem, run } = hre
    await run("compile")

    const { chainId } = network.config as { chainId: bigint }
    const [owner] = await viem.getWalletClients()

    const networkConfig = networks[chainId.toString()]
    if (networkConfig && networkConfig.assets) {
      if (!wNEARAddress) {
        wNEARAddress = networkConfig.assets.wNEAR
      }
      if (!wNEARAddress) {
        throw new Error(`No wNEAR address configured for chain ID ${chainId}`)
      }
    }
    if (!signer) {
      signer = networkConfig.isTestnet ? "v1.signer-prod.testnet" : "v1.signer"
    }
    if (!multisig) {
      multisig = owner.account.address
    }

    const { relayMultisigSigner } = await ignition.deploy(
      RelayMultisigSignerModule,
      {
        parameters: {
          RelayMultisigSigner: {
            multisig,
            signer,
            wNEAR: wNEARAddress,
          },
        },
      }
    )

    console.log(
      `Relay multisig signer deployed at ${relayMultisigSigner.address}.`
    )

    await run(
      { scope: "ignition", task: "verify" },
      { deploymentId: `chain-${chainId}` }
    )

    // Approve 2 wNEAR for the allocator if necessary
    const allowance = parseUnits("2", 24)
    await checkAndApproveWNEAR(
      hre,
      owner.account.address,
      relayMultisigSigner.address,
      allowance
    )

    // check wNEAR balance
    const wNEAR = await viem.getContractAt("MyToken", wNEARAddress)
    const balance = await wNEAR.read.balanceOf([owner.account.address])
    console.log(`Current wNEAR balance: ${balance} wei`)

    if (balance < allowance) {
      throw Error(`Insufficient balance ${balance}`)
    }

    console.log("ready to initialize!")
    await relayMultisigSigner.write.init()

    console.log("Relay multisig signer initialized successfully")

    // Lets get the signature
    const derivationPath = relayMultisigSigner.address.toLowerCase()
    // remove 0x for aurora address
    const predecessor = `${relayMultisigSigner.address.substring(2).toLowerCase()}.aurora`
    const domainId = 0 // 1 for Eddsa

    // Get the public key from the NEAR contract
    const { publicKey: allocatorPublicKeyRaw } = await derivePublicKey(
      derivationPath,
      predecessor,
      Number(domainId)
    )

    // NajPublicKey to UncompressedPubKeySEC1
    const allocatorPublicKey = `0x04${Buffer.from(base58.decode(allocatorPublicKeyRaw)).toString("hex")}`

    // UncompressedPubKeySEC1 to Address
    const signerAddress = publicKeyToAddress(
      allocatorPublicKey as `0x${string}`
    )
    console.log(
      `Signer address ${signerAddress} (should be set to as from on the transactions to be submitted)`
    )

    return relayMultisigSigner.address
  })
