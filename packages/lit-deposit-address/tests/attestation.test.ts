import { getDepositAddressTriggerHash } from "@relay-protocol/settlement-sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { DepositAddressTrigger } from "../src/common/types.js";

const oracle = privateKeyToAccount(`0x${"01".repeat(32)}`);
const depositAddressManager = "0x357dfbec07a628e934bdb3642056fd72f10a7902";
const inputDepository =
  "0x000000000000000000000000c0000000000000000000000000000000000000ff" as const;
const chainId = 421614;
const trigger: DepositAddressTrigger = {
  input: {
    vmType: "solana-vm",
    chainId: "solana-devnet",
    currency: "0x01",
    amount: "1000000",
  },
  derivationFields: {
    inputVmType: "solana-vm",
    outputVmType: "ethereum-vm",
    outputChainId: "1",
    outputCurrency: "0x0000000000000000000000000000000000000000",
    outputRecipient: "0x0000000000000000000000000000000000000002",
    solver: "0x0000000000000000000000000000000000000003",
    pricingOracle: "0x0000000000000000000000000000000000000004",
    depositor: "0x05",
    refundRecipient: "0x06",
    priceImpactBps: "50",
  },
  orderId: `0x${"11".repeat(32)}`,
  nonce: "1",
  currencies: [{ chainId: "solana-devnet", currency: "0x01" }],
  prices: [
    { usdPrice: "100000000", usdPriceDecimals: 8, currencyDecimals: 18, expiration: "1735689600" },
  ],
  extraData: "0x",
};
const triggerHash = getDepositAddressTriggerHash(trigger);

beforeAll(() => {
  Object.assign(globalThis, {
    __DEPOSIT_ADDRESS_MANAGER_ADDRESS__: depositAddressManager,
    __HUB_EVM_CHAIN_ID__: chainId.toString(),
    __ALLOWED_ORACLES__: JSON.stringify([oracle.address]),
    __ORACLE_SIGNATURE_THRESHOLD__: "1",
  });
});

describe("trigger attestation", () => {
  it("derives indexes solely from derivation fields", async () => {
    const { derivationFieldsToIndexes } = await import("../src/derivation/path.js");
    const indexes = derivationFieldsToIndexes(trigger.derivationFields);

    expect(indexes).toHaveLength(8);
    for (const index of indexes) {
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThanOrEqual(0x7fff_ffff);
    }
    expect(
      derivationFieldsToIndexes({
        ...trigger.derivationFields,
        outputRecipient: "0x0000000000000000000000000000000000000009",
      }),
    ).not.toEqual(indexes);
    expect(
      derivationFieldsToIndexes({
        ...trigger.derivationFields,
      }),
    ).toEqual(indexes);
  });

  it("verifies signed trigger attestations", async () => {
    const { verifyDepositAddressTriggerAttestation } = await import("../src/attestation/index.js");
    const signature = await oracle.signTypedData({
      domain: {
        chainId: BigInt(chainId),
        name: "Trigger",
        verifyingContract: "0x0000000000000000000000000000000000000000",
        version: "1",
      },
      message: {
        chainId: BigInt(chainId),
        depositAddressManager,
        inputDepository,
        triggerHash,
      },
      primaryType: "Trigger",
      types: {
        Trigger: [
          { name: "chainId", type: "uint256" },
          { name: "depositAddressManager", type: "address" },
          { name: "inputDepository", type: "bytes" },
          { name: "triggerHash", type: "bytes32" },
        ],
      },
    });

    await expect(
      verifyDepositAddressTriggerAttestation(trigger, {
        chainId,
        depositAddressManager,
        inputDepository,
        triggerHash,
        signatures: [{ oracleSigner: oracle.address, signature }],
      }),
    ).resolves.toBeUndefined();
  });
});
