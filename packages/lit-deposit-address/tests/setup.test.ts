import { keccak_256 } from "@noble/hashes/sha3.js";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createApiKeyBackend,
  createChainSecuredBackend,
  type ActionInfo,
  type SetupBackend,
} from "@relay-protocol/lit-helpers/setup";
import { ACTION_VERSION, VM_TYPES } from "../scripts/env.js";
import { main } from "../scripts/setup.js";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  readFileSync: vi.fn((path: string) => path),
}));

vi.mock("../scripts/env.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../scripts/env.js")>()),
  loadEnvironment: (name: string) => ({ name }),
}));

vi.mock("@relay-protocol/lit-helpers/setup", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@relay-protocol/lit-helpers/setup")>()),
  createApiKeyBackend: vi.fn(),
  createChainSecuredBackend: vi.fn(),
  printCalldataBatch: vi.fn(),
}));

const PKP = `0x${"12".repeat(20)}`;
const GROUP_ID = 1n;
const legacy: ActionInfo = { name: "deposit-address-dev-action-ethereum-vm", actionHash: 1n };
const unrelated: ActionInfo[] = [
  { name: "deposit-address-dev-action-custom", actionHash: 2n },
  { name: "deposit-address-prod-action-ethereum-vm", actionHash: 3n },
  { name: "unrelated-action", actionHash: 4n },
];
const hashCid = (cid: string) =>
  BigInt(`0x${Buffer.from(keccak_256(new TextEncoder().encode(cid))).toString("hex")}`);
const targetHashes = VM_TYPES.map((vm) => hashCid(`cid-${vm}`));

