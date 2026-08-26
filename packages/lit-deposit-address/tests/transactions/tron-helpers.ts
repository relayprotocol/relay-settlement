import { TronWeb, utils } from "tronweb";
import type { TronVmTransaction } from "../../src/common/types.js";

export const TRON_DEPOSITORY = "TXtEs6t2oUWQsNos7m68gbHdE9Q5n6x2oN";
export const TRON_TOKEN = "TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC";
export const OTHER_TRON_ADDRESS = "TZ36csLY9VZyWAH1NRN8SRSmskFjqESdoS";

interface TriggerContractOptions {
  purpose: TronVmTransaction["purpose"];
  owner: string;
  contractAddress: string;
  data: string;
  callValue?: bigint;
  timestamp?: number;
  expiration?: number;
  duplicateContract?: boolean;
  typeUrl?: string;
}

/** Encode a Tron address as one TVM ABI address word. */
export function tronAddressWord(address: string): string {
  return TronWeb.address.toHex(address).slice(2).padStart(64, "0");
}

/** Build an unsigned TriggerSmartContract protobuf using TronWeb as the reference encoder. */
export function buildTriggerContractTransaction(
  options: TriggerContractOptions,
): TronVmTransaction {
  const timestamp = options.timestamp ?? Date.now();
  const contract = {
    parameter: {
      type_url: "type.googleapis.com/protocol.TriggerSmartContract",
      value: {
        owner_address: options.owner,
        contract_address: options.contractAddress,
        call_value: Number(options.callValue ?? 0n),
        data: options.data,
      },
    },
    type: "TriggerSmartContract",
  };
  const transaction = {
    visible: false,
    txID: "",
    raw_data_hex: "",
    raw_data: {
      contract: [contract],
      ref_block_bytes: "abcd",
      ref_block_hash: "0011223344556677",
      expiration: options.expiration ?? timestamp + 60_000,
      timestamp,
      fee_limit: 100_000_000,
    },
  };
  const protobuf = utils.transaction.txJsonToPb(
    transaction as unknown as Parameters<typeof utils.transaction.txJsonToPb>[0],
  );
  if (options.duplicateContract) {
    const rawData = protobuf.getRawData();
    rawData.addContract(rawData.getContractList()[0]);
  }
  if (options.typeUrl) {
    protobuf.getRawData().getContractList()[0].getParameter().setTypeUrl(options.typeUrl);
  }
  return {
    purpose: options.purpose,
    rawData: `0x${Buffer.from(protobuf.getRawData().serializeBinary()).toString("hex")}`,
  };
}

/** Build the removed residue-recovery request shape to verify that policy rejects it. */
export function buildTransferTransaction(options: {
  owner: string;
  recipient?: string;
  amount?: bigint;
  timestamp?: number;
}): TronVmTransaction {
  const timestamp = options.timestamp ?? Date.now();
  const transaction = {
    visible: false,
    txID: "",
    raw_data_hex: "",
    raw_data: {
      contract: [
        {
          parameter: {
            type_url: "type.googleapis.com/protocol.TransferContract",
            value: {
              owner_address: options.owner,
              to_address: options.recipient ?? OTHER_TRON_ADDRESS,
              amount: Number(options.amount ?? 1n),
            },
          },
          type: "TransferContract",
        },
      ],
      ref_block_bytes: "abcd",
      ref_block_hash: "0011223344556677",
      expiration: timestamp + 60_000,
      timestamp,
    },
  };
  const protobuf = utils.transaction.txJsonToPb(
    transaction as unknown as Parameters<typeof utils.transaction.txJsonToPb>[0],
  );
  return {
    purpose: "residue-recovery",
    rawData: `0x${Buffer.from(protobuf.getRawData().serializeBinary()).toString("hex")}`,
  } as unknown as TronVmTransaction;
}
