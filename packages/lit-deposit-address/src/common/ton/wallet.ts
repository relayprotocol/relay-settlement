import { Builder, Cell, beginCell, bocToCell } from "./cell.js";
import { hexToBytes } from "../bytes.js";

/**
 * TON Wallet V5R1 (`v5r1`) helpers: deterministic address derivation from an
 * Ed25519 public key, plus construction of the signed external-message body
 * the wallet verifies. Layouts mirror the canonical contract
 * (ton-blockchain/wallet-contract-v5) and `@ton/ton`'s `WalletContractV5R1`;
 * parity is asserted in `tests/ton-wallet.test.ts`.
 *
 * Older wallet versions (v3/v4) are deprecated, so deposit wallets are always
 * Wallet V5R1.
 */

/**
 * Compiled Wallet V5R1 code, as published in
 * ton-blockchain/wallet-contract-v5 `build/wallet_v5.compiled.json` and
 * embedded in `@ton/ton`. The code cell is a protocol constant; the deposit
 * address is the hash of the StateInit built from this code plus the
 * wallet's data cell.
 */
const CODE_BOC_HEX =
  "b5ee9c7241021401000281000114ff00f4a413f4bcf2c80b01020120020d020148030402dcd020d749c120915b8f6320d70b1f2082106578746ebd21821073696e74bdb0925f03e082106578746eba8eb48020d72101d074d721fa4030fa44f828fa443058bd915be0ed44d0810141d721f4058307f40e6fa1319130e18040d721707fdb3ce03120d749810280b99130e070e2100f020120050c020120060902016e07080019adce76a2684020eb90eb85ffc00019af1df6a2684010eb90eb858fc00201480a0b0017b325fb51341c75c875c2c7e00011b262fb513435c280200019be5f0f6a2684080a0eb90fa02c0102f20e011e20d70b1f82107369676ebaf2e08a7f0f01e68ef0eda2edfb218308d722028308d723208020d721d31fd31fd31fed44d0d200d31f20d31fd3ffd70a000af90140ccf9109a28945f0adb31e1f2c087df02b35007b0f2d0845125baf2e0855036baf2e086f823bbf2d0882292f800de01a47fc8ca00cb1f01cf16c9ed542092f80fde70db3cd81003f6eda2edfb02f404216e926c218e4c0221d73930709421c700b38e2d01d72820761e436c20d749c008f2e09320d74ac002f2e09320d71d06c712c2005230b0f2d089d74cd7393001a4e86c128407bbf2e093d74ac000f2e093ed55e2d20001c000915be0ebd72c08142091709601d72c081c12e25210b1e30f20d74a111213009601fa4001fa44f828fa443058baf2e091ed44d0810141d718f405049d7fc8ca0040048307f453f2e08b8e14038307f45bf2e08c22d70a00216e01b3b0f2d090e2c85003cf1612f400c9ed54007230d72c08248e2d21f2e092d200ed44d0d2005113baf2d08f54503091319c01810140d721d70a00f2e08ee2c8ca0058cf16c9ed5493f2c08de20010935bdb31e1d74cd0b4d6c35e";

/** Mainnet TON network global id (used in the Wallet V5R1 `wallet_id`). */
export const TON_NETWORK_GLOBAL_ID = -239;

/** Wallet V5R1 authentication opcode for externally-signed requests. */
const AUTH_SIGNED_EXTERNAL = 0x7369676e;

/** Out-action tag for `action_send_msg`. */
const ACTION_SEND_MSG = 0x0ec3c86d;

/** `SendMode.IGNORE_ERRORS`, required on actions of external messages. */
const SEND_MODE_IGNORE_ERRORS = 2;

/** `SendMode` bits that send more than the explicit message value. */
const SEND_MODE_CARRY_ALL = 0b1100_0000; // CARRY_ALL_REMAINING_BALANCE | _INCOMING

let cachedCodeCell: Cell | undefined;
function codeCell(): Cell {
  if (!cachedCodeCell) {
    cachedCodeCell = bocToCell(hexToBytes(CODE_BOC_HEX, "ton wallet code"));
  }
  return cachedCodeCell;
}

/**
 * Compute the Wallet V5R1 `wallet_id` (a signed 32-bit value, returned as the
 * unsigned bit pattern) for a basechain, subwallet-0 wallet on the given
 * network. Matches `@ton/ton`'s `storeWalletIdV5R1` for the client context
 * `{ workchain: 0, walletVersion: 'v5r1', subwalletNumber: 0 }`.
 */
export function walletIdV5R1(networkGlobalId: number, workchain = 0, subwallet = 0): number {
  // Client context packed into 32 bits: 1 | int8 workchain | uint8 version(0) | uint15 subwallet.
  const context = ((1 << 31) | ((workchain & 0xff) << 23) | (subwallet & 0x7fff)) >>> 0;
  return ((networkGlobalId ^ context) >>> 0) as number;
}

