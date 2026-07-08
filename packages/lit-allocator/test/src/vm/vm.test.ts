import { describe, expect, it, vi, type Mock } from "vitest";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { secp256k1 } from "@noble/curves/secp256k1.js";

/** Decode a 0x-prefixed hex string into a Uint8Array. */
function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/i, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Encode a Uint8Array as a lowercase hex string (no 0x prefix). */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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
  __LIGHTER_ALLOWED_API_KEYS__?: string;
  __LIGHTER_GATEWAY__?: string;
  __LIGHTER_GATEWAY_CHAIN_ID__?: string;
};

const TEST_PKP_KEY_HEX = "deadbeef".repeat(8);
const PKP_ID = "pkp-test";

function mockConfig(): void {
  const globalWithLit = globalThis as GlobalWithLit;
  globalWithLit.__ALLOCATOR_ADDRESS__ = "0x0000000000000000000000000000000000000000";
  globalWithLit.__HUB_EVM_CHAIN_ID__ = "421614";
  globalWithLit.__ALLOWED_ORACLES__ = "[]";
  globalWithLit.__ORACLE_SIGNATURE_THRESHOLD__ = "0";
  globalWithLit.__LIGHTER_ALLOWED_API_KEYS__ = JSON.stringify([
    {
      apiKeyIndex: 5,
      publicKey: "0x0102030405060708091011121314151617181920212223242526272829303132",
    },
  ]);
  globalWithLit.__LIGHTER_GATEWAY__ = "0x3B4D794a66304F130a4Db8F2551B0070dfCf5ca7";
  globalWithLit.__LIGHTER_GATEWAY_CHAIN_ID__ = "1";
}

