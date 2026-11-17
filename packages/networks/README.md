# Networks info for Relay Protocol

This package contains network configurations for various chains supported by the Relay Protocol

## How to use

```typescript
import { networks } from "@relay-protocol/settlement-networks"

// Access networks directly by slug
const ethereum = networks["ethereum"]
const base = networks["base"]

// Access networks by chain id
const ethereum = networks["1"]
const base = networks["8453"]
```

Each built-in network exposes `usesDefaultRpc`. It is `true` when `rpc` uses
the package's non-empty default endpoints, and `false` when an environment
variable or an override file supplies the RPC list. A network with no default
endpoint also reports `false`. Direct network exports expose the same metadata.

This flag describes where the configuration came from; it does not classify
explicitly configured endpoints as public or private. Environment overrides are
read when the package is imported, so set them before importing it. An empty
environment variable keeps the existing fallback behavior.

## Use overrides

You can override network config by specifying a file

```typescript
import { initializeNetworks } from "@relay-protocol/settlement-networks"

const networks = initializeNetworks({
  overrideFile: "./configs/overrides.dev.json",
})
```

### Example Override File

```json
// configs/overrides.dev.json
{
  "ethereum": {
    "rpc": ["http://<my-private-rpc>"]
  },
  "base": {
    "contracts": {
      "prod": {
        "depository": "0x..."
      }
    }
  },
  "bitcoin": {
    "esploraCompatibleApiUrl": "https://enterprise.blockstream.info/api"
  }
}
```
