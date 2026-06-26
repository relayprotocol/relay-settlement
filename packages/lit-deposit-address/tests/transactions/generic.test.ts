import { describe, expect, it } from "vitest";
import { signTransactionsWithWallet } from "../../src/derivation/index.js";
import { PATH, ROOT_KEY } from "./shared.js";

describe("transaction signing", () => {
  it("rejects empty transaction lists", async () => {
    await expect(signTransactionsWithWallet(ROOT_KEY, "ethereum-vm", PATH, [])).rejects.toThrow(
      "at least one transaction",
    );
  });
});
