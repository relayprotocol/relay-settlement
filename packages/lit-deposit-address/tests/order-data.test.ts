import { beforeAll, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { Order } from "../src/common/relay-sdk.js";
import type { DepositAddressTrigger } from "../src/common/types.js";

const solverPk = `0x${"01".repeat(32)}` as const;
const solver = privateKeyToAccount(solverPk);

/**
 * Order whose address-like fields (`solver`, `currency`, `recipient`,
 * `extraData`) are already in their canonical bytes-hex form, mirroring what
 * the SDK's `normalizeOrder` would produce for an `ethereum-vm` only order.
 */
const order: Order = {
  version: "v1",
  solverChainId: "10",
  solver: solver.address.toLowerCase(),
  salt: "0x0000000000000000000000000000000000000000000000000000000000000001",
  inputs: [
    {
      payment: {
        chainId: "10",
        currency: "0x0000000000000000000000000000000000000000",
        amount: "1000000000000000",
        weight: "1",
      },
      refunds: [
        {
          chainId: "10",
          recipient: "0x000000000000000000000000000000000000cafe",
          currency: "0x0000000000000000000000000000000000000000",
          minimumAmount: "1000000000000000",
          deadline: 0xffff_ffff,
          extraData: "0x",
        },
      ],
    },
  ],
  output: {
    chainId: "1",
    payments: [
      {
        recipient: "0x000000000000000000000000000000000000dead",
        currency: "0x0000000000000000000000000000000000000000",
        minimumAmount: "990000000000000",
        expectedAmount: "1000000000000000",
      },
    ],
    calls: [],
    deadline: 0xffff_ffff,
    extraData: "0x",
  },
  fees: [],
};

async function buildTrigger(forOrder: Order = order): Promise<DepositAddressTrigger> {
  const { generateAddress, getOrderId } = await import("../src/common/relay-sdk.js");
  return {
    input: {
      vmType: "ethereum-vm",
      chainId: "10",
      currency: "0x0000000000000000000000000000000000000000",
      amount: "1000000000000000",
    },
    derivationFields: {
      inputVmType: "ethereum-vm",
      outputVmType: "ethereum-vm",
      outputChainId: "1",
      outputCurrency: "0x0000000000000000000000000000000000000000",
      outputRecipient: "0x000000000000000000000000000000000000dead",
      solver: generateAddress({
        chainId: order.solverChainId,
        address: order.solver,
      }),
      pricingOracle: "0x331f90567b293887f907a9566657d7da60eae62f",
      depositor: "0x000000000000000000000000000000000000beef",
      refundRecipient: "0x000000000000000000000000000000000000cafe",
      priceImpactBps: "200",
    },
    orderId: getOrderId(forOrder),
    nonce: "1",
    currencies: [
      // input: native on chain 10
      { chainId: "10", currency: "0x0000000000000000000000000000000000000000" },
      // output: native on chain 1
      { chainId: "1", currency: "0x0000000000000000000000000000000000000000" },
    ],
    prices: [
      // $4000 / whole unit of ETH (18 decimals), 8-decimal usd-price precision
      {
        usdPrice: "400000000000",
        usdPriceDecimals: 8,
        currencyDecimals: 18,
        expiration: "281474976710655",
      },
      {
        usdPrice: "400000000000",
        usdPriceDecimals: 8,
        currencyDecimals: 18,
        expiration: "281474976710655",
      },
    ],
    extraData: "0x",
  };
}

beforeAll(() => {
  Object.assign(globalThis, {
    __DEPOSIT_ADDRESS_MANAGER_ADDRESS__: "0x1bff267aa51674fa536da3873188a41a9c05cf44",
    __HUB_EVM_CHAIN_ID__: "421614",
    __ALLOWED_ORACLES__: JSON.stringify([]),
    __ORACLE_SIGNATURE_THRESHOLD__: "0",
  });
});

describe("verifyOrderData", () => {
  it("rejects an order with zero inputs", async () => {
    const { verifyOrderData } = await import("../src/attestation/index.js");
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
    const { verifyOrderData } = await import("../src/attestation/index.js");
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
    const { verifyOrderData } = await import("../src/attestation/index.js");
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
    const { verifyOrderData } = await import("../src/attestation/index.js");
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
    const { verifyOrderData } = await import("../src/attestation/index.js");
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
    const { verifyOrderData } = await import("../src/attestation/index.js");
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

  it("rejects an order whose input has zero refunds", async () => {
    const { verifyOrderData } = await import("../src/attestation/index.js");
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
    const { verifyOrderData } = await import("../src/attestation/index.js");
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
    const { verifyOrderData } = await import("../src/attestation/index.js");
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
    const { verifyOrderData } = await import("../src/attestation/index.js");
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
    const { verifyOrderData } = await import("../src/attestation/index.js");
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
    const { verifyOrderData } = await import("../src/attestation/index.js");
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
    const { verifyOrderData } = await import("../src/attestation/index.js");
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

  it("rejects an order whose output has zero payments", async () => {
    const { verifyOrderData } = await import("../src/attestation/index.js");
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
    const { verifyOrderData } = await import("../src/attestation/index.js");
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
    const { verifyOrderData } = await import("../src/attestation/index.js");
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
    const { verifyOrderData } = await import("../src/attestation/index.js");
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
    const { verifyOrderData } = await import("../src/attestation/index.js");
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
    const { verifyOrderData } = await import("../src/attestation/index.js");
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

  it("rejects a trigger whose priceImpactBps exceeds 10000", async () => {
    const { verifyOrderData } = await import("../src/attestation/index.js");
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
    const { verifyOrderData } = await import("../src/attestation/index.js");
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
    const { verifyOrderData } = await import("../src/attestation/index.js");
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
    const { verifyOrderData } = await import("../src/attestation/index.js");
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
    const { verifyOrderData } = await import("../src/attestation/index.js");
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
    const { verifyOrderData } = await import("../src/attestation/index.js");
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

  it("accepts a valid solver order whose virtual address matches derivationFields.solver", async () => {
    const { verifyOrderData } = await import("../src/attestation/index.js");
    const trigger = await buildTrigger();
    const orderSignature = await solver.signMessage({
      message: { raw: trigger.orderId as `0x${string}` },
    });

    expect(() => verifyOrderData(trigger, order, orderSignature)).not.toThrow();
  });

  it("rejects an order whose recomputed id doesn't match trigger.orderId", async () => {
    const { verifyOrderData } = await import("../src/attestation/index.js");
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
    const { verifyOrderData } = await import("../src/attestation/index.js");
    const trigger = await buildTrigger();
    const other = privateKeyToAccount(`0x${"02".repeat(32)}`);
    const wrongSig = await other.signMessage({
      message: { raw: trigger.orderId as `0x${string}` },
    });

    expect(() => verifyOrderData(trigger, order, wrongSig)).toThrow(/order signature mismatch/);
  });

  it("rejects an order whose virtual address differs from derivationFields.solver", async () => {
    const { generateAddress, getOrderId } = await import("../src/common/relay-sdk.js");
    const { verifyOrderData } = await import("../src/attestation/index.js");
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
