import assert from "node:assert/strict"
import test from "node:test"
import { projectApprovedOracleInstances } from "./oracles.js"

const relayOracleAddress = "0xd4b9fdB83C723c096d7fBE72da252aa23f1387aa"

test("projectApprovedOracleInstances expands multisig role members into signer instances", () => {
  const approvedOracle = "0x3333333333333333333333333333333333333333"
  const signers = [
    "0x4444444444444444444444444444444444444444",
    "0x5555555555555555555555555555555555555555",
  ]

  const response = projectApprovedOracleInstances({
    relayOracleAddress,
    roleMembers: [
      {
        address: approvedOracle,
        isContract: true,
        multisig: {
          signers,
          threshold: 2,
        },
      },
    ],
    source: {
      fromBlock: 0,
      roleMembers: "indexed-role-members",
      verifiedAtBlock: 100,
    },
  })

  assert.equal(response.count, 2)
  assert.equal(response.approvedOracles[0].type, "multisig")
  assert.equal(response.approvedOracles[0].threshold, 2)
  assert.deepEqual(
    response.data.map((instance) => instance.address),
    signers
  )
  assert.deepEqual(
    response.data.map((instance) => instance.type),
    ["multisig-signer", "multisig-signer"]
  )
  assert.equal(response.data[0].approvedOracle.address, approvedOracle)
})

test("projectApprovedOracleInstances exposes direct role members as instances", () => {
  const directOracle = "0x6666666666666666666666666666666666666666"

  const response = projectApprovedOracleInstances({
    relayOracleAddress,
    roleMembers: [
      {
        address: directOracle,
        isContract: false,
        multisig: null,
      },
    ],
    source: {
      fromBlock: 0,
      roleMembers: "indexed-role-members",
      verifiedAtBlock: 100,
    },
  })

  assert.equal(response.count, 1)
  assert.equal(response.approvedOracles[0].type, "direct")
  assert.equal(response.approvedOracles[0].threshold, 1)
  assert.equal(response.data[0].address, directOracle)
  assert.equal(response.data[0].type, "direct-role-member")
})

test("projectApprovedOracleInstances exposes non-multisig contracts as contract members", () => {
  const contractOracle = "0x7777777777777777777777777777777777777777"

  const response = projectApprovedOracleInstances({
    relayOracleAddress,
    roleMembers: [
      {
        address: contractOracle,
        isContract: true,
        multisig: null,
      },
    ],
    source: {
      fromBlock: 0,
      roleMembers: "indexed-role-members",
      verifiedAtBlock: 100,
    },
  })

  assert.equal(response.count, 1)
  assert.equal(response.approvedOracles[0].type, "contract")
  assert.equal(response.approvedOracles[0].threshold, 1)
  assert.equal(response.data[0].address, contractOracle)
  assert.equal(response.data[0].type, "contract-role-member")
})
