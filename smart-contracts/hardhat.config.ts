import type { HardhatUserConfig } from 'hardhat/config'
import 'solidity-coverage'
import '@nomicfoundation/hardhat-toolbox-viem'
import '@nomicfoundation/hardhat-ignition'
import '@nomiclabs/hardhat-solhint'

import './tasks/exportAbis'
import './tasks/deployments/hub'

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

const etherscan = {
  apiKey: {
    arbitrumSepolia: 'W5XNFPZS8D6JZ5AXVWD4XCG8B5ZH5JCD4Y',
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
