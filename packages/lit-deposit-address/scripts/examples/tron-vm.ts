#!/usr/bin/env tsx
/**
 * Build, Lit-sign, broadcast, and hash-check a Tron deposit sweep.
 *
 * This example starts after the Hub trigger and oracle attestation exist. The
 * input JSON contains `trigger`, `attestation`, `order`, and `orderSignature`.
 * It builds the canonical native or TRC20 protobuf batch from those values,
 * signs the complete request with the solver EOA, invokes the `tron-vm` Lit
 * Action, and broadcasts each returned protobuf via `wallet/broadcasthex`.
 *
 * Required env:
 *   LIT_ENV
 *   LIT_USAGE_API_KEY
 *   LIT_PKP_ID
 *   SOLVER_PRIVATE_KEY
 *   TRON_VM_RPC_URL
 *   TRON_VM_SIGN_INPUT
 *
 * Optional env:
 *   TRON_VM_ALLOWANCE_RESET=true
 *   TRON_VM_FEE_LIMIT_SUN=150000000
 *   LIT_API_BASE_URL
 */

import { readFileSync } from "node:fs";
import { encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { TronWeb, utils } from "tronweb";
import type {
  DepositAddressTrigger,
  DepositAddressTriggerAttestation,
  Order,
  TronVmSignedTransaction,
  TronVmTransaction,
  WalletInfo,
} from "../../src/common/types.js";
import {
  buildLitActionJsParams,
  DEFAULT_BASE_URL,
  executeLitAction,
  type DepositAddressesClient,
} from "../client/index.js";
import { addSolverRequestSignature } from "./solver-request.js";
import { requireEnv } from "./lib/common.js";

const NATIVE_CURRENCY = "410000000000000000000000000000000000000000";
const DEPOSITORY_ABI = parseAbi([
  "function depositNative(address depositor, bytes32 id)",
  "function depositErc20(address depositor, address token, uint256 amount, bytes32 id)",
]);
const ERC20_ABI = parseAbi(["function approve(address spender, uint256 amount)"]);
const CONFIRMATION_POLL_INTERVAL_MS = 3_000;
const CONFIRMATION_POLL_ATTEMPTS = 20;

interface PreparedSignInput {
  trigger: DepositAddressTrigger;
  attestation: DepositAddressTriggerAttestation;
  order: Order;
  orderSignature: string;
}

interface TronSignResult {
  wallet: WalletInfo;
  triggerHash: string;
  signedTransactions: TronVmSignedTransaction[];
}

interface ReferenceBlock {
  blockID: string;
  block_header: { raw_data: { number: number; timestamp: number } };
}

/** Parse one required protocol address encoded as `0x41...` bytes. */
function addressHex(value: string, field: string): string {
  const hex = value.replace(/^0x/u, "").toLowerCase();
  if (!/^41[0-9a-f]{40}$/u.test(hex)) {
    throw new Error(`${field} must be a 21-byte settlement-encoded Tron address`);
  }
  return hex;
}

/** Convert validated 21-byte Tron protocol hex to a 20-byte TVM ABI address. */
function protocolHexToAbiAddress(value: string): Address {
  return `0x${value.slice(2)}`;
}

/** Convert one settlement-encoded Tron address to a TVM ABI address. */
function abiAddress(value: string, field: string): Address {
  return protocolHexToAbiAddress(addressHex(value, field));
}

/** Validate and normalize one bytes32 value for viem ABI encoding. */
function bytes32Hex(value: string, field: string): Hex {
  const normalized = value.toLowerCase();
  if (!/^0x[0-9a-f]{64}$/u.test(normalized)) {
    throw new Error(`${field} must be 32 bytes`);
  }
  return normalized as Hex;
}

/** Build one unsigned protocol.Transaction with TronWeb's reference encoder. */
function buildTriggerTransaction(options: {
  purpose: TronVmTransaction["purpose"];
  owner: string;
  contractAddress: string;
  data: string;
  callValue?: bigint;
  referenceBlock: ReferenceBlock;
  feeLimit: number;
}): TronVmTransaction {
  const timestamp = options.referenceBlock.block_header.raw_data.timestamp;
  const blockNumber = options.referenceBlock.block_header.raw_data.number;
  const callValue = options.callValue ?? 0n;
  if (callValue > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("TRX amount exceeds TronWeb's safe integer range");
  }
  const transaction = {
    visible: false,
    txID: "",
    raw_data_hex: "",
    raw_data: {
      contract: [
        {
          parameter: {
            type_url: "type.googleapis.com/protocol.TriggerSmartContract",
            value: {
              owner_address: options.owner,
              contract_address: options.contractAddress,
              call_value: Number(callValue),
              data: options.data,
            },
          },
          type: "TriggerSmartContract",
        },
      ],
      ref_block_bytes: blockNumber.toString(16).slice(-4).padStart(4, "0"),
      ref_block_hash: options.referenceBlock.blockID.slice(16, 32),
      timestamp,
      expiration: timestamp + 300_000,
      fee_limit: options.feeLimit,
    },
  };
  const protobuf = utils.transaction.txJsonToPb(
    transaction as unknown as Parameters<typeof utils.transaction.txJsonToPb>[0],
  );
  return {
    purpose: options.purpose,
    rawData: `0x${Buffer.from(protobuf.getRawData().serializeBinary()).toString("hex")}`,
  };
}

/** Build the native or ordered TRC20 transaction batch bound to the trigger. */
function buildTransactions(options: {
  input: PreparedSignInput;
  wallet: WalletInfo;
  referenceBlock: ReferenceBlock;
  feeLimit: number;
  allowanceReset: boolean;
}): TronVmTransaction[] {
  const { trigger, attestation } = options.input;
  const amount = BigInt(trigger.input.amount);
  const depositoryHex = addressHex(attestation.inputDepository, "attestation.inputDepository");
  const depository = TronWeb.address.fromHex(depositoryHex);
  const depositor = abiAddress(
    trigger.derivationFields.depositor,
    "trigger.derivationFields.depositor",
  );
  const orderId = bytes32Hex(trigger.orderId, "trigger.orderId");
  const common = {
    owner: options.wallet.address,
    referenceBlock: options.referenceBlock,
    feeLimit: options.feeLimit,
  };
  const currencyHex = addressHex(trigger.input.currency, "trigger.input.currency");
  if (currencyHex === NATIVE_CURRENCY) {
    return [
      buildTriggerTransaction({
        ...common,
        purpose: "native-deposit",
        contractAddress: depository,
        callValue: amount,
        data: encodeFunctionData({
          abi: DEPOSITORY_ABI,
          functionName: "depositNative",
          args: [depositor, orderId],
        }).slice(2),
      }),
    ];
  }

  const token = TronWeb.address.fromHex(currencyHex);
  const transactions: TronVmTransaction[] = [];
  if (options.allowanceReset) {
    transactions.push(
      buildTriggerTransaction({
        ...common,
        purpose: "trc20-pre-approval",
        contractAddress: token,
        data: encodeFunctionData({
          abi: ERC20_ABI,
          functionName: "approve",
          args: [protocolHexToAbiAddress(depositoryHex), 0n],
        }).slice(2),
      }),
    );
  }
  transactions.push(
    buildTriggerTransaction({
      ...common,
      purpose: "trc20-approval",
      contractAddress: token,
      data: encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "approve",
        args: [protocolHexToAbiAddress(depositoryHex), amount],
      }).slice(2),
    }),
    buildTriggerTransaction({
      ...common,
      purpose: "trc20-deposit",
      contractAddress: depository,
      data: encodeFunctionData({
        abi: DEPOSITORY_ABI,
        functionName: "depositErc20",
        args: [depositor, protocolHexToAbiAddress(currencyHex), amount, orderId],
      }).slice(2),
    }),
  );
  return transactions;
}

