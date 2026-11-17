// ABOUTME: relay-router codec tests: routed transfer payloads vs the Hub builder,
// ABOUTME: bundle/call roundtrips, PDAs, call compression and the execution id.

import { BorshCoder, Idl } from "@coral-xyz/anchor"
import { PublicKey } from "@solana/web3.js"
import { sha256 } from "js-sha256"
import { encodeAbiParameters, parseAbiParameters } from "viem"
import { describe, it, expect } from "vitest"

import { RelayDepositoryIdl } from "../src/messages/common/solana-vm/idls/RelayDepositoryIdl"
import { RelayRouterIdl } from "../src/messages/common/solana-vm/idls/RelayRouterIdl"
import {
  ROUTED_TRANSFER_REQUEST_PREFIX,
  SolanaRoutedTransferRequest,
  decodeSolanaRoutedTransferRequest,
  encodeSolanaRoutedTransferRequest,
  getSolanaRoutedTransferRequestHash,
  getSolanaUsedRequestAddress,
} from "../src/messages/common/solana-vm/routed-transfer"
import {
  SOLANA_NATIVE_MINT,
  SolanaRouterBundle,
  decodeSolanaRoutedWithdrawalData,
  decodeSolanaRouterBundle,
  encodeSolanaRoutedWithdrawalData,
  encodeSolanaRouterBundle,
  encodeSolanaRouterReleaseData,
  encodeSolanaRouterSettleData,
  getSolanaRouterAuthority,
  getSolanaRouterConfigAddress,
  getSolanaRouterDepositoryRole,
  encodeSolanaRouterInitializeData,
  encodeSolanaRouterGrantDepositoryRoleData,
  encodeSolanaRouterRevokeDepositoryRoleData,
  encodeSolanaRouterSetOwnerData,
  getSolanaRouterBundleAddress,
  getSolanaRouterBundleHash,
  getSolanaRouterBundlePda,
  toSolanaBundleFillMint,
  toSolanaBundleWithdrawMint,
} from "../src/messages/common/solana-vm/router"
import {
  DecodedSolanaVmWithdrawal,
  decodeWithdrawal,
  encodeWithdrawal,
  getDecodedWithdrawalId,
} from "../src/messages/v2.1/depository-withdrawal"
import {
  ExecuteAndWithdrawRequest,
  computeExecutionId,
  encodeWithdrawRequestAdditionalData,
  getExecuteAndWithdrawRequestHash,
} from "../src/messages/v2.3/withdrawal"

const key = (hex: string) => new PublicKey(Buffer.from(hex, "hex")).toBase58()

const ROUTER = "9QybjuydfDYwJkdDLMJJaHEcQPaYeRoiJ5cYj7qLd5Su"
const DEPOSITORY = "99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2"

// Produced by the SolanaVmPayloadBuilder routed mode
const hubVector = {
  request: {
    domain:
      "0x5fe7f977e71dba2ea1a68e21057beebb9be2ac30c6410aa38d4f3fbe41dcffd2",
    recipient: key(
      "d354d13253ad4f7764f5c933ccadca795c052d143e2721ff5716848f1fe390cc"
    ),
    token: key(
      "471500e6828e391e3b31326faa896e01212f976de1ad90ecb7823a2b96e9eb85"
    ),
    amount: "1000000",
    nonce: "14041958522398838600",
    expiration: 1700000300,
    vaultAddress: key(
      "1fa427265aebc381e466efb16f55b95fc3d44af745a3c52f6c599d3a7ec6b19a"
    ),
    router: key(
      "7d01d9c59e2296807ea0d4df99ccf825c028060cba6aa00c2ab482dad32161be"
    ),
  } satisfies SolanaRoutedTransferRequest,
  payload:
    "0x52656c61794465706f7369746f72793a526f757465645472616e73666572526571756573743a76315fe7f977e71dba2ea1a68e21057beebb9be2ac30c6410aa38d4f3fbe41dcffd2d354d13253ad4f7764f5c933ccadca795c052d143e2721ff5716848f1fe390cc01471500e6828e391e3b31326faa896e01212f976de1ad90ecb7823a2b96e9eb8540420f0000000000480f5aeee00edfc22cf25365000000001fa427265aebc381e466efb16f55b95fc3d44af745a3c52f6c599d3a7ec6b19a7d01d9c59e2296807ea0d4df99ccf825c028060cba6aa00c2ab482dad32161be",
  hash: "0xbaac8f151b7e4a8db284ac7c47affad9d7dcd8c8df0f6235b80dbe0e2ca887a3",
  executor: "d1c24bcb2cf2f78791a8e63d2e528be4e923944900af6d8826f0063e91d1515f",
}

