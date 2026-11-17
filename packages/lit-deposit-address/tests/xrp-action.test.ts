import { decode, encode, encodeForSigning } from "ripple-binary-codec";
import { verify } from "ripple-keypairs";
import { encodeAbiParameters, zeroAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeAddressFromHex, encodeAddressToHex } from "../src/common/address.js";
import { getDepositAddressTriggerHash } from "../src/common/relay-sdk.js";
import { deriveWallet } from "../src/derivation/index.js";
import { derivationFieldsToIndexes } from "../src/derivation/path.js";
import { XrpVmWalletDeriver } from "../src/derivation/vm/xrp/XrpVmWalletDeriver.js";
import type { ActionParams, SignResult } from "../src/vm/action.js";
import { buildTrigger, order as baseOrder, solver } from "./order-data/shared.js";

const NOW = 1_800_000_000n;
/** Encode the ledger reference that the Oracle must validate before attesting. */
const ledgerReference = (index = 90, observedAt = NOW) =>
  encodeAbiParameters([{ type: "uint32" }, { type: "uint64" }], [index, observedAt]);
const rootKey = `0x${"11".repeat(32)}`;
const oracle = privateKeyToAccount(`0x${"03".repeat(32)}`);
const outsider = privateKeyToAccount(`0x${"04".repeat(32)}`);
const manager = "0x1bff267aa51674fa536da3873188a41a9c05cf44";
const depository = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
let runVmAction: typeof import("../src/vm/action.js").runVmAction;
let solverSignRequestHash: typeof import("../src/vm/action.js").solverSignRequestHash;
let approved: ActionParams<"xrp-vm">;

/** Bind the complete request body to the Solver's EOA key. */
async function signRequest(params: ActionParams<"xrp-vm">): Promise<void> {
  params.requestSignature = await solver.signMessage({
    message: { raw: solverSignRequestHash(params as unknown as Record<string, unknown>) },
  });
}

/** Execute the XRP action with the same shared authorization flow as the generated bundle. */
function run(params: ActionParams<"xrp-vm">) {
  return runVmAction("xrp-vm", new XrpVmWalletDeriver(), params);
}

afterAll(() => vi.restoreAllMocks());
beforeEach(() => vi.mocked(Date.now).mockReturnValue(Number(NOW) * 1000));

beforeAll(async () => {
  vi.spyOn(Date, "now").mockReturnValue(Number(NOW) * 1000);
  Object.assign(globalThis, {
    Lit: { Actions: { getPrivateKey: async () => rootKey } },
    __DEPOSIT_ADDRESS_MANAGER_ADDRESS__: manager,
    __HUB_EVM_CHAIN_ID__: "421614",
    __ALLOWED_ORACLES__: JSON.stringify([oracle.address]),
    __ORACLE_SIGNATURE_THRESHOLD__: "1",
  });
  ({ runVmAction, solverSignRequestHash } = await import("../src/vm/action.js"));
  approved = await buildRequest();
});

