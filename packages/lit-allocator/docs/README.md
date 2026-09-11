# Allocator integration recipe

This is the shortest path from a Hub withdrawal to a destination-chain signed
payload. The action API and security checks are summarized in the
[package README](../README.md).

## Prerequisites

- the environment's existing PKP id and Lit usage API key;
- the current action code from `@relay-protocol/lit-actions`;
- the exact `WithdrawRequest` submitted to `RelayAllocator`; and
- the Relay oracle endpoint for the same environment.

Do not mix configuration, action code, attestations, or PKPs from different
environments.

## 1. Request the oracle attestation

Call:

```text
POST /attestations/withdraw-requests/v1
```

Send the withdrawal fields plus the payload-builder `hashIndexes` that need
signatures. The order of `hashIndexes` must match the order in which the final
payload expects signatures.

The oracle reads each requested value from
`allocator.hashesToSign[withdrawRequestHash][hashIndex]` and returns an
attestation containing:

```ts
{
  chainId: number
  allocator: string
  withdrawRequestHash: string
  hashesToSign: string[]
  signatures: { oracleSigner: string; signature: string }[]
}
```

Do not replace `hashesToSign` with locally computed values. The action accepts
only the hashes covered by the oracle signatures.

## 2. Load the released action

```ts
import { getAllocatorAction } from "@relay-protocol/lit-actions";

const { code, config } = getAllocatorAction(environment, "v1", vmType);
```

Confirm that `config.name`, `config.hubEvmChainId`, and
`config.allocatorAddress` match the environment used for the Hub request and
oracle call.

## 3. Execute `sign`

Send the exact withdrawal and attestation to Lit:

```ts
const httpResponse = await fetch("https://api.chipotle.litprotocol.com/core/v1/lit_action", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Api-Key": usageApiKey,
  },
  body: JSON.stringify({
    code,
    js_params: {
      pkpId,
      action: "sign",
      withdrawRequest,
      attestation,
    },
  }),
});

if (!httpResponse.ok) throw new Error(await httpResponse.text());
const body = await httpResponse.json();
const result = typeof body.response === "string" ? JSON.parse(body.response) : body.response;
```

For `gateway-vm`, also pass `destinationVmType` as `ethereum-vm` or
`solana-vm`.

## 4. Validate and use the response

Check the parsed `result`:

- `withdrawRequestHash` equals the attested hash;
- `results.length` equals `attestation.hashesToSign.length`; and
- every `results[i].hash` equals `attestation.hashesToSign[i]`.

Insert each `results[i].signature` into the matching payload-builder position,
without reordering it. Submit the completed payload to the destination chain
and wait for the chain-specific success condition before marking the withdrawal
complete.

VM-specific exceptions such as Gateway signature curves, XRP DER signatures,
and Hedera account creation are listed in the
[package README](../README.md#vm-specific-behavior).

## Local smoke test

To test the same flow with a JSON request file:

```sh
yarn workspace @relay-protocol/lit-allocator sign -- \
  --env <env> \
  --usage-api-key <usage-api-key> \
  --pkp-id <pkp-address> \
  --vm-type <vm-type> \
  --input request.json
```
