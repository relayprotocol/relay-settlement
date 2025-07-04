import '@nomicfoundation/hardhat-ignition'
import '@nomicfoundation/hardhat-toolbox-viem'
import '@nomiclabs/hardhat-solhint'
import { networks as nets } from '@relay-protocol/networks'
import type { HardhatUserConfig } from 'hardhat/config'
import 'solidity-coverage'

import { parseEther } from 'viem'

// allocator actions
import './tasks/allocator/grantHubRole'
import './tasks/allocator/init'
import './tasks/allocator/setPayloadBuilder'
import './tasks/allocator/signPayload'
import './tasks/allocator/submitWithdrawRequest'

// allocator test suite
import './tasks/allocator/full/evm'
import './tasks/allocator/full/bitcoin'
import './tasks/allocator/full/solana'
import './tasks/allocator/PayloadBuilders/sendBitcoinTx'

// deployments
import './tasks/deployments/hub'
import './tasks/deployments/allocator'

// helpers
import './tasks/computeSignatures'
import './tasks/exportAbis'

// get pk from shell
const { DEPLOYER_PRIVATE_KEY } = process.env
if (!DEPLOYER_PRIVATE_KEY) {
  console.error(
    '⚠️ Missing DEPLOYER_PRIVATE_KEY environment variable. Please set one. In the meantime, we will use default settings'
  )
} else {
  console.error(
    '⚠️ Using account from DEPLOYER_PRIVATE_KEY environment variable.'
  )
}

// https://github.com/relayprotocol/relay-vaults/blob/3085d0d1c04f1928f3e4a07e48d1687985570abd/packages/networks/src/networks/testnets/arbitrum-sepolia.ts
let accounts
if (DEPLOYER_PRIVATE_KEY) {
  accounts = [DEPLOYER_PRIVATE_KEY]
}

// parse networks from file
const networks = {
  'arbitrum-sepolia': {
    accounts,
    chainId: 421614,
    name: 'Arbitrum Sepolia',
    url: 'https://sepolia-rollup.arbitrum.io/rpc',
  },
  hardhat: {
    allowUnlimitedContractSize: true,
  },
}

Object.keys(nets).forEach((id) => {
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
        balance: parseEther('10000').toString(),
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

const etherscan = {
  apiKey: {
    arbitrumSepolia: 'W5XNFPZS8D6JZ5AXVWD4XCG8B5ZH5JCD4Y',
    auroraTestnet: 'T',
  },
}

const config: HardhatUserConfig = {
  etherscan,
  networks,
  solidity: {
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
    version: '0.8.28',
  },
  sourcify: {
    enabled: true,
  },
}

export default config
