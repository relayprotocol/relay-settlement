import {
  SLIP10Node,
  ed25519Bip32,
} from "https://cdn.jsdelivr.net/npm/@metamask/key-tree@10.1.1/+esm";
import { pbkdf2 } from "https://cdn.jsdelivr.net/npm/@noble/hashes@2.0.1/pbkdf2.js/+esm";
import { sha512 } from "https://cdn.jsdelivr.net/npm/@noble/hashes@2.0.1/sha2.js/+esm";
import { hexToBytes } from "../../../common/bytes.js";
import { deriveVmSeed } from "../../../common/crypto.js";
import type { AccountInfo } from "../../../common/types.js";
import { VmWalletDeriver } from "./VmWalletDeriver.js";

/** PBKDF2 iteration count for CIP-3 root-node derivation. */
const PBKDF2_ITERATIONS = 4096;

/**
 * Base class for Ed25519 VMs that use the publicly derivable CIP-3 /
 * BIP32-Ed25519 scheme (via `@metamask/key-tree`'s `ed25519Bip32` curve), so
 * child wallets can be derived from the account extended public key alone.
 *
 * This differs from the hardened-only SLIP-0010 derivation most Ed25519
 * wallets use, but still produces valid Ed25519 keypairs. Subclasses pin the
 * account path segments and format the public key / address per VM.
 */
export abstract class Ed25519Bip32VmWalletDeriver<Tx, SignedTx> extends VmWalletDeriver<
  Tx,
  SignedTx
> {
  /** CIP-3 account path segments after the root node, e.g. `cip3:44'`. */
  protected abstract readonly accountSegments: readonly string[];

  /** Format the account/wallet public key per VM convention. */
  protected abstract formatPublicKey(publicKeyBytes: Uint8Array): string;

  protected async deriveAccountNode(rootKeyHex: string): Promise<SLIP10Node> {
    const rootKey = hexToBytes(rootKeyHex, "rootKeyHex");
    const entropy = deriveVmSeed(rootKey, this.vmType);

    // CIP-3 root-node clamping over a PBKDF2-stretched master key.
    const rootNode = pbkdf2(sha512, ed25519Bip32.secret, entropy, {
      c: PBKDF2_ITERATIONS,
      dkLen: 96,
    });
    rootNode[0] &= 0b1111_1000;
    rootNode[31] &= 0b0001_1111;
    rootNode[31] |= 0b0100_0000;

    const master = await SLIP10Node.fromExtendedKey({
      depth: 0,
      parentFingerprint: 0,
      index: 0,
      chainCode: rootNode.slice(64),
      privateKey: rootNode.slice(0, 64),
      curve: "ed25519Bip32",
    });

    return master.derive(this.accountSegments as unknown as Parameters<typeof master.derive>[0]);
  }

  protected deserializeAccountNode(extendedPublicKey: string): Promise<SLIP10Node> {
    return SLIP10Node.fromJSON(
      JSON.parse(extendedPublicKey) as Parameters<typeof SLIP10Node.fromJSON>[0],
    );
  }

  protected deriveChildNode(node: SLIP10Node, index: number): Promise<SLIP10Node> {
    return node.derive([`cip3:${index}`]);
  }

  protected accountFromNode(accountNode: SLIP10Node): AccountInfo {
    return {
      vmType: this.vmType,
      accountPath: this.accountPath,
      publicKey: this.formatPublicKey(accountNode.publicKeyBytes),
      extendedPublicKey: JSON.stringify(accountNode.neuter().toJSON()),
    };
  }
}
