import "@nomicfoundation/hardhat-foundry"
import "@nomicfoundation/hardhat-ignition"
import "@nomicfoundation/hardhat-toolbox-viem"
import "@nomiclabs/hardhat-solhint"
import { networks as nets } from "@relay-protocol/settlement-networks"
import "hardhat-gas-reporter"
import type { HardhatUserConfig } from "hardhat/config"
import "solidity-coverage"

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
import "./tasks/allocator/full/solana"
import "./tasks/allocator/full/sui"

// hub tasks
import "./tasks/hub/add-editors"
import "./tasks/hub/add-operator"
import "./tasks/hub/hub-setup"
import "./tasks/hub/test-oracle"

// deployments
import "./tasks/deployments/allocator"
import "./tasks/deployments/erc20View"
import "./tasks/deployments/hub"
import "./tasks/deployments/oracle"
import "./tasks/deployments/relayMultisigSigner"

// helpers
import "./tasks/allocator/getSignerAddress"
import "./tasks/computeSignatures"
import "./tasks/exportAbis"
import "./tasks/grantRole"

// Relay Multisig signer
import type { NetworkConfig } from "@relay-protocol/settlement-sdk"
import "./tasks/relayMultisigSigner/check-hashes"
import "./tasks/relayMultisigSigner/create-nonce-account"
import "./tasks/relayMultisigSigner/decode-multicall"
import "./tasks/relayMultisigSigner/execute-transactions"
import "./tasks/relayMultisigSigner/full/solana"
import "./tasks/relayMultisigSigner/full/tron"
import "./tasks/relayMultisigSigner/generate-tron-headers"
import "./tasks/relayMultisigSigner/simulate"
import "./tasks/relayMultisigSigner/solana/solana-program-upgrade-with-migration"
import "./tasks/relayMultisigSigner/submit"

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

const customChains = Object.keys(nets)
  .filter((id) => nets[id].blockExplorer)
  .map((id) => nets[id].blockExplorer)

// Build etherscan API keys from network configs
const etherscanApiKeys = Object.keys(nets).reduce(
  (acc, id) => {
    const network = nets[id]
    if (network.blockExplorer?.apiKey) {
      acc[network.blockExplorer.network] = network.blockExplorer.apiKey
    }
    return acc
  },
  { mainnet: "C1KDFD2PHN7FXXXT1AW5PG27I5JB23J41D" } as Record<string, string>
)

const etherscan = {
  apiKey: etherscanApiKeys,
  customChains,
}

// check if protocol onctracts are present in the network config
const PROTOCOL_CONTRACTS = ["allocator", "oracle", "multisigSigner"]
const hasProcotolContracts = (n: NetworkConfig) => {
  return [
    ...Object.keys(n.contracts?.dev || {}),
    ...Object.keys(n.contracts?.prod || {}),
  ].some((contract) => PROTOCOL_CONTRACTS.includes(contract))
}

Object.keys(nets)
  .filter((id: any) => {
    const network = nets[id]
    // Only process by slug (not by chainId key) to avoid duplicates
    // The nets object has both slug and chainId as keys, we only want slugs
    return (
      network &&
      network.slug === id &&
      (hasProcotolContracts(network) || network.slug.includes("testnet"))
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
  etherscan,
  ignition: {
    requiredConfirmations: 1,
  },
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
  sourcify: {
    enabled: true,
  },
}

// console.log(JSON.stringify(config, null, 2))
export default config
