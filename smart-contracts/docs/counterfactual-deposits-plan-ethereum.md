# Counterfactual Deposit Addresses

## Goal

Add contracts for unique deposit addresses per (order ID, depositor) pair that can be computed before deployment and sweep funds to a depository when deployed.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│              DepositAddressFactory                               │
│  - computeDepositAddress(orderId, depositor) → address   │
│  - sweep(orderId, depositor, tokens)                     │
│  - implementation (immutable → DepositAddress)           │
│  - depository (immutable → destination)                  │
└───────────────────┬──────────────────────────────────────┘
                    │ CREATE2 (EIP-1167 minimal proxy)
                    ▼
┌──────────────────────────────────────────────────────────┐
│         Minimal Proxy (per orderId + depositor)          │
│  Deterministic address based on hash(orderId, depositor) │
└───────────────────┬──────────────────────────────────────┘
                    │ delegatecall
                    ▼
┌──────────────────────────────────────────────────────────┐
│             DepositAddress                                │
│  - sweep(token, depository, depositor, orderId)          │
│  - ERC20: approve depository, call depositErc20          │
│  - Native: call depositNative{value}                     │
└──────────────────────────────────────────────────────────┘
                    │ calls
                    ▼
┌──────────────────────────────────────────────────────────┐
│             Depository (external)                         │
│  - depositErc20(depositor, token, id)                    │
│  - depositNative(depositor, id) payable                  │
└──────────────────────────────────────────────────────────┘
```

## Implementation

### 1. DepositAddress.sol

Minimal implementation contract (deployed once, used via proxies):

- `sweep(address token, address depository, address depositor, bytes32 id)` - deposits funds into depository on behalf of depositor
  - **ERC20**: approves depository for the full balance, then calls `depository.depositErc20(depositor, token, id)`. The depository's 3-param overload reads the full allowance and pulls tokens via `safeTransferFrom` — no residual approval.
  - **Native (token = address(0))**: calls `depository.depositNative{value: balance}(depositor, id)`. The depository accepts the ETH and emits a `RelayNativeDeposit` event for accounting.
- `receive() external payable {}` - allows ETH deposits after proxy deployment (prevents griefing)
- Uses Solady's `SafeTransferLib` for safe approvals
- Stateless - no storage variables

**Why receive() is needed:** Without it, an attacker could grief by calling `sweep` before the user deposits, deploying the proxy early. ERC20s would still work (can sweep later), but native ETH transfers would revert. The proxy delegates receive() to the implementation.

**Why we call depositErc20/depositNative instead of raw transfers:** The depository contract tracks deposits by depositor and order ID. A raw transfer would credit no one. The sweep must go through the depository's deposit functions so the funds are properly attributed.

**Depository deposit mechanics:** The RelayDepository has two `depositErc20` overloads: a 4-param version `(depositor, token, amount, id)` that pulls an explicit amount, and a 3-param version `(depositor, token, id)` that reads the full allowance and delegates to the 4-param version. The sweep uses the 3-param overload so the depository pulls the entire approved balance. For native ETH, `depositNative` accepts `msg.value` and emits a `RelayNativeDeposit` event — the ETH is held by the depository and managed via its `execute()` function.

### 2. DepositAddressFactory.sol

Factory for deterministic deposit addresses:

- `depository` (immutable) - hardcoded destination for all sweeps (set at deployment)
- `computeDepositAddress(bytes32 orderId, address depositor)` - predict address before deployment
- `sweep(bytes32 orderId, address depositor, address[] tokens)` - deploy proxy if needed and sweep multiple tokens to depository. Auto-deploys on first call, re-sweeps on subsequent calls. Reverts if any individual token sweep fails.
- Uses Solady's `LibClone.cloneDeterministic` for CREATE2 deployment
- Salt = `keccak256(abi.encodePacked(orderId, depositor))` — binds depositor to the deposit address
- Emits `ProxyDeployed(bytes32 indexed orderId, address proxyAddress)` on deployment
- Emits `Swept(bytes32 indexed orderId, address indexed depositor, address token, uint256 amount)` per token swept

### 3. RelayDepository.sol

Minimal local interface matching the RelayDepository contract:

- `depositErc20(address depositor, address token, bytes32 id)` - 3-param overload (reads full allowance, pulls via transferFrom)
- `depositErc20(address depositor, address token, uint256 amount, bytes32 id)` - 4-param overload (explicit amount)
- `depositNative(address depositor, bytes32 id) payable` - accepts native ETH

### 4. IDepositAddressFactory.sol

Interface for external integrations.

## Files to Create

```
smart-contracts/contracts/
├── DepositAddressFactory.sol
├── DepositAddress.sol
└── interfaces/
    ├── RelayDepository.sol
    └── IDepositAddressFactory.sol