const routedWithdrawal: DecodedSolanaVmWithdrawal = {
  vmType: "solana-vm",
  withdrawal: hubVector.request,
}

describe("solana-vm routed transfer request", () => {
  it("matches the Hub payload builder byte for byte", () => {
    expect(ROUTED_TRANSFER_REQUEST_PREFIX.toString("utf8")).toBe(
      "RelayDepository:RoutedTransferRequest:v1"
    )
    expect(
      "0x" +
        encodeSolanaRoutedTransferRequest(hubVector.request).toString("hex")
    ).toBe(hubVector.payload)
    expect(getSolanaRoutedTransferRequestHash(hubVector.request)).toBe(
      hubVector.hash
    )
  })

  it("rejects malformed amounts and domains", () => {
    expect(() =>
      encodeSolanaRoutedTransferRequest({
        ...hubVector.request,
        amount: "-100",
      })
    ).toThrow("u64")
    expect(() =>
      encodeSolanaRoutedTransferRequest({
        ...hubVector.request,
        domain: "0x1234",
      })
    ).toThrow("32-byte hex")
  })

  it("routes the withdrawal codec through the routed type", () => {
    expect(encodeWithdrawal(routedWithdrawal)).toBe(hubVector.payload)
    expect(getDecodedWithdrawalId(routedWithdrawal)).toBe(hubVector.hash)
    expect(decodeWithdrawal(hubVector.payload, "solana-vm")).toEqual(
      routedWithdrawal
    )
    expect(
      getDecodedWithdrawalId(decodeWithdrawal(hubVector.payload, "solana-vm"))
    ).toBe(hubVector.hash)
  })

  it("never decodes a routed payload as a plain TransferRequest", () => {
    // A routed payload whose prefix happens to parse under the plain layout
    const plainCoder = new BorshCoder(RelayDepositoryIdl as Idl)
    const routed = Buffer.from(hubVector.payload.slice(2), "hex")
    routed[64] = 0
    const aliased = "0x" + routed.toString("hex")
    expect(() =>
      plainCoder.types.decode("TransferRequest", routed)
    ).not.toThrow()

    const decoded = decodeWithdrawal(aliased, "solana-vm")
    expect(decoded.withdrawal.router).toBeDefined()
    expect(encodeWithdrawal(decoded)).toBe(aliased)
    expect(getDecodedWithdrawalId(decoded)).toBe("0x" + sha256(routed))
  })

  it("returns undefined for plain payloads and leaves them unchanged", () => {
    const plain: DecodedSolanaVmWithdrawal = {
      vmType: "solana-vm",
      withdrawal: { ...hubVector.request, router: undefined },
    }
    delete plain.withdrawal.router
    const encoded = encodeWithdrawal(plain)

    expect(decodeSolanaRoutedTransferRequest(encoded)).toBeUndefined()
    expect(decodeWithdrawal(encoded, "solana-vm")).toEqual(plain)
    expect(getDecodedWithdrawalId(plain)).not.toBe(hubVector.hash)
  })

  it("rejects trailing bytes after a routed request", () => {
    expect(() =>
      decodeSolanaRoutedTransferRequest(hubVector.payload + "00")
    ).toThrow("Invalid routed transfer request payload")
  })

  it("rejects routed payloads that are not strict 0x hex", () => {
    for (const payload of [
      hubVector.payload + "f",
      hubVector.payload + "zz",
      hubVector.payload.slice(2),
    ]) {
      expect(() => decodeSolanaRoutedTransferRequest(payload)).toThrow(
        "Invalid hex string"
      )
    }
  })

  it("encodes native SOL as None", () => {
    const native = {
      ...hubVector.request,
      token: "11111111111111111111111111111111",
    }
    const decoded = decodeSolanaRoutedTransferRequest(
      encodeSolanaRoutedTransferRequest(native)
    )
    expect(decoded).toEqual(native)
  })

  it("derives the used_request PDA from the routed id", () => {
    const [expected] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("used_request"),
        Buffer.from(hubVector.hash.slice(2), "hex"),
      ],
      new PublicKey(DEPOSITORY)
    )
    expect(getSolanaUsedRequestAddress(DEPOSITORY, hubVector.hash)).toBe(
      expected.toBase58()
    )
    expect(() =>
      getSolanaUsedRequestAddress(DEPOSITORY, hubVector.hash.slice(0, -2))
    ).toThrow("32-byte hex")
    expect(() => getSolanaUsedRequestAddress(DEPOSITORY, "0xabc")).toThrow(
      "Invalid hex string"
    )
  })
})

