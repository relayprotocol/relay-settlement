import { SLIP10Node } from "https://cdn.jsdelivr.net/npm/@metamask/key-tree@10.1.1/+esm";
import { secp256k1 } from "https://cdn.jsdelivr.net/npm/@noble/curves@2.0.1/secp256k1.js/+esm";
import { bech32 } from "https://cdn.jsdelivr.net/npm/@scure/base@2.0.0/+esm";
import { bytesToHex } from "../../../common/bytes.js";
import { hash160 } from "../../../common/crypto.js";
import type {
  BitcoinVmSignedTransaction,
  BitcoinVmTransaction,
  DepositAddressTrigger,
  DepositAddressTriggerAttestation,
  WalletInfo,
} from "../../../common/types.js";
import { Secp256k1VmWalletDeriver } from "../base/Secp256k1VmWalletDeriver.js";
import { assertBitcoinDepositTransaction, signableBitcoinDigests } from "./transaction.js";

/**
 * Bitcoin wallet deriver. Produces native-segwit (`bc1...`) P2WPKH addresses
 * from the compressed secp256k1 public key and signs 64-byte compact ECDSA
 * signatures.
 */
export class BitcoinVmWalletDeriver extends Secp256k1VmWalletDeriver<
  BitcoinVmTransaction,
  BitcoinVmSignedTransaction
> {
  readonly vmType = "bitcoin-vm" as const;
  protected readonly accountPath = "m/84'/0'/0'/0";
  protected readonly accountSegments = ["bip32:84'", "bip32:0'", "bip32:0'", "bip32:0"] as const;

  override verifyTransactions(
    trigger: DepositAddressTrigger,
    attestation: DepositAddressTriggerAttestation,
    transactions: readonly BitcoinVmTransaction[],
  ): void {
    if (transactions.length !== 1) {
      throw new Error(`bitcoin deposit requires exactly 1 transaction, got ${transactions.length}`);
    }
    assertBitcoinDepositTransaction(trigger, attestation, transactions[0]);
  }

  protected walletFromNode(indexes: readonly number[], childNode: SLIP10Node): WalletInfo {
    const program = hash160(childNode.compressedPublicKeyBytes);
    return {
      vmType: this.vmType,
      indexes: [...indexes],
      path: this.path(indexes),
      address: bech32.encode("bc", [0, ...bech32.toWords(program)]),
      publicKey: childNode.compressedPublicKey,
    };
  }

  protected async signTransactionWithKey(
    privateKey: Uint8Array,
    transaction: BitcoinVmTransaction,
  ): Promise<BitcoinVmSignedTransaction> {
    if (transaction.sighashes.length === 0) {
      throw new Error("bitcoin transaction must have at least one sighash");
    }
    const publicKey = secp256k1.getPublicKey(privateKey, true);
    return {
      signatures: signableBitcoinDigests(transaction, publicKey).map((digest) => {
        const sig = secp256k1.sign(digest, privateKey, { prehash: false, format: "compact" });
        return `0x${bytesToHex(sig)}`;
      }),
    };
  }
}
