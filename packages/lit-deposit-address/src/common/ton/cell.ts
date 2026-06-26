import { sha256 } from "https://cdn.jsdelivr.net/npm/@noble/hashes@2.0.1/sha2.js/+esm";

/**
 * Minimal TON cell implementation: a {@link Builder} for assembling cells, a
 * {@link Cell} with the standard representation hash + depth, and BOC
 * (bag-of-cells) parse/serialize. Hand-rolled (rather than importing
 * `@ton/core`) so the Lit Action bundle stays dependency-light and resolves
 * cleanly inside the TEE. The implementation mirrors `@ton/core` byte-for-byte
 * for the ordinary, level-0 cells this package builds; parity is asserted in
 * `tests/ton-cell.test.ts`.
 */

const MAX_CELL_BITS = 1023;
const MAX_CELL_REFS = 4;

/** Assembles an ordinary TON cell out of bits and child-cell references. */
export class Builder {
  readonly bits: boolean[] = [];
  readonly refs: Cell[] = [];

  /** Bits still available before the 1023-bit cell limit is hit. */
  get availableBits(): number {
    return MAX_CELL_BITS - this.bits.length;
  }

  storeBit(value: boolean | number): this {
    this.bits.push(Boolean(value));
    return this;
  }

  /** Store an unsigned integer big-endian across `n` bits. */
  storeUint(value: bigint | number, n: number): this {
    const v = BigInt(value);
    if (v < 0n) {
      throw new Error("storeUint requires a non-negative value");
    }
    if (n < 0 || v >= 1n << BigInt(n)) {
      throw new Error(`value ${v} does not fit in ${n} bits`);
    }
    for (let i = n - 1; i >= 0; i--) {
      this.bits.push(((v >> BigInt(i)) & 1n) === 1n);
    }
    return this;
  }

  /** Store a two's-complement signed integer across `n` bits. */
  storeInt(value: bigint | number, n: number): this {
    let v = BigInt(value);
    const limit = 1n << BigInt(n - 1);
    if (v < -limit || v >= limit) {
      throw new Error(`value ${v} does not fit in signed ${n} bits`);
    }
    if (v < 0n) {
      v += 1n << BigInt(n);
    }
    return this.storeUint(v, n);
  }

  /** Append every byte of `bytes` as 8 bits (MSB first). */
  storeBuffer(bytes: Uint8Array): this {
    for (const byte of bytes) {
      for (let i = 7; i >= 0; i--) {
        this.bits.push(((byte >> i) & 1) === 1);
      }
    }
    return this;
  }

  /** Store a TON `Grams`/`VarUInteger16` coin amount. */
  storeCoins(amount: bigint | number): this {
    const v = BigInt(amount);
    if (v < 0n) {
      throw new Error("storeCoins requires a non-negative value");
    }
    if (v === 0n) {
      return this.storeUint(0, 4);
    }
    let byteLength = 0;
    for (let t = v; t > 0n; t >>= 8n) {
      byteLength++;
    }
    if (byteLength > 15) {
      throw new Error("coin amount exceeds VarUInteger16 range");
    }
    this.storeUint(byteLength, 4);
    return this.storeUint(v, byteLength * 8);
  }

  /** Store a `MsgAddressInt` (`addr_std`, no anycast). */
  storeAddressInt(workchain: number, hash: Uint8Array): this {
    if (hash.length !== 32) {
      throw new Error("address hash must be 32 bytes");
    }
    this.storeUint(0b10, 2);
    this.storeBit(0);
    this.storeInt(workchain, 8);
    return this.storeBuffer(hash);
  }

  /** Store an `addr_none` (empty address). */
  storeAddressNone(): this {
    return this.storeUint(0, 2);
  }

  storeRef(cell: Cell): this {
    if (this.refs.length >= MAX_CELL_REFS) {
      throw new Error("cell already has the maximum of 4 refs");
    }
    this.refs.push(cell);
    return this;
  }

  /** Store an optional ref as `Maybe ^Cell`. */
  storeMaybeRef(cell: Cell | null): this {
    if (cell) {
      this.storeBit(1);
      return this.storeRef(cell);
    }
    return this.storeBit(0);
  }

