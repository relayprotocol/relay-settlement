import {
  SLIP10Node,
  ed25519Bip32,
} from "https://cdn.jsdelivr.net/npm/@metamask/key-tree@10.1.1/+esm";
import { bytesToBase64, bytesToHex, hexToBytes } from "../../../common/bytes.js";
import { encodeTonAddress } from "../../../common/address/ton.js";
import { signEd25519Bip32 } from "../../../common/ed25519.js";
import {
  TON_NETWORK_GLOBAL_ID,
  commentBody,
  externalMessage,
  internalMessage,
  sendModeCarriesAll,
  signedRequestWithSignature,
  signingRequest,
  walletAddressHash,
  walletIdV5R1,
  walletStateInit,
} from "../../../common/ton/wallet.js";
import type {
  DepositAddressTrigger,
  DepositAddressTriggerAttestation,
  TonVmSignedTransaction,
  TonVmTransaction,
  WalletInfo,
} from "../../../common/types.js";
import { Ed25519Bip32VmWalletDeriver } from "../base/Ed25519Bip32VmWalletDeriver.js";

const HASH_LEN = 32;
const DEPOSITOR_RE = /\|depositor=([^|]+)(?=\|)/;

/**
 * TON wallet deriver. Deposit wallets are Wallet V5R1 contracts whose address
 * is the hash of the StateInit built from the Ed25519 public key. Key
 * derivation reuses the publicly-derivable CIP-3 / BIP32-Ed25519 scheme (the
 * same one used for Solana), so child wallets derive from the account
 * extended public key alone.
 *
 * Deposits on TON are detected by the oracle as a native-TON internal message
 * to the depository carrying the order id in a text comment (the same
 * model as bitcoin-vm's OP_RETURN). The signer therefore authorizes a single
 * Wallet V5R1 transfer that forwards the deposited funds to the depository
 * with `trigger.orderId` and `|depositor=<addr>|` in the comment.
 */
export class TonVmWalletDeriver extends Ed25519Bip32VmWalletDeriver<
  TonVmTransaction,
  TonVmSignedTransaction
> {
  readonly vmType = "ton-vm" as const;
  protected readonly accountPath = "m/44'/607'/0'/0";
  protected readonly accountSegments = ["cip3:44'", "cip3:607'", "cip3:0'", "cip3:0"] as const;

  protected formatPublicKey(publicKeyBytes: Uint8Array): string {
    return `0x${bytesToHex(publicKeyBytes)}`;
  }

  /**
   * Reject any sweep that doesn't match the expected native-TON deposit for
   * the current trigger:
   *
   * - exactly one transfer, non-bounceable (a bounce would auto-refund the
   *   credit), with `to` resolving to `attestation.inputDepository`;
   * - `amount === trigger.input.amount` and a send mode that delivers exactly
   *   that value (no carry-all-balance bits);
   * - a text comment that starts with `trigger.orderId` and carries
   *   `|depositor=<addr>|` resolving to `trigger.derivationFields.depositor`;
   * - native TON only (`trigger.input.currency` is the 32-zero-byte sentinel).
   */
  override verifyTransactions(
    trigger: DepositAddressTrigger,
    attestation: DepositAddressTriggerAttestation,
    transactions: readonly TonVmTransaction[],
  ): void {
    if (transactions.length !== 1) {
      throw new Error(`ton deposit requires exactly 1 transaction, got ${transactions.length}`);
    }
    const tx = transactions[0];

    const currency = hexToBytes(trigger.input.currency, "trigger.input.currency");
    if (currency.length !== HASH_LEN || !currency.every((b) => b === 0)) {
      throw new Error("ton-vm only supports native TON deposits");
    }

    if (tx.bounce) {
      throw new Error("transactions[0]: deposit transfer must be non-bounceable");
    }

    const expectedDepository = hex32Bytes(
      attestation.inputDepository,
      "attestation.inputDepository",
    );
    const actualTo = encodeTonAddress(tx.to);
    if (!bytesEqual(actualTo, expectedDepository)) {
      throw new Error(
        `transactions[0]: "to" must equal input depository 0x${bytesToHex(expectedDepository)}, got 0x${bytesToHex(actualTo)}`,
      );
    }

    const expectedAmount = BigInt(trigger.input.amount);
    if (BigInt(tx.amount) !== expectedAmount) {
      throw new Error(
        `transactions[0]: amount must equal input.amount: expected=${expectedAmount}, got=${tx.amount}`,
      );
    }

    if (sendModeCarriesAll(tx.sendMode)) {
      throw new Error(
        "transactions[0]: send mode must not carry the remaining balance (amount would not be exact)",
      );
    }

    if (!tx.comment.startsWith(trigger.orderId)) {
      throw new Error("transactions[0]: comment must start with trigger.orderId");
    }
    const depositor = DEPOSITOR_RE.exec(tx.comment)?.[1];
    if (!depositor) {
      throw new Error("transactions[0]: comment must include |depositor=<depositor>|");
    }
    const expectedDepositor = hex32Bytes(
      trigger.derivationFields.depositor,
      "trigger.derivationFields.depositor",
    );
    if (!bytesEqual(encodeTonAddress(depositor), expectedDepositor)) {
      throw new Error(
        `transactions[0]: comment depositor mismatch: expected=0x${bytesToHex(expectedDepositor)}, got=${depositor}`,
      );
    }
  }

  protected walletFromNode(indexes: readonly number[], childNode: SLIP10Node): WalletInfo {
    const publicKey = childNode.publicKeyBytes;
    return {
      vmType: this.vmType,
      indexes: [...indexes],
      path: this.path(indexes),
      address: `0:${bytesToHex(walletAddressHash(publicKey))}`,
      publicKey: `0x${bytesToHex(publicKey)}`,
    };
  }

  protected async signTransactionWithKey(
    privateKey: Uint8Array,
    transaction: TonVmTransaction,
  ): Promise<TonVmSignedTransaction> {
    const publicKey = ed25519Bip32.getPublicKey(privateKey);
    const addressHash = walletAddressHash(publicKey);

    const message = internalMessage({
      destHash: encodeTonAddress(transaction.to),
      amount: BigInt(transaction.amount),
      bounce: transaction.bounce,
      body: commentBody(transaction.comment),
    });

    const request = signingRequest({
      walletId: walletIdV5R1(TON_NETWORK_GLOBAL_ID),
      seqno: transaction.seqno,
      validUntil: transaction.validUntil,
      sendMode: transaction.sendMode,
      message,
    });
    const signingHash = request.endCell().hash();
    const signature = signEd25519Bip32(signingHash, privateKey);

    const body = signedRequestWithSignature(request, signature);
    const stateInit = transaction.seqno === 0 ? walletStateInit(publicKey) : null;
    const external = externalMessage({ addressHash, stateInit, body });

    return {
      signature: `0x${bytesToHex(signature)}`,
      signingHash: `0x${bytesToHex(signingHash)}`,
      externalMessage: bytesToBase64(external.toBoc()),
    };
  }
}

/** Decode a 32-byte bytes-hex value, asserting it's exactly 32 bytes. */
function hex32Bytes(hex: string, field: string): Uint8Array {
  const bytes = hexToBytes(hex, field);
  if (bytes.length !== HASH_LEN) {
    throw new Error(`${field} must be 32 bytes, got ${bytes.length}`);
  }
  return bytes;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}
