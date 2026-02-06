import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers"
import { expect } from "chai"
import hre from "hardhat"

describe("RelayOracleMultisig - management", function () {
  const setup = async () => {
    const wallets = await hre.viem.getWalletClients()
    const [owner, signer1, signer2, signer3, newSigner, otherWallet] = wallets

    // Sort signers by address for consistent ordering
    const signerWallets = [signer1, signer2, signer3].sort((a, b) =>
      a.account.address.toLowerCase() < b.account.address.toLowerCase() ? -1 : 1
    )
    const signerAddresses = signerWallets.map((w) => w.account.address)

    const multisig = await hre.viem.deployContract("RelayOracleMultisig", [
      owner.account.address,
      signerAddresses,
      2n, // 2 of 3 threshold
    ])

    const publicClient = await hre.viem.getPublicClient()

    return {
      multisig,
      newSigner,
      otherWallet,
      owner,
      publicClient,
      signerAddresses,
      signerWallets,
    }
  }

  describe("addSigner", function () {
    it("should add a new signer when called by owner", async () => {
      const { multisig, newSigner } = await loadFixture(setup)

      await multisig.write.addSigner([newSigner.account.address])

      expect(
        await multisig.read.isSigner([newSigner.account.address])
      ).to.equal(true)
      expect(await multisig.read.getSignerCount()).to.equal(4n)
    })

    it("should emit SignerAdded event", async () => {
      const { multisig, newSigner, publicClient } = await loadFixture(setup)

      const hash = await multisig.write.addSigner([newSigner.account.address])
      await publicClient.waitForTransactionReceipt({ hash })

      const logs = await publicClient.getContractEvents({
        abi: multisig.abi,
        address: multisig.address,
        eventName: "SignerAdded",
      })

      expect(logs.length).to.be.greaterThan(0)
    })

    it("should revert when adding existing signer", async () => {
      const { multisig, signerAddresses } = await loadFixture(setup)

      await expect(
        multisig.write.addSigner([signerAddresses[0]])
      ).to.be.rejectedWith("SignerAlreadyExists")
    })

    it("should revert when adding zero address", async () => {
      const { multisig } = await loadFixture(setup)

      const zeroAddress = "0x0000000000000000000000000000000000000000"

      await expect(multisig.write.addSigner([zeroAddress])).to.be.rejectedWith(
        "InvalidSignerAddress"
      )
    })

    it("should revert when called by non-owner", async () => {
      const { multisig, newSigner, otherWallet } = await loadFixture(setup)

      const multisigAsOther = await hre.viem.getContractAt(
        "RelayOracleMultisig",
        multisig.address,
        { client: { wallet: otherWallet } }
      )

      await expect(
        multisigAsOther.write.addSigner([newSigner.account.address])
      ).to.be.rejectedWith("OwnableUnauthorizedAccount")
    })
  })

  describe("removeSigner", function () {
    it("should remove a signer when called by owner", async () => {
      const { multisig, signerAddresses } = await loadFixture(setup)

      const signerToRemove = signerAddresses[2]

      await multisig.write.removeSigner([signerToRemove])

      expect(await multisig.read.isSigner([signerToRemove])).to.equal(false)
      expect(await multisig.read.getSignerCount()).to.equal(2n)
    })

    it("should emit SignerRemoved event", async () => {
      const { multisig, signerAddresses, publicClient } =
        await loadFixture(setup)

      const signerToRemove = signerAddresses[2]
      const hash = await multisig.write.removeSigner([signerToRemove])
      await publicClient.waitForTransactionReceipt({ hash })

      const logs = await publicClient.getContractEvents({
        abi: multisig.abi,
        address: multisig.address,
        eventName: "SignerRemoved",
      })

      expect(logs.length).to.be.greaterThan(0)
    })

    it("should revert when removing non-existent signer", async () => {
      const { multisig, otherWallet } = await loadFixture(setup)

      await expect(
        multisig.write.removeSigner([otherWallet.account.address])
      ).to.be.rejectedWith("SignerDoesNotExist")
    })

    it("should revert when removal would make threshold impossible", async () => {
      const { multisig, signerAddresses } = await loadFixture(setup)

      // First remove one signer (3 -> 2, threshold stays at 2)
      await multisig.write.removeSigner([signerAddresses[2]])

      // Try to remove another (would leave 1 signer but threshold is 2)
      await expect(
        multisig.write.removeSigner([signerAddresses[1]])
      ).to.be.rejectedWith("InvalidThreshold")
    })

    it("should revert when removing last signer", async () => {
      const { multisig, signerAddresses } = await loadFixture(setup)

      // Lower threshold first so we can remove signers
      await multisig.write.setThreshold([1n])

      // Remove signers until one remains
      await multisig.write.removeSigner([signerAddresses[2]])
      await multisig.write.removeSigner([signerAddresses[1]])

      // Try to remove the last signer
      await expect(
        multisig.write.removeSigner([signerAddresses[0]])
      ).to.be.rejectedWith("CannotRemoveLastSigner")
    })

    it("should revert when called by non-owner", async () => {
      const { multisig, signerAddresses, otherWallet } =
        await loadFixture(setup)

      const multisigAsOther = await hre.viem.getContractAt(
        "RelayOracleMultisig",
        multisig.address,
        { client: { wallet: otherWallet } }
      )

      await expect(
        multisigAsOther.write.removeSigner([signerAddresses[0]])
      ).to.be.rejectedWith("OwnableUnauthorizedAccount")
    })
  })

  describe("setThreshold", function () {
    it("should change threshold when called by owner", async () => {
      const { multisig } = await loadFixture(setup)

      const newThreshold = 3n

      await multisig.write.setThreshold([newThreshold])

      expect(await multisig.read.threshold()).to.equal(newThreshold)
    })

    it("should emit ThresholdChanged event", async () => {
      const { multisig, publicClient } = await loadFixture(setup)

      const newThreshold = 1n

      const hash = await multisig.write.setThreshold([newThreshold])
      await publicClient.waitForTransactionReceipt({ hash })

      const logs = await publicClient.getContractEvents({
        abi: multisig.abi,
        address: multisig.address,
        eventName: "ThresholdChanged",
      })

      expect(logs.length).to.be.greaterThan(0)
    })

    it("should revert when setting threshold to zero", async () => {
      const { multisig } = await loadFixture(setup)

      await expect(multisig.write.setThreshold([0n])).to.be.rejectedWith(
        "InvalidThreshold"
      )
    })

    it("should revert when setting threshold greater than signer count", async () => {
      const { multisig } = await loadFixture(setup)

      await expect(multisig.write.setThreshold([10n])).to.be.rejectedWith(
        "InvalidThreshold"
      )
    })

    it("should revert when called by non-owner", async () => {
      const { multisig, otherWallet } = await loadFixture(setup)

      const multisigAsOther = await hre.viem.getContractAt(
        "RelayOracleMultisig",
        multisig.address,
        { client: { wallet: otherWallet } }
      )

      await expect(multisigAsOther.write.setThreshold([1n])).to.be.rejectedWith(
        "OwnableUnauthorizedAccount"
      )
    })
  })

  describe("combined operations", function () {
    it("should allow multiple management operations in sequence", async () => {
      const { multisig, newSigner, signerAddresses } = await loadFixture(setup)

      // Add a new signer
      await multisig.write.addSigner([newSigner.account.address])
      expect(await multisig.read.getSignerCount()).to.equal(4n)

      // Increase threshold
      await multisig.write.setThreshold([3n])
      expect(await multisig.read.threshold()).to.equal(3n)

      // Remove a signer
      await multisig.write.removeSigner([signerAddresses[2]])
      expect(await multisig.read.getSignerCount()).to.equal(3n)

      // Decrease threshold
      await multisig.write.setThreshold([2n])
      expect(await multisig.read.threshold()).to.equal(2n)
    })
  })
})
