import { describe, it, expect } from "vitest"

import {
  getGenericMappingDeleteEntryHash,
  getGenericMappingSetEntryHash,
} from "../src/messages/v2.4/generic-mapping"

const mapping = "0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f"
const entry = {
  user: "0x" + "11".repeat(20),
  id: "0x" + "ab".repeat(32),
  data: "0x0102",
  nonce: "0x" + "cd".repeat(32),
  expiration: 1_900_000_000n,
}

describe("v2.4 generic mapping", () => {
  // Fixture mirrored by `test_setEntryHashMatchesSdkFixture` in
  // smart-contracts/test/GenericMapping/sdkFixture.t.sol — the oracle signs
  // this digest, so both sides must derive it identically
  it("hashes the Solidity SetEntry EIP-712 shape", () => {
    expect(getGenericMappingSetEntryHash(31337, mapping, entry)).toBe(
      "0xb6ee0ceb64cc2faa20c3d5ac09c31beb824c63dd4596190ee08fde8e6967ab7f"
    )
  })

  // Fixture mirrored by `test_deleteEntryHashMatchesSdkFixture` in
  // smart-contracts/test/GenericMapping/sdkFixture.t.sol
  it("hashes the Solidity DeleteEntry EIP-712 shape", () => {
    expect(
      getGenericMappingDeleteEntryHash(31337, mapping, {
        user: entry.user,
        id: entry.id,
        nonce: entry.nonce,
        expiration: entry.expiration,
      })
    ).toBe("0x8a5f0aff443f45827a3c734c569b3d81dc5617bf7fad7f8556ab2a3f30b9e6a3")
  })

  it("binds the expiration", () => {
    expect(getGenericMappingSetEntryHash(31337, mapping, entry)).not.toBe(
      getGenericMappingSetEntryHash(31337, mapping, {
        ...entry,
        expiration: entry.expiration + 1n,
      })
    )
  })
})
