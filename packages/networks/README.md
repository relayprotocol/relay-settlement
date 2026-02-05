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
