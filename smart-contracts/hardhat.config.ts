import "@nomicfoundation/hardhat-ignition"
import "@nomicfoundation/hardhat-toolbox-viem"
import "@nomiclabs/hardhat-solhint"
import { networks as nets } from "@relay-protocol/networks"
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

// allocator test suite
import "./tasks/allocator/full/bitcoin"
import "./tasks/allocator/full/evm"
import "./tasks/allocator/full/hyperliquid"
import "./tasks/allocator/full/solana"
import "./tasks/allocator/full/sui"

// hub tasks
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
import { NetworkConfig } from "@relay-protocol/types"
import "./tasks/relayMultisigSigner/check-hashes"
import "./tasks/relayMultisigSigner/create-nonce-account"
import "./tasks/relayMultisigSigner/decode-multicall"
import "./tasks/relayMultisigSigner/execute-transactions"
import "./tasks/relayMultisigSigner/simulate"
import "./tasks/relayMultisigSigner/submit"
import "./tasks/relayMultisigSigner/solana/solana-program-upgrade-with-migration"
import "./tasks/relayMultisigSigner/full/solana"

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

const etherscan = {
  apiKey: "C1KDFD2PHN7FXXXT1AW5PG27I5JB23J41D",
  customChains,
}

// check if protocol onctracts are present in the network config
const PROTOCOL_CONTRACTS = ["allocator", "oracle"]
const hasProcotolContracts = (n: NetworkConfig) => {
  return [
    ...Object.keys(n.contracts?.dev || {}),
    ...Object.keys(n.contracts?.prod || {}),
  ].some((contract) => PROTOCOL_CONTRACTS.includes(contract))
}

Object.keys(nets)
  // we only "hub" networks to manage our contracts here
  .filter((id: any) => hasProcotolContracts(nets[id]))
  .forEach((id) => {
    const { slug, rpc } = nets[id]
    let accounts
    const network = {
      chainId: Number(id),
      url: rpc[0],
    }
    if (DEPLOYER_PRIVATE_KEY) {
      accounts = [DEPLOYER_PRIVATE_KEY]
    }
    networks[slug] = {
      ...network,
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