describe("solana-vm routed withdrawal data", () => {
  const data = {
    version: 1,
    router: ROUTER,
    executor: key(hubVector.executor),
  }

  it("encodes as abi.encode(uint8, bytes32, bytes32)", () => {
    const encoded = encodeSolanaRoutedWithdrawalData(data)
    expect(encoded).toBe(
      encodeAbiParameters(parseAbiParameters("uint8, bytes32, bytes32"), [
        1,
        "0x7d01d9c59e2296807ea0d4df99ccf825c028060cba6aa00c2ab482dad32161be",
        `0x${hubVector.executor}`,
      ])
    )
    expect(decodeSolanaRoutedWithdrawalData(encoded)).toEqual(data)
  })

  it("rejects unknown versions", () => {
    expect(() =>
      encodeSolanaRoutedWithdrawalData({ ...data, version: 2 })
    ).toThrow("Unsupported routed withdrawal data version")
    const v2 = encodeAbiParameters(
      parseAbiParameters("uint8, bytes32, bytes32"),
      [2, `0x${"11".repeat(32)}`, `0x${"22".repeat(32)}`]
    )
    expect(() => decodeSolanaRoutedWithdrawalData(v2)).toThrow(
      "Unsupported routed withdrawal data version"
    )
  })

  it("is emitted as the solana-vm request data only when routed", () => {
    expect(encodeWithdrawRequestAdditionalData({ vmType: "solana-vm" })).toBe(
      "0x"
    )
    expect(
      encodeWithdrawRequestAdditionalData({
        vmType: "solana-vm",
        additionalData: {
          "solana-vm": { router: data.router, executor: data.executor },
        },
      })
    ).toBe(encodeSolanaRoutedWithdrawalData(data))
  })
})

describe("solana-vm currency mapping", () => {
  it("maps the zero currency to None / the native mint", () => {
    for (const zero of [
      "",
      "0x",
      "0x" + "00".repeat(32),
      "11111111111111111111111111111111",
    ]) {
      expect(toSolanaBundleWithdrawMint(zero)).toBeNull()
      expect(toSolanaBundleFillMint(zero)).toBe(SOLANA_NATIVE_MINT)
    }
  })

  it("passes SPL mints through in base58", () => {
    const usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
    const usdcHex = "0x" + new PublicKey(usdc).toBuffer().toString("hex")
    expect(toSolanaBundleWithdrawMint(usdc)).toBe(usdc)
    expect(toSolanaBundleWithdrawMint(usdcHex)).toBe(usdc)
    expect(toSolanaBundleFillMint(usdcHex)).toBe(usdc)
  })
})

const A = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
const B = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
const P2 = "MemoSq4gqABAXKb96qnH8TxNnkkqtWW8oL5hhLmXtCK"

