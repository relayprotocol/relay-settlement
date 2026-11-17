/**
 * Lit Action: Atlas signer.
 *
 * Runs inside Lit's TEE. Atlas accounts are named by an EVM-style address: a
 * Main account's address is its owner key's address, so the address derived
 * here is the depository account. The key signs Atlas transfers out of that
 * account: the digest is rebuilt from the transfer under the environment's
 * domain and must be the one hash the oracle attested for the withdraw request.
 * Its only other signature is the bind that opens the wallet, with every field
 * but the expiry and the accepted terms fixed here.
 *
 * js_params:
 *   - pkpId:           string — PKP identifier
 *   - action:          string — "wallet" | "sign" | "onboard"
 *   - withdrawRequest: object — RelayAllocator WithdrawRequest (required for action=sign)
 *   - attestation:     object — oracle WithdrawRequestAttestation (required for action=sign)
 *   - transfer:        object — the payload builder's Atlas transfer (required for action=sign)
 *   - bind:            object — expiry and statements of the wallet-opening bind (required for action=onboard)
 */
import { addr } from "https://cdn.jsdelivr.net/npm/micro-eth-signer@0.18.1/+esm";
import { sign as secpSign } from "https://cdn.jsdelivr.net/npm/micro-eth-signer@0.18.1/utils.js/+esm";
import {
  bytesToHex,
  deriveKey,
  hexToBytes,
  verifyWithdrawRequestAttestation,
  type WithdrawRequestAttestation,
  type WithdrawRequest,
} from "../common/index.js";
import { parseQuantity, quantityToWord } from "../common/abi.js";
import { bytesToBigInt, concatBytes, equalBytes, expectLength } from "../common/bytes.js";
import { keccak } from "../common/crypto.js";
import {
  ALLOCATOR_ADDRESS,
  ALLOWED_ORACLES,
  HUB_EVM_CHAIN_ID,
  ORACLE_SIGNATURE_THRESHOLD,
} from "../config.js";
import { ATLAS_DOMAIN, type AtlasDomain } from "../custom-configs/atlas-vm.js";

const encoder = new TextEncoder();

const EIP712_DOMAIN_TYPE = "EIP712Domain(string name,string version,uint256 chainId,bytes32 salt)";
const ATLAS_DOMAIN_NAME = "atlas";
const ATLAS_DOMAIN_VERSION = "1";
const NONCE_GAPLESS_TYPE = "NonceGapless(uint64 gapless_nonce,uint64 expires_at)";
const TRANSFER_TYPE =
  "Transfer(address account,address toAccount,uint32 asset,int128 amount,bytes32 memoHead,bytes32 memoTail)";
const TRANSFER_TRANSACTION_TYPE = `Transaction(address signer,NonceGapless nonce,Transfer action)${NONCE_GAPLESS_TYPE}${TRANSFER_TYPE}`;
const BUILDER_FEE_CAP_TYPE = "BuilderFeeCap(int64 perpBps,int64 spotBps)";
const KEY_CHANGE_BIND_TYPE =
  "KeyChangeBind(uint8 scope,BuilderFeeCap builderFeeCap,uint8 nonceMode,Statement[] statements)";
const SET_INSTRUCTION_KEY_TYPE =
  "SetInstructionKey(address account,address instructionKey,KeyChangeBind change)";
const STATEMENT_TYPE = "Statement(string label,string value)";
const BIND_TRANSACTION_TYPE = `Transaction(address signer,NonceGapless nonce,SetInstructionKey action)${BUILDER_FEE_CAP_TYPE}${KEY_CHANGE_BIND_TYPE}${NONCE_GAPLESS_TYPE}${SET_INSTRUCTION_KEY_TYPE}${STATEMENT_TYPE}`;

/** Longest a gapless nonce may be dated ahead: Atlas refuses anything further. */
const MAX_EXPIRY_SECONDS = 14 * 24 * 60 * 60;
/** The bind is submitted right after it is signed, so it gets a day. */
const MAX_BIND_EXPIRY_SECONDS = 24 * 60 * 60;
/** A new wallet's owner slot starts at 0, so the bind that opens it carries 1. */
const BIND_NONCE = 1n;
const INSTRUCTION_KEY_SCOPE_REDUCE_ONLY = 2n;
const NONCE_MODE_GAPLESS = 0n;
const TERMS_LABEL = "Atlas Terms of Use";
const TERMS_VALUE = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+ 0x[0-9a-f]{64}$/;

