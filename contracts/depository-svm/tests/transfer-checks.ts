import * as anchor from "@coral-xyz/anchor"
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
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

// Request and transfer checks shared by both transfer instructions, run against each of them
describe("Relay Depository transfer checks", () => {
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
  const payer = (provider.wallet as anchor.Wallet).payer
  const allocator = Keypair.generate()
  const recipient = Keypair.generate()
  const otherRecipient = Keypair.generate()

  // Test-only router stand-in loaded from tests/fixtures (see Anchor.toml)
  const caller = new PublicKey("3516fiQYXRSj3wmyaQ3UcxoQMxGpbFUCecDjCmaUZEp9")
  const [callerAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("depository_caller")],
    caller
  )
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

  const sha256 = (data: Buffer) => createHash("sha256").update(data).digest()
  const domain = sha256(
    Buffer.concat([
      Buffer.from("RelayDepository"),
      Buffer.from("1"),
      Buffer.from("solana-mainnet"),
      program.programId.toBuffer(),
    ])
  )

  let splMint: PublicKey
  let otherSplMint: PublicKey
  let mint2022: PublicKey

  const usedRequestPDA = (hash: Buffer) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("used_request"), hash],
      program.programId
    )[0]

  // Routed-shaped request; the plain instruction drops `router`
  const createRequest = (overrides: Record<string, any> = {}) => ({
    domain: Array.from(domain),
    recipient: recipient.publicKey,
    token: null as PublicKey | null,
    amount: new anchor.BN(LAMPORTS_PER_SOL / 100),
    nonce: new anchor.BN(Date.now() + Math.floor(Math.random() * 1e6)),
    expiration: new anchor.BN(Math.floor(Date.now() / 1000) + 300),
    vaultAddress: vaultPDA,
    router: caller,
    ...overrides,
  })

  const toPlain = ({ router: _router, ...plain }: any) => plain

  const nativeAccounts = (recipientKey = recipient.publicKey) => ({
    relayDepository: relayDepositoryPDA,
    executor: provider.wallet.publicKey,
    recipient: recipientKey,
    vault: vaultPDA,
    mint: null,
    recipientTokenAccount: null,
    vaultTokenAccount: null,
    ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
    tokenProgram: TOKEN_PROGRAM_ID,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  })

  const tokenAccounts = (
    mint: PublicKey,
    tokenProgram: PublicKey,
    recipientKey = recipient.publicKey
  ) => ({
    ...nativeAccounts(recipientKey),
    mint,
    recipientTokenAccount: getAssociatedTokenAddressSync(
      mint,
      recipientKey,
      false,
      tokenProgram
    ),
    vaultTokenAccount: getAssociatedTokenAddressSync(
      mint,
      vaultPDA,
      true,
      tokenProgram
    ),
    tokenProgram,
  })

  type Kind = {
    name: string
    event: string
    hash: (request: any) => Buffer
    instruction: (
      request: any,
      accounts: Record<string, any>
    ) => Promise<TransactionInstruction>
  }

  const kinds: Kind[] = [
    {
      name: "execute_transfer",
      event: "transferExecutedEvent",
      hash: (request) =>
        sha256(program.coder.types.encode("transferRequest", toPlain(request))),
      instruction: (request, accounts) =>
        program.methods
          .executeTransfer(toPlain(request))
          .accountsPartial(accounts)
          .instruction(),
    },
    {
      name: "execute_transfer_routed",
      event: "routedTransferExecutedEvent",
      hash: (request) =>
        sha256(
          Buffer.concat([
            ROUTED_TRANSFER_REQUEST_PREFIX,
            program.coder.types.encode("routedTransferRequest", request),
          ])
        ),
      // Called through the router stand-in, the way the router calls the depository
      instruction: async (request, accounts) => {
        const ix = await program.methods
          .executeTransferRouted(request)
          .accountsPartial({ ...accounts, routerAuthority: callerAuthority })
          .instruction()
        return new TransactionInstruction({
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
          data: Buffer.concat([Buffer.from([1]), ix.data]),
        })
      },
    },
  ]

  const send = async (
    kind: Kind,
    request: any,
    accounts: Record<string, any> = nativeAccounts()
  ) => {
    const hash = kind.hash(request)
    return provider.sendAndConfirm(
      new Transaction().add(
        Ed25519Program.createInstructionWithPublicKey({
          publicKey: allocator.publicKey.toBytes(),
          message: hash,
          signature: nacl.sign.detached(hash, allocator.secretKey),
        }),
        await kind.instruction(request, {
          ...accounts,
          usedRequest: usedRequestPDA(hash),
        })
      ),
      [],
      { commitment: "confirmed", preflightCommitment: "confirmed" }
    )
  }

  // A rejected request must leave its used_request account uncreated
  const expectRejected = async (
    kind: Kind,
    request: any,
    error: string,
    accounts?: Record<string, any>
  ) => {
    try {
      await send(kind, request, accounts)
      assert.fail("Should have thrown error")
    } catch (err) {
      assert.include(`${err.message}\n${(err.logs ?? []).join("\n")}`, error)
    }
    assert.isNull(
      await provider.connection.getAccountInfo(
        usedRequestPDA(kind.hash(request))
      )
    )
  }

  const tokenBalance = async (
    mint: PublicKey,
    tokenProgram: PublicKey,
    owner: PublicKey
  ) =>
    (
      await getAccount(
        provider.connection,
        getAssociatedTokenAddressSync(mint, owner, true, tokenProgram),
        "confirmed",
        tokenProgram
      )
    ).amount

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

    // Fund the vault and create recipient token accounts for each mint
    const setupMint = async (tokenProgram: PublicKey) => {
      const mint = await createMint(
        provider.connection,
        payer,
        payer.publicKey,
        null,
        6,
        undefined,
        undefined,
        tokenProgram
      )
      for (const holder of [
        vaultPDA,
        recipient.publicKey,
        otherRecipient.publicKey,
      ]) {
        const account = await getOrCreateAssociatedTokenAccount(
          provider.connection,
          payer,
          mint,
          holder,
          true,
          undefined,
          undefined,
          tokenProgram
        )
        if (holder.equals(vaultPDA)) {
          await mintTo(
            provider.connection,
            payer,
            mint,
            account.address,
            payer,
            1_000_000_000,
            [],
            undefined,
            tokenProgram
          )
        }
      }
      return mint
    }
    splMint = await setupMint(TOKEN_PROGRAM_ID)
    otherSplMint = await setupMint(TOKEN_PROGRAM_ID)
    mint2022 = await setupMint(TOKEN_2022_PROGRAM_ID)
  })

  for (const kind of kinds) {
    describe(kind.name, () => {
      it("Executes a native transfer and marks the request used", async () => {
        const request = createRequest()
        const before = await provider.connection.getBalance(recipient.publicKey)
        await send(kind, request)

        const after = await provider.connection.getBalance(recipient.publicKey)
        assert.equal(after - before, request.amount.toNumber())
        const used = await program.account.usedRequest.fetch(
          usedRequestPDA(kind.hash(request))
        )
        assert.isTrue(used.isUsed)
      })

      it("Executes an SPL token transfer", async () => {
        const request = createRequest({
          token: splMint,
          amount: new anchor.BN(1_000_000),
        })
        const vaultBefore = await tokenBalance(
          splMint,
          TOKEN_PROGRAM_ID,
          vaultPDA
        )
        const before = await tokenBalance(
          splMint,
          TOKEN_PROGRAM_ID,
          recipient.publicKey
        )
        await send(kind, request, tokenAccounts(splMint, TOKEN_PROGRAM_ID))

        assert.equal(
          await tokenBalance(splMint, TOKEN_PROGRAM_ID, recipient.publicKey),
          before + BigInt(1_000_000)
        )
        assert.equal(
          await tokenBalance(splMint, TOKEN_PROGRAM_ID, vaultPDA),
          vaultBefore - BigInt(1_000_000)
        )
      })

      it("Executes a Token-2022 transfer", async () => {
        const request = createRequest({
          token: mint2022,
          amount: new anchor.BN(2_000_000),
        })
        const before = await tokenBalance(
          mint2022,
          TOKEN_2022_PROGRAM_ID,
          recipient.publicKey
        )
        await send(
          kind,
          request,
          tokenAccounts(mint2022, TOKEN_2022_PROGRAM_ID)
        )

        assert.equal(
          await tokenBalance(
            mint2022,
            TOKEN_2022_PROGRAM_ID,
            recipient.publicKey
          ),
          before + BigInt(2_000_000)
        )
      })

      it("Emits the executed event with the used request id", async () => {
        const request = createRequest()
        const signature = await send(kind, request)

        const tx = await provider.connection.getTransaction(signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        })
        const events = [
          ...new anchor.EventParser(program.programId, program.coder).parseLogs(
            tx.meta.logMessages
          ),
        ]
        assert.lengthOf(events, 1)
        assert.equal(events[0].name, kind.event)
        assert.isTrue(
          events[0].data.id.equals(usedRequestPDA(kind.hash(request)))
        )
        assert.isTrue(events[0].data.executor.equals(provider.wallet.publicKey))
        assert.isTrue(events[0].data.request.nonce.eq(request.nonce))
        assert.isTrue(events[0].data.request.amount.eq(request.amount))
        assert.isTrue(
          events[0].data.request.recipient.equals(request.recipient)
        )
        assert.isNull(events[0].data.request.token)
        if (kind.name === "execute_transfer_routed") {
          assert.isTrue(events[0].data.request.router.equals(caller))
        }
      })

      it("Executes a request after a rejected attempt with the same nonce", async () => {
        const nonce = new anchor.BN(
          Date.now() + Math.floor(Math.random() * 1e6)
        )
        await expectRejected(
          kind,
          createRequest({ nonce }),
          "InvalidRecipient",
          nativeAccounts(otherRecipient.publicKey)
        )
        await send(kind, createRequest({ nonce }))
      })

      it("Should not allow double execution of the same request", async () => {
        const request = createRequest()
        await send(kind, request)
        try {
          await send(kind, request)
          assert.fail("Should have thrown error")
        } catch (err) {
          assert.include(err.message, "already in use")
        }
      })

      it("Should fail with an expired request", async () => {
        await expectRejected(
          kind,
          createRequest({
            expiration: new anchor.BN(Math.floor(Date.now() / 1000) - 300),
          }),
          "SignatureExpired"
        )
      })

      it("Should fail with another domain", async () => {
        await expectRejected(
          kind,
          createRequest({ domain: Array.from(sha256(Buffer.from("other"))) }),
          "InvalidDomainSeparator"
        )
      })

      it("Should fail with another vault address", async () => {
        await expectRejected(
          kind,
          createRequest({ vaultAddress: Keypair.generate().publicKey }),
          "InvalidVaultAddress"
        )
      })

      it("Should fail when the native recipient account differs from the request", async () => {
        await expectRejected(
          kind,
          createRequest(),
          "InvalidRecipient",
          nativeAccounts(otherRecipient.publicKey)
        )
      })

      it("Should fail when the native transfer leaves the vault below rent", async () => {
        const vaultBalance = await provider.connection.getBalance(vaultPDA)
        const minRent =
          await provider.connection.getMinimumBalanceForRentExemption(0)
        await expectRejected(
          kind,
          createRequest({ amount: new anchor.BN(vaultBalance - minRent + 1) }),
          "InsufficientVaultBalance"
        )
      })

      it("Executes a native transfer that leaves the vault exactly at rent", async () => {
        const vaultBalance = await provider.connection.getBalance(
          vaultPDA,
          "confirmed"
        )
        const minRent =
          await provider.connection.getMinimumBalanceForRentExemption(0)
        await send(
          kind,
          createRequest({ amount: new anchor.BN(vaultBalance - minRent) })
        )
        assert.equal(
          await provider.connection.getBalance(vaultPDA, "confirmed"),
          minRent
        )

        // Refill the vault for the remaining cases
        await program.methods
          .depositNative(new anchor.BN(LAMPORTS_PER_SOL), Array(32).fill(0))
          .accountsPartial({
            relayDepository: relayDepositoryPDA,
            sender: provider.wallet.publicKey,
            depositor: provider.wallet.publicKey,
            vault: vaultPDA,
            systemProgram: SystemProgram.programId,
          })
          .rpc({ commitment: "confirmed" })
      })

      it("Should fail when the token recipient account differs from the request", async () => {
        await expectRejected(
          kind,
          createRequest({ token: splMint, amount: new anchor.BN(1) }),
          "InvalidRecipient",
          tokenAccounts(splMint, TOKEN_PROGRAM_ID, otherRecipient.publicKey)
        )
      })

      it("Should fail when the mint account differs from the request token", async () => {
        await expectRejected(
          kind,
          createRequest({ token: splMint, amount: new anchor.BN(1) }),
          "InvalidMint",
          tokenAccounts(otherSplMint, TOKEN_PROGRAM_ID)
        )
      })

      it("Should fail with a token request and no token accounts", async () => {
        await expectRejected(
          kind,
          createRequest({ token: splMint, amount: new anchor.BN(1) }),
          "InvalidMint"
        )
      })

      it("Should fail with a token request and a missing vault token account", async () => {
        await expectRejected(
          kind,
          createRequest({ token: splMint, amount: new anchor.BN(1) }),
          "InvalidMint",
          {
            ...tokenAccounts(splMint, TOKEN_PROGRAM_ID),
            vaultTokenAccount: null,
          }
        )
      })

      it("Should fail with a token request and a missing recipient token account", async () => {
        await expectRejected(
          kind,
          createRequest({ token: splMint, amount: new anchor.BN(1) }),
          "InvalidMint",
          {
            ...tokenAccounts(splMint, TOKEN_PROGRAM_ID),
            recipientTokenAccount: null,
          }
        )
      })

      it("Should fail when the token amount exceeds the vault balance", async () => {
        const vaultBalance = await tokenBalance(
          splMint,
          TOKEN_PROGRAM_ID,
          vaultPDA
        )
        await expectRejected(
          kind,
          createRequest({
            token: splMint,
            amount: new anchor.BN((vaultBalance + BigInt(1)).toString()),
          }),
          "insufficient funds",
          tokenAccounts(splMint, TOKEN_PROGRAM_ID)
        )
      })
    })
  }
})