const executionRequest: ExecuteAndWithdrawRequest = {
  inChainId: "base",
  inCurrency: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  outChainId: "solana",
  outCurrency:
    "0xc6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d61",
  outAmountMinimum: "4990000",
  depository:
    "0x0102030405060708091011121314151617181920212223242526272829303132",
  orderAddress: "0x3333333333333333333333333333333333333333",
  receiver:
    "0xd354d13253ad4f7764f5c933ccadca795c052d143e2721ff5716848f1fe390cc",
  data: "0x0001",
  fees: [
    { recipient: "0x1111111111111111111111111111111111111111", amount: "1000" },
    { recipient: "0x2222222222222222222222222222222222222222", amount: "25" },
  ],
  nonce: "0x4444444444444444444444444444444444444444444444444444444444444444",
  deadline: "1893456000",
}

describe("computeExecutionId", () => {
  it("matches RelayExecutor.hashExecuteAndWithdrawRequest with an empty receiver", () => {
    // Read from a deployed RelayExecutor (forge, chain id 8453)
    const executor = "0xF62849F9A0B5Bf2913b396098F7c7019b51A820a"
    const expected =
      "0x261c17c292d6bcbde6ae5e230a85a554a501fc5364909bf864b733d8e0383734"

    expect(computeExecutionId(8453, executor, executionRequest)).toBe(expected)
    expect(
      getExecuteAndWithdrawRequestHash(8453, executor, {
        ...executionRequest,
        receiver: "0x",
      })
    ).toBe(expected)
    expect(
      getExecuteAndWithdrawRequestHash(8453, executor, executionRequest)
    ).not.toBe(expected)
  })
})

const bundle: SolanaRouterBundle = {
  version: 1,
  orderId: "0x" + "0a".repeat(32),
  executionId:
    "0x261c17c292d6bcbde6ae5e230a85a554a501fc5364909bf864b733d8e0383734",
  executor: key(hubVector.executor),
  depository: DEPOSITORY,
  withdrawMint: A,
  minimumWithdrawAmount: "1000000",
  fillMint: SOLANA_NATIVE_MINT,
  recipient: B,
  minimumAmount: "5000000",
  // The router runs no user calls in v1
  callAccounts: [],
  calls: [],
}

