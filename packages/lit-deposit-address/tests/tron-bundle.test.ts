import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, type Plugin } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DepositAddressTriggerDerivationFields, WalletInfo } from "../src/common/types.js";
import {
  encodeSignedTronTransaction,
  type ParsedTronTransaction,
} from "../src/common/tron/transaction.js";
import { deriveWallet } from "../src/derivation/index.js";
import { derivationFieldsToIndexes } from "../src/derivation/path.js";

const require = createRequire(import.meta.url);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rootKey = `0x${"11".repeat(32)}`;
const referenceTriggerRawData =
  "0x0a02abcd2208001122334455667740e0a499ffbc315ab101081f12ac010a31747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e54726967676572536d617274436f6e747261637412770a15417e5f4552091a69125d5dfcb7b8c2659029395bdf121541f0623e1012177482912fb057e44e1a9769b1f58818e807224449290c1c000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000007080d095ffbc31900180c2d72f";
const derivationFields: DepositAddressTriggerDerivationFields = {
  inputVmType: "tron-vm",
  outputVmType: "tron-vm",
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

const urlPackages = new Map<string, string>([
  ["https://cdn.jsdelivr.net/npm/viem@2.48.11/+esm", "viem"],
  ["https://cdn.jsdelivr.net/npm/tronweb@6.1.0/+esm", "tronweb"],
  ["https://cdn.jsdelivr.net/npm/@metamask/key-tree@10.1.1/+esm", "@metamask/key-tree"],
  [
    "https://cdn.jsdelivr.net/npm/@noble/curves@2.0.1/secp256k1.js/+esm",
    "@noble/curves/secp256k1.js",
  ],
  ["https://cdn.jsdelivr.net/npm/@noble/hashes@2.0.1/utils.js/+esm", "@noble/hashes/utils.js"],
  ["https://cdn.jsdelivr.net/npm/@noble/hashes@2.0.1/sha2.js/+esm", "@noble/hashes/sha2.js"],
  ["https://cdn.jsdelivr.net/npm/@noble/hashes@2.0.1/sha3.js/+esm", "@noble/hashes/sha3.js"],
  ["https://cdn.jsdelivr.net/npm/@noble/hashes@2.0.1/hkdf.js/+esm", "@noble/hashes/hkdf.js"],
  ["https://cdn.jsdelivr.net/npm/@noble/hashes@2.0.1/legacy.js/+esm", "@noble/hashes/legacy.js"],
  ["https://cdn.jsdelivr.net/npm/@scure/base@2.0.0/+esm", "@scure/base"],
]);

let temporaryDirectory: string;
let bundledMain: (params: Record<string, unknown>) => Promise<unknown>;
let bundledDecodeTronRawData: (encoded: string) => ParsedTronTransaction;
let bundledTronTransactionHash: (encodedRawData: string) => string;
let bundledEncodeSignedTronTransaction: (
  parsed: ParsedTronTransaction,
  signature: Uint8Array,
) => string;

beforeAll(async () => {
  execFileSync(
    process.execPath,
    [require.resolve("tsx/cli"), "scripts/bundle-actions.ts", "--env", "dev"],
    {
      cwd: packageRoot,
      stdio: "pipe",
    },
  );
  temporaryDirectory = await mkdtemp(resolve(tmpdir(), "tron-lit-bundle-"));
  const executableBundle = resolve(temporaryDirectory, "tron-vm.mjs");
  const codecBundle = resolve(temporaryDirectory, "tron-codec.mjs");
  const localDependencies: Plugin = {
    name: "local-lit-action-dependencies",
    setup(esbuild) {
      esbuild.onResolve({ filter: /^https:\/\/cdn\.jsdelivr\.net\// }, async (args) => {
        const packageName = urlPackages.get(args.path);
        if (!packageName) {
          throw new Error(`unmapped Lit Action dependency: ${args.path}`);
        }
        return esbuild.resolve(packageName, { kind: args.kind, resolveDir: packageRoot });
      });
    },
  };
  await build({
    entryPoints: [resolve(packageRoot, "dist/actions/dev/tron-vm.js")],
    outfile: executableBundle,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "es2022",
    treeShaking: false,
    plugins: [localDependencies],
    footer: { js: "export { main };" },
    logLevel: "silent",
  });
  const module = (await import(pathToFileURL(executableBundle).href)) as {
    main: (params: Record<string, unknown>) => Promise<unknown>;
  };
  bundledMain = module.main;
  await build({
    entryPoints: [resolve(packageRoot, "src/common/tron/transaction.ts")],
    outfile: codecBundle,
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    treeShaking: false,
    plugins: [localDependencies],
    logLevel: "silent",
  });
  const codecModule = (await import(pathToFileURL(codecBundle).href)) as {
    decodeTronRawData: (encoded: string) => ParsedTronTransaction;
    tronTransactionHash: (encodedRawData: string) => string;
    encodeSignedTronTransaction: (parsed: ParsedTronTransaction, signature: Uint8Array) => string;
  };
  bundledDecodeTronRawData = codecModule.decodeTronRawData;
  bundledTronTransactionHash = codecModule.tronTransactionHash;
  bundledEncodeSignedTronTransaction = codecModule.encodeSignedTronTransaction;
});

afterAll(async () => {
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

describe("generated tron-vm Lit Action bundle", () => {
  it("executes the TronWeb codec from a Lit-compatible bundle", () => {
    const parsed = bundledDecodeTronRawData(referenceTriggerRawData);
    const signature = Uint8Array.from({ length: 65 }, (_, index) => index);
    const signed = bundledEncodeSignedTronTransaction(parsed, signature);

    expect(parsed.rawData.contract).toMatchObject({
      type: "TriggerSmartContract",
      ownerAddress: "417e5f4552091a69125d5dfcb7b8c2659029395bdf",
      contractAddress: "41f0623e1012177482912fb057e44e1a9769b1f588",
      callValue: 1_000n,
    });
    expect(bundledTronTransactionHash(referenceTriggerRawData)).toBe(
      "fb0b414d1cfd6a8cee09d96efc2a53f1349fb3c9cac49cb34fc14d8cd31a21e0",
    );
    expect(signed).toBe(encodeSignedTronTransaction(parsed, signature));
    expect(signed.endsWith(Buffer.from(signature).toString("hex"))).toBe(true);
  });

  it("returns the same public wallet as source derivation", async () => {
    Object.assign(globalThis, {
      Lit: { Actions: { getPrivateKey: async () => rootKey } },
    });
    const indexes = derivationFieldsToIndexes(derivationFields);
    const expected = await deriveWallet(rootKey, "tron-vm", indexes);
    const actual = (await bundledMain({
      pkpId: "0x1234",
      action: "wallet",
      derivationFields,
    })) as WalletInfo;

    expect(actual).toEqual(expected);
  });
});
