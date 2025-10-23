import { buildModule } from "@nomicfoundation/hardhat-ignition/modules"

const ERC20ViewModule = buildModule("ERC20View", (m) => {
  const erc20View = m.contract("ERC20View", [0n])
  return { erc20View }
})

export default ERC20ViewModule
