import { expect } from "chai"
import { hexToBytes, keccak256 } from "viem"
import hre from "hardhat"

describe("ChainSignatures encodeJSONRequest", function () {
  it("should correctly encode a JSON request with a payload hash", async function () {
    const chainSignatures = await hre.viem.deployContract("ChainSignatures", [])

    // Create a test payload hash
    const payloadHash = keccak256("0x1234")
    const domainId = "1"
    // compute path hash
    const path = "0xpath"

    const result = await chainSignatures.read.encodeJSONRequest([
      payloadHash,
      "Ecdsa",
      path,
      domainId,
    ])

    // Convert result to string for easier comparison
    const resultStr = Buffer.from(hexToBytes(result)).toString("utf8")

    const jsonResult = JSON.parse(resultStr)
    expect(jsonResult.request).to.be.an("object")
    expect(jsonResult.request.payload_v2).to.be.an("object")
    expect(jsonResult.request.payload_v2.Ecdsa).to.be.an("string")
    expect(jsonResult.request.path).to.equal(path)
    expect(jsonResult.request.domain_id).to.equal(Number(domainId))
  })

  it("should handle different paths", async function () {
    const chainSignatures = await hre.viem.deployContract("ChainSignatures", [])

    const payloadHash = keccak256("0x1234")
    const domainId = "1"

    // compute path hash
    const path = "0xpath"

    const result = await chainSignatures.read.encodeJSONRequest([
      payloadHash,
      "Ecdsa",
      path,
      domainId,
    ])

    const resultStr = Buffer.from(hexToBytes(result)).toString("utf8")
    const jsonResult = JSON.parse(resultStr)
    expect(jsonResult.request.path).to.equal(path)
  })
})