  /** Append another builder's bits and refs (mirrors `storeBuilder`). */
  storeBuilder(other: Builder): this {
    for (const bit of other.bits) {
      this.bits.push(bit);
    }
    for (const ref of other.refs) {
      this.storeRef(ref);
    }
    return this;
  }

  endCell(): Cell {
    return new Cell(this.bits.slice(), this.refs.slice());
  }
}

/** Convenience factory mirroring `@ton/core`'s `beginCell()`. */
export function beginCell(): Builder {
  return new Builder();
}

/** An immutable ordinary TON cell. */
export class Cell {
  private cachedHash?: Uint8Array;
  private cachedDepth?: number;

  constructor(
    readonly bits: boolean[],
    readonly refs: Cell[],
  ) {
    if (bits.length > MAX_CELL_BITS) {
      throw new Error(`cell exceeds ${MAX_CELL_BITS} bits`);
    }
    if (refs.length > MAX_CELL_REFS) {
      throw new Error(`cell exceeds ${MAX_CELL_REFS} refs`);
    }
  }

  /** Byte-packed data with TON augmentation when not byte-aligned. */
  dataBytes(): Uint8Array {
    const byteLength = Math.ceil(this.bits.length / 8);
    const out = new Uint8Array(byteLength);
    const padded = this.bits.slice();
    if (padded.length % 8 !== 0) {
      padded.push(true);
      while (padded.length % 8 !== 0) {
        padded.push(false);
      }
    }
    for (let i = 0; i < padded.length; i++) {
      if (padded[i]) {
        out[i >> 3] |= 1 << (7 - (i % 8));
      }
    }
    return out;
  }

  /** First descriptor byte: refs + 8·exotic + 32·level (ordinary, level 0). */
  private d1(): number {
    return this.refs.length;
  }

  /** Second descriptor byte: ⌊bits/8⌋ + ⌈bits/8⌉. */
  private d2(): number {
    return Math.floor(this.bits.length / 8) + Math.ceil(this.bits.length / 8);
  }

  depth(): number {
    if (this.cachedDepth === undefined) {
      this.cachedDepth = this.refs.length
        ? 1 + Math.max(...this.refs.map((ref) => ref.depth()))
        : 0;
    }
    return this.cachedDepth;
  }

  hash(): Uint8Array {
    if (this.cachedHash) {
      return this.cachedHash;
    }
    const data = this.dataBytes();
    const parts: number[] = [this.d1(), this.d2(), ...data];
    for (const ref of this.refs) {
      const depth = ref.depth();
      parts.push((depth >> 8) & 0xff, depth & 0xff);
    }
    for (const ref of this.refs) {
      for (const byte of ref.hash()) {
        parts.push(byte);
      }
    }
    this.cachedHash = sha256(Uint8Array.from(parts));
    return this.cachedHash;
  }

  /** Serialize a single-root bag-of-cells (with crc32c). */
  toBoc(): Uint8Array {
    return cellToBoc(this);
  }
}

// ─── BOC serialization ──────────────────────────────────────────────────────

function uintToBytes(value: number, byteLength: number): number[] {
  const out: number[] = [];
  for (let i = byteLength - 1; i >= 0; i--) {
    out.push((value >> (8 * i)) & 0xff);
  }
  return out;
}

function byteWidth(value: number): number {
  let width = 1;
  while (value >= 1 << (8 * width)) {
    width++;
  }
  return width;
}

