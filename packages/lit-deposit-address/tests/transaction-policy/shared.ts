import type { Hex } from "viem";
import type {
  DepositAddressTrigger,
  DepositAddressTriggerAttestation,
  VmType,
} from "../../src/common/types.js";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
export const DEPOSITORY = "0x00000000000000000000000000000000000000ff";
export const DEPOSITOR = "0x000000000000000000000000000000000000beef";
export const ORDER_ID: Hex = `0x${"ab".repeat(32)}`;

export function makeTrigger(
  overrides: { inputCurrency?: string; inputVmType?: VmType } = {},
): DepositAddressTrigger {
  const inputVmType = overrides.inputVmType ?? "ethereum-vm";
  return {
    input: {
      vmType: inputVmType,
      chainId: "10",
      currency: overrides.inputCurrency ?? ZERO_ADDRESS,
      amount: "1000000000000000",
    },
    derivationFields: {
      inputVmType,
      outputVmType: "ethereum-vm",
      outputChainId: "base",
      outputCurrency: ZERO_ADDRESS,
      outputRecipient: "0x000000000000000000000000000000000000dead",
      solver: "0x000000000000000000000000000000000000cafe",
      pricingOracle: "0x000000000000000000000000000000000000beef",
      depositor: DEPOSITOR,
      refundRecipient: DEPOSITOR,
      priceImpactBps: "200",
    },
    orderId: ORDER_ID,
    nonce: "1",
    currencies: [],
    prices: [],
    extraData: "0x",
  };
}

export function makeAttestation(): DepositAddressTriggerAttestation {
  return {
    chainId: 421614,
    depositAddressManager: "0xd03250b221f709abe58ff4a177d50d01d922d974",
    inputDepository: DEPOSITORY,
    triggerHash: `0x${"00".repeat(32)}`,
    signatures: [],
  };
}
