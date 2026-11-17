import { describe, expect, it } from "vitest";
import { ACTION_VERSIONS, validateEnvironment } from "../../scripts/env.js";

const ORACLE = "0x2c598f73a5ab65c0510fd8efb740826d291cab0e";
const MAINNET_GATEWAY = "0x3b4d794a66304f130a4db8f2551b0070dfcf5ca7";
const ROBINHOOD_GATEWAY = "0x94bab9693ba2f6358507effcbd372b0660afff9d";
const API_KEY = { apiKeyIndex: 4, publicKey: "0x0102" };

function baseEnv() {
  return {
    name: "dev",
    allocatorAddress: "0x95bb2652BaA8a1177f750d92384527c5814f5254",
    hubEvmChainId: 537724,
    allowedOracles: [ORACLE],
    oracleSignatureThreshold: 1,
  };
}

describe("validateEnvironment", () => {
  it("exports the action version registered by setup", () => {
    expect(ACTION_VERSIONS).toEqual({ dev: "v3", stag: "v3", prod: "v3", test: "v3" });
  });

  it("accepts an environment without Lighter gateways", () => {
    expect(() => validateEnvironment(baseEnv(), "test.json")).not.toThrow();
  });

  it("accepts multiple gateways, including one with an empty allowlist", () => {
    const env = {
      ...baseEnv(),
      lighterGateways: [
        { chainId: 1, gateway: MAINNET_GATEWAY, allowedApiKeys: [API_KEY] },
        { chainId: 4663, gateway: ROBINHOOD_GATEWAY, allowedApiKeys: [] },
      ],
    };
    expect(() => validateEnvironment(env, "test.json")).not.toThrow();
  });

  it("rejects an empty gateway list", () => {
    expect(() => validateEnvironment({ ...baseEnv(), lighterGateways: [] }, "test.json")).toThrow(
      "lighterGateways must be a non-empty array",
    );
  });

  it("rejects duplicate chain ids", () => {
    const env = {
      ...baseEnv(),
      lighterGateways: [
        { chainId: 1, gateway: MAINNET_GATEWAY, allowedApiKeys: [] },
        { chainId: 1, gateway: ROBINHOOD_GATEWAY, allowedApiKeys: [] },
      ],
    };
    expect(() => validateEnvironment(env, "test.json")).toThrow(
      "lighterGateways[].chainId must be unique",
    );
  });

  it("rejects a non-positive chain id", () => {
    const env = {
      ...baseEnv(),
      lighterGateways: [{ chainId: 0, gateway: MAINNET_GATEWAY, allowedApiKeys: [] }],
    };
    expect(() => validateEnvironment(env, "test.json")).toThrow(
      "lighterGateways[].chainId must be a positive integer",
    );
  });

  it("rejects a malformed gateway address", () => {
    const env = {
      ...baseEnv(),
      lighterGateways: [{ chainId: 1, gateway: "0x1234", allowedApiKeys: [] }],
    };
    expect(() => validateEnvironment(env, "test.json")).toThrow(
      "lighterGateways[].gateway must be a 20-byte hex address",
    );
  });

  it("rejects a malformed API key entry", () => {
    const env = {
      ...baseEnv(),
      lighterGateways: [
        {
          chainId: 1,
          gateway: MAINNET_GATEWAY,
          allowedApiKeys: [{ apiKeyIndex: 300, publicKey: "0x0102" }],
        },
      ],
    };
    expect(() => validateEnvironment(env, "test.json")).toThrow(
      "lighterGateways[].allowedApiKeys[].apiKeyIndex must be a uint8",
    );
    env.lighterGateways[0].allowedApiKeys = [{ apiKeyIndex: 4, publicKey: "0x123" }];
    expect(() => validateEnvironment(env, "test.json")).toThrow(
      "lighterGateways[].allowedApiKeys[].publicKey must be non-empty hex",
    );
  });

  it("rejects the legacy single-gateway fields", () => {
    for (const legacyField of [
      "lighterGateway",
      "lighterGatewayChainId",
      "lighterAllowedApiKeys",
    ]) {
      const env = { ...baseEnv(), [legacyField]: "anything" };
      expect(() => validateEnvironment(env, "test.json")).toThrow(
        `${legacyField} is no longer supported; use lighterGateways`,
      );
    }
  });

  it("accepts an Atlas domain and rejects malformed ones", () => {
    const atlasDomain = { chainId: 21337, salt: `0x${"11".repeat(32)}` };
    expect(() => validateEnvironment({ ...baseEnv(), atlasDomain }, "test.json")).not.toThrow();
    expect(() =>
      validateEnvironment(
        { ...baseEnv(), atlasDomain: { ...atlasDomain, chainId: 0 } },
        "test.json",
      ),
    ).toThrow("atlasDomain.chainId must be a positive integer");
    expect(() =>
      validateEnvironment(
        { ...baseEnv(), atlasDomain: { ...atlasDomain, salt: "0x11" } },
        "test.json",
      ),
    ).toThrow("atlasDomain.salt must be a 32-byte hex value");
    expect(() =>
      validateEnvironment({ ...baseEnv(), atlasDomain: { chainId: 21337 } }, "test.json"),
    ).toThrow("atlasDomain.salt must be a 32-byte hex value");
    expect(() =>
      validateEnvironment(
        {
          ...baseEnv(),
          atlasDomain: { chainId: 21337, verifyingContract: `0x${"00".repeat(20)}` },
        },
        "test.json",
      ),
    ).toThrow("atlasDomain.verifyingContract is no longer supported; use atlasDomain.salt");
    expect(() => validateEnvironment({ ...baseEnv(), atlasDomain: null }, "test.json")).toThrow(
      "atlasDomain must be an object",
    );
  });
});
