import { describe, expect, it } from "vitest";
import type { Order } from "../../src/common/relay-sdk.js";
import { buildTrigger, order, solver } from "./shared.js";

describe("verifyOrderData", () => {
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
