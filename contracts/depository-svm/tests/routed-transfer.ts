import * as anchor from "@coral-xyz/anchor"
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token"
import {
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
import { createHash } from "crypto"
import nacl from "tweetnacl"

import { RelayDepository } from "../target/types/relay_depository"

// Runs after the main depository suite; the router CPI path is covered by the router workspace
describe("Relay Depository routed transfers", () => {
  const provider = anchor.AnchorProvider.env()
  anchor.setProvider(provider)

  const program = anchor.workspace
    .RelayDepository as anchor.Program<RelayDepository>

  const owner = Keypair.fromSecretKey(
    Buffer.from(
      "5223911e0fbfb0b8d5880ebea5711d5d7754387950c08b52c0eaf127facebd455e28ef570e8aed9ecef8a89f5c1a90739080c05df9e9c8ca082376ef93a02b2e",
      "hex"
    )
  )
  const allocator = Keypair.generate()
  const router = Keypair.generate().publicKey
  const recipient = Keypair.generate()

  const ROUTED_TRANSFER_REQUEST_PREFIX = Buffer.from(
    "RelayDepository:RoutedTransferRequest:v1"
  )

  const [relayDepositoryPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("relay_depository")],
    program.programId
  )
  const [vaultPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault")],
    program.programId
  )
  const [routerAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("depository_caller")],
    router
  )

  // Test-only router stand-in loaded from tests/fixtures (see Anchor.toml)
  const caller = new PublicKey("3516fiQYXRSj3wmyaQ3UcxoQMxGpbFUCecDjCmaUZEp9")
  const [callerAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("depository_caller")],
    caller
  )

  const domain = createHash("sha256")
    .update(
      Buffer.concat([
        Buffer.from("RelayDepository"),
        Buffer.from("1"),
        Buffer.from("solana-mainnet"),
        program.programId.toBuffer(),
      ])
    )
    .digest()

  const sha256 = (data: Buffer) => createHash("sha256").update(data).digest()

  const discriminator = (name: string) =>
    sha256(Buffer.from(`global:${name}`)).subarray(0, 8)

  const createRoutedRequest = (amount: number, requestRouter = router) => ({
    domain: Array.from(domain),
    recipient: recipient.publicKey,
    token: null,
    amount: new anchor.BN(amount),
    nonce: new anchor.BN(Date.now() + Math.floor(Math.random() * 1000)),
    expiration: new anchor.BN(Math.floor(Date.now() / 1000) + 300),
    vaultAddress: vaultPDA,
    router: requestRouter,
  })

  const encodeRouted = (request: any) =>
    program.coder.types.encode("routedTransferRequest", request)

  const hashRouted = (request: any) =>
    sha256(
      Buffer.concat([ROUTED_TRANSFER_REQUEST_PREFIX, encodeRouted(request)])
    )

  const hashPlain = (request: any) =>
    sha256(program.coder.types.encode("transferRequest", request))

  const usedRequestPDA = (hash: Buffer) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("used_request"), hash],
      program.programId
    )[0]

  const signatureInstruction = (hash: Buffer) =>
    Ed25519Program.createInstructionWithPublicKey({
      publicKey: allocator.publicKey.toBytes(),
      message: hash,
      signature: nacl.sign.detached(hash, allocator.secretKey),
    })

  const nativeTransferAccounts = (usedRequest: PublicKey) => ({
    relayDepository: relayDepositoryPDA,
    executor: provider.wallet.publicKey,
    recipient: recipient.publicKey,
    vault: vaultPDA,
    mint: null,
    recipientTokenAccount: null,
    vaultTokenAccount: null,
    usedRequest,
    ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
    tokenProgram: TOKEN_PROGRAM_ID,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  })

  before(async () => {
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(
        owner.publicKey,
        2 * LAMPORTS_PER_SOL
      )
    )

    if (!(await provider.connection.getAccountInfo(relayDepositoryPDA))) {
      await program.methods
        .initialize("solana-mainnet")
        .accountsPartial({
          relayDepository: relayDepositoryPDA,
          vault: vaultPDA,
          owner: owner.publicKey,
          allocator: allocator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([owner])
        .rpc()
    }

    await program.methods
      .setAllocator(allocator.publicKey)
      .accountsPartial({
        relayDepository: relayDepositoryPDA,
        owner: owner.publicKey,
      })
      .signers([owner])
      .rpc()

    await program.methods
      .depositNative(new anchor.BN(LAMPORTS_PER_SOL), Array(32).fill(0))
      .accountsPartial({
        relayDepository: relayDepositoryPDA,
        sender: provider.wallet.publicKey,
        depositor: provider.wallet.publicKey,
        vault: vaultPDA,
        systemProgram: SystemProgram.programId,
      })
      .rpc()
  })

  it("Routed request hash is prefixed and differs from the plain hash", () => {
    const request = createRoutedRequest(LAMPORTS_PER_SOL / 10)
    const { router: _router, ...plain } = request

    assert.deepEqual(encodeRouted(request).subarray(-32), router.toBuffer())
    assert.notDeepEqual(hashRouted(request), hashPlain(plain))
    assert.isFalse(
      usedRequestPDA(hashRouted(request)).equals(
        usedRequestPDA(hashPlain(plain))
      )
    )
  })

  it("Should fail when the router authority is not the router's PDA", async () => {
    const request = createRoutedRequest(LAMPORTS_PER_SOL / 10)
    const hash = hashRouted(request)
    const fakeAuthority = Keypair.generate()

    try {
      await program.methods
        .executeTransferRouted(request)
        .accountsPartial({
          ...nativeTransferAccounts(usedRequestPDA(hash)),
          routerAuthority: fakeAuthority.publicKey,
        })
        .preInstructions([signatureInstruction(hash)])
        .signers([fakeAuthority])
        .rpc()
      assert.fail("Should have thrown error")
    } catch (err) {
      assert.include(err.message, "InvalidRouterAuthority")
    }
  })

  it("Should fail when the router authority does not sign", async () => {
    const request = createRoutedRequest(LAMPORTS_PER_SOL / 10)
    const hash = hashRouted(request)

    const ix = await program.methods
      .executeTransferRouted(request)
      .accountsPartial({
        ...nativeTransferAccounts(usedRequestPDA(hash)),
        routerAuthority,
      })
      .instruction()
    ix.keys.find((key) => key.pubkey.equals(routerAuthority)).isSigner = false

    try {
      await provider.sendAndConfirm(
        new Transaction().add(signatureInstruction(hash), ix)
      )
      assert.fail("Should have thrown error")
    } catch (err) {
      assert.include(err.message, "AccountNotSigner")
    }
  })

  it("Should fail when a routed request is passed to execute_transfer", async () => {
    const request = createRoutedRequest(LAMPORTS_PER_SOL / 10)
    const hash = hashRouted(request)
    const { router: _router, ...plain } = request

    // The routed bytes decode as a plain request with trailing data
    const ix = await program.methods
      .executeTransfer(plain)
      .accountsPartial(nativeTransferAccounts(usedRequestPDA(hashPlain(plain))))
      .instruction()
    const routedIx = new TransactionInstruction({
      programId: ix.programId,
      keys: ix.keys,
      data: Buffer.concat([
        discriminator("execute_transfer"),
        encodeRouted(request),
      ]),
    })

    try {
      await provider.sendAndConfirm(
        new Transaction().add(signatureInstruction(hash), routedIx)
      )
      assert.fail("Should have thrown error")
    } catch (err) {
      assert.include(err.message, "MessageMismatch")
    }
  })

  it("Plain request with the same fields still executes", async () => {
    const request = createRoutedRequest(LAMPORTS_PER_SOL / 10)
    const { router: _router, ...plain } = request
    const hash = hashPlain(plain)

    const balanceBefore = await provider.connection.getBalance(
      recipient.publicKey
    )
    await program.methods
      .executeTransfer(plain)
      .accountsPartial(nativeTransferAccounts(usedRequestPDA(hash)))
      .preInstructions([signatureInstruction(hash)])
      .rpc()

    const balanceAfter = await provider.connection.getBalance(
      recipient.publicKey
    )
    assert.equal(balanceAfter - balanceBefore, LAMPORTS_PER_SOL / 10)
    assert.isNull(
      await provider.connection.getAccountInfo(
        usedRequestPDA(hashRouted(request))
      )
    )
  })

  // Calls execute_transfer_routed through the caller fixture, `depth` program levels deep
  const callerInstruction = async (request: any, depth: number) => {
    const ix = await program.methods
      .executeTransferRouted(request)
      .accountsPartial({
        ...nativeTransferAccounts(usedRequestPDA(hashRouted(request))),
        routerAuthority: callerAuthority,
      })
      .instruction()
    return new TransactionInstruction({
      programId: caller,
      keys: [
        { pubkey: caller, isSigner: false, isWritable: false },
        { pubkey: program.programId, isSigner: false, isWritable: false },
        ...ix.keys.map((key) =>
          key.pubkey.equals(callerAuthority) ? { ...key, isSigner: false } : key
        ),
      ],
      data: Buffer.concat([Buffer.from([depth]), ix.data]),
    })
  }

  it("Routed request executes when its router calls the depository directly", async () => {
    const request = createRoutedRequest(LAMPORTS_PER_SOL / 10, caller)
    const hash = hashRouted(request)

    const balanceBefore = await provider.connection.getBalance(
      recipient.publicKey
    )
    await provider.sendAndConfirm(
      new Transaction().add(
        signatureInstruction(hash),
        await callerInstruction(request, 1)
      )
    )

    const balanceAfter = await provider.connection.getBalance(
      recipient.publicKey
    )
    assert.equal(balanceAfter - balanceBefore, LAMPORTS_PER_SOL / 10)
    const used = await program.account.usedRequest.fetch(usedRequestPDA(hash))
    assert.isTrue(used.isUsed)
  })

  it("Should fail when the request names another router than the one signing", async () => {
    // The caller signs as its own PDA, but the request binds a different router
    const request = createRoutedRequest(LAMPORTS_PER_SOL / 10, router)

    try {
      await provider.sendAndConfirm(
        new Transaction().add(
          signatureInstruction(hashRouted(request)),
          await callerInstruction(request, 1)
        )
      )
      assert.fail("Should have thrown error")
    } catch (err) {
      assert.include(err.message, "InvalidRouterAuthority")
    }
  })

  it("Should fail when a plain request signature is used for a routed transfer", async () => {
    const request = createRoutedRequest(LAMPORTS_PER_SOL / 10, caller)
    const { router: _router, ...plain } = request

    try {
      await provider.sendAndConfirm(
        new Transaction().add(
          signatureInstruction(hashPlain(plain)),
          await callerInstruction(request, 1)
        )
      )
      assert.fail("Should have thrown error")
    } catch (err) {
      assert.include(err.message, "MessageMismatch")
    }
  })

  it("Should fail when the router reaches the depository through a nested call", async () => {
    const request = createRoutedRequest(LAMPORTS_PER_SOL / 10, caller)

    try {
      await provider.sendAndConfirm(
        new Transaction().add(
          signatureInstruction(hashRouted(request)),
          await callerInstruction(request, 2)
        )
      )
      assert.fail("Should have thrown error")
    } catch (err) {
      assert.include(err.message, "InvalidRouterCaller")
    }
  })
})
