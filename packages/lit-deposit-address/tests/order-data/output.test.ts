import { describe, expect, it } from "vitest";
import type { Order } from "../../src/common/relay-sdk.js";
import { buildTrigger, order, solver } from "./shared.js";

describe("verifyOrderData", () => {
  it("rejects an order whose output has zero payments", async () => {
    const { verifyOrderData } = await import("../../src/attestation/index.js");
    const trigger = await buildTrigger();
    const orderSignature = await solver.signMessage({
      message: { raw: trigger.orderId as `0x${string}` },
    });
    const noOutputPaymentOrder: Order = {
      ...order,
      output: { ...order.output, payments: [] },
    };

    expect(() => verifyOrderData(trigger, noOutputPaymentOrder, orderSignature)).toThrow(
      /order output to have exactly one payment/,
    );
  });

  it("rejects an order whose output has multiple payments", async () => {
    const { verifyOrderData } = await import("../../src/attestation/index.js");
    const trigger = await buildTrigger();
    const orderSignature = await solver.signMessage({
      message: { raw: trigger.orderId as `0x${string}` },
    });
    const multiOutputOrder: Order = {
      ...order,
      output: {
        ...order.output,
        payments: [order.output.payments[0], order.output.payments[0]],
      },
    };

    expect(() => verifyOrderData(trigger, multiOutputOrder, orderSignature)).toThrow(
      /order output to have exactly one payment/,
    );
  });

  it("rejects an order whose output contains calls", async () => {
    const { verifyOrderData } = await import("../../src/attestation/index.js");
    const trigger = await buildTrigger();
    const orderSignature = await solver.signMessage({
      message: { raw: trigger.orderId as `0x${string}` },
    });
    const withCallsOrder: Order = {
      ...order,
      output: { ...order.output, calls: ["0xabc0"] },
    };

    expect(() => verifyOrderData(trigger, withCallsOrder, orderSignature)).toThrow(
      /order output to have no calls/,
    );
  });

  it("rejects an order whose output chainId differs from derivationFields.outputChainId", async () => {
    const { verifyOrderData } = await import("../../src/attestation/index.js");
    const trigger = await buildTrigger();
    const orderSignature = await solver.signMessage({
      message: { raw: trigger.orderId as `0x${string}` },
    });
    const wrongOutputChainOrder: Order = {
      ...order,
      output: { ...order.output, chainId: "137" },
    };

    expect(() => verifyOrderData(trigger, wrongOutputChainOrder, orderSignature)).toThrow(
      /order output chainId mismatch/,
    );
  });

  it("rejects an order whose output currency differs from derivationFields.outputCurrency", async () => {
    const { verifyOrderData } = await import("../../src/attestation/index.js");
    const trigger = await buildTrigger();
    const orderSignature = await solver.signMessage({
      message: { raw: trigger.orderId as `0x${string}` },
    });
    const wrongCurrencyOutputOrder: Order = {
      ...order,
      output: {
        ...order.output,
        payments: [
          {
            ...order.output.payments[0],
            currency: "0x000000000000000000000000000000000000000a",
          },
        ],
      },
    };

    expect(() => verifyOrderData(trigger, wrongCurrencyOutputOrder, orderSignature)).toThrow(
      /order output currency mismatch/,
    );
  });

  it("rejects an order whose output recipient differs from derivationFields.outputRecipient", async () => {
    const { verifyOrderData } = await import("../../src/attestation/index.js");
    const trigger = await buildTrigger();
    const orderSignature = await solver.signMessage({
      message: { raw: trigger.orderId as `0x${string}` },
    });
    const wrongRecipientOrder: Order = {
      ...order,
      output: {
        ...order.output,
        payments: [
          {
            ...order.output.payments[0],
            recipient: "0x000000000000000000000000000000000000000a",
          },
        ],
      },
    };

    expect(() => verifyOrderData(trigger, wrongRecipientOrder, orderSignature)).toThrow(
      /order output recipient mismatch/,
    );
  });
});
