#!/usr/bin/env node
import { Command } from "commander"
import { registerSimulate } from "./commands/simulate"
import { registerSubmit } from "./commands/submit"
import { registerCheckHashes } from "./commands/check-hashes"
import { registerExecuteTransactions } from "./commands/execute-transactions"
import { registerDecodeMulticall } from "./commands/decode-multicall"
import { registerGenerateTronHeaders } from "./commands/generate-tron-headers"
import { registerCreateNonceAccount } from "./commands/create-nonce-account"
import { registerSolanaProgramUpgrade } from "./commands/solana-program-upgrade"

const program = new Command("multisig-tools")
  .description(
    "Build, simulate, submit, check, and execute cross-VM transactions via the Relay multisig signer."
  )
  .version("0.0.1")

registerSimulate(program)
registerSubmit(program)
registerCheckHashes(program)
registerExecuteTransactions(program)
registerDecodeMulticall(program)
registerGenerateTronHeaders(program)
registerCreateNonceAccount(program)
registerSolanaProgramUpgrade(program)

program.parseAsync(process.argv).catch((error) => {
  console.error(error)
  process.exit(1)
})