smart-contracts/test/DepositAddressFactory/
├── computeAddress.ts
├── edgeCases.ts
└── sweep.ts
```

## Key Design Decisions

1. **EIP-1167 minimal proxies** - ~45 bytes runtime, cheapest deployment
2. **Depositor bound to salt** - salt = `keccak256(orderId, depositor)` prevents depositor spoofing via front-running
3. **Multi-token sweep** - sweep multiple tokens in one tx (ERC20s + native), bounded by gas limits
4. **Atomic sweep** - if any individual token sweep fails, the entire transaction reverts (no partial sweeps)
5. **No access control on sweep** - anyone can trigger (funds always go to hardcoded depository)
6. **Hardcoded depository** - immutable in factory, prevents sweeping to arbitrary addresses
7. **Stateless sweeper** - implementation has no storage, all params passed per-call
8. **receive() required** - prevents griefing where attacker deploys before user deposits; proxy delegates to implementation's receive()
9. **Deposit via depository functions** - sweep calls `depositErc20`/`depositNative` (not raw transfers) so funds are attributed to the depositor and order
10. **Events for off-chain tracking** - `ProxyDeployed` and `Swept` events enable indexing sweep activity

## Stack

- **Hardhat** - compilation, testing, deployment
- **Viem** - contract interactions in tests
- **Mocha/Chai** - test framework (existing pattern)
- **Solidity 0.8.28** - compiler version
- **loadFixture** - deterministic test deployments

## Dependencies (already available)

- `solady/src/utils/LibClone.sol` - CREATE2 clone deployment
- `solady/src/utils/SafeTransferLib.sol` - safe token approvals
- `@openzeppelin/contracts/token/ERC20/IERC20.sol` - ERC20 interface

## Dependencies (new)

- `RelayDepository` interface - minimal interface matching the RelayDepository contract from `packages/depository/packages/ethereum-vm/`. Includes both `depositErc20` overloads and `depositNative`.

## TDD Workflow

Tests written BEFORE implementation. Order of development:

### Phase 1: DepositAddressFactory address computation

1. Write test: `computeDepositAddress` returns deterministic address for orderId and depositor
2. Write test: same (orderId, depositor) always returns same address
3. Write test: different orderId returns different address
4. Write test: different depositor returns different address
5. Implement minimal `computeDepositAddress` to pass tests

### Phase 2: Sweep (auto-deploys proxy)

The core flow: funds are sent to the pre-computed address **before** the proxy is deployed, then `sweep` auto-deploys the proxy if needed and sweeps.

1. Write test: `sweep` deploys proxy at predicted address on first call
2. Write test: ERC20 sent to pre-computed address before deployment is swept via `depositErc20(depositor, token, id)`
3. Write test: native ETH sent to pre-computed address before deployment is swept via `depositNative{value}(depositor, id)`
4. Write test: multiple tokens swept in single call
5. Write test: depositor address is correctly passed through to depository
6. Implement `sweep` to pass tests

### Phase 3: Edge cases and errors

1. Write test: second sweep with same orderId succeeds (idempotent — no re-deploy)
2. Write test: sweep with zero balance succeeds (no-op)
3. Write test: non-standard ERC20 (USDT-style) works
4. Write test: ETH sent after deployment can be received and swept (anti-griefing)
5. Write test: auto-deploy on first sweep (no prior deployment needed)
6. Write test: `address(0)` passed multiple times in tokens array
7. Implement error handling to pass tests

### Phase 4: Re-sweep (double deposits)

Handles the case where additional funds are sent to the deposit address after the initial sweep.

1. Write test: `sweep` works on already-deployed address for ERC20
2. Write test: `sweep` works on already-deployed address for native ETH
3. Write test: re-sweep does not emit ProxyDeployed event
4. Write test: sweeping with wrong depositor does not access the original deposit address

## Security Checklist

Vulnerabilities to check and test:

### Reentrancy

- [ ] Sweep calls external depository contract (approve + depositErc20, or depositNative) — no state to corrupt (stateless sweeper)
- [ ] Depository is a trusted immutable address, limiting reentrancy risk

### Access Control

- [ ] Depository is immutable (cannot be changed post-deployment)
- [ ] Anyone can trigger sweep (by design - funds go to hardcoded depository)

### Token Handling

- [ ] Non-standard ERC20s (USDT, BNB) - use SafeTransferLib for approve
- [ ] Zero-balance sweep doesn't revert
- [ ] Fee-on-transfer tokens - test expected behavior
- [ ] Approve-before-deposit pattern: sweeper approves depository, then depository pulls tokens via transferFrom

### CREATE2 / Proxy

- [ ] Duplicate orderId is handled idempotently (proxy deployed only once, subsequent sweeps skip deployment)
- [ ] orderId is a hash generated offchain, ensuring uniqueness at the application layer
- [ ] Proxy cannot be initialized twice (stateless, no init)
- [ ] Implementation cannot be changed (immutable)

### Denial of Service

- [ ] Gas limits naturally bound the tokens array size
- [ ] Failed token sweep reverts the entire transaction (atomic — no partial sweeps)

### Front-running / Griefing

- [ ] Depositor spoofing prevented: depositor is part of CREATE2 salt, so a wrong depositor yields a different (empty) address
- [ ] Front-running sweep is harmless (funds go to same depository, depositor is bound)
- [ ] Front-running deployment is harmless (same outcome)
- [ ] Griefing via early deployment: ETH can still be deposited and swept (receive() handles this)

## Verification

1. **Unit tests**: Run `yarn test test/DepositAddressFactory/`
2. **Coverage**: Run `yarn coverage` - target 100% for new contracts
3. **Lint**: Run `yarn lint` before commit
4. **Integration test**: End-to-end flow on hardhat network
