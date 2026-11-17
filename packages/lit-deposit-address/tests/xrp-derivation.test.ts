import { classicAddressToXAddress } from "ripple-address-codec";
import { deriveAddress } from "ripple-keypairs";
import { describe, expect, it } from "vitest";
import { decodeAddressFromHex, encodeAddressToHex } from "../src/common/address.js";
import type { DepositAddressTriggerDerivationFields, VmType } from "../src/common/types.js";
import {
  deriveAccount,
  deriveWallet,
  deriveWalletFromExtendedPublicKey,
} from "../src/derivation/index.js";
import { derivationFieldsToIndexes } from "../src/derivation/path.js";
import { deriveDepositWallet, type AccountResponse } from "../scripts/client/local-derivation.js";
import fixture from "./xrp-derivation.fixture.json" with { type: "json" };

const vmType = "xrp-vm" as VmType;
const fields = fixture.protocolDerivationFields as DepositAddressTriggerDerivationFields;

describe("XRP derivation", () => {
  it("matches the XRP account root derived with Node HKDF and key-tree", async () => {
    await expect(deriveAccount(fixture.rootKeyHex, vmType)).resolves.toEqual(fixture.account);
  });

  it("derives the same frozen XRP wallet from private and public roots", async () => {
    expect(derivationFieldsToIndexes(fields)).toEqual(fixture.wallet.indexes);
    await expect(deriveWallet(fixture.rootKeyHex, vmType, fixture.wallet.indexes)).resolves.toEqual(
      fixture.wallet,
    );
    await expect(
      deriveWalletFromExtendedPublicKey(
        vmType,
        fixture.account.extendedPublicKey,
        fixture.wallet.indexes,
      ),
    ).resolves.toEqual(fixture.wallet);
    expect(deriveAddress(fixture.wallet.publicKey.slice(2))).toBe(fixture.wallet.address);
  });

  it("matches the XRP wallet in the existing local client", async () => {
    await expect(deriveDepositWallet(fixture.account as AccountResponse, fields)).resolves.toEqual(
      fixture.wallet,
    );
  });

  it("changes the XRP wallet when the salt changes", async () => {
    const indexes = derivationFieldsToIndexes({ ...fields, salt: "124" });
    const wallet = await deriveWalletFromExtendedPublicKey(
      vmType,
      fixture.account.extendedPublicKey,
      indexes,
    );
    expect(wallet.address).not.toBe(fixture.wallet.address);
  });

  it("preserves classic XRP addresses and the native currency sentinel", () => {
    const address = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
    expect(encodeAddressToHex(address, vmType)).toBe(fixture.derivationFields.depositor);
    expect(decodeAddressFromHex(fixture.derivationFields.depositor, vmType)).toBe(address);
    expect(encodeAddressToHex(classicAddressToXAddress(address, false, false), vmType)).toBe(
      fixture.derivationFields.depositor,
    );
    expect(encodeAddressToHex("rrrrrrrrrrrrrrrrrrrrrhoLvTp", vmType)).toBe(`0x${"00".repeat(20)}`);
  });

  it("rejects invalid checksums and tagged X-addresses", () => {
    const address = fixture.wallet.address;
    for (const invalid of [
      address.toLowerCase(),
      `${address.slice(0, -1)}r`,
      classicAddressToXAddress(address, 42, false),
    ]) {
      expect(() => encodeAddressToHex(invalid, vmType)).toThrow();
    }
    expect(() => decodeAddressFromHex("0x00", vmType)).toThrow();
  });

  it("rejects testnet X-addresses in the mainnet XRP path", () => {
    const address = classicAddressToXAddress(fixture.wallet.address, false, true);
    expect(() => encodeAddressToHex(address, vmType)).toThrow(/testnet/i);
  });

});
