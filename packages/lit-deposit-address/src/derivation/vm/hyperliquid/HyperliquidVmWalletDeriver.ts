import { SLIP10Node } from "https://cdn.jsdelivr.net/npm/@metamask/key-tree@10.1.1/+esm#sha384-iWbSDJToETb8472qJVfgUl0vgl03s8An4v0EtHgKVwHrYQFjgbPU8Xu9n83+plLN";
import { secp256k1 } from "https://cdn.jsdelivr.net/npm/@noble/curves@2.0.1/secp256k1.js/+esm#sha384-EtK9grXXeMKBkEYOQQfnqbuL27d6fm62SvYWp0bXat9Nh0VIK6vdGAqidcU/3m+d";
import { encodeAddressToHex, normalizeAddressHex } from "../../../common/address.js";
import { bytesToHex } from "../../../common/bytes.js";
import { keccak256 } from "../../../common/crypto.js";
import type {
  DepositAddressTrigger,
  DepositAddressTriggerAttestation,
  HyperliquidVmSignedTransaction,
  HyperliquidVmTransaction,
  WalletInfo,
} from "../../../common/types.js";
import { Secp256k1VmWalletDeriver } from "../base/Secp256k1VmWalletDeriver.js";
import { assertHyperliquidDeposit } from "./policy.js";
import { signNonceMapping, signSendAsset } from "./signing.js";

export class HyperliquidVmWalletDeriver extends Secp256k1VmWalletDeriver<
  HyperliquidVmTransaction,
  HyperliquidVmSignedTransaction
> {
  readonly vmType = "hyperliquid-vm" as const;
  protected readonly accountPath = "m/44'/60'/0'/0";
  protected readonly accountSegments = ["bip32:44'", "bip32:60'", "bip32:0'", "bip32:0"] as const;

  override verifyTransactions(
    trigger: DepositAddressTrigger,
    attestation: DepositAddressTriggerAttestation,
    transactions: readonly HyperliquidVmTransaction[],
  ): void {
    if (transactions.length !== 1) {
      throw new Error(
        `hyperliquid deposit requires exactly 1 transaction (nonceMapping + sendAsset), got ${transactions.length}`,
      );
    }
    assertHyperliquidDeposit(trigger, attestation, transactions[0]);
  }

  protected walletFromNode(indexes: readonly number[], childNode: SLIP10Node): WalletInfo {
    const uncompressed = secp256k1.Point.fromHex(
      bytesToHex(childNode.compressedPublicKeyBytes),
    ).toBytes(false);
    const address = `0x${bytesToHex(keccak256(uncompressed.slice(1)).slice(12))}`;
    return {
      vmType: this.vmType,
      indexes: [...indexes],
      path: this.path(indexes),
      address,
      publicKey: childNode.compressedPublicKey,
    };
  }

  protected async signTransactionWithKey(
    privateKey: Uint8Array,
    transaction: HyperliquidVmTransaction,
  ): Promise<HyperliquidVmSignedTransaction> {
    const publicKey = secp256k1.getPublicKey(privateKey, false);
    const wallet = `0x${bytesToHex(keccak256(publicKey.slice(1)).slice(12))}`;
    const expectedWallet = normalizeAddressHex(transaction.nonceMapping.wallet, "hyperliquid-vm");
    const actualWallet = encodeAddressToHex(wallet, "hyperliquid-vm").toLowerCase();
    if (actualWallet !== expectedWallet) {
      throw new Error(
        `nonceMapping.wallet must equal derived hyperliquid wallet: expected=${actualWallet}, got=${expectedWallet}`,
      );
    }
    return {
      nonceMapping: signNonceMapping(transaction.nonceMapping, privateKey),
      sendAsset: signSendAsset(transaction.sendAsset, privateKey),
    };
  }
}
