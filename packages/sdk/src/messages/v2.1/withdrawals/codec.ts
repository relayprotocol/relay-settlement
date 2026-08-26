import {
  AbiParameter,
  AbiParameterToPrimitiveType,
  decodeAbiParameters,
  encodeAbiParameters,
  Hex,
} from "viem"

// Per-VM withdrawal codec. `W` is the decoded "withdrawal" payload type,
// i.e. DecodedXxxVmWithdrawal["withdrawal"].
export interface WithdrawalCodec<W> {
  encode: (withdrawal: W) => string
  decode: (encodedWithdrawal: string) => W
  getId: (withdrawal: W) => string
  getCurrency: (withdrawal: W) => string
  getAmount: (withdrawal: W) => string
  getRecipient: (withdrawal: W) => string
}

// Raw tuple type derived from a const-typed ABI parameter list.
export type AbiValues<TParams extends readonly AbiParameter[]> = {
  [K in keyof TParams]: AbiParameterToPrimitiveType<TParams[K]>
}

// Builds encode/decode from a single ABI parameter definition: the ABI schema
// is declared once and both directions are derived from it, with `toAbi` /
// `fromAbi` type-checked against the schema-derived tuple type. Renaming or
// retyping a field in `params` breaks compilation of the transforms, so the
// decoded type cannot drift from the ABI.
export const defineAbiWithdrawalCodec = <
  TParams extends readonly AbiParameter[],
  W,
>(config: {
  params: TParams
  toAbi: (withdrawal: W) => AbiValues<TParams>
  fromAbi: (values: AbiValues<TParams>) => W
}): Pick<WithdrawalCodec<W>, "encode" | "decode"> => ({
  encode: (withdrawal) =>
    // The widening casts are needed because TS cannot resolve viem's
    // conditional parameter types against a generic TParams; call sites
    // remain fully checked through the config object.
    encodeAbiParameters(
      config.params as readonly AbiParameter[],
      config.toAbi(withdrawal) as readonly unknown[]
    ),
  decode: (encodedWithdrawal) =>
    config.fromAbi(
      decodeAbiParameters(
        config.params as readonly AbiParameter[],
        encodedWithdrawal as Hex
      ) as AbiValues<TParams>
    ),
})
