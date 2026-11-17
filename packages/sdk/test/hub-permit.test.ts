import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { encodeAbiParameters, keccak256, toHex } from "viem"
import {
  getHubPermitHash,
  getHubPermitTypedData,
  hubPermitTypes,
  splitHubPermitSignature,
} from "../src/messages/v2.3/hub-permit"
import { getTransferExecutionId } from "../src/messages/v2.3/transfer-consent"
import * as sdk from "../src"

const HUB = "0xa884543c91156098b2e50ae17c3840770b7b55f5"
const OWNER = "0x7daf3d1ec43294cbdd39a4c54a2343e6342a92cb"
const POOL = "0x9d541ad6da83303eb603aa1bfb8c540edf9acf0b"
const permit = {
  owner: OWNER,
  spender: POOL,
  tokenId:
    86512134522270721992957910457991533944458899231992780260485192288294071515448n,
  value: 10_000_000n,
  nonce: 0n,
  deadline: 1792099133n,
} as const

describe("hub permit", () => {
  it("hashes under the Hub's domain with RelayHub.PERMIT_TYPEHASH's field order", () => {
    // Rebuilt by hand from RelayHub.sol: EIP712("RelayHub", "1"), PERMIT_TYPEHASH over
    // (owner, spender, tokenId, value, nonce, deadline).
    const domainSeparator = keccak256(
      encodeAbiParameters(
        [
          { type: "bytes32" },
          { type: "bytes32" },
          { type: "bytes32" },
          { type: "uint256" },
          { type: "address" },
        ],
        [
          keccak256(
            toHex(
              "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
            )
          ),
          keccak256(toHex("RelayHub")),
          keccak256(toHex("1")),
          537724n,
          HUB,
        ]
      )
    )
    const structHash = keccak256(
      encodeAbiParameters(
        [
          { type: "bytes32" },
          { type: "address" },
          { type: "address" },
          { type: "uint256" },
          { type: "uint256" },
          { type: "uint256" },
          { type: "uint256" },
        ],
        [
          keccak256(
            toHex(
              "Permit(address owner,address spender,uint256 tokenId,uint256 value,uint256 nonce,uint256 deadline)"
            )
          ),
          permit.owner,
          permit.spender,
          permit.tokenId,
          permit.value,
          permit.nonce,
          permit.deadline,
        ]
      )
    )
    const expected = keccak256(
      `0x1901${domainSeparator.slice(2)}${structHash.slice(2)}`
    )
    expect(getHubPermitHash(537724, HUB, permit)).toBe(expected)
    expect(Object.keys(hubPermitTypes)).toEqual(["Permit"])
    expect(getHubPermitTypedData(537724, HUB, permit)).toMatchObject({
      domain: {
        name: "RelayHub",
        version: "1",
        chainId: 537724,
        verifyingContract: HUB,
      },
      primaryType: "Permit",
      message: permit,
    })
  })

  it("splits a signature into the v, r, s the Hub takes, normalizing the recovery id", () => {
    const r = `0x${"11".repeat(32)}`
    const s = `0x${"22".repeat(32)}`
    expect(splitHubPermitSignature(`${r}${s.slice(2)}1c`)).toEqual({
      r,
      s,
      v: 28,
    })
    expect(splitHubPermitSignature(`${r}${s.slice(2)}1b`)).toEqual({
      r,
      s,
      v: 27,
    })
    // A wallet returning yParity instead of 27/28
    expect(splitHubPermitSignature(`${r}${s.slice(2)}00`)).toEqual({
      r,
      s,
      v: 27,
    })
    expect(splitHubPermitSignature(`${r}${s.slice(2)}01`)).toEqual({
      r,
      s,
      v: 28,
    })
    // Malformed input fails instead of yielding shifted or truncated parts
    expect(() =>
      splitHubPermitSignature(`${r.slice(2)}${s.slice(2)}1c` as `0x${string}`)
    ).toThrow()
    expect(() => splitHubPermitSignature("0x1234")).toThrow()
  })

  it("is exported from the package root", () => {
    expect(sdk.getHubPermitHash).toBe(getHubPermitHash)
    expect(sdk.hubPermitTypes).toBe(hubPermitTypes)
    expect(sdk.getTransferExecutionId).toBe(getTransferExecutionId)
  })
})

describe("transfer execution id", () => {
  it("is the oracle's deterministic id: sha256 of the lowercased colon-joined fields", () => {
    const fields = {
      hubId: "relay-devnet",
      hubTokenId: 1234n,
      from: "0xA11a5A11A5a11A5A11A5A11a5a11A5a11A5A11A5",
      to: OWNER,
      nonce: `0x${"ab".repeat(32)}`,
    }
    const expected = `0x${createHash("sha256")
      .update(
        `relay-devnet:1234:${fields.from}:${OWNER}:${fields.nonce}`.toLowerCase()
      )
      .digest("hex")}`
    expect(getTransferExecutionId(fields)).toBe(expected)
    expect(getTransferExecutionId({ ...fields, hubTokenId: "1234" })).toBe(
      expected
    )
  })
})
