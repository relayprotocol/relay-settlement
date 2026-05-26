import config from "./config"

import bitcoinVm from "./bitcoin-vm"
import ethereumVm from "./ethereum-vm"
import hyperliquidVm from "./hyperliquid-vm"
import solanaVm from "./solana-vm"

const code: Record<string, string> = {
  "bitcoin-vm": bitcoinVm,
  "ethereum-vm": ethereumVm,
  "hyperliquid-vm": hyperliquidVm,
  "solana-vm": solanaVm,
}

export { config, code }
