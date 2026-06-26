import { describe, expect, it } from "vitest";
import type { Order } from "../../src/common/relay-sdk.js";
import { buildTrigger, order, solver } from "./shared.js";

describe("verifyOrderData", () => {
  it("rejects an order with zero inputs", async () => {
    const { verifyOrderData } = await import("../../src/attestation/index.js");
    const trigger = await buildTrigger();
    const orderSignature = await solver.signMessage({
      message: { raw: trigger.orderId as `0x${string}` },
    });
    const noInputOrder: Order = { ...order, inputs: [] };

    expect(() => verifyOrderData(trigger, noInputOrder, orderSignature)).toThrow(
      /expected order to have exactly one input/,
    );
  });

  it("rejects an order with multiple inputs", async () => {
    const { verifyOrderData } = await import("../../src/attestation/index.js");
    const trigger = await buildTrigger();
    const orderSignature = await solver.signMessage({
      message: { raw: trigger.orderId as `0x${string}` },
    });
    const multiInputOrder: Order = {
      ...order,
      inputs: [order.inputs[0], order.inputs[0]],
    };

    expect(() => verifyOrderData(trigger, multiInputOrder, orderSignature)).toThrow(
      /expected order to have exactly one input/,
    );
  });

  it("rejects an order whose input chainId differs from trigger.input.chainId", async () => {
    const { verifyOrderData } = await import("../../src/attestation/index.js");
    const trigger = await buildTrigger();
    const orderSignature = await solver.signMessage({
      message: { raw: trigger.orderId as `0x${string}` },
    });
    const wrongChainOrder: Order = {
      ...order,
      inputs: [
        {
          ...order.inputs[0],
          payment: { ...order.inputs[0].payment, chainId: "137" },
        },
      ],
    };

    expect(() => verifyOrderData(trigger, wrongChainOrder, orderSignature)).toThrow(
      /order input chainId mismatch/,
    );
  });

  it("rejects an order whose input currency differs from trigger.input.currency", async () => {
    const { verifyOrderData } = await import("../../src/attestation/index.js");
    const trigger = await buildTrigger();
    const orderSignature = await solver.signMessage({
      message: { raw: trigger.orderId as `0x${string}` },
    });
    const wrongCurrencyOrder: Order = {
      ...order,
      inputs: [
        {
          ...order.inputs[0],
          payment: {
            ...order.inputs[0].payment,
            currency: "0x000000000000000000000000000000000000000a",
          },
        },
      ],
    };

    expect(() => verifyOrderData(trigger, wrongCurrencyOrder, orderSignature)).toThrow(
      /order input currency mismatch/,
    );
  });

  it("rejects an order whose input amount differs from trigger.input.amount", async () => {
    const { verifyOrderData } = await import("../../src/attestation/index.js");
    const trigger = await buildTrigger();
    const orderSignature = await solver.signMessage({
      message: { raw: trigger.orderId as `0x${string}` },
    });
    const wrongAmountOrder: Order = {
      ...order,
      inputs: [
        {
          ...order.inputs[0],
          payment: { ...order.inputs[0].payment, amount: "999999999999999" },
        },
      ],
    };

    expect(() => verifyOrderData(trigger, wrongAmountOrder, orderSignature)).toThrow(
      /order input amount mismatch/,
    );
  });

  it('rejects an order whose input weight isn\'t "1"', async () => {
    const { verifyOrderData } = await import("../../src/attestation/index.js");
    const trigger = await buildTrigger();
    const orderSignature = await solver.signMessage({
      message: { raw: trigger.orderId as `0x${string}` },
    });
    const wrongWeightOrder: Order = {
      ...order,
      inputs: [
        {
          ...order.inputs[0],
          payment: { ...order.inputs[0].payment, weight: "10000" },
        },
      ],
    };

    expect(() => verifyOrderData(trigger, wrongWeightOrder, orderSignature)).toThrow(
      /order input weight must be "1"/,
    );
  });
});