/** Create a fully signed request for the selected source chain. */
async function buildRequest(
  chainId = "xrp",
  extraData = ledgerReference(),
  deadline?: number,
): Promise<ActionParams<"xrp-vm">> {
  const order = structuredClone(baseOrder);
  order.inputs[0].payment.chainId = chainId;
  order.inputs[0].payment.amount = "1000000";
  order.inputs[0].refunds[0].chainId = chainId;
  order.inputs[0].refunds[0].minimumAmount = "1000000";
  order.output.payments[0].minimumAmount = "990000000000000000";
  order.output.payments[0].expectedAmount = "1000000000000000000";
  if (deadline !== undefined) {
    order.output.deadline = deadline;
  }
  const trigger = await buildTrigger(order);
  trigger.input = { ...trigger.input, vmType: "xrp-vm", chainId: chainId, amount: "1000000" };
  trigger.derivationFields.inputVmType = "xrp-vm";
  trigger.currencies[0].chainId = chainId;
  trigger.prices[0].currencyDecimals = 6;
  trigger.extraData = extraData;
  const wallet = await deriveWallet(
    rootKey,
    "xrp-vm",
    derivationFieldsToIndexes(trigger.derivationFields),
  );
  const attestation = {
    chainId: 421614,
    depositAddressManager: manager,
    inputDepository: encodeAddressToHex(depository, "xrp-vm"),
    triggerHash: getDepositAddressTriggerHash(trigger),
    signatures: [] as { oracleSigner: string; signature: string }[],
  };
  const signature = await oracle.signTypedData({
    domain: { chainId: 421614, name: "Trigger", verifyingContract: zeroAddress, version: "1" },
    primaryType: "Trigger",
    types: {
      Trigger: [
        { name: "chainId", type: "uint256" },
        { name: "depositAddressManager", type: "address" },
        { name: "inputDepository", type: "bytes" },
        { name: "triggerHash", type: "bytes32" },
      ],
    },
    message: {
      ...attestation,
      chainId: 421614n,
      depositAddressManager: manager as Hex,
      inputDepository: attestation.inputDepository as Hex,
      triggerHash: attestation.triggerHash as Hex,
    },
  });
  attestation.signatures.push({ oracleSigner: oracle.address, signature });
  const params: ActionParams<"xrp-vm"> = {
    pkpId: "0x1234",
    action: "sign",
    trigger,
    attestation,
    order,
    orderSignature: await solver.signMessage({ message: { raw: trigger.orderId as Hex } }),
    transactions: [
      {
        unsignedTransaction: encode({
          TransactionType: "Payment",
          Account: wallet.address,
          Destination: depository,
          Amount: trigger.input.amount,
          Fee: "12",
          Sequence: 1,
          LastLedgerSequence: 94,
          Flags: 0x80000000,
          Memos: [
            {
              Memo: {
                MemoData: Buffer.from(
                  `${trigger.orderId}|depositor=${decodeAddressFromHex(trigger.derivationFields.depositor, "xrp-vm")}|`,
                ).toString("hex"),
              },
            },
          ],
        }),
      },
    ],
  };
  await signRequest(params);
  return params;
}

