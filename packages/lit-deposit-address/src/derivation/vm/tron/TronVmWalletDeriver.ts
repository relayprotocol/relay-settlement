import { SLIP10Node } from "https://cdn.jsdelivr.net/npm/@metamask/key-tree@10.1.1/+esm";
import { secp256k1 } from "https://cdn.jsdelivr.net/npm/@noble/curves@2.0.1/secp256k1.js/+esm";
import { sha256 } from "https://cdn.jsdelivr.net/npm/@noble/hashes@2.0.1/sha2.js/+esm";
import { encodeTronAddress, tronAddressFromPublicKey } from "../../../common/address/tron.js";
import { bytesToHex } from "../../../common/bytes.js";
import {
  decodeTronRawData,
  encodeSignedTronTransaction,
} from "../../../common/tron/transaction.js";
import type {
  DepositAddressTrigger,
  DepositAddressTriggerAttestation,
  TronVmSignedTransaction,
  TronVmTransaction,
  WalletInfo,
} from "../../../common/types.js";
import { Secp256k1VmWalletDeriver } from "../base/Secp256k1VmWalletDeriver.js";
import { assertTronTransactions } from "./policy.js";

/** Tron wallet deriver using the SLIP-0044 coin type 195 account root. */
export class TronVmWalletDeriver extends Secp256k1VmWalletDeriver<
  TronVmTransaction,
  TronVmSignedTransaction
> {
  readonly vmType = "tron-vm" as const;
  protected readonly accountPath = "m/44'/195'/0'/0";
  protected readonly accountSegments = ["bip32:44'", "bip32:195'", "bip32:0'", "bip32:0"] as const;

  /** Reject transaction batches outside the authorized Tron deposit flows. */
  override verifyTransactions(
    trigger: DepositAddressTrigger,
    attestation: DepositAddressTriggerAttestation,
    transactions: readonly TronVmTransaction[],
  ): void {
    assertTronTransactions(trigger, attestation, transactions);
  }

  /** Format a derived child node as a canonical Tron Base58Check wallet. */
  protected walletFromNode(indexes: readonly number[], childNode: SLIP10Node): WalletInfo {
    return {
      vmType: this.vmType,
      indexes: [...indexes],
      path: this.path(indexes),
      address: tronAddressFromPublicKey(childNode.compressedPublicKey),
      publicKey: childNode.compressedPublicKey,
    };
  }

  /** Sign one canonical Tron protobuf transaction. */
  protected async signTransactionWithKey(
    privateKey: Uint8Array,
    transaction: TronVmTransaction,
  ): Promise<TronVmSignedTransaction> {
    const parsed = decodeTronRawData(transaction.rawData);
    const signerAddress = bytesToHex(
      encodeTronAddress(tronAddressFromPublicKey(bytesToHex(secp256k1.getPublicKey(privateKey)))),
    );
    if (parsed.rawData.contract.ownerAddress !== signerAddress) {
      throw new Error(
        `Tron transaction owner mismatch: expected=${signerAddress}, got=${parsed.rawData.contract.ownerAddress}`,
      );
    }
    const digest = sha256(parsed.rawDataBytes);
    const recovered = secp256k1.sign(digest, privateKey, {
      prehash: false,
      format: "recovered",
    });
    const signature = new Uint8Array(65);
    signature.set(recovered.slice(1), 0);
    signature[64] = recovered[0];
    return {
      rawTransaction: encodeSignedTronTransaction(parsed, signature),
      transactionHash: bytesToHex(digest),
    };
  }
}