describe("deposit-address setup version retention", () => {
  let backend: SetupBackend;
  let registered: Set<bigint>;
  let attached: Set<bigint>;
  let operations: string[];
  let registeredNames: string[];

  beforeEach(() => {
    vi.mocked(execFileSync).mockReset();
    vi.mocked(readFileSync).mockReset().mockImplementation((path) => String(path));
    const actions = [legacy, ...unrelated];
    registered = new Set(actions.map((a) => a.actionHash));
    attached = new Set(registered);
    operations = [];
    registeredNames = [];
    backend = {
      mode: "api-key",
      listPkps: vi.fn(async () => [{ walletAddress: PKP }]),
      listGroups: vi.fn(async () => [{ id: GROUP_ID, name: "deposit-address-dev" }]),
      listActions: vi.fn(async () => actions),
      listUsageApiKeys: vi.fn(async () => [{ name: "deposit-address-dev-usage-key" }]),
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
        registeredNames.push(name);
        registered.add(hashCid(cid));
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
        const vm = VM_TYPES.find((vm) => code.endsWith(`/${vm}.js`));
        if (!vm) {
          throw new Error(`Unexpected bundle: ${code}`);
        }
        return new Response(JSON.stringify(`cid-${vm}`));
      }),
    );
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

  it.each(["stag", "prod"])("keeps XRP out of the %s setup preview", async (environment) => {
    await main([
      "--env",
      environment,
      "--mode",
      "api-key",
      "--account-api-key",
      "test-key",
      "--pkp-id",
      PKP,
      "--dry-run",
    ]);
    const output = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(output).not.toContain("xrp-vm");
    expect(output).toContain("ethereum-vm target CID");
    expect(operations).toEqual([]);
  });

  it("registers new actions under version-suffixed names", async () => {
    await run();
    expect(registeredNames).toEqual(
      VM_TYPES.map((vm) => `deposit-address-dev-action-${vm}-${ACTION_VERSION}`),
    );
  });

  it("rebuilds before reading any dev action for its target hash", async () => {
    let rebuilt = false;
    vi.mocked(execFileSync).mockImplementation(() => {
      rebuilt = true;
      operations.push("bundle");
      return Buffer.alloc(0);
    });
    vi.mocked(readFileSync).mockImplementation((path) => {
      expect(rebuilt).toBe(true);
      expect(String(path)).toContain("/dist/actions/dev/");
      return String(path);
    });
    await run();
    expect(execFileSync).toHaveBeenCalledExactlyOnceWith(
      process.execPath,
      [expect.any(String), expect.stringContaining("bundle-actions.ts"), "--env", "dev"],
      expect.objectContaining({ stdio: "pipe" }),
    );
    expect(operations.indexOf("bundle")).toBeLessThan(operations.indexOf("register"));
    const cidRequests = vi.mocked(fetch).mock.calls.map(([, init]) => JSON.parse(init!.body as string) as string);
    expect(cidRequests).toHaveLength(VM_TYPES.length);
    expect(cidRequests.every((code) => code.includes("/dist/actions/dev/"))).toBe(true);
  });

  it("stops before registering actions when the XRP rebuild fails", async () => {
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error("XRP bundle build failed"); });
    await expect(run()).rejects.toThrow("XRP bundle build failed");
    expect(backend.addAction).not.toHaveBeenCalled();
    expect(backend.updateGroup).not.toHaveBeenCalled();
  });

  it("retains old XRP permissions", async () => {
    const oldXrp = [
      { name: "deposit-address-dev-action-xrp-vm", actionHash: 5n },
      { name: "deposit-address-dev-action-xrp-vm-v1.1", actionHash: 6n },
      { name: "deposit-address-dev-action-xrp-vm-custom", actionHash: 7n },
      { name: `deposit-address-dev-action-xrp-vm-${ACTION_VERSION}`, actionHash: 8n },
    ];
    const actions = [legacy, ...unrelated, ...oldXrp];
    registered = new Set(actions.map((a) => a.actionHash));
    attached = new Set(registered);
    vi.mocked(backend.listActions).mockResolvedValue(actions);
    vi.mocked(backend.listActionsInGroup).mockResolvedValue(actions);

    await run();

    expect(attached).toEqual(
      new Set([
        ...targetHashes,
        legacy.actionHash,
        ...unrelated.map((a) => a.actionHash),
        ...oldXrp.map((a) => a.actionHash),
      ]),
    );
    expect(registered).toEqual(new Set([...actions.map((a) => a.actionHash), ...targetHashes]));
    expect(backend.removeAction).not.toHaveBeenCalled();
    expect(backend.removeActionFromGroup).not.toHaveBeenCalled();
    expect(backend.updateGroup).not.toHaveBeenCalled();
  });

  it("propagates API errors when reading group permissions", async () => {
    const actual = await vi.importActual<typeof import("@relay-protocol/lit-helpers/setup")>(
      "@relay-protocol/lit-helpers/setup",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unavailable", { status: 503 })),
    );

    await expect(
      actual.createApiKeyBackend("test-key").listActionsInGroup(GROUP_ID),
    ).rejects.toThrow("503");
  });

  it("reads every page of group permissions through the supported actions endpoint", async () => {
    const actual = await vi.importActual<typeof import("@relay-protocol/lit-helpers/setup")>(
      "@relay-protocol/lit-helpers/setup",
    );
    const actions = Array.from({ length: 51 }, (_, index) => ({
      id: `0x${BigInt(index + 1)
        .toString(16)
        .padStart(64, "0")}`,
      name: `action-${index}`,
    }));
    const fetchPage = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(init?.method).toBe("GET");
      expect(url.searchParams.get("group_id")).toBe(String(GROUP_ID));
      expect(url.searchParams.get("page_size")).toBe("50");
      if (url.pathname !== "/core/v1/list_actions") {
        return new Response("unsupported", { status: 404 });
      }
      const page = Number(url.searchParams.get("page_number"));
      return new Response(JSON.stringify(actions.slice(page * 50, (page + 1) * 50)));
    });
    vi.stubGlobal("fetch", fetchPage);

    await expect(
      actual.createApiKeyBackend("test-key").listActionsInGroup(GROUP_ID),
    ).resolves.toEqual(
      actions.map((action) => ({ actionHash: BigInt(action.id), name: action.name })),
    );
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it("refuses group id 0, which the actions endpoint treats as the whole account", async () => {
    const actual = await vi.importActual<typeof import("@relay-protocol/lit-helpers/setup")>(
      "@relay-protocol/lit-helpers/setup",
    );
    const fetchPage = vi.fn();
    vi.stubGlobal("fetch", fetchPage);

    await expect(actual.createApiKeyBackend("test-key").listActionsInGroup(0n)).rejects.toThrow(
      "Cannot list actions for group id 0",
    );
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it.each([404, 501])("identifies an unsupported group action endpoint (%s)", async (status) => {
    const actual = await vi.importActual<typeof import("@relay-protocol/lit-helpers/setup")>(
      "@relay-protocol/lit-helpers/setup",
    );
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unsupported", { status })));
    await expect(actual.createApiKeyBackend("test-key").listActionsInGroup(GROUP_ID)).resolves.toBeUndefined();
  });

  it("preserves a nameless group action identified by its account registration", async () => {
    vi.mocked(backend.listActionsInGroup).mockResolvedValue([
      legacy, ...unrelated.map((action) => action.actionHash === 4n ? { actionHash: 4n } : action),
    ]);

    await run();

    expect(attached.has(4n)).toBe(true);
  });

  it("accepts a nameless action matching a freshly built target", async () => {
    const currentXrp = { actionHash: hashCid("cid-xrp-vm") };
    attached.add(currentXrp.actionHash);
    vi.mocked(backend.listActionsInGroup).mockResolvedValue([legacy, ...unrelated, currentXrp]);

    await run();

    expect(attached.has(currentXrp.actionHash)).toBe(true);
  });

  it.each([false, true])("keeps non-XRP setup additive when group listing is unsupported (preview=%s)", async (dryRun) => {
    vi.mocked(backend.listGroups).mockResolvedValue([{ id: GROUP_ID, name: "deposit-address-stag" }]);
    vi.mocked(backend.listActionsInGroup).mockResolvedValue(undefined);
    await main([
      "--env", "stag", "--mode", "api-key", "--account-api-key", "test-key", "--pkp-id", PKP,
      ...(dryRun ? ["--dry-run"] : []),
    ]);
    const output = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(output).toContain("ethereum-vm target CID");
    expect(output).not.toContain("xrp-vm");
    expect(backend.updateGroup).not.toHaveBeenCalled();
    expect(attached.has(legacy.actionHash)).toBe(true);
    for (const action of unrelated) {
      expect(attached.has(action.actionHash)).toBe(true);
    }
    if (dryRun) {
      expect(operations).toEqual([]);
    } else {
      expect(backend.addActionToGroup).toHaveBeenCalled();
    }
  });

  it("rejects group permissions whose action hashes cannot be read", async () => {
    const actual = await vi.importActual<typeof import("@relay-protocol/lit-helpers/setup")>(
      "@relay-protocol/lit-helpers/setup",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify([
              { id: 1, name: "deposit-address-dev-action-xrp-vm-v1.1", hashed_cid: "0x05" },
              { id: 42, name: "unrelated-action" },
            ]),
          ),
      ),
    );

    await expect(
      actual.createApiKeyBackend("test-key").listActionsInGroup(GROUP_ID),
    ).rejects.toThrow("Cannot read group action hash");
  });

  it("accepts an empty API group permission list", async () => {
    const actual = await vi.importActual<typeof import("@relay-protocol/lit-helpers/setup")>(
      "@relay-protocol/lit-helpers/setup",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("[]")),
    );

    await expect(
      actual.createApiKeyBackend("test-key").listActionsInGroup(GROUP_ID),
    ).resolves.toEqual([]);
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
          ...(prune ? [] : [legacy.actionHash]),
        ]);
        expect(registered).toEqual(expected);
        expect(attached).toEqual(expected);
        if (prune) {
          expect(backend.removeAction).toHaveBeenCalledExactlyOnceWith(legacy.actionHash);
          expect(backend.removeActionFromGroup).toHaveBeenCalledExactlyOnceWith(
            GROUP_ID,
            legacy.actionHash,
          );
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
      ...unrelated,
      ...VM_TYPES.map((vm) => ({
        name: `deposit-address-dev-action-${vm}-${ACTION_VERSION}`,
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
    expect(operations).toEqual(["detach", "remove"]);
    expect(attached).toEqual(new Set([...targetHashes, ...unrelated.map((a) => a.actionHash)]));
    expect(registered).toEqual(attached);
  });

  it("prunes stale actions whose version label has a minor part", async () => {
    const stale: ActionInfo = {
      name: "deposit-address-dev-action-bitcoin-vm-v1.1",
      actionHash: 5n,
    };
    const actions = [stale, ...unrelated];
    registered = new Set(actions.map((a) => a.actionHash));
    attached = new Set(registered);
    vi.mocked(backend.listActions).mockResolvedValue(actions);
    vi.mocked(backend.listActionsInGroup).mockResolvedValue(actions);

    await run("--prune-old-versions");
    expect(registered.has(stale.actionHash)).toBe(false);
    expect(attached.has(stale.actionHash)).toBe(false);
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
