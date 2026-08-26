import { describe, expect, it } from "vitest";
import dev from "../environments/dev.json" with { type: "json" };
import stag from "../environments/stag.json" with { type: "json" };
import prod from "../environments/prod.json" with { type: "json" };

describe("environment config", () => {
  it("contains dev deposit address manager configuration", () => {
    expect(dev).toEqual({
      name: "dev",
      depositAddressManagerAddress: "0xf4d50837c674ce6ec05527a5233651e2c842cefa",
      hubEvmChainId: 537724,
      allowedOracles: [
        "0xcda3c24706c1a5eea958a988693e8a838d520af9",
        "0xf24a399259f47c6360d00da3793eca9cc6ad1caa",
      ],
      oracleSignatureThreshold: 2,
    });
  });

  it("contains stag deposit address manager configuration", () => {
    expect(stag).toEqual({
      name: "stag",
      depositAddressManagerAddress: "0xe3e1722cf7a58eea50989d3e0a5ee05428e988bb",
      hubEvmChainId: 537713,
      allowedOracles: [
        "0x3001dfd9e77675afd7d3dfd6b2183399ca4f801e",
        "0x5c8031dfae2ad620f908e7e50f88e1d4835697cd",
        "0x8e4716438b4be24a0e1d1b7375dff45727ca120a",
      ],
      oracleSignatureThreshold: 2,
    });
  });

  it("contains prod deposit address manager configuration", () => {
    expect(prod).toEqual({
      name: "prod",
      depositAddressManagerAddress: "0xde325dc0eab913c27cee4c36d39e9dddca1aabf8",
      hubEvmChainId: 537713,
      allowedOracles: [
        "0x2c598f73a5ab65c0510fd8efb740826d291cab0e",
        "0x5be2dd28f7810582ed6dc910fd8693878a1d90f2",
        "0xa41716ff5a7d4ad22f83b7cb74d9af9767a96a52",
        "0x23f1518173769d40bd24dae168c0879bd02d9b5f",
        "0xeae66bc5500976e6a681d3dd0112baba0ef95149",
      ],
      oracleSignatureThreshold: 2,
    });
  });
});
