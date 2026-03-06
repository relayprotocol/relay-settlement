import hre from "hardhat"
import { keccak256, zeroAddress } from "viem"
import { deployAllocator } from "./deployAllocator"
import { extractEvent } from "./extractEvent"

const chainId = 1n

export async function deployAllocatorSpender() {
  const { allocator, owner, otherAccounts, publicClient, wNEAR, utils } =
    await deployAllocator()

  // otherAccounts: [0] depository, [1] oracleWallet, [2] caller, [3+] others
  const [depository, oracleWallet, caller, ...remainingAccounts] = otherAccounts

  // Deploy RelayAllocatorSpender
  const spender = await hre.viem.deployContract("RelayAllocatorSpender", [
    owner.account.address,
    allocator.address,
  ])

  // Grant APPROVED_WITHDRAWER_ROLE to the spender contract on the allocator
  await allocator.write.grantRole(
    [keccak256("APPROVED_WITHDRAWER_ROLE" as `0x${string}`), spender.address],
    { account: owner.account }
  )

  // Grant ORACLE_ROLE to oracleWallet on the spender
  const ORACLE_ROLE = await spender.read.ORACLE_ROLE()
  await spender.write.grantRole([ORACLE_ROLE, oracleWallet.account.address], {
    account: owner.account,
  })

  // Deploy and set payload builder
  const payloadBuilder = await hre.viem.deployContract("DummyPayloadBuilder")
  await allocator.write.setPayloadBuilder(
    [chainId, depository.account.address, payloadBuilder.address],
    { account: owner.account }
  )

  // Set up wNEAR for signature fees
  const wNearAmount = 9000000000000000000000000n
  await wNEAR.write.mint([wNearAmount], { account: caller.account })
  await wNEAR.write.approve([allocator.address, wNearAmount], {
    account: caller.account,
  })
  // approve from owner for init()
  await wNEAR.write.approve([allocator.address, wNearAmount])

  // Submit a withdraw request so it can be signed later
  // The spender contract has APPROVED_WITHDRAWER_ROLE, so we submit via
  // someone who also has the role (grant it to caller temporarily)
  await allocator.write.grantRole(
    [
      keccak256("APPROVED_WITHDRAWER_ROLE" as `0x${string}`),
      caller.account.address,
    ],
    { account: owner.account }
  )

  const requestParams = {
    amount: 1n,
    chainId,
    currency: zeroAddress,
    data: "0x" as `0x${string}`,
    depository: depository.account.address,
    nonce: keccak256("0xnonce" as `0x${string}`),
    receiver: caller.account.address,
    spender: caller.account.address,
  }

  const txHash = await allocator.write.submitWithdrawRequest([requestParams], {
    account: caller.account,
  })
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash })
  const payloadBuiltEvent = await extractEvent(
    receipt,
    "PayloadBuilt",
    allocator.abi
  )

  return {
    allocator,
    caller,
    depository,
    oracleWallet,
    owner,
    payloadBuilder,
    publicClient,
    remainingAccounts,
    requestParams,
    spender,
    utils,
    wNEAR,
    withdrawRequestHash: payloadBuiltEvent.args.withdrawRequestHash,
  }
}
