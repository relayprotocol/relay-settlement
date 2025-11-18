import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers"
import { generateAddress, generateTokenId } from "@relay-protocol/hub-utils"
import { ActionType } from "@reservoir0x/relay-protocol-sdk"
import { expect } from "chai"
import { randomBytes } from "crypto"
import hre from "hardhat"
import { Hex } from "viem"

import { deployOracle } from "../helpers/deployOracle"

import { createAction, signExecution } from "../helpers/oracle"

describe("executeMultiple", function () {
  const setup = async () => {
    const { admin, hub, oracle, utils } = await loadFixture(deployOracle)
    const wallets = await hre.viem.getWalletClients()
    const [, oracleWallet, ...otherWallets] = wallets

    const ORACLE_ROLE = await oracle.read.ORACLE_ROLE()
    await oracle.write.grantRole([ORACLE_ROLE, oracleWallet.account.address])

    const publicClient = await hre.viem.getPublicClient()

    const amount = 10n ** 18n

    const hubTokenId1 = generateTokenId({
      address: otherWallets[3].account.address,
      chainId: "1",
      family: "ethereum-vm",
    })
    const hubTokenId2 = generateTokenId({
      address: otherWallets[4].account.address,
      chainId: "1",
      family: "ethereum-vm",
    })
    const hubAddress1 = generateAddress({
      address: otherWallets[5].account.address,
      chainId: "1",
      family: "ethereum-vm",
    })
    const hubAddress2 = generateAddress({
      address: otherWallets[6].account.address,
      chainId: "1",
      family: "ethereum-vm",
    })
    const hubAddress3 = generateAddress({
      address: otherWallets[7].account.address,
      chainId: "1",
      family: "ethereum-vm",
    })
    const hubAddress4 = generateAddress({
      address: otherWallets[8].account.address,
      chainId: "1",
      family: "ethereum-vm",
    })

    const execution1Actions = [
      createAction(ActionType.MINT, {
        amount,
        hubToAddress: hubAddress1,
        hubTokenId: hubTokenId1,
      }),
      createAction(ActionType.TRANSFER, {
        amount,
        hubFromAddress: hubAddress1,
        hubToAddress: hubAddress2,
        hubTokenId: hubTokenId1,
      }),
    ]

    const execution2Actions = [
      createAction(ActionType.MINT, {
        amount,
        hubToAddress: hubAddress3,
        hubTokenId: hubTokenId2,
      }),
      createAction(ActionType.TRANSFER, {
        amount,
        hubFromAddress: hubAddress3,
        hubToAddress: hubAddress4,
        hubTokenId: hubTokenId2,
      }),
    ]

    const execution3Actions = [
      createAction(ActionType.BURN, {
        amount: amount,
        hubFromAddress: hubAddress2,
        hubTokenId: hubTokenId1,
      }),
    ]

    const idempotencyKey = () => `0x${randomBytes(32).toString("hex")}` as Hex
    return {
      admin,
      amount,
      execution1Actions,
      execution2Actions,
      execution3Actions,
      hub,
      hubAddress1,
      hubAddress2,
      hubAddress3,
      hubAddress4,
      hubTokenId1,
      hubTokenId2,
      idempotencyKey,
      oracle,
      oracleWallet,
      otherWallets,
      publicClient,
      utils,
    }
  }

  it("should execute multiple executions in one call", async () => {
    const {
      hub,
      oracle,
      oracleWallet,
      execution1Actions,
      execution2Actions,
      execution3Actions,
      publicClient,
      amount,
      idempotencyKey,
      hubAddress1,
      hubAddress2,
      hubAddress3,
      hubAddress4,
      hubTokenId1,
      hubTokenId2,
    } = await loadFixture(setup)

    const idempotencyKey1 = idempotencyKey()
    const idempotencyKey2 = idempotencyKey()
    const idempotencyKey3 = idempotencyKey()

    const signature1 = await signExecution(
      idempotencyKey1,
      execution1Actions,
      oracle.address,
      oracleWallet
    )
    const signature2 = await signExecution(
      idempotencyKey2,
      execution2Actions,
      oracle.address,
      oracleWallet
    )
    const signature3 = await signExecution(
      idempotencyKey3,
      execution3Actions,
      oracle.address,
      oracleWallet
    )

    const balance1Before = await hub.read.balanceOf([hubAddress1, hubTokenId1])
    const balance2Before = await hub.read.balanceOf([hubAddress2, hubTokenId1])
    const balance3Before = await hub.read.balanceOf([hubAddress3, hubTokenId2])
    const balance4Before = await hub.read.balanceOf([hubAddress4, hubTokenId2])

    const executeTxHash = await oracle.write.executeMultiple([
      [
        {
          actions: execution1Actions,
          idempotencyKey: idempotencyKey1,
        },
        {
          actions: execution2Actions,
          idempotencyKey: idempotencyKey2,
        },
        {
          actions: execution3Actions,
          idempotencyKey: idempotencyKey3,
        },
      ],
      [signature1, signature2, signature3],
    ])

    const balance1After = await hub.read.balanceOf([hubAddress1, hubTokenId1])
    const balance2After = await hub.read.balanceOf([hubAddress2, hubTokenId1])
    const balance3After = await hub.read.balanceOf([hubAddress3, hubTokenId2])
    const balance4After = await hub.read.balanceOf([hubAddress4, hubTokenId2])

    const logs1 = await publicClient.getContractEvents({
      abi: oracle.abi,
      address: oracle.address,
      args: {
        idempotencyKey: idempotencyKey1,
      },
      eventName: "Executed",
    })
    const logs2 = await publicClient.getContractEvents({
      abi: oracle.abi,
      address: oracle.address,
      args: {
        idempotencyKey: idempotencyKey2,
      },
      eventName: "Executed",
    })
    const logs3 = await publicClient.getContractEvents({
      abi: oracle.abi,
      address: oracle.address,
      args: {
        idempotencyKey: idempotencyKey3,
      },
      eventName: "Executed",
    })

    expect(
      Boolean(logs1.find((l) => l.transactionHash === executeTxHash))
    ).to.equal(true)
    expect(
      Boolean(logs2.find((l) => l.transactionHash === executeTxHash))
    ).to.equal(true)
    expect(
      Boolean(logs3.find((l) => l.transactionHash === executeTxHash))
    ).to.equal(true)

    expect(balance1After - balance1Before).to.equal(0n)
    expect(balance2After - balance2Before).to.equal(0n)
    expect(balance3After - balance3Before).to.equal(0n)
    expect(balance4After - balance4Before).to.equal(BigInt(amount))
  })

  it("should not revert for a single failing execution", async () => {
    const {
      amount,
      publicClient,
      oracle,
      oracleWallet,
      execution1Actions,
      execution2Actions,
      execution3Actions,
      idempotencyKey,
      hubAddress1,
      hubAddress2,
      hubTokenId2,
    } = await loadFixture(setup)

    // should fail as user has no balance
    const executionActionsFailing = [
      createAction(ActionType.TRANSFER, {
        amount,
        hubFromAddress: hubAddress1,
        hubToAddress: hubAddress2,
        hubTokenId: hubTokenId2,
      }),
    ]

    const idempotencyKey1 = idempotencyKey()
    const idempotencyKey2 = idempotencyKey()
    const idempotencyKey3 = idempotencyKey()
    const idempotencyKeyFailing = idempotencyKey()

    const signature1 = await signExecution(
      idempotencyKey1,
      execution1Actions,
      oracle.address,
      oracleWallet
    )
    const signature2 = await signExecution(
      idempotencyKey2,
      execution2Actions,
      oracle.address,
      oracleWallet
    )
    const signature3 = await signExecution(
      idempotencyKey3,
      execution3Actions,
      oracle.address,
      oracleWallet
    )
    const signatureFailing = await signExecution(
      idempotencyKeyFailing,
      executionActionsFailing,
      oracle.address,
      oracleWallet
    )

    const executeTxHash = await oracle.write.executeMultiple([
      [
        {
          actions: execution1Actions,
          idempotencyKey: idempotencyKey1,
        },
        {
          actions: execution2Actions,
          idempotencyKey: idempotencyKey2,
        },
        {
          actions: execution3Actions,
          idempotencyKey: idempotencyKey3,
        },
        {
          actions: executionActionsFailing,
          idempotencyKey: idempotencyKeyFailing,
        },
      ],
      [signature1, signature2, signature3, signatureFailing],
    ])

    const logs = await publicClient.getContractEvents({
      abi: oracle.abi,
      address: oracle.address,
      args: {
        idempotencyKey: idempotencyKey1,
      },
      eventName: "Executed",
    })

    expect(
      Boolean(logs.find((l) => l.transactionHash === executeTxHash))
    ).to.equal(true)

    const logFailing = await publicClient.getContractEvents({
      abi: oracle.abi,
      address: oracle.address,
      args: {
        idempotencyKey: idempotencyKeyFailing,
      },
      eventName: "Executed",
    })

    // no logs found
    expect(
      Boolean(logFailing.find((l) => l.transactionHash === executeTxHash))
    ).to.equal(false)
  })
})
