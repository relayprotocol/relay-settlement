import * as anchor from "@coral-xyz/anchor"
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token"
import {
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

// Negative cases for the allocator ed25519 check, run against both transfer instructions
describe("Relay Depository signature validation", () => {
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
  const attacker = Keypair.generate()
  const recipient = Keypair.generate()

  const ED25519_PROGRAM_ID = new PublicKey(
    "Ed25519SigVerify111111111111111111111111111"
  )
  const MEMO_PROGRAM_ID = new PublicKey(
    "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"
  )
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

  const usedRequestPDA = (hash: Buffer) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("used_request"), hash],
      program.programId
    )[0]

  const accounts = (usedRequest: PublicKey) => ({
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

  type Transfer = {
    hash: Buffer
    instruction: () => Promise<TransactionInstruction>
  }

  // A fresh request for each kind of transfer instruction, with its signed hash
  const kinds: {
    name: string
    transfer: () => Transfer
  }[] = [
    {
      name: "execute_transfer",
      transfer: () => {
        const request = {
          domain: Array.from(domain),
          recipient: recipient.publicKey,
          token: null,
          amount: new anchor.BN(LAMPORTS_PER_SOL / 100),
          nonce: new anchor.BN(Date.now() + Math.floor(Math.random() * 1e6)),
          expiration: new anchor.BN(Math.floor(Date.now() / 1000) + 300),
          vaultAddress: vaultPDA,
        }
        const hash = sha256(
          program.coder.types.encode("transferRequest", request)
        )
        return {
          hash,
          instruction: () =>
            program.methods
              .executeTransfer(request)
              .accountsPartial(accounts(usedRequestPDA(hash)))
              .instruction(),
        }
      },
    },
    {
      name: "execute_transfer_routed",
      transfer: () => {
        const request = {
          domain: Array.from(domain),
          recipient: recipient.publicKey,
          token: null,
          amount: new anchor.BN(LAMPORTS_PER_SOL / 100),
          nonce: new anchor.BN(Date.now() + Math.floor(Math.random() * 1e6)),
          expiration: new anchor.BN(Math.floor(Date.now() / 1000) + 300),
          vaultAddress: vaultPDA,
          router: caller,
        }
        const hash = sha256(
          Buffer.concat([
            ROUTED_TRANSFER_REQUEST_PREFIX,
            program.coder.types.encode("routedTransferRequest", request),
          ])
        )
        return {
          hash,
          // Called through the router stand-in so only the signature check can fail
          instruction: async () => {
            const ix = await program.methods
              .executeTransferRouted(request)
              .accountsPartial({
                ...accounts(usedRequestPDA(hash)),
                routerAuthority: callerAuthority,
              })
              .instruction()
            return new TransactionInstruction({
              programId: caller,
              keys: [
                { pubkey: caller, isSigner: false, isWritable: false },
                {
                  pubkey: program.programId,
                  isSigner: false,
                  isWritable: false,
                },
                ...ix.keys.map((key) =>
                  key.pubkey.equals(callerAuthority)
                    ? { ...key, isSigner: false }
                    : key
                ),
              ],
              data: Buffer.concat([Buffer.from([1]), ix.data]),
            })
          },
        }
      },
    },
  ]

  type Ed25519Layout = {
    publicKey: Buffer
    signature: Buffer
    message: Buffer
    numSignatures?: number
    padding?: number
    signatureOffset?: number
    signatureIndex?: number
    publicKeyOffset?: number
    publicKeyIndex?: number
    messageOffset?: number
    messageSize?: number
    messageIndex?: number
    // Byte offsets where publicKey, signature and message are written
    publicKeyAt?: number
    signatureAt?: number
    messageAt?: number
    length?: number
  }

  // Ed25519 precompile data: a 16-byte offsets header, then the key, signature and message
  const ed25519Data = (layout: Ed25519Layout) => {
    const publicKeyAt = layout.publicKeyAt ?? 16
    const signatureAt = layout.signatureAt ?? 48
    const messageAt = layout.messageAt ?? 112
    const data = Buffer.alloc(
      layout.length ?? Math.max(144, messageAt + layout.message.length)
    )
    data.writeUInt8(layout.numSignatures ?? 1, 0)
    data.writeUInt8(layout.padding ?? 0, 1)
    data.writeUInt16LE(layout.signatureOffset ?? signatureAt, 2)
    data.writeUInt16LE(layout.signatureIndex ?? 0xffff, 4)
    data.writeUInt16LE(layout.publicKeyOffset ?? publicKeyAt, 6)
    data.writeUInt16LE(layout.publicKeyIndex ?? 0xffff, 8)
    data.writeUInt16LE(layout.messageOffset ?? messageAt, 10)
    data.writeUInt16LE(layout.messageSize ?? layout.message.length, 12)
    data.writeUInt16LE(layout.messageIndex ?? 0xffff, 14)
    layout.publicKey.copy(data, publicKeyAt)
    layout.signature.copy(data, signatureAt)
    layout.message.copy(data, messageAt)
    return data
  }

  const ed25519Instruction = (
    layout: Ed25519Layout,
    keys: TransactionInstruction["keys"] = []
  ) =>
    new TransactionInstruction({
      programId: ED25519_PROGRAM_ID,
      keys,
      data: ed25519Data(layout),
    })

  const signed = (message: Buffer, signer = allocator): Ed25519Layout => ({
    publicKey: Buffer.from(signer.publicKey.toBytes()),
    signature: Buffer.from(nacl.sign.detached(message, signer.secretKey)),
    message,
  })

  const memo = () =>
    new TransactionInstruction({
      programId: MEMO_PROGRAM_ID,
      keys: [],
      data: Buffer.from("between"),
    })

  const expectFailure = async (
    instructions: TransactionInstruction[],
    error: string
  ) => {
    try {
      await provider.sendAndConfirm(new Transaction().add(...instructions))
      assert.fail("Should have thrown error")
    } catch (err) {
      const actual = `${err.message}\n${(err.logs ?? []).join("\n")}`
      assert.include(actual, error, actual)
    }
  }

  // Errors the ed25519 precompile itself raises before the depository runs
  const PRECOMPILE_INVALID_SIGNATURE = "custom program error: 0x2"
  const PRECOMPILE_INVALID_DATA_OFFSETS = "custom program error: 0x3"
  const PRECOMPILE_INVALID_DATA_SIZE = "custom program error: 0x4"

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

  for (const kind of kinds) {
    describe(kind.name, () => {
      it("Executes with a well-formed allocator signature", async () => {
        const { hash, instruction } = kind.transfer()
        await provider.sendAndConfirm(
          new Transaction().add(
            ed25519Instruction(signed(hash)),
            await instruction()
          )
        )
        const used = await program.account.usedRequest.fetch(
          usedRequestPDA(hash)
        )
        assert.isTrue(used.isUsed)
      })

      it("Should fail when the signature instruction is not from the ed25519 program", async () => {
        const { instruction } = kind.transfer()
        await expectFailure([memo(), await instruction()], "MissingSignature")
      })

      it("Should fail when the signature instruction has accounts", async () => {
        const { hash, instruction } = kind.transfer()
        await expectFailure(
          [
            ed25519Instruction(signed(hash), [
              {
                pubkey: Keypair.generate().publicKey,
                isSigner: false,
                isWritable: false,
              },
            ]),
            await instruction(),
          ],
          "MalformedEd25519Data"
        )
      })

      it("Should fail when the signature data is not 144 bytes", async () => {
        const { hash, instruction } = kind.transfer()
        await expectFailure(
          [
            ed25519Instruction({ ...signed(hash), length: 145 }),
            await instruction(),
          ],
          "MalformedEd25519Data"
        )
        const short = ed25519Instruction(signed(hash))
        short.data = short.data.subarray(0, 143)
        await expectFailure(
          [short, await instruction()],
          PRECOMPILE_INVALID_DATA_OFFSETS
        )
      })

      it("Should fail with zero or two signatures, or nonzero padding", async () => {
        const { hash, instruction } = kind.transfer()
        await expectFailure(
          [
            ed25519Instruction({ ...signed(hash), numSignatures: 0 }),
            await instruction(),
          ],
          PRECOMPILE_INVALID_DATA_SIZE
        )
        await expectFailure(
          [
            ed25519Instruction({ ...signed(hash), numSignatures: 2 }),
            await instruction(),
          ],
          PRECOMPILE_INVALID_DATA_OFFSETS
        )
        await expectFailure(
          [
            ed25519Instruction({ ...signed(hash), padding: 1 }),
            await instruction(),
          ],
          "MalformedEd25519Data"
        )
      })

      it("Should fail when the public key is read from another instruction", async () => {
        const { hash, instruction } = kind.transfer()
        // The precompile checks the attacker's key from instruction 0 while the data claims the allocator's
        await expectFailure(
          [
            ed25519Instruction(signed(hash, attacker)),
            ed25519Instruction({
              ...signed(hash, attacker),
              publicKey: Buffer.from(allocator.publicKey.toBytes()),
              publicKeyIndex: 0,
            }),
            await instruction(),
          ],
          "MalformedEd25519Data"
        )
      })

      it("Should fail when the message is read from another instruction", async () => {
        const { hash, instruction } = kind.transfer()
        const otherHash = sha256(Buffer.from("another request"))
        // The allocator signed another message, which the precompile reads from instruction 0
        await expectFailure(
          [
            ed25519Instruction(signed(otherHash)),
            ed25519Instruction({
              ...signed(otherHash),
              message: hash,
              messageIndex: 0,
            }),
            await instruction(),
          ],
          "MalformedEd25519Data"
        )
      })

      it("Should fail when the signature is read from another instruction", async () => {
        const { hash, instruction } = kind.transfer()
        await expectFailure(
          [
            ed25519Instruction(signed(hash)),
            ed25519Instruction({
              ...signed(hash),
              signature: Buffer.alloc(64),
              signatureIndex: 0,
            }),
            await instruction(),
          ],
          "MalformedEd25519Data"
        )
        // Pointing at the transfer instruction gives the precompile bytes that are not a signature
        await expectFailure(
          [
            ed25519Instruction({ ...signed(hash), signatureIndex: 1 }),
            await instruction(),
          ],
          PRECOMPILE_INVALID_SIGNATURE
        )
      })

      it("Should fail when the public key and signature offsets are moved", async () => {
        const { hash, instruction } = kind.transfer()
        await expectFailure(
          [
            ed25519Instruction({
              ...signed(hash),
              signatureAt: 16,
              publicKeyAt: 80,
            }),
            await instruction(),
          ],
          "MalformedEd25519Data"
        )
      })

      it("Should fail when the message is read from other bytes or has the wrong length", async () => {
        const { hash, instruction } = kind.transfer()
        const allocatorKey = Buffer.from(allocator.publicKey.toBytes())
        // A valid signature over the public key bytes, read back as the message
        await expectFailure(
          [
            ed25519Instruction({
              ...signed(allocatorKey),
              message: Buffer.alloc(32),
              messageOffset: 16,
              messageSize: 32,
            }),
            await instruction(),
          ],
          "MessageMismatch"
        )
        await expectFailure(
          [
            ed25519Instruction(signed(hash.subarray(0, 31))),
            await instruction(),
          ],
          "MessageMismatch"
        )
        await expectFailure(
          [
            ed25519Instruction(signed(Buffer.concat([hash, Buffer.from([0])]))),
            await instruction(),
          ],
          "MalformedEd25519Data"
        )
      })

      it("Should fail with a valid signature from another key", async () => {
        const { hash, instruction } = kind.transfer()
        await expectFailure(
          [ed25519Instruction(signed(hash, attacker)), await instruction()],
          "AllocatorSignerMismatch"
        )
      })

      it("Should fail with a corrupted signature", async () => {
        const { hash, instruction } = kind.transfer()
        const layout = signed(hash)
        layout.signature[0] ^= 0xff
        await expectFailure(
          [ed25519Instruction(layout), await instruction()],
          PRECOMPILE_INVALID_SIGNATURE
        )
      })

      it("Should fail when the signature is not directly before the transfer", async () => {
        const { hash, instruction } = kind.transfer()
        await expectFailure(
          [ed25519Instruction(signed(hash)), memo(), await instruction()],
          "MissingSignature"
        )
        await expectFailure(
          [memo(), await instruction(), ed25519Instruction(signed(hash))],
          "MissingSignature"
        )
      })

      it("Should fail when the transfer is the first instruction", async () => {
        const { instruction } = kind.transfer()
        await expectFailure([await instruction()], "MalformedEd25519Data")
      })

      it("Should fail when one signature is used for two transfers", async () => {
        const first = kind.transfer()
        const second = kind.transfer()
        await expectFailure(
          [
            ed25519Instruction(signed(first.hash)),
            await first.instruction(),
            await second.instruction(),
          ],
          "MissingSignature"
        )
        await expectFailure(
          [ed25519Instruction(signed(first.hash)), await second.instruction()],
          "MessageMismatch"
        )
      })
    })
  }
})
