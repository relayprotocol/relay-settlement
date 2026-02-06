import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers"
import {
  ActionType,
  generateAddress,
  generateTokenId,
} from "@relay-protocol/settlement-sdk"
import { expect } from "chai"
import { randomBytes } from "crypto"
import hre from "hardhat"
import { Hex, concat, encodeAbiParameters } from "viem"

import { deployHub } from "../helpers/deployHub"

describe("RelayOracleMultisig - integration with RelayOracle", function () {
  const setup = async () => {
    // Deploy Hub
    const { hub } = await deployHub()

    // Get wallets
    const wallets = await hre.viem.getWalletClients()
    const [admin, signer1, signer2, signer3, recipient] = wallets

    // Sort signers by address
    const signerWallets = [signer1, signer2, signer3].sort((a, b) =>
      a.account.address.toLowerCase() < b.account.address.toLowerCase() ? -1 : 1
    )
    const signerAddresses = signerWallets.map((w) => w.account.address)

    // Deploy multisig (2 of 3)
    const multisig = await hre.viem.deployContract("RelayOracleMultisig", [
      admin.account.address,
      signerAddresses,
      2n,
    ])

    // Deploy Oracle
    const oracle = await hre.viem.deployContract("RelayOracle", [
      admin.account.address,
      hub.address,
    ])

    // Grant ORACLE_ROLE to the multisig
    const ORACLE_ROLE = await oracle.read.ORACLE_ROLE()
    await oracle.write.grantRole([ORACLE_ROLE, multisig.address])

    // Grant OPERATOR_ROLE to the oracle on the hub
    await hub.write.grantRole([await hub.read.OPERATOR_ROLE(), oracle.address])

    const publicClient = await hre.viem.getPublicClient()

    return {
      admin,
      hub,
      multisig,
      oracle,
      publicClient,
      recipient,
      signerAddresses,
      signerWallets,
    }
  }

  // Helper to create action
  const createMintAction = (
    hubToAddress: string,
    hubTokenId: bigint,
    amount: bigint
  ): Hex => {
    return encodeAbiParameters(
      [
        { name: "actionType", type: "uint8" },
        { name: "hubToAddress", type: "address" },
        { name: "hubTokenId", type: "uint256" },
        { name: "amount", type: "uint256" },
      ],
      [ActionType.MINT, hubToAddress as `0x${string}`, hubTokenId, amount]
    )
  }

  // Helper to sign execution with EIP-712
  const signExecution = async (
    wallet: any,
    oracleAddress: Hex,
    idempotencyKey: Hex,
    actions: Hex[]
  ): Promise<Hex> => {
    const chainId = await wallet.getChainId()

    return wallet.signTypedData({
      domain: {
        chainId,
        name: "RelayOracle",
        verifyingContract: oracleAddress,
        version: "1",
      },
      message: {
        actions,
        idempotencyKey,
      },
      primaryType: "Execution",
      types: {
        Execution: [
          { name: "idempotencyKey", type: "bytes32" },
          { name: "actions", type: "bytes[]" },
        ],
      },
    })
  }

  // Combine signatures sorted by signer address
  const combineOracleSignatures = async (
    wallets: any[],
    oracleAddress: Hex,
    idempotencyKey: Hex,
    actions: Hex[]
  ): Promise<Hex> => {
    const sortedWallets = [...wallets].sort((a, b) =>
      a.account.address.toLowerCase() < b.account.address.toLowerCase() ? -1 : 1
    )

    const signatures: Hex[] = []
    for (const wallet of sortedWallets) {
      const sig = await signExecution(
        wallet,
        oracleAddress,
        idempotencyKey,
        actions
      )
      signatures.push(sig)
    }

    return concat(signatures)
  }

  it("should execute mint action when multisig validates signature", async () => {
    const { hub, oracle, multisig, signerWallets, recipient, publicClient } =
      await loadFixture(setup)

    // Create mint action
    const currency = "0x6402c4c08C1F752Ac8c91beEAF226018ec1a27f2"
    const amount = 10n ** 18n

    const hubTokenId = generateTokenId({
      address: currency,
      chainId: "1",
      family: "ethereum-vm",
    })
    const hubToAddress = generateAddress({
      address: recipient.account.address,
      chainId: "1",
      family: "ethereum-vm",
    })

    const action = createMintAction(hubToAddress, BigInt(hubTokenId), amount)
    const idempotencyKey = `0x${randomBytes(32).toString("hex")}` as Hex
    const actions = [action]

    // Get combined signature from 2 of 3 signers
    const combinedSignature = await combineOracleSignatures(
      [signerWallets[0], signerWallets[1]],
      oracle.address,
      idempotencyKey,
      actions
    )

    // Check balance before
    const balanceBefore = await hub.read.balanceOf([hubToAddress, hubTokenId])

    // Execute with multisig as oracle
    const executeTxHash = await oracle.write.execute([
      {
        actions,
        idempotencyKey,
      },
      multisig.address,
      combinedSignature,
    ])

    // Check balance after
    const balanceAfter = await hub.read.balanceOf([hubToAddress, hubTokenId])

    // Verify execution
    expect(balanceAfter - balanceBefore).to.equal(amount)

    // Verify event
    const logs = await publicClient.getContractEvents({
      abi: oracle.abi,
      address: oracle.address,
      args: { idempotencyKey },
      eventName: "Executed",
    })
    expect(
      Boolean(logs.find((l) => l.transactionHash === executeTxHash))
    ).to.equal(true)
  })

  it("should reject execution with insufficient multisig signatures", async () => {
    const { oracle, multisig, signerWallets, recipient } =
      await loadFixture(setup)

    const currency = "0x6402c4c08C1F752Ac8c91beEAF226018ec1a27f2"
    const amount = 10n ** 18n

    const hubTokenId = generateTokenId({
      address: currency,
      chainId: "1",
      family: "ethereum-vm",
    })
    const hubToAddress = generateAddress({
      address: recipient.account.address,
      chainId: "1",
      family: "ethereum-vm",
    })

    const action = createMintAction(hubToAddress, BigInt(hubTokenId), amount)
    const idempotencyKey = `0x${randomBytes(32).toString("hex")}` as Hex
    const actions = [action]

    // Only 1 signature when 2 required
    const singleSignature = await signExecution(
      signerWallets[0],
      oracle.address,
      idempotencyKey,
      actions
    )

    await expect(
      oracle.write.execute([
        {
          actions,
          idempotencyKey,
        },
        multisig.address,
        singleSignature,
      ])
    ).to.be.rejectedWith("InvalidSignature")
  })

  it("should reject execution with all signatures from non-signers", async () => {
    const { oracle, multisig, recipient } = await loadFixture(setup)

    const wallets = await hre.viem.getWalletClients()
    const nonSigners = wallets.slice(5, 7) // Get wallets that are not signers

    const currency = "0x6402c4c08C1F752Ac8c91beEAF226018ec1a27f2"
    const amount = 10n ** 18n

    const hubTokenId = generateTokenId({
      address: currency,
      chainId: "1",
      family: "ethereum-vm",
    })
    const hubToAddress = generateAddress({
      address: recipient.account.address,
      chainId: "1",
      family: "ethereum-vm",
    })

    const action = createMintAction(hubToAddress, BigInt(hubTokenId), amount)
    const idempotencyKey = `0x${randomBytes(32).toString("hex")}` as Hex
    const actions = [action]

    const combinedSignature = await combineOracleSignatures(
      nonSigners,
      oracle.address,
      idempotencyKey,
      actions
    )

    await expect(
      oracle.write.execute([
        {
          actions,
          idempotencyKey,
        },
        multisig.address,
        combinedSignature,
      ])
    ).to.be.rejectedWith("InvalidSignature")
  })

  it("should work with executeMultiple", async () => {
    const { hub, oracle, multisig, signerWallets, recipient } =
      await loadFixture(setup)

    const currency = "0x6402c4c08C1F752Ac8c91beEAF226018ec1a27f2"
    const amount = 10n ** 18n

    const hubTokenId = generateTokenId({
      address: currency,
      chainId: "1",
      family: "ethereum-vm",
    })
    const hubToAddress = generateAddress({
      address: recipient.account.address,
      chainId: "1",
      family: "ethereum-vm",
    })

    // Create multiple executions
    const action1 = createMintAction(hubToAddress, BigInt(hubTokenId), amount)
    const action2 = createMintAction(
      hubToAddress,
      BigInt(hubTokenId),
      amount * 2n
    )

    const idempotencyKey1 = `0x${randomBytes(32).toString("hex")}` as Hex
    const idempotencyKey2 = `0x${randomBytes(32).toString("hex")}` as Hex

    const signature1 = await combineOracleSignatures(
      [signerWallets[0], signerWallets[1]],
      oracle.address,
      idempotencyKey1,
      [action1]
    )
    const signature2 = await combineOracleSignatures(
      [signerWallets[0], signerWallets[2]], // Different signer combination
      oracle.address,
      idempotencyKey2,
      [action2]
    )

    const balanceBefore = await hub.read.balanceOf([hubToAddress, hubTokenId])

    await oracle.write.executeMultiple([
      [
        { actions: [action1], idempotencyKey: idempotencyKey1 },
        { actions: [action2], idempotencyKey: idempotencyKey2 },
      ],
      multisig.address,
      [signature1, signature2],
    ])

    const balanceAfter = await hub.read.balanceOf([hubToAddress, hubTokenId])

    // Should have minted amount + amount*2 = amount*3
    expect(balanceAfter - balanceBefore).to.equal(amount * 3n)
  })
})
