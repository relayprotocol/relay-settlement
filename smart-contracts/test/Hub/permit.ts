// ABOUTME: Unit tests for the RelayHub permit function
// ABOUTME: Tests EIP712 signature-based approval functionality
import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers"
import { expect } from "chai"
import hre from "hardhat"
import { keccak256, getAddress } from "viem"

describe("permit", function () {
  async function deployHub() {
    const walletClients = await hre.viem.getWalletClients()
    const admin = walletClients[0]
    const operatorUser = walletClients[1]
    const spender = walletClients[2]
    const ownerSigner = walletClients[3]
    const wrongSigner = walletClients[4]

    const hub = await hre.viem.deployContract("RelayHub", [
      admin.account.address,
    ])
    const publicClient = await hre.viem.getPublicClient()

    // Add operator role to operatorUser
    const addOperatorHash = await hub.write.grantRole(
      [keccak256("OPERATOR_ROLE"), operatorUser.account.address],
      {
        account: admin.account,
      }
    )
    await publicClient.waitForTransactionReceipt({ hash: addOperatorHash })

    // Mint some tokens to the owner
    const tokenId = 1n
    const mintAmount = 1000n
    const mintHash = await hub.write.mint(
      [ownerSigner.account.address, tokenId, mintAmount],
      {
        account: operatorUser.account,
      }
    )
    await publicClient.waitForTransactionReceipt({ hash: mintHash })

    return {
      admin,
      hub,
      operatorUser,
      ownerAccount: ownerSigner.account,
      ownerSigner,
      publicClient,
      spender,
      tokenId,
      wrongSigner,
    }
  }

  async function signPermit(
    hub: any,
    owner: any,
    spender: string,
    tokenId: bigint,
    value: bigint,
    deadline: bigint,
    nonce: bigint,
    ownerOverride?: string
  ) {
    const domain = {
      chainId: 31337,
      name: "RelayHub",
      // hardhat default chain id
      verifyingContract: getAddress(hub.address),
      version: "1",
    }

    const types = {
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "tokenId", type: "uint256" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    }

    const message = {
      deadline,
      nonce,
      owner: getAddress(ownerOverride ?? owner.account.address),
      spender: getAddress(spender),
      tokenId,
      value,
    }

    const signature = await owner.signTypedData({
      domain,
      message,
      primaryType: "Permit",
      types,
    })

    // Extract v, r, s from signature
    const r = signature.slice(0, 66) as `0x${string}`
    const s = `0x${signature.slice(66, 130)}` as `0x${string}`
    const v = parseInt(signature.slice(130, 132), 16)

    return { r, s, v }
  }

  it("reverts when owner is zero address", async function () {
    const { hub, spender, ownerAccount, ownerSigner, tokenId } =
      await loadFixture(deployHub)

    const zeroAddress = "0x0000000000000000000000000000000000000000"
    const value = 500n
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600)
    const nonce = await hub.read.nonces([ownerAccount.address])

    const { v, r, s } = await signPermit(
      hub,
      ownerSigner,
      spender.account.address,
      tokenId,
      value,
      deadline,
      nonce,
      zeroAddress
    )

    await expect(
      hub.write.permit([
        zeroAddress,
        spender.account.address,
        tokenId,
        value,
        deadline,
        v,
        r,
        s,
      ])
    ).to.be.rejectedWith("InvalidPermitOwner")
  })

  it("allows spender to be approved via valid permit signature", async function () {
    const { hub, spender, ownerAccount, ownerSigner, tokenId, publicClient } =
      await loadFixture(deployHub)

    const value = 500n
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600) // 1 hour from now
    const nonce = await hub.read.nonces([ownerAccount.address])

    const { v, r, s } = await signPermit(
      hub,
      ownerSigner,
      spender.account.address,
      tokenId,
      value,
      deadline,
      nonce
    )

    // Execute permit
    const permitHash = await hub.write.permit([
      ownerAccount.address,
      spender.account.address,
      tokenId,
      value,
      deadline,
      v,
      r,
      s,
    ])
    await publicClient.waitForTransactionReceipt({ hash: permitHash })

    // Verify allowance was set
    const allowance = await hub.read.allowance([
      ownerAccount.address,
      spender.account.address,
      tokenId,
    ])
    expect(allowance).to.equal(value)
  })

  it("increments nonce after successful permit", async function () {
    const { hub, spender, ownerAccount, ownerSigner, tokenId, publicClient } =
      await loadFixture(deployHub)

    const value = 500n
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600)
    const nonceBefore = await hub.read.nonces([ownerAccount.address])

    const { v, r, s } = await signPermit(
      hub,
      ownerSigner,
      spender.account.address,
      tokenId,
      value,
      deadline,
      nonceBefore
    )

    // Execute permit
    const permitHash = await hub.write.permit([
      ownerAccount.address,
      spender.account.address,
      tokenId,
      value,
      deadline,
      v,
      r,
      s,
    ])
    await publicClient.waitForTransactionReceipt({ hash: permitHash })

    // Verify nonce was incremented
    const nonceAfter = await hub.read.nonces([ownerAccount.address])
    expect(nonceAfter).to.equal(nonceBefore + 1n)
  })

  it("emits Approval event on successful permit", async function () {
    const { hub, spender, ownerAccount, ownerSigner, tokenId, publicClient } =
      await loadFixture(deployHub)

    const value = 500n
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600)
    const nonce = await hub.read.nonces([ownerAccount.address])

    const { v, r, s } = await signPermit(
      hub,
      ownerSigner,
      spender.account.address,
      tokenId,
      value,
      deadline,
      nonce
    )

    // Execute permit
    const permitHash = await hub.write.permit([
      ownerAccount.address,
      spender.account.address,
      tokenId,
      value,
      deadline,
      v,
      r,
      s,
    ])
    await publicClient.waitForTransactionReceipt({ hash: permitHash })

    // Get Approval events
    const logs = await publicClient.getContractEvents({
      abi: hub.abi,
      address: hub.address,
      eventName: "Approval",
    })

    // Find the Approval event for this permit
    const approvalEvent = logs.find(
      (log) =>
        log.args.owner?.toLowerCase() === ownerAccount.address.toLowerCase() &&
        log.args.spender?.toLowerCase() ===
          spender.account.address.toLowerCase() &&
        log.args.id === tokenId
    )

    expect(approvalEvent).to.not.equal(undefined)

    const event = approvalEvent as NonNullable<typeof approvalEvent>
    const args = event.args as {
      owner: `0x${string}`
      spender: `0x${string}`
      id: bigint
      amount: bigint
    }
    expect(args.owner.toLowerCase()).to.equal(
      ownerAccount.address.toLowerCase()
    )
    expect(args.spender.toLowerCase()).to.equal(
      spender.account.address.toLowerCase()
    )
    expect(args.id).to.equal(tokenId)
    expect(args.amount).to.equal(value)
  })

  it("reverts when deadline has expired", async function () {
    const { hub, spender, ownerAccount, ownerSigner, tokenId } =
      await loadFixture(deployHub)

    const value = 500n
    const deadline = BigInt(Math.floor(Date.now() / 1000) - 3600) // 1 hour ago
    const nonce = await hub.read.nonces([ownerAccount.address])

    const { v, r, s } = await signPermit(
      hub,
      ownerSigner,
      spender.account.address,
      tokenId,
      value,
      deadline,
      nonce
    )

    // Attempt to execute permit with expired deadline
    await expect(
      hub.write.permit([
        ownerAccount.address,
        spender.account.address,
        tokenId,
        value,
        deadline,
        v,
        r,
        s,
      ])
    ).to.be.rejectedWith("PermitDeadlineExpired")
  })

  it("reverts when signature is invalid (wrong signer)", async function () {
    const { hub, spender, ownerAccount, wrongSigner, tokenId } =
      await loadFixture(deployHub)

    const value = 500n
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600)
    const nonce = await hub.read.nonces([ownerAccount.address])

    // Sign with a different account
    const { v, r, s } = await signPermit(
      hub,
      wrongSigner, // Wrong signer
      spender.account.address,
      tokenId,
      value,
      deadline,
      nonce
    )

    // Attempt to execute permit with signature from wrong signer
    await expect(
      hub.write.permit([
        ownerAccount.address, // Claiming to be owner
        spender.account.address,
        tokenId,
        value,
        deadline,
        v,
        r,
        s,
      ])
    ).to.be.rejectedWith("InvalidPermitSignature")
  })

  it("reverts when using an already-used nonce", async function () {
    const { hub, spender, ownerAccount, ownerSigner, tokenId, publicClient } =
      await loadFixture(deployHub)

    const value = 500n
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600)
    const nonce = await hub.read.nonces([ownerAccount.address])

    const { v, r, s } = await signPermit(
      hub,
      ownerSigner,
      spender.account.address,
      tokenId,
      value,
      deadline,
      nonce
    )

    // Execute permit first time
    const permitHash = await hub.write.permit([
      ownerAccount.address,
      spender.account.address,
      tokenId,
      value,
      deadline,
      v,
      r,
      s,
    ])
    await publicClient.waitForTransactionReceipt({ hash: permitHash })

    // Try to use the same signature again (nonce is now invalid)
    await expect(
      hub.write.permit([
        ownerAccount.address,
        spender.account.address,
        tokenId,
        value,
        deadline,
        v,
        r,
        s,
      ])
    ).to.be.rejectedWith("InvalidPermitSignature")
  })

  it("allows permit for different token IDs independently", async function () {
    const {
      hub,
      spender,
      ownerAccount,
      ownerSigner,
      tokenId,
      publicClient,
      operatorUser,
    } = await loadFixture(deployHub)

    // Mint another token
    const tokenId2 = 2n
    const mintHash = await hub.write.mint(
      [ownerAccount.address, tokenId2, 1000n],
      {
        account: operatorUser.account,
      }
    )
    await publicClient.waitForTransactionReceipt({ hash: mintHash })

    const value1 = 300n
    const value2 = 700n
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600)

    // Permit for tokenId1
    const nonce1 = await hub.read.nonces([ownerAccount.address])
    const sig1 = await signPermit(
      hub,
      ownerSigner,
      spender.account.address,
      tokenId,
      value1,
      deadline,
      nonce1
    )
    const permitHash1 = await hub.write.permit([
      ownerAccount.address,
      spender.account.address,
      tokenId,
      value1,
      deadline,
      sig1.v,
      sig1.r,
      sig1.s,
    ])
    await publicClient.waitForTransactionReceipt({ hash: permitHash1 })

    // Permit for tokenId2
    const nonce2 = await hub.read.nonces([ownerAccount.address])
    const sig2 = await signPermit(
      hub,
      ownerSigner,
      spender.account.address,
      tokenId2,
      value2,
      deadline,
      nonce2
    )
    const permitHash2 = await hub.write.permit([
      ownerAccount.address,
      spender.account.address,
      tokenId2,
      value2,
      deadline,
      sig2.v,
      sig2.r,
      sig2.s,
    ])
    await publicClient.waitForTransactionReceipt({ hash: permitHash2 })

    // Verify both allowances
    const allowance1 = await hub.read.allowance([
      ownerAccount.address,
      spender.account.address,
      tokenId,
    ])
    const allowance2 = await hub.read.allowance([
      ownerAccount.address,
      spender.account.address,
      tokenId2,
    ])

    expect(allowance1).to.equal(value1)
    expect(allowance2).to.equal(value2)
  })

  it("allows spender to transferFrom after successful permit", async function () {
    const {
      hub,
      spender,
      ownerAccount,
      ownerSigner,
      tokenId,
      publicClient,
      operatorUser,
    } = await loadFixture(deployHub)

    const value = 500n
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600)
    const nonce = await hub.read.nonces([ownerAccount.address])

    const { v, r, s } = await signPermit(
      hub,
      ownerSigner,
      spender.account.address,
      tokenId,
      value,
      deadline,
      nonce
    )

    // Execute permit
    const permitHash = await hub.write.permit([
      ownerAccount.address,
      spender.account.address,
      tokenId,
      value,
      deadline,
      v,
      r,
      s,
    ])
    await publicClient.waitForTransactionReceipt({ hash: permitHash })

    // Verify spender can now transfer tokens to operatorUser (different from owner)
    const transferAmount = 250n
    const transferHash = await hub.write.transferFrom(
      [
        ownerAccount.address,
        operatorUser.account.address,
        tokenId,
        transferAmount,
      ],
      {
        account: spender.account,
      }
    )
    await publicClient.waitForTransactionReceipt({ hash: transferHash })

    // Verify balances
    const ownerBalance = await hub.read.balanceOf([
      ownerAccount.address,
      tokenId,
    ])
    const recipientBalance = await hub.read.balanceOf([
      operatorUser.account.address,
      tokenId,
    ])

    expect(ownerBalance).to.equal(1000n - transferAmount)
    expect(recipientBalance).to.equal(transferAmount)

    // Verify remaining allowance
    const remainingAllowance = await hub.read.allowance([
      ownerAccount.address,
      spender.account.address,
      tokenId,
    ])
    expect(remainingAllowance).to.equal(value - transferAmount)
  })

  it("exposes DOMAIN_SEPARATOR for external verification", async function () {
    const { hub } = await loadFixture(deployHub)

    const domainSeparator = await hub.read.DOMAIN_SEPARATOR()
    expect(domainSeparator).to.match(/^0x[a-fA-F0-9]{64}$/)
  })

  describe("integration", function () {
    async function deployHubWithMultipleUsers() {
      const walletClients = await hre.viem.getWalletClients()
      const admin = walletClients[0]
      const operatorUser = walletClients[1]
      const spender1 = walletClients[2]
      const spender2 = walletClients[3]
      const recipient = walletClients[4]
      const owner1Signer = walletClients[5]
      const owner2Signer = walletClients[6]

      const hub = await hre.viem.deployContract("RelayHub", [
        admin.account.address,
      ])
      const publicClient = await hre.viem.getPublicClient()

      const addOperatorHash = await hub.write.grantRole(
        [keccak256("OPERATOR_ROLE"), operatorUser.account.address],
        {
          account: admin.account,
        }
      )
      await publicClient.waitForTransactionReceipt({ hash: addOperatorHash })

      const tokenId = 1n
      const mintAmount = 10000n

      const mintHash1 = await hub.write.mint(
        [owner1Signer.account.address, tokenId, mintAmount],
        {
          account: operatorUser.account,
        }
      )
      await publicClient.waitForTransactionReceipt({ hash: mintHash1 })

      const mintHash2 = await hub.write.mint(
        [owner2Signer.account.address, tokenId, mintAmount],
        {
          account: operatorUser.account,
        }
      )
      await publicClient.waitForTransactionReceipt({ hash: mintHash2 })

      return {
        admin,
        hub,
        operatorUser,
        owner1Account: owner1Signer.account,
        owner1Signer,
        owner2Account: owner2Signer.account,
        owner2Signer,
        publicClient,
        recipient,
        spender1,
        spender2,
        tokenId,
      }
    }

    it("handles multiple permits from same owner to different spenders", async function () {
      const {
        hub,
        spender1,
        spender2,
        owner1Account,
        owner1Signer,
        tokenId,
        publicClient,
        recipient,
      } = await loadFixture(deployHubWithMultipleUsers)

      const value1 = 1000n
      const value2 = 2000n
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600)

      const nonce1 = await hub.read.nonces([owner1Account.address])
      const sig1 = await signPermit(
        hub,
        owner1Signer,
        spender1.account.address,
        tokenId,
        value1,
        deadline,
        nonce1
      )
      const permitHash1 = await hub.write.permit([
        owner1Account.address,
        spender1.account.address,
        tokenId,
        value1,
        deadline,
        sig1.v,
        sig1.r,
        sig1.s,
      ])
      await publicClient.waitForTransactionReceipt({ hash: permitHash1 })

      const nonce2 = await hub.read.nonces([owner1Account.address])
      const sig2 = await signPermit(
        hub,
        owner1Signer,
        spender2.account.address,
        tokenId,
        value2,
        deadline,
        nonce2
      )
      const permitHash2 = await hub.write.permit([
        owner1Account.address,
        spender2.account.address,
        tokenId,
        value2,
        deadline,
        sig2.v,
        sig2.r,
        sig2.s,
      ])
      await publicClient.waitForTransactionReceipt({ hash: permitHash2 })

      const transferHash1 = await hub.write.transferFrom(
        [owner1Account.address, recipient.account.address, tokenId, 500n],
        { account: spender1.account }
      )
      await publicClient.waitForTransactionReceipt({ hash: transferHash1 })

      const transferHash2 = await hub.write.transferFrom(
        [owner1Account.address, recipient.account.address, tokenId, 1500n],
        { account: spender2.account }
      )
      await publicClient.waitForTransactionReceipt({ hash: transferHash2 })

      const ownerBalance = await hub.read.balanceOf([
        owner1Account.address,
        tokenId,
      ])
      const recipientBalance = await hub.read.balanceOf([
        recipient.account.address,
        tokenId,
      ])

      expect(ownerBalance).to.equal(10000n - 500n - 1500n)
      expect(recipientBalance).to.equal(2000n)
    })

    it("handles permit overwriting previous allowance", async function () {
      const {
        hub,
        spender1,
        owner1Account,
        owner1Signer,
        tokenId,
        publicClient,
      } = await loadFixture(deployHubWithMultipleUsers)

      const value1 = 1000n
      const value2 = 5000n
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600)

      const nonce1 = await hub.read.nonces([owner1Account.address])
      const sig1 = await signPermit(
        hub,
        owner1Signer,
        spender1.account.address,
        tokenId,
        value1,
        deadline,
        nonce1
      )
      const permitHash1 = await hub.write.permit([
        owner1Account.address,
        spender1.account.address,
        tokenId,
        value1,
        deadline,
        sig1.v,
        sig1.r,
        sig1.s,
      ])
      await publicClient.waitForTransactionReceipt({ hash: permitHash1 })

      const allowance1 = await hub.read.allowance([
        owner1Account.address,
        spender1.account.address,
        tokenId,
      ])
      expect(allowance1).to.equal(value1)

      const nonce2 = await hub.read.nonces([owner1Account.address])
      const sig2 = await signPermit(
        hub,
        owner1Signer,
        spender1.account.address,
        tokenId,
        value2,
        deadline,
        nonce2
      )
      const permitHash2 = await hub.write.permit([
        owner1Account.address,
        spender1.account.address,
        tokenId,
        value2,
        deadline,
        sig2.v,
        sig2.r,
        sig2.s,
      ])
      await publicClient.waitForTransactionReceipt({ hash: permitHash2 })

      const allowance2 = await hub.read.allowance([
        owner1Account.address,
        spender1.account.address,
        tokenId,
      ])
      expect(allowance2).to.equal(value2)
    })

    it("handles permit with zero value to revoke allowance", async function () {
      const {
        hub,
        spender1,
        owner1Account,
        owner1Signer,
        tokenId,
        publicClient,
        recipient,
      } = await loadFixture(deployHubWithMultipleUsers)

      const value = 1000n
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600)

      const nonce1 = await hub.read.nonces([owner1Account.address])
      const sig1 = await signPermit(
        hub,
        owner1Signer,
        spender1.account.address,
        tokenId,
        value,
        deadline,
        nonce1
      )
      const permitHash1 = await hub.write.permit([
        owner1Account.address,
        spender1.account.address,
        tokenId,
        value,
        deadline,
        sig1.v,
        sig1.r,
        sig1.s,
      ])
      await publicClient.waitForTransactionReceipt({ hash: permitHash1 })

      const nonce2 = await hub.read.nonces([owner1Account.address])
      const sig2 = await signPermit(
        hub,
        owner1Signer,
        spender1.account.address,
        tokenId,
        0n,
        deadline,
        nonce2
      )
      const permitHash2 = await hub.write.permit([
        owner1Account.address,
        spender1.account.address,
        tokenId,
        0n,
        deadline,
        sig2.v,
        sig2.r,
        sig2.s,
      ])
      await publicClient.waitForTransactionReceipt({ hash: permitHash2 })

      const allowance = await hub.read.allowance([
        owner1Account.address,
        spender1.account.address,
        tokenId,
      ])
      expect(allowance).to.equal(0n)

      await expect(
        hub.write.transferFrom(
          [owner1Account.address, recipient.account.address, tokenId, 100n],
          { account: spender1.account }
        )
      ).to.be.rejected
    })

    it("handles permit with max uint256 value for unlimited allowance", async function () {
      const {
        hub,
        spender1,
        owner1Account,
        owner1Signer,
        tokenId,
        publicClient,
        recipient,
      } = await loadFixture(deployHubWithMultipleUsers)

      const maxValue = 2n ** 256n - 1n
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600)

      const nonce = await hub.read.nonces([owner1Account.address])
      const sig = await signPermit(
        hub,
        owner1Signer,
        spender1.account.address,
        tokenId,
        maxValue,
        deadline,
        nonce
      )
      const permitHash = await hub.write.permit([
        owner1Account.address,
        spender1.account.address,
        tokenId,
        maxValue,
        deadline,
        sig.v,
        sig.r,
        sig.s,
      ])
      await publicClient.waitForTransactionReceipt({ hash: permitHash })

      const allowance = await hub.read.allowance([
        owner1Account.address,
        spender1.account.address,
        tokenId,
      ])
      expect(allowance).to.equal(maxValue)

      const transferHash = await hub.write.transferFrom(
        [owner1Account.address, recipient.account.address, tokenId, 1000n],
        { account: spender1.account }
      )
      await publicClient.waitForTransactionReceipt({ hash: transferHash })

      const allowanceAfter = await hub.read.allowance([
        owner1Account.address,
        spender1.account.address,
        tokenId,
      ])
      expect(allowanceAfter).to.equal(maxValue)
    })

    it("keeps separate nonces for different owners", async function () {
      const {
        hub,
        spender1,
        owner1Account,
        owner1Signer,
        owner2Account,
        owner2Signer,
        tokenId,
        publicClient,
      } = await loadFixture(deployHubWithMultipleUsers)

      const value = 1000n
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600)

      const nonce1Before = await hub.read.nonces([owner1Account.address])
      const nonce2Before = await hub.read.nonces([owner2Account.address])
      expect(nonce1Before).to.equal(0n)
      expect(nonce2Before).to.equal(0n)

      const sig1 = await signPermit(
        hub,
        owner1Signer,
        spender1.account.address,
        tokenId,
        value,
        deadline,
        nonce1Before
      )
      const permitHash1 = await hub.write.permit([
        owner1Account.address,
        spender1.account.address,
        tokenId,
        value,
        deadline,
        sig1.v,
        sig1.r,
        sig1.s,
      ])
      await publicClient.waitForTransactionReceipt({ hash: permitHash1 })

      const sig2 = await signPermit(
        hub,
        owner2Signer,
        spender1.account.address,
        tokenId,
        value,
        deadline,
        nonce2Before
      )
      const permitHash2 = await hub.write.permit([
        owner2Account.address,
        spender1.account.address,
        tokenId,
        value,
        deadline,
        sig2.v,
        sig2.r,
        sig2.s,
      ])
      await publicClient.waitForTransactionReceipt({ hash: permitHash2 })

      const nonce1After = await hub.read.nonces([owner1Account.address])
      const nonce2After = await hub.read.nonces([owner2Account.address])
      expect(nonce1After).to.equal(1n)
      expect(nonce2After).to.equal(1n)
    })

    it("integrates permit with ERC20View approval events", async function () {
      const {
        hub,
        spender1,
        owner1Account,
        owner1Signer,
        tokenId,
        publicClient,
      } = await loadFixture(deployHubWithMultipleUsers)

      const value = 1000n
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600)
      const nonce = await hub.read.nonces([owner1Account.address])

      const { v, r, s } = await signPermit(
        hub,
        owner1Signer,
        spender1.account.address,
        tokenId,
        value,
        deadline,
        nonce
      )

      const erc20ViewAddress = await hub.read.erc20Views([tokenId])
      expect(erc20ViewAddress).to.not.equal(
        "0x0000000000000000000000000000000000000000"
      )

      const erc20View = await hre.viem.getContractAt(
        "ERC20View",
        erc20ViewAddress
      )

      const permitHash = await hub.write.permit([
        owner1Account.address,
        spender1.account.address,
        tokenId,
        value,
        deadline,
        v,
        r,
        s,
      ])
      await publicClient.waitForTransactionReceipt({ hash: permitHash })

      const hubLogs = await publicClient.getContractEvents({
        abi: hub.abi,
        address: hub.address,
        eventName: "Approval",
      })

      const relevantHubLog = hubLogs.find(
        (log) =>
          log.args.owner?.toLowerCase() ===
            owner1Account.address.toLowerCase() &&
          log.args.spender?.toLowerCase() ===
            spender1.account.address.toLowerCase()
      )

      expect(relevantHubLog).to.not.equal(undefined)

      const erc20Logs = await publicClient.getContractEvents({
        abi: erc20View.abi,
        address: erc20ViewAddress,
        eventName: "Approval",
      })

      const relevantErc20Log = erc20Logs.find(
        (log) =>
          log.args.owner?.toLowerCase() ===
            owner1Account.address.toLowerCase() &&
          log.args.spender?.toLowerCase() ===
            spender1.account.address.toLowerCase()
      )

      expect(relevantErc20Log).to.not.equal(undefined)
    })

    it("allows combining permit and regular approve", async function () {
      const {
        hub,
        spender1,
        spender2,
        owner1Account,
        owner1Signer,
        tokenId,
        publicClient,
        recipient,
      } = await loadFixture(deployHubWithMultipleUsers)

      const permitValue = 1000n
      const approveValue = 500n
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600)

      const nonce = await hub.read.nonces([owner1Account.address])
      const sig = await signPermit(
        hub,
        owner1Signer,
        spender1.account.address,
        tokenId,
        permitValue,
        deadline,
        nonce
      )
      const permitHash = await hub.write.permit([
        owner1Account.address,
        spender1.account.address,
        tokenId,
        permitValue,
        deadline,
        sig.v,
        sig.r,
        sig.s,
      ])
      await publicClient.waitForTransactionReceipt({ hash: permitHash })

      const approveHash = await hub.write.approve(
        [spender2.account.address, tokenId, approveValue],
        { account: owner1Account }
      )
      await publicClient.waitForTransactionReceipt({ hash: approveHash })

      const allowance1 = await hub.read.allowance([
        owner1Account.address,
        spender1.account.address,
        tokenId,
      ])
      const allowance2 = await hub.read.allowance([
        owner1Account.address,
        spender2.account.address,
        tokenId,
      ])

      expect(allowance1).to.equal(permitValue)
      expect(allowance2).to.equal(approveValue)

      await hub.write.transferFrom(
        [owner1Account.address, recipient.account.address, tokenId, 100n],
        { account: spender1.account }
      )
      await hub.write.transferFrom(
        [owner1Account.address, recipient.account.address, tokenId, 100n],
        { account: spender2.account }
      )

      const recipientBalance = await hub.read.balanceOf([
        recipient.account.address,
        tokenId,
      ])
      expect(recipientBalance).to.equal(200n)
    })
  })
})