function cellToBoc(root: Cell): Uint8Array {
  // Topological order: parents strictly before children, each cell once.
  const visited = new Set<string>();
  const postorder: Cell[] = [];
  const hashHex = (cell: Cell) =>
    Array.from(cell.hash())
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  const walk = (cell: Cell): void => {
    const key = hashHex(cell);
    if (visited.has(key)) {
      return;
    }
    visited.add(key);
    for (const ref of cell.refs) {
      walk(ref);
    }
    postorder.push(cell);
  };
  walk(root);
  const ordered = postorder.reverse();

  const indexByHash = new Map<string, number>();
  ordered.forEach((cell, index) => indexByHash.set(hashHex(cell), index));

  const cellCount = ordered.length;
  const refSize = byteWidth(cellCount);

  const serializedCells: number[][] = ordered.map((cell) => {
    const data = cell.dataBytes();
    const d2 = Math.floor(cell.bits.length / 8) + Math.ceil(cell.bits.length / 8);
    const out: number[] = [cell.refs.length, d2];
    for (const byte of data) {
      out.push(byte);
    }
    for (const ref of cell.refs) {
      out.push(...uintToBytes(indexByHash.get(hashHex(ref))!, refSize));
    }
    return out;
  });

  const totalDataSize = serializedCells.reduce((sum, c) => sum + c.length, 0);
  const offBytes = byteWidth(totalDataSize);

  const out: number[] = [];
  out.push(0xb5, 0xee, 0x9c, 0x72); // magic
  out.push(0b0100_0000 | refSize); // has_crc32c flag + size
  out.push(offBytes);
  out.push(...uintToBytes(cellCount, refSize));
  out.push(...uintToBytes(1, refSize)); // root count
  out.push(...uintToBytes(0, refSize)); // absent
  out.push(...uintToBytes(totalDataSize, offBytes));
  out.push(...uintToBytes(0, refSize)); // root index 0
  for (const cell of serializedCells) {
    out.push(...cell);
  }
  const crc = crc32c(Uint8Array.from(out));
  out.push(crc & 0xff, (crc >> 8) & 0xff, (crc >> 16) & 0xff, (crc >> 24) & 0xff);
  return Uint8Array.from(out);
}

// ─── BOC parsing ────────────────────────────────────────────────────────────

/** Parse a single-root bag-of-cells into its root {@link Cell}. */
export function bocToCell(boc: Uint8Array): Cell {
  let offset = 0;
  const readByte = (): number => boc[offset++];
  const readUint = (n: number): number => {
    let value = 0;
    for (let i = 0; i < n; i++) {
      value = value * 256 + readByte();
    }
    return value;
  };

  const magic = readUint(4);
  if (magic !== 0xb5ee9c72) {
    throw new Error(`unsupported BOC magic 0x${magic.toString(16)}`);
  }
  const flags = readByte();
  const hasIdx = (flags & 0b1000_0000) !== 0;
  const hasCrc = (flags & 0b0100_0000) !== 0;
  const refSize = flags & 0b0000_0111;
  const offBytes = readByte();
  const cellCount = readUint(refSize);
  const rootCount = readUint(refSize);
  readUint(refSize); // absent
  readUint(offBytes); // total data size
  const roots: number[] = [];
  for (let i = 0; i < rootCount; i++) {
    roots.push(readUint(refSize));
  }
  if (hasIdx) {
    offset += cellCount * offBytes;
  }

  const rawCells: { bits: boolean[]; refs: number[] }[] = [];
  for (let i = 0; i < cellCount; i++) {
    const d1 = readByte();
    const d2 = readByte();
    const refCount = d1 & 0b0000_0111;
    const dataByteLength = Math.ceil(d2 / 2);
    const isAugmented = d2 % 2 !== 0;
    const dataBytes = boc.slice(offset, offset + dataByteLength);
    offset += dataByteLength;
    const bits: boolean[] = [];
    for (const byte of dataBytes) {
      for (let b = 7; b >= 0; b--) {
        bits.push(((byte >> b) & 1) === 1);
      }
    }
    if (isAugmented) {
      // Drop the augmentation: trailing 1 then any 0s back to the last 1 bit.
      let last = bits.length - 1;
      while (last >= 0 && !bits[last]) {
        last--;
      }
      bits.length = last; // also removes the augmentation 1 bit itself
    }
    const refs: number[] = [];
    for (let r = 0; r < refCount; r++) {
      refs.push(readUint(refSize));
    }
    rawCells.push({ bits, refs });
  }
  if (hasCrc) {
    offset += 4;
  }

  // Build bottom-up: refs always have a higher index than their parent.
  const built: Cell[] = new Array(cellCount);
  for (let i = cellCount - 1; i >= 0; i--) {
    const raw = rawCells[i];
    built[i] = new Cell(
      raw.bits,
      raw.refs.map((index) => built[index]),
    );
  }
  return built[roots[0]];
}

// ─── crc32c (Castagnoli) ────────────────────────────────────────────────────

const CRC32C_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0x82f6_3b78 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32c(bytes: Uint8Array): number {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc = (crc >>> 8) ^ CRC32C_TABLE[(crc ^ byte) & 0xff];
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}
