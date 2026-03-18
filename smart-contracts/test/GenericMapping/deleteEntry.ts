import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers"
import { expect } from "chai"
import { keccak256, toHex } from "viem"
import { deployGenericMapping } from "../helpers/deployGenericMapping"

async function signSetEntry(
  params: {
    user: string
    id: `0x${string}`
    data: `0x${string}`
    nonce: `0x${string}`
  },
  storeAddress: string,
  oracleWallet: any
) {
  return oracleWallet.signTypedData({
    domain: {
      chainId: await oracleWallet.getChainId(),
      name: "RelayGenericMapping",
      verifyingContract: storeAddress,
      version: "1",
    },
    message: params,
    primaryType: "SetEntry",
    types: {
      SetEntry: [
        { name: "user", type: "address" },
        { name: "id", type: "bytes32" },
        { name: "data", type: "bytes" },
        { name: "nonce", type: "bytes32" },
      ],
    },
  })
}

async function signDeleteEntry(
  params: { user: string; id: `0x${string}`; nonce: `0x${string}` },
  storeAddress: string,
  oracleWallet: any
) {
  return oracleWallet.signTypedData({
    domain: {
      chainId: await oracleWallet.getChainId(),
      name: "RelayGenericMapping",
      verifyingContract: storeAddress,
      version: "1",
    },
    message: params,
    primaryType: "DeleteEntry",
    types: {
      DeleteEntry: [
        { name: "user", type: "address" },
        { name: "id", type: "bytes32" },
        { name: "nonce", type: "bytes32" },
      ],
    },
  })
}

