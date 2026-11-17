import { describe, expect, it } from "vitest"
import { privateKeyToAccount } from "viem/accounts"
import { verifyMessage } from "viem"
import {
  TransferConsent,
  getTransferConsentMessage,
} from "../src/messages/v2.3/transfer-consent"
import * as sdk from "../src"

const consent: TransferConsent = {
  hubChainId: "537724",
  hubAddress: "0xA884543c91156098B2e50aE17c3840770B7B55f5",
  expiration: 1760000000,
  chainId: "base",
  currency: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  amount: "10000000",
  ownerChainId: "base",
  owner: "0x28c50f9329d14b1ee7a3a38a2064e2348950d6b3",
  recipient: "0x7daf3d1ec43294cbdd39a4c54a2343e6342a92cb",
  nonce: "0x5fd0104e2e6bfc5d0f8760488a566f4e5f9b3602245fb2a7ebc613b83dfa6331",
}

describe("transfer consent", () => {
  it("is the oracle's stable-stringified payload: sorted keys, compact, hub address lowercased", () => {
    // What `json-stable-stringify(createTransferSignaturePayload(data))` yields in relay-protocol-oracle
    expect(getTransferConsentMessage(consent)).toBe(
      '{"amount":"10000000","chainId":"base","currency":"0x833589fcd6edb6e08f4c7c32d4f71b54bda02913","expiration":1760000000,"hubAddress":"0xa884543c91156098b2e50ae17c3840770b7b55f5","hubChainId":"537724","nonce":"0x5fd0104e2e6bfc5d0f8760488a566f4e5f9b3602245fb2a7ebc613b83dfa6331","operation":"transfer","owner":"0x28c50f9329d14b1ee7a3a38a2064e2348950d6b3","ownerChainId":"base","recipient":"0x7daf3d1ec43294cbdd39a4c54a2343e6342a92cb"}'
    )
  })

  it("verifies as a plain EVM message from the owner", async () => {
    const account = privateKeyToAccount(`0x${"11".repeat(32)}`)
    const message = getTransferConsentMessage({
      ...consent,
      owner: account.address,
    })
    const signature = await account.signMessage({ message })
    expect(
      await verifyMessage({ address: account.address, message, signature })
    ).toBe(true)
  })

  it("is exported from the package root", () => {
    expect(sdk.getTransferConsentMessage).toBe(getTransferConsentMessage)
  })
})