describe("relay-router bundle", () => {
  it("pins the borsh encoding, hash and PDA", () => {
    expect(
      "0x" + encodeSolanaRouterBundle(bundle).toString("hex")
    ).toMatchInlineSnapshot(
      `"0x010a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a261c17c292d6bcbde6ae5e230a85a554a501fc5364909bf864b733d8e0383734d1c24bcb2cf2f78791a8e63d2e528be4e923944900af6d8826f0063e91d1515f792689378ecd51d80406eb0caa3b62795beb10b6c5dc96bc2e0df03cbfee1abf01c6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d6140420f0000000000069b8857feab8184fb687f634618c035dac439dc1aeb3b5598a0f0000000000106ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9404b4c00000000000000000000000000"`
    )
    expect(getSolanaRouterBundleHash(bundle)).toMatchInlineSnapshot(
      `"0x8b6e8059654b31b7c1483ef9e5ad1d474222778558e790f45d83c4cacfe042b5"`
    )
    expect(getSolanaRouterBundlePda(bundle, ROUTER)).toMatchInlineSnapshot(`
      {
        "address": "859QPdV9yayCRTfk8g6G8RPWm7Y5Vw8iSZQnz2LfxfQQ",
        "bump": 252,
      }
    `)
  })

  it("roundtrips, including native SOL withdrawals", () => {
    expect(decodeSolanaRouterBundle(encodeSolanaRouterBundle(bundle))).toEqual(
      bundle
    )
    const native = {
      ...bundle,
      withdrawMint: null,
      callAccounts: [],
      calls: [],
    }
    expect(
      decodeSolanaRouterBundle(
        "0x" + encodeSolanaRouterBundle(native).toString("hex")
      )
    ).toEqual(native)
    expect(() =>
      decodeSolanaRouterBundle(
        Buffer.concat([encodeSolanaRouterBundle(bundle), Buffer.from([0])])
      )
    ).toThrow("Failed to decode router bundle")
  })

  it("hashes the borsh bytes with sha256", () => {
    expect(getSolanaRouterBundleHash(bundle)).toBe(
      "0x" + sha256(encodeSolanaRouterBundle(bundle))
    )
  })

  it("derives the bundle PDA and router authority like the program", () => {
    const [address, bump] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("bundle"),
        Buffer.from(sha256.arrayBuffer(encodeSolanaRouterBundle(bundle))),
      ],
      new PublicKey(ROUTER)
    )
    expect(getSolanaRouterBundlePda(bundle, ROUTER)).toEqual({
      address: address.toBase58(),
      bump,
    })
    expect(getSolanaRouterBundleAddress(bundle, ROUTER)).toBe(
      address.toBase58()
    )

    const [authority] = PublicKey.findProgramAddressSync(
      [Buffer.from("depository_caller")],
      new PublicKey(ROUTER)
    )
    expect(getSolanaRouterAuthority(ROUTER)).toBe(authority.toBase58())
  })

  it("enforces the version, empty calls and strict inputs", () => {
    expect(() => encodeSolanaRouterBundle({ ...bundle, version: 2 })).toThrow(
      "Unsupported router bundle version"
    )
    expect(() =>
      encodeSolanaRouterBundle({
        ...bundle,
        callAccounts: [{ pubkey: P2, isWritable: false }],
        calls: [{ programIdIndex: 0, accountIndexes: [0], data: "0x01" }],
      })
    ).toThrow("calls are not supported")
    for (const amount of ["-5", " 5", "1.5", "007", (2n ** 64n).toString()]) {
      expect(() =>
        encodeSolanaRouterBundle({ ...bundle, minimumAmount: amount })
      ).toThrow("u64")
    }
    for (const id of [
      bundle.executionId + "f",
      bundle.executionId.slice(0, -2) + "zz",
      bundle.executionId.slice(2),
    ]) {
      expect(() =>
        encodeSolanaRouterBundle({ ...bundle, executionId: id })
      ).toThrow("Invalid hex string")
    }
    expect(() =>
      encodeSolanaRouterBundle({
        ...bundle,
        executionId: bundle.executionId + "00",
      })
    ).toThrow("32-byte hex")
    expect(() =>
      encodeSolanaRouterBundle({ ...bundle, withdrawMint: SOLANA_NATIVE_MINT })
    ).toThrow("cannot be the native mint")
  })

  it("decodes only strict 0x hex", () => {
    const hex = "0x" + encodeSolanaRouterBundle(bundle).toString("hex")
    for (const data of [hex + "f", hex + "zz", hex.slice(2)]) {
      expect(() => decodeSolanaRouterBundle(data)).toThrow("Invalid hex string")
    }
  })
})

