import { describe, expect, it } from "vitest";
import type { Order } from "../../src/common/relay-sdk.js";
import { buildTrigger, order, solver } from "./shared.js";

describe("verifyOrderData", () => {
  it("rejects a solver-signed dust refund rebound to the same deposit wallet", async () => {
    const { verifyOrderData } = await import("../../src/attestation/index.js");
    const { derivationFieldsToIndexes } = await import("../../src/derivation/path.js");
    const originalTrigger = await buildTrigger();
    const reboundOrder = structuredClone(order);
    reboundOrder.inputs[0].refunds[0].minimumAmount = "1";
    const trigger = await buildTrigger(reboundOrder);
    const orderSignature = await solver.signMessage({
      message: { raw: trigger.orderId as `0x${string}` },
    });

    expect(trigger.orderId).not.toBe(originalTrigger.orderId);
    expect(derivationFieldsToIndexes(trigger.derivationFields)).toEqual(
      derivationFieldsToIndexes(originalTrigger.derivationFields),
    );
    expect(() => verifyOrderData(trigger, reboundOrder, orderSignature)).toThrow(
      /order refund\[0\] price impact exceeded/,
    );
  });

  it.each([
    { input: "1000000000000000", minimum: "0", bps: "200", accepted: false },
    { input: "1000000000000000", minimum: "979999999999999", bps: "200", accepted: false },
    { input: "1000000000000000", minimum: "980000000000000", bps: "200", accepted: true },
    { input: "1000000000000000", minimum: "990000000000000", bps: "200", accepted: true },
    { input: "101", minimum: "98", bps: "200", accepted: false },
    { input: "101", minimum: "99", bps: "200", accepted: true },
    { input: "101", minimum: "100", bps: "0", accepted: false },
    { input: "101", minimum: "101", bps: "0", accepted: true },
    { input: "101", minimum: "0", bps: "10000", accepted: true },
  ])(
    "enforces refund minimum $minimum for input $input at $bps bps (accepted=$accepted)",
    async ({ input, minimum, bps, accepted }) => {
      const { verifyOrderData } = await import("../../src/attestation/index.js");
      const refundOrder = structuredClone(order);
      refundOrder.inputs[0].payment.amount = input;
      refundOrder.inputs[0].refunds[0].minimumAmount = minimum;
      refundOrder.output.payments[0].minimumAmount = input;
      const trigger = await buildTrigger(refundOrder);
      trigger.input.amount = input;
      trigger.derivationFields.priceImpactBps = bps;
      const orderSignature = await solver.signMessage({
        message: { raw: trigger.orderId as `0x${string}` },
      });

      const verify = () => verifyOrderData(trigger, refundOrder, orderSignature);
      if (accepted) {
        expect(verify).not.toThrow();
      } else {
        expect(verify).toThrow(/order refund\[0\] price impact exceeded/);
      }
    },
  );

  it("rejects an insufficient later refund even when the first refund covers the full input", async () => {
    const { verifyOrderData } = await import("../../src/attestation/index.js");
    const refundOrder = structuredClone(order);
    refundOrder.inputs[0].refunds.push({
      ...refundOrder.inputs[0].refunds[0],
      minimumAmount: "1",
    });
    const trigger = await buildTrigger(refundOrder);
    const orderSignature = await solver.signMessage({
      message: { raw: trigger.orderId as `0x${string}` },
    });

    expect(() => verifyOrderData(trigger, refundOrder, orderSignature)).toThrow(
      /order refund\[1\] price impact exceeded/,
    );
  });

  it("rejects an order whose input has zero refunds", async () => {
    const { verifyOrderData } = await import("../../src/attestation/index.js");
    const trigger = await buildTrigger();
    const orderSignature = await solver.signMessage({
      message: { raw: trigger.orderId as `0x${string}` },
    });
    const noRefundOrder: Order = {
      ...order,
      inputs: [{ ...order.inputs[0], refunds: [] }],
    };

    expect(() => verifyOrderData(trigger, noRefundOrder, orderSignature)).toThrow(
      /order input to have at least one refund/,
    );
  });

  it("accepts an order whose input has multiple refunds when every entry matches the trigger", async () => {
    const { verifyOrderData } = await import("../../src/attestation/index.js");
    const matchingRefund = { ...order.inputs[0].refunds[0] };
    const multiRefundOrder: Order = {
      ...order,
      inputs: [{ ...order.inputs[0], refunds: [order.inputs[0].refunds[0], matchingRefund] }],
    };
    const trigger = await buildTrigger(multiRefundOrder);
    const orderSignature = await solver.signMessage({
      message: { raw: trigger.orderId as `0x${string}` },
    });

    expect(() => verifyOrderData(trigger, multiRefundOrder, orderSignature)).not.toThrow();
  });

  it("rejects an order whose later refunds disagree with the trigger", async () => {
    const { verifyOrderData } = await import("../../src/attestation/index.js");
    const goodRefund = order.inputs[0].refunds[0];
    const badRefund = { ...goodRefund, recipient: "0x000000000000000000000000000000000000dead" };
    const multiRefundOrder: Order = {
      ...order,
      inputs: [{ ...order.inputs[0], refunds: [goodRefund, badRefund] }],
    };
    const trigger = await buildTrigger(multiRefundOrder);
    const orderSignature = await solver.signMessage({
      message: { raw: trigger.orderId as `0x${string}` },
    });

    expect(() => verifyOrderData(trigger, multiRefundOrder, orderSignature)).toThrow(
      /order refund\[1\] recipient mismatch/,
    );
  });

  it("rejects an order whose first refund mismatches even if a later refund matches", async () => {
    const { verifyOrderData } = await import("../../src/attestation/index.js");
    const goodRefund = order.inputs[0].refunds[0];
    const badRefund = { ...goodRefund, recipient: "0x000000000000000000000000000000000000dead" };
    const badFirstRefundOrder: Order = {
      ...order,
      inputs: [{ ...order.inputs[0], refunds: [badRefund, goodRefund] }],
    };
    const trigger = await buildTrigger(badFirstRefundOrder);
    const orderSignature = await solver.signMessage({
      message: { raw: trigger.orderId as `0x${string}` },
    });

    expect(() => verifyOrderData(trigger, badFirstRefundOrder, orderSignature)).toThrow(
      /order refund\[0\] recipient mismatch/,
    );
  });

  it("rejects an order whose refund chainId differs from trigger.input.chainId", async () => {
    const { verifyOrderData } = await import("../../src/attestation/index.js");
    const trigger = await buildTrigger();
    const orderSignature = await solver.signMessage({
      message: { raw: trigger.orderId as `0x${string}` },
    });
    const wrongRefundChainOrder: Order = {
      ...order,
      inputs: [
        {
          ...order.inputs[0],
          refunds: [{ ...order.inputs[0].refunds[0], chainId: "137" }],
        },
      ],
    };

    expect(() => verifyOrderData(trigger, wrongRefundChainOrder, orderSignature)).toThrow(
      /order refund\[0\] chainId mismatch/,
    );
  });

  it("rejects an order whose refund currency differs from trigger.input.currency", async () => {
    const { verifyOrderData } = await import("../../src/attestation/index.js");
    const trigger = await buildTrigger();
    const orderSignature = await solver.signMessage({
      message: { raw: trigger.orderId as `0x${string}` },
    });
    const wrongRefundCurrencyOrder: Order = {
      ...order,
      inputs: [
        {
          ...order.inputs[0],
          refunds: [
            {
              ...order.inputs[0].refunds[0],
              currency: "0x000000000000000000000000000000000000000a",
            },
          ],
        },
      ],
    };

    expect(() => verifyOrderData(trigger, wrongRefundCurrencyOrder, orderSignature)).toThrow(
      /order refund\[0\] currency mismatch/,
    );
  });

  it("rejects an order whose refund recipient differs from derivationFields.refundRecipient", async () => {
    const { verifyOrderData } = await import("../../src/attestation/index.js");
    const trigger = await buildTrigger();
    const orderSignature = await solver.signMessage({
      message: { raw: trigger.orderId as `0x${string}` },
    });
    const wrongRefundRecipientOrder: Order = {
      ...order,
      inputs: [
        {
          ...order.inputs[0],
          refunds: [
            {
              ...order.inputs[0].refunds[0],
              recipient: "0x000000000000000000000000000000000000000b",
            },
          ],
        },
      ],
    };

    expect(() => verifyOrderData(trigger, wrongRefundRecipientOrder, orderSignature)).toThrow(
      /order refund\[0\] recipient mismatch/,
    );
  });
});