/** Wait for a broadcast transaction to execute before submitting the next ordered stage. */
async function waitForConfirmation(tronWeb: TronWeb, transactionHash: string): Promise<void> {
  for (let attempt = 0; attempt < CONFIRMATION_POLL_ATTEMPTS; attempt++) {
    const receipt = await tronWeb.trx.getTransactionInfo(transactionHash);
    if (Object.keys(receipt).length > 0) {
      if (receipt.result === "FAILED") {
        throw new Error(`Tron transaction failed: ${transactionHash}: ${receipt.resMessage}`);
      }
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, CONFIRMATION_POLL_INTERVAL_MS));
  }
  throw new Error(`Tron transaction confirmation timed out: ${transactionHash}`);
}

const rpcUrl = requireEnv("TRON_VM_RPC_URL", "Tron fullnode HTTP endpoint");
const inputPath = requireEnv(
  "TRON_VM_SIGN_INPUT",
  "JSON containing trigger, attestation, order, and orderSignature",
);
const solver = privateKeyToAccount(
  requireEnv("SOLVER_PRIVATE_KEY", "solver EOA private key") as `0x${string}`,
);
const envName = requireEnv("LIT_ENV", "Lit Action environment") as "dev";
const litClient: DepositAddressesClient = {
  apiBaseUrl: process.env.LIT_API_BASE_URL?.trim() || DEFAULT_BASE_URL,
  apiKey: requireEnv("LIT_USAGE_API_KEY", "Chipotle usage API key"),
  pkpId: requireEnv("LIT_PKP_ID", "Lit PKP id"),
  envName,
  vmType: "tron-vm",
};
const feeLimit = Number.parseInt(process.env.TRON_VM_FEE_LIMIT_SUN?.trim() ?? "150000000", 10);
if (!Number.isSafeInteger(feeLimit) || feeLimit < 0 || feeLimit > 1_000_000_000) {
  throw new Error("TRON_VM_FEE_LIMIT_SUN must be an integer between 0 and 1000000000");
}

const prepared = JSON.parse(readFileSync(inputPath, "utf8")) as PreparedSignInput;
const tronWeb = new TronWeb({ fullHost: rpcUrl });
const wallet = (await executeLitAction(litClient, {
  action: "wallet",
  derivationFields: prepared.trigger.derivationFields,
})) as WalletInfo;
const referenceBlock = (await tronWeb.trx.getCurrentBlock()) as ReferenceBlock;
const transactions = buildTransactions({
  input: prepared,
  wallet,
  referenceBlock,
  feeLimit,
  allowanceReset: process.env.TRON_VM_ALLOWANCE_RESET?.trim() === "true",
});
const request = await addSolverRequestSignature(
  buildLitActionJsParams(litClient, { action: "sign", ...prepared, transactions }),
  solver,
);
const result = (await executeLitAction(litClient, request)) as TronSignResult;

for (const signed of result.signedTransactions) {
  const broadcast = await tronWeb.trx.sendHexTransaction(signed.rawTransaction.replace(/^0x/u, ""));
  if (!("result" in broadcast) || !broadcast.result) {
    throw new Error(`Tron broadcast failed: ${JSON.stringify(broadcast)}`);
  }
  if (broadcast.txid.toLowerCase() !== signed.transactionHash) {
    throw new Error(
      `broadcast hash mismatch: expected=${signed.transactionHash}, got=${broadcast.txid}`,
    );
  }
  await waitForConfirmation(tronWeb, signed.transactionHash);
  console.log(`broadcast ${signed.transactionHash}`);
}