/** Build the Wallet V5R1 data (storage) cell for a given public key. */
function dataCell(publicKey: Uint8Array, networkGlobalId: number): Cell {
  if (publicKey.length !== 32) {
    throw new Error("ton public key must be 32 bytes");
  }
  return beginCell()
    .storeBit(1) // is_signature_auth_allowed
    .storeUint(0, 32) // seqno
    .storeUint(walletIdV5R1(networkGlobalId), 32) // wallet_id
    .storeBuffer(publicKey)
    .storeBit(0) // empty extensions dict
    .endCell();
}

/** Build the Wallet V5R1 StateInit cell for a given public key. */
export function walletStateInit(
  publicKey: Uint8Array,
  networkGlobalId = TON_NETWORK_GLOBAL_ID,
): Cell {
  return beginCell()
    .storeBit(0) // no split_depth
    .storeBit(0) // no special
    .storeMaybeRef(codeCell())
    .storeMaybeRef(dataCell(publicKey, networkGlobalId))
    .storeBit(0) // empty library dict
    .endCell();
}

/** The 32-byte basechain account hash (deposit address) for a public key. */
export function walletAddressHash(
  publicKey: Uint8Array,
  networkGlobalId = TON_NETWORK_GLOBAL_ID,
): Uint8Array {
  return walletStateInit(publicKey, networkGlobalId).hash();
}

/** Build a text-comment body cell (opcode 0 + snake-encoded UTF-8 string). */
export function commentBody(text: string): Cell {
  const builder = beginCell().storeUint(0, 32);
  writeSnakeString(builder, new TextEncoder().encode(text));
  return builder.endCell();
}

/** @ton/core-compatible snake string writer (spills overflow into refs). */
function writeSnakeString(builder: Builder, bytes: Uint8Array): void {
  const available = Math.floor(builder.availableBits / 8);
  builder.storeBuffer(bytes.subarray(0, available));
  const rest = bytes.subarray(available);
  if (rest.length > 0) {
    const child = beginCell();
    writeSnakeString(child, rest);
    builder.storeRef(child.endCell());
  }
}

/** Build an internal `MessageRelaxed` carrying native TON + a body cell. */
export function internalMessage(params: {
  destHash: Uint8Array;
  amount: bigint;
  bounce: boolean;
  body: Cell;
}): Cell {
  return beginCell()
    .storeBit(0) // int_msg_info$0
    .storeBit(1) // ihr_disabled
    .storeBit(params.bounce)
    .storeBit(0) // bounced
    .storeAddressNone() // src (filled in by the validator)
    .storeAddressInt(0, params.destHash)
    .storeCoins(params.amount)
    .storeBit(0) // empty extra-currency dict
    .storeCoins(0) // ihr_fee
    .storeCoins(0) // fwd_fee
    .storeUint(0, 64) // created_lt
    .storeUint(0, 32) // created_at
    .storeBit(0) // no StateInit on the inner message
    .storeBit(1) // body stored as a ref
    .storeRef(params.body)
    .endCell();
}

/**
 * Build the Wallet V5R1 signed-request body (without the trailing signature).
 * The cell hash of this builder is what the wallet's `check_signature`
 * verifies, so the signature must be computed over `endCell().hash()`.
 */
export function signingRequest(params: {
  walletId: number;
  seqno: number;
  validUntil: number;
  sendMode: number;
  message: Cell;
}): Builder {
  const mode = (params.sendMode | SEND_MODE_IGNORE_ERRORS) & 0xff;
  const outList = beginCell()
    .storeRef(beginCell().endCell()) // empty tail of the action list
    .storeUint(ACTION_SEND_MSG, 32)
    .storeUint(mode, 8)
    .storeRef(params.message)
    .endCell();

  const builder = beginCell().storeUint(AUTH_SIGNED_EXTERNAL, 32).storeUint(params.walletId, 32);
  if (params.seqno === 0) {
    builder.storeUint(0xffff_ffff, 32); // valid_until = max for the deploy spend
  } else {
    builder.storeUint(params.validUntil, 32);
  }
  builder.storeUint(params.seqno, 32);
  // storeOutListExtendedV5R1: basic actions ref present, no extended actions.
  builder.storeBit(1).storeRef(outList).storeBit(0);
  return builder;
}

/** Append the 64-byte signature to a signed-request body (tail layout). */
export function signedRequestWithSignature(request: Builder, signature: Uint8Array): Cell {
  return beginCell().storeBuilder(request).storeBuffer(signature).endCell();
}

/** Build the external-in message addressed to the deposit wallet. */
export function externalMessage(params: {
  addressHash: Uint8Array;
  stateInit: Cell | null;
  body: Cell;
}): Cell {
  const builder = beginCell()
    .storeUint(0b10, 2) // ext_in_msg_info$10
    .storeAddressNone() // src
    .storeAddressInt(0, params.addressHash)
    .storeCoins(0); // import_fee
  if (params.stateInit) {
    builder.storeBit(1).storeBit(1).storeRef(params.stateInit); // Maybe + Either(ref)
  } else {
    builder.storeBit(0);
  }
  builder.storeBit(1).storeRef(params.body); // body: Either(ref)
  return builder.endCell();
}

/** True when a send mode would deliver more than the explicit message value. */
export function sendModeCarriesAll(sendMode: number): boolean {
  return (sendMode & SEND_MODE_CARRY_ALL) !== 0;
}