describe("GenericMapping deleteEntry", function () {
  it("should allow anyone to delete an entry with a valid oracle signature", async function () {
    const { store, oracleWallet, caller } =
      await loadFixture(deployGenericMapping)

    const user = caller.account.address
    const id = keccak256(toHex("entry1"))
    const data = toHex("data1")
    const setNonce = keccak256(toHex("nonce-1"))
    const deleteNonce = keccak256(toHex("nonce-2"))

    const setSig = await signSetEntry(
      { data, id, nonce: setNonce, user },
      store.address,
      oracleWallet
    )
    await store.write.setEntry(
      [user, id, data, setNonce, oracleWallet.account.address, setSig],
      { account: caller.account }
    )

    const deleteSig = await signDeleteEntry(
      { id, nonce: deleteNonce, user },
      store.address,
      oracleWallet
    )
    await store.write.deleteEntry(
      [user, id, deleteNonce, oracleWallet.account.address, deleteSig],
      { account: caller.account }
    )

    const [entryData, createdAt] = await store.read.getEntry([user, id])
    expect(entryData).to.equal("0x")
    expect(createdAt).to.equal(0n)
  })

  it("should emit EntryDeleted event", async function () {
    const { store, oracleWallet, caller, publicClient } =
      await loadFixture(deployGenericMapping)

    const user = caller.account.address
    const id = keccak256(toHex("entry1"))
    const data = toHex("data1")
    const setNonce = keccak256(toHex("nonce-1"))
    const deleteNonce = keccak256(toHex("nonce-2"))

    const setSig = await signSetEntry(
      { data, id, nonce: setNonce, user },
      store.address,
      oracleWallet
    )
    await store.write.setEntry(
      [user, id, data, setNonce, oracleWallet.account.address, setSig],
      { account: caller.account }
    )

    const deleteSig = await signDeleteEntry(
      { id, nonce: deleteNonce, user },
      store.address,
      oracleWallet
    )
    const txHash = await store.write.deleteEntry(
      [user, id, deleteNonce, oracleWallet.account.address, deleteSig],
      { account: caller.account }
    )
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
    })

    expect(receipt.logs.length).to.be.greaterThan(0)
  })

  it("should not affect other entries for the same user", async function () {
    const { store, oracleWallet, caller } =
      await loadFixture(deployGenericMapping)

    const user = caller.account.address
    const id1 = keccak256(toHex("entry1"))
    const id2 = keccak256(toHex("entry2"))
    const data1 = toHex("data1")
    const data2 = toHex("data2")
    const nonce1 = keccak256(toHex("nonce-1"))
    const nonce2 = keccak256(toHex("nonce-2"))
    const nonce3 = keccak256(toHex("nonce-3"))

    const setSig1 = await signSetEntry(
      { data: data1, id: id1, nonce: nonce1, user },
      store.address,
      oracleWallet
    )
    await store.write.setEntry(
      [user, id1, data1, nonce1, oracleWallet.account.address, setSig1],
      { account: caller.account }
    )

    const setSig2 = await signSetEntry(
      { data: data2, id: id2, nonce: nonce2, user },
      store.address,
      oracleWallet
    )
    await store.write.setEntry(
      [user, id2, data2, nonce2, oracleWallet.account.address, setSig2],
      { account: caller.account }
    )

    const deleteSig = await signDeleteEntry(
      { id: id1, nonce: nonce3, user },
      store.address,
      oracleWallet
    )
    await store.write.deleteEntry(
      [user, id1, nonce3, oracleWallet.account.address, deleteSig],
      { account: caller.account }
    )

    const [deletedData, deletedCreatedAt] = await store.read.getEntry([
      user,
      id1,
    ])
    expect(deletedData).to.equal("0x")
    expect(deletedCreatedAt).to.equal(0n)
    const [remainingData] = await store.read.getEntry([user, id2])
    expect(remainingData).to.equal(data2)
  })

  it("should revert with NonceAlreadyUsed when replaying a signature", async function () {
    const { store, oracleWallet, caller } =
      await loadFixture(deployGenericMapping)

    const user = caller.account.address
    const id = keccak256(toHex("entry1"))
    const data = toHex("data1")
    const setNonce = keccak256(toHex("nonce-1"))
    const deleteNonce = keccak256(toHex("nonce-2"))

    const setSig = await signSetEntry(
      { data, id, nonce: setNonce, user },
      store.address,
      oracleWallet
    )
    await store.write.setEntry(
      [user, id, data, setNonce, oracleWallet.account.address, setSig],
      { account: caller.account }
    )

    const deleteSig = await signDeleteEntry(
      { id, nonce: deleteNonce, user },
      store.address,
      oracleWallet
    )
    await store.write.deleteEntry(
      [user, id, deleteNonce, oracleWallet.account.address, deleteSig],
      { account: caller.account }
    )

    // Re-set the entry so delete would otherwise succeed
    const setNonce2 = keccak256(toHex("nonce-3"))
    const setSig2 = await signSetEntry(
      { data, id, nonce: setNonce2, user },
      store.address,
      oracleWallet
    )
    await store.write.setEntry(
      [user, id, data, setNonce2, oracleWallet.account.address, setSig2],
      { account: caller.account }
    )

    // Replay the same delete signature
    await expect(
      store.write.deleteEntry(
        [user, id, deleteNonce, oracleWallet.account.address, deleteSig],
        { account: caller.account }
      )
    ).to.be.rejectedWith("NonceAlreadyUsed")
  })

  it("should revert with UnauthorizedOracle when oracle lacks ORACLE_ROLE", async function () {
    const { store, oracleWallet, caller, remainingAccounts } =
      await loadFixture(deployGenericMapping)

    const user = caller.account.address
    const id = keccak256(toHex("entry1"))
    const data = toHex("data1")
    const setNonce = keccak256(toHex("nonce-1"))
    const deleteNonce = keccak256(toHex("nonce-2"))

    // Create the entry first
    const setSig = await signSetEntry(
      { data, id, nonce: setNonce, user },
      store.address,
      oracleWallet
    )
    await store.write.setEntry(
      [user, id, data, setNonce, oracleWallet.account.address, setSig],
      { account: caller.account }
    )

    const unauthorizedOracle = remainingAccounts[0]
    const signature = await signDeleteEntry(
      { id, nonce: deleteNonce, user },
      store.address,
      unauthorizedOracle
    )

    await expect(
      store.write.deleteEntry(
        [user, id, deleteNonce, unauthorizedOracle.account.address, signature],
        { account: caller.account }
      )
    ).to.be.rejectedWith("UnauthorizedOracle")
  })

  it("should revert with InvalidOracleSignature when signature does not match oracle", async function () {
    const { store, oracleWallet, caller, remainingAccounts } =
      await loadFixture(deployGenericMapping)

    const user = caller.account.address
    const id = keccak256(toHex("entry1"))
    const data = toHex("data1")
    const setNonce = keccak256(toHex("nonce-1"))
    const deleteNonce = keccak256(toHex("nonce-2"))

    // Create the entry first
    const setSig = await signSetEntry(
      { data, id, nonce: setNonce, user },
      store.address,
      oracleWallet
    )
    await store.write.setEntry(
      [user, id, data, setNonce, oracleWallet.account.address, setSig],
      { account: caller.account }
    )

    const wrongSigner = remainingAccounts[0]
    const wrongSignature = await signDeleteEntry(
      { id, nonce: deleteNonce, user },
      store.address,
      wrongSigner
    )

    await expect(
      store.write.deleteEntry(
        [user, id, deleteNonce, oracleWallet.account.address, wrongSignature],
        { account: caller.account }
      )
    ).to.be.rejectedWith("InvalidOracleSignature")
  })

  it("should revert with EntryNotFound when entry does not exist", async function () {
    const { store, oracleWallet, caller } =
      await loadFixture(deployGenericMapping)

    const user = caller.account.address
    const id = keccak256(toHex("nonexistent"))
    const nonce = keccak256(toHex("nonce-1"))

    const signature = await signDeleteEntry(
      { id, nonce, user },
      store.address,
      oracleWallet
    )

    await expect(
      store.write.deleteEntry(
        [user, id, nonce, oracleWallet.account.address, signature],
        { account: caller.account }
      )
    ).to.be.rejectedWith("EntryNotFound")
  })

  it("should revert when id is bytes32(0)", async function () {
    const { store, oracleWallet, caller } =
      await loadFixture(deployGenericMapping)

    const nonce = keccak256(toHex("nonce-1"))
    const zeroId =
      "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`

    const signature = await signDeleteEntry(
      { id: zeroId, nonce, user: caller.account.address },
      store.address,
      oracleWallet
    )

    await expect(
      store.write.deleteEntry(
        [
          caller.account.address,
          zeroId,
          nonce,
          oracleWallet.account.address,
          signature,
        ],
        { account: caller.account }
      )
    ).to.be.rejectedWith("EmptyId")
  })
})
