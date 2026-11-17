import { describe, it, expect } from "vitest"
import { encodeAbiParameters, hashStruct, keccak256, toHex } from "viem"

import {
  getWithdrawRequestAuthorizationHash,
  getWithdrawRequestAuthorizationTypedData,
  withdrawRequestAuthorizationTypes,
} from "../src/messages/v2.4/withdraw-request-authorization"

const allocator = "0xa110ca70a110cA70a110CA70a110cA70a110cA70"
const request = {
  chainId: "ethereum-mainnet",
  depository: "0x" + "22".repeat(20),
  currency: "0x" + "00".repeat(20),
  amount: "10",
  spenderChainId: "relay",
  // `vm.addr(0xA11CE)`, the key the Foundry fixture signs with
  spender: "0xe05fcC23807536bEe418f142D19fa0d21BB0cfF7",
  receiver: "0x" + "33".repeat(20),
  data: "0x",
  nonce: "0x" + "cd".repeat(32),
}
const expiration = 1_900_000_000n

// `RelayAllocator.WITHDRAW_REQUEST_AUTHORIZATION_TYPEHASH`, verbatim
const WITHDRAW_REQUEST_AUTHORIZATION_TYPE =
  "WithdrawRequestAuthorization(WithdrawRequest request,uint256 expiration)WithdrawRequest(string chainId,bytes depository,bytes currency,uint256 amount,string spenderChainId,bytes spender,bytes receiver,bytes data,bytes32 nonce)"

describe("v2.4 withdraw authorization", () => {
  // Fixture mirrored by `test_withdrawRequestAuthorizationHashMatchesSdkFixture` in
  // contracts/relay-chain/test/RelayAllocator/sdkFixture.t.sol — the spender
  // signs this digest, so both sides must derive it identically
  it("hashes the Solidity WithdrawRequestAuthorization EIP-712 shape", () => {
    expect(
      getWithdrawRequestAuthorizationHash(31337, allocator, {
        request,
        expiration,
      })
    ).toBe("0x0528bdd3cecf713e0b53a65410a0385df137513506bc809a556a412c8b4bcdc8")
  })

  // Nested encodeType: primary type first, then the referenced `WithdrawRequest`
  it("encodes the nested type as the contract's typehash string", () => {
    const { message } = getWithdrawRequestAuthorizationTypedData(
      31337,
      allocator,
      {
        request,
        expiration,
      }
    )

    expect(
      hashStruct({
        types: withdrawRequestAuthorizationTypes,
        primaryType: "WithdrawRequestAuthorization",
        data: message,
      })
    ).toBe(
      keccak256(
        encodeAbiParameters(
          [{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }],
          [
            keccak256(toHex(WITHDRAW_REQUEST_AUTHORIZATION_TYPE)),
            hashStruct({
              types: withdrawRequestAuthorizationTypes,
              primaryType: "WithdrawRequest",
              data: message.request,
            }),
            expiration,
          ]
        )
      )
    )
  })

  it("binds the expiration", () => {
    expect(
      getWithdrawRequestAuthorizationHash(31337, allocator, {
        request,
        expiration,
      })
    ).not.toBe(
      getWithdrawRequestAuthorizationHash(31337, allocator, {
        request,
        expiration: expiration + 1n,
      })
    )
  })

  it("binds the request", () => {
    expect(
      getWithdrawRequestAuthorizationHash(31337, allocator, {
        request,
        expiration,
      })
    ).not.toBe(
      getWithdrawRequestAuthorizationHash(31337, allocator, {
        request: { ...request, amount: "11" },
        expiration,
      })
    )
  })
})
