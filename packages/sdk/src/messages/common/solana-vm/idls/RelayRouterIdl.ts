// ABOUTME: Minimal relay-router IDL: instruction accounts and args, accounts, errors and the
// ABOUTME: borsh types shared with the depository routed transfer.

// Account order mirrors the program; the bundle PDA and unused optional accounts must
// be passed explicitly.
export const RelayRouterIdl = {
  address: "",
  metadata: {
    name: "relay_router",
    version: "0.1.0",
    spec: "0.1.0",
    description: "Relay router program",
  },
  instructions: [
    {
      name: "release",
      discriminator: [253, 249, 15, 206, 28, 127, 193, 241],
      accounts: [
        { name: "executor", writable: true, signer: true },
        { name: "bundle_address", writable: true },
        { name: "router_authority" },
        { name: "depository_program" },
        { name: "relay_depository" },
        { name: "vault", writable: true },
        { name: "withdraw_mint", optional: true },
        {
          name: "bundle_withdraw_token_account",
          writable: true,
          optional: true,
        },
        { name: "vault_token_account", writable: true, optional: true },
        { name: "used_request", writable: true },
        { name: "ix_sysvar" },
        { name: "withdraw_token_program" },
        { name: "associated_token_program" },
        { name: "system_program" },
        { name: "depository_role" },
      ],
      args: [
        {
          name: "bundle_hash",
          type: { array: ["u8", 32] },
        },
        {
          name: "bump",
          type: "u8",
        },
        {
          name: "request",
          type: { defined: { name: "RoutedTransferRequest" } },
        },
      ],
    },
    {
      name: "settle",
      discriminator: [175, 42, 185, 87, 144, 131, 102, 212],
      accounts: [
        { name: "executor", writable: true, signer: true },
        { name: "bundle_address", writable: true },
        { name: "recipient", writable: true },
        { name: "fill_mint", optional: true },
        { name: "bundle_fill_token_account", writable: true, optional: true },
        {
          name: "recipient_fill_token_account",
          writable: true,
          optional: true,
        },
        { name: "withdraw_mint", optional: true },
        {
          name: "bundle_withdraw_token_account",
          writable: true,
          optional: true,
        },
        {
          name: "recipient_withdraw_token_account",
          writable: true,
          optional: true,
        },
        { name: "ix_sysvar" },
        { name: "fill_token_program", optional: true },
        { name: "withdraw_token_program", optional: true },
        { name: "system_program" },
      ],
      args: [
        {
          name: "bundle",
          type: { defined: { name: "Bundle" } },
        },
        {
          name: "bump",
          type: "u8",
        },
      ],
    },
    {
      name: "initialize",
      discriminator: [175, 175, 109, 31, 13, 152, 155, 237],
      accounts: [
        { name: "config", writable: true },
        { name: "authority", writable: true, signer: true },
        { name: "program" },
        { name: "program_data" },
        { name: "system_program" },
      ],
      args: [{ name: "owner", type: "pubkey" }],
    },
    {
      name: "grant_depository_role",
      discriminator: [99, 28, 230, 234, 150, 188, 175, 212],
      accounts: [
        { name: "config" },
        { name: "owner", writable: true, signer: true },
        { name: "depository_role", writable: true },
        { name: "system_program" },
      ],
      args: [{ name: "depository", type: "pubkey" }],
    },
    {
      name: "revoke_depository_role",
      discriminator: [21, 126, 197, 114, 220, 180, 7, 176],
      accounts: [
        { name: "config" },
        { name: "owner", writable: true, signer: true },
        { name: "depository_role", writable: true },
      ],
      args: [{ name: "depository", type: "pubkey" }],
    },
    {
      name: "set_owner",
      discriminator: [72, 202, 120, 52, 77, 128, 96, 197],
      accounts: [
        { name: "config", writable: true },
        { name: "owner", signer: true },
      ],
      args: [{ name: "new_owner", type: "pubkey" }],
    },
  ],
  accounts: [
    {
      name: "RouterConfig",
      discriminator: [147, 20, 81, 135, 46, 251, 46, 139],
    },
    {
      name: "DepositoryRole",
      discriminator: [143, 69, 84, 191, 57, 107, 241, 31],
    },
  ],
  errors: [
    { code: 6000, name: "NotTopLevel", msg: "Must be a top-level instruction" },
    { code: 6001, name: "MissingSettle", msg: "Missing settle instruction" },
    { code: 6002, name: "MissingRelease", msg: "Missing release instruction" },
    {
      code: 6003,
      name: "MultipleBundleInstructions",
      msg: "Only one release and one settle per transaction",
    },
    { code: 6004, name: "InvalidBundle", msg: "Invalid bundle" },
    { code: 6005, name: "InvalidBundleAddress", msg: "Invalid bundle address" },
    { code: 6006, name: "InvalidExecutor", msg: "Invalid executor" },
    { code: 6007, name: "InvalidDepository", msg: "Invalid depository" },
    { code: 6008, name: "InvalidRouter", msg: "Invalid router" },
    { code: 6009, name: "InvalidMint", msg: "Invalid mint" },
    { code: 6010, name: "InvalidRecipient", msg: "Invalid recipient" },
    { code: 6011, name: "InvalidTokenAccount", msg: "Invalid token account" },
    {
      code: 6012,
      name: "InsufficientWithdrawal",
      msg: "Withdrawal below the bundle minimum",
    },
    {
      code: 6013,
      name: "InsufficientFill",
      msg: "Fill below the bundle minimum",
    },
    {
      code: 6014,
      name: "CallsNotSupported",
      msg: "Bundle calls are not supported",
    },
    { code: 6015, name: "DepositoryNotAllowed", msg: "Depository not allowed" },
    { code: 6016, name: "Unauthorized", msg: "Unauthorized" },
    {
      code: 6017,
      name: "SameCurrencyNotSupported",
      msg: "Withdraw and fill currency must differ",
    },
    { code: 6018, name: "InvalidOwner", msg: "Invalid owner" },
  ],
  types: [
    {
      name: "RouterConfig",
      type: {
        kind: "struct",
        fields: [{ name: "owner", type: "pubkey" }],
      },
    },
    {
      name: "DepositoryRole",
      type: { kind: "struct", fields: [] },
    },
    {
      name: "RoutedTransferRequest",
      type: {
        kind: "struct",
        fields: [
          { name: "domain", type: { array: ["u8", 32] } },
          { name: "recipient", type: "pubkey" },
          { name: "token", type: { option: "pubkey" } },
          { name: "amount", type: "u64" },
          { name: "nonce", type: "u64" },
          { name: "expiration", type: "i64" },
          { name: "vault_address", type: "pubkey" },
          { name: "router", type: "pubkey" },
        ],
      },
    },
    {
      name: "CallAccount",
      type: {
        kind: "struct",
        fields: [
          { name: "pubkey", type: "pubkey" },
          { name: "is_writable", type: "bool" },
        ],
      },
    },
    {
      name: "BundleCall",
      type: {
        kind: "struct",
        fields: [
          { name: "program_id_index", type: "u8" },
          { name: "account_indexes", type: "bytes" },
          { name: "data", type: "bytes" },
        ],
      },
    },
    {
      name: "Bundle",
      type: {
        kind: "struct",
        fields: [
          { name: "version", type: "u8" },
          { name: "order_id", type: { array: ["u8", 32] } },
          { name: "execution_id", type: { array: ["u8", 32] } },
          { name: "executor", type: "pubkey" },
          { name: "depository", type: "pubkey" },
          { name: "withdraw_mint", type: { option: "pubkey" } },
          { name: "minimum_withdraw_amount", type: "u64" },
          { name: "fill_mint", type: "pubkey" },
          { name: "recipient", type: "pubkey" },
          { name: "minimum_amount", type: "u64" },
          {
            name: "call_accounts",
            type: { vec: { defined: { name: "CallAccount" } } },
          },
          {
            name: "calls",
            type: { vec: { defined: { name: "BundleCall" } } },
          },
        ],
      },
    },
  ],
}
