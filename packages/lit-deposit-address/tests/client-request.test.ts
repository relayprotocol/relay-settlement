import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { buildLitActionJsParams, type DepositAddressesClient } from "../scripts/client/index.js";
import {
  addSolverRequestSignature,
  solverSignRequestHash,
} from "../scripts/examples/solver-request.js";

const CLIENT: DepositAddressesClient = {
  apiBaseUrl: "https://example.invalid",
  apiKey: "test-api-key",
  pkpId: "0x1234",
  envName: "dev",
  vmType: "tron-vm",
};

describe("Lit client request shaping", () => {
  it("includes the client PKP id before the solver signs the request", async () => {
    const solver = privateKeyToAccount(`0x${"11".repeat(32)}`);
    const shaped = buildLitActionJsParams(CLIENT, {
      pkpId: "caller-cannot-override-client-pkp",
      action: "sign",
      transactions: [{ purpose: "native-deposit", rawData: "0x01" }],
    });
    const signed = await addSolverRequestSignature(shaped, solver);
    const transmitted = buildLitActionJsParams(CLIENT, signed);

    expect(transmitted).toEqual(signed);
    expect(solverSignRequestHash(transmitted)).toBe(solverSignRequestHash(shaped));
    expect(transmitted.pkpId).toBe(CLIENT.pkpId);
  });
});
