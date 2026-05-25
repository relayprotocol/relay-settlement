import { sha256 } from "https://cdn.jsdelivr.net/npm/@noble/hashes@2.0.1/sha2.js/+esm";
import { encodeAddressToHex, normalizeAddressHex } from "../../../common/address.js";
import { hexToBytes } from "../../../common/bytes.js";
import { hash160 } from "../../../common/crypto.js";
import type {
  BitcoinVmTransaction,
  DepositAddressTrigger,
  DepositAddressTriggerAttestation,
} from "../../../common/types.js";

const BTC_NATIVE = encodeAddressToHex(
  "bc1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqmql8k8",
  "bitcoin-vm",
).toLowerCase();
const SIGHASH_ALL = 1;
const OP_RETURN = 0x6a;
const DEPOSITOR_RE = /\|depositor=([^|]+)(?=\|)/;
const LEGACY = 0xff;
const P2PKH = 0x00;
const P2SH = 0x05;

interface TxInput {
  txid: Uint8Array;
  index: number;
  sequence: number;
}

interface TxOutput {
  value: bigint;
  script: Uint8Array;
}

interface ParsedTx {
  version: number;
  inputs: TxInput[];
  outputs: TxOutput[];
  locktime: number;
}

class Reader {
  private offset = 0;
  constructor(private readonly bytes: Uint8Array) {}

  bytesN(length: number, label: string): Uint8Array {
    if (this.offset + length > this.bytes.length) {
      throw new Error(`bitcoin transaction truncated while reading ${label}`);
    }
    const out = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    return out;
  }

  u8(label: string): number {
    return this.bytesN(1, label)[0];
  }

  u32(label: string): number {
    const b = this.bytesN(4, label);
    return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
  }

  u64(label: string): bigint {
    const b = this.bytesN(8, label);
    let out = 0n;
    for (let i = 7; i >= 0; i--) {
      out = (out << 8n) | BigInt(b[i]);
    }
    return out;
  }

  varInt(label: string): number {
    const first = this.u8(label);
    if (first < 0xfd) {
      return first;
    }
    if (first === 0xfd) {
      const b = this.bytesN(2, label);
      return b[0] | (b[1] << 8);
    }
    if (first === 0xfe) {
      return this.u32(label);
    }
    const value = this.u64(label);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`${label} is too large`);
    }
    return Number(value);
  }

  end(): void {
    if (this.offset !== this.bytes.length) {
      throw new Error("bitcoin transaction has trailing bytes");
    }
  }
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function u32le(n: number): Uint8Array {
  return new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
}

function u64le(n: bigint): Uint8Array {
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i++, n >>= 8n) {
    out[i] = Number(n & 0xffn);
  }
  return out;
}

function varInt(n: number | bigint): Uint8Array {
  const v = BigInt(n);
  if (v < 0xfdn) {
    return new Uint8Array([Number(v)]);
  }
  if (v <= 0xffffn) {
    return new Uint8Array([0xfd, Number(v & 0xffn), Number((v >> 8n) & 0xffn)]);
  }
  if (v <= 0xffff_ffffn) {
    return concat([new Uint8Array([0xfe]), u32le(Number(v))]);
  }
  return concat([new Uint8Array([0xff]), u64le(v)]);
}

