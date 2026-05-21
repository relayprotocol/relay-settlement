import { describe, expect, it, vi, type Mock } from "vitest";
import bs58 from "bs58";
import nacl from "tweetnacl";

/** Decode a 0x-prefixed hex string into a Uint8Array. */
function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/i, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

type GetPrivateKey = (params: { pkpId: string }) => Promise<string>;

type LitMock = {
  Actions: {
    getPrivateKey: Mock<GetPrivateKey>;
  };
};

type GlobalWithLit = typeof globalThis & {
  Lit: LitMock;
  __ALLOCATOR_ADDRESS__?: string;
  __HUB_EVM_CHAIN_ID__?: string;
  __ALLOWED_ORACLES__?: string;
  __ORACLE_SIGNATURE_THRESHOLD__?: string;
};

const TEST_PKP_KEY_HEX = "deadbeef".repeat(8);
const PKP_ID = "pkp-test";

function mockConfig(): void {
  const globalWithLit = globalThis as GlobalWithLit;
  globalWithLit.__ALLOCATOR_ADDRESS__ = "0x0000000000000000000000000000000000000000";
  globalWithLit.__HUB_EVM_CHAIN_ID__ = "421614";
  globalWithLit.__ALLOWED_ORACLES__ = "[]";
  globalWithLit.__ORACLE_SIGNATURE_THRESHOLD__ = "0";
}

async function loadActions() {
  mockConfig();
  const [{ main: ethereumMain }, { main: solanaMain }] = await Promise.all([
    import("../../../src/vm/ethereum-vm.js"),
    import("../../../src/vm/solana-vm.js"),
  ]);
  return { ethereumMain, solanaMain };
}

/** Install a mock Lit runtime that returns deterministic PKP key material. */
function mockLit(privateKeyHex = TEST_PKP_KEY_HEX): LitMock {
  const lit: LitMock = {
    Actions: {
      getPrivateKey: vi.fn<GetPrivateKey>(async () => privateKeyHex),
    },
  };
  (globalThis as GlobalWithLit).Lit = lit;
  return lit;
}

describe("ethereum-vm action", () => {
  it("returns the HKDF-derived Ethereum wallet address", async () => {
    const lit = mockLit();
    const { ethereumMain } = await loadActions();

    const result = await ethereumMain({ pkpId: PKP_ID, action: "wallet" });

    expect(lit.Actions.getPrivateKey).toHaveBeenCalledWith({ pkpId: PKP_ID });
    expect(result).toEqual({
      vmType: "ethereum-vm",
      address: "0x0C70f309dF7A0DA96aADd6487b25aa69E5f4482B",
    });
  });

  it("rejects unknown actions", async () => {
    mockLit();
    const { ethereumMain } = await loadActions();
    await expect(ethereumMain({ pkpId: PKP_ID, action: "unknown" })).rejects.toThrow(
      "unknown action",
    );
  });

  it("requires withdrawRequest and attestation for sign", async () => {
    mockLit();
    const { ethereumMain } = await loadActions();
    await expect(ethereumMain({ pkpId: PKP_ID, action: "sign" })).rejects.toThrow(
      "withdrawRequest is required",
    );
    await expect(
      ethereumMain({ pkpId: PKP_ID, action: "sign", withdrawRequest: {} as never }),
    ).rejects.toThrow("attestation is required");
  });
});

describe("solana-vm action", () => {
  it("returns the HKDF-derived Solana wallet address", async () => {
    const lit = mockLit();
    const { solanaMain } = await loadActions();

    const result = await solanaMain({ pkpId: PKP_ID, action: "wallet" });

    expect(lit.Actions.getPrivateKey).toHaveBeenCalledWith({ pkpId: PKP_ID });
    expect(result).toEqual({
      vmType: "solana-vm",
      address: "DCawGAmp66teXvMwi2uvU2GiZ52SWHu4c4E5xxvntTnT",
    });
  });

  it("rejects unknown actions", async () => {
    mockLit();
    const { solanaMain } = await loadActions();
    await expect(solanaMain({ pkpId: PKP_ID, action: "unknown" })).rejects.toThrow(
      "unknown action",
    );
  });

  it("requires withdrawRequest and attestation for sign", async () => {
    mockLit();
    const { solanaMain } = await loadActions();
    await expect(solanaMain({ pkpId: PKP_ID, action: "sign" })).rejects.toThrow(
      "withdrawRequest is required",
    );
    await expect(
      solanaMain({ pkpId: PKP_ID, action: "sign", withdrawRequest: {} as never }),
    ).rejects.toThrow("attestation is required");
  });

  it("emits 64-byte hex Ed25519 signatures", async () => {
    mockLit();
    const { solanaMain } = await loadActions();

    // Build a minimal withdraw request whose hash the oracle attestation will
    // claim to cover. allowedOracles=[] + threshold=0 lets the attestation
    // path through verification without any signatures.
    const withdrawRequest = {
      chainId: "solana-devnet",
      depository: "0x0000000000000000000000000000000000000000",
      currency: "0x0000000000000000000000000000000000000000",
      amount: "0",
      spenderChainId: "solana-devnet",
      spender: "0x0000000000000000000000000000000000000000",
      receiver: "0x0000000000000000000000000000000000000000",
      data: "0x",
      nonce: `0x${"00".repeat(32)}`,
    };
    const { computeWithdrawRequestHash } = await import("../../../src/common/abi.js");
    const withdrawRequestHashBytes = computeWithdrawRequestHash(withdrawRequest);
    const withdrawRequestHash = `0x${Array.from(withdrawRequestHashBytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")}`;
    const hashToSign = `0x${"11".repeat(32)}`;

    const result = (await solanaMain({
      pkpId: PKP_ID,
      action: "sign",
      withdrawRequest,
      attestation: {
        chainId: 421614,
        allocator: "0x0000000000000000000000000000000000000000",
        withdrawRequestHash,
        hashesToSign: [hashToSign],
        signatures: [],
      },
    })) as { results: Array<{ hash: string; signature: string }>; address: string };

    expect(result.results).toHaveLength(1);
    const signature = result.results[0].signature;
    expect(signature.startsWith("0x")).toBe(false);
    expect(signature.length).toBe(128); // 64 bytes, no prefix
    const sigBytes = hexToBytes(signature);
    expect(sigBytes.length).toBe(64);

    // Verify the signature against the derived public key for full confidence.
    const pubKey = bs58.decode(result.address);
    const msg = hexToBytes(hashToSign);
    expect(nacl.sign.detached.verify(msg, sigBytes, pubKey)).toBe(true);
  });
});