async function loadActions() {
  mockConfig();
  const [
    { main: ethereumMain },
    { main: tronMain },
    { main: solanaMain },
    { main: tonMain },
    { main: bitcoinMain },
    { main: hyperliquidMain },
    { main: lighterMain },
    { main: xrpMain },
  ] = await Promise.all([
    import("../../../src/vm/ethereum-vm.js"),
    import("../../../src/vm/tron-vm.js"),
    import("../../../src/vm/solana-vm.js"),
    import("../../../src/vm/ton-vm.js"),
    import("../../../src/vm/bitcoin-vm.js"),
    import("../../../src/vm/hyperliquid-vm.js"),
    import("../../../src/vm/lighter-vm.js"),
    import("../../../src/vm/xrp-vm.js"),
  ]);
  return {
    ethereumMain,
    tronMain,
    solanaMain,
    tonMain,
    bitcoinMain,
    hyperliquidMain,
    lighterMain,
    xrpMain,
  };
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

describe("bitcoin-vm action", () => {
  it("returns the HKDF-derived Bitcoin P2WPKH wallet address", async () => {
    const lit = mockLit();
    const { bitcoinMain } = await loadActions();

    const result = await bitcoinMain({ pkpId: PKP_ID, action: "wallet" });

    expect(lit.Actions.getPrivateKey).toHaveBeenCalledWith({ pkpId: PKP_ID });
    expect(result).toEqual({
      vmType: "bitcoin-vm",
      address: "bc1qjyapu2va0vz6v0quuerllc4ufkyd38qsvl0n4x",
    });
  });

  it("derives a distinct wallet from ethereum-vm", async () => {
    mockLit();
    const { ethereumMain, bitcoinMain } = await loadActions();

    const ethereum = (await ethereumMain({ pkpId: PKP_ID, action: "wallet" })) as {
      address: string;
    };
    const bitcoin = (await bitcoinMain({ pkpId: PKP_ID, action: "wallet" })) as {
      address: string;
    };
    expect(bitcoin.address).not.toBe(ethereum.address);
  });

  it("rejects unknown actions", async () => {
    mockLit();
    const { bitcoinMain } = await loadActions();
    await expect(bitcoinMain({ pkpId: PKP_ID, action: "unknown" })).rejects.toThrow(
      "unknown action",
    );
  });

  it("requires withdrawRequest and attestation for sign", async () => {
    mockLit();
    const { bitcoinMain } = await loadActions();
    await expect(bitcoinMain({ pkpId: PKP_ID, action: "sign" })).rejects.toThrow(
      "withdrawRequest is required",
    );
    await expect(
      bitcoinMain({ pkpId: PKP_ID, action: "sign", withdrawRequest: {} as never }),
    ).rejects.toThrow("attestation is required");
  });
});

describe("hyperliquid-vm action", () => {
  it("returns the HKDF-derived Hyperliquid wallet address", async () => {
    const lit = mockLit();
    const { hyperliquidMain } = await loadActions();

    const result = await hyperliquidMain({ pkpId: PKP_ID, action: "wallet" });

    expect(lit.Actions.getPrivateKey).toHaveBeenCalledWith({ pkpId: PKP_ID });
    expect(result).toMatchObject({ vmType: "hyperliquid-vm" });
    expect((result as { address: string }).address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("derives a distinct wallet from ethereum-vm", async () => {
    mockLit();
    const { ethereumMain, hyperliquidMain } = await loadActions();

    const ethereum = (await ethereumMain({ pkpId: PKP_ID, action: "wallet" })) as {
      address: string;
    };
    const hyperliquid = (await hyperliquidMain({ pkpId: PKP_ID, action: "wallet" })) as {
      address: string;
    };
    expect(hyperliquid.address).not.toBe(ethereum.address);
  });

  it("rejects unknown actions", async () => {
    mockLit();
    const { hyperliquidMain } = await loadActions();
    await expect(hyperliquidMain({ pkpId: PKP_ID, action: "unknown" })).rejects.toThrow(
      "unknown action",
    );
  });

  it("requires withdrawRequest and attestation for sign", async () => {
    mockLit();
    const { hyperliquidMain } = await loadActions();
    await expect(hyperliquidMain({ pkpId: PKP_ID, action: "sign" })).rejects.toThrow(
      "withdrawRequest is required",
    );
    await expect(
      hyperliquidMain({ pkpId: PKP_ID, action: "sign", withdrawRequest: {} as never }),
    ).rejects.toThrow("attestation is required");
  });
});

describe("lighter-vm action", () => {
  it("returns the HKDF-derived Lighter wallet address", async () => {
    const lit = mockLit();
    const { lighterMain } = await loadActions();

    const result = await lighterMain({ pkpId: PKP_ID, action: "wallet" });

    expect(lit.Actions.getPrivateKey).toHaveBeenCalledWith({ pkpId: PKP_ID });
    expect(result).toMatchObject({ vmType: "lighter-vm" });
    expect((result as { address: string }).address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("derives a distinct wallet from ethereum-vm", async () => {
    mockLit();
    const { ethereumMain, lighterMain } = await loadActions();

    const ethereum = (await ethereumMain({ pkpId: PKP_ID, action: "wallet" })) as {
      address: string;
    };
    const lighter = (await lighterMain({ pkpId: PKP_ID, action: "wallet" })) as {
      address: string;
    };
    expect(lighter.address).not.toBe(ethereum.address);
  });

  it("rejects unknown actions", async () => {
    mockLit();
    const { lighterMain } = await loadActions();
    await expect(lighterMain({ pkpId: PKP_ID, action: "unknown" })).rejects.toThrow(
      "unknown action",
    );
  });

  it("requires withdrawRequest and attestation for sign", async () => {
    mockLit();
    const { lighterMain } = await loadActions();
    await expect(lighterMain({ pkpId: PKP_ID, action: "sign" })).rejects.toThrow(
      "withdrawRequest is required",
    );
    await expect(
      lighterMain({ pkpId: PKP_ID, action: "sign", withdrawRequest: {} as never }),
    ).rejects.toThrow("attestation is required");
  });

  it("signs ChangePubKey only for allowlisted API keys", async () => {
    mockLit();
    const { lighterMain } = await loadActions();

    const result = (await lighterMain({
      pkpId: PKP_ID,
      action: "changePubKey",
      changePubKey: {
        accountIndex: 42,
        apiKeyIndex: 5,
        publicKey: "0x0102030405060708091011121314151617181920212223242526272829303132",
        txNonce: 7,
        gasPrice: 20_000_000_000n,
        gasLimit: 200_000,
      },
    })) as {
      changePubKey: {
        hash: string;
        data: string;
        rawTransaction: string;
        signature: string;
        transactionSignature: { r: string; s: string; v: string };
      };
    };

    expect(result.changePubKey.hash).toMatch(/^0x[0-9a-f]{64}$/i);
    expect(result.changePubKey.data.startsWith("0x")).toBe(true);
    expect(result.changePubKey.rawTransaction.startsWith("0x")).toBe(true);
    expect(result.changePubKey.signature).toMatch(/^0x[0-9a-f]{130}$/i);
    expect(result.changePubKey.transactionSignature.r).toMatch(/^0x[0-9a-f]{64}$/i);
    expect(result.changePubKey.transactionSignature.s).toMatch(/^0x[0-9a-f]{64}$/i);
    expect(["37", "38"]).toContain(result.changePubKey.transactionSignature.v);
  });

  it("rejects ChangePubKey for API keys outside the config allowlist", async () => {
    mockLit();
    const { lighterMain } = await loadActions();

    await expect(
      lighterMain({
        pkpId: PKP_ID,
        action: "changePubKey",
        changePubKey: {
          accountIndex: 42,
          apiKeyIndex: 6,
          publicKey: "0x0102030405060708091011121314151617181920212223242526272829303132",
          txNonce: 7,
          gasPrice: 20_000_000_000n,
          gasLimit: 200_000,
        },
      }),
    ).rejects.toThrow("Lighter API key is not allowlisted");
  });
});

describe("tron-vm action", () => {
  it("returns the HKDF-derived Tron VM wallet address", async () => {
    const lit = mockLit();
    const { tronMain } = await loadActions();

    const result = await tronMain({ pkpId: PKP_ID, action: "wallet" });

    expect(lit.Actions.getPrivateKey).toHaveBeenCalledWith({ pkpId: PKP_ID });
    expect(result).toEqual({
      vmType: "tron-vm",
      address: "0x41aaB158f98B2087376D099fb1f00a6F95f055E2",
    });
  });

  it("derives a distinct keypair from ethereum-vm", async () => {
    mockLit();
    const { ethereumMain, tronMain } = await loadActions();

    const ethereum = (await ethereumMain({ pkpId: PKP_ID, action: "wallet" })) as {
      address: string;
    };
    const tron = (await tronMain({ pkpId: PKP_ID, action: "wallet" })) as { address: string };
    expect(tron.address).not.toBe(ethereum.address);
  });

  it("rejects unknown actions", async () => {
    mockLit();
    const { tronMain } = await loadActions();
    await expect(tronMain({ pkpId: PKP_ID, action: "unknown" })).rejects.toThrow("unknown action");
  });

  it("requires withdrawRequest and attestation for sign", async () => {
    mockLit();
    const { tronMain } = await loadActions();
    await expect(tronMain({ pkpId: PKP_ID, action: "sign" })).rejects.toThrow(
      "withdrawRequest is required",
    );
    await expect(
      tronMain({ pkpId: PKP_ID, action: "sign", withdrawRequest: {} as never }),
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

describe("ton-vm action", () => {
  it("returns the HKDF-derived TON wallet address", async () => {
    const lit = mockLit();
    const { tonMain } = await loadActions();

    const result = await tonMain({ pkpId: PKP_ID, action: "wallet" });

    expect(lit.Actions.getPrivateKey).toHaveBeenCalledWith({ pkpId: PKP_ID });
    expect(result).toEqual({
      vmType: "ton-vm",
      address: "0:c2200416edfee97346c7bfb6ca39aa2ae908a3ba650058a23dbf413d38fa0453",
    });
  });

  it("derives a distinct keypair from solana-vm", async () => {
    mockLit();
    const { solanaMain, tonMain } = await loadActions();

    const solana = (await solanaMain({ pkpId: PKP_ID, action: "wallet" })) as { address: string };
    const ton = (await tonMain({ pkpId: PKP_ID, action: "wallet" })) as { address: string };

    // Solana uses bs58, TON uses raw 0:<hex>; compare the underlying public keys.
    const solanaPubKey = bytesToHex(bs58.decode(solana.address));
    const tonPubKey = ton.address.slice("0:".length);
    expect(tonPubKey).not.toBe(solanaPubKey);
  });

  it("rejects unknown actions", async () => {
    mockLit();
    const { tonMain } = await loadActions();
    await expect(tonMain({ pkpId: PKP_ID, action: "unknown" })).rejects.toThrow("unknown action");
  });

  it("requires withdrawRequest and attestation for sign", async () => {
    mockLit();
    const { tonMain } = await loadActions();
    await expect(tonMain({ pkpId: PKP_ID, action: "sign" })).rejects.toThrow(
      "withdrawRequest is required",
    );
    await expect(
      tonMain({ pkpId: PKP_ID, action: "sign", withdrawRequest: {} as never }),
    ).rejects.toThrow("attestation is required");
  });

  it("emits 64-byte hex Ed25519 signatures", async () => {
    mockLit();
    const { tonMain } = await loadActions();

    // Build a minimal withdraw request whose hash the oracle attestation will
    // claim to cover. allowedOracles=[] + threshold=0 lets the attestation
    // path through verification without any signatures.
    const withdrawRequest = {
      chainId: "ton-testnet",
      depository: "0x0000000000000000000000000000000000000000",
      currency: "0x0000000000000000000000000000000000000000",
      amount: "0",
      spenderChainId: "ton-testnet",
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

    const result = (await tonMain({
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
    const pubKey = hexToBytes(result.address.slice("0:".length));
    const msg = hexToBytes(hashToSign);
    expect(nacl.sign.detached.verify(msg, sigBytes, pubKey)).toBe(true);
  });
});

describe("xrp-vm action", () => {
  it("returns the HKDF-derived XRPL address and signing public key", async () => {
    const lit = mockLit();
    const { xrpMain } = await loadActions();

    const result = await xrpMain({ pkpId: PKP_ID, action: "wallet" });

    expect(lit.Actions.getPrivateKey).toHaveBeenCalledWith({ pkpId: PKP_ID });
    expect(result).toEqual({
      vmType: "xrp-vm",
      address: "rs5YPnwapsg4kspq5JuFEhYFBvkV2XL8DP",
      signingPubKey: "0x0363a2fd2d8434e91271d3b5f3aef73b7eb8cc9e4238e9b78a9196a0a97e1a3c06",
    });
  });

  it("derives a distinct keypair from bitcoin-vm", async () => {
    mockLit();
    const { bitcoinMain, xrpMain } = await loadActions();

    const bitcoin = (await bitcoinMain({ pkpId: PKP_ID, action: "wallet" })) as {
      address: string;
    };
    const xrp = (await xrpMain({ pkpId: PKP_ID, action: "wallet" })) as { address: string };
    expect(xrp.address).not.toBe(bitcoin.address);
  });

  it("rejects unknown actions", async () => {
    mockLit();
    const { xrpMain } = await loadActions();
    await expect(xrpMain({ pkpId: PKP_ID, action: "unknown" })).rejects.toThrow("unknown action");
  });

  it("requires withdrawRequest and attestation for sign", async () => {
    mockLit();
    const { xrpMain } = await loadActions();
    await expect(xrpMain({ pkpId: PKP_ID, action: "sign" })).rejects.toThrow(
      "withdrawRequest is required",
    );
    await expect(
      xrpMain({ pkpId: PKP_ID, action: "sign", withdrawRequest: {} as never }),
    ).rejects.toThrow("attestation is required");
  });

  it("emits canonical low-S DER secp256k1 signatures over the given digest", async () => {
    mockLit();
    const { xrpMain } = await loadActions();

    // Minimal withdraw request whose hash the attestation claims to cover.
    // allowedOracles=[] + threshold=0 lets the attestation through without
    // any oracle signatures.
    const withdrawRequest = {
      chainId: "xrp",
      depository: "0x0000000000000000000000000000000000000000",
      currency: "0x0000000000000000000000000000000000000000",
      amount: "0",
      spenderChainId: "xrp",
      spender: "0x0000000000000000000000000000000000000000",
      receiver: "0x0000000000000000000000000000000000000000",
      data: "0x",
      nonce: `0x${"00".repeat(32)}`,
    };
    const { computeWithdrawRequestHash } = await import("../../../src/common/abi.js");
    const withdrawRequestHash = `0x${bytesToHex(computeWithdrawRequestHash(withdrawRequest))}`;
    const hashToSign = `0x${"11".repeat(32)}`;

    const result = (await xrpMain({
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
    })) as {
      results: Array<{ hash: string; signature: string }>;
    };

    expect(result.results).toHaveLength(1);
    const signature = result.results[0].signature;
    expect(signature.startsWith("0x30")).toBe(true); // DER SEQUENCE tag

    // The signing public key is only exposed on the wallet action (it is a
    // fixed per-PKP constant used once at deploy time), so fetch it there and
    // verify the DER signature against it without re-hashing (the digest is
    // already the XRPL single-signing hash).
    const wallet = (await xrpMain({ pkpId: PKP_ID, action: "wallet" })) as {
      signingPubKey: string;
    };
    const der = hexToBytes(signature);
    const pubKey = hexToBytes(wallet.signingPubKey);
    const digest = hexToBytes(hashToSign);
    expect(secp256k1.verify(der, digest, pubKey, { prehash: false, format: "der" })).toBe(true);
    // Low-S canonical form: s must be in the lower half of the curve order.
    const parsed = secp256k1.Signature.fromBytes(der, "der");
    expect(parsed.hasHighS()).toBe(false);
  });
});
