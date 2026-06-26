import { describe, expect, it } from "vitest";
import type { Order } from "../../src/common/relay-sdk.js";
import type { DepositAddressTrigger } from "../../src/common/types.js";
import { buildTrigger, order, solver } from "./shared.js";

describe("verifyOrderData", () => {
  it("rejects a trigger whose priceImpactBps exceeds 10000", async () => {
    const { verifyOrderData } = await import("../../src/attestation/index.js");
    const trigger = await buildTrigger();
    trigger.derivationFields.priceImpactBps = "10001";
    const orderSignature = await solver.signMessage({
      message: { raw: trigger.orderId as `0x${string}` },
    });

    expect(() => verifyOrderData(trigger, order, orderSignature)).toThrow(
      /priceImpactBps must be <= 10000/,
    );
  });

  it("rejects an order whose output.minimumAmount exceeds the trigger's priceImpactBps", async () => {
    const { verifyOrderData } = await import("../../src/attestation/index.js");
    const trigger = await buildTrigger();
    const orderSignature = await solver.signMessage({
      message: { raw: trigger.orderId as `0x${string}` },
    });
    // input.amount = 1e15 wei, default minimumAmount = 9.9e14 (1% price
    // impact, well under the 2% priceImpactBps). Halving the minimum to
    // 5e14 yields 50% price impact — way over the 200-bps budget.
    const highPriceImpactOrder: Order = {
      ...order,
      output: {
        ...order.output,
        payments: [{ ...order.output.payments[0], minimumAmount: "500000000000000" }],
      },
    };

    expect(() => verifyOrderData(trigger, highPriceImpactOrder, orderSignature)).toThrow(
      /price impact exceeded/,
    );
  });

  it("rejects an order when the input price is expired", async () => {
    const { verifyOrderData } = await import("../../src/attestation/index.js");
    const trigger = await buildTrigger();
    const orderSignature = await solver.signMessage({
      message: { raw: trigger.orderId as `0x${string}` },
    });
    const expiredTrigger: DepositAddressTrigger = {
      ...trigger,
      prices: [{ ...trigger.prices[0], expiration: "0" }, trigger.prices[1]],
    };

    expect(() => verifyOrderData(expiredTrigger, order, orderSignature)).toThrow(
      /input price expired/,
    );
  });

  it("rejects an order when the output price is expired", async () => {
    const { verifyOrderData } = await import("../../src/attestation/index.js");
    const trigger = await buildTrigger();
    const orderSignature = await solver.signMessage({
      message: { raw: trigger.orderId as `0x${string}` },
    });
    const expiredTrigger: DepositAddressTrigger = {
      ...trigger,
      prices: [trigger.prices[0], { ...trigger.prices[1], expiration: "0" }],
    };

    expect(() => verifyOrderData(expiredTrigger, order, orderSignature)).toThrow(
      /output price expired/,
    );
  });

  it("rejects when no price is provided for the input currency", async () => {
    const { verifyOrderData } = await import("../../src/attestation/index.js");
    const trigger = await buildTrigger();
    const orderSignature = await solver.signMessage({
      message: { raw: trigger.orderId as `0x${string}` },
    });
    // Drop the input currency entry; only the output currency remains.
    const missingInputTrigger: DepositAddressTrigger = {
      ...trigger,
      currencies: [trigger.currencies[1]],
      prices: [trigger.prices[1]],
    };

    expect(() => verifyOrderData(missingInputTrigger, order, orderSignature)).toThrow(
      /no price found for input currency/,
    );
  });

  it("rejects when no price is provided for the output currency", async () => {
    const { verifyOrderData } = await import("../../src/attestation/index.js");
    const trigger = await buildTrigger();
    const orderSignature = await solver.signMessage({
      message: { raw: trigger.orderId as `0x${string}` },
    });
    const missingOutputTrigger: DepositAddressTrigger = {
      ...trigger,
      currencies: [trigger.currencies[0]],
      prices: [trigger.prices[0]],
    };

    expect(() => verifyOrderData(missingOutputTrigger, order, orderSignature)).toThrow(
      /no price found for output currency/,
    );
  });
});
