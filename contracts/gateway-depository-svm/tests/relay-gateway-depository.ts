import * as anchor from "@coral-xyz/anchor"
import { secp256k1 } from "@noble/curves/secp256k1"
import { keccak_256 } from "@noble/hashes/sha3"
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotent,
  getAccount,
  getAssociatedTokenAddressSync,
  mintTo,
} from "@solana/spl-token"
import {
  ComputeBudgetProgram,
  Ed25519Program,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js"
import { assert } from "chai"
import { createHash, randomBytes } from "crypto"
import nacl from "tweetnacl"

import { RelayGatewayDepository } from "../target/types/relay_gateway_depository"
import {
  GATEWAY_MINTER,
  GATEWAY_MINTER_CUSTODY,
  GATEWAY_MINTER_EVENT_AUTHORITY,
  GATEWAY_MINTER_PROGRAM,
  GATEWAY_WALLET,
  GATEWAY_WALLET_CUSTODY,
  GATEWAY_WALLET_EVENT_AUTHORITY,
  GATEWAY_WALLET_PROGRAM,
  SOLANA_DOMAIN,
  TEST_ATTESTER_PRIVATE_KEY,
  TEST_MINT_AUTHORITY,
  USDC_MINT,
  denylist,
  gatewayDeposit,
  usedTransferSpecHash,
} from "./fixtures/circle-gateway/constants"

// Runs against the Circle Gateway programs loaded by `yarn fetch:fixtures` (see Anchor.toml)
describe("Relay Gateway Depository", () => {
  const provider = anchor.AnchorProvider.env()
  anchor.setProvider(provider)

  const program = anchor.workspace
    .RelayGatewayDepository as anchor.Program<RelayGatewayDepository>

  const owner = Keypair.generate()
  const allocator = Keypair.generate()
  const recipient = Keypair.generate()
  const payer = (provider.wallet as anchor.Wallet).payer

  const TRANSFER_REQUEST_PREFIX = Buffer.from(
    "RelayGatewayDepository:TransferRequest:v1"
  )
  const ROUTED_TRANSFER_REQUEST_PREFIX = Buffer.from(
    "RelayGatewayDepository:RoutedTransferRequest:v1"
  )

  const [relayGatewayDepositoryPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("relay_gateway_depository")],
    program.programId
  )
  const [vaultPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("gateway_vault")],
    program.programId
  )

  const [programData] = PublicKey.findProgramAddressSync(
    [program.programId.toBuffer()],
    new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111")
  )

  // Test-only router stand-in loaded from tests/fixtures (see Anchor.toml)
  const caller = new PublicKey("3516fiQYXRSj3wmyaQ3UcxoQMxGpbFUCecDjCmaUZEp9")
  const [callerAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("depository_caller")],
    caller
  )

  const sha256 = (data: Buffer) => createHash("sha256").update(data).digest()

  const domain = sha256(
    Buffer.concat([
      Buffer.from("RelayGatewayDepository"),
      Buffer.from("1"),
      Buffer.from("solana-mainnet"),
      program.programId.toBuffer(),
    ])
  )

  const tokenAccount = (authority: PublicKey) =>
    getAssociatedTokenAddressSync(USDC_MINT, authority, true)

  const tokenBalance = async (account: PublicKey) =>
    (await getAccount(provider.connection, account)).amount

  const createRequest = (amount: number, requestRecipient = recipient) => ({
    domain: Array.from(domain),
    transferSpecHash: Array.from(randomBytes(32)),
    recipient: requestRecipient.publicKey,
    token: USDC_MINT,
    amount: new anchor.BN(amount),
    nonce: new anchor.BN(randomBytes(8)),
    expiration: new anchor.BN(Math.floor(Date.now() / 1000) + 300),
  })

  const createRoutedRequest = (amount: number, router: PublicKey) => ({
    ...createRequest(amount),
    router,
  })

  const hashPlain = (request: any) =>
    sha256(
      Buffer.concat([
        TRANSFER_REQUEST_PREFIX,
        program.coder.types.encode("gatewayTransferRequest", request),
      ])
    )

  const hashRouted = (request: any) =>
    sha256(
      Buffer.concat([
        ROUTED_TRANSFER_REQUEST_PREFIX,
        program.coder.types.encode("gatewayRoutedTransferRequest", request),
      ])
    )

  const usedRequestPDA = (hash: Buffer) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("used_request"), hash],
      program.programId
    )[0]

  const signatureInstruction = (hash: Buffer, signer = allocator) =>
    Ed25519Program.createInstructionWithPublicKey({
      publicKey: signer.publicKey.toBytes(),
      message: hash,
      signature: nacl.sign.detached(hash, signer.secretKey),
    })

  const u64 = (value: bigint | number) => {
    const buffer = Buffer.alloc(8)
    buffer.writeBigUInt64BE(BigInt(value))
    return buffer
  }

  // Signs the single-element attestation Circle's minter rebuilds for the vault
  const signAttestation = (
    request: any,
    maxBlockHeight: anchor.BN,
    overrides: { amount?: number; destinationCaller?: PublicKey } = {}
  ) => {
    const u32 = (value: number) => {
      const buffer = Buffer.alloc(4)
      buffer.writeUInt32BE(value)
      return buffer
    }
    const payload = Buffer.concat([
      Buffer.from("10cbb1ec", "hex"),
      u32(1),
      u32(SOLANA_DOMAIN),
      GATEWAY_MINTER_PROGRAM.toBuffer(),
      (overrides.destinationCaller ?? vaultPDA).toBuffer(),
      u64(BigInt(maxBlockHeight.toString())),
      u32(1),
      USDC_MINT.toBuffer(),
      vaultPDA.toBuffer(),
      u64(overrides.amount ?? request.amount.toNumber()),
      Buffer.from(request.transferSpecHash),
      u32(0),
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

  const maxBlockHeight = async () =>
    new anchor.BN((await provider.connection.getSlot()) + 1000)

  const transferAccounts = (request: any, hash: Buffer) => ({
    relayGatewayDepository: relayGatewayDepositoryPDA,
    executor: provider.wallet.publicKey,
    recipient: request.recipient,
    vault: vaultPDA,
    mint: USDC_MINT,
    recipientTokenAccount: tokenAccount(request.recipient),
    usedRequest: usedRequestPDA(hash),
    ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
    gatewayMinterProgram: GATEWAY_MINTER_PROGRAM,
    gatewayMinter: GATEWAY_MINTER,
    gatewayMinterCustody: GATEWAY_MINTER_CUSTODY,
    usedTransferSpecHash: usedTransferSpecHash(
      Buffer.from(request.transferSpecHash)
    ),
    gatewayMinterEventAuthority: GATEWAY_MINTER_EVENT_AUTHORITY,
    tokenProgram: TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  })

  const computeBudget = ComputeBudgetProgram.setComputeUnitLimit({
    units: 400_000,
  })

  const executeTransfer = async (
    request: any,
    options: {
      hash?: Buffer
      signer?: Keypair
      circleSignature?: number[]
      accounts?: any
    } = {}
  ) => {
    const hash = hashPlain(request)
    const height = await maxBlockHeight()
    return program.methods
      .executeTransfer(
        request,
        height,
        options.circleSignature ?? signAttestation(request, height)
      )
      .accountsPartial({
        ...transferAccounts(request, hash),
        ...options.accounts,
      })
      .preInstructions([
        computeBudget,
        signatureInstruction(options.hash ?? hash, options.signer),
      ])
      .rpc()
  }

  const getEvents = async (signature: string) => {
    await provider.connection.confirmTransaction(signature, "confirmed")
    const transaction = await provider.connection.getParsedTransaction(
      signature,
      "confirmed"
    )

    const events: anchor.Event[] = []
    for (const logMessage of transaction?.meta?.logMessages || []) {
      if (!logMessage.startsWith("Program data: ")) {
        continue
      }
      const event = program.coder.events.decode(
        logMessage.slice("Program data: ".length)
      )
      if (event) {
        events.push(event)
      }
    }

    return events
  }

  const expectError = async (promise: Promise<unknown>, message: string) => {
    try {
      await promise
    } catch (err) {
      assert.include(`${err.message}\n${(err.logs ?? []).join("\n")}`, message)
      return
    }
    assert.fail("Should have thrown error")
  }

  before(async () => {
    for (const account of [owner.publicKey, recipient.publicKey]) {
      await provider.connection.confirmTransaction(
        await provider.connection.requestAirdrop(account, 2 * LAMPORTS_PER_SOL)
      )
    }
    await createAssociatedTokenAccountIdempotent(
      provider.connection,
      payer,
      USDC_MINT,
      recipient.publicKey
    )
  })

  const initialize = (authority: Keypair) =>
    program.methods
      .initialize("solana-mainnet", owner.publicKey)
      .accountsPartial({
        relayGatewayDepository: relayGatewayDepositoryPDA,
        vault: vaultPDA,
        authority: authority.publicKey,
        programData,
        allocator: allocator.publicKey,
        mint: USDC_MINT,
        gatewayMinterProgram: GATEWAY_MINTER_PROGRAM,
        gatewayWalletProgram: GATEWAY_WALLET_PROGRAM,
      })
      .signers([authority])
      .rpc()

  it("Should fail to initialize without the upgrade authority", async () => {
    await expectError(initialize(owner), "Unauthorized")
  })

  it("Should initialize with the vault token account at the vault PDA", async () => {
    await initialize(payer)

    const state = await program.account.relayGatewayDepository.fetch(
      relayGatewayDepositoryPDA
    )
    assert.isTrue(state.owner.equals(owner.publicKey))
    assert.isTrue(state.allocator.equals(allocator.publicKey))
    assert.isTrue(state.mint.equals(USDC_MINT))
    assert.isTrue(state.gatewayMinter.equals(GATEWAY_MINTER_PROGRAM))
    assert.isTrue(state.gatewayWallet.equals(GATEWAY_WALLET_PROGRAM))
    assert.isFalse(state.depositsEnabled)
    assert.deepEqual(Buffer.from(state.domainSeparator), domain)

    const vault = await getAccount(provider.connection, vaultPDA)
    assert.isTrue(vault.mint.equals(USDC_MINT))
    assert.isTrue(vault.owner.equals(relayGatewayDepositoryPDA))
  })

  it("Only the owner can update settings", async () => {
    const accounts = {
      relayGatewayDepository: relayGatewayDepositoryPDA,
      owner: provider.wallet.publicKey,
    }
    await expectError(
      program.methods
        .setAllocator(provider.wallet.publicKey)
        .accountsPartial(accounts)
        .rpc(),
      "Unauthorized"
    )
    await expectError(
      program.methods
        .setOwner(provider.wallet.publicKey)
        .accountsPartial(accounts)
        .rpc(),
      "Unauthorized"
    )
    await expectError(
      program.methods.setDepositsEnabled(true).accountsPartial(accounts).rpc(),
      "Unauthorized"
    )

    const newAllocator = Keypair.generate().publicKey
    for (const next of [newAllocator, allocator.publicKey]) {
      await program.methods
        .setAllocator(next)
        .accountsPartial({ ...accounts, owner: owner.publicKey })
        .signers([owner])
        .rpc()
      const state = await program.account.relayGatewayDepository.fetch(
        relayGatewayDepositoryPDA
      )
      assert.isTrue(state.allocator.equals(next))
    }
  })

  it("Should fail to set the owner or the allocator to the default key", async () => {
    const accounts = {
      relayGatewayDepository: relayGatewayDepositoryPDA,
      owner: owner.publicKey,
    }
    await expectError(
      program.methods
        .setOwner(PublicKey.default)
        .accountsPartial(accounts)
        .signers([owner])
        .rpc(),
      "InvalidOwner"
    )
    await expectError(
      program.methods
        .setAllocator(PublicKey.default)
        .accountsPartial(accounts)
        .signers([owner])
        .rpc(),
      "InvalidAllocator"
    )

    const state = await program.account.relayGatewayDepository.fetch(
      relayGatewayDepositoryPDA
    )
    assert.isTrue(state.owner.equals(owner.publicKey))
    assert.isTrue(state.allocator.equals(allocator.publicKey))
  })

  it("Executes a transfer funded by a Circle Gateway mint", async () => {
    const request = createRequest(1_000_000)
    const hash = hashPlain(request)
    const recipientTokenAccount = tokenAccount(recipient.publicKey)

    const balanceBefore = await tokenBalance(recipientTokenAccount)
    const custodyBefore = await tokenBalance(GATEWAY_MINTER_CUSTODY)
    await executeTransfer(request)

    assert.equal(
      (await tokenBalance(recipientTokenAccount)) - balanceBefore,
      BigInt(1_000_000)
    )
    assert.equal(
      custodyBefore - (await tokenBalance(GATEWAY_MINTER_CUSTODY)),
      BigInt(1_000_000)
    )
    assert.equal(await tokenBalance(vaultPDA), BigInt(0))

    const used = await program.account.usedRequest.fetch(usedRequestPDA(hash))
    assert.isTrue(used.isUsed)
    assert.isNotNull(
      await provider.connection.getAccountInfo(
        usedTransferSpecHash(Buffer.from(request.transferSpecHash))
      )
    )

    // The request cannot be executed again
    await expectError(executeTransfer(request), "already in use")
  })

  it("Should fail when the transfer spec was already minted", async () => {
    const request = createRequest(1_000_000)
    await executeTransfer(request)

    const reused = {
      ...createRequest(1_000_000),
      transferSpecHash: request.transferSpecHash,
    }
    await expectError(executeTransfer(reused), "TransferSpecHashAlreadyUsed")
  })

  it("Should fail when the allocator did not sign the request", async () => {
    const request = createRequest(1_000_000)

    await expectError(
      executeTransfer(request, { signer: Keypair.generate() }),
      "AllocatorSignerMismatch"
    )
    await expectError(
      executeTransfer(request, { hash: hashPlain(createRequest(1_000_000)) }),
      "MessageMismatch"
    )

    const ix = await program.methods
      .executeTransfer(request, new anchor.BN(0), Array(65).fill(0))
      .accountsPartial(transferAccounts(request, hashPlain(request)))
      .instruction()
    await expectError(
      provider.sendAndConfirm(new Transaction().add(ix)),
      "MalformedEd25519Data"
    )
  })

  it("Should fail when the request is expired", async () => {
    const request = {
      ...createRequest(1_000_000),
      expiration: new anchor.BN(Math.floor(Date.now() / 1000) - 60),
    }
    await expectError(executeTransfer(request), "SignatureExpired")
  })

  it("Should fail when the request has another domain", async () => {
    const request = {
      ...createRequest(1_000_000),
      domain: Array.from(randomBytes(32)),
    }
    await expectError(executeTransfer(request), "InvalidDomainSeparator")
  })

  it("Should fail when the request has another token", async () => {
    const request = {
      ...createRequest(1_000_000),
      token: Keypair.generate().publicKey,
    }
    await expectError(executeTransfer(request), "InvalidMint")
  })

  it("Should fail when the recipient is not the request's recipient", async () => {
    const request = createRequest(1_000_000)
    const other = Keypair.generate()
    await createAssociatedTokenAccountIdempotent(
      provider.connection,
      payer,
      USDC_MINT,
      other.publicKey
    )

    await expectError(
      executeTransfer(request, {
        accounts: {
          recipient: other.publicKey,
          recipientTokenAccount: tokenAccount(other.publicKey),
        },
      }),
      "InvalidRecipient"
    )
    // The token account has to be the recipient's associated token account
    await expectError(
      executeTransfer(request, {
        accounts: { recipientTokenAccount: tokenAccount(other.publicKey) },
      }),
      "ConstraintTokenOwner"
    )
  })

  it("Should fail when Circle attested another amount or caller", async () => {
    const request = createRequest(1_000_000)
    const height = await maxBlockHeight()

    for (const overrides of [
      { amount: 2_000_000 },
      { destinationCaller: Keypair.generate().publicKey },
    ]) {
      await expectError(
        program.methods
          .executeTransfer(
            request,
            height,
            signAttestation(request, height, overrides)
          )
          .accountsPartial(transferAccounts(request, hashPlain(request)))
          .preInstructions([
            computeBudget,
            signatureInstruction(hashPlain(request)),
          ])
          .rpc(),
        "InvalidAttesterSignature"
      )
    }
    assert.isNull(
      await provider.connection.getAccountInfo(
        usedRequestPDA(hashPlain(request))
      )
    )
  })

  it("Should fail when the attestation is expired", async () => {
    const request = createRequest(1_000_000)
    const height = new anchor.BN((await provider.connection.getSlot()) - 1)

    await expectError(
      program.methods
        .executeTransfer(request, height, signAttestation(request, height))
        .accountsPartial(transferAccounts(request, hashPlain(request)))
        .preInstructions([
          computeBudget,
          signatureInstruction(hashPlain(request)),
        ])
        .rpc(),
      "AttestationExpired"
    )
  })

  it("Should fail when another program is passed as the Circle minter", async () => {
    const request = createRequest(1_000_000)
    await expectError(
      executeTransfer(request, {
        accounts: { gatewayMinterProgram: caller },
      }),
      "InvalidGatewayProgram"
    )
  })

  it("Should fail when a routed request is passed to execute_transfer", async () => {
    const request = createRoutedRequest(1_000_000, caller)
    const { router: _router, ...plain } = request
    const height = await maxBlockHeight()

    await expectError(
      program.methods
        .executeTransfer(plain, height, signAttestation(plain, height))
        .accountsPartial(transferAccounts(plain, hashPlain(plain)))
        .preInstructions([
          computeBudget,
          signatureInstruction(hashRouted(request)),
        ])
        .rpc(),
      "MessageMismatch"
    )
  })

  // Calls execute_transfer_routed through the caller fixture, `depth` program levels deep
  const callerInstruction = async (
    request: any,
    depth: number,
    hash = hashRouted(request)
  ) => {
    const height = await maxBlockHeight()
    const ix = await program.methods
      .executeTransferRouted(request, height, signAttestation(request, height))
      .accountsPartial({
        ...transferAccounts(request, hashRouted(request)),
        routerAuthority: callerAuthority,
      })
      .instruction()
    return new Transaction().add(
      computeBudget,
      signatureInstruction(hash),
      new TransactionInstruction({
        programId: caller,
        keys: [
          { pubkey: caller, isSigner: false, isWritable: false },
          { pubkey: program.programId, isSigner: false, isWritable: false },
          ...ix.keys.map((key) =>
            key.pubkey.equals(callerAuthority)
              ? { ...key, isSigner: false }
              : key
          ),
        ],
        data: Buffer.concat([Buffer.from([depth]), ix.data]),
      })
    )
  }

  it("Routed request executes when its router calls the depository directly", async () => {
    const request = createRoutedRequest(1_000_000, caller)
    const recipientTokenAccount = tokenAccount(recipient.publicKey)

    const balanceBefore = await tokenBalance(recipientTokenAccount)
    await provider.sendAndConfirm(await callerInstruction(request, 1))

    assert.equal(
      (await tokenBalance(recipientTokenAccount)) - balanceBefore,
      BigInt(1_000_000)
    )
    const used = await program.account.usedRequest.fetch(
      usedRequestPDA(hashRouted(request))
    )
    assert.isTrue(used.isUsed)
  })

  it("Should fail when the request names another router than the one signing", async () => {
    const request = createRoutedRequest(1_000_000, Keypair.generate().publicKey)
    await expectError(
      provider.sendAndConfirm(await callerInstruction(request, 1)),
      "InvalidRouterAuthority"
    )
  })

  it("Should fail when the router authority does not sign", async () => {
    const request = createRoutedRequest(1_000_000, caller)
    const height = await maxBlockHeight()

    const ix = await program.methods
      .executeTransferRouted(request, height, signAttestation(request, height))
      .accountsPartial({
        ...transferAccounts(request, hashRouted(request)),
        routerAuthority: callerAuthority,
      })
      .instruction()
    ix.keys.find((key) => key.pubkey.equals(callerAuthority)).isSigner = false

    await expectError(
      provider.sendAndConfirm(
        new Transaction().add(signatureInstruction(hashRouted(request)), ix)
      ),
      "AccountNotSigner"
    )
  })

  it("Should fail when a plain request signature is used for a routed transfer", async () => {
    const request = createRoutedRequest(1_000_000, caller)
    const { router: _router, ...plain } = request

    await expectError(
      provider.sendAndConfirm(
        await callerInstruction(request, 1, hashPlain(plain))
      ),
      "MessageMismatch"
    )
  })

  it("Should fail when the router reaches the depository through a nested call", async () => {
    const request = createRoutedRequest(1_000_000, caller)
    await expectError(
      provider.sendAndConfirm(await callerInstruction(request, 2)),
      "InvalidRouterCaller"
    )
  })

  const depositAccounts = (sender: PublicKey) => ({
    relayGatewayDepository: relayGatewayDepositoryPDA,
    sender,
    depositor: sender,
    mint: USDC_MINT,
    senderTokenAccount: tokenAccount(sender),
    vault: vaultPDA,
    gatewayWalletProgram: GATEWAY_WALLET_PROGRAM,
    gatewayWallet: GATEWAY_WALLET,
    gatewayWalletCustody: GATEWAY_WALLET_CUSTODY,
    gatewayDeposit: gatewayDeposit(allocator.publicKey),
    depositoryDenylist: denylist(relayGatewayDepositoryPDA),
    allocatorDenylist: denylist(allocator.publicKey),
    gatewayWalletEventAuthority: GATEWAY_WALLET_EVENT_AUTHORITY,
    tokenProgram: TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  })

  const setDepositsEnabled = (enabled: boolean) =>
    program.methods
      .setDepositsEnabled(enabled)
      .accountsPartial({
        relayGatewayDepository: relayGatewayDepositoryPDA,
        owner: owner.publicKey,
      })
      .signers([owner])
      .rpc()

  it("Should fail to deposit while deposits are disabled", async () => {
    await mintTo(
      provider.connection,
      payer,
      USDC_MINT,
      tokenAccount(recipient.publicKey),
      TEST_MINT_AUTHORITY,
      10_000_000
    )

    await expectError(
      program.methods
        .deposit(new anchor.BN(1_000_000), Array.from(randomBytes(32)))
        .accountsPartial(depositAccounts(recipient.publicKey))
        .signers([recipient])
        .rpc(),
      "DepositsDisabled"
    )
  })

  it("Deposits into the allocator's Circle Gateway balance", async () => {
    await setDepositsEnabled(true)
    const id = Array.from(randomBytes(32))
    const senderTokenAccount = tokenAccount(recipient.publicKey)

    // The second deposit credits another account than the one that pays
    const depositors = [recipient.publicKey, Keypair.generate().publicKey]
    const balanceBefore = await tokenBalance(senderTokenAccount)
    const custodyBefore = await tokenBalance(GATEWAY_WALLET_CUSTODY)
    for (const depositor of depositors) {
      const signature = await program.methods
        .deposit(new anchor.BN(1_000_000), id)
        .accountsPartial({
          ...depositAccounts(recipient.publicKey),
          depositor,
        })
        .preInstructions([computeBudget])
        .signers([recipient])
        .rpc()

      const [event] = await getEvents(signature)
      assert.equal(event.name, "depositEvent")
      assert.isTrue(event.data.depositor.equals(depositor))
      assert.isTrue(event.data.token.equals(USDC_MINT))
      assert.equal(event.data.amount.toNumber(), 1_000_000)
      assert.deepEqual(event.data.id, id)
    }

    assert.equal(
      balanceBefore - (await tokenBalance(senderTokenAccount)),
      BigInt(2_000_000)
    )
    assert.equal(
      (await tokenBalance(GATEWAY_WALLET_CUSTODY)) - custodyBefore,
      BigInt(2_000_000)
    )
    assert.equal(await tokenBalance(vaultPDA), BigInt(0))

    // Circle deposit account: discriminator (2) | bump | depositor | mint | available balance
    const deposit = await provider.connection.getAccountInfo(
      gatewayDeposit(allocator.publicKey)
    )
    assert.deepEqual(
      deposit.data.subarray(3, 35),
      allocator.publicKey.toBuffer()
    )
    assert.equal(deposit.data.readBigUInt64LE(67), BigInt(2_000_000))
  })

  it("Should fail to deposit through another program than the Circle wallet", async () => {
    await expectError(
      program.methods
        .deposit(new anchor.BN(1_000_000), Array.from(randomBytes(32)))
        .accountsPartial({
          ...depositAccounts(recipient.publicKey),
          gatewayWalletProgram: caller,
        })
        .signers([recipient])
        .rpc(),
      "InvalidGatewayProgram"
    )
  })

  it("Only the owner can sweep tokens sent to the vault", async () => {
    await mintTo(
      provider.connection,
      payer,
      USDC_MINT,
      vaultPDA,
      TEST_MINT_AUTHORITY,
      500_000
    )
    const destination = tokenAccount(recipient.publicKey)
    const accounts = {
      relayGatewayDepository: relayGatewayDepositoryPDA,
      owner: owner.publicKey,
      mint: USDC_MINT,
      vault: vaultPDA,
      destinationTokenAccount: destination,
      tokenProgram: TOKEN_PROGRAM_ID,
    }

    await expectError(
      program.methods
        .sweep(new anchor.BN(500_000))
        .accountsPartial({ ...accounts, owner: provider.wallet.publicKey })
        .rpc(),
      "Unauthorized"
    )

    const balanceBefore = await tokenBalance(destination)
    await program.methods
      .sweep(new anchor.BN(500_000))
      .accountsPartial(accounts)
      .signers([owner])
      .rpc()
    assert.equal(
      (await tokenBalance(destination)) - balanceBefore,
      BigInt(500_000)
    )
    assert.equal(await tokenBalance(vaultPDA), BigInt(0))
  })

  it("Request hashes are prefixed and differ between plain and routed", () => {
    const request = createRoutedRequest(1_000_000, caller)
    const { router: _router, ...plain } = request

    assert.notDeepEqual(hashRouted(request), hashPlain(plain))
    assert.equal(
      program.coder.types.encode("gatewayTransferRequest", plain).length,
      152
    )
    assert.equal(
      program.coder.types.encode("gatewayRoutedTransferRequest", request)
        .length,
      184
    )
  })
})
