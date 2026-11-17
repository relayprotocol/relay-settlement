import { describe, expect, it } from "vitest";
import type { Order } from "../../src/common/relay-sdk.js";
import type { DepositAddressTrigger } from "../../src/common/types.js";
import { buildTrigger, order, solver } from "./shared.js";

describe("verifyOrderData", () => {
  it.each(["usdPriceDecimals", "currencyDecimals"] as const)(
    "rejects a dust payout after changing input %s to a string without changing the trigger hash",
    async (field) => {
      const { verifyOrderData } = await import("../../src/attestation/index.js");
      const { getDepositAddressTriggerHash } = await import("../../src/common/relay-sdk.js");
      const dustOrder: Order = {
        ...order,
        output: {
          ...order.output,
          payments: [{ ...order.output.payments[0], minimumAmount: "1" }],
        },
      };
      const trigger = await buildTrigger(dustOrder);
      const orderSignature = await solver.signMessage({
        message: { raw: trigger.orderId as `0x${string}` },
      });
      const triggerHash = getDepositAddressTriggerHash(trigger);

      expect(() => verifyOrderData(trigger, dustOrder, orderSignature)).toThrow(
        /price impact exceeded/,
      );

      // JSON types are not bound by the ABI hash: the same attestation can
      // authenticate both 18 and "18", but JavaScript addition differs.
      Object.assign(trigger.prices[0], { [field]: String(trigger.prices[0][field]) });
      expect(getDepositAddressTriggerHash(trigger)).toBe(triggerHash);
      expect(() => verifyOrderData(trigger, dustOrder, orderSignature)).toThrow(
        `input price ${field} must be an integer between 0 and 255`,
      );
    },
  );

  describe.each([
    [0, "input", "usdPriceDecimals"],
    [0, "input", "currencyDecimals"],
    [1, "output", "usdPriceDecimals"],
    [1, "output", "currencyDecimals"],
  ] as const)("price %i (%s) %s", (index, side, field) => {
    it.each(
      ["18", 18n, null, undefined, true, [], {}, -1, 256, 1.5, NaN, Infinity].map((value) => [
        value,
      ]),
    )("rejects an invalid decimal value: %s", async (value) => {
      const { verifyOrderData } = await import("../../src/attestation/index.js");
      const trigger = await buildTrigger();
      const orderSignature = await solver.signMessage({
        message: { raw: trigger.orderId as `0x${string}` },
      });
      Object.assign(trigger.prices[index], { [field]: value });

      expect(() => verifyOrderData(trigger, order, orderSignature)).toThrow(
        `${side} price ${field} must be an integer between 0 and 255`,
      );
    });
  });

  it.each([
    [0, 0],
    [8, 18],
    [255, 255],
  ])("accepts numeric price and currency decimals %i and %i", async (usd, currency) => {
    const { verifyOrderData } = await import("../../src/attestation/index.js");
    const trigger = await buildTrigger();
    for (const price of trigger.prices) {
      price.usdPriceDecimals = usd;
      price.currencyDecimals = currency;
    }
    const orderSignature = await solver.signMessage({
      message: { raw: trigger.orderId as `0x${string}` },
    });

    expect(() => verifyOrderData(trigger, order, orderSignature)).not.toThrow();
  });

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
