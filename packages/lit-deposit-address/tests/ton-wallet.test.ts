import { Address as TonAddress, Cell as TonCell, loadMessageRelaxed } from "@ton/core";
import { WalletContractV5R1 } from "@ton/ton";
import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import {
  deriveAccount,
  deriveWallet,
  signTransactionsWithWallet,
} from "../src/derivation/index.js";
import {
  TON_NETWORK_GLOBAL_ID,
  walletAddressHash,
  walletIdV5R1,
} from "../src/common/ton/wallet.js";

const ROOT_KEY = `0x${"11".repeat(32)}`;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

describe("ton wallet v5r1 helpers", () => {
  it("walletId matches @ton/ton for mainnet basechain", () => {
    const pub = Buffer.alloc(32, 0x11);
    const wallet = WalletContractV5R1.create({ workchain: 0, publicKey: pub });
    // wallet_id is the third field in the data cell (1 + 32 bits before it).
    const slice = wallet.init.data.beginParse();
    slice.loadUint(1);
    slice.loadUint(32);
    const expectedWalletId = slice.loadInt(32);
    expect(walletIdV5R1(TON_NETWORK_GLOBAL_ID)).toBe(expectedWalletId >>> 0);
  });

  it("derives the same deposit address as @ton/ton WalletContractV5R1", async () => {
    for (const indexes of [[0], [1, 2], [7, 0, 123]]) {
      const wallet = await deriveWallet(ROOT_KEY, "ton-vm", indexes);
      const pub = Buffer.from(wallet.publicKey.slice(2), "hex");
      const expected = WalletContractV5R1.create({ workchain: 0, publicKey: pub });
      expect(wallet.address).toBe(expected.address.toRawString());
      expect(`0:${toHex(walletAddressHash(pub))}`).toBe(expected.address.toRawString());
    }
  });

  it("account publicKey is the raw ed25519 key as 0x-hex", async () => {
    const account = await deriveAccount(ROOT_KEY, "ton-vm");
    expect(account.vmType).toBe("ton-vm");
    expect(account.accountPath).toBe("m/44'/607'/0'/0");
    expect(account.publicKey).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("ton wallet v5r1 signing", () => {
  const depository = `0:${"22".repeat(32)}`;
  const orderId = `0x${"ab".repeat(32)}`;
  const depositor = `0:${"33".repeat(32)}`;
  const comment = `${orderId}|depositor=${depositor}|`;

  async function sign(seqno: number) {
    const wallet = await deriveWallet(ROOT_KEY, "ton-vm", [0]);
    const { signedTransactions } = await signTransactionsWithWallet(
      ROOT_KEY,
      "ton-vm",
      [0],
      [
        {
          to: depository,
          amount: "1500000000",
          comment,
          bounce: false,
          seqno,
          validUntil: 2_000_000_000,
          sendMode: 3,
        },
      ],
    );
    return { wallet, signed: signedTransactions[0] };
  }

  it("produces a signature valid under standard ed25519 + a decodable message", async () => {
    const { wallet, signed } = await sign(0);
    const pub = Buffer.from(wallet.publicKey.slice(2), "hex");

    // The signature verifies under RFC-8032 ed25519 (what TON check_signature does).
    const sig = Buffer.from(signed.signature.slice(2), "hex");
    const hash = Buffer.from(signed.signingHash.slice(2), "hex");
    expect(ed25519.verify(sig, hash, pub)).toBe(true);

    // The external message parses with @ton/core and addresses the wallet.
    const external = TonCell.fromBoc(Buffer.from(signed.externalMessage, "base64"))[0];
    const slice = external.beginParse();
    expect(slice.loadUint(2)).toBe(0b10); // ext_in_msg_info$10
    slice.loadUint(2); // src addr_none
    const dest = slice.loadAddress();
    expect(dest.toRawString()).toBe(wallet.address);
    slice.loadCoins(); // import_fee
    // StateInit present on the deploy (seqno 0).
    expect(slice.loadBit()).toBe(true);
    slice.loadBit();
    const stateInit = slice.loadRef();
    expect(stateInit.hash().toString("hex")).toBe(wallet.address.split(":")[1]);

    // Body: signed request → inner action list → the relaxed transfer.
    const body = slice.loadRef().beginParse();
    expect(body.loadUint(32)).toBe(0x7369676e); // auth_signed_external
    body.loadUint(32); // wallet_id
    body.loadUint(32); // valid_until (max for seqno 0)
    expect(body.loadUint(32)).toBe(0); // seqno
    expect(body.loadBit()).toBe(true); // out-list ref present
    const outList = body.loadRef().beginParse();
    outList.loadRef(); // empty tail
    expect(outList.loadUint(32)).toBe(0x0ec3c86d); // action_send_msg
    expect(outList.loadUint(8)).toBe(3); // mode (1 | IGNORE_ERRORS)
    const transfer = loadMessageRelaxed(outList.loadRef().beginParse());
    expect(transfer.info.type).toBe("internal");
    if (transfer.info.type === "internal") {
      expect(transfer.info.bounce).toBe(false);
      expect(transfer.info.dest.toRawString()).toBe(depository);
      expect(transfer.info.value.coins).toBe(1500000000n);
    }
    const text = transfer.body.beginParse();
    expect(text.loadUint(32)).toBe(0); // text comment opcode
    expect(text.loadStringTail()).toBe(comment);
  });

  it("omits the StateInit once the wallet is deployed (seqno > 0)", async () => {
    const { signed } = await sign(5);
    const external = TonCell.fromBoc(Buffer.from(signed.externalMessage, "base64"))[0];
    const slice = external.beginParse();
    slice.loadUint(2);
    slice.loadUint(2);
    slice.loadAddress();
    slice.loadCoins();
    expect(slice.loadBit()).toBe(false); // no StateInit
  });

  it("accepts a friendly depositor address in the comment", async () => {
    const friendly = new TonAddress(0, Buffer.from("33".repeat(32), "hex")).toString({
      urlSafe: true,
      bounceable: true,
    });
    const wallet = await deriveWallet(ROOT_KEY, "ton-vm", [0]);
    const { signedTransactions } = await signTransactionsWithWallet(
      ROOT_KEY,
      "ton-vm",
      [0],
      [
        {
          to: depository,
          amount: "1500000000",
          comment: `${orderId}|depositor=${friendly}|`,
          bounce: false,
          seqno: 1,
          validUntil: 2_000_000_000,
          sendMode: 3,
        },
      ],
    );
    expect(signedTransactions[0].externalMessage.length).toBeGreaterThan(0);
    expect(wallet.address.startsWith("0:")).toBe(true);
  });
});
