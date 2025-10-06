import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers"
import { generateTokenId, generateAddress } from "@relay-protocol/hub-utils"
import {
  ActionType,
  encodeAction,
  VmType,
} from "@reservoir0x/relay-protocol-sdk"
import { expect } from "chai"
import { randomBytes } from "crypto"
import hre from "hardhat"
import { Hex } from "viem"

import { deployOracle } from "../helpers/deployOracle"

interface MintActionData {
  currencyVmType: VmType
  currencyChainId: string
  currency: string
  toVmType: VmType
  toChainId: string
  to: string
  amount: string
}

interface BurnActionData {
  currencyVmType: VmType
  currencyChainId: string
  currency: string
  fromVmType: VmType
  fromChainId: string
  from: string
  amount: string
}

interface TransferActionData {
  currencyVmType: VmType
  currencyChainId: string
  currency: string
  fromVmType: VmType
  fromChainId: string
  from: string
  toVmType: VmType
  toChainId: string
  to: string
  amount: string
}

describe("execute", function () {
  const setup = async () => {
    const { admin, hub, oracle, utils } = await loadFixture(deployOracle)

    const [, oracleWallet, ...otherWallets] = await hre.viem.getWalletClients()

    // Grant role
    const ORACLE_ROLE = await oracle.read.ORACLE_ROLE()
    await oracle.write.grantRole([ORACLE_ROLE, oracleWallet.account.address])

    const signExecution = async (idempotencyKey: Hex, actions: Hex[]) =>
      oracleWallet.signTypedData({
        domain: {
          chainId: await oracleWallet.getChainId(),
          name: "RelayOracle",
          verifyingContract: oracle.address,
          version: "1",
        },
        message: {
          actions,
          idempotencyKey,
        },
        primaryType: "Execution",
        types: {
          Execution: [
            {
              name: "idempotencyKey",
              type: "bytes32",
            },
            {
              name: "actions",
              type: "bytes[]",
            },
          ],
        },
      })

    const mint = async (data: MintActionData) => {
      // Create action
      const idempotencyKey = `0x${randomBytes(32).toString("hex")}` as Hex
      const action = createAction(ActionType.MINT, data)

      // Sign
      const signature = await signExecution(idempotencyKey, [action])

      return {
        action,
        idempotencyKey,
        signature,
      }
    }
    const burn = async (data: BurnActionData) => {
      // Create action
      const idempotencyKey = `0x${randomBytes(32).toString("hex")}` as Hex
      const action = createAction(ActionType.BURN, data)

      // Sign
      const signature = await signExecution(idempotencyKey, [action])

      return {
        action,
        idempotencyKey,
        signature,
      }
    }
    const transfer = async (data: TransferActionData) => {
      // Create action
      const idempotencyKey = `0x${randomBytes(32).toString("hex")}` as Hex
      const action = createAction(ActionType.TRANSFER, data)

      // Sign
      const signature = await signExecution(idempotencyKey, [action])

      return {
        action,
        idempotencyKey,
        signature,
      }
    }

    // Helper function to create action data with default values
    const createAction = (
      type: ActionType,
      overrides: Partial<
        MintActionData | BurnActionData | TransferActionData
      > = {}
    ) => {
      const defaultData = {
        amount: String(10n ** 18n),
        currency: otherWallets[0].account.address,
        currencyChainId: "1",
        currencyVmType: "ethereum-vm" as VmType,
        from: otherWallets[1].account.address,
        fromChainId: "1",
        fromVmType: "ethereum-vm" as VmType,
        to: otherWallets[1].account.address,
        toChainId: "1",
        toVmType: "ethereum-vm" as VmType,
        ...overrides,
      }

      return encodeAction({
        data: defaultData,
        type,
      }) as Hex
    }

    const publicClient = await hre.viem.getPublicClient()
    return {
      admin,
      burn,
      createAction,
      hub,
      mint,
      oracle,
      oracleWallet,
      otherWallets,
      publicClient,
      signExecution,
      transfer,
      utils,
    }
  }

  it("should execute a single mint action", async () => {
    const { hub, mint, oracle, oracleWallet, otherWallets, publicClient } =
      await loadFixture(setup)

    const currency = otherWallets[0].account.address
    const to = otherWallets[1].account.address
    const amount = String(10n ** 18n)

    const data = {
      amount,
      currency,
      currencyChainId: "1",
      currencyVmType: "ethereum-vm",
      to,
      toChainId: "1",
      toVmType: "ethereum-vm",
    } as const
    const { idempotencyKey, action, signature } = await mint(data)

    const hubTokenId = generateTokenId({
      address: data.currency,
      chainId: data.currencyChainId,
      family: data.currencyVmType,
    })
    const hubToAddress = generateAddress({
      address: data.to,
      chainId: data.toChainId,
      family: data.toVmType,
    })

    const hubBalanceBefore = await hub.read.balanceOf([
      hubToAddress,
      hubTokenId,
    ])

    // Execute
    const executeTxHash = await oracle.write.execute([
      {
        actions: [action],
        idempotencyKey,
      },
      oracleWallet.account.address,
      signature,
    ])

    const hubBalanceAfter = await hub.read.balanceOf([hubToAddress, hubTokenId])

    // Ensure an 'Executed' event was emitted with the correct idempotency key
    const logs = await publicClient.getContractEvents({
      abi: oracle.abi,
      address: oracle.address,
      args: {
        idempotencyKey,
      },
      eventName: "Executed",
    })
    expect(
      Boolean(logs.find((l) => l.transactionHash === executeTxHash))
    ).to.equal(true)

    // Ensure the difference in balance matches the execution
    expect(hubBalanceAfter - hubBalanceBefore).to.equal(BigInt(amount))
  })

  it("should execute a single burn action", async () => {
    const {
      burn,
      hub,
      mint,
      oracle,
      oracleWallet,
      otherWallets,
      publicClient,
    } = await loadFixture(setup)

    const currency = otherWallets[0].account.address
    const from = otherWallets[1].account.address
    const amount = String(10n ** 18n)

    // Need to mint before burning
    {
      const data = {
        amount,
        currency,
        currencyChainId: "1",
        currencyVmType: "ethereum-vm",
        to: from,
        toChainId: "1",
        toVmType: "ethereum-vm",
      } as const
      const { idempotencyKey, action, signature } = await mint(data)

      await oracle.write.execute([
        {
          actions: [action],
          idempotencyKey,
        },
        oracleWallet.account.address,
        signature,
      ])
    }

    const data = {
      amount,
      currency,
      currencyChainId: "1",
      currencyVmType: "ethereum-vm",
      from,
      fromChainId: "1",
      fromVmType: "ethereum-vm",
    } as const
    const { idempotencyKey, action, signature } = await burn(data)

    const hubTokenId = generateTokenId({
      address: data.currency,
      chainId: data.currencyChainId,
      family: data.currencyVmType,
    })
    const hubFromAddress = generateAddress({
      address: data.from,
      chainId: data.fromChainId,
      family: data.fromVmType,
    })

    const hubBalanceBefore = await hub.read.balanceOf([
      hubFromAddress,
      hubTokenId,
    ])

    // Execute
    const executeTxHash = await oracle.write.execute([
      {
        actions: [action],
        idempotencyKey,
      },
      oracleWallet.account.address,
      signature,
    ])

    const hubBalanceAfter = await hub.read.balanceOf([
      hubFromAddress,
      hubTokenId,
    ])

    // Ensure an 'Executed' event was emitted with the correct idempotency key
    const logs = await publicClient.getContractEvents({
      abi: oracle.abi,
      address: oracle.address,
      args: {
        idempotencyKey,
      },
      eventName: "Executed",
    })
    expect(
      Boolean(logs.find((l) => l.transactionHash === executeTxHash))
    ).to.equal(true)

    // Ensure the difference in balance matches the execution
    expect(hubBalanceBefore - hubBalanceAfter).to.equal(BigInt(amount))
  })

  it("should execute a single transfer action", async () => {
    const {
      hub,
      mint,
      oracle,
      oracleWallet,
      otherWallets,
      publicClient,
      transfer,
    } = await loadFixture(setup)

    const currency = otherWallets[0].account.address
    const from = otherWallets[1].account.address
    const to = otherWallets[2].account.address
    const amount = String(10n ** 18n)

    // Need to mint before burning
    {
      const data = {
        amount,
        currency,
        currencyChainId: "1",
        currencyVmType: "ethereum-vm",
        to: from,
        toChainId: "1",
        toVmType: "ethereum-vm",
      } as const
      const { idempotencyKey, action, signature } = await mint(data)

      await oracle.write.execute([
        {
          actions: [action],
          idempotencyKey,
        },
        oracleWallet.account.address,
        signature,
      ])
    }

    const data = {
      amount,
      currency,
      currencyChainId: "1",
      currencyVmType: "ethereum-vm",
      from,
      fromChainId: "1",
      fromVmType: "ethereum-vm",
      to,
      toChainId: "1",
      toVmType: "ethereum-vm",
    } as const
    const { idempotencyKey, action, signature } = await transfer(data)

    const hubTokenId = generateTokenId({
      address: data.currency,
      chainId: data.currencyChainId,
      family: data.currencyVmType,
    })
    const hubFromAddress = generateAddress({
      address: data.from,
      chainId: data.fromChainId,
      family: data.fromVmType,
    })
    const hubToAddress = generateAddress({
      address: data.to,
      chainId: data.toChainId,
      family: data.toVmType,
    })

    const hubFromBalanceBefore = await hub.read.balanceOf([
      hubFromAddress,
      hubTokenId,
    ])
    const hubToBalanceBefore = await hub.read.balanceOf([
      hubToAddress,
      hubTokenId,
    ])

    // Execute
    const executeTxHash = await oracle.write.execute([
      {
        actions: [action],
        idempotencyKey,
      },
      oracleWallet.account.address,
      signature,
    ])

    const hubFromBalanceAfter = await hub.read.balanceOf([
      hubFromAddress,
      hubTokenId,
    ])
    const hubToBalanceAfter = await hub.read.balanceOf([
      hubToAddress,
      hubTokenId,
    ])

    // Ensure an 'Executed' event was emitted with the correct idempotency key
    const logs = await publicClient.getContractEvents({
      abi: oracle.abi,
      address: oracle.address,
      args: {
        idempotencyKey,
      },
      eventName: "Executed",
    })
    expect(
      Boolean(logs.find((l) => l.transactionHash === executeTxHash))
    ).to.equal(true)

    // Ensure the difference in balance matches the execution
    expect(hubFromBalanceBefore - hubFromBalanceAfter).to.equal(BigInt(amount))
    expect(hubToBalanceAfter - hubToBalanceBefore).to.equal(BigInt(amount))
  })

  it("should execute multiple actions in one call", async () => {
    const {
      hub,
      createAction,
      oracle,
      oracleWallet,
      otherWallets,
      publicClient,
      signExecution,
    } = await loadFixture(setup)

    const mintTo1 = otherWallets[1].account.address
    const mintTo2 = otherWallets[2].account.address
    const mintTo3 = otherWallets[3].account.address
    const transferTo = otherWallets[4].account.address

    // Create multiple actions: 3 mints, 1 transfer, 1 burn
    const actions = [
      // Mint 1
      createAction(ActionType.MINT, { to: mintTo1 }),
      // Mint 2
      createAction(ActionType.MINT, { to: mintTo2 }),
      // Mint 3
      createAction(ActionType.MINT, { to: mintTo3 }),
      // Transfer
      createAction(ActionType.TRANSFER, { from: mintTo1, to: transferTo }),
      // Burn
      createAction(ActionType.BURN, { from: transferTo }),
    ]

    // Create single idempotency key and signature for all actions
    const idempotencyKey = `0x${randomBytes(32).toString("hex")}` as Hex
    const signature = await signExecution(idempotencyKey, actions)

    // Get hub addresses for balance tracking
    const currency = otherWallets[0].account.address
    const amount = String(10n ** 18n)
    const hubTokenId = generateTokenId({
      address: currency,
      chainId: "1",
      family: "ethereum-vm",
    })
    const hubMintTo1Address = generateAddress({
      address: mintTo1,
      chainId: "1",
      family: "ethereum-vm",
    })
    const hubMintTo2Address = generateAddress({
      address: mintTo2,
      chainId: "1",
      family: "ethereum-vm",
    })
    const hubMintTo3Address = generateAddress({
      address: mintTo3,
      chainId: "1",
      family: "ethereum-vm",
    })
    const hubTransferToAddress = generateAddress({
      address: transferTo,
      chainId: "1",
      family: "ethereum-vm",
    })

    // Get balances before execution
    const mintTo1BalanceBefore = await hub.read.balanceOf([
      hubMintTo1Address,
      hubTokenId,
    ])
    const mintTo2BalanceBefore = await hub.read.balanceOf([
      hubMintTo2Address,
      hubTokenId,
    ])
    const mintTo3BalanceBefore = await hub.read.balanceOf([
      hubMintTo3Address,
      hubTokenId,
    ])
    const transferToBalanceBefore = await hub.read.balanceOf([
      hubTransferToAddress,
      hubTokenId,
    ])

    // Execute all actions in one call
    const executeTxHash = await oracle.write.execute([
      {
        actions,
        idempotencyKey,
      },
      oracleWallet.account.address,
      signature,
    ])

    // Get balances after execution
    const mintTo1BalanceAfter = await hub.read.balanceOf([
      hubMintTo1Address,
      hubTokenId,
    ])
    const mintTo2BalanceAfter = await hub.read.balanceOf([
      hubMintTo2Address,
      hubTokenId,
    ])
    const mintTo3BalanceAfter = await hub.read.balanceOf([
      hubMintTo3Address,
      hubTokenId,
    ])
    const transferToBalanceAfter = await hub.read.balanceOf([
      hubTransferToAddress,
      hubTokenId,
    ])

    // Ensure an 'Executed' event was emitted with the correct idempotency key
    const logs = await publicClient.getContractEvents({
      abi: oracle.abi,
      address: oracle.address,
      args: {
        idempotencyKey,
      },
      eventName: "Executed",
    })
    expect(
      Boolean(logs.find((l) => l.transactionHash === executeTxHash))
    ).to.equal(true)

    // Verify balance changes
    // Mint 1: mintTo1 should have +amount from mint, then -amount from transfer, net effect is 0
    expect(mintTo1BalanceAfter - mintTo1BalanceBefore).to.equal(0n)

    // Mint 2: mintTo2 should have +amount
    expect(mintTo2BalanceAfter - mintTo2BalanceBefore).to.equal(BigInt(amount))

    // Mint 3: mintTo3 should have +amount
    expect(mintTo3BalanceAfter - mintTo3BalanceBefore).to.equal(BigInt(amount))

    // Transfer: transferTo should have +amount from transfer, then -amount from burn, net effect is 0
    expect(transferToBalanceAfter - transferToBalanceBefore).to.equal(0n)
  })

  it("should fail to execute the same idempotency key multiple times", async () => {
    const { mint, oracle, oracleWallet, otherWallets } =
      await loadFixture(setup)

    const currency = otherWallets[0].account.address
    const from = otherWallets[1].account.address
    const amount = String(10n ** 18n)

    const data = {
      amount,
      currency,
      currencyChainId: "1",
      currencyVmType: "ethereum-vm",
      to: from,
      toChainId: "1",
      toVmType: "ethereum-vm",
    } as const
    const { idempotencyKey, action, signature } = await mint(data)

    await oracle.write.execute([
      {
        actions: [action],
        idempotencyKey,
      },
      oracleWallet.account.address,
      signature,
    ])

    await expect(
      oracle.write.execute([
        {
          actions: [action],
          idempotencyKey,
        },
        oracleWallet.account.address,
        signature,
      ])
    ).to.be.rejectedWith("AlreadyExecuted")
  })

  it("should fail to execute if the signature is invalid", async () => {
    const { mint, oracle, oracleWallet, otherWallets } =
      await loadFixture(setup)

    const currency = otherWallets[0].account.address
    const from = otherWallets[1].account.address
    const amount = String(10n ** 18n)

    const data = {
      amount,
      currency,
      currencyChainId: "1",
      currencyVmType: "ethereum-vm",
      to: from,
      toChainId: "1",
      toVmType: "ethereum-vm",
    } as const
    const { idempotencyKey, action } = await mint(data)

    await expect(
      oracle.write.execute([
        {
          actions: [action],
          idempotencyKey,
        },
        oracleWallet.account.address,
        `0x${randomBytes(65).toString("hex")}`,
      ])
    ).to.be.rejectedWith("InvalidSignature")
  })
})
