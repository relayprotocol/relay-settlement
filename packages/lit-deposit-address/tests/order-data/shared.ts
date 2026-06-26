import { beforeAll } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { Order } from "../../src/common/relay-sdk.js";
import type { DepositAddressTrigger } from "../../src/common/types.js";

const solverPk = `0x${"01".repeat(32)}` as const;
export const solver = privateKeyToAccount(solverPk);

/**
 * Order whose address-like fields (`solver`, `currency`, `recipient`,
 * `extraData`) are already in their canonical bytes-hex form, mirroring what
 * the SDK's `normalizeOrder` would produce for an `ethereum-vm` only order.
 */
export const order: Order = {
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

export async function buildTrigger(forOrder: Order = order): Promise<DepositAddressTrigger> {
  const { generateAddress, getOrderId } = await import("../../src/common/relay-sdk.js");
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
