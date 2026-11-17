import { describe, it, expect } from "vitest"

import { ActionType, encodeAction } from "../src/messages/v2.2/execution"
import {
  OracleExecutionMessage,
  getOracleExecutionHash,
} from "../src/messages/v2.4/execution"

const oracle = "0x4242424242424242424242424242424242424242"
const execution = {
  idempotencyKey: "0x" + "ab".repeat(32),
  actions: [
    encodeAction({
      type: ActionType.MINT,
      data: {
        hubToAddress: "0x" + "11".repeat(20),
        hubTokenId: 1n,
        amount: "1000",
      },
    }),
  ],
  expiration: 1_900_000_000n,
}

describe("v2.4 oracle execution", () => {
  // Fixture mirrored by `test_executionHashMatchesSdkFixture` in
  // smart-contracts/test/RelayInbox/SdkFixture.t.sol — the oracle signs this
  // digest, so both sides must derive it identically
  it("hashes the Solidity Execution EIP-712 shape", () => {
    expect(getOracleExecutionHash(31337, oracle, execution)).toBe(
      "0xda5f83f243973373bf600d68b6f310c8870533adfa2b0c486b282b908a4b62cd"
    )
  })

  // Mirrored by `test_multiActionExecutionHashMatchesSdkFixture`
  it("hashes a multi-action execution", () => {
    expect(
      getOracleExecutionHash(31337, oracle, {
        ...execution,
        actions: [
          execution.actions[0],
          encodeAction({
            type: ActionType.MINT,
            data: {
              hubToAddress: "0x" + "22".repeat(20),
              hubTokenId: 2n,
              amount: "5",
            },
          }),
        ],
      })
    ).toBe("0x4ceb8673aee13f255fa87bff6a204e751cb740af6b56e4fdaf37b457d2ded156")
  })

  // Mirrored by `test_emptyExecutionHashMatchesSdkFixture`
  it("hashes an execution with no actions", () => {
    expect(
      getOracleExecutionHash(31337, oracle, { ...execution, actions: [] })
    ).toBe("0xe4adf8f321128aaa4746855d7ba38c5d8bb9bd74518e6767af49f41763c18a52")
  })

  // The producer carries the execution as an `OracleExecutionMessage`
  it("hashes an OracleExecutionMessage without a cast", () => {
    const message: OracleExecutionMessage = {
      ...execution,
      metadata: [
        {
          hubTokenId: 1n,
          origin: {
            address: "0x" + "33".repeat(20),
            chainId: "1",
            family: "ethereum-vm",
          },
          oracleChainId: "31337",
          oracleContract: oracle,
        },
      ],
    }
    expect(getOracleExecutionHash(31337, oracle, message)).toBe(
      "0xda5f83f243973373bf600d68b6f310c8870533adfa2b0c486b282b908a4b62cd"
    )
  })

  it("binds the expiration", () => {
    expect(getOracleExecutionHash(31337, oracle, execution)).not.toBe(
      getOracleExecutionHash(31337, oracle, {
        ...execution,
        expiration: execution.expiration + 1n,
      })
    )
  })
})
