import { keccak_256 } from "@noble/hashes/sha3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createApiKeyBackend,
  createChainSecuredBackend,
  type ActionInfo,
  type SetupBackend,
} from "@relay-protocol/lit-helpers/setup";
import { ACTION_VERSIONS, VM_TYPES, actionBasenameForVm } from "../../scripts/env.js";

const ACTION_VERSION = ACTION_VERSIONS.dev;
import { main } from "../../scripts/setup.js";

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  readFileSync: (path: string) => path,
}));

vi.mock("../../scripts/env.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../scripts/env.js")>()),
  loadEnvironment: () => ({
    name: "dev",
    allocatorAddress: "0x95bb2652BaA8a1177f750d92384527c5814f5254",
    hubEvmChainId: 537724,
  }),
}));

vi.mock("@relay-protocol/lit-helpers/setup", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@relay-protocol/lit-helpers/setup")>()),
  createApiKeyBackend: vi.fn(),
  createChainSecuredBackend: vi.fn(),
  printCalldataBatch: vi.fn(),
}));

const PKP = `0x${"12".repeat(20)}`;
const GROUP_ID = 1n;
/** A v1 registration: unversioned managed name, different CID. */
const legacy: ActionInfo = { name: "allocator-dev-action-lighter-vm", actionHash: 1n };
/** An older versioned registration that is also stale. */
const legacyVersioned: ActionInfo = { name: "allocator-dev-action-ethereum-vm-v0", actionHash: 5n };
const unrelated: ActionInfo[] = [
  { name: "allocator-dev-action-custom", actionHash: 2n },
  { name: "allocator-prod-action-lighter-vm", actionHash: 3n },
  { actionHash: 4n },
];
const hashCid = (cid: string) =>
  BigInt(`0x${Buffer.from(keccak_256(new TextEncoder().encode(cid))).toString("hex")}`);
const targetHashes = VM_TYPES.map((vm) => hashCid(`cid-${vm}`));

