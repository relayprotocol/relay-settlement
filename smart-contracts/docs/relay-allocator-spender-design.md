# RelayAllocatorSpender Design

## Purpose

A contract that holds `APPROVED_WITHDRAWER_ROLE` on `RelayAllocator` and gates calls to `signWithdrawPayloadHash` behind oracle EIP-712 signature verification.

## Architecture

- **Inheritance:** `AccessControl`, `EIP712`
- **Pattern:** Mirrors `RelayOracle`'s role structure with its own `ADMIN_ROLE` and `ORACLE_ROLE`

## Constructor

```solidity
constructor(address admin, address allocator) EIP712("RelayAllocatorSpender", "1")
```

- Sets `ADMIN_ROLE` as role admin for `ORACLE_ROLE`
- Grants `ADMIN_ROLE` to `admin`
- Stores `allocator` as immutable `ALLOCATOR`

## Roles

- `ADMIN_ROLE` — manages the oracle list
- `ORACLE_ROLE` — wallets/contracts whose signatures authorize withdrawal signing

## Immutables

- `ALLOCATOR` — the `RelayAllocator` contract reference

## EIP-712

- Domain: `name = "RelayAllocatorSpender"`, `version = "1"`
- Typehash: same `SubmitWithdrawRequest` struct as `RelayAllocator`

```
SubmitWithdrawRequest(uint256 chainId,string depository,string currency,uint256 amount,address spender,string receiver,bytes data,bytes32 nonce)
```

## Function

```solidity
function signWithdrawPayloadHash(
    RelayAllocator.SubmitWithdrawRequest calldata params,
    GasSettings memory gasSettings,
    uint32 hashIndex,
    address oracle,
    bytes calldata oracleSignature
) external
```

### Flow

1. Verify `oracle` has `ORACLE_ROLE` via `hasRole(ORACLE_ROLE, oracle)` — revert `UnauthorizedOracle` if not
2. Compute EIP-712 digest from `params`
3. Verify signature using `SignatureChecker.isValidSignatureNow(oracle, digest, oracleSignature)` — revert `InvalidOracleSignature` if invalid
4. Call `ALLOCATOR.signWithdrawPayloadHash(params, "", gasSettings, hashIndex)` — empty signature since this contract has `APPROVED_WITHDRAWER_ROLE`

### Errors

- `UnauthorizedOracle(address oracle)`
- `InvalidOracleSignature(address oracle)`

## Replay Protection

Delegated to `RelayAllocator`'s existing `PayloadAlreadySigned` and `SignaturePending` checks.

## Signature Support

Both EOA (ECDSA) and EIP-1271 contract signatures via OpenZeppelin `SignatureChecker`.

## Dependencies

- `RelayAllocator` (for struct types and `signWithdrawPayloadHash`)
- OpenZeppelin: `AccessControl`, `EIP712`, `SignatureChecker`
