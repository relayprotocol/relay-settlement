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

describe("GenericMapping setEntry", function () {
  it("should allow anyone to set an entry with a valid oracle signature", async function () {
    const { store, oracleWallet, caller } =
      await loadFixture(deployGenericMapping)

    const user = caller.account.address
    const id = keccak256(toHex("entry1"))
    const data = toHex("data1")
    const nonce = keccak256(toHex("nonce-1"))

    const signature = await signSetEntry(
      { data, id, nonce, user },
      store.address,
      oracleWallet
    )

    await store.write.setEntry(
      [user, id, data, nonce, oracleWallet.account.address, signature],
      { account: caller.account }
    )

    const [entryData, createdAt] = await store.read.getEntry([user, id])
    expect(entryData).to.equal(data)
    expect(createdAt > 0n).to.equal(true)
  })

  it("should emit EntrySet event", async function () {
    const { store, oracleWallet, caller, publicClient } =
      await loadFixture(deployGenericMapping)

    const user = caller.account.address
    const id = keccak256(toHex("entry1"))
    const data = toHex("data1")
    const nonce = keccak256(toHex("nonce-1"))

    const signature = await signSetEntry(
      { data, id, nonce, user },
      store.address,
      oracleWallet
    )

    const txHash = await store.write.setEntry(
      [user, id, data, nonce, oracleWallet.account.address, signature],
      { account: caller.account }
    )
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
    })

    expect(receipt.logs.length).to.be.greaterThan(0)
  })

  it("should revert with EntryAlreadyExists when entry already set", async function () {
    const { store, oracleWallet, caller } =
      await loadFixture(deployGenericMapping)

    const user = caller.account.address
    const id = keccak256(toHex("entry1"))
    const data1 = toHex("data1")
    const data2 = toHex("data2")
    const nonce1 = keccak256(toHex("nonce-1"))
    const nonce2 = keccak256(toHex("nonce-2"))

    const sig1 = await signSetEntry(
      { data: data1, id, nonce: nonce1, user },
      store.address,
      oracleWallet
    )
    await store.write.setEntry(
      [user, id, data1, nonce1, oracleWallet.account.address, sig1],
      { account: caller.account }
    )

    const sig2 = await signSetEntry(
      { data: data2, id, nonce: nonce2, user },
      store.address,
      oracleWallet
    )
    await expect(
      store.write.setEntry(
        [user, id, data2, nonce2, oracleWallet.account.address, sig2],
        { account: caller.account }
      )
    ).to.be.rejectedWith("EntryAlreadyExists")
  })

  it("should allow setting an entry after it has been deleted", async function () {
    const { store, oracleWallet, caller } =
      await loadFixture(deployGenericMapping)

    const user = caller.account.address
    const id = keccak256(toHex("entry1"))
    const data1 = toHex("data1")
    const data2 = toHex("data2")
    const nonce1 = keccak256(toHex("nonce-1"))
    const nonce2 = keccak256(toHex("nonce-2"))
    const nonce3 = keccak256(toHex("nonce-3"))

    // Set entry
    const sig1 = await signSetEntry(
      { data: data1, id, nonce: nonce1, user },
      store.address,
      oracleWallet
    )
    await store.write.setEntry(
      [user, id, data1, nonce1, oracleWallet.account.address, sig1],
      { account: caller.account }
    )

    // Delete entry
    const deleteSig = await oracleWallet.signTypedData({
      domain: {
        chainId: await oracleWallet.getChainId(),
        name: "RelayGenericMapping",
        verifyingContract: store.address,
        version: "1",
      },
      message: { id, nonce: nonce2, user },
      primaryType: "DeleteEntry",
      types: {
        DeleteEntry: [
          { name: "user", type: "address" },
          { name: "id", type: "bytes32" },
          { name: "nonce", type: "bytes32" },
        ],
      },
    })
    await store.write.deleteEntry(
      [user, id, nonce2, oracleWallet.account.address, deleteSig],
      { account: caller.account }
    )

    // Re-set entry with new data
    const sig3 = await signSetEntry(
      { data: data2, id, nonce: nonce3, user },
      store.address,
      oracleWallet
    )
    await store.write.setEntry(
      [user, id, data2, nonce3, oracleWallet.account.address, sig3],
      { account: caller.account }
    )

    const [entryData] = await store.read.getEntry([user, id])
    expect(entryData).to.equal(data2)
  })

  it("should store separate entries for the same user with different ids", async function () {
    const { store, oracleWallet, caller } =
      await loadFixture(deployGenericMapping)

    const user = caller.account.address
    const id1 = keccak256(toHex("entry1"))
    const id2 = keccak256(toHex("entry2"))
    const data1 = toHex("data1")
    const data2 = toHex("data2")
    const nonce1 = keccak256(toHex("nonce-1"))
    const nonce2 = keccak256(toHex("nonce-2"))

    const sig1 = await signSetEntry(
      { data: data1, id: id1, nonce: nonce1, user },
      store.address,
      oracleWallet
    )
    await store.write.setEntry(
      [user, id1, data1, nonce1, oracleWallet.account.address, sig1],
      { account: caller.account }
    )

    const sig2 = await signSetEntry(
      { data: data2, id: id2, nonce: nonce2, user },
      store.address,
      oracleWallet
    )
    await store.write.setEntry(
      [user, id2, data2, nonce2, oracleWallet.account.address, sig2],
      { account: caller.account }
    )

    const [entryData1] = await store.read.getEntry([user, id1])
    const [entryData2] = await store.read.getEntry([user, id2])
    expect(entryData1).to.equal(data1)
    expect(entryData2).to.equal(data2)
  })

  it("should store separate entries for different users with the same id", async function () {
    const { store, oracleWallet, caller, remainingAccounts } =
      await loadFixture(deployGenericMapping)

    const user1 = caller.account.address
    const user2 = remainingAccounts[0].account.address
    const id = keccak256(toHex("entry1"))
    const data1 = toHex("data1")
    const data2 = toHex("data2")
    const nonce1 = keccak256(toHex("nonce-1"))
    const nonce2 = keccak256(toHex("nonce-2"))

    const sig1 = await signSetEntry(
      { data: data1, id, nonce: nonce1, user: user1 },
      store.address,
      oracleWallet
    )
    await store.write.setEntry(
      [user1, id, data1, nonce1, oracleWallet.account.address, sig1],
      { account: caller.account }
    )

    const sig2 = await signSetEntry(
      { data: data2, id, nonce: nonce2, user: user2 },
      store.address,
      oracleWallet
    )
    await store.write.setEntry(
      [user2, id, data2, nonce2, oracleWallet.account.address, sig2],
      { account: caller.account }
    )

    const [entryData1] = await store.read.getEntry([user1, id])
    const [entryData2] = await store.read.getEntry([user2, id])
    expect(entryData1).to.equal(data1)
    expect(entryData2).to.equal(data2)
  })

  it("should revert with NonceAlreadyUsed when replaying a nonce with different params", async function () {
    const { store, oracleWallet, caller } =
      await loadFixture(deployGenericMapping)

    const user = caller.account.address
    const id1 = keccak256(toHex("entry1"))
    const id2 = keccak256(toHex("entry2"))
    const data = toHex("data1")
    const nonce = keccak256(toHex("nonce-1"))

    const sig1 = await signSetEntry(
      { data, id: id1, nonce, user },
      store.address,
      oracleWallet
    )
    await store.write.setEntry(
      [user, id1, data, nonce, oracleWallet.account.address, sig1],
      { account: caller.account }
    )

    // Try to use the same nonce with a different entry
    const sig2 = await signSetEntry(
      { data, id: id2, nonce, user },
      store.address,
      oracleWallet
    )
    await expect(
      store.write.setEntry(
        [user, id2, data, nonce, oracleWallet.account.address, sig2],
        { account: caller.account }
      )
    ).to.be.rejectedWith("NonceAlreadyUsed")
  })

  it("should revert with UnauthorizedOracle when oracle lacks ORACLE_ROLE", async function () {
    const { store, caller, remainingAccounts } =
      await loadFixture(deployGenericMapping)

    const user = caller.account.address
    const id = keccak256(toHex("entry1"))
    const data = toHex("data1")
    const nonce = keccak256(toHex("nonce-1"))

    const unauthorizedOracle = remainingAccounts[0]
    const signature = await signSetEntry(
      { data, id, nonce, user },
      store.address,
      unauthorizedOracle
    )

    await expect(
      store.write.setEntry(
        [user, id, data, nonce, unauthorizedOracle.account.address, signature],
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
    const nonce = keccak256(toHex("nonce-1"))

    // Sign with a different wallet but claim it's from the oracle
    const wrongSigner = remainingAccounts[0]
    const wrongSignature = await signSetEntry(
      { data, id, nonce, user },
      store.address,
      wrongSigner
    )

    await expect(
      store.write.setEntry(
        [user, id, data, nonce, oracleWallet.account.address, wrongSignature],
        { account: caller.account }
      )
    ).to.be.rejectedWith("InvalidOracleSignature")
  })

  it("should revert with InvalidOracleSignature when params don't match signature", async function () {
    const { store, oracleWallet, caller } =
      await loadFixture(deployGenericMapping)

    const user = caller.account.address
    const id = keccak256(toHex("entry1"))
    const data = toHex("data1")
    const tamperedData = toHex("tampered")
    const nonce = keccak256(toHex("nonce-1"))

    const signature = await signSetEntry(
      { data: tamperedData, id, nonce, user },
      store.address,
      oracleWallet
    )

    await expect(
      store.write.setEntry(
        [user, id, data, nonce, oracleWallet.account.address, signature],
        { account: caller.account }
      )
    ).to.be.rejectedWith("InvalidOracleSignature")
  })

  it("should revert when data is empty", async function () {
    const { store, oracleWallet, caller } =
      await loadFixture(deployGenericMapping)

    const user = caller.account.address
    const id = keccak256(toHex("entry1"))
    const emptyData = "0x" as `0x${string}`
    const nonce = keccak256(toHex("nonce-1"))

    const signature = await signSetEntry(
      { data: emptyData, id, nonce, user },
      store.address,
      oracleWallet
    )

    await expect(
      store.write.setEntry(
        [user, id, emptyData, nonce, oracleWallet.account.address, signature],
        { account: caller.account }
      )
    ).to.be.rejectedWith("EmptyData")
  })

  it("should revert when id is bytes32(0)", async function () {
    const { store, oracleWallet, caller } =
      await loadFixture(deployGenericMapping)

    const data = toHex("data1")
    const nonce = keccak256(toHex("nonce-1"))
    const zeroId =
      "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`

    const signature = await signSetEntry(
      { data, id: zeroId, nonce, user: caller.account.address },
      store.address,
      oracleWallet
    )

    await expect(
      store.write.setEntry(
        [
          caller.account.address,
          zeroId,
          data,
          nonce,
          oracleWallet.account.address,
          signature,
        ],
        { account: caller.account }
      )
    ).to.be.rejectedWith("EmptyId")
  })

  it("should return empty bytes and zero timestamp for a non-existent entry", async function () {
    const { store, caller } = await loadFixture(deployGenericMapping)

    const id = keccak256(toHex("nonexistent"))

    const [entryData, createdAt] = await store.read.getEntry([
      caller.account.address,
      id,
    ])
    expect(entryData).to.equal("0x")
    expect(createdAt).to.equal(0n)
  })
})
