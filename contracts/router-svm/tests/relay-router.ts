import anchor from "@coral-xyz/anchor"
import { secp256k1 } from "@noble/curves/secp256k1"
import { keccak_256 } from "@noble/hashes/sha3"
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  AuthorityType,
  NATIVE_MINT,
  NATIVE_MINT_2022,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCreateNativeMintInstruction,
  createMint,
  createSetAuthorityInstruction,
  createSyncNativeInstruction,
  createTransferCheckedInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token"
import {
  AddressLookupTableProgram,
  Ed25519Program,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js"
import { assert } from "chai"
import { createHash, randomBytes } from "crypto"
import fs from "fs"
import path from "path"
import nacl from "tweetnacl"

const { BN } = anchor

// Runs against the upgraded depository loaded at its program id (see Anchor.toml)
describe("Relay Router", () => {
  const provider = anchor.AnchorProvider.env()
  anchor.setProvider(provider)
  const connection = provider.connection

  const loadIdl = (file: string) =>
    JSON.parse(fs.readFileSync(path.resolve(file), "utf8"))
  const router = new anchor.Program(
    loadIdl("target/idl/relay_router.json"),
    provider
  )
  const depository = new anchor.Program(
    loadIdl("../depository-svm/target/idl/relay_depository.json"),
    provider
  )

  const MEMO_PROGRAM_ID = new PublicKey(
    "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"
  )
  const ROUTED_TRANSFER_REQUEST_PREFIX = Buffer.from(
    "RelayDepository:RoutedTransferRequest:v1"
  )

  const owner = Keypair.fromSecretKey(
    Buffer.from(
      "5223911e0fbfb0b8d5880ebea5711d5d7754387950c08b52c0eaf127facebd455e28ef570e8aed9ecef8a89f5c1a90739080c05df9e9c8ca082376ef93a02b2e",
      "hex"
    )
  )
  const allocator = Keypair.generate()
  const executor = Keypair.generate()
  const mintAuthority = Keypair.generate()
  const routerOwner = Keypair.generate()

  const [relayDepository] = PublicKey.findProgramAddressSync(
    [Buffer.from("relay_depository")],
    depository.programId
  )
  const [vault] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault")],
    depository.programId
  )
  const [routerConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    router.programId
  )
  const BPF_LOADER_UPGRADEABLE_PROGRAM_ID = new PublicKey(
    "BPFLoaderUpgradeab1e11111111111111111111111"
  )
  const [routerProgramData] = PublicKey.findProgramAddressSync(
    [router.programId.toBuffer()],
    BPF_LOADER_UPGRADEABLE_PROGRAM_ID
  )
  const depositoryRole = (program: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("depository_role"), program.toBuffer()],
      router.programId
    )[0]
  const [routerAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("depository_caller")],
    router.programId
  )

  const sha256 = (data: Buffer) => createHash("sha256").update(data).digest()
  const domain = sha256(
    Buffer.concat([
      Buffer.from("RelayDepository"),
      Buffer.from("1"),
      Buffer.from("solana-mainnet"),
      depository.programId.toBuffer(),
    ])
  )

  // Withdrawn token (SPL Token) and fill token (Token-2022)
  let withdrawMint: PublicKey
  let fillMint: PublicKey

  const tokenProgramOf = (mint: PublicKey) =>
    mint.equals(fillMint) || mint.equals(NATIVE_MINT_2022)
      ? TOKEN_2022_PROGRAM_ID
      : TOKEN_PROGRAM_ID
  const ata = (mint: PublicKey, owner: PublicKey) =>
    getAssociatedTokenAddressSync(mint, owner, true, tokenProgramOf(mint))
  const tokenBalance = async (account: PublicKey) => {
    const info = await connection.getAccountInfo(account)
    if (!info) return 0n
    return (await getAccount(connection, account, undefined, info.owner)).amount
  }

  type CallAccount = { pubkey: PublicKey; isWritable: boolean }
  type Call = { programIdIndex: number; accountIndexes: number[]; data: Buffer }

  const u32 = (value: number) => {
    const buffer = Buffer.alloc(4)
    buffer.writeUInt32LE(value)
    return buffer
  }

  const u64 = (value: BN) => value.toArrayLike(Buffer, "le", 8)

  // Borsh layout of the router's Bundle
  const encodeBundle = (bundle: any) =>
    Buffer.concat([
      Buffer.from([bundle.version]),
      Buffer.from(bundle.orderId),
      Buffer.from(bundle.executionId),
      bundle.executor.toBuffer(),
      bundle.depository.toBuffer(),
      bundle.withdrawMint
        ? Buffer.concat([Buffer.from([1]), bundle.withdrawMint.toBuffer()])
        : Buffer.from([0]),
      u64(bundle.minimumWithdrawAmount),
      bundle.fillMint.toBuffer(),
      bundle.recipient.toBuffer(),
      u64(bundle.minimumAmount),
      u32(bundle.callAccounts.length),
      ...bundle.callAccounts.map((account: CallAccount) =>
        Buffer.concat([
          account.pubkey.toBuffer(),
          Buffer.from([account.isWritable ? 1 : 0]),
        ])
      ),
      u32(bundle.calls.length),
      ...bundle.calls.map((call: Call) =>
        Buffer.concat([
          Buffer.from([call.programIdIndex]),
          u32(call.accountIndexes.length),
          Buffer.from(call.accountIndexes),
          u32(call.data.length),
          call.data,
        ])
      ),
    ])

  type FillParams = {
    withdrawMint: PublicKey | null
    fillMint: PublicKey
    amount: number
    minimumAmount: number
    recipient?: PublicKey
    callAccounts?: CallAccount[]
    calls?: Call[]
    // The executor's top-level swap between release and settle
    swap?: (fill: Fill) => TransactionInstruction[]
    signer?: Keypair
    requestRecipient?: PublicKey
    betweenSignatureAndRelease?: TransactionInstruction[]
    skipRelease?: boolean
    skipSettle?: boolean
    // Depository program committed in the bundle, the real depository by default
    depositoryProgram?: PublicKey
    version?: number
    requestRouter?: PublicKey
    requestToken?: PublicKey
    minimumWithdrawAmount?: number
  }

  type Fill = {
    bundle: any
    bundleAddress: PublicKey
    requestHash: Buffer
    recipient: PublicKey
    withdrawAccount: PublicKey | null
    fillAccount: PublicKey | null
  }

  const createFill = async (params: FillParams) => {
    const recipient = params.recipient ?? Keypair.generate().publicKey
    const signer = params.signer ?? executor
    const native = params.withdrawMint === null
    const nativeFill = params.fillMint.equals(NATIVE_MINT)

    const bundle = {
      version: params.version ?? 1,
      orderId: Array.from(randomBytes(32)),
      executionId: Array.from(randomBytes(32)),
      executor: executor.publicKey,
      depository: params.depositoryProgram ?? depository.programId,
      withdrawMint: params.withdrawMint,
      minimumWithdrawAmount: new BN(
        params.minimumWithdrawAmount ?? params.amount
      ),
      fillMint: params.fillMint,
      recipient,
      minimumAmount: new BN(params.minimumAmount),
      callAccounts: params.callAccounts ?? [],
      calls: params.calls ?? [],
    }
    const encodedBundle = encodeBundle(bundle)
    const bundleHash = sha256(encodedBundle)
    const [bundleAddress, bump] = PublicKey.findProgramAddressSync(
      [Buffer.from("bundle"), bundleHash],
      router.programId
    )

    const request = {
      domain: Array.from(domain),
      recipient: params.requestRecipient ?? bundleAddress,
      token: params.requestToken ?? params.withdrawMint,
      amount: new BN(params.amount),
      nonce: new BN(randomBytes(8)),
      expiration: new BN(Math.floor(Date.now() / 1000) + 300),
      vaultAddress: vault,
      router: params.requestRouter ?? router.programId,
    }
    const requestHash = sha256(
      Buffer.concat([
        ROUTED_TRANSFER_REQUEST_PREFIX,
        depository.coder.types.encode("routedTransferRequest", request),
      ])
    )
    const [usedRequest] = PublicKey.findProgramAddressSync(
      [Buffer.from("used_request"), requestHash],
      depository.programId
    )

    const withdrawAccount = ata(
      params.withdrawMint ?? NATIVE_MINT,
      bundleAddress
    )
    const fillAccount = ata(params.fillMint, bundleAddress)
    const recipientFillAccount = nativeFill
      ? null
      : ata(params.fillMint, recipient)
    const recipientWithdrawAccount = native
      ? null
      : ata(params.withdrawMint, recipient)

    // Token accounts the executor creates before the fill
    const setup = [
      withdrawAccount,
      fillAccount,
      recipientFillAccount,
      recipientWithdrawAccount,
    ]
      .map((account, i) => {
        if (!account) return null
        const [mint, owner] = [
          [params.withdrawMint ?? NATIVE_MINT, bundleAddress],
          [params.fillMint, bundleAddress],
          [params.fillMint, recipient],
          [params.withdrawMint, recipient],
        ][i]
        return createAssociatedTokenAccountIdempotentInstruction(
          executor.publicKey,
          account,
          owner,
          mint,
          tokenProgramOf(mint)
        )
      })
      .filter(Boolean)
    if (setup.length) {
      await provider.sendAndConfirm(new Transaction().add(...setup), [executor])
    }

    const fill: Fill = {
      bundle,
      bundleAddress,
      requestHash,
      recipient,
      withdrawAccount,
      fillAccount,
    }

    const release = await router.methods
      .release(Array.from(bundleHash), bump, request)
      .accountsPartial({
        executor: signer.publicKey,
        bundleAddress,
        routerAuthority,
        depositoryProgram: bundle.depository,
        relayDepository,
        vault,
        withdrawMint: params.withdrawMint,
        bundleWithdrawTokenAccount: withdrawAccount,
        vaultTokenAccount: native ? null : ata(params.withdrawMint, vault),
        usedRequest,
        ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        withdrawTokenProgram: native
          ? TOKEN_PROGRAM_ID
          : tokenProgramOf(params.withdrawMint),
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        depositoryRole: depositoryRole(bundle.depository),
      })
      .instruction()

    const settle = await router.methods
      .settle({ ...bundle, callAccounts: [], calls: [] }, bump)
      .accountsPartial({
        executor: signer.publicKey,
        bundleAddress,
        recipient,
        fillMint: nativeFill ? null : params.fillMint,
        bundleFillTokenAccount: fillAccount,
        recipientFillTokenAccount: recipientFillAccount,
        withdrawMint: native ? null : params.withdrawMint,
        bundleWithdrawTokenAccount: withdrawAccount,
        recipientWithdrawTokenAccount: recipientWithdrawAccount,
        ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        fillTokenProgram: tokenProgramOf(params.fillMint),
        withdrawTokenProgram: native
          ? TOKEN_PROGRAM_ID
          : tokenProgramOf(params.withdrawMint),
        systemProgram: SystemProgram.programId,
      })
      .instruction()
    // The IDL coder cannot encode call data, so the arguments are encoded by hand
    settle.data = Buffer.concat([
      settle.data.subarray(0, 8),
      encodedBundle,
      Buffer.from([bump]),
    ])

    const instructions = [
      Ed25519Program.createInstructionWithPublicKey({
        publicKey: allocator.publicKey.toBytes(),
        message: requestHash,
        signature: nacl.sign.detached(requestHash, allocator.secretKey),
      }),
      ...(params.betweenSignatureAndRelease ?? []),
      ...(params.skipRelease ? [] : [release]),
      ...(params.swap ? params.swap(fill) : []),
      ...(params.skipSettle ? [] : [settle]),
    ]
    return { fill, instructions, signer, release, settle, request }
  }

  // Routed fills exceed the legacy size limit, so they go through a lookup table
  const sendWithLookupTable = async (
    instructions: TransactionInstruction[],
    signer: Keypair,
    otherSigners: Keypair[] = []
  ) => {
    const programIds = new Set(
      instructions.map((ix) => ix.programId.toBase58())
    )
    const addresses = [
      ...new Set(
        instructions.flatMap((ix) =>
          ix.keys
            .filter((key) => !key.isSigner)
            .map((key) => key.pubkey.toBase58())
        )
      ),
    ]
      .filter((key) => !programIds.has(key))
      .map((key) => new PublicKey(key))

    const [create, table] = AddressLookupTableProgram.createLookupTable({
      authority: signer.publicKey,
      payer: signer.publicKey,
      recentSlot: await connection.getSlot("finalized"),
    })
    await provider.sendAndConfirm(new Transaction().add(create), [signer])
    for (let i = 0; i < addresses.length; i += 20) {
      await provider.sendAndConfirm(
        new Transaction().add(
          AddressLookupTableProgram.extendLookupTable({
            lookupTable: table,
            authority: signer.publicKey,
            payer: signer.publicKey,
            addresses: addresses.slice(i, i + 20),
          })
        ),
        [signer]
      )
    }
    const extendedAt = await connection.getSlot()
    while ((await connection.getSlot()) <= extendedAt + 1) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }

    const lookupTable = (await connection.getAddressLookupTable(table)).value
    const message = new TransactionMessage({
      payerKey: signer.publicKey,
      recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
      instructions,
    }).compileToV0Message([lookupTable])
    const tx = new VersionedTransaction(message)
    tx.sign([signer, ...otherSigners])

    const signature = await connection.sendTransaction(tx)
    await connection.confirmTransaction(signature, "confirmed")
    const result = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    })
    assert.isNull(result.meta.err, JSON.stringify(result.meta.logMessages))
    return result
  }

  const runFill = async (params: FillParams) => {
    const { fill, instructions, signer } = await createFill(params)
    const result = await sendWithLookupTable(instructions, signer)
    const events = result.meta.logMessages
      .filter((log) => log.startsWith("Program data: "))
      .map((log) =>
        router.coder.events.decode(log.slice("Program data: ".length))
      )
      .filter(Boolean)
    return { fill, result, events }
  }

  const expectError = async (promise: Promise<unknown>, error: string) => {
    try {
      await promise
      assert.fail("Should have thrown error")
    } catch (err) {
      const logs = (err.logs ?? []).join("\n")
      assert.include(`${err.message}\n${logs}`, error)
    }
  }

  // The depository has errors of the same names, so this checks the router threw it
  const expectRouterError = async (
    promise: Promise<unknown>,
    error: string
  ) => {
    let logs: string[] = []
    try {
      await promise
    } catch (err) {
      logs = err.logs ?? []
    }
    const stack: string[] = []
    let thrower: string | undefined
    for (const log of logs) {
      const invoke = log.match(/^Program (\w+) invoke/)
      if (invoke) {
        stack.push(invoke[1])
      } else if (/^Program \w+ (success|failed)/.test(log)) {
        stack.pop()
      } else if (log.includes(`Error Code: ${error}.`)) {
        thrower = stack[stack.length - 1]
      }
    }
    assert.equal(thrower, router.programId.toBase58(), logs.join("\n"))
  }

  const expectFillError = async (
    params: FillParams,
    error: string,
    expect = expectError
  ) => {
    const { instructions, signer } = await createFill(params)
    await expect(sendWithLookupTable(instructions, signer), error)
  }

  // Test-only program from ../depository-svm that forwards an instruction through a CPI
  const CALLER_PROGRAM_ID = new PublicKey(
    "3516fiQYXRSj3wmyaQ3UcxoQMxGpbFUCecDjCmaUZEp9"
  )
  const throughCaller = (ix: TransactionInstruction) =>
    new TransactionInstruction({
      programId: CALLER_PROGRAM_ID,
      keys: [
        { pubkey: CALLER_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: ix.programId, isSigner: false, isWritable: false },
        ...ix.keys,
      ],
      data: Buffer.concat([Buffer.from([1]), ix.data]),
    })

  const transferChecked = (
    mint: PublicKey,
    from: PublicKey,
    to: PublicKey,
    amount: number,
    decimals: number
  ) =>
    createTransferCheckedInstruction(
      from,
      mint,
      to,
      executor.publicKey,
      amount,
      decimals,
      [],
      tokenProgramOf(mint)
    )

  before(async () => {
    for (const account of [owner, executor, mintAuthority, routerOwner]) {
      await connection.confirmTransaction(
        await connection.requestAirdrop(
          account.publicKey,
          20 * LAMPORTS_PER_SOL
        )
      )
    }

    if (!(await connection.getAccountInfo(relayDepository))) {
      await depository.methods
        .initialize("solana-mainnet")
        .accountsPartial({
          relayDepository,
          vault,
          owner: owner.publicKey,
          allocator: allocator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([owner])
        .rpc()
    }
    await depository.methods
      .setAllocator(allocator.publicKey)
      .accountsPartial({ relayDepository, owner: owner.publicKey })
      .signers([owner])
      .rpc()

    withdrawMint = await createMint(
      connection,
      mintAuthority,
      mintAuthority.publicKey,
      null,
      6
    )
    fillMint = await createMint(
      connection,
      mintAuthority,
      mintAuthority.publicKey,
      null,
      9,
      undefined,
      undefined,
      TOKEN_2022_PROGRAM_ID
    )

    // Depository liquidity
    const depositor = await getOrCreateAssociatedTokenAccount(
      connection,
      mintAuthority,
      withdrawMint,
      mintAuthority.publicKey
    )
    await mintTo(
      connection,
      mintAuthority,
      withdrawMint,
      depositor.address,
      mintAuthority,
      1_000_000_000
    )
    await depository.methods
      .depositToken(new BN(1_000_000_000), Array(32).fill(0))
      .accountsPartial({
        relayDepository,
        sender: mintAuthority.publicKey,
        depositor: mintAuthority.publicKey,
        vault,
        mint: withdrawMint,
        senderTokenAccount: depositor.address,
        vaultTokenAccount: ata(withdrawMint, vault),
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([mintAuthority])
      .rpc()
    await depository.methods
      .depositNative(new BN(10 * LAMPORTS_PER_SOL), Array(32).fill(0))
      .accountsPartial({
        relayDepository,
        sender: mintAuthority.publicKey,
        depositor: mintAuthority.publicKey,
        vault,
        systemProgram: SystemProgram.programId,
      })
      .signers([mintAuthority])
      .rpc()

    // Token-2022 native mint liquidity, where a token transfer also moves lamports
    if (!(await connection.getAccountInfo(NATIVE_MINT_2022))) {
      await provider.sendAndConfirm(
        new Transaction().add(
          createCreateNativeMintInstruction(
            provider.wallet.publicKey,
            NATIVE_MINT_2022,
            TOKEN_2022_PROGRAM_ID
          )
        )
      )
    }
    const nativeDepositor = await getOrCreateAssociatedTokenAccount(
      connection,
      mintAuthority,
      NATIVE_MINT_2022,
      mintAuthority.publicKey,
      undefined,
      undefined,
      undefined,
      TOKEN_2022_PROGRAM_ID
    )
    await provider.sendAndConfirm(
      new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: mintAuthority.publicKey,
          toPubkey: nativeDepositor.address,
          lamports: 2 * LAMPORTS_PER_SOL,
        }),
        createSyncNativeInstruction(
          nativeDepositor.address,
          TOKEN_2022_PROGRAM_ID
        )
      ),
      [mintAuthority]
    )
    await depository.methods
      .depositToken(new BN(2 * LAMPORTS_PER_SOL), Array(32).fill(0))
      .accountsPartial({
        relayDepository,
        sender: mintAuthority.publicKey,
        depositor: mintAuthority.publicKey,
        vault,
        mint: NATIVE_MINT_2022,
        senderTokenAccount: nativeDepositor.address,
        vaultTokenAccount: ata(NATIVE_MINT_2022, vault),
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([mintAuthority])
      .rpc()

    // Executor inventory used by the simulated swaps
    for (const mint of [
      withdrawMint,
      fillMint,
      NATIVE_MINT,
      NATIVE_MINT_2022,
    ]) {
      await getOrCreateAssociatedTokenAccount(
        connection,
        executor,
        mint,
        executor.publicKey,
        undefined,
        undefined,
        undefined,
        tokenProgramOf(mint)
      )
    }
    await mintTo(
      connection,
      mintAuthority,
      fillMint,
      ata(fillMint, executor.publicKey),
      mintAuthority,
      1_000_000_000_000,
      [],
      undefined,
      TOKEN_2022_PROGRAM_ID
    )
  })

  const initialize = (authority: Keypair, programData = routerProgramData) =>
    router.methods
      .initialize(routerOwner.publicKey)
      .accountsPartial({
        config: routerConfig,
        authority: authority.publicKey,
        program: router.programId,
        programData,
        systemProgram: SystemProgram.programId,
      })
      .signers([authority])
      .rpc()

  const setDepositoryRole = (grant: boolean, signer: Keypair) =>
    (grant
      ? router.methods.grantDepositoryRole(depository.programId)
      : router.methods.revokeDepositoryRole(depository.programId)
    )
      .accountsPartial({
        config: routerConfig,
        owner: signer.publicKey,
        depositoryRole: depositoryRole(depository.programId),
      })
      .signers([signer])
      .rpc()

  it("Should fail to initialize the config without the upgrade authority", async () => {
    await expectError(initialize(mintAuthority), "Unauthorized")
  })

  it("Should fail to initialize the config with another program's data", async () => {
    const [noopProgramData] = PublicKey.findProgramAddressSync(
      [NOOP_PROGRAM_ID.toBuffer()],
      BPF_LOADER_UPGRADEABLE_PROGRAM_ID
    )
    // SetAuthority, making the caller the upgrade authority of the noop program
    await provider.sendAndConfirm(
      new Transaction().add(
        new TransactionInstruction({
          programId: BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
          keys: [
            { pubkey: noopProgramData, isSigner: false, isWritable: true },
            {
              pubkey: provider.wallet.publicKey,
              isSigner: true,
              isWritable: false,
            },
            {
              pubkey: mintAuthority.publicKey,
              isSigner: false,
              isWritable: false,
            },
          ],
          data: Buffer.from([4, 0, 0, 0]),
        })
      )
    )
    await expectError(
      initialize(mintAuthority, noopProgramData),
      "Unauthorized"
    )
  })

  it("Upgrade authority initializes the config once", async () => {
    await initialize((provider.wallet as anchor.Wallet).payer)
    const config = await router.account.routerConfig.fetch(routerConfig)
    assert.isTrue(config.owner.equals(routerOwner.publicKey))

    await expectError(
      initialize((provider.wallet as anchor.Wallet).payer),
      "already in use"
    )
  })

  it("Should fail to grant the depository role without the owner", async () => {
    await expectError(setDepositoryRole(true, mintAuthority), "Unauthorized")
  })

  it("Owner grants the depository role", async () => {
    await setDepositoryRole(true, routerOwner)
    const role = await connection.getAccountInfo(
      depositoryRole(depository.programId)
    )
    assert.isTrue(role.owner.equals(router.programId))
  })

  it("Should fail to revoke the depository role without the owner", async () => {
    await expectError(setDepositoryRole(false, mintAuthority), "Unauthorized")
  })

  it("Owner hands the config to a new owner", async () => {
    const setOwner = (signer: Keypair, newOwner: PublicKey) =>
      router.methods
        .setOwner(newOwner)
        .accountsPartial({ config: routerConfig, owner: signer.publicKey })
        .signers([signer])
        .rpc()

    await expectError(
      setOwner(mintAuthority, mintAuthority.publicKey),
      "Unauthorized"
    )

    await expectError(setOwner(routerOwner, PublicKey.default), "InvalidOwner")

    await setOwner(routerOwner, mintAuthority.publicKey)
    let config = await router.account.routerConfig.fetch(routerConfig)
    assert.isTrue(config.owner.equals(mintAuthority.publicKey))
    await expectError(
      setOwner(routerOwner, routerOwner.publicKey),
      "Unauthorized"
    )

    await setOwner(mintAuthority, routerOwner.publicKey)
    config = await router.account.routerConfig.fetch(routerConfig)
    assert.isTrue(config.owner.equals(routerOwner.publicKey))
  })

  it("Bundle encoding matches the program's layout", () => {
    const bundle = {
      version: 1,
      orderId: Array.from(randomBytes(32)),
      executionId: Array.from(randomBytes(32)),
      executor: executor.publicKey,
      depository: depository.programId,
      withdrawMint: null,
      minimumWithdrawAmount: new BN(1),
      fillMint: NATIVE_MINT,
      recipient: executor.publicKey,
      minimumAmount: new BN(2),
      callAccounts: [{ pubkey: MEMO_PROGRAM_ID, isWritable: true }],
      calls: [],
    }
    assert.deepEqual(
      encodeBundle(bundle),
      router.coder.types.encode("bundle", bundle)
    )
  })

  // The executor's swap: spend the whole withdrawal as delegate, pay the fill into the bundle
  const swapAll = (fill: Fill) => [
    transferChecked(
      withdrawMint,
      fill.withdrawAccount,
      ata(withdrawMint, executor.publicKey),
      1_000_000,
      6
    ),
    transferChecked(
      fillMint,
      ata(fillMint, executor.publicKey),
      fill.fillAccount,
      1_000_000_000,
      9
    ),
  ]

  const crossFill = (overrides: Partial<FillParams> = {}): FillParams => ({
    withdrawMint,
    fillMint,
    amount: 1_000_000,
    minimumAmount: 1_000_000_000,
    swap: swapAll,
    ...overrides,
  })

  // Test-only program that accepts any instruction (see Anchor.toml)
  const NOOP_PROGRAM_ID = new PublicKey(
    "ChjNGc1Pzm3JbGbzL5ptxH3WD9SgEp2HUsJP8mitKnsM"
  )
  const underNoop = (ix: TransactionInstruction) =>
    new TransactionInstruction({
      programId: NOOP_PROGRAM_ID,
      keys: ix.keys,
      data: ix.data,
    })

  const withKey = (
    ix: TransactionInstruction,
    index: number,
    pubkey: PublicKey
  ) => {
    ix.keys[index] = { ...ix.keys[index], pubkey }
  }

  it("Cross-currency fill pays the swap output and returns unspent input", async () => {
    const recipient = Keypair.generate().publicKey
    const { fill, instructions, signer } = await createFill({
      withdrawMint,
      fillMint,
      amount: 2_000_000,
      minimumAmount: 5_000_000_000,
      recipient,
      swap: (fill) => [
        transferChecked(
          withdrawMint,
          fill.withdrawAccount,
          ata(withdrawMint, executor.publicKey),
          1_500_000,
          6
        ),
        transferChecked(
          fillMint,
          ata(fillMint, executor.publicKey),
          fill.fillAccount,
          5_100_000_000,
          9
        ),
      ],
    })
    const bundleAccountsRent =
      (await connection.getBalance(fill.withdrawAccount)) +
      (await connection.getBalance(fill.fillAccount))

    const result = await sendWithLookupTable(instructions, signer)
    const events = result.meta.logMessages
      .filter((log) => log.startsWith("Program data: "))
      .map((log) =>
        router.coder.events.decode(log.slice("Program data: ".length))
      )
      .filter(Boolean)

    assert.equal(await tokenBalance(ata(fillMint, recipient)), 5_100_000_000n)
    assert.equal(await tokenBalance(ata(withdrawMint, recipient)), 500_000n)
    assert.isNull(await connection.getAccountInfo(fill.withdrawAccount))
    assert.isNull(await connection.getAccountInfo(fill.fillAccount))
    assert.isNull(await connection.getAccountInfo(fill.bundleAddress))

    const [usedRequest] = PublicKey.findProgramAddressSync(
      [Buffer.from("used_request"), fill.requestHash],
      depository.programId
    )
    const used = await depository.account.usedRequest.fetch(usedRequest)
    assert.isTrue(used.isUsed)

    const released = events.find((event) => event.name === "released")
    const settled = events.find((event) => event.name === "settled")
    assert.isTrue(released.data.bundleAddress.equals(fill.bundleAddress))
    assert.isTrue(settled.data.bundleAddress.equals(fill.bundleAddress))
    assert.equal(settled.data.amountPaid.toString(), "5100000000")
    assert.equal(settled.data.unspentReturned.toNumber(), 500_000)
    assert.deepEqual(settled.data.executionId, fill.bundle.executionId)

    // The executor gets the bundle token account rent back and pays only the used request
    const usedRequestRent =
      await connection.getMinimumBalanceForRentExemption(9)
    assert.equal(
      result.meta.postBalances[0] - result.meta.preBalances[0],
      bundleAccountsRent - usedRequestRent - result.meta.fee
    )
  })

  it("Native SOL withdrawal is wrapped for the swap", async () => {
    const executorWsol = ata(NATIVE_MINT, executor.publicKey)
    const wsolBefore = await tokenBalance(executorWsol)
    const { fill } = await runFill({
      withdrawMint: null,
      fillMint,
      amount: LAMPORTS_PER_SOL / 10,
      minimumAmount: 1_000_000_000,
      swap: (fill) => [
        transferChecked(
          NATIVE_MINT,
          fill.withdrawAccount,
          executorWsol,
          LAMPORTS_PER_SOL / 10,
          9
        ),
        transferChecked(
          fillMint,
          ata(fillMint, executor.publicKey),
          fill.fillAccount,
          1_000_000_000,
          9
        ),
      ],
    })

    assert.equal(
      await tokenBalance(ata(fillMint, fill.recipient)),
      1_000_000_000n
    )
    assert.equal(
      (await tokenBalance(executorWsol)) - wsolBefore,
      BigInt(LAMPORTS_PER_SOL / 10)
    )
    assert.isNull(await connection.getAccountInfo(fill.withdrawAccount))
    assert.isNull(await connection.getAccountInfo(fill.bundleAddress))
  })

  it("WSOL fill output is paid as native SOL", async () => {
    const { fill } = await runFill({
      withdrawMint,
      fillMint: NATIVE_MINT,
      amount: 1_000_000,
      minimumAmount: LAMPORTS_PER_SOL / 20,
      swap: (fill) => [
        transferChecked(
          withdrawMint,
          fill.withdrawAccount,
          ata(withdrawMint, executor.publicKey),
          1_000_000,
          6
        ),
        SystemProgram.transfer({
          fromPubkey: executor.publicKey,
          toPubkey: fill.fillAccount,
          lamports: LAMPORTS_PER_SOL / 20,
        }),
        createSyncNativeInstruction(fill.fillAccount),
      ],
    })

    assert.equal(
      await connection.getBalance(fill.recipient),
      LAMPORTS_PER_SOL / 20
    )
    assert.isNull(await connection.getAccountInfo(fill.fillAccount))
    assert.isNull(await connection.getAccountInfo(fill.bundleAddress))
  })

  // Exact balances: the bundle rent goes back to the executor and nothing else moves
  const expectExactPayout = async (
    fill: Fill,
    result: Awaited<ReturnType<typeof sendWithLookupTable>>,
    bundleAccountsRent: number,
    executorPaidLamports: number
  ) => {
    const usedRequestRent =
      await connection.getMinimumBalanceForRentExemption(9)
    assert.equal(
      result.meta.postBalances[0] - result.meta.preBalances[0],
      bundleAccountsRent -
        usedRequestRent -
        result.meta.fee -
        executorPaidLamports
    )
    assert.equal(await connection.getBalance(fill.recipient), 0)
    assert.isNull(await connection.getAccountInfo(fill.bundleAddress))
  }

  for (const amount of [1_000_000, LAMPORTS_PER_SOL]) {
    it(`Token-2022 native fill of ${amount} lamports pays exactly the fill`, async () => {
      const { fill, instructions, signer } = await createFill({
        withdrawMint,
        fillMint: NATIVE_MINT_2022,
        amount: 1_000_000,
        minimumAmount: amount,
        swap: (fill) => [
          transferChecked(
            withdrawMint,
            fill.withdrawAccount,
            ata(withdrawMint, executor.publicKey),
            1_000_000,
            6
          ),
          SystemProgram.transfer({
            fromPubkey: executor.publicKey,
            toPubkey: fill.fillAccount,
            lamports: amount,
          }),
          createSyncNativeInstruction(fill.fillAccount, TOKEN_2022_PROGRAM_ID),
        ],
      })
      const bundleAccountsRent =
        (await connection.getBalance(fill.withdrawAccount)) +
        (await connection.getBalance(fill.fillAccount))

      const result = await sendWithLookupTable(instructions, signer)

      assert.equal(
        await tokenBalance(ata(NATIVE_MINT_2022, fill.recipient)),
        BigInt(amount)
      )
      await expectExactPayout(fill, result, bundleAccountsRent, amount)
    })

    it(`Unspent Token-2022 native withdrawal of ${amount} lamports is returned exactly`, async () => {
      const spent = 1_000_000
      const { fill, instructions, signer } = await createFill(
        crossFill({
          withdrawMint: NATIVE_MINT_2022,
          amount: spent + amount,
          swap: (fill) => [
            transferChecked(
              NATIVE_MINT_2022,
              fill.withdrawAccount,
              ata(NATIVE_MINT_2022, executor.publicKey),
              spent,
              9
            ),
            ...swapAll(fill).slice(1),
          ],
        })
      )
      const bundleAccountsRent =
        (await connection.getBalance(fill.withdrawAccount)) +
        (await connection.getBalance(fill.fillAccount))

      const result = await sendWithLookupTable(instructions, signer)

      assert.equal(
        await tokenBalance(ata(NATIVE_MINT_2022, fill.recipient)),
        BigInt(amount)
      )
      await expectExactPayout(fill, result, bundleAccountsRent, 0)
    })
  }

  // Anyone can send tokens to the bundle withdraw account before the fill
  const sendToWithdrawAccount = (fill: Fill, amount: number) =>
    mintTo(
      connection,
      mintAuthority,
      withdrawMint,
      fill.withdrawAccount,
      mintAuthority,
      amount
    )

  it("Tokens sent to the bundle withdraw account before the fill stay there", async () => {
    const { fill, instructions, signer, settle } = await createFill(crossFill())
    await sendToWithdrawAccount(fill, 1)
    // Without the recipient withdraw account, as for a swap that spends the whole withdrawal
    withKey(settle, 8, router.programId)
    const fillAccountRent = await connection.getBalance(fill.fillAccount)

    const result = await sendWithLookupTable(instructions, signer)

    assert.equal(
      await tokenBalance(ata(fillMint, fill.recipient)),
      1_000_000_000n
    )
    const left = await getAccount(connection, fill.withdrawAccount)
    assert.equal(left.amount, 1n)
    assert.isNull(left.delegate)
    const usedRequestRent =
      await connection.getMinimumBalanceForRentExemption(9)
    assert.equal(
      result.meta.postBalances[0] - result.meta.preBalances[0],
      fillAccountRent - usedRequestRent - result.meta.fee
    )
    assert.isNull(await connection.getAccountInfo(fill.bundleAddress))
  })

  it("Tokens sent to the bundle withdraw account go to the recipient with the unspent withdrawal", async () => {
    const { fill, instructions, signer } = await createFill(
      crossFill({
        amount: 2_000_000,
        swap: (fill) => [
          transferChecked(
            withdrawMint,
            fill.withdrawAccount,
            ata(withdrawMint, executor.publicKey),
            1_500_000,
            6
          ),
          ...swapAll(fill).slice(1),
        ],
      })
    )
    await sendToWithdrawAccount(fill, 7)

    await sendWithLookupTable(instructions, signer)

    assert.equal(
      await tokenBalance(ata(withdrawMint, fill.recipient)),
      500_007n
    )
    assert.isNull(await connection.getAccountInfo(fill.withdrawAccount))
  })

  it("Input the executor sends back after spending the whole withdrawal is returned", async () => {
    const { fill, events } = await runFill(
      crossFill({
        swap: (fill) => [
          ...swapAll(fill),
          transferChecked(
            withdrawMint,
            ata(withdrawMint, executor.publicKey),
            fill.withdrawAccount,
            400_000,
            6
          ),
        ],
      })
    )

    assert.equal(
      await tokenBalance(ata(withdrawMint, fill.recipient)),
      400_000n
    )
    assert.isNull(await connection.getAccountInfo(fill.withdrawAccount))
    const settled = events.find((event) => event.name === "settled")
    assert.equal(settled.data.unspentReturned.toNumber(), 400_000)
  })

  it("Should fail when the swap spends more than the withdrawal", async () => {
    const { fill, instructions, signer } = await createFill(
      crossFill({
        swap: (fill) => [
          transferChecked(
            withdrawMint,
            fill.withdrawAccount,
            ata(withdrawMint, executor.publicKey),
            1_000_001,
            6
          ),
          ...swapAll(fill).slice(1),
        ],
      })
    )
    await sendToWithdrawAccount(fill, 1)

    await expectError(
      sendWithLookupTable(instructions, signer),
      "insufficient funds"
    )
  })

  it("Should fail when the executor's rent refund is the only native fill it receives", async () => {
    await expectFillError(
      {
        withdrawMint,
        fillMint: NATIVE_MINT,
        amount: 1_000_000,
        // One WSOL account's rent, which settle refunds to the executor
        minimumAmount: await connection.getMinimumBalanceForRentExemption(165),
        recipient: executor.publicKey,
        swap: (fill) => [
          transferChecked(
            withdrawMint,
            fill.withdrawAccount,
            ata(withdrawMint, executor.publicKey),
            1_000_000,
            6
          ),
        ],
      },
      "InsufficientFill",
      expectRouterError
    )
  })

  it("Lamports sent to the bundle address first go to the recipient", async () => {
    const { fill, instructions, signer } = await createFill(crossFill())
    await provider.sendAndConfirm(
      new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: provider.wallet.publicKey,
          toPubkey: fill.bundleAddress,
          lamports: LAMPORTS_PER_SOL / 100,
        })
      )
    )

    await sendWithLookupTable(instructions, signer)

    assert.equal(
      await tokenBalance(ata(fillMint, fill.recipient)),
      1_000_000_000n
    )
    assert.equal(
      await connection.getBalance(fill.recipient),
      LAMPORTS_PER_SOL / 100
    )
    assert.isNull(await connection.getAccountInfo(fill.bundleAddress))
  })

  // Native SOL withdrawal with one lamport of WSOL sent to the bundle withdraw account first
  const createDustedNativeFill = async () => {
    const executorWsol = ata(NATIVE_MINT, executor.publicKey)
    const created = await createFill({
      withdrawMint: null,
      fillMint,
      amount: LAMPORTS_PER_SOL / 10,
      minimumAmount: 1_000_000_000,
      swap: (fill) => [
        transferChecked(
          NATIVE_MINT,
          fill.withdrawAccount,
          executorWsol,
          LAMPORTS_PER_SOL / 10,
          9
        ),
        swapAll(fill)[1],
      ],
    })
    await provider.sendAndConfirm(
      new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: provider.wallet.publicKey,
          toPubkey: created.fill.withdrawAccount,
          lamports: 1,
        }),
        createSyncNativeInstruction(created.fill.withdrawAccount)
      )
    )
    return created
  }

  it("Leftover lamports that cannot keep the recipient rent exempt go to the executor", async () => {
    const { fill, instructions, signer } = await createDustedNativeFill()
    const bundleAccountsRent =
      (await connection.getBalance(fill.withdrawAccount)) +
      (await connection.getBalance(fill.fillAccount))

    const result = await sendWithLookupTable(instructions, signer)

    assert.equal(
      await tokenBalance(ata(fillMint, fill.recipient)),
      1_000_000_000n
    )
    // The lamport sent to the withdraw account is part of its balance
    await expectExactPayout(fill, result, bundleAccountsRent, 0)
  })

  it("Leftover lamports go to a recipient that stays rent exempt", async () => {
    const { fill, instructions, signer } = await createDustedNativeFill()
    const rentExempt = await connection.getMinimumBalanceForRentExemption(0)
    await provider.sendAndConfirm(
      new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: provider.wallet.publicKey,
          toPubkey: fill.recipient,
          lamports: rentExempt,
        })
      )
    )

    await sendWithLookupTable(instructions, signer)

    assert.equal(await connection.getBalance(fill.recipient), rentExempt + 1)
    assert.isNull(await connection.getAccountInfo(fill.bundleAddress))
  })

  it("Should fail when the withdraw and fill currency are the same", async () => {
    await expectFillError(
      {
        withdrawMint,
        fillMint: withdrawMint,
        amount: 1_000_000,
        minimumAmount: 1_000_000,
      },
      "SameCurrencyNotSupported"
    )
    await expectFillError(
      {
        withdrawMint: null,
        fillMint: NATIVE_MINT,
        amount: LAMPORTS_PER_SOL / 10,
        minimumAmount: LAMPORTS_PER_SOL / 10,
      },
      "SameCurrencyNotSupported"
    )
  })

  it("Should fail when the bundle has calls", async () => {
    for (const calls of [
      { callAccounts: [{ pubkey: MEMO_PROGRAM_ID, isWritable: false }] },
      {
        callAccounts: [{ pubkey: MEMO_PROGRAM_ID, isWritable: false }],
        calls: [
          { programIdIndex: 0, accountIndexes: [], data: Buffer.from("call") },
        ],
      },
    ]) {
      await expectFillError(crossFill(calls), "CallsNotSupported")
    }
  })

  it("Should fail with two releases in one transaction", async () => {
    // Without the swap, to stay within the transaction size limit
    const { instructions, signer, release } = await createFill(
      crossFill({ swap: undefined })
    )
    instructions.splice(instructions.indexOf(release) + 1, 0, release)

    await expectError(
      sendWithLookupTable(instructions, signer),
      "MultipleBundleInstructions"
    )
  })

  it("Should fail when one release is followed by two settles", async () => {
    for (const replenish of [false, true]) {
      const { fill, instructions, signer, settle } = await createFill(
        crossFill({ swap: undefined })
      )
      // Release rejects the shape before the signature check, and two bundles leave no room for it
      instructions.shift()

      // Refilling the bundle address between the settles would let the second pay out again
      if (replenish) {
        instructions.push(
          SystemProgram.transfer({
            fromPubkey: executor.publicKey,
            toPubkey: fill.bundleAddress,
            lamports: LAMPORTS_PER_SOL / 10,
          })
        )
      }
      instructions.push(settle)

      await expectError(
        sendWithLookupTable(instructions, signer),
        "MultipleBundleInstructions"
      )
    }
  })

  it("Should fail release for a depository without the role", async () => {
    await expectFillError(
      crossFill({ depositoryProgram: Keypair.generate().publicKey }),
      "DepositoryNotAllowed"
    )
  })

  it("Should fail release with the role of another depository", async () => {
    const { instructions, signer, release } = await createFill(
      crossFill({ depositoryProgram: Keypair.generate().publicKey })
    )
    withKey(release, 14, depositoryRole(depository.programId))

    await expectRouterError(
      sendWithLookupTable(instructions, signer),
      "DepositoryNotAllowed"
    )
  })

  it("Revoking the depository role stops already signed requests", async () => {
    const { fill, instructions, signer } = await createFill(crossFill())

    await setDepositoryRole(false, routerOwner)
    assert.isNull(
      await connection.getAccountInfo(depositoryRole(depository.programId))
    )
    await expectError(
      sendWithLookupTable(instructions, signer),
      "DepositoryNotAllowed"
    )

    // Granting it again lets the same signed request execute
    await setDepositoryRole(true, routerOwner)
    await sendWithLookupTable(instructions, signer)
    assert.equal(
      await tokenBalance(ata(fillMint, fill.recipient)),
      1_000_000_000n
    )
  })

  it("Should fail when the depository program is not the bundle's", async () => {
    const { instructions, signer, release } = await createFill(crossFill())
    withKey(release, 3, Keypair.generate().publicKey)

    await expectError(
      sendWithLookupTable(instructions, signer),
      "InvalidDepository"
    )
  })

  it("Should fail when the request names another router", async () => {
    await expectFillError(
      crossFill({ requestRouter: Keypair.generate().publicKey }),
      "InvalidRouter",
      expectRouterError
    )
  })

  it("Should fail when release or settle is not top-level", async () => {
    const fill = await createFill(crossFill())
    fill.instructions[fill.instructions.indexOf(fill.release)] = throughCaller(
      fill.release
    )
    await expectError(
      sendWithLookupTable(fill.instructions, fill.signer),
      "NotTopLevel"
    )

    const { settle, signer } = await createFill(crossFill())
    await expectError(
      sendWithLookupTable([throughCaller(settle)], signer),
      "NotTopLevel"
    )
  })

  it("Should fail with an unknown bundle version", async () => {
    await expectFillError(crossFill({ version: 2 }), "InvalidBundle")
  })

  it("Should fail when the withdraw mint is the native mint", async () => {
    await expectFillError(
      crossFill({ withdrawMint: NATIVE_MINT, swap: undefined }),
      "InvalidMint"
    )
  })

  it("Should fail when the withdrawal is below the bundle minimum", async () => {
    await expectFillError(
      crossFill({ minimumWithdrawAmount: 1_000_001 }),
      "InsufficientWithdrawal"
    )
  })

  it("Should fail with a token account that is not the bundle's", async () => {
    const native = await createFill(
      crossFill({
        withdrawMint: null,
        amount: LAMPORTS_PER_SOL / 10,
        swap: undefined,
      })
    )
    withKey(native.release, 7, ata(NATIVE_MINT, executor.publicKey))
    await expectError(
      sendWithLookupTable(native.instructions, native.signer),
      "InvalidTokenAccount"
    )

    const { instructions, signer, settle } = await createFill(crossFill())
    withKey(settle, 4, ata(fillMint, executor.publicKey))
    await expectError(
      sendWithLookupTable(instructions, signer),
      "InvalidTokenAccount"
    )
  })

  it("Should fail with a recipient token account that is not the recipient's", async () => {
    const { instructions, signer, settle } = await createFill(crossFill())
    withKey(settle, 5, ata(fillMint, executor.publicKey))

    await expectError(
      sendWithLookupTable(instructions, signer),
      "InvalidTokenAccount"
    )
  })

  it("Should fail with a recipient token account handed to another owner", async () => {
    const recipient = Keypair.generate()
    const { instructions, signer } = await createFill(
      crossFill({ amount: 2_000_000, recipient: recipient.publicKey })
    )
    await provider.sendAndConfirm(
      new Transaction().add(
        createSetAuthorityInstruction(
          ata(withdrawMint, recipient.publicKey),
          recipient.publicKey,
          AuthorityType.AccountOwner,
          executor.publicKey
        )
      ),
      [recipient]
    )

    await expectRouterError(
      sendWithLookupTable(instructions, signer),
      "InvalidTokenAccount"
    )
  })

  it("Should fail when unspent input has no recipient account", async () => {
    const { instructions, signer, settle } = await createFill(
      crossFill({
        swap: (fill) => [
          transferChecked(
            withdrawMint,
            fill.withdrawAccount,
            ata(withdrawMint, executor.publicKey),
            500_000,
            6
          ),
          swapAll(fill)[1],
        ],
      })
    )
    withKey(settle, 8, router.programId)

    await expectError(
      sendWithLookupTable(instructions, signer),
      "InvalidTokenAccount"
    )
  })

  it("Should fail when settle names another recipient", async () => {
    const { instructions, signer, settle } = await createFill(crossFill())
    withKey(settle, 2, Keypair.generate().publicKey)

    await expectError(
      sendWithLookupTable(instructions, signer),
      "InvalidRecipient"
    )
  })

  it("Should fail when settle passes another fill mint", async () => {
    const { instructions, signer, settle } = await createFill(crossFill())
    withKey(settle, 3, withdrawMint)

    await expectRouterError(
      sendWithLookupTable(instructions, signer),
      "InvalidMint"
    )
  })

  for (const instruction of ["release", "settle"] as const) {
    it(`Should fail when only ${instruction} is signed by another executor`, async () => {
      const other = Keypair.generate()
      await connection.confirmTransaction(
        await connection.requestAirdrop(other.publicKey, LAMPORTS_PER_SOL)
      )
      const fill = await createFill(crossFill())
      withKey(fill[instruction], 0, other.publicKey)

      await expectRouterError(
        sendWithLookupTable(fill.instructions, fill.signer, [other]),
        "InvalidExecutor"
      )
    })
  }

  it("Should fail release without settle", async () => {
    await expectFillError(crossFill({ skipSettle: true }), "MissingSettle")
  })

  it("Should fail when settle uses a different bump than release", async () => {
    const { fill, instructions, signer, settle } = await createFill(crossFill())
    const bundleHash = sha256(encodeBundle(fill.bundle))
    const canonicalBump = settle.data[settle.data.length - 1]

    // Another valid, off-curve bundle address for the same bundle hash
    let otherBump: number
    let otherAddress: PublicKey
    for (let bump = canonicalBump - 1; bump >= 0 && !otherAddress; bump--) {
      try {
        otherAddress = PublicKey.createProgramAddressSync(
          [Buffer.from("bundle"), bundleHash, Buffer.from([bump])],
          router.programId
        )
        otherBump = bump
      } catch {}
    }

    // The executor funds the other address itself so its settle would pay the minimum
    const otherWithdrawAccount = ata(withdrawMint, otherAddress)
    const otherFillAccount = ata(fillMint, otherAddress)
    await provider.sendAndConfirm(
      new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(
          executor.publicKey,
          otherWithdrawAccount,
          otherAddress,
          withdrawMint
        ),
        createAssociatedTokenAccountIdempotentInstruction(
          executor.publicKey,
          otherFillAccount,
          otherAddress,
          fillMint,
          TOKEN_2022_PROGRAM_ID
        )
      ),
      [executor]
    )
    await mintTo(
      connection,
      mintAuthority,
      fillMint,
      otherFillAccount,
      mintAuthority,
      1_000_000_000,
      [],
      undefined,
      TOKEN_2022_PROGRAM_ID
    )

    const replace = new Map([
      [fill.bundleAddress.toBase58(), otherAddress],
      [fill.withdrawAccount.toBase58(), otherWithdrawAccount],
      [fill.fillAccount.toBase58(), otherFillAccount],
    ])
    settle.keys = settle.keys.map((key) => ({
      ...key,
      pubkey: replace.get(key.pubkey.toBase58()) ?? key.pubkey,
    }))
    settle.data[settle.data.length - 1] = otherBump

    await expectError(
      sendWithLookupTable(instructions, signer),
      "MissingRelease"
    )
  })

  it("Should fail settle without release", async () => {
    await expectFillError(
      crossFill({ skipRelease: true, swap: undefined }),
      "MissingRelease"
    )
  })

  it("Should fail when the bundle minimum amount is zero", async () => {
    await expectFillError(
      crossFill({ minimumAmount: 0 }),
      "InvalidBundle",
      expectRouterError
    )
  })

  it("Should fail below the minimum amount", async () => {
    await expectFillError(
      crossFill({ minimumAmount: 1_000_000_001 }),
      "InsufficientFill"
    )
  })

  it("Should fail with a different executor", async () => {
    const other = Keypair.generate()
    await connection.confirmTransaction(
      await connection.requestAirdrop(other.publicKey, LAMPORTS_PER_SOL)
    )
    await expectFillError(
      crossFill({ signer: other, swap: undefined }),
      "InvalidExecutor"
    )
  })

  it("Should fail when the request recipient is not the bundle address", async () => {
    await expectFillError(
      crossFill({ requestRecipient: Keypair.generate().publicKey }),
      "InvalidRecipient",
      expectRouterError
    )
  })

  it("Should fail when the signature is not directly before release", async () => {
    await expectFillError(
      crossFill({
        betweenSignatureAndRelease: [
          new TransactionInstruction({
            programId: MEMO_PROGRAM_ID,
            keys: [],
            data: Buffer.from("between"),
          }),
        ],
      }),
      "MissingSignature"
    )
  })

  it("Should fail to replay a settled request", async () => {
    const { fill, instructions, signer } = await createFill(crossFill())
    await sendWithLookupTable(instructions, signer)

    // Recreate the closed bundle token accounts so only the used request can fail
    await provider.sendAndConfirm(
      new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(
          executor.publicKey,
          fill.withdrawAccount,
          fill.bundleAddress,
          withdrawMint
        ),
        createAssociatedTokenAccountIdempotentInstruction(
          executor.publicKey,
          fill.fillAccount,
          fill.bundleAddress,
          fillMint,
          TOKEN_2022_PROGRAM_ID
        )
      ),
      [executor]
    )
    await expectError(
      sendWithLookupTable(instructions, signer),
      "already in use"
    )
  })

  it("Should fail when the request token is not the bundle's withdraw mint", async () => {
    await expectFillError(
      crossFill({ requestToken: fillMint }),
      "InvalidMint",
      expectRouterError
    )
  })

  it("Should fail when release names another bundle address", async () => {
    const other = Keypair.generate().publicKey
    const { instructions, signer, release } = await createFill(
      crossFill({ requestRecipient: other })
    )
    withKey(release, 1, other)

    await expectError(
      sendWithLookupTable(instructions, signer),
      "InvalidBundleAddress"
    )
  })

  it("Should fail when release uses a non-canonical bump", async () => {
    const { instructions, signer, release } = await createFill(crossFill())
    // Arguments: discriminator (8), bundle hash (32), bump (1), request
    release.data[40] = release.data[40] - 1

    await expectError(
      sendWithLookupTable(instructions, signer),
      "InvalidBundleAddress"
    )
  })

  it("Should fail when settle names another bundle address", async () => {
    const { instructions, signer, settle } = await createFill(crossFill())
    withKey(settle, 1, Keypair.generate().publicKey)

    await expectError(
      sendWithLookupTable(instructions, signer),
      "InvalidBundleAddress"
    )
  })

  it("Should fail when settle returns unspent input from another token account", async () => {
    const { instructions, signer, settle } = await createFill(crossFill())
    withKey(settle, 7, ata(withdrawMint, executor.publicKey))

    await expectError(
      sendWithLookupTable(instructions, signer),
      "InvalidTokenAccount"
    )
  })

  it("Should fail when release is matched with another bundle's settle", async () => {
    const first = await createFill(crossFill())
    const second = await createFill(crossFill())
    const instructions = first.instructions.map((ix) =>
      ix === first.settle ? second.settle : ix
    )

    await expectError(
      sendWithLookupTable(instructions, first.signer),
      "MissingSettle"
    )
  })

  it("Should fail when settle comes before release", async () => {
    const { fill, instructions, signer, release, settle } = await createFill(
      crossFill()
    )
    const signature = instructions[0]

    await expectError(
      sendWithLookupTable(
        [settle, signature, release, ...swapAll(fill)],
        signer
      ),
      "MissingRelease"
    )
  })

  it("Should fail when settle carries trailing bytes", async () => {
    const { instructions, signer, settle } = await createFill(crossFill())
    settle.data = Buffer.concat([settle.data, Buffer.from([0])])

    await expectError(
      sendWithLookupTable(instructions, signer),
      "InvalidBundle"
    )
  })

  it("Should fail with a spoofed instructions sysvar", async () => {
    for (const ix of ["release", "settle"] as const) {
      const fill = await createFill(crossFill())
      const target = fill[ix]
      withKey(
        target,
        target.keys.findIndex((key) =>
          key.pubkey.equals(SYSVAR_INSTRUCTIONS_PUBKEY)
        ),
        Keypair.generate().publicKey
      )

      await expectError(
        sendWithLookupTable(fill.instructions, fill.signer),
        "ConstraintAddress"
      )
    }
  })

  it("Should fail when the swap pays the recipient outside the bundle", async () => {
    // The fill reaches the recipient, but settle only counts what the bundle pays
    const { fill, instructions, signer } = await createFill(
      crossFill({
        swap: (fill) => [
          transferChecked(
            withdrawMint,
            fill.withdrawAccount,
            ata(withdrawMint, executor.publicKey),
            1_000_000,
            6
          ),
          transferChecked(
            fillMint,
            ata(fillMint, executor.publicKey),
            ata(fillMint, fill.recipient),
            1_000_000_000,
            9
          ),
        ],
      })
    )

    await expectError(
      sendWithLookupTable(instructions, signer),
      "InsufficientFill"
    )
    assert.equal(await tokenBalance(ata(fillMint, fill.recipient)), 0n)
  })

  it("Should fail to grant a role twice or revoke a role never granted", async () => {
    await expectError(setDepositoryRole(true, routerOwner), "already in use")

    const other = Keypair.generate().publicKey
    await expectError(
      router.methods
        .revokeDepositoryRole(other)
        .accountsPartial({
          config: routerConfig,
          owner: routerOwner.publicKey,
          depositoryRole: depositoryRole(other),
        })
        .signers([routerOwner])
        .rpc(),
      "AccountNotInitialized"
    )
  })

  describe("Release and settle pairing", () => {
    const tampered = [
      ["minimum amount", { minimumAmount: new BN(0) }],
      ["recipient", { recipient: Keypair.generate().publicKey }],
      ["fill mint", { fillMint: NATIVE_MINT }],
      ["executor", { executor: Keypair.generate().publicKey }],
    ] as const

    for (const [field, change] of tampered) {
      it(`Should fail when settle changes the bundle ${field}`, async () => {
        const { fill, instructions, signer, settle } = await createFill(
          crossFill()
        )
        const bump = settle.data[settle.data.length - 1]
        settle.data = Buffer.concat([
          settle.data.subarray(0, 8),
          encodeBundle({ ...fill.bundle, ...change }),
          Buffer.from([bump]),
        ])

        await expectError(
          sendWithLookupTable(instructions, signer),
          "MissingSettle"
        )
      })
    }

    it("Should fail when the settle is under another program", async () => {
      const { instructions, signer, settle } = await createFill(crossFill())
      instructions[instructions.indexOf(settle)] = underNoop(settle)

      await expectError(
        sendWithLookupTable(instructions, signer),
        "MissingSettle"
      )
    })

    it("Should fail when the release is under another program", async () => {
      const { instructions, signer, release } = await createFill(
        crossFill({ swap: undefined })
      )
      instructions[instructions.indexOf(release)] = underNoop(release)

      await expectError(
        sendWithLookupTable(instructions, signer),
        "MissingRelease"
      )
    })

    for (const name of ["release", "settle"] as const) {
      it(`A ${name} under another program does not count as a second ${name}`, async () => {
        const fill = await createFill(crossFill())
        const ix = fill[name]
        // The discriminator alone would be read as a second instruction were the program id not checked
        const copy = new TransactionInstruction({
          programId: NOOP_PROGRAM_ID,
          keys: [],
          data: ix.data.subarray(0, 8),
        })
        const at = fill.instructions.indexOf(ix)
        fill.instructions.splice(name === "release" ? at + 1 : at, 0, copy)

        await sendWithLookupTable(fill.instructions, fill.signer)
        assert.equal(
          await tokenBalance(ata(fillMint, fill.fill.recipient)),
          1_000_000_000n
        )
      })
    }

    it("Should fail when a release follows the settle", async () => {
      const { instructions, signer, release } = await createFill(
        crossFill({ swap: undefined })
      )
      instructions.push(release)

      await expectError(
        sendWithLookupTable(instructions, signer),
        "MultipleBundleInstructions"
      )
    })

    it("Should fail when settle data is truncated", async () => {
      const { instructions, signer, settle } = await createFill(crossFill())
      settle.data = settle.data.subarray(0, settle.data.length - 1)

      await expectError(
        sendWithLookupTable(instructions, signer),
        "InvalidBundle"
      )
    })

    it("Should fail when release carries trailing bytes", async () => {
      const { instructions, signer, release } = await createFill(crossFill())
      release.data = Buffer.concat([release.data, Buffer.from([0])])

      await expectError(
        sendWithLookupTable(instructions, signer),
        "InvalidBundle"
      )
    })
  })

  describe("Allocator signature through the router", () => {
    it("Should fail with a signature from another key", async () => {
      const { fill, instructions, signer } = await createFill(crossFill())
      const other = Keypair.generate()
      instructions[0] = Ed25519Program.createInstructionWithPublicKey({
        publicKey: other.publicKey.toBytes(),
        message: fill.requestHash,
        signature: nacl.sign.detached(fill.requestHash, other.secretKey),
      })

      await expectError(
        sendWithLookupTable(instructions, signer),
        "AllocatorSignerMismatch"
      )
    })

    it("Should fail with the allocator's signature over the plain request", async () => {
      const { instructions, signer, request } = await createFill(crossFill())
      const { router: _router, ...plain } = request
      const plainHash = sha256(
        depository.coder.types.encode("transferRequest", plain)
      )
      instructions[0] = Ed25519Program.createInstructionWithPublicKey({
        publicKey: allocator.publicKey.toBytes(),
        message: plainHash,
        signature: nacl.sign.detached(plainHash, allocator.secretKey),
      })

      await expectError(
        sendWithLookupTable(instructions, signer),
        "MessageMismatch"
      )
    })
  })

  // Runs against the gateway depository and Circle's GatewayMinter (see Anchor.toml)
  describe("Circle Gateway release", () => {
    const gatewayDepository = new anchor.Program(
      loadIdl(
        "../gateway-depository-svm/target/idl/relay_gateway_depository.json"
      ),
      provider
    )
    const GATEWAY_ROUTED_TRANSFER_REQUEST_PREFIX = Buffer.from(
      "RelayGatewayDepository:RoutedTransferRequest:v1"
    )

    // Same addresses and attester key as the fixtures in ../gateway-depository-svm
    const GATEWAY_MINTER_PROGRAM = new PublicKey(
      "GATEm5SoBJiSw1v2Pz1iPBgUYkXzCUJ27XSXhDfSyzVZ"
    )
    const GATEWAY_WALLET_PROGRAM = new PublicKey(
      "GATEwy4YxeiEbRJLwB6dXgg7q61e6zBPrMzYj5h1pRXQ"
    )
    const USDC_MINT = new PublicKey(
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
    )
    const SOLANA_DOMAIN = 5
    const TEST_ATTESTER_PRIVATE_KEY = Buffer.from(
      "7b1f0c6e5d4a39281706f5e4d3c2b1a0918273645546372819a0b1c2d3e4f506",
      "hex"
    )
    const minterAddress = (...seeds: Buffer[]) =>
      PublicKey.findProgramAddressSync(seeds, GATEWAY_MINTER_PROGRAM)[0]
    const GATEWAY_MINTER = minterAddress(Buffer.from("gateway_minter"))
    const GATEWAY_MINTER_CUSTODY = minterAddress(
      Buffer.from("gateway_minter_custody"),
      USDC_MINT.toBuffer()
    )
    const GATEWAY_MINTER_EVENT_AUTHORITY = minterAddress(
      Buffer.from("__event_authority")
    )
    const usedTransferSpecHash = (transferSpecHash: Buffer) =>
      minterAddress(Buffer.from("used_transfer_spec_hash"), transferSpecHash)

    const [relayGatewayDepository] = PublicKey.findProgramAddressSync(
      [Buffer.from("relay_gateway_depository")],
      gatewayDepository.programId
    )
    const [gatewayVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("gateway_vault")],
      gatewayDepository.programId
    )
    const [gatewayProgramData] = PublicKey.findProgramAddressSync(
      [gatewayDepository.programId.toBuffer()],
      BPF_LOADER_UPGRADEABLE_PROGRAM_ID
    )
    const gatewayDomain = sha256(
      Buffer.concat([
        Buffer.from("RelayGatewayDepository"),
        Buffer.from("1"),
        Buffer.from("solana-mainnet"),
        gatewayDepository.programId.toBuffer(),
      ])
    )

    // Signs the single-element attestation Circle's minter rebuilds for the vault
    const signAttestation = (request: any, maxBlockHeight: anchor.BN) => {
      const u32be = (value: number) => {
        const buffer = Buffer.alloc(4)
        buffer.writeUInt32BE(value)
        return buffer
      }
      const payload = Buffer.concat([
        Buffer.from("10cbb1ec", "hex"),
        u32be(1),
        u32be(SOLANA_DOMAIN),
        GATEWAY_MINTER_PROGRAM.toBuffer(),
        gatewayVault.toBuffer(),
        maxBlockHeight.toArrayLike(Buffer, "be", 8),
        u32be(1),
        USDC_MINT.toBuffer(),
        gatewayVault.toBuffer(),
        request.amount.toArrayLike(Buffer, "be", 8),
        Buffer.from(request.transferSpecHash),
        u32be(0),
      ])
      const digest = keccak_256(
        Buffer.concat([
          Buffer.from("\x19Ethereum Signed Message:\n32"),
          keccak_256(payload),
        ])
      )
      const signature = secp256k1.sign(digest, TEST_ATTESTER_PRIVATE_KEY)
      return Array.from(
        Buffer.concat([
          signature.toCompactRawBytes(),
          Buffer.from([27 + signature.recovery]),
        ])
      )
    }

    // The fill of `createFill` with its release replaced by a `release_gateway`
    const createGatewayFill = async (params: Partial<FillParams> = {}) => {
      const base = await createFill({
        withdrawMint: USDC_MINT,
        fillMint,
        amount: 1_000_000,
        minimumAmount: 1_000_000_000,
        depositoryProgram: gatewayDepository.programId,
        swap: (fill) => [
          transferChecked(
            USDC_MINT,
            fill.withdrawAccount,
            ata(USDC_MINT, executor.publicKey),
            600_000,
            6
          ),
          transferChecked(
            fillMint,
            ata(fillMint, executor.publicKey),
            fill.fillAccount,
            1_000_000_000,
            9
          ),
        ],
        ...params,
      })
      const { fill } = base
      const bundleHash = sha256(encodeBundle(fill.bundle))
      const [, bump] = PublicKey.findProgramAddressSync(
        [Buffer.from("bundle"), bundleHash],
        router.programId
      )

      const request = {
        domain: Array.from(gatewayDomain),
        transferSpecHash: Array.from(randomBytes(32)),
        recipient: base.request.recipient,
        token: base.request.token,
        amount: base.request.amount,
        nonce: base.request.nonce,
        expiration: base.request.expiration,
        router: base.request.router,
      }
      const requestHash = sha256(
        Buffer.concat([
          GATEWAY_ROUTED_TRANSFER_REQUEST_PREFIX,
          gatewayDepository.coder.types.encode(
            "gatewayRoutedTransferRequest",
            request
          ),
        ])
      )
      const [usedRequest] = PublicKey.findProgramAddressSync(
        [Buffer.from("used_request"), requestHash],
        gatewayDepository.programId
      )
      const maxBlockHeight = new BN((await connection.getSlot()) + 1000)

      const release = await router.methods
        .releaseGateway(
          Array.from(bundleHash),
          bump,
          request,
          maxBlockHeight,
          signAttestation(request, maxBlockHeight)
        )
        .accountsPartial({
          executor: base.signer.publicKey,
          bundleAddress: fill.bundleAddress,
          routerAuthority,
          depositoryProgram: fill.bundle.depository,
          relayGatewayDepository,
          vault: gatewayVault,
          withdrawMint: USDC_MINT,
          bundleWithdrawTokenAccount: ata(USDC_MINT, fill.bundleAddress),
          usedRequest,
          ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          gatewayMinterProgram: GATEWAY_MINTER_PROGRAM,
          gatewayMinter: GATEWAY_MINTER,
          gatewayMinterCustody: GATEWAY_MINTER_CUSTODY,
          usedTransferSpecHash: usedTransferSpecHash(
            Buffer.from(request.transferSpecHash)
          ),
          gatewayMinterEventAuthority: GATEWAY_MINTER_EVENT_AUTHORITY,
          withdrawTokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          depositoryRole: depositoryRole(fill.bundle.depository),
        })
        .instruction()

      const instructions = base.instructions.map((ix) =>
        ix === base.release ? release : ix
      )
      instructions[0] = Ed25519Program.createInstructionWithPublicKey({
        publicKey: allocator.publicKey.toBytes(),
        message: requestHash,
        signature: nacl.sign.detached(requestHash, allocator.secretKey),
      })
      return { ...base, instructions, release, request, usedRequest }
    }

    before(async () => {
      await gatewayDepository.methods
        .initialize("solana-mainnet", owner.publicKey)
        .accountsPartial({
          relayGatewayDepository,
          vault: gatewayVault,
          authority: provider.wallet.publicKey,
          programData: gatewayProgramData,
          allocator: allocator.publicKey,
          mint: USDC_MINT,
          gatewayMinterProgram: GATEWAY_MINTER_PROGRAM,
          gatewayWalletProgram: GATEWAY_WALLET_PROGRAM,
        })
        .rpc()
      await router.methods
        .grantDepositoryRole(gatewayDepository.programId)
        .accountsPartial({
          config: routerConfig,
          owner: routerOwner.publicKey,
          depositoryRole: depositoryRole(gatewayDepository.programId),
        })
        .signers([routerOwner])
        .rpc()
      await getOrCreateAssociatedTokenAccount(
        connection,
        executor,
        USDC_MINT,
        executor.publicKey
      )
    })

    it("Gateway transfer is minted to the bundle, swapped and settled", async () => {
      const { fill, instructions, signer, request, usedRequest } =
        await createGatewayFill()
      const custodyBefore = await tokenBalance(GATEWAY_MINTER_CUSTODY)

      const result = await sendWithLookupTable(instructions, signer)
      const events = result.meta.logMessages
        .filter((log) => log.startsWith("Program data: "))
        .map((log) =>
          router.coder.events.decode(log.slice("Program data: ".length))
        )
        .filter(Boolean)

      assert.equal(
        await tokenBalance(ata(fillMint, fill.recipient)),
        1_000_000_000n
      )
      assert.equal(await tokenBalance(ata(USDC_MINT, fill.recipient)), 400_000n)
      assert.equal(
        custodyBefore - (await tokenBalance(GATEWAY_MINTER_CUSTODY)),
        1_000_000n
      )
      assert.equal(await tokenBalance(gatewayVault), 0n)
      assert.isNull(await connection.getAccountInfo(fill.withdrawAccount))
      assert.isNull(await connection.getAccountInfo(fill.fillAccount))

      const used = await gatewayDepository.account.usedRequest.fetch(
        usedRequest
      )
      assert.isTrue(used.isUsed)
      assert.isNotNull(
        await connection.getAccountInfo(
          usedTransferSpecHash(Buffer.from(request.transferSpecHash))
        )
      )

      const released = events.find((event) => event.name === "released")
      const settled = events.find((event) => event.name === "settled")
      assert.isTrue(released.data.bundleAddress.equals(fill.bundleAddress))
      assert.equal(released.data.amount.toNumber(), 1_000_000)
      assert.equal(settled.data.unspentReturned.toNumber(), 400_000)

      // The request cannot be released again, with the closed bundle token accounts recreated
      await provider.sendAndConfirm(
        new Transaction().add(
          createAssociatedTokenAccountIdempotentInstruction(
            executor.publicKey,
            fill.withdrawAccount,
            fill.bundleAddress,
            USDC_MINT
          ),
          createAssociatedTokenAccountIdempotentInstruction(
            executor.publicKey,
            fill.fillAccount,
            fill.bundleAddress,
            fillMint,
            TOKEN_2022_PROGRAM_ID
          )
        ),
        [executor]
      )
      await expectError(
        sendWithLookupTable(instructions, signer),
        "already in use"
      )
    })

    it("Should fail when the gateway request token is not the bundle's withdraw mint", async () => {
      const { instructions, signer } = await createGatewayFill({
        withdrawMint,
        requestToken: USDC_MINT,
      })
      await expectRouterError(
        sendWithLookupTable(instructions, signer),
        "InvalidMint"
      )
    })

    it("Should fail when the gateway transfer is below the bundle minimum", async () => {
      const { instructions, signer } = await createGatewayFill({
        minimumWithdrawAmount: 1_000_001,
      })
      await expectRouterError(
        sendWithLookupTable(instructions, signer),
        "InsufficientWithdrawal"
      )
    })

    it("Should fail gateway release without settle", async () => {
      const { instructions, signer } = await createGatewayFill({
        skipSettle: true,
      })
      await expectRouterError(
        sendWithLookupTable(instructions, signer),
        "MissingSettle"
      )
    })

    it("Should fail gateway release for a depository without the role", async () => {
      const { instructions, signer } = await createGatewayFill({
        depositoryProgram: NOOP_PROGRAM_ID,
      })
      await expectRouterError(
        sendWithLookupTable(instructions, signer),
        "DepositoryNotAllowed"
      )
    })

    for (const [name, order] of [
      ["a release after a gateway release", ["gateway", "release"]],
      ["a release before a gateway release", ["release", "gateway"]],
      ["two gateway releases", ["gateway", "gateway"]],
    ] as const) {
      it(`Should fail with ${name} in one transaction`, async () => {
        // Without the swap and the signature, to stay within the transaction size limit
        const base = await createFill(crossFill({ swap: undefined }))
        const { instructions, signer, release } = await createGatewayFill({
          swap: undefined,
        })
        instructions.shift()
        instructions.splice(
          instructions.indexOf(release),
          1,
          ...order.map((kind) => (kind === "gateway" ? release : base.release))
        )

        await expectRouterError(
          sendWithLookupTable(instructions, signer),
          "MultipleBundleInstructions"
        )
      })
    }

    it("Should fail when the gateway release is under another program", async () => {
      const { instructions, signer, release } = await createGatewayFill({
        swap: undefined,
      })
      instructions[instructions.indexOf(release)] = underNoop(release)

      await expectRouterError(
        sendWithLookupTable(instructions, signer),
        "MissingRelease"
      )
    })

    it("Should fail when the gateway release carries trailing bytes", async () => {
      const { instructions, signer, release } = await createGatewayFill()
      release.data = Buffer.concat([release.data, Buffer.from([0])])

      await expectRouterError(
        sendWithLookupTable(instructions, signer),
        "InvalidBundle"
      )
    })

    // The router does not tell the depositories apart: a request of the other kind fails in the callee
    const expectFailureIn = async (
      promise: Promise<unknown>,
      program: PublicKey
    ) => {
      let logs: string[] = []
      try {
        await promise
        assert.fail("Should have thrown error")
      } catch (err) {
        logs = err.logs ?? []
      }
      assert.isTrue(
        logs.some((log) => log.startsWith(`Program ${program} failed`)),
        logs.join("\n")
      )
    }

    it("Should fail when release calls the gateway depository", async () => {
      const { instructions, signer } = await createFill(
        crossFill({ depositoryProgram: gatewayDepository.programId })
      )
      await expectFailureIn(
        sendWithLookupTable(instructions, signer),
        gatewayDepository.programId
      )
    })

    it("Should fail when a gateway release calls the depository", async () => {
      const { instructions, signer } = await createGatewayFill({
        depositoryProgram: depository.programId,
      })
      await expectFailureIn(
        sendWithLookupTable(instructions, signer),
        depository.programId
      )
    })

    it("Should fail when a gateway release passes the Token-2022 program", async () => {
      const { instructions, signer, release } = await createGatewayFill()
      // Accounts: withdraw_token_program is the 16th
      withKey(release, 15, TOKEN_2022_PROGRAM_ID)

      await expectFailureIn(
        sendWithLookupTable(instructions, signer),
        gatewayDepository.programId
      )
    })

    it("Should fail when a gateway release is not top-level", async () => {
      const { instructions, signer, release } = await createGatewayFill()
      instructions[instructions.indexOf(release)] = throughCaller(release)

      await expectRouterError(
        sendWithLookupTable(instructions, signer),
        "NotTopLevel"
      )
    })

    it("Should fail when a gateway release is signed by another executor", async () => {
      const other = Keypair.generate()
      await connection.confirmTransaction(
        await connection.requestAirdrop(other.publicKey, LAMPORTS_PER_SOL)
      )
      const { instructions, signer, release } = await createGatewayFill()
      withKey(release, 0, other.publicKey)

      await expectRouterError(
        sendWithLookupTable(instructions, signer, [other]),
        "InvalidExecutor"
      )
    })

    it("Should fail when the gateway request recipient is not the bundle address", async () => {
      const { instructions, signer } = await createGatewayFill({
        requestRecipient: Keypair.generate().publicKey,
      })
      await expectRouterError(
        sendWithLookupTable(instructions, signer),
        "InvalidRecipient"
      )
    })

    it("Should fail when the gateway request names another router", async () => {
      const { instructions, signer } = await createGatewayFill({
        requestRouter: CALLER_PROGRAM_ID,
      })
      await expectRouterError(
        sendWithLookupTable(instructions, signer),
        "InvalidRouter"
      )
    })

    it("Should fail a gateway release for a native SOL bundle", async () => {
      const { instructions, signer } = await createGatewayFill({
        withdrawMint: null,
        requestToken: USDC_MINT,
      })
      await expectRouterError(
        sendWithLookupTable(instructions, signer),
        "InvalidMint"
      )
    })

    it("Should fail when settle uses a different bump than the gateway release", async () => {
      const { fill, instructions, signer, settle } = await createGatewayFill()
      const bundleHash = sha256(encodeBundle(fill.bundle))
      const canonicalBump = settle.data[settle.data.length - 1]

      // Another valid, off-curve bundle address for the same bundle hash
      let otherBump: number
      let otherAddress: PublicKey
      for (let bump = canonicalBump - 1; bump >= 0 && !otherAddress; bump--) {
        try {
          otherAddress = PublicKey.createProgramAddressSync(
            [Buffer.from("bundle"), bundleHash, Buffer.from([bump])],
            router.programId
          )
          otherBump = bump
        } catch {}
      }

      // The executor funds the other address itself so its settle would pay the minimum
      const otherWithdrawAccount = ata(USDC_MINT, otherAddress)
      const otherFillAccount = ata(fillMint, otherAddress)
      await provider.sendAndConfirm(
        new Transaction().add(
          createAssociatedTokenAccountIdempotentInstruction(
            executor.publicKey,
            otherWithdrawAccount,
            otherAddress,
            USDC_MINT
          ),
          createAssociatedTokenAccountIdempotentInstruction(
            executor.publicKey,
            otherFillAccount,
            otherAddress,
            fillMint,
            TOKEN_2022_PROGRAM_ID
          )
        ),
        [executor]
      )
      await mintTo(
        connection,
        mintAuthority,
        fillMint,
        otherFillAccount,
        mintAuthority,
        1_000_000_000,
        [],
        undefined,
        TOKEN_2022_PROGRAM_ID
      )

      const replace = new Map([
        [fill.bundleAddress.toBase58(), otherAddress],
        [fill.withdrawAccount.toBase58(), otherWithdrawAccount],
        [fill.fillAccount.toBase58(), otherFillAccount],
      ])
      settle.keys = settle.keys.map((key) => ({
        ...key,
        pubkey: replace.get(key.pubkey.toBase58()) ?? key.pubkey,
      }))
      settle.data[settle.data.length - 1] = otherBump

      await expectRouterError(
        sendWithLookupTable(instructions, signer),
        "MissingRelease"
      )
    })
  })
})
