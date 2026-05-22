import { describe, expect, it } from "vitest";
import dev from "../environments/dev.json" with { type: "json" };

describe("environment config", () => {
  it("contains dev deposit address manager configuration", () => {
    expect(dev).toEqual({
      name: "dev",
      depositAddressManagerAddress: "0xd03250b221f709abe58ff4a177d50d01d922d974",
      hubEvmChainId: 421614,
      allowedOracles: [
        "0xcda3c24706c1a5eea958a988693e8a838d520af9",
        "0xf24a399259f47c6360d00da3793eca9cc6ad1caa",
      ],
      oracleSignatureThreshold: 2,
    });
  });
});
