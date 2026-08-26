import { describe, expect, it } from "vitest";
import type { DepositAddressTriggerDerivationFields } from "../src/common/types.js";
import { deriveAccount, deriveWallet, type AccountInfo } from "../src/derivation/index.js";
import { derivationFieldsToIndexes } from "../src/derivation/path.js";
import {
  deriveDepositWallet,
  derivationFieldsToIndexes as localDerivationFieldsToIndexes,
  type AccountResponse,
  type DerivationFields,
} from "../scripts/client/local-derivation.js";

const ROOT_KEY = `0x${"11".repeat(32)}`;
const EXPECTED_V2_INDEXES = [
  712433122, 929844241, 413308361, 981927593, 490777477, 1212769592, 1455078799, 128105356,
];

const derivationFields: DepositAddressTriggerDerivationFields = {
  inputVmType: "ethereum-vm",
  outputVmType: "ethereum-vm",
  outputChainId: "1",
  outputCurrency: "0x0000000000000000000000000000000000000000",
  outputRecipient: "0x000000000000000000000000000000000000dead",
  solver: "0x0000000000000000000000000000000000000001",
  pricingOracle: "0x0000000000000000000000000000000000000002",
  depositor: "0x000000000000000000000000000000000000beef",
  refundRecipient: "0x000000000000000000000000000000000000cafe",
  priceImpactBps: "50",
  salt: "123",
};

function toAccountResponse(account: AccountInfo): AccountResponse {
  return {
    vmType: account.vmType,
    accountPath: account.accountPath,
    publicKey: account.publicKey,
    extendedPublicKey: account.extendedPublicKey,
  };
}

describe("scripts/client/local-derivation parity with src/", () => {
  it("derivationFieldsToIndexes produces the same indexes off- and in-TEE", () => {
    const inTee = derivationFieldsToIndexes(derivationFields);
    const offTee = localDerivationFieldsToIndexes(derivationFields as DerivationFields);
    expect(inTee).toEqual(EXPECTED_V2_INDEXES);
    expect(offTee).toEqual(inTee);
  });

  it("binds the derivation indexes to the v2 salt", () => {
    const indexes = derivationFieldsToIndexes(derivationFields);
    const changedSaltIndexes = derivationFieldsToIndexes({ ...derivationFields, salt: "124" });
    const withoutSalt: Partial<DepositAddressTriggerDerivationFields> = { ...derivationFields };
    delete withoutSalt.salt;

    expect(changedSaltIndexes).not.toEqual(indexes);
    expect(() =>
      derivationFieldsToIndexes(withoutSalt as DepositAddressTriggerDerivationFields),
    ).toThrow();
  });

  for (const vmType of [
    "ethereum-vm",
    "bitcoin-vm",
    "solana-vm",
    "hyperliquid-vm",
    "tron-vm",
  ] as const) {
    it(`deriveDepositWallet matches deriveWallet for ${vmType}`, async () => {
      const fields: DepositAddressTriggerDerivationFields = {
        ...derivationFields,
        inputVmType: vmType,
        outputVmType: vmType,
      };
      const account = toAccountResponse(await deriveAccount(ROOT_KEY, vmType));
      const indexes = derivationFieldsToIndexes(fields);

      const inTee = await deriveWallet(ROOT_KEY, vmType, indexes);
      const offTee = await deriveDepositWallet(account, fields as DerivationFields);

      expect(offTee.address).toBe(inTee.address);
      expect(offTee.publicKey).toBe(inTee.publicKey);
      expect(offTee.indexes).toEqual(inTee.indexes);
      expect(offTee.path).toBe(inTee.path);
    });
  }
});