/** Atlas transfer as encoded by the payload builder (decoded `AtlasTransfer` plus the header's signer, nonce and expiry). */
export interface AtlasTransfer {
  signer: string;
  /** Gapless owner nonce of the depository's wallet. */
  nonce: string;
  /** Unix seconds after which Atlas no longer books the transfer. */
  expiresAt: string;
  fromAccountAddress: string;
  toAccountAddress: string;
  assetId: string;
  /** Amount × 10^12, the fixed signing scale of every Atlas asset. */
  amount: string;
  memoHead: string;
  memoTail: string;
}

/** One line the owner accepts with a bind. */
interface AtlasStatement {
  label: string;
  value: string;
}

/** The caller-chosen fields of the wallet-opening bind. */
interface AtlasBind {
  /** Unix seconds after which Atlas no longer accepts the bind. */
  expiresAt: string;
  /** The terms in force (`<id>@<version> 0x<contentHash>`), then `Request: enableTrading`. */
  statements: AtlasStatement[];
}

/** `js_params` passed by the Lit Action invoker. */
interface AtlasActionParams {
  /** PKP identifier whose private key the action reconstructs inside the TEE. */
  pkpId: string;
  /** `"wallet"` to return the derived address; `"sign"` to sign the attested transfer; `"onboard"` to sign the wallet-opening bind. */
  action: "wallet" | "sign" | "onboard" | string;
  /** Original withdraw request fields. Required for `action="sign"`. */
  withdrawRequest?: WithdrawRequest;
  /** Oracle attestation containing the hash to sign. Required for `action="sign"`. */
  attestation?: WithdrawRequestAttestation;
  /** Transfer the attested hash commits to. Required for `action="sign"`. */
  transfer?: AtlasTransfer;
  /** Expiry and statements of the bind. Required for `action="onboard"`. */
  bind?: AtlasBind;
}

/** Result returned for `action="wallet"`. */
interface AtlasWalletResult {
  vmType: "atlas-vm";
  /** EIP-55-checksummed EVM address derived from the PKP; the Atlas Main account address. */
  address: string;
}

/** Result returned for `action="sign"`. */
interface AtlasSignResult extends AtlasWalletResult {
  /** keccak256(abi.encode(withdrawRequest)) as a 0x-prefixed hex string. */
  withdrawRequestHash: string;
  /** The single attested hash: the Atlas transferId. */
  results: Array<{
    hash: string;
    /** secp256k1 signature in Atlas order r+s+v (v = 0 or 1), 65 bytes hex. */
    signature: string;
  }>;
}

/** Result returned for `action="onboard"`. */
interface AtlasOnboardResult extends AtlasWalletResult {
  /** The digest of the bind. */
  results: Array<{
    hash: string;
    /** secp256k1 signature in Atlas order r+s+v (v = 0 or 1), 65 bytes hex. */
    signature: string;
  }>;
}

/** Derive the Atlas VM secp256k1 private key as hex from the PKP private key. */
async function deriveAtlasPrivateKeyHex(pkpPrivateKeyHex: string): Promise<string> {
  return bytesToHex(await deriveKey(pkpPrivateKeyHex, "atlas-vm"));
}

/** Sign a 32-byte digest with secp256k1, returning r+s+v with Atlas's raw recovery id (v=0/1). */
function signDigest(messageHash: Uint8Array, privateKeyHex: string): string {
  const recovered = secpSign(messageHash, hexToBytes(`0x${privateKeyHex}`)).toBytes("recovered");
  const signature = new Uint8Array(65);
  signature.set(recovered.slice(1), 0);
  signature[64] = recovered[0];
  return `0x${bytesToHex(signature)}`;
}

/** Left-pad a 20-byte address into an ABI word. */
function addressWord(address: string, field: string): Uint8Array {
  return concatBytes(new Uint8Array(12), expectLength(hexToBytes(address, field), 20, field));
}

/** Compute the Atlas transaction domain separator of a deployment. */
function atlasDomainSeparator(domain: AtlasDomain): Uint8Array {
  return keccak(
    concatBytes(
      keccak(encoder.encode(EIP712_DOMAIN_TYPE)),
      keccak(encoder.encode(ATLAS_DOMAIN_NAME)),
      keccak(encoder.encode(ATLAS_DOMAIN_VERSION)),
      quantityToWord(domain.chainId, "ATLAS_DOMAIN.chainId"),
      expectLength(hexToBytes(domain.salt, "ATLAS_DOMAIN.salt"), 32, "ATLAS_DOMAIN.salt"),
    ),
  );
}