describe("XRP Lit action authorization", () => {
  it("signs after verifying a real Oracle attestation, order signature, and Solver request", async () => {
    const result = (await run(approved)) as SignResult<"xrp-vm">;
    const signed = decode(result.signedTransactions[0].rawTransaction);
    expect(result.triggerHash).toBe(approved.attestation!.triggerHash);
    expect(signed.Account).toBe(result.wallet.address);
    expect(
      verify(
        encodeForSigning(signed),
        signed.TxnSignature as string,
        signed.SigningPubKey as string,
      ),
    ).toBe(true);
  });

  it("rejects a different source chain even with valid Oracle, order, and Solver signatures", async () => {
    await expect(run(await buildRequest("10"))).rejects.toThrow("XRP input chain must be xrp");
  });

  it("rejects a Payment without the original depositor even with fresh Solver approval", async () => {
    const params = structuredClone(approved);
    const payment = decode(params.transactions![0].unsignedTransaction);
    params.transactions![0].unsignedTransaction = encode({
      ...payment,
      Memos: [{ Memo: { MemoData: Buffer.from(params.trigger!.orderId).toString("hex") } }],
    });
    await signRequest(params);
    await expect(run(params)).rejects.toThrow("XRP Payment memo must bind orderId and depositor");
  });

  it("rejects an excessive ledger expiry even with fresh Solver approval", async () => {
    const params = structuredClone(approved);
    const payment = decode(params.transactions![0].unsignedTransaction);
    params.transactions![0].unsignedTransaction = encode({
      ...payment,
      LastLedgerSequence: 0xffffffff,
    });
    await signRequest(params);
    await expect(run(params)).rejects.toThrow("XRP ledger expiry");
  });

  it.each(["not-an-account", depository])(
    "rejects depositor substitution %s with fresh Solver approval",
    async (depositor) => {
      const params = structuredClone(approved);
      const payment = decode(params.transactions![0].unsignedTransaction);
      params.transactions![0].unsignedTransaction = encode({
        ...payment,
        Memos: [
          {
            Memo: {
              MemoData: Buffer.from(`${params.trigger!.orderId}|depositor=${depositor}|`).toString(
                "hex",
              ),
            },
          },
        ],
      });
      await signRequest(params);
      await expect(run(params)).rejects.toThrow("XRP Payment memo must bind orderId and depositor");
    },
  );

  it.each([NOW - 1n, NOW + 15n, NOW + 16n])(
    "signs the same Oracle-attested Payment at node time %s",
    async (nodeTime) => {
      const expected = await run(approved);
      await vi.mocked(Date.now).withImplementation(
        () => Number(nodeTime) * 1000,
        async () => {
          await expect(run(approved)).resolves.toEqual(expected);
        },
      );
    },
  );

  it("signs a Payment that expires 32 ledgers past the reference with fresh Solver approval", async () => {
    const params = structuredClone(approved);
    const payment = decode(params.transactions![0].unsignedTransaction);
    params.transactions![0].unsignedTransaction = encode({ ...payment, LastLedgerSequence: 122 });
    await signRequest(params);
    const result = (await run(params)) as SignResult<"xrp-vm">;
    expect(decode(result.signedTransactions[0].rawTransaction).LastLedgerSequence).toBe(122);
  });

  it.each([90, 123])(
    "rejects ledger expiry outside the attested window (%s)",
    async (LastLedgerSequence) => {
      const params = structuredClone(approved);
      const payment = decode(params.transactions![0].unsignedTransaction);
      params.transactions![0].unsignedTransaction = encode({ ...payment, LastLedgerSequence });
      await signRequest(params);
      await expect(run(params)).rejects.toThrow("XRP ledger expiry");
    },
  );

  it("preserves the shared settlement deadline buffer before XRP signing", async () => {
    await expect(
      run(await buildRequest("xrp", ledgerReference(), Number(NOW) + 60)),
    ).rejects.toThrow("order output deadline must be more than");
  });

  it("rejects transaction bytes altered after Solver approval", async () => {
    const params = structuredClone(approved);
    const payment = decode(params.transactions![0].unsignedTransaction);
    params.transactions![0].unsignedTransaction = encode({ ...payment, Fee: "13" });
    await expect(run(params)).rejects.toThrow("requestSignature mismatch");
  });

  it("rejects an unauthorized Solver", async () => {
    const params = structuredClone(approved);
    params.requestSignature = await outsider.signMessage({
      message: { raw: solverSignRequestHash(params as unknown as Record<string, unknown>) },
    });
    await expect(run(params)).rejects.toThrow("requestSignature mismatch");
  });

  it("rejects a missing Oracle signature even with Solver approval", async () => {
    const params = structuredClone(approved);
    params.attestation!.signatures = [];
    await signRequest(params);
    await expect(run(params)).rejects.toThrow("attestation signature threshold not met");
  });

  it("rejects an Oracle signature bound to a different depository", async () => {
    const params = structuredClone(approved);
    params.attestation!.inputDepository = `0x${"01".repeat(20)}`;
    await signRequest(params);
    await expect(run(params)).rejects.toThrow("attestation signature mismatch");
  });

  it("rejects a ledger timestamp changed after Oracle approval", async () => {
    const params = structuredClone(approved);
    params.trigger!.extraData = ledgerReference(90, NOW + 1n);
    await signRequest(params);
    await expect(run(params)).rejects.toThrow("attestation triggerHash mismatch");
  });

  it("rejects a different signed order", async () => {
    const params = structuredClone(approved);
    params.order!.salt = `0x${"05".repeat(32)}`;
    await signRequest(params);
    await expect(run(params)).rejects.toThrow("order id mismatch");
  });

  it("enforces the Payment policy even when the Solver approves a changed destination", async () => {
    const params = structuredClone(approved);
    const payment = decode(params.transactions![0].unsignedTransaction);
    params.transactions![0].unsignedTransaction = encode({
      ...payment,
      Destination: payment.Account,
    });
    await signRequest(params);
    await expect(run(params)).rejects.toThrow("XRP Destination must equal");
  });
});
