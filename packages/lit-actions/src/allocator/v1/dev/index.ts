import config from "./config"

import ethereumVm from "./ethereum-vm"
import solanaVm from "./solana-vm"

const code: Record<string, string> = {
  "ethereum-vm": ethereumVm,
  "solana-vm": solanaVm,
}

export { config, code }