/** Hash a type string or a `string` field the way EIP-712 does. */
function hashText(text: string): Uint8Array {
  return keccak(encoder.encode(text));
}

/** Parse a gapless expiry and require it to be ahead of now by at most `maxSeconds`. */
function parseExpiry(value: string, maxSeconds: number, field: string): bigint {
  const expiresAt = parseQuantity(value, field);
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (expiresAt <= now) {
    throw new Error(`${field} has passed`);
  }
  if (expiresAt > now + BigInt(maxSeconds)) {
    throw new Error(`${field} is more than ${maxSeconds} seconds ahead`);
  }
  return expiresAt;
}

/** Compute the digest Atlas verifies for a gapless transaction of the given type. */
function atlasTransactionDigest(
  domain: AtlasDomain,
  transactionType: string,
  signer: string,
  nonce: bigint,
  expiresAt: bigint,
  actionHash: Uint8Array,
): Uint8Array {
  if (nonce >= 1n << 64n) {
    throw new Error("nonce does not fit uint64");
  }
  if (expiresAt >= 1n << 64n) {
    throw new Error("expiresAt does not fit uint64");
  }
  const structHash = keccak(
    concatBytes(
      hashText(transactionType),
      addressWord(signer, "signer"),
      keccak(
        concatBytes(
          hashText(NONCE_GAPLESS_TYPE),
          quantityToWord(nonce, "nonce"),
          quantityToWord(expiresAt, "expiresAt"),
        ),
      ),
      actionHash,
    ),
  );
  return keccak(
    concatBytes(new Uint8Array([0x19, 0x01]), atlasDomainSeparator(domain), structHash),
  );
}

/** Compute the transferId Atlas assigns to a signed transfer under a domain. */
export function atlasTransferDigest(domain: AtlasDomain, transfer: AtlasTransfer): Uint8Array {
  const signedAmount = BigInt(transfer.amount);
  if (signedAmount <= 0n || signedAmount >= 1n << 127n) {
    throw new Error("transfer.amount does not fit int128");
  }
  const assetId = BigInt(transfer.assetId);
  if (assetId >= 1n << 32n) {
    throw new Error("transfer.assetId does not fit uint32");
  }

  const actionHash = keccak(
    concatBytes(
      keccak(encoder.encode(TRANSFER_TYPE)),
      addressWord(transfer.fromAccountAddress, "transfer.fromAccountAddress"),
      addressWord(transfer.toAccountAddress, "transfer.toAccountAddress"),
      quantityToWord(assetId, "transfer.assetId"),
      quantityToWord(signedAmount, "transfer.amount"),
      expectLength(hexToBytes(transfer.memoHead, "transfer.memoHead"), 32, "transfer.memoHead"),
      expectLength(hexToBytes(transfer.memoTail, "transfer.memoTail"), 32, "transfer.memoTail"),
    ),
  );
  return atlasTransactionDigest(
    domain,
    TRANSFER_TRANSACTION_TYPE,
    transfer.signer,
    parseQuantity(transfer.nonce, "transfer.nonce"),
    parseQuantity(transfer.expiresAt, "transfer.expiresAt"),
    actionHash,
  );
}

/**
 * Compute the digest of the bind that opens an account's wallet: the account binds its own
 * key reduce-only with no Builder Fee, so the signature grants nothing the key lacks.
 */
function atlasBindDigest(
  domain: AtlasDomain,
  account: string,
  expiresAt: bigint,
  statements: AtlasStatement[],
): Uint8Array {
  const statementsHash = keccak(
    concatBytes(
      ...statements.map(({ label, value }) =>
        keccak(concatBytes(hashText(STATEMENT_TYPE), hashText(label), hashText(value))),
      ),
    ),
  );
  const builderFeeCapHash = keccak(
    concatBytes(
      hashText(BUILDER_FEE_CAP_TYPE),
      quantityToWord(0n, "perpBps"),
      quantityToWord(0n, "spotBps"),
    ),
  );
  const changeHash = keccak(
    concatBytes(
      hashText(`${KEY_CHANGE_BIND_TYPE}${BUILDER_FEE_CAP_TYPE}${STATEMENT_TYPE}`),
      quantityToWord(INSTRUCTION_KEY_SCOPE_REDUCE_ONLY, "scope"),
      builderFeeCapHash,
      quantityToWord(NONCE_MODE_GAPLESS, "nonceMode"),
      statementsHash,
    ),
  );
  const actionHash = keccak(
    concatBytes(
      hashText(
        `${SET_INSTRUCTION_KEY_TYPE}${BUILDER_FEE_CAP_TYPE}${KEY_CHANGE_BIND_TYPE}${STATEMENT_TYPE}`,
      ),
      addressWord(account, "account"),
      addressWord(account, "account"),
      changeHash,
    ),
  );
  return atlasTransactionDigest(
    domain,
    BIND_TRANSACTION_TYPE,
    account,
    BIND_NONCE,
    expiresAt,
    actionHash,
  );
}