function hash256(bytes: Uint8Array): Uint8Array {
  return sha256(sha256(bytes));
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function parseTx(rawHex: string): ParsedTx {
  const r = new Reader(hexToBytes(rawHex, "transaction.unsignedTransaction"));
  const version = r.u32("version");
  let inputCount = r.varInt("input count");
  const hasWitness = inputCount === 0;
  if (hasWitness) {
    if (r.u8("segwit flag") !== 1) {
      throw new Error("unsupported bitcoin transaction marker/flag");
    }
    inputCount = r.varInt("input count");
  }
  if (inputCount === 0) {
    throw new Error("bitcoin transaction must have at least one input");
  }

  const inputs = Array.from({ length: inputCount }, (_, i) => {
    const txid = r.bytesN(32, `inputs[${i}].txid`);
    const index = r.u32(`inputs[${i}].index`);
    r.bytesN(r.varInt(`inputs[${i}].script length`), `inputs[${i}].script`);
    const sequence = r.u32(`inputs[${i}].sequence`);
    return { txid, index, sequence };
  });

  const outputCount = r.varInt("output count");
  if (outputCount === 0) {
    throw new Error("bitcoin transaction must have at least one output");
  }
  const outputs = Array.from({ length: outputCount }, (_, i) => {
    const value = r.u64(`outputs[${i}].value`);
    const script = r.bytesN(r.varInt(`outputs[${i}].script length`), `outputs[${i}].script`);
    return { value, script };
  });

  if (hasWitness) {
    for (let i = 0; i < inputCount; i++) {
      const itemCount = r.varInt(`witness[${i}].item count`);
      if (itemCount !== 0) {
        throw new Error(`bitcoin transaction witness[${i}] must be empty for unsigned deposits`);
      }
    }
  }

  const locktime = r.u32("locktime");
  r.end();
  return { version, inputs, outputs, locktime };
}

const outpoint = (input: TxInput) => concat([input.txid, u32le(input.index)]);
const script = (bytes: Uint8Array) => concat([varInt(bytes.length), bytes]);
const output = (o: TxOutput) => concat([u64le(o.value), script(o.script)]);
const p2wpkhCode = (pubkey: Uint8Array) =>
  concat([new Uint8Array([0x76, 0xa9, 0x14]), hash160(pubkey), new Uint8Array([0x88, 0xac])]);

function sighash(tx: ParsedTx, inputIndex: number, pubkey: Uint8Array, value: bigint): Uint8Array {
  const input = tx.inputs[inputIndex];
  return hash256(
    concat([
      u32le(tx.version),
      hash256(concat(tx.inputs.map(outpoint))),
      hash256(concat(tx.inputs.map((i) => u32le(i.sequence)))),
      outpoint(input),
      script(p2wpkhCode(pubkey)),
      u64le(value),
      u32le(input.sequence),
      hash256(concat(tx.outputs.map(output))),
      u32le(tx.locktime),
      u32le(SIGHASH_ALL),
    ]),
  );
}

function addressScripts(encodedHex: string, label: string): Uint8Array[] {
  const encoded = hexToBytes(encodedHex, label);
  if (encoded[0] === LEGACY) {
    const payload = encoded.slice(1);
    if (payload.length === 21 && payload[0] === P2PKH) {
      return [
        concat([
          new Uint8Array([0x76, 0xa9, 0x14]),
          payload.slice(1),
          new Uint8Array([0x88, 0xac]),
        ]),
      ];
    }
    if (payload.length === 21 && payload[0] === P2SH) {
      return [concat([new Uint8Array([0xa9, 0x14]), payload.slice(1), new Uint8Array([0x87])])];
    }
    throw new Error(`${label} has unsupported legacy bitcoin address encoding`);
  }
  if (encoded.length < 3 || encoded[0] > 16) {
    throw new Error(`${label} is not a supported bitcoin address encoding`);
  }
  const versionOp = encoded[0] === 0 ? 0x00 : 0x50 + encoded[0];
  const program = encoded.slice(1);
  return [concat([new Uint8Array([versionOp, program.length]), program])];
}

function depositoryScripts(encodedHex: string): Uint8Array[] {
  return addressScripts(encodedHex, "attestation.inputDepository");
}

function refundScripts(encodedHex: string): Uint8Array[] {
  return addressScripts(encodedHex, "trigger.derivationFields.refundRecipient");
}

function opReturn(scriptBytes: Uint8Array): string | undefined {
  if (scriptBytes[0] !== OP_RETURN || scriptBytes.length < 2) {
    return undefined;
  }
  const op = scriptBytes[1];
  const data =
    op <= 75
      ? scriptBytes.slice(2, 2 + op)
      : op === 0x4c
        ? scriptBytes.slice(3, 3 + scriptBytes[2])
        : undefined;
  return data ? new TextDecoder().decode(data) : undefined;
}

function assertCounts(tx: ParsedTx, data: BitcoinVmTransaction): void {
  if (data.sighashes.length !== tx.inputs.length) {
    throw new Error(
      `transactions[0]: sighash count must equal input count: expected=${tx.inputs.length}, got=${data.sighashes.length}`,
    );
  }
  if (data.inputValues.length !== tx.inputs.length) {
    throw new Error(
      `transactions[0]: inputValues count must equal input count: expected=${tx.inputs.length}, got=${data.inputValues.length}`,
    );
  }
}

export function assertBitcoinDepositTransaction(
  trigger: DepositAddressTrigger,
  attestation: DepositAddressTriggerAttestation,
  data: BitcoinVmTransaction,
): void {
  if (normalizeAddressHex(trigger.input.currency, "bitcoin-vm") !== BTC_NATIVE) {
    throw new Error("bitcoin-vm only supports native BTC deposits");
  }

  const tx = parseTx(data.unsignedTransaction);
  assertCounts(tx, data);

  const expectedAmount = BigInt(trigger.input.amount);
  const scripts = depositoryScripts(attestation.inputDepository);
  const refunds = refundScripts(trigger.derivationFields.refundRecipient);
  const actualAmount = tx.outputs.reduce(
    (sum, o) => sum + (scripts.some((s) => equal(s, o.script)) ? o.value : 0n),
    0n,
  );
  if (actualAmount !== expectedAmount) {
    throw new Error(
      `transactions[0]: value sent to input depository must equal input.amount: expected=${expectedAmount}, got=${actualAmount}`,
    );
  }

  const invalidChange = tx.outputs.find(
    (o) =>
      !scripts.some((s) => equal(s, o.script)) &&
      opReturn(o.script) === undefined &&
      !refunds.some((s) => equal(s, o.script)),
  );
  if (invalidChange) {
    throw new Error(
      "transactions[0]: non-depository, non-OP_RETURN outputs must pay trigger.derivationFields.refundRecipient",
    );
  }

  const metadata = tx.outputs
    .map((o) => opReturn(o.script))
    .find((x) => x?.startsWith(trigger.orderId));
  if (!metadata) {
    throw new Error("transactions[0]: OP_RETURN metadata must start with trigger.orderId");
  }

  const depositor = DEPOSITOR_RE.exec(metadata)?.[1];
  if (!depositor) {
    throw new Error("transactions[0]: OP_RETURN metadata must include |depositor=<depositor>|");
  }
  const encodedDepositor = encodeAddressToHex(depositor, "bitcoin-vm").toLowerCase();
  if (encodedDepositor !== trigger.derivationFields.depositor.toLowerCase()) {
    throw new Error(
      `transactions[0]: OP_RETURN depositor mismatch: expected=${trigger.derivationFields.depositor}, got=${depositor} (${encodedDepositor})`,
    );
  }
}

export function signableBitcoinDigests(
  data: BitcoinVmTransaction,
  pubkey: Uint8Array,
): Uint8Array[] {
  const tx = parseTx(data.unsignedTransaction);
  assertCounts(tx, data);

  return tx.inputs.map((_, i) => {
    const actual = hexToBytes(data.sighashes[i], `transaction.sighashes[${i}]`);
    if (actual.length !== 32) {
      throw new Error(`transaction.sighashes[${i}] must be 32 bytes`);
    }
    if (!equal(actual, sighash(tx, i, pubkey, BigInt(data.inputValues[i])))) {
      throw new Error(`transaction.sighashes[${i}] does not match unsignedTransaction`);
    }
    return actual;
  });
}
