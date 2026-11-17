import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTrigger, order, solver } from "./shared.js";

const now = 1_800_000_000;

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(now * 1000 + 999);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("verifyOrderData deadlines", () => {
  it.each([" 2000000000", "02000000000"])(
    "compares numeric string deadlines numerically (output=%s)",
    async (outputDeadline) => {
      const { verifyOrderData } = await import("../../src/attestation/index.js");
      const { getOrderId } = await import("../../src/common/relay-sdk.js");
      const earlyRefundOrder = structuredClone(order);
      earlyRefundOrder.output.deadline = 2_000_000_000;
      earlyRefundOrder.inputs[0].refunds[0].deadline = 1_900_000_000;
      const trigger = await buildTrigger(earlyRefundOrder);
      const orderSignature = await solver.signMessage({
        message: { raw: trigger.orderId as `0x${string}` },
      });

      // Untrusted JSON can carry strings despite the static number annotations.
      Object.assign(earlyRefundOrder.output, { deadline: outputDeadline });
      Object.assign(earlyRefundOrder.inputs[0].refunds[0], { deadline: "1900000000" });
      expect(getOrderId(earlyRefundOrder)).toBe(trigger.orderId);
      expect(() => verifyOrderData(trigger, earlyRefundOrder, orderSignature)).toThrow(
        /order refund\[0\] deadline precedes output deadline/,
      );
    },
  );

  it.each(["output", "first refund", "later refund"] as const)(
    "rejects %s deadlines with at most one hour remaining in solver-signed orders",
    async (target) => {
      const { verifyOrderData } = await import("../../src/attestation/index.js");
      for (const deadline of [0, now - 1, now, now + 1, now + 3599, now + 3600]) {
        const expiredOrder = structuredClone(order);
        let error: RegExp;
        if (target === "output") {
          expiredOrder.output.deadline = deadline;
          error = /order output deadline must be more than 3600 seconds in the future/;
        } else {
          const refunds = expiredOrder.inputs[0].refunds;
          if (target === "later refund") {
            refunds.push({ ...refunds[0] });
          }
          refunds[refunds.length - 1].deadline = deadline;
          error = new RegExp(
            `order refund\\[${refunds.length - 1}\\] deadline must be more than 3600 seconds in the future`,
          );
        }
        const trigger = await buildTrigger(expiredOrder);
        const orderSignature = await solver.signMessage({
          message: { raw: trigger.orderId as `0x${string}` },
        });

        expect(() => verifyOrderData(trigger, expiredOrder, orderSignature)).toThrow(error);
      }
    },
  );

  it.each([0, 60])(
    "accepts deadlines beyond the buffer with refunds %i seconds after output",
    async (offset) => {
      const { verifyOrderData } = await import("../../src/attestation/index.js");
      const futureOrder = structuredClone(order);
      futureOrder.output.deadline = now + 3601;
      futureOrder.inputs[0].refunds[0].deadline = now + 3601 + offset;
      const trigger = await buildTrigger(futureOrder);
      const orderSignature = await solver.signMessage({
        message: { raw: trigger.orderId as `0x${string}` },
      });

      expect(() => verifyOrderData(trigger, futureOrder, orderSignature)).not.toThrow();
    },
  );

  it.each([0, 1])(
    "rejects refund[%i] ending before output even beyond the buffer",
    async (index) => {
      const { verifyOrderData } = await import("../../src/attestation/index.js");
      const earlyRefundOrder = structuredClone(order);
      earlyRefundOrder.output.deadline = now + 7200;
      const refunds = earlyRefundOrder.inputs[0].refunds;
      if (index === 1) {
        refunds.push({ ...refunds[0] });
      }
      refunds[index].deadline = now + 7199;
      const trigger = await buildTrigger(earlyRefundOrder);
      const orderSignature = await solver.signMessage({
        message: { raw: trigger.orderId as `0x${string}` },
      });

      expect(() => verifyOrderData(trigger, earlyRefundOrder, orderSignature)).toThrow(
        new RegExp(`order refund\\[${index}\\] deadline precedes output deadline`),
      );
    },
  );
});
