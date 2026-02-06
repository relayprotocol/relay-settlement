import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers"
import { expect } from "chai"
import hre from "hardhat"
import { Hex, concat, hashMessage } from "viem"

describe("RelayOracleMultisig - isValidSignature (EIP-1271)", function () {
  const setup = async () => {
    const wallets = await hre.viem.getWalletClients()
    const [owner, signer1, signer2, signer3, nonSigner] = wallets

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

    return { multisig, nonSigner, owner, signerAddresses, signerWallets }
  }

  const signHash = async (wallet: any, hash: Hex): Promise<Hex> => {
    return wallet.signMessage({ message: { raw: hash } })
  }

  // Helper to combine multiple signatures sorted by signer address
  const combineSignatures = async (wallets: any[], hash: Hex): Promise<Hex> => {
    // Sort wallets by address
    const sortedWallets = [...wallets].sort((a, b) =>
      a.account.address.toLowerCase() < b.account.address.toLowerCase() ? -1 : 1
    )

    const signatures: Hex[] = []
    for (const wallet of sortedWallets) {
      const sig = await signHash(wallet, hash)
      signatures.push(sig)
    }

    return concat(signatures)
  }

  it("should return magic value for valid threshold signatures", async () => {
    const { multisig, signerWallets } = await loadFixture(setup)

    const message =
      "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef" as Hex
    // signMessage adds the Ethereum signed message prefix, so we need to pass
    // the prefixed hash to isValidSignature for the contract to recover correctly
    const hash = hashMessage({ raw: message })

    // Sign with first 2 signers (meeting threshold)
    const combinedSig = await combineSignatures(
      [signerWallets[0], signerWallets[1]],
      message
    )

    const result = await multisig.read.isValidSignature([hash, combinedSig])
    expect(result).to.equal("0x1626ba7e") // EIP-1271 magic value
  })

  it("should return magic value with all signers", async () => {
    const { multisig, signerWallets } = await loadFixture(setup)

    const message =
      "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890" as Hex
    // signMessage adds the Ethereum signed message prefix, so we need to pass
    // the prefixed hash to isValidSignature for the contract to recover correctly
    const hash = hashMessage({ raw: message })

    const combinedSig = await combineSignatures(signerWallets, message)

    const result = await multisig.read.isValidSignature([hash, combinedSig])
    expect(result).to.equal("0x1626ba7e")
  })

  it("should return 0x00000000 for insufficient signatures", async () => {
    const { multisig, signerWallets } = await loadFixture(setup)

    const hash =
      "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef" as Hex

    // Only 1 signature when threshold is 2
    const sig = await signHash(signerWallets[0], hash)

    const result = await multisig.read.isValidSignature([hash, sig])
    expect(result).to.equal("0x00000000")
  })

  it("should return 0x00000000 for signatures from non-signers", async () => {
    const { multisig, nonSigner, signerWallets } = await loadFixture(setup)

    const hash =
      "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef" as Hex

    // One valid signer + one non-signer
    const combinedSig = await combineSignatures(
      [signerWallets[0], nonSigner],
      hash
    )

    const result = await multisig.read.isValidSignature([hash, combinedSig])
    expect(result).to.equal("0x00000000")
  })

  it("should return 0x00000000 for signatures not in ascending address order", async () => {
    const { multisig, signerWallets } = await loadFixture(setup)

    const hash =
      "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef" as Hex

    // Sign in reverse order (descending addresses)
    const reversedWallets = [...signerWallets].reverse()
    const sig1 = await signHash(reversedWallets[0], hash)
    const sig2 = await signHash(reversedWallets[1], hash)
    const wrongOrderSig = concat([sig1, sig2])

    const result = await multisig.read.isValidSignature([hash, wrongOrderSig])
    expect(result).to.equal("0x00000000")
  })

  it("should return 0x00000000 for duplicate signatures", async () => {
    const { multisig, signerWallets } = await loadFixture(setup)

    const hash =
      "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef" as Hex

    // Same signer twice
    const sig = await signHash(signerWallets[0], hash)
    const duplicateSig = concat([sig, sig])

    const result = await multisig.read.isValidSignature([hash, duplicateSig])
    expect(result).to.equal("0x00000000")
  })

  it("should return 0x00000000 for wrong hash signature", async () => {
    const { multisig, signerWallets } = await loadFixture(setup)

    const hash1 =
      "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef" as Hex
    const hash2 =
      "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890" as Hex

    // Sign hash2 but validate with hash1
    const combinedSig = await combineSignatures(
      [signerWallets[0], signerWallets[1]],
      hash2
    )

    const result = await multisig.read.isValidSignature([hash1, combinedSig])
    expect(result).to.equal("0x00000000")
  })

  it("should return 0x00000000 for malformed signatures instead of reverting", async () => {
    const { multisig, signerWallets } = await loadFixture(setup)

    const hash =
      "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef" as Hex

    const combinedSig = await combineSignatures(
      [signerWallets[0], signerWallets[1]],
      hash
    )

    const sigBytes = Buffer.from(combinedSig.slice(2), "hex")
    sigBytes[64] = 0x00 // invalid v for the first signature
    const malformedSig = `0x${sigBytes.toString("hex")}` as Hex

    const result = await multisig.read.isValidSignature([hash, malformedSig])
    expect(result).to.equal("0x00000000")
  })
})
