import type { SLIP10Node } from "https://cdn.jsdelivr.net/npm/@metamask/key-tree@10.1.1/+esm";
import { secp256k1 } from "https://cdn.jsdelivr.net/npm/@noble/curves@2.0.1/secp256k1.js/+esm";
import { sha512 } from "https://cdn.jsdelivr.net/npm/@noble/hashes@2.0.1/sha2.js/+esm";
import {
  encode,
  encodeForSigning,
} from "https://cdn.jsdelivr.net/npm/ripple-binary-codec@2.8.0/dist/index.js/+esm";
import {
  deriveAddress,
  sign,
} from "https://cdn.jsdelivr.net/npm/ripple-keypairs@2.0.0/dist/index.js/+esm";
import { bytesToHex, hexToBytes } from "../../../common/bytes.js";
import type {
  DepositAddressTrigger,
  DepositAddressTriggerAttestation,
  WalletInfo,
  XrpVmSignedTransaction,
  XrpVmTransaction,
} from "../../../common/types.js";
import { Secp256k1VmWalletDeriver } from "../base/Secp256k1VmWalletDeriver.js";
import { assertXrpTransactions, parseXrpPayment } from "./policy.js";

/** Derive XRP wallets and sign native sweeps with the SLIP-0044 coin type 144 root. */
export class XrpVmWalletDeriver extends Secp256k1VmWalletDeriver<
  XrpVmTransaction,
  XrpVmSignedTransaction
> {
  readonly vmType = "xrp-vm" as const;
  protected readonly accountPath = "m/44'/144'/0'/0";
  protected readonly accountSegments = ["bip32:44'", "bip32:144'", "bip32:0'", "bip32:0"] as const;

  /** Enforce the native XRP sweep policy before signing. */
  override verifyTransactions(
    trigger: DepositAddressTrigger,
    attestation: DepositAddressTriggerAttestation,
    transactions: readonly XrpVmTransaction[],
    wallet?: WalletInfo,
  ): void {
    assertXrpTransactions(trigger, attestation, transactions, wallet);
  }

  /** Format the derived public key as a classic XRP address. */
  protected walletFromNode(indexes: readonly number[], childNode: SLIP10Node): WalletInfo {
    return {
      vmType: this.vmType,
      indexes: [...indexes],
      path: this.path(indexes),
      address: deriveAddress(childNode.compressedPublicKey.slice(2)),
      publicKey: childNode.compressedPublicKey,
    };
  }

  /** Sign canonical XRPL bytes and return the blob with its prefixed SHA512Half id. */
  protected async signTransactionWithKey(
    privateKey: Uint8Array,
    transaction: XrpVmTransaction,
  ): Promise<XrpVmSignedTransaction> {
    const payment = parseXrpPayment(transaction);
    const publicKey = bytesToHex(secp256k1.getPublicKey(privateKey)).toUpperCase();
    if (payment.Account !== deriveAddress(publicKey)) {
      throw new Error("XRP transaction Account mismatch");
    }
    const unsigned = { ...payment, SigningPubKey: publicKey };
    const signature = sign(encodeForSigning(unsigned), `00${bytesToHex(privateKey)}`);
    const rawTransaction = encode({ ...unsigned, TxnSignature: signature });
    // XRPL transaction ids hash the TXN prefix followed by the complete signed bytes.
    const hash = sha512(hexToBytes(`54584E00${rawTransaction}`, "signed XRP transaction"));
    return { rawTransaction, transactionHash: bytesToHex(hash.slice(0, 32)).toUpperCase() };
  }
}