describe("relay-router instruction data", () => {
  const discriminator = (name: string) =>
    Buffer.from(sha256.arrayBuffer(`global:${name}`)).subarray(0, 8)
  const coder = new BorshCoder(RelayRouterIdl as Idl)

  it("uses the Anchor sighash discriminators", () => {
    for (const ix of RelayRouterIdl.instructions) {
      expect(Buffer.from(ix.discriminator)).toEqual(discriminator(ix.name))
    }
  })

  it("encodes release and settle args in IDL order", () => {
    const { bump } = getSolanaRouterBundlePda(bundle, ROUTER)
    const bundleHash = getSolanaRouterBundleHash(bundle)

    const release = encodeSolanaRouterReleaseData({
      bundleHash,
      bump,
      request: hubVector.request,
    })
    expect(release.subarray(0, 8)).toEqual(discriminator("release"))
    expect(release.subarray(41)).toEqual(
      Buffer.from(hubVector.payload.slice(2), "hex").subarray(
        ROUTED_TRANSFER_REQUEST_PREFIX.length
      )
    )
    const decodedRelease = coder.instruction.decode(release)
    expect(decodedRelease?.name).toBe("release")
    expect(
      Buffer.from(
        (decodedRelease!.data as { bundle_hash: number[] }).bundle_hash
      )
    ).toEqual(Buffer.from(bundleHash.slice(2), "hex"))

    const settle = encodeSolanaRouterSettleData({ bundle, bump })
    expect(settle.subarray(0, 8)).toEqual(discriminator("settle"))
    expect(settle.subarray(8, -1)).toEqual(encodeSolanaRouterBundle(bundle))
    expect(settle[settle.length - 1]).toBe(bump)
    expect(coder.instruction.decode(settle)?.name).toBe("settle")
  })

  it("uses the Anchor account discriminators and decodes RouterConfig", () => {
    for (const account of RelayRouterIdl.accounts) {
      expect(Buffer.from(account.discriminator)).toEqual(
        Buffer.from(sha256.arrayBuffer(`account:${account.name}`)).subarray(
          0,
          8
        )
      )
    }
    const owner = new PublicKey(DEPOSITORY)
    const data = Buffer.concat([
      Buffer.from(RelayRouterIdl.accounts[0].discriminator),
      owner.toBuffer(),
    ])
    expect(coder.accounts.decode("RouterConfig", data).owner.toBase58()).toBe(
      DEPOSITORY
    )
  })

  it("numbers the v1 router errors", () => {
    expect(RelayRouterIdl.errors.filter((error) => error.code >= 6014)).toEqual(
      [
        {
          code: 6014,
          name: "CallsNotSupported",
          msg: "Bundle calls are not supported",
        },
        {
          code: 6015,
          name: "DepositoryNotAllowed",
          msg: "Depository not allowed",
        },
        { code: 6016, name: "Unauthorized", msg: "Unauthorized" },
        {
          code: 6017,
          name: "SameCurrencyNotSupported",
          msg: "Withdraw and fill currency must differ",
        },
        { code: 6018, name: "InvalidOwner", msg: "Invalid owner" },
      ]
    )
    RelayRouterIdl.errors.forEach((error, index) =>
      expect(error.code).toBe(6000 + index)
    )
  })

  it("lists depository_role as release account 14", () => {
    const release = RelayRouterIdl.instructions.find(
      (ix) => ix.name === "release"
    )!
    expect(release.accounts).toHaveLength(15)
    expect(release.accounts[14]).toEqual({ name: "depository_role" })
  })

  it("encodes the owner instructions", () => {
    const owner = key(hubVector.executor)
    expect(encodeSolanaRouterInitializeData({ owner })).toEqual(
      Buffer.concat([
        discriminator("initialize"),
        new PublicKey(owner).toBuffer(),
      ])
    )
    const setOwner = encodeSolanaRouterSetOwnerData({ newOwner: owner })
    expect(setOwner).toEqual(
      Buffer.concat([
        discriminator("set_owner"),
        new PublicKey(owner).toBuffer(),
      ])
    )
    expect(coder.instruction.decode(setOwner)?.name).toBe("set_owner")
    for (const [name, encode] of [
      ["grant_depository_role", encodeSolanaRouterGrantDepositoryRoleData],
      ["revoke_depository_role", encodeSolanaRouterRevokeDepositoryRoleData],
    ] as const) {
      const data = encode({ depository: DEPOSITORY })
      expect(data).toEqual(
        Buffer.concat([
          discriminator(name),
          new PublicKey(DEPOSITORY).toBuffer(),
        ])
      )
      expect(coder.instruction.decode(data)?.name).toBe(name)
    }
  })
})

describe("relay-router config and depository role", () => {
  it("derives the PDAs like the program", () => {
    const [config] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      new PublicKey(ROUTER)
    )
    expect(getSolanaRouterConfigAddress(ROUTER)).toBe(config.toBase58())

    const [role] = PublicKey.findProgramAddressSync(
      [Buffer.from("depository_role"), new PublicKey(DEPOSITORY).toBuffer()],
      new PublicKey(ROUTER)
    )
    expect(getSolanaRouterDepositoryRole(ROUTER, DEPOSITORY)).toBe(
      role.toBase58()
    )
  })
})