/** Lit Action entrypoint for wallet lookup, attestation-gated Atlas transfer signing and onboarding. */
export async function main({
  pkpId,
  action,
  withdrawRequest,
  attestation,
  transfer,
  bind,
}: AtlasActionParams): Promise<AtlasWalletResult | AtlasSignResult | AtlasOnboardResult> {
  const pkpPrivateKey = await Lit.Actions.getPrivateKey({ pkpId });
  const atlasPrivateKey = await deriveAtlasPrivateKeyHex(pkpPrivateKey);
  const address = addr.fromPrivateKey(`0x${atlasPrivateKey}`);

  if (action === "wallet") {
    return {
      vmType: "atlas-vm",
      address,
    };
  }

  if (action === "sign") {
    if (!ATLAS_DOMAIN) {
      throw new Error("Atlas is not configured for this environment");
    }
    if (!withdrawRequest) {
      throw new Error("withdrawRequest is required");
    }
    if (!attestation) {
      throw new Error("attestation is required");
    }
    if (!transfer) {
      throw new Error("transfer is required");
    }

    const { withdrawRequestHash, hashesToSign } = verifyWithdrawRequestAttestation(
      withdrawRequest,
      attestation,
      ALLOCATOR_ADDRESS,
      HUB_EVM_CHAIN_ID,
      ALLOWED_ORACLES,
      ORACLE_SIGNATURE_THRESHOLD,
    );
    if (hashesToSign.length !== 1) {
      throw new Error(`expected one attested hash, got ${hashesToSign.length}`);
    }
    if (transfer.signer.toLowerCase() !== address.toLowerCase()) {
      throw new Error("transfer signer is not this depository");
    }
    // The key is the account's full authority, so it signs nothing but its own transfers
    if (transfer.fromAccountAddress.toLowerCase() !== address.toLowerCase()) {
      throw new Error("transfer is not from this depository");
    }
    // The oracle reads the memo tail of a booked transfer as the nonce it took
    if (
      bytesToBigInt(hexToBytes(transfer.memoTail, "transfer.memoTail")) !==
      parseQuantity(transfer.nonce, "transfer.nonce")
    ) {
      throw new Error("transfer memoTail is not its nonce");
    }
    parseExpiry(transfer.expiresAt, MAX_EXPIRY_SECONDS, "transfer.expiresAt");
    const digest = atlasTransferDigest(ATLAS_DOMAIN, transfer);
    if (!equalBytes(digest, hashesToSign[0])) {
      throw new Error("attested hash is not this transfer under the configured domain");
    }

    return {
      vmType: "atlas-vm",
      address,
      withdrawRequestHash: `0x${bytesToHex(withdrawRequestHash)}`,
      results: [
        {
          hash: `0x${bytesToHex(digest)}`,
          signature: signDigest(digest, atlasPrivateKey),
        },
      ],
    };
  }

  if (action === "onboard") {
    if (!ATLAS_DOMAIN) {
      throw new Error("Atlas is not configured for this environment");
    }
    if (!bind) {
      throw new Error("bind is required");
    }
    const [terms, request, ...rest] = bind.statements;
    if (
      rest.length !== 0 ||
      terms?.label !== TERMS_LABEL ||
      !TERMS_VALUE.test(terms.value) ||
      request?.label !== "Request" ||
      request.value !== "enableTrading"
    ) {
      throw new Error("bind statements must be the terms in force and the enableTrading request");
    }
    const digest = atlasBindDigest(
      ATLAS_DOMAIN,
      address,
      parseExpiry(bind.expiresAt, MAX_BIND_EXPIRY_SECONDS, "bind.expiresAt"),
      [terms, request],
    );

    return {
      vmType: "atlas-vm",
      address,
      results: [
        {
          hash: `0x${bytesToHex(digest)}`,
          signature: signDigest(digest, atlasPrivateKey),
        },
      ],
    };
  }

  throw new Error(`unknown action: ${action}`);
}
