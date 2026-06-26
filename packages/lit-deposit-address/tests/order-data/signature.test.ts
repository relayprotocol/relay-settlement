import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { Order } from "../../src/common/relay-sdk.js";
import type { DepositAddressTrigger } from "../../src/common/types.js";
import { buildTrigger, order, solver } from "./shared.js";

describe("verifyOrderData", () => {
  it("accepts a valid solver order whose virtual address matches derivationFields.solver", async () => {
    const { verifyOrderData } = await import("../../src/attestation/index.js");
    const trigger = await buildTrigger();
    const orderSignature = await solver.signMessage({
      message: { raw: trigger.orderId as `0x${string}` },
    });

    expect(() => verifyOrderData(trigger, order, orderSignature)).not.toThrow();
  });

  it("rejects an order whose recomputed id doesn't match trigger.orderId", async () => {
    const { verifyOrderData } = await import("../../src/attestation/index.js");
    const trigger = await buildTrigger();
    const orderSignature = await solver.signMessage({
      message: { raw: trigger.orderId as `0x${string}` },
    });
    const wrongOrder: Order = {
      ...order,
      salt: "0x0000000000000000000000000000000000000000000000000000000000000099",
    };

    expect(() => verifyOrderData(trigger, wrongOrder, orderSignature)).toThrow(/order id mismatch/);
  });

  it("rejects a signature by a different key", async () => {
    const { verifyOrderData } = await import("../../src/attestation/index.js");
    const trigger = await buildTrigger();
    const other = privateKeyToAccount(`0x${"02".repeat(32)}`);
    const wrongSig = await other.signMessage({
      message: { raw: trigger.orderId as `0x${string}` },
    });

    expect(() => verifyOrderData(trigger, order, wrongSig)).toThrow(/order signature mismatch/);
  });

  it("rejects an order whose virtual address differs from derivationFields.solver", async () => {
    const { generateAddress, getOrderId } = await import("../../src/common/relay-sdk.js");
    const { verifyOrderData } = await import("../../src/attestation/index.js");
    const otherSolver = privateKeyToAccount(`0x${"03".repeat(32)}`);
    const otherOrder: Order = { ...order, solver: otherSolver.address.toLowerCase() };
    const otherOrderId = getOrderId(otherOrder);
    const otherSig = await otherSolver.signMessage({
      message: { raw: otherOrderId as `0x${string}` },
    });

    // derivationFields.solver still points to the *original* solver's virtual
    // address, so the binding check must fail even though the order signature
    // and id pair up internally.
    const trigger = await buildTrigger();
    const otherTrigger: DepositAddressTrigger = {
      ...trigger,
      orderId: otherOrderId,
      derivationFields: {
        ...trigger.derivationFields,
        solver: generateAddress({
          chainId: order.solverChainId,
          address: order.solver,
        }),
      },
    };

    expect(() => verifyOrderData(otherTrigger, otherOrder, otherSig)).toThrow(
      /derivation fields solver mismatch/,
    );
  });
});
