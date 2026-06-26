import {
  Address as TonAddress,
  beginCell as tonBeginCell,
  Cell as TonCell,
  internal as tonInternal,
  storeMessageRelaxed,
} from "@ton/core";
import { WalletContractV5R1 } from "@ton/ton";
import { describe, expect, it } from "vitest";
import { beginCell, bocToCell } from "../src/common/ton/cell.js";

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

describe("ton cell representation hash matches @ton/core", () => {
  it("hashes a simple bit/ref cell identically", () => {
    const child = beginCell().storeUint(0x1234, 16).endCell();
    const ours = beginCell().storeUint(1, 1).storeUint(0xdeadbeef, 32).storeRef(child).endCell();

    const tonChild = tonBeginCell().storeUint(0x1234, 16).endCell();
    const tonCell = tonBeginCell()
      .storeUint(1, 1)
      .storeUint(0xdeadbeef, 32)
      .storeRef(tonChild)
      .endCell();

    expect(toHex(ours.hash())).toBe(tonCell.hash().toString("hex"));
  });

  it("hashes coins, addresses and a text-comment message identically", () => {
    const hash = Buffer.alloc(32, 0xab);
    const comment = `0x${"11".repeat(32)}|depositor=0:${"22".repeat(32)}|`;

    const ourComment = beginCell().storeUint(0, 32);
    writeSnake(ourComment, new TextEncoder().encode(comment));
    const ourMsg = beginCell()
      .storeBit(0)
      .storeBit(1)
      .storeBit(0)
      .storeBit(0)
      .storeAddressNone()
      .storeAddressInt(0, hash)
      .storeCoins(123456789n)
      .storeBit(0)
      .storeCoins(0)
      .storeCoins(0)
      .storeUint(0, 64)
      .storeUint(0, 32)
      .storeBit(0)
      .storeMaybeRef(ourComment.endCell())
      .endCell();

    const tonMsg = tonBeginCell()
      .store(
        storeMessageRelaxed(
          tonInternal({
            to: new TonAddress(0, hash),
            value: 123456789n,
            bounce: false,
            body: tonBeginCell().storeUint(0, 32).storeStringTail(comment).endCell(),
          }),
        ),
      )
      .endCell();

    expect(toHex(ourMsg.hash())).toBe(tonMsg.hash().toString("hex"));
  });

  it("round-trips a BOC through @ton/core", () => {
    const inner = beginCell().storeUint(0xcafe, 16).endCell();
    const cell = beginCell().storeUint(0x7369676e, 32).storeRef(inner).endCell();

    const parsedByTon = TonCell.fromBoc(Buffer.from(cell.toBoc()))[0];
    expect(parsedByTon.hash().toString("hex")).toBe(toHex(cell.hash()));

    // And our parser reads @ton/core's BOC back to the same hash.
    const ours = bocToCell(parsedByTon.toBoc());
    expect(toHex(ours.hash())).toBe(toHex(cell.hash()));
  });

  it("loads the v5r1 code cell and matches the wallet StateInit address", () => {
    const pub = Buffer.alloc(32, 0x11);
    const expected = WalletContractV5R1.create({ workchain: 0, publicKey: pub });

    const codeCell = bocToCell(Buffer.from(expected.init.code.toBoc()));
    expect(toHex(codeCell.hash())).toBe(expected.init.code.hash().toString("hex"));
  });
});

// Mirrors @ton/core's snake string writer for test fixtures.
function writeSnake(builder: ReturnType<typeof beginCell>, bytes: Uint8Array): void {
  const avail = Math.floor(builder.availableBits / 8);
  const chunk = bytes.subarray(0, avail);
  builder.storeBuffer(chunk);
  const rest = bytes.subarray(avail);
  if (rest.length > 0) {
    const child = beginCell();
    writeSnake(child, rest);
    builder.storeRef(child.endCell());
  }
}
