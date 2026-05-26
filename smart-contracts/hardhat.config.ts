import "@nomicfoundation/hardhat-foundry"
import "@nomicfoundation/hardhat-viem"
import { networks as nets } from "@relay-protocol/settlement-networks"
import type { HardhatUserConfig } from "hardhat/config"

import { parseEther } from "viem"

// allocator actions
import "./tasks/allocator/addWithdrawer"
import "./tasks/allocator/init"
import "./tasks/allocator/setPayloadBuilder"
import "./tasks/allocator/signPayload"
import "./tasks/allocator/submitWithdrawRequest"
import "./tasks/allocator/withdrawToNear"
import "./tasks/depository/withdraw"
import "./tasks/depository/checkOwners"

// allocator test suite
import "./tasks/allocator/full/bitcoin"
import "./tasks/allocator/full/evm"
import "./tasks/allocator/full/hyperliquid"
import "./tasks/allocator/full/lighter"
import "./tasks/allocator/full/solana"

// hub tasks
import "./tasks/hub/add-editors"
import "./tasks/hub/add-operator"
import "./tasks/hub/hub-setup"
import "./tasks/hub/test-oracle"
import "./tasks/hub/setup-withdrawal-test"

// helpers
import "./tasks/accounts"
import "./tasks/allocator/getSignerAddress"
import "./tasks/computeSignatures"
import "./tasks/grantRole"

// Relay Multisig signer — off-chain CLI lives in packages/multisig-tools.
import type { NetworkConfig } from "@relay-protocol/settlement-sdk"

// get pk from shell
const { DEPLOYER_PRIVATE_KEY } = process.env
if (!DEPLOYER_PRIVATE_KEY) {
  console.error(
    "⚠️ Missing DEPLOYER_PRIVATE_KEY environment variable. Please set one. In the meantime, we will use default settings"
  )
} else {
  console.error(
    "⚠️ Using account from DEPLOYER_PRIVATE_KEY environment variable."
  )
}

// parse networks from file
const networks = {
  hardhat: {
    allowUnlimitedContractSize: true,
  },
}

// check if protocol onctracts are present in the network config
const PROTOCOL_CONTRACTS = ["allocator", "oracle", "multisigSigner"]
const hasProcotolContracts = (n: NetworkConfig) => {
  return [
    ...Object.keys(n.contracts?.dev || {}),
    ...Object.keys(n.contracts?.prod || {}),
  ].some((contract) => PROTOCOL_CONTRACTS.includes(contract))
}

const hasDepository = (n: NetworkConfig) =>
  !!(
    n.contracts?.dev?.depository ||
    n.contracts?.stag?.depository ||
    n.contracts?.prod?.depository
  )

Object.keys(nets)
  .filter((id: any) => {
    const network = nets[id]
    // Only process by slug (not by chainId key) to avoid duplicates
    // The nets object has both slug and chainId as keys, we only want slugs
    return (
      network &&
      network.slug === id &&
      (hasProcotolContracts(network) ||
        network.slug.includes("testnet") ||
        (network.family === "ethereum-vm" && hasDepository(network)))
    )
  })
  .forEach((id) => {
    const network = nets[id]
    const { slug, rpc, chainId } = network
    let accounts
    const networkConfig = {
      chainId: Number(chainId),
      url: rpc[0],
    }
    if (DEPLOYER_PRIVATE_KEY) {
      accounts = [DEPLOYER_PRIVATE_KEY]
    }
    networks[slug] = {
      ...networkConfig,
      accounts,
    }
  })

// parse fork URL for tests
const forkUrl = process.env.RPC_URL
if (forkUrl) {
  let accounts
  if (DEPLOYER_PRIVATE_KEY) {
    accounts = [
      {
        balance: parseEther("10000").toString(),
        privateKey: DEPLOYER_PRIVATE_KEY,
      },
    ]
  }

  // check if fork is zksync
  networks.hardhat = {
    ...networks.hardhat,
    accounts,
    forking: {
      url: forkUrl,
    },
  }
}

const config: HardhatUserConfig = {
  networks,
  solidity: {
    settings: {
      metadata: {
        appendCBOR: false,
        bytecodeHash: "none",
        useLiteralContent: true,
      },
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
    version: "0.8.28",
  },
}

// console.log(JSON.stringify(config, null, 2))
export default config
