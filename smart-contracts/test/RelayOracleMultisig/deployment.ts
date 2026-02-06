import { expect } from "chai"
import hre from "hardhat"

describe("RelayOracleMultisig - deployment", function () {
  const deployWithSigners = async (signerCount: number, threshold: number) => {
    const wallets = await hre.viem.getWalletClients()
    const owner = wallets[0]
    const signerWallets = wallets.slice(1, signerCount + 1)
    const signerAddresses = signerWallets.map((w) => w.account.address)

    const multisig = await hre.viem.deployContract("RelayOracleMultisig", [
      owner.account.address,
      signerAddresses,
      BigInt(threshold),
    ])

    return { multisig, owner, signerAddresses, signerWallets }
  }

  it("should deploy with valid signers and threshold", async () => {
    const { multisig, owner, signerAddresses } = await deployWithSigners(3, 2)

    expect(await multisig.read.threshold()).to.equal(2n)
    expect(await multisig.read.getSignerCount()).to.equal(3n)
    expect((await multisig.read.owner()).toLowerCase()).to.equal(
      owner.account.address.toLowerCase()
    )

    for (const signer of signerAddresses) {
      expect(await multisig.read.isSigner([signer])).to.equal(true)
    }
  })

  it("should emit SignerAdded events for each signer", async () => {
    const wallets = await hre.viem.getWalletClients()
    const owner = wallets[0]
    const signerAddresses = wallets.slice(1, 4).map((w) => w.account.address)
    const publicClient = await hre.viem.getPublicClient()

    const hash = await hre.viem.deployContract("RelayOracleMultisig", [
      owner.account.address,
      signerAddresses,
      2n,
    ])

    // Get deployment transaction logs
    const logs = await publicClient.getContractEvents({
      abi: hash.abi,
      address: hash.address,
      eventName: "SignerAdded",
    })

    expect(logs.length).to.equal(3)
  })

  it("should revert with zero threshold", async () => {
    const wallets = await hre.viem.getWalletClients()
    const owner = wallets[0]
    const signerAddresses = wallets.slice(1, 4).map((w) => w.account.address)

    await expect(
      hre.viem.deployContract("RelayOracleMultisig", [
        owner.account.address,
        signerAddresses,
        0n,
      ])
    ).to.be.rejectedWith("InvalidThreshold")
  })

  it("should revert with threshold greater than signer count", async () => {
    const wallets = await hre.viem.getWalletClients()
    const owner = wallets[0]
    const signerAddresses = wallets.slice(1, 3).map((w) => w.account.address)

    await expect(
      hre.viem.deployContract("RelayOracleMultisig", [
        owner.account.address,
        signerAddresses,
        3n,
      ])
    ).to.be.rejectedWith("InvalidThreshold")
  })

  it("should revert with empty signer list", async () => {
    const wallets = await hre.viem.getWalletClients()
    const owner = wallets[0]

    await expect(
      hre.viem.deployContract("RelayOracleMultisig", [
        owner.account.address,
        [],
        1n,
      ])
    ).to.be.rejectedWith("InvalidThreshold")
  })

  it("should revert with zero address as signer", async () => {
    const wallets = await hre.viem.getWalletClients()
    const owner = wallets[0]
    const signerAddresses = [
      wallets[1].account.address,
      "0x0000000000000000000000000000000000000000",
    ]

    await expect(
      hre.viem.deployContract("RelayOracleMultisig", [
        owner.account.address,
        signerAddresses,
        1n,
      ])
    ).to.be.rejectedWith("InvalidSignerAddress")
  })

  it("should revert with duplicate signers", async () => {
    const wallets = await hre.viem.getWalletClients()
    const owner = wallets[0]
    const signerAddresses = [
      wallets[1].account.address,
      wallets[1].account.address,
    ]

    await expect(
      hre.viem.deployContract("RelayOracleMultisig", [
        owner.account.address,
        signerAddresses,
        1n,
      ])
    ).to.be.rejectedWith("SignerAlreadyExists")
  })

  describe("Ownership", function () {
    it("should set correct owner at deployment", async () => {
      const { multisig, owner } = await deployWithSigners(3, 2)

      expect((await multisig.read.owner()).toLowerCase()).to.equal(
        owner.account.address.toLowerCase()
      )
    })

    it("should allow owner to initiate ownership transfer", async () => {
      const { multisig, owner } = await deployWithSigners(3, 2)
      const wallets = await hre.viem.getWalletClients()
      const newOwner = wallets[5]

      await multisig.write.transferOwnership([newOwner.account.address])

      expect((await multisig.read.pendingOwner()).toLowerCase()).to.equal(
        newOwner.account.address.toLowerCase()
      )
      // Owner should not change until accepted
      expect((await multisig.read.owner()).toLowerCase()).to.equal(
        owner.account.address.toLowerCase()
      )
    })

    it("should allow pending owner to accept ownership", async () => {
      const { multisig } = await deployWithSigners(3, 2)
      const wallets = await hre.viem.getWalletClients()
      const newOwner = wallets[5]

      await multisig.write.transferOwnership([newOwner.account.address])

      const multisigAsNewOwner = await hre.viem.getContractAt(
        "RelayOracleMultisig",
        multisig.address,
        { client: { wallet: newOwner } }
      )
      await multisigAsNewOwner.write.acceptOwnership()

      expect((await multisig.read.owner()).toLowerCase()).to.equal(
        newOwner.account.address.toLowerCase()
      )
      expect((await multisig.read.pendingOwner()).toLowerCase()).to.equal(
        "0x0000000000000000000000000000000000000000"
      )
    })

    it("should reject non-pending owner from accepting ownership", async () => {
      const { multisig } = await deployWithSigners(3, 2)
      const wallets = await hre.viem.getWalletClients()
      const newOwner = wallets[5]
      const otherWallet = wallets[6]

      await multisig.write.transferOwnership([newOwner.account.address])

      const multisigAsOther = await hre.viem.getContractAt(
        "RelayOracleMultisig",
        multisig.address,
        { client: { wallet: otherWallet } }
      )

      await expect(multisigAsOther.write.acceptOwnership()).to.be.rejectedWith(
        "OwnableUnauthorizedAccount"
      )
    })

    it("should allow owner to renounce ownership", async () => {
      const { multisig } = await deployWithSigners(3, 2)

      await multisig.write.renounceOwnership()

      expect(await multisig.read.owner()).to.equal(
        "0x0000000000000000000000000000000000000000"
      )
    })
  })
})
