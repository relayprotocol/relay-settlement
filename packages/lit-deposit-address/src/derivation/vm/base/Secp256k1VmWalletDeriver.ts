import { SLIP10Node } from "https://cdn.jsdelivr.net/npm/@metamask/key-tree@10.1.1/+esm";
import { hexToBytes } from "../../../common/bytes.js";
import { deriveVmSeed } from "../../../common/crypto.js";
import type { AccountInfo } from "../../../common/types.js";
import { VmWalletDeriver } from "./VmWalletDeriver.js";

/**
 * Base class for secp256k1-curve VMs. Wires the BIP32 primitives from
 * `@metamask/key-tree` into the abstract deriver and leaves address and
 * transaction-signature formatting to concrete subclasses.
 */
export abstract class Secp256k1VmWalletDeriver<Tx, SignedTx> extends VmWalletDeriver<Tx, SignedTx> {
  /** BIP32 segments after the seed that form the account path. */
  protected abstract readonly accountSegments: readonly string[];

  protected async deriveAccountNode(rootKeyHex: string): Promise<SLIP10Node> {
    const rootKey = hexToBytes(rootKeyHex, "rootKeyHex");
    const seed = deriveVmSeed(rootKey, this.vmType);
    return SLIP10Node.fromSeed({
      curve: "secp256k1",
      // `@metamask/key-tree` accepts the seed as the first element of the path.
      derivationPath: [seed, ...this.accountSegments] as unknown as [
        Uint8Array,
        ...`bip32:${number}`[],
      ],
    });
  }

  protected deserializeAccountNode(extendedPublicKey: string): Promise<SLIP10Node> {
    return SLIP10Node.fromExtendedKey(extendedPublicKey);
  }

  protected deriveChildNode(node: SLIP10Node, index: number): Promise<SLIP10Node> {
    return node.derive([`bip32:${index}`]);
  }

  protected accountFromNode(accountNode: SLIP10Node): AccountInfo {
    return {
      vmType: this.vmType,
      accountPath: this.accountPath,
      publicKey: accountNode.compressedPublicKey,
      extendedPublicKey: accountNode.neuter().extendedKey,
    };
  }
}
