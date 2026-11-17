import { sha256, stringToBytes } from "viem"

// The owner consent the protocol oracle verifies before signing a hub
// `TRANSFER` from the owner's alias (`POST /attestations/transfer/v1`). The
// oracle builds the same payload from the request body and its own hub config,
// so the signer must name the hub it means and an expiration the oracle checks
// against its clock.
//
// Mirrors `createTransferSignaturePayload` in relay-protocol-oracle: the
// message is compact JSON text with lexicographically sorted keys (what
// `json-stable-stringify` produces), signed as a plain message by the owner's
// chain-native scheme. EVM owners use `personal_sign` over the UTF-8 text.

export type TransferConsent = {
  // Hub chain id, as the oracle reports it (decimal string)
  hubChainId: string
  // Hub contract address; lowercased in the message
  hubAddress: string
  // Unix seconds after which the oracle refuses the consent
  expiration: number
  // Protocol chain id of the currency being moved, e.g. "base"
  chainId: string
  // Currency address on that chain
  currency: string
  // Amount in the currency's raw units
  amount: string
  // Protocol chain id of the owner, whose alias holds the funds
  ownerChainId: string
  // Owner address on that chain (the depositor)
  owner: string
  // Hub address receiving the funds
  recipient: string
  // Replay protection; the oracle rejects a reused nonce
  nonce: string
}

const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(sortKeys)
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])])
    )
  }
  return value
}

/**
 * The text an owner signs to consent to a hub transfer from its alias.
 * @param consent The transfer and the hub it is meant for
 * @returns Compact JSON with sorted keys, to be signed as a plain message
 */
export const getTransferConsentMessage = (consent: TransferConsent): string =>
  JSON.stringify(
    sortKeys({
      operation: "transfer",
      hubChainId: consent.hubChainId,
      hubAddress: consent.hubAddress.toLowerCase(),
      expiration: consent.expiration,
      chainId: consent.chainId,
      currency: consent.currency,
      amount: consent.amount,
      ownerChainId: consent.ownerChainId,
      owner: consent.owner,
      recipient: consent.recipient,
      nonce: consent.nonce,
    })
  )

/**
 * The idempotency key the oracle gives the execution of a hub transfer it
 * attested: `sha256` of `hubId:hubTokenId:from:to:nonce`, lowercased. It is
 * deterministic, so a relayer that asked for a transfer can tell from
 * `RelayOracle.isExecuted(key)` whether it ran without asking the oracle again.
 *
 * Mirrors `getDeterministicId` in relay-protocol-oracle.
 * @param execution Hub id (the hub's protocol chain id, e.g. "relay"), hub token
 *   id, the alias the transfer draws from, its recipient and the consent nonce
 */
export const getTransferExecutionId = (execution: {
  hubId: string
  hubTokenId: bigint | string
  from: string
  to: string
  nonce: string
}): `0x${string}` =>
  sha256(
    stringToBytes(
      [
        execution.hubId,
        execution.hubTokenId.toString(),
        execution.from,
        execution.to,
        execution.nonce,
      ]
        .join(":")
        .toLowerCase()
    )
  )
