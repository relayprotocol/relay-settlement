import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import {
  deriveAccount,
  deriveWallet,
  deriveWalletFromExtendedPublicKey,
  getSupportedVmTypes,
} from "../src/derivation/index.js";
import { VM_TYPES, type VmType } from "../src/common/types.js";

const ROOT_KEY = `0x${"11".repeat(32)}`;
const OTHER_ROOT_KEY = `0x${"12".repeat(32)}`;
describe("derivation", () => {
  it("lists all supported vm types", () => {
    expect(getSupportedVmTypes().sort()).toEqual([...VM_TYPES].sort());
  });

  for (const vmType of VM_TYPES satisfies readonly VmType[]) {
    it(`derives a stable account public root for ${vmType}`, async () => {
      const first = await deriveAccount(ROOT_KEY, vmType);
      const second = await deriveAccount(ROOT_KEY, vmType);

      expect(second).toEqual(first);
      expect(first.vmType).toBe(vmType);
      expect(first.accountPath).toMatch(/^m\//u);
      expect(first.publicKey.length).toBeGreaterThan(0);
      expect(first.extendedPublicKey.length).toBeGreaterThan(0);
    });

    it(`public derivation matches private derivation for ${vmType}`, async () => {
      const path = [7];
      const account = await deriveAccount(ROOT_KEY, vmType);
      const direct = await deriveWallet(ROOT_KEY, vmType, path);
      const publicOnly = await deriveWalletFromExtendedPublicKey(
        vmType,
        account.extendedPublicKey,
        path,
      );

      expect(publicOnly).toEqual(direct);
    });

    it(`multi-index public derivation matches private derivation for ${vmType}`, async () => {
      const path = [3, 5, 7, 9];
      const account = await deriveAccount(ROOT_KEY, vmType);
      const direct = await deriveWallet(ROOT_KEY, vmType, path);
      const publicOnly = await deriveWalletFromExtendedPublicKey(
        vmType,
        account.extendedPublicKey,
        path,
      );

      expect(direct.indexes).toEqual(path);
      expect(direct.path.endsWith("/3/5/7/9")).toBe(true);
      expect(publicOnly).toEqual(direct);
    });

    it(`different indexes derive different wallets for ${vmType}`, async () => {
      const first = await deriveWallet(ROOT_KEY, vmType, [0]);
      const second = await deriveWallet(ROOT_KEY, vmType, [1]);

      expect(second.address).not.toBe(first.address);
      expect(second.publicKey).not.toBe(first.publicKey);
      expect(first.path.endsWith("/0")).toBe(true);
      expect(second.path.endsWith("/1")).toBe(true);
    });

    it(`different root keys derive different wallets for ${vmType}`, async () => {
      const first = await deriveWallet(ROOT_KEY, vmType, [0]);
      const second = await deriveWallet(OTHER_ROOT_KEY, vmType, [0]);

      expect(second.address).not.toBe(first.address);
      expect(second.publicKey).not.toBe(first.publicKey);
    });
  }

  it("formats ethereum wallets", async () => {
    const wallet = await deriveWallet(ROOT_KEY, "ethereum-vm", [0]);

    expect(wallet.address).toMatch(/^0x[0-9a-f]{40}$/u);
    expect(wallet.publicKey).toMatch(/^0x0[23][0-9a-f]{64}$/u);
    expect(wallet.path).toBe("m/44'/60'/0'/0/0");
  });

  it("formats bitcoin wallets", async () => {
    const wallet = await deriveWallet(ROOT_KEY, "bitcoin-vm", [0]);

    expect(wallet.address).toMatch(/^bc1[ac-hj-np-z02-9]+$/u);
    expect(wallet.publicKey).toMatch(/^0x0[23][0-9a-f]{64}$/u);
    expect(wallet.path).toBe("m/84'/0'/0'/0/0");
  });

  it("formats solana wallets", async () => {
    const wallet = await deriveWallet(ROOT_KEY, "solana-vm", [0]);

    expect(bs58.decode(wallet.address)).toHaveLength(32);
    expect(wallet.publicKey).toBe(wallet.address);
    expect(wallet.path).toBe("m/44'/501'/0'/0/0");
  });

  it("rejects invalid indexes", async () => {
    await expect(deriveWallet(ROOT_KEY, "ethereum-vm", [-1])).rejects.toThrow(
      "index must be an unhardened uint31",
    );
    await expect(deriveWallet(ROOT_KEY, "ethereum-vm", [0x8000_0000])).rejects.toThrow(
      "index must be an unhardened uint31",
    );
    await expect(deriveWallet(ROOT_KEY, "ethereum-vm", [1.5])).rejects.toThrow(
      "index must be an unhardened uint31",
    );
    await expect(deriveWallet(ROOT_KEY, "ethereum-vm", [])).rejects.toThrow(
      "at least one index is required",
    );
  });
});
