import { SLIP10Node } from "https://cdn.jsdelivr.net/npm/@metamask/key-tree@10.1.1/+esm#sha384-iWbSDJToETb8472qJVfgUl0vgl03s8An4v0EtHgKVwHrYQFjgbPU8Xu9n83+plLN";
import type {
  AccountInfo,
  DepositAddressTrigger,
  DepositAddressTriggerAttestation,
  VmType,
  WalletInfo,
} from "../../../common/types.js";

/** Maximum valid unhardened BIP32/CIP3 child index (`2^31 - 1`). */
const MAX_UNHARDENED_INDEX = 0x7fff_ffff;

/** Validate that every entry is a non-negative unhardened uint31 integer. */
function assertIndexes(indexes: readonly number[]): void {
  if (indexes.length === 0) {
    throw new Error("at least one index is required");
  }
  for (const index of indexes) {
    if (!Number.isInteger(index) || index < 0 || index > MAX_UNHARDENED_INDEX) {
      throw new Error("index must be an unhardened uint31");
    }
  }
}

/**
 * Abstract base class for VM-specific deterministic wallet derivation.
 *
 * The generic parameters describe the VM-native transaction shape (`Tx`) and
 * its corresponding signed-transaction output (`SignedTx`). Subclasses pin
 * those to their concrete types and implement the curve/address/signing
 * primitives.
 */
export abstract class VmWalletDeriver<Tx = unknown, SignedTx = unknown> {
  /** VM family this deriver handles. */
  abstract readonly vmType: VmType;

  /** Canonical account derivation path, e.g. `m/44'/60'/0'/0`. */
  protected abstract readonly accountPath: string;

  /** Derive the publicly shareable account root for this VM. */
  async deriveAccount(rootKeyHex: string): Promise<AccountInfo> {
    return this.accountFromNode(await this.deriveAccountNode(rootKeyHex));
  }

  /** Derive a child wallet at `indexes` from the PKP root key. */
  async deriveWallet(rootKeyHex: string, indexes: readonly number[]): Promise<WalletInfo> {
    assertIndexes(indexes);
    const accountNode = await this.deriveAccountNode(rootKeyHex);
    const childNode = await this.deriveChildAtPath(accountNode, indexes);
    return this.walletFromNode(indexes, childNode);
  }

  /**
   * Derive a child wallet at `indexes` from an account-level extended public
   * key. Produces the same public address and public key as
   * {@link deriveWallet} but does not require access to the root private key.
   */
  async deriveWalletFromExtendedPublicKey(
    extendedPublicKey: string,
    indexes: readonly number[],
  ): Promise<WalletInfo> {
    assertIndexes(indexes);
    const accountNode = await this.deserializeAccountNode(extendedPublicKey);
    const childNode = await this.deriveChildAtPath(accountNode, indexes);
    return this.walletFromNode(indexes, childNode);
  }

  /**
   * Authorize a batch of unsigned VM-native transactions against an active
   * trigger + oracle attestation. Default implementation is a no-op so VMs
   * without an enforced policy inherit it; subclasses should override this
   * to reject any transaction that doesn't match their expected deposit
   * shape, and should throw with a descriptive error otherwise.
   *
   * Called by the action before signing so a malicious caller can't trick
   * the TEE into signing an arbitrary transaction with the deposit wallet.
   */
  verifyTransactions(
    _trigger: DepositAddressTrigger,
    _attestation: DepositAddressTriggerAttestation,
    _transactions: readonly Tx[],
  ): void {
    // no-op by default
  }

  /**
   * Sign one or more VM-native transactions with the child wallet at `indexes`.
   * The wallet's private key is derived once and reused for every transaction.
   */
  async signTransactions(
    rootKeyHex: string,
    indexes: readonly number[],
    transactions: readonly Tx[],
  ): Promise<{ wallet: WalletInfo; signedTransactions: SignedTx[] }> {
    if (transactions.length === 0) {
      throw new Error("at least one transaction is required");
    }
    const { wallet, privateKey } = await this.deriveChildKey(rootKeyHex, indexes);
    const signedTransactions = await Promise.all(
      transactions.map((tx) => this.signTransactionWithKey(privateKey, tx)),
    );
    return { wallet, signedTransactions };
  }

  /** Format the full derivation path including child indexes. */
  protected path(indexes: readonly number[]): string {
    return `${this.accountPath}/${indexes.join("/")}`;
  }

  /** Derive the wallet at `indexes` and return its private key + public info. */
  private async deriveChildKey(
    rootKeyHex: string,
    indexes: readonly number[],
  ): Promise<{ wallet: WalletInfo; privateKey: Uint8Array }> {
    assertIndexes(indexes);
    const accountNode = await this.deriveAccountNode(rootKeyHex);
    const childNode = await this.deriveChildAtPath(accountNode, indexes);
    if (!childNode.privateKeyBytes) {
      throw new Error(`failed to derive ${this.vmType} child private key`);
    }
    return {
      wallet: this.walletFromNode(indexes, childNode),
      privateKey: childNode.privateKeyBytes,
    };
  }

  /** Walk one child level at a time so the same primitive supports any depth. */
  private async deriveChildAtPath(
    accountNode: SLIP10Node,
    indexes: readonly number[],
  ): Promise<SLIP10Node> {
    let node = accountNode;
    for (const index of indexes) {
      node = await this.deriveChildNode(node, index);
    }
    return node;
  }

  protected abstract deriveAccountNode(rootKeyHex: string): Promise<SLIP10Node>;
  protected abstract deserializeAccountNode(extendedPublicKey: string): Promise<SLIP10Node>;
  protected abstract deriveChildNode(node: SLIP10Node, index: number): Promise<SLIP10Node>;
  protected abstract accountFromNode(accountNode: SLIP10Node): AccountInfo;
  protected abstract walletFromNode(indexes: readonly number[], childNode: SLIP10Node): WalletInfo;
  protected abstract signTransactionWithKey(
    privateKey: Uint8Array,
    transaction: Tx,
  ): Promise<SignedTx>;
}