describe("allocator setup version retention", () => {
  let backend: SetupBackend;
  let registered: Set<bigint>;
  let attached: Set<bigint>;
  let operations: string[];
  let registeredNames: string[];

  beforeEach(() => {
    const actions = [legacy, legacyVersioned, ...unrelated];
    registered = new Set(actions.map((a) => a.actionHash));
    attached = new Set(registered);
    operations = [];
    registeredNames = [];
    backend = {
      mode: "api-key",
      listPkps: vi.fn(async () => [{ walletAddress: PKP }]),
      listGroups: vi.fn(async () => [{ id: GROUP_ID, name: "allocator-dev" }]),
      listActions: vi.fn(async () => actions),
      listUsageApiKeys: vi.fn(async () => [{ name: "allocator-dev-usage-key" }]),
      listPkpsInGroup: vi.fn(async () => [{ walletAddress: PKP }]),
      listActionsInGroup: vi.fn(async () => actions),
      createPkp: vi.fn(),
      addGroup: vi.fn(async (_name, _description, hashes) => {
        attached = new Set(hashes);
        operations.push("create-group");
        return GROUP_ID;
      }),
      addPkpToGroup: vi.fn(),
      addAction: vi.fn(async (name, _description, cid) => {
        registered.add(hashCid(cid));
        registeredNames.push(name);
        operations.push("register");
      }),
      addActionToGroup: vi.fn(async (_groupId, cid) => {
        attached.add(hashCid(cid));
        operations.push("attach");
      }),
      removeActionFromGroup: vi.fn(async (_groupId, hash) => {
        attached.delete(hash);
        operations.push("detach");
      }),
      removeAction: vi.fn(async (hash) => {
        registered.delete(hash);
        operations.push("remove");
      }),
      updateGroup: vi.fn(async (_groupId, params) => {
        attached = new Set(params.cidHashesPermitted);
      }),
      createUsageApiKey: vi.fn(),
    };
    vi.mocked(createApiKeyBackend).mockReturnValue(backend);
    vi.mocked(createChainSecuredBackend).mockReturnValue(backend);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init: RequestInit) => {
        const code = JSON.parse(init.body as string) as string;
        const vm = VM_TYPES.find((vm) => code.endsWith(`/${actionBasenameForVm(vm)}.js`));
        if (!vm) {
          throw new Error(`Unexpected bundle: ${code}`);
        }
        return new Response(JSON.stringify(`cid-${vm}`));
      }),
    );
  });

  it("preserves existing permissions when the group action endpoint is unsupported", async () => {
    vi.mocked(backend.listActionsInGroup).mockResolvedValue(undefined);
    await main(["--env", "dev", "--mode", "api-key", "--account-api-key", "test-key", "--pkp-id", PKP]);
    expect(backend.addActionToGroup).toHaveBeenCalled();
    expect(backend.updateGroup).not.toHaveBeenCalled();
    expect(attached).toEqual(new Set([...targetHashes, legacy.actionHash, legacyVersioned.actionHash, ...unrelated.map((a) => a.actionHash)]));
  });

  it("checks pruning prerequisites before attaching the requested PKP", async () => {
    vi.mocked(backend.listPkpsInGroup).mockResolvedValue([]);
    vi.mocked(backend.listActionsInGroup).mockResolvedValue(undefined);

    await expect(run("--prune-old-versions")).rejects.toThrow("Cannot prune action versions without a complete group permission list");

    expect(backend.addPkpToGroup).not.toHaveBeenCalled();
    expect(backend.updateGroup).not.toHaveBeenCalled();
    expect(operations).toEqual([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const run = (...args: string[]) =>
    main([
      "--env",
      "dev",
      "--mode",
      "api-key",
      "--account-api-key",
      "test-key",
      "--pkp-id",
      PKP,
      ...args,
    ]);

  it("registers new actions under version-suffixed names", async () => {
    await run();
    expect(registeredNames).toEqual(
      VM_TYPES.map((vm) => `allocator-dev-action-${vm}-${ACTION_VERSION}`),
    );
  });

  for (const mode of ["api-key", "chain-secured", "calldata"]) {
    for (const prune of [false, true]) {
      it(`${mode} ${prune ? "prunes only managed old versions after attaching replacements" : "preserves legacy permissions"}`, async () => {
        await main([
          "--env",
          "dev",
          "--mode",
          mode === "calldata" ? "chain-secured" : mode,
          "--account-api-key",
          "test-key",
          "--pkp-id",
          PKP,
          ...(mode === "calldata"
            ? ["--calldata"]
            : mode === "chain-secured"
              ? ["--private-key", "test-key"]
              : []),
          ...(prune ? ["--prune-old-versions"] : []),
        ]);

        const expected = new Set([
          ...targetHashes,
          ...unrelated.map((a) => a.actionHash),
          ...(prune ? [] : [legacy.actionHash, legacyVersioned.actionHash]),
        ]);
        expect(registered).toEqual(expected);
        expect(attached).toEqual(expected);
        if (prune) {
          expect(backend.removeAction).toHaveBeenCalledTimes(2);
          expect(backend.removeAction).toHaveBeenCalledWith(legacy.actionHash);
          expect(backend.removeAction).toHaveBeenCalledWith(legacyVersioned.actionHash);
          expect(backend.removeActionFromGroup).toHaveBeenCalledWith(GROUP_ID, legacy.actionHash);
          expect(operations.indexOf("detach")).toBeGreaterThan(operations.lastIndexOf("attach"));
          expect(operations.indexOf("detach")).toBeGreaterThan(operations.lastIndexOf("register"));
        } else {
          expect(backend.removeAction).not.toHaveBeenCalled();
          expect(backend.removeActionFromGroup).not.toHaveBeenCalled();
        }
      });
    }
  }

  it.each([false, true])(
    "dry-run previews pruning only when requested (%s) without writes",
    async (prune) => {
      await run("--dry-run", ...(prune ? ["--prune-old-versions"] : []));
      expect(operations).toEqual([]);
      expect(backend.updateGroup).not.toHaveBeenCalled();
      const output = vi.mocked(console.log).mock.calls.flat().join("\n");
      expect(output.includes("Would prune")).toBe(prune);
      expect(output).toContain(`0x${legacy.actionHash.toString(16).padStart(64, "0")}`);
    },
  );

  it.each(["addAction", "addActionToGroup"] as const)(
    "preserves old versions when %s fails",
    async (method) => {
      vi.mocked(backend[method]).mockRejectedValueOnce(new Error("replacement failed"));
      await expect(run("--prune-old-versions")).rejects.toThrow("replacement failed");
      expect(backend.removeAction).not.toHaveBeenCalled();
      expect(backend.removeActionFromGroup).not.toHaveBeenCalled();
      expect(attached.has(legacy.actionHash)).toBe(true);
      expect(registered.has(legacy.actionHash)).toBe(true);
    },
  );

  it("prunes on a later run when replacements are already registered and attached", async () => {
    const actions = [
      legacy,
      legacyVersioned,
      ...unrelated,
      ...VM_TYPES.map((vm) => ({
        name: `allocator-dev-action-${vm}-${ACTION_VERSION}`,
        actionHash: hashCid(`cid-${vm}`),
      })),
    ];
    registered = new Set(actions.map((a) => a.actionHash));
    attached = new Set(registered);
    vi.mocked(backend.listActions).mockResolvedValue(actions);
    vi.mocked(backend.listActionsInGroup).mockResolvedValue(actions);

    await run();
    expect(operations).toEqual([]);
    expect(backend.updateGroup).not.toHaveBeenCalled();

    await run("--prune-old-versions");
    expect(operations).toEqual(["detach", "remove", "detach", "remove"]);
    expect(attached).toEqual(new Set([...targetHashes, ...unrelated.map((a) => a.actionHash)]));
    expect(registered).toEqual(attached);
  });

  it("prunes old account registrations only after creating a missing group", async () => {
    vi.mocked(backend.listGroups).mockResolvedValue([]);
    await run("--prune-old-versions");
    expect(attached).toEqual(new Set(targetHashes));
    expect(operations.indexOf("remove")).toBeGreaterThan(operations.indexOf("create-group"));
    expect(backend.removeActionFromGroup).not.toHaveBeenCalled();
  });

  it("preserves old registrations if creating the replacement group fails", async () => {
    vi.mocked(backend.listGroups).mockResolvedValue([]);
    vi.mocked(backend.addGroup).mockRejectedValueOnce(new Error("group failed"));
    await expect(run("--prune-old-versions")).rejects.toThrow("group failed");
    expect(backend.removeAction).not.toHaveBeenCalled();
  });
});
