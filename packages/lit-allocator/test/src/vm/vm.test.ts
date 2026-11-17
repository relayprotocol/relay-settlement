import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import type { AtlasTransfer } from "../../../src/vm/atlas-vm.js";

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
  __LIGHTER_GATEWAYS__?: string;
  __ATLAS_DOMAIN__?: string;
};

const TEST_PKP_KEY_HEX = "deadbeef".repeat(8);
const PKP_ID = "pkp-test";
// Atlas testnet transaction domain
const TESTNET_DOMAIN = {
  chainId: 43003,
  salt: "0xcc279b865244fb243618dfc109dced1cae0e32662920805f8b64813411597338",
};

function mockConfig(): void {
  const globalWithLit = globalThis as GlobalWithLit;
  globalWithLit.__ALLOCATOR_ADDRESS__ = "0x0000000000000000000000000000000000000000";
  globalWithLit.__HUB_EVM_CHAIN_ID__ = "421614";
  globalWithLit.__ALLOWED_ORACLES__ = "[]";
  globalWithLit.__ORACLE_SIGNATURE_THRESHOLD__ = "0";
  globalWithLit.__LIGHTER_GATEWAYS__ = JSON.stringify([
    {
      chainId: 1,
      gateway: "0x3B4D794a66304F130a4Db8F2551B0070dfCf5ca7",
      allowedApiKeys: [
        {
          apiKeyIndex: 5,
          publicKey: "0x0102030405060708091011121314151617181920212223242526272829303132",
        },
      ],
    },
    {
      chainId: 4663,
      gateway: "0x94bAB9693Ba2f6358507eFfcbd372b0660AFfF9d",
      allowedApiKeys: [
        {
          apiKeyIndex: 7,
          publicKey: "0x3232323232323232323232323232323232323232323232323232323232323232",
        },
      ],
    },
    {
      chainId: 999,
      gateway: "0x0000000000000000000000000000000000000999",
      allowedApiKeys: [],
    },
  ]);
  globalWithLit.__ATLAS_DOMAIN__ = JSON.stringify(TESTNET_DOMAIN);
}

