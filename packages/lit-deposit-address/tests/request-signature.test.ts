import { beforeAll, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { Order } from "../src/common/relay-sdk.js";
import type { ActionParams } from "../src/vm/action.js";

const solverPk = `0x${"01".repeat(32)}` as const;
const solver = privateKeyToAccount(solverPk);
const other = privateKeyToAccount(`0x${"02".repeat(32)}`);

const order: Order = {
  version: "v1",
  solverChainId: "10",
  solver: solver.address.toLowerCase(),
  salt: `0x${"00".repeat(32)}`,
  inputs: [],
  output: {
    chainId: "1",
    payments: [],
    calls: [],
    deadline: 0xffff_ffff,
    extraData: "0x",
  },
  fees: [],
};

const baseParams: ActionParams<"ethereum-vm"> = {
  pkpId: "0x000000000000000000000000000000000000abcd",
  action: "sign",
  // Minimal placeholders — verifySolverRequestSignature does not read these
  // fields, it only hashes the canonical JSON of the params.
  trigger: {
    input: { vmType: "ethereum-vm", chainId: "10", currency: "0x", amount: "0" },
    derivationFields: {
      inputVmType: "ethereum-vm",
      outputVmType: "ethereum-vm",
      outputChainId: "1",
      outputCurrency: "0x",
      outputRecipient: "0x",
      solver: "0x",
      pricingOracle: "0x",
      depositor: "0x",
      refundRecipient: "0x",
      priceImpactBps: "0",
      salt: "123",
    },
    orderId: `0x${"00".repeat(32)}`,
    nonce: "0",
    currencies: [],
    prices: [],
    extraData: "0x",
  },
  attestation: {
    chainId: 1,
    depositAddressManager: "0x0000000000000000000000000000000000000001",
    inputDepository: "0x",
    triggerHash: `0x${"00".repeat(32)}`,
    signatures: [],
  },
  order,
  orderSignature: "0x",
  transactions: [{ unsignedTransaction: "0x" }],
};

beforeAll(() => {
  Object.assign(globalThis, {
    __DEPOSIT_ADDRESS_MANAGER_ADDRESS__: "0x0000000000000000000000000000000000000001",
    __HUB_EVM_CHAIN_ID__: "1",
    __ALLOWED_ORACLES__: JSON.stringify([]),
    __ORACLE_SIGNATURE_THRESHOLD__: "0",
  });
});

async function signRequest(params: ActionParams<"ethereum-vm">): Promise<string> {
  const { solverSignRequestHash } = await import("../src/vm/action.js");
  const hash = solverSignRequestHash(params as unknown as Record<string, unknown>);
  return solver.signMessage({ message: { raw: hash as `0x${string}` } });
}

describe("solverSignRequestHash", () => {
  it("is independent of object key ordering at every nesting level", async () => {
    const { solverSignRequestHash } = await import("../src/vm/action.js");
    const a = {
      action: "sign",
      trigger: { input: { chainId: "10", amount: "1", currency: "0x" } },
      transactions: [{ unsignedTransaction: "0x", note: "x" }],
    } as Record<string, unknown>;
    const b = {
      transactions: [{ note: "x", unsignedTransaction: "0x" }],
      trigger: { input: { currency: "0x", chainId: "10", amount: "1" } },
      action: "sign",
    } as Record<string, unknown>;

    expect(solverSignRequestHash(a)).toBe(solverSignRequestHash(b));
  });

  it("strips requestSignature regardless of nesting depth", async () => {
    const { solverSignRequestHash } = await import("../src/vm/action.js");
    const withSig = {
      action: "sign",
      requestSignature: "0xtop",
      trigger: { requestSignature: "0xnested", input: { chainId: "10" } },
      transactions: [{ requestSignature: "0xarr", unsignedTransaction: "0x" }],
    } as Record<string, unknown>;
    const withoutSig = {
      action: "sign",
      trigger: { input: { chainId: "10" } },
      transactions: [{ unsignedTransaction: "0x" }],
    } as Record<string, unknown>;

    expect(solverSignRequestHash(withSig)).toBe(solverSignRequestHash(withoutSig));
  });

  it("changes when any non-signature field changes", async () => {
    const { solverSignRequestHash } = await import("../src/vm/action.js");
    const base = { action: "sign", value: 1 } as Record<string, unknown>;
    const mutated = { action: "sign", value: 2 } as Record<string, unknown>;
    expect(solverSignRequestHash(base)).not.toBe(solverSignRequestHash(mutated));
  });

  it("treats `undefined`-valued entries like JSON.stringify (drops them)", async () => {
    const { solverSignRequestHash } = await import("../src/vm/action.js");
    const withUndefined = {
      action: "sign",
      trigger: { input: { chainId: "10" }, attestation: undefined },
      transactions: [{ unsignedTransaction: "0x", optional: undefined }],
      optional: undefined,
    } as Record<string, unknown>;
    const withoutUndefined = {
      action: "sign",
      trigger: { input: { chainId: "10" } },
      transactions: [{ unsignedTransaction: "0x" }],
    } as Record<string, unknown>;
    expect(solverSignRequestHash(withUndefined)).toBe(solverSignRequestHash(withoutUndefined));
  });
});

describe("verifySolverRequestSignature", () => {
  it("accepts a request signed by order.solver", async () => {
    const { verifySolverRequestSignature } = await import("../src/vm/action.js");
    const signature = await signRequest(baseParams);
    expect(() => verifySolverRequestSignature(baseParams, order, signature)).not.toThrow();
  });

  it("rejects a request signed by a different EOA", async () => {
    const { solverSignRequestHash, verifySolverRequestSignature } = await import(
      "../src/vm/action.js"
    );
    const hash = solverSignRequestHash(baseParams as unknown as Record<string, unknown>);
    const signature = await other.signMessage({ message: { raw: hash as `0x${string}` } });
    expect(() => verifySolverRequestSignature(baseParams, order, signature)).toThrow(
      /requestSignature mismatch/,
    );
  });

  it("rejects when the request body is mutated after signing", async () => {
    const { verifySolverRequestSignature } = await import("../src/vm/action.js");
    const signature = await signRequest(baseParams);
    const mutated: ActionParams<"ethereum-vm"> = {
      ...baseParams,
      transactions: [{ unsignedTransaction: "0xdeadbeef" }],
    };
    expect(() => verifySolverRequestSignature(mutated, order, signature)).toThrow(
      /requestSignature mismatch/,
    );
  });

  it("accepts a signed request even when requestSignature is supplied inline on the params", async () => {
    const { verifySolverRequestSignature } = await import("../src/vm/action.js");
    const signature = await signRequest(baseParams);
    // Caller round-trips the params back through verify with the signature
    // attached — the strip logic must drop it before hashing.
    const withSignature = { ...baseParams, requestSignature: signature };
    expect(() => verifySolverRequestSignature(withSignature, order, signature)).not.toThrow();
  });
});

describe("runVmAction sign request signature gate", () => {
  it("rejects sign requests with no requestSignature", async () => {
    const { runVmAction } = await import("../src/vm/action.js");
    const { EthereumVmWalletDeriver } = await import(
      "../src/derivation/vm/ethereum/EthereumVmWalletDeriver.js"
    );
    Object.assign(globalThis, {
      Lit: { Actions: { getPrivateKey: async () => `0x${"11".repeat(32)}` } },
    });
    await expect(
      runVmAction("ethereum-vm", new EthereumVmWalletDeriver(), baseParams),
    ).rejects.toThrow(/requestSignature is required/);
  });

  it("rejects sign requests whose requestSignature recovers to a different EOA", async () => {
    const { runVmAction, solverSignRequestHash } = await import("../src/vm/action.js");
    const { EthereumVmWalletDeriver } = await import(
      "../src/derivation/vm/ethereum/EthereumVmWalletDeriver.js"
    );
    Object.assign(globalThis, {
      Lit: { Actions: { getPrivateKey: async () => `0x${"11".repeat(32)}` } },
    });
    const hash = solverSignRequestHash(baseParams as unknown as Record<string, unknown>);
    const requestSignature = await other.signMessage({ message: { raw: hash as `0x${string}` } });
    await expect(
      runVmAction("ethereum-vm", new EthereumVmWalletDeriver(), {
        ...baseParams,
        requestSignature,
      }),
    ).rejects.toThrow(/requestSignature mismatch/);
  });
});