async function loadActions() {
  mockConfig();
  const [
    { main: gatewayMain },
    { main: ethereumMain },
    { main: tronMain },
    { main: solanaMain },
    { main: tonMain },
    { main: bitcoinMain },
    { main: hyperliquidMain },
    { main: lighterMain },
    { main: xrpMain },
    { main: hederaMain },
    { main: atlasMain },
  ] = await Promise.all([
    import("../../../src/vm/gateway-vm.js"),
    import("../../../src/vm/ethereum-vm.js"),
    import("../../../src/vm/tron-vm.js"),
    import("../../../src/vm/solana-vm.js"),
    import("../../../src/vm/ton-vm.js"),
    import("../../../src/vm/bitcoin-vm.js"),
    import("../../../src/vm/hyperliquid-vm.js"),
    import("../../../src/vm/lighter-vm.js"),
    import("../../../src/vm/xrp-vm.js"),
    import("../../../src/vm/hedera-vm.js"),
    import("../../../src/vm/atlas-vm.js"),
  ]);
  return {
    gatewayMain,
    ethereumMain,
    tronMain,
    solanaMain,
    tonMain,
    bitcoinMain,
    hyperliquidMain,
    lighterMain,
    xrpMain,
    hederaMain,
    atlasMain,
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

describe("gateway-vm action", () => {
  it("returns a dedicated HKDF-derived Gateway address", async () => {
    const lit = mockLit();
    const { gatewayMain, ethereumMain } = await loadActions();

    const gateway = await gatewayMain({
      pkpId: PKP_ID,
      action: "wallet",
      destinationVmType: "ethereum-vm",
    });
    const ethereum = await ethereumMain({ pkpId: PKP_ID, action: "wallet" });

    expect(lit.Actions.getPrivateKey).toHaveBeenCalledWith({ pkpId: PKP_ID });
    expect(gateway).toEqual({
      vmType: "gateway-vm",
      destinationVmType: "ethereum-vm",
      gatewaySigner: "0x98073A349deF281dF771Ae2De7e6f47525e2D28B",
      address: "0x98073A349deF281dF771Ae2De7e6f47525e2D28B",
    });
    expect(gateway.address).not.toBe(ethereum.address);
  });

  it("signs the attested BurnIntent and CallRequest in order", async () => {
    mockLit();
    const { gatewayMain } = await loadActions();
    const withdrawRequest = {
      chainId: "gateway",
      depository: "0x1111111111111111111111111111111111111111",
      currency: "0x0000000000000000000000000000000000000000",
      amount: "1000000",
      spenderChainId: "gateway",
      spender: "0x2222222222222222222222222222222222222222",
      receiver: "0x3333333333333333333333333333333333333333",
      data: "0x",
      nonce: `0x${"01".repeat(32)}`,
    };
    const { computeWithdrawRequestHash } = await import("../../../src/common/abi.js");
    const { deriveKey } = await import("../../../src/common/crypto.js");
    const withdrawRequestHash = `0x${bytesToHex(computeWithdrawRequestHash(withdrawRequest))}`;
    const burnIntentHash = `0x${"11".repeat(32)}`;
    const callRequestHash = `0x${"22".repeat(32)}`;

    const result = await gatewayMain({
      pkpId: PKP_ID,
      action: "sign",
      destinationVmType: "ethereum-vm",
      withdrawRequest,
      attestation: {
        chainId: 421614,
        allocator: "0x0000000000000000000000000000000000000000",
        withdrawRequestHash,
        hashesToSign: [burnIntentHash, callRequestHash],
        signatures: [],
      },
    });

    if (!("results" in result)) {
      throw new Error("expected Gateway signing result");
    }
    expect(result.results.map(({ hash }) => hash)).toEqual([burnIntentHash, callRequestHash]);

    const privateKey = await deriveKey(TEST_PKP_KEY_HEX, "gateway-vm");
    const publicKey = secp256k1.getPublicKey(privateKey);
    for (const signed of result.results) {
      const signature = hexToBytes(signed.signature);
      expect(signature).toHaveLength(65);
      expect([27, 28]).toContain(signature[64]);
      expect(
        secp256k1.verify(signature.slice(0, 64), hexToBytes(signed.hash), publicKey, {
          prehash: false,
          format: "compact",
        }),
      ).toBe(true);
    }
  });

  it("uses the same Gateway key material for a Solana destination allocator", async () => {
    mockLit();
    const { gatewayMain } = await loadActions();
    const withdrawRequest = {
      chainId: "gateway",
      depository: `0x${"11".repeat(32)}`,
      currency: "0x0000000000000000000000000000000000000000",
      amount: "1000000",
      spenderChainId: "gateway",
      spender: "0x2222222222222222222222222222222222222222",
      receiver: `0x${"33".repeat(32)}`,
      data: "0x",
      nonce: `0x${"01".repeat(32)}`,
    };
    const { computeWithdrawRequestHash } = await import("../../../src/common/abi.js");
    const { deriveKey } = await import("../../../src/common/crypto.js");
    const withdrawRequestHash = `0x${bytesToHex(computeWithdrawRequestHash(withdrawRequest))}`;
    const burnIntentHash = `0x${"44".repeat(32)}`;
    const callRequestHash = `0x${"55".repeat(32)}`;

    const result = await gatewayMain({
      pkpId: PKP_ID,
      action: "sign",
      destinationVmType: "solana-vm",
      withdrawRequest,
      attestation: {
        chainId: 421614,
        allocator: "0x0000000000000000000000000000000000000000",
        withdrawRequestHash,
        hashesToSign: [burnIntentHash, callRequestHash],
        signatures: [],
      },
    });

    if (!("results" in result)) {
      throw new Error("expected Gateway signing result");
    }
    const gatewayKey = await deriveKey(TEST_PKP_KEY_HEX, "gateway-vm");
    const secpPublicKey = secp256k1.getPublicKey(gatewayKey);
    const solanaKeyPair = nacl.sign.keyPair.fromSeed(gatewayKey);

    expect(result.gatewaySigner).toBe("0x98073A349deF281dF771Ae2De7e6f47525e2D28B");
    expect(result.address).toBe(bs58.encode(solanaKeyPair.publicKey));

    const burnSignature = hexToBytes(result.results[0].signature);
    expect(
      secp256k1.verify(burnSignature.slice(0, 64), hexToBytes(burnIntentHash), secpPublicKey, {
        prehash: false,
        format: "compact",
      }),
    ).toBe(true);

    const callSignature = hexToBytes(result.results[1].signature);
    expect(callSignature).toHaveLength(64);
    expect(
      nacl.sign.detached.verify(
        hexToBytes(callRequestHash),
        callSignature,
        solanaKeyPair.publicKey,
      ),
    ).toBe(true);
  });

  it("rejects unsupported destination VM types", async () => {
    mockLit();
    const { gatewayMain } = await loadActions();

    await expect(
      gatewayMain({ pkpId: PKP_ID, action: "wallet", destinationVmType: "bitcoin-vm" }),
    ).rejects.toThrow("unsupported destinationVmType");
  });
});

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
        gatewayChainId: 1,
        accountIndex: 42,
        apiKeyIndex: 5,
        publicKey: "0x0102030405060708091011121314151617181920212223242526272829303132",
        txNonce: 7,
        gasPrice: 20_000_000_000n,
        gasLimit: 200_000,
      },
    })) as {
      changePubKey: {
        gatewayChainId: string;
        gateway: string;
        hash: string;
        data: string;
        rawTransaction: string;
        signature: string;
        transactionSignature: { r: string; s: string; v: string };
      };
    };

    expect(result.changePubKey.gatewayChainId).toBe("1");
    expect(result.changePubKey.gateway).toBe("0x3b4d794a66304f130a4db8f2551b0070dfcf5ca7");
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
          gatewayChainId: 1,
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

  it("signs ChangePubKey against the Robinhood Lighter gateway with EIP-155 v for chain 4663", async () => {
    mockLit();
    const { lighterMain } = await loadActions();

    const result = (await lighterMain({
      pkpId: PKP_ID,
      action: "changePubKey",
      changePubKey: {
        gatewayChainId: 4663,
        accountIndex: 42,
        apiKeyIndex: 7,
        publicKey: "0x3232323232323232323232323232323232323232323232323232323232323232",
        txNonce: 0,
        gasPrice: 100_000_000n,
        gasLimit: 200_000,
      },
    })) as {
      changePubKey: {
        gatewayChainId: string;
        gateway: string;
        rawTransaction: string;
        transactionSignature: { v: string };
      };
    };

    expect(result.changePubKey.gatewayChainId).toBe("4663");
    expect(result.changePubKey.gateway).toBe("0x94bab9693ba2f6358507effcbd372b0660afff9d");
    // v = yParity + chainId * 2 + 35 for chain 4663
    expect(["9361", "9362"]).toContain(result.changePubKey.transactionSignature.v);
    // The gateway address is the `to` field of the RLP-encoded transaction.
    expect(result.changePubKey.rawTransaction.toLowerCase()).toContain(
      "94bab9693ba2f6358507effcbd372b0660afff9d",
    );
  });

  it("rejects ChangePubKey for a gateway chain id that is not configured", async () => {
    mockLit();
    const { lighterMain } = await loadActions();

    await expect(
      lighterMain({
        pkpId: PKP_ID,
        action: "changePubKey",
        changePubKey: {
          gatewayChainId: 42161,
          accountIndex: 42,
          apiKeyIndex: 5,
          publicKey: "0x0102030405060708091011121314151617181920212223242526272829303132",
          txNonce: 7,
          gasPrice: 20_000_000_000n,
          gasLimit: 200_000,
        },
      }),
    ).rejects.toThrow("Lighter gateway chain id is not allowlisted");
  });

  it("requires gatewayChainId for ChangePubKey", async () => {
    mockLit();
    const { lighterMain } = await loadActions();

    await expect(
      lighterMain({
        pkpId: PKP_ID,
        action: "changePubKey",
        changePubKey: {
          accountIndex: 42,
          apiKeyIndex: 5,
          publicKey: "0x0102030405060708091011121314151617181920212223242526272829303132",
          txNonce: 7,
          gasPrice: 20_000_000_000n,
          gasLimit: 200_000,
        } as never,
      }),
    ).rejects.toThrow("changePubKey.gatewayChainId is required");
  });

  it("does not accept an API key allowlisted on another gateway", async () => {
    mockLit();
    const { lighterMain } = await loadActions();

    // apiKeyIndex 5 / this public key are allowlisted on chain 1 only.
    await expect(
      lighterMain({
        pkpId: PKP_ID,
        action: "changePubKey",
        changePubKey: {
          gatewayChainId: 4663,
          accountIndex: 42,
          apiKeyIndex: 5,
          publicKey: "0x0102030405060708091011121314151617181920212223242526272829303132",
          txNonce: 7,
          gasPrice: 20_000_000_000n,
          gasLimit: 200_000,
        },
      }),
    ).rejects.toThrow("Lighter API key is not allowlisted");
  });

  it("rejects every ChangePubKey on a gateway whose allowlist is empty", async () => {
    mockLit();
    const { lighterMain } = await loadActions();
    await expect(
      lighterMain({
        pkpId: PKP_ID,
        action: "changePubKey",
        changePubKey: {
          gatewayChainId: 999,
          accountIndex: 42,
          apiKeyIndex: 5,
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

describe("hedera-vm action", () => {
  it("returns the HKDF-derived EVM alias and compressed public key", async () => {
    const lit = mockLit();
    const { hederaMain } = await loadActions();

    const result = await hederaMain({ pkpId: PKP_ID, action: "wallet" });

    expect(lit.Actions.getPrivateKey).toHaveBeenCalledWith({ pkpId: PKP_ID });
    expect(result).toEqual({
      vmType: "hedera-vm",
      address: "0xa42D9C8832131a551b7D8836E1fFa759933a5326",
      publicKey: "0x03ae2b785d3eaff9164b032acfd694fda4dd13aaf594abb8e826a1ff13ec8e72bb",
    });
  });

  it("derives a distinct keypair from ethereum-vm", async () => {
    mockLit();
    const { ethereumMain, hederaMain } = await loadActions();

    const ethereum = (await ethereumMain({ pkpId: PKP_ID, action: "wallet" })) as {
      address: string;
    };
    const hedera = (await hederaMain({ pkpId: PKP_ID, action: "wallet" })) as { address: string };
    expect(hedera.address).not.toBe(ethereum.address);
  });

  it("rejects unknown actions", async () => {
    mockLit();
    const { hederaMain } = await loadActions();
    await expect(hederaMain({ pkpId: PKP_ID, action: "unknown" })).rejects.toThrow(
      "unknown action",
    );
  });

  it("requires withdrawRequest and attestation for sign", async () => {
    mockLit();
    const { hederaMain } = await loadActions();
    await expect(hederaMain({ pkpId: PKP_ID, action: "sign" })).rejects.toThrow(
      "withdrawRequest is required",
    );
    await expect(
      hederaMain({ pkpId: PKP_ID, action: "sign", withdrawRequest: {} as never }),
    ).rejects.toThrow("attestation is required");
  });

  it("emits canonical low-S 64-byte r‖s signatures over the given digest", async () => {
    mockLit();
    const { hederaMain } = await loadActions();

    const withdrawRequest = {
      chainId: "hedera",
      depository: "0x0000000000000000000000000000000000000000",
      currency: "0x0000000000000000000000000000000000000000",
      amount: "0",
      spenderChainId: "hedera",
      spender: "0x0000000000000000000000000000000000000000",
      receiver: "0x0000000000000000000000000000000000000000",
      data: "0x",
      nonce: `0x${"00".repeat(32)}`,
    };
    const { computeWithdrawRequestHash } = await import("../../../src/common/abi.js");
    const withdrawRequestHash = `0x${bytesToHex(computeWithdrawRequestHash(withdrawRequest))}`;
    const hashToSign = `0x${"11".repeat(32)}`;

    const result = (await hederaMain({
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
    const signature = hexToBytes(result.results[0].signature);
    // Hedera's SignaturePair.ECDSA_secp256k1 carries raw r‖s with no recovery
    // byte — 64 bytes, not the 65 the Ethereum action emits.
    expect(signature).toHaveLength(64);

    const wallet = (await hederaMain({ pkpId: PKP_ID, action: "wallet" })) as {
      publicKey: string;
    };
    const pubKey = hexToBytes(wallet.publicKey);
    const digest = hexToBytes(hashToSign);
    // The digest is already keccak256 of the transaction body, so it is
    // verified as-is rather than re-hashed.
    expect(secp256k1.verify(signature, digest, pubKey, { prehash: false })).toBe(true);
    expect(secp256k1.Signature.fromBytes(signature).hasHighS()).toBe(false);
  });
});

describe("atlas-vm action", () => {
  const ATLAS_DEPOSITORY = "0x1EF18983E5BA8D8F36c0baD4543588b8c28E70BD";
  const NOW_SECONDS = 1_700_000_000;
  const OTHER_ACCOUNT = "0x8f3a6c1e2b9d4f7a0c5e8b1d3f6a9c2e4b7d0f15";
  // The settlement SDK and payload builder tests pin the same transfer and transfer id
  const TRANSFER = {
    nonce: "7",
    expiresAt: String(NOW_SECONDS + 3600),
    signer: ATLAS_DEPOSITORY,
    fromAccountAddress: ATLAS_DEPOSITORY,
    toAccountAddress: "0x299d292ddb5c386bee485ed5ffc9226421ed2947",
    assetId: "2",
    amount: "1000000000000",
    memoHead: `0x${Buffer.from("ord-42").toString("hex").padEnd(64, "0")}`,
    memoTail: `0x${"00".repeat(31)}07`,
  };
  const TRANSFER_ID = "0x7b533dfc4b8b8bbb898f8c7291a32983c3dbec4bff489c705c4b3a223c2c4c6f";
  // Terms line published in the Atlas docs for testnet
  const BIND = {
    expiresAt: String(NOW_SECONDS + 3600),
    statements: [
      {
        label: "Atlas Terms of Use",
        value:
          "atlas-terms-of-use@testnet-2 0x28ef6460e39d51d0c9d9dc3c3635503ae039fbd91913cc43839e367bd7690120",
      },
      { label: "Request", value: "enableTrading" },
    ],
  };
  // EIP-712 hash of the bind, computed with two typed-data libraries from the published type string
  const BIND_DIGEST = "0x80d0560b686565ebe90e919aa05036ec95375cf0a165f6996e859143d6a43eee";

  const withdrawRequest = {
    chainId: "atlas-testnet",
    depository: ATLAS_DEPOSITORY.toLowerCase(),
    currency: `0x${"00".repeat(15)}02`,
    amount: "1000000",
    spenderChainId: "atlas-testnet",
    spender: "0x0000000000000000000000000000000000000000",
    receiver: TRANSFER.toAccountAddress,
    data: `0x${"00".repeat(31)}07`,
    nonce: `0x${"00".repeat(32)}`,
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW_SECONDS * 1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function signParams(hashesToSign: string[], transfer: AtlasTransfer) {
    const { computeWithdrawRequestHash } = await import("../../../src/common/abi.js");
    return {
      pkpId: PKP_ID,
      action: "sign",
      withdrawRequest,
      attestation: {
        chainId: 421614,
        allocator: "0x0000000000000000000000000000000000000000",
        withdrawRequestHash: `0x${bytesToHex(computeWithdrawRequestHash(withdrawRequest))}`,
        hashesToSign,
        signatures: [],
      },
      transfer,
    };
  }

  /** Attest the transfer's own digest under the given domain and ask the action to sign it. */
  async function signTransfer(transfer: AtlasTransfer, domain = TESTNET_DOMAIN) {
    const { atlasMain } = await loadActions();
    const { atlasTransferDigest } = await import("../../../src/vm/atlas-vm.js");
    const digest = `0x${bytesToHex(atlasTransferDigest(domain, transfer))}`;
    return atlasMain(await signParams([digest], transfer));
  }

  async function expectDepositorySignature(hash: string, signatureHex: string) {
    const signature = hexToBytes(signatureHex);
    expect([0, 1]).toContain(signature[64]);
    expect(BigInt(`0x${bytesToHex(signature.slice(32, 64))}`)).toBeLessThanOrEqual(
      secp256k1.Point.Fn.ORDER / 2n,
    );
    const recovered = secp256k1.Signature.fromBytes(signature.slice(0, 64))
      .addRecoveryBit(signature[64])
      .recoverPublicKey(hexToBytes(hash));
    const { addr } = await import("micro-eth-signer");
    expect(addr.fromPublicKey(recovered.toBytes(false))).toBe(ATLAS_DEPOSITORY);
  }

  it("returns the HKDF-derived Atlas owner address", async () => {
    const lit = mockLit();
    const { atlasMain } = await loadActions();

    const result = await atlasMain({ pkpId: PKP_ID, action: "wallet" });

    expect(lit.Actions.getPrivateKey).toHaveBeenCalledWith({ pkpId: PKP_ID });
    // Pinned: this address is the depository's Atlas account.
    expect(result).toEqual({ vmType: "atlas-vm", address: ATLAS_DEPOSITORY });
  });

  it("derives a distinct wallet from ethereum-vm", async () => {
    mockLit();
    const { ethereumMain, atlasMain } = await loadActions();

    const ethereum = (await ethereumMain({ pkpId: PKP_ID, action: "wallet" })) as {
      address: string;
    };
    const atlas = (await atlasMain({ pkpId: PKP_ID, action: "wallet" })) as { address: string };
    expect(atlas.address).not.toBe(ethereum.address);
  });

  it("derives the transfer id the SDK and the payload builder derive", async () => {
    const { atlasTransferDigest } = await import("../../../src/vm/atlas-vm.js");

    expect(`0x${bytesToHex(atlasTransferDigest(TESTNET_DOMAIN, TRANSFER))}`).toBe(TRANSFER_ID);
  });

  it("signs the attested transfer out of the depository", async () => {
    mockLit();

    const result = (await signTransfer(TRANSFER)) as {
      results: Array<{ hash: string; signature: string }>;
    };

    expect(result.results).toHaveLength(1);
    expect(result.results[0].hash).toBe(TRANSFER_ID);
    await expectDepositorySignature(TRANSFER_ID, result.results[0].signature);
  });

  it("rejects a transfer that is not from the depository", async () => {
    mockLit();

    await expect(signTransfer({ ...TRANSFER, fromAccountAddress: OTHER_ACCOUNT })).rejects.toThrow(
      "transfer is not from this depository",
    );
  });

  it("rejects a different signer even when the oracle attested its digest", async () => {
    mockLit();

    await expect(signTransfer({ ...TRANSFER, signer: OTHER_ACCOUNT })).rejects.toThrow(
      "transfer signer is not this depository",
    );
  });

  it("rejects a transfer whose memo tail is not its nonce", async () => {
    mockLit();

    await expect(signTransfer({ ...TRANSFER, memoTail: `0x${"00".repeat(32)}` })).rejects.toThrow(
      "transfer memoTail is not its nonce",
    );
    // Hex 0x10 is 16, whatever a decimal reading of the same digits says
    await expect(
      signTransfer({ ...TRANSFER, nonce: "10", memoTail: `${"00".repeat(31)}10` }),
    ).rejects.toThrow("transfer memoTail is not its nonce");
  });

  it("rejects a transfer that has expired", async () => {
    mockLit();

    await expect(signTransfer({ ...TRANSFER, expiresAt: String(NOW_SECONDS) })).rejects.toThrow(
      "transfer.expiresAt has passed",
    );
  });

  it("rejects a transfer dated further ahead than Atlas accepts", async () => {
    mockLit();
    const limit = NOW_SECONDS + 14 * 24 * 60 * 60;

    await expect(signTransfer({ ...TRANSFER, expiresAt: String(limit + 1) })).rejects.toThrow(
      "transfer.expiresAt is more than 1209600 seconds ahead",
    );
    await expect(signTransfer({ ...TRANSFER, expiresAt: String(limit) })).resolves.toBeDefined();
  });

  it("rejects a transfer attested under another domain chain id", async () => {
    mockLit();

    await expect(signTransfer(TRANSFER, { ...TESTNET_DOMAIN, chainId: 21337 })).rejects.toThrow(
      "attested hash is not this transfer under the configured domain",
    );
  });

  it("rejects an attested hash that is not the given transfer", async () => {
    mockLit();
    const { atlasMain } = await loadActions();

    await expect(
      atlasMain(await signParams([TRANSFER_ID], { ...TRANSFER, amount: "2000000000000" })),
    ).rejects.toThrow("attested hash is not this transfer");
  });

  it("rejects an attestation that does not carry exactly one hash", async () => {
    mockLit();
    const { atlasMain } = await loadActions();

    await expect(
      atlasMain(await signParams([`0x${"11".repeat(32)}`, `0x${"22".repeat(32)}`], TRANSFER)),
    ).rejects.toThrow("expected one attested hash, got 2");
  });

  it("requires the transfer", async () => {
    mockLit();
    const { atlasMain } = await loadActions();
    const { transfer: _, ...params } = await signParams([`0x${"11".repeat(32)}`], TRANSFER);

    await expect(atlasMain(params)).rejects.toThrow("transfer is required");
  });

  it("rejects signing and onboarding when the environment has no Atlas domain", async () => {
    mockLit();
    vi.resetModules();
    mockConfig();
    (globalThis as GlobalWithLit).__ATLAS_DOMAIN__ = "null";
    try {
      const { main: atlasMain } = await import("../../../src/vm/atlas-vm.js");
      await expect(atlasMain(await signParams([`0x${"11".repeat(32)}`], TRANSFER))).rejects.toThrow(
        "Atlas is not configured for this environment",
      );
      await expect(atlasMain({ pkpId: PKP_ID, action: "onboard", bind: BIND })).rejects.toThrow(
        "Atlas is not configured for this environment",
      );
    } finally {
      vi.resetModules();
    }
  });

  it("signs the bind that opens the depository's wallet", async () => {
    mockLit();
    const { atlasMain } = await loadActions();

    const result = (await atlasMain({ pkpId: PKP_ID, action: "onboard", bind: BIND })) as {
      results: Array<{ hash: string; signature: string }>;
    };

    expect(result.results).toHaveLength(1);
    expect(result.results[0].hash).toBe(BIND_DIGEST);
    await expectDepositorySignature(BIND_DIGEST, result.results[0].signature);
  });

  it.each([
    ["no request line", [BIND.statements[0]]],
    ["an extra line", [...BIND.statements, { label: "Builder", value: OTHER_ACCOUNT }]],
    ["lines out of order", [BIND.statements[1], BIND.statements[0]]],
    ["another terms label", [{ ...BIND.statements[0], label: "Terms" }, BIND.statements[1]]],
    [
      "a terms value without a content hash",
      [{ ...BIND.statements[0], value: "atlas-terms-of-use@testnet-2" }, BIND.statements[1]],
    ],
    ["another request", [BIND.statements[0], { label: "Request", value: "enableBuilder" }]],
  ])("rejects a bind with %s", async (_, statements) => {
    mockLit();
    const { atlasMain } = await loadActions();

    await expect(
      atlasMain({ pkpId: PKP_ID, action: "onboard", bind: { ...BIND, statements } }),
    ).rejects.toThrow("bind statements must be the terms in force and the enableTrading request");
  });

  it("rejects a bind that has expired or is dated more than a day ahead", async () => {
    mockLit();
    const { atlasMain } = await loadActions();
    const onboard = (expiresAt: number) =>
      atlasMain({
        pkpId: PKP_ID,
        action: "onboard",
        bind: { ...BIND, expiresAt: String(expiresAt) },
      });

    await expect(onboard(NOW_SECONDS)).rejects.toThrow("bind.expiresAt has passed");
    await expect(onboard(NOW_SECONDS + 86_401)).rejects.toThrow(
      "bind.expiresAt is more than 86400 seconds ahead",
    );
    await expect(onboard(NOW_SECONDS + 86_400)).resolves.toBeDefined();
  });

  it("requires the bind", async () => {
    mockLit();
    const { atlasMain } = await loadActions();

    await expect(atlasMain({ pkpId: PKP_ID, action: "onboard" })).rejects.toThrow(
      "bind is required",
    );
  });

  it("rejects unknown actions", async () => {
    mockLit();
    const { atlasMain } = await loadActions();
    await expect(atlasMain({ pkpId: PKP_ID, action: "unknown" })).rejects.toThrow("unknown action");
  });
});
