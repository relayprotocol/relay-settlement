use anchor_lang::{
    prelude::*,
    solana_program::{
        bpf_loader_upgradeable,
        instruction::{get_stack_height, AccountMeta, Instruction, TRANSACTION_LEVEL_STACK_HEIGHT},
        program::invoke_signed,
    },
};
use anchor_spl::token::{transfer_checked, Mint, Token, TokenAccount, TransferChecked};
use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked};
use solana_sha256_hasher::hash;

///
/// A Solana depository for Circle Gateway built with the Anchor framework.
/// It deposits USDC into the allocator's Circle Gateway balance and pays out
/// allocator-signed transfers funded by a Circle Gateway mint.
///

//----------------------------------------
// Constants
//----------------------------------------

const RELAY_GATEWAY_DEPOSITORY_SEED: &[u8] = b"relay_gateway_depository";

const USED_REQUEST_SEED: &[u8] = b"used_request";

const VAULT_SEED: &[u8] = b"gateway_vault";

const DOMAIN_NAME: &[u8] = b"RelayGatewayDepository";

const DOMAIN_VERSION: &[u8] = b"1";

const TRANSFER_REQUEST_PREFIX: &[u8] = b"RelayGatewayDepository:TransferRequest:v1";

const ROUTED_TRANSFER_REQUEST_PREFIX: &[u8] = b"RelayGatewayDepository:RoutedTransferRequest:v1";

const DEPOSITORY_CALLER_SEED: &[u8] = b"depository_caller";

const ED25519_PROGRAM_ID: Pubkey = pubkey!("Ed25519SigVerify111111111111111111111111111");

/// Circle GatewayMinter `gateway_mint_with_params` instruction discriminator
const GATEWAY_MINT_WITH_PARAMS_DISCRIMINATOR: [u8; 2] = [12, 1];

/// Circle GatewayWallet `deposit_for` instruction discriminator
const DEPOSIT_FOR_DISCRIMINATOR: [u8; 2] = [22, 1];

//----------------------------------------
// Program ID
//----------------------------------------

declare_id!("DAt1pZmsCkKJ3WETGZPrtLhZq9inV3DrBSeZu12EKSe8");

//----------------------------------------
// Program Module
//----------------------------------------

#[program]
pub mod relay_gateway_depository {
    use super::*;

    /// Initialize the gateway depository
    ///
    /// Creates the state account and the vault token account, and pins the
    /// USDC mint and the Circle Gateway programs this deployment talks to.
    /// Only the program's upgrade authority can call this, once.
    ///
    /// # Parameters
    /// * `ctx` - The context containing the accounts
    /// * `chain_id` - The chain identifier (e.g., "solana-mainnet")
    /// * `owner` - The owner of the gateway depository who can update settings
    ///
    /// # Returns
    /// * `Ok(())` on success
    pub fn initialize(ctx: Context<Initialize>, chain_id: String, owner: Pubkey) -> Result<()> {
        let relay_gateway_depository = &mut ctx.accounts.relay_gateway_depository;
        relay_gateway_depository.owner = owner;
        relay_gateway_depository.allocator = ctx.accounts.allocator.key();
        relay_gateway_depository.mint = ctx.accounts.mint.key();
        relay_gateway_depository.gateway_minter = ctx.accounts.gateway_minter_program.key();
        relay_gateway_depository.gateway_wallet = ctx.accounts.gateway_wallet_program.key();
        relay_gateway_depository.deposits_enabled = false;
        relay_gateway_depository.bump = ctx.bumps.relay_gateway_depository;
        relay_gateway_depository.vault_bump = ctx.bumps.vault;
        relay_gateway_depository.domain_separator = create_domain_separator(
            DOMAIN_NAME,
            DOMAIN_VERSION,
            chain_id.as_bytes(),
            ctx.program_id,
        );

        Ok(())
    }

    /// Update the allocator public key
    ///
    /// Existing Circle Gateway funds remain owned by the previous allocator.
    ///
    /// # Parameters
    /// * `ctx` - The context containing the accounts
    /// * `new_allocator` - The public key of the new allocator
    ///
    /// # Returns
    /// * `Ok(())` on success
    /// * `Err(error)` if not authorized
    pub fn set_allocator(ctx: Context<OwnerOnly>, new_allocator: Pubkey) -> Result<()> {
        require_keys_neq!(
            new_allocator,
            Pubkey::default(),
            CustomError::InvalidAllocator
        );
        ctx.accounts.relay_gateway_depository.allocator = new_allocator;
        Ok(())
    }

    /// Update the owner public key
    ///
    /// # Parameters
    /// * `ctx` - The context containing the accounts
    /// * `new_owner` - The public key of the new owner
    ///
    /// # Returns
    /// * `Ok(())` on success
    /// * `Err(error)` if not authorized
    pub fn set_owner(ctx: Context<OwnerOnly>, new_owner: Pubkey) -> Result<()> {
        require_keys_neq!(new_owner, Pubkey::default(), CustomError::InvalidOwner);
        ctx.accounts.relay_gateway_depository.owner = new_owner;
        Ok(())
    }

    /// Enable or disable deposits into Circle Gateway
    ///
    /// # Parameters
    /// * `ctx` - The context containing the accounts
    /// * `enabled` - Whether deposits should be enabled
    ///
    /// # Returns
    /// * `Ok(())` on success
    /// * `Err(error)` if not authorized
    pub fn set_deposits_enabled(ctx: Context<OwnerOnly>, enabled: bool) -> Result<()> {
        ctx.accounts.relay_gateway_depository.deposits_enabled = enabled;
        Ok(())
    }

    /// Move tokens that were sent to the vault directly out of it
    ///
    /// The vault only holds funds within a single instruction, so anything left
    /// in it was transferred there by mistake.
    ///
    /// # Parameters
    /// * `ctx` - The context containing the accounts
    /// * `amount` - The amount of tokens to move
    ///
    /// # Returns
    /// * `Ok(())` on success
    /// * `Err(error)` if not authorized
    pub fn sweep(ctx: Context<Sweep>, amount: u64) -> Result<()> {
        let relay_gateway_depository = &ctx.accounts.relay_gateway_depository;
        let seeds: &[&[u8]] = &[
            RELAY_GATEWAY_DEPOSITORY_SEED,
            &[relay_gateway_depository.bump],
        ];

        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    mint: ctx.accounts.mint.to_account_info(),
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.destination_token_account.to_account_info(),
                    authority: relay_gateway_depository.to_account_info(),
                },
                &[seeds],
            ),
            amount,
            ctx.accounts.mint.decimals,
        )
    }

    /// Deposit USDC into the allocator's Circle Gateway balance
    ///
    /// Transfers tokens from the sender through the vault into Circle Gateway,
    /// credited to the allocator, and emits a deposit event.
    ///
    /// # Parameters
    /// * `ctx` - The context containing the accounts
    /// * `amount` - The amount of tokens to deposit
    /// * `id` - A unique identifier for the deposit
    ///
    /// # Returns
    /// * `Ok(())` on success
    /// * `Err(error)` if deposits are disabled
    pub fn deposit(ctx: Context<Deposit>, amount: u64, id: [u8; 32]) -> Result<()> {
        let relay_gateway_depository = &ctx.accounts.relay_gateway_depository;
        require!(
            relay_gateway_depository.deposits_enabled,
            CustomError::DepositsDisabled
        );

        // Transfer to vault
        transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    mint: ctx.accounts.mint.to_account_info(),
                    from: ctx.accounts.sender_token_account.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.sender.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;

        // Deposit the exact amount into the allocator's Gateway balance
        let mut data = DEPOSIT_FOR_DISCRIMINATOR.to_vec();
        data.extend_from_slice(&amount.to_le_bytes());
        data.extend_from_slice(relay_gateway_depository.allocator.as_ref());

        let seeds: &[&[u8]] = &[
            RELAY_GATEWAY_DEPOSITORY_SEED,
            &[relay_gateway_depository.bump],
        ];
        invoke_signed(
            &Instruction {
                program_id: ctx.accounts.gateway_wallet_program.key(),
                accounts: vec![
                    AccountMeta::new(ctx.accounts.sender.key(), true),
                    AccountMeta::new_readonly(relay_gateway_depository.key(), true),
                    AccountMeta::new_readonly(ctx.accounts.gateway_wallet.key(), false),
                    AccountMeta::new(ctx.accounts.vault.key(), false),
                    AccountMeta::new(ctx.accounts.gateway_wallet_custody.key(), false),
                    AccountMeta::new(ctx.accounts.gateway_deposit.key(), false),
                    AccountMeta::new_readonly(ctx.accounts.depository_denylist.key(), false),
                    AccountMeta::new_readonly(ctx.accounts.allocator_denylist.key(), false),
                    AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
                    AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
                    AccountMeta::new_readonly(
                        ctx.accounts.gateway_wallet_event_authority.key(),
                        false,
                    ),
                    AccountMeta::new_readonly(ctx.accounts.gateway_wallet_program.key(), false),
                ],
                data,
            },
            &[
                ctx.accounts.sender.to_account_info(),
                relay_gateway_depository.to_account_info(),
                ctx.accounts.gateway_wallet.to_account_info(),
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.gateway_wallet_custody.to_account_info(),
                ctx.accounts.gateway_deposit.to_account_info(),
                ctx.accounts.depository_denylist.to_account_info(),
                ctx.accounts.allocator_denylist.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
                ctx.accounts
                    .gateway_wallet_event_authority
                    .to_account_info(),
                ctx.accounts.gateway_wallet_program.to_account_info(),
            ],
            &[seeds],
        )?;

        emit!(DepositEvent {
            depositor: ctx.accounts.depositor.key(),
            token: ctx.accounts.mint.key(),
            amount,
            id,
        });

        Ok(())
    }

    /// Execute a transfer with allocator signature
    ///
    /// Verifies the allocator's signature, mints the request's transfer spec
    /// from Circle Gateway into the vault, and pays the recipient.
    ///
    /// # Parameters
    /// * `ctx` - The context containing the accounts
    /// * `request` - The transfer request details
    /// * `max_block_height` - The slot the Circle attestation expires after
    /// * `circle_signature` - The Circle signature over the attestation
    ///
    /// # Returns
    /// * `Ok(())` on success
    /// * `Err(error)` if a signature is invalid or the request can't be processed
    pub fn execute_transfer(
        ctx: Context<ExecuteTransfer>,
        request: GatewayTransferRequest,
        max_block_height: u64,
        circle_signature: [u8; 65],
    ) -> Result<()> {
        let request_hash = request.get_hash();

        process_transfer(
            TransferAccounts {
                relay_gateway_depository: &ctx.accounts.relay_gateway_depository,
                executor: &ctx.accounts.executor,
                recipient: &ctx.accounts.recipient,
                vault: &ctx.accounts.vault,
                mint: &ctx.accounts.mint,
                recipient_token_account: &ctx.accounts.recipient_token_account,
                ix_sysvar: &ctx.accounts.ix_sysvar,
                gateway_minter_program: &ctx.accounts.gateway_minter_program,
                gateway_minter: &ctx.accounts.gateway_minter,
                gateway_minter_custody: &ctx.accounts.gateway_minter_custody,
                used_transfer_spec_hash: &ctx.accounts.used_transfer_spec_hash,
                gateway_minter_event_authority: &ctx.accounts.gateway_minter_event_authority,
                token_program: &ctx.accounts.token_program,
                system_program: &ctx.accounts.system_program,
            },
            &request,
            &request_hash,
            max_block_height,
            &circle_signature,
        )?;

        ctx.accounts.used_request.is_used = true;

        emit!(GatewayTransferExecutedEvent {
            id: request_hash,
            request,
            executor: ctx.accounts.executor.key(),
        });

        Ok(())
    }

    /// Execute a routed transfer with allocator signature
    ///
    /// Runs the same checks as `execute_transfer`, and additionally requires the
    /// request's router to sign through its `depository_caller` PDA. Only the router
    /// program can produce that signature, so a routed request can only execute
    /// inside the router instruction that consumes the funds.
    ///
    /// # Parameters
    /// * `ctx` - The context containing the accounts
    /// * `request` - The routed transfer request details
    /// * `max_block_height` - The slot the Circle attestation expires after
    /// * `circle_signature` - The Circle signature over the attestation
    ///
    /// # Returns
    /// * `Ok(())` on success
    /// * `Err(error)` if the router did not sign or the request can't be processed
    pub fn execute_transfer_routed(
        ctx: Context<ExecuteTransferRouted>,
        request: GatewayRoutedTransferRequest,
        max_block_height: u64,
        circle_signature: [u8; 65],
    ) -> Result<()> {
        let (expected_router_authority, _) =
            Pubkey::find_program_address(&[DEPOSITORY_CALLER_SEED], &request.router);
        require_keys_eq!(
            ctx.accounts.router_authority.key(),
            expected_router_authority,
            CustomError::InvalidRouterAuthority
        );

        // Signer privileges flow through nested CPIs, so only accept the router's
        // top-level instruction as the direct caller
        require!(
            get_stack_height() == TRANSACTION_LEVEL_STACK_HEIGHT + 1,
            CustomError::InvalidRouterCaller
        );

        let request_hash = request.get_hash();

        // Same checks and transfer as a plain request; only the signed hash differs
        process_transfer(
            TransferAccounts {
                relay_gateway_depository: &ctx.accounts.relay_gateway_depository,
                executor: &ctx.accounts.executor,
                recipient: &ctx.accounts.recipient,
                vault: &ctx.accounts.vault,
                mint: &ctx.accounts.mint,
                recipient_token_account: &ctx.accounts.recipient_token_account,
                ix_sysvar: &ctx.accounts.ix_sysvar,
                gateway_minter_program: &ctx.accounts.gateway_minter_program,
                gateway_minter: &ctx.accounts.gateway_minter,
                gateway_minter_custody: &ctx.accounts.gateway_minter_custody,
                used_transfer_spec_hash: &ctx.accounts.used_transfer_spec_hash,
                gateway_minter_event_authority: &ctx.accounts.gateway_minter_event_authority,
                token_program: &ctx.accounts.token_program,
                system_program: &ctx.accounts.system_program,
            },
            &GatewayTransferRequest {
                domain: request.domain,
                transfer_spec_hash: request.transfer_spec_hash,
                recipient: request.recipient,
                token: request.token,
                amount: request.amount,
                nonce: request.nonce,
                expiration: request.expiration,
            },
            &request_hash,
            max_block_height,
            &circle_signature,
        )?;

        ctx.accounts.used_request.is_used = true;

        emit!(GatewayRoutedTransferExecutedEvent {
            id: request_hash,
            request,
            executor: ctx.accounts.executor.key(),
        });

        Ok(())
    }
}

//----------------------------------------
// Account Structures
//----------------------------------------

/// Gateway depository account that stores configuration and state
///
/// This account is a PDA derived from the `RELAY_GATEWAY_DEPOSITORY_SEED`.
/// It is also the token authority of the vault.
#[account]
#[derive(InitSpace)]
pub struct RelayGatewayDepository {
    /// The owner of the gateway depository who can update settings
    pub owner: Pubkey,
    /// The allocator that signs transfer requests and owns the Circle Gateway balance
    pub allocator: Pubkey,
    /// The USDC mint deposited into and minted from Circle Gateway
    pub mint: Pubkey,
    /// The Circle GatewayMinter program
    pub gateway_minter: Pubkey,
    /// The Circle GatewayWallet program
    pub gateway_wallet: Pubkey,
    /// Whether deposits into Circle Gateway are enabled
    pub deposits_enabled: bool,
    /// The bump seed for this account
    pub bump: u8,
    /// The bump seed for the vault PDA
    pub vault_bump: u8,
    /// Expected domain separator hash for this deployment
    pub domain_separator: [u8; 32],
}

/// Account that tracks whether a transfer request has been used
///
/// This account is created for each transfer request to prevent replay attacks.
#[account]
#[derive(InitSpace)]
pub struct UsedRequest {
    /// Flag indicating whether the request has been processed
    pub is_used: bool,
}

//----------------------------------------
// Instruction Contexts
//----------------------------------------

/// Accounts required for initializing the gateway depository
#[derive(Accounts)]
pub struct Initialize<'info> {
    /// The gateway depository account to be initialized
    #[account(
        init,
        payer = authority,
        space = 8 + RelayGatewayDepository::INIT_SPACE,
        seeds = [RELAY_GATEWAY_DEPOSITORY_SEED],
        bump
    )]
    pub relay_gateway_depository: Account<'info, RelayGatewayDepository>,

    /// The vault token account, created at the vault PDA itself so that one address is
    /// both the Circle destination caller and the Circle destination recipient
    #[account(
        init,
        payer = authority,
        seeds = [VAULT_SEED],
        bump,
        token::mint = mint,
        token::authority = relay_gateway_depository,
    )]
    pub vault: Account<'info, TokenAccount>,

    /// The program's upgrade authority
    #[account(mut)]
    pub authority: Signer<'info>,

    /// This program's data account
    #[account(
        seeds = [crate::ID.as_ref()],
        bump,
        seeds::program = bpf_loader_upgradeable::ID,
        constraint = program_data.upgrade_authority_address == Some(authority.key()) @ CustomError::Unauthorized
    )]
    pub program_data: Account<'info, ProgramData>,

    /// The allocator account that will be authorized to sign transfer requests
    /// CHECK: Used as public key only
    pub allocator: UncheckedAccount<'info>,

    /// The USDC mint
    pub mint: Account<'info, Mint>,

    /// The Circle GatewayMinter program
    /// CHECK: Used as public key only
    #[account(executable)]
    pub gateway_minter_program: UncheckedAccount<'info>,

    /// The Circle GatewayWallet program
    /// CHECK: Used as public key only
    #[account(executable)]
    pub gateway_wallet_program: UncheckedAccount<'info>,

    /// The token program
    pub token_program: Program<'info, Token>,
    /// The system program
    pub system_program: Program<'info, System>,
}

/// Accounts required for updating a setting
#[derive(Accounts)]
pub struct OwnerOnly<'info> {
    /// The gateway depository account to update
    #[account(
        mut,
        seeds = [RELAY_GATEWAY_DEPOSITORY_SEED],
        bump = relay_gateway_depository.bump,
        has_one = owner @ CustomError::Unauthorized
    )]
    pub relay_gateway_depository: Account<'info, RelayGatewayDepository>,

    /// The owner of the gateway depository
    pub owner: Signer<'info>,
}

/// Accounts required for sweeping the vault
#[derive(Accounts)]
pub struct Sweep<'info> {
    /// The gateway depository account
    #[account(
        seeds = [RELAY_GATEWAY_DEPOSITORY_SEED],
        bump = relay_gateway_depository.bump,
        has_one = owner @ CustomError::Unauthorized,
        has_one = mint @ CustomError::InvalidMint
    )]
    pub relay_gateway_depository: Account<'info, RelayGatewayDepository>,

    /// The owner of the gateway depository
    pub owner: Signer<'info>,

    /// The USDC mint
    pub mint: Account<'info, Mint>,

    /// The vault token account
    #[account(
        mut,
        seeds = [VAULT_SEED],
        bump = relay_gateway_depository.vault_bump
    )]
    pub vault: Account<'info, TokenAccount>,

    /// The token account that receives the swept tokens
    #[account(mut)]
    pub destination_token_account: Account<'info, TokenAccount>,

    /// The token program
    pub token_program: Program<'info, Token>,
}

/// Accounts required for depositing into Circle Gateway
#[derive(Accounts)]
pub struct Deposit<'info> {
    /// The gateway depository account
    #[account(
        seeds = [RELAY_GATEWAY_DEPOSITORY_SEED],
        bump = relay_gateway_depository.bump,
        has_one = mint @ CustomError::InvalidMint
    )]
    pub relay_gateway_depository: Box<Account<'info, RelayGatewayDepository>>,

    /// The sender of the deposit, who also pays for the Circle deposit account
    #[account(mut)]
    pub sender: Signer<'info>,

    /// The account credited for the deposit on the Hub; anyone can deposit on its behalf
    /// CHECK: Only named in the deposit event, the Circle Gateway balance goes to the allocator
    pub depositor: UncheckedAccount<'info>,

    /// The USDC mint
    pub mint: Box<Account<'info, Mint>>,

    /// The sender's token account
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = sender
    )]
    pub sender_token_account: Box<Account<'info, TokenAccount>>,

    /// The vault token account
    #[account(
        mut,
        seeds = [VAULT_SEED],
        bump = relay_gateway_depository.vault_bump
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    /// The Circle GatewayWallet program
    /// CHECK: Address checked against the configured program
    #[account(address = relay_gateway_depository.gateway_wallet @ CustomError::InvalidGatewayProgram)]
    pub gateway_wallet_program: UncheckedAccount<'info>,

    /// The Circle GatewayWallet state account
    /// CHECK: Validated by the GatewayWallet program
    pub gateway_wallet: UncheckedAccount<'info>,

    /// The Circle GatewayWallet custody token account
    /// CHECK: Validated by the GatewayWallet program
    #[account(mut)]
    pub gateway_wallet_custody: UncheckedAccount<'info>,

    /// The allocator's Circle Gateway deposit account
    /// CHECK: Validated by the GatewayWallet program
    #[account(mut)]
    pub gateway_deposit: UncheckedAccount<'info>,

    /// The Circle denylist account of the gateway depository account
    /// CHECK: Validated by the GatewayWallet program
    pub depository_denylist: UncheckedAccount<'info>,

    /// The Circle denylist account of the allocator
    /// CHECK: Validated by the GatewayWallet program
    pub allocator_denylist: UncheckedAccount<'info>,

    /// The Circle GatewayWallet event authority
    /// CHECK: Validated by the GatewayWallet program
    pub gateway_wallet_event_authority: UncheckedAccount<'info>,

    /// The token program
    pub token_program: Program<'info, Token>,
    /// The system program
    pub system_program: Program<'info, System>,
}

/// Accounts required for executing a transfer
#[derive(Accounts)]
#[instruction(request: GatewayTransferRequest)]
pub struct ExecuteTransfer<'info> {
    /// The gateway depository account
    #[account(
        seeds = [RELAY_GATEWAY_DEPOSITORY_SEED],
        bump = relay_gateway_depository.bump,
        has_one = mint @ CustomError::InvalidMint
    )]
    pub relay_gateway_depository: Box<Account<'info, RelayGatewayDepository>>,

    /// The executor of the transfer, who also pays for the replay accounts
    #[account(mut)]
    pub executor: Signer<'info>,

    /// The recipient of the transfer
    /// CHECK: The recipient of the transfer
    pub recipient: UncheckedAccount<'info>,

    /// The vault token account, the Circle destination caller and recipient
    #[account(
        mut,
        seeds = [VAULT_SEED],
        bump = relay_gateway_depository.vault_bump
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    /// The USDC mint
    pub mint: Box<Account<'info, Mint>>,

    /// The recipient's token account
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = recipient
    )]
    pub recipient_token_account: Box<Account<'info, TokenAccount>>,

    /// The account that tracks whether a transfer request has been used
    ///
    /// This account is created for each transfer request to prevent replay attacks.
    #[account(
        init,
        payer = executor,
        space = 8 + UsedRequest::INIT_SPACE,
        seeds = [USED_REQUEST_SEED, &request.get_hash()[..]],
        bump
    )]
    pub used_request: Account<'info, UsedRequest>,

    /// The instruction sysvar for ed25519 verification
    /// CHECK: Address checked against the instructions sysvar
    #[account(address = solana_instructions_sysvar::ID)]
    pub ix_sysvar: AccountInfo<'info>,

    /// The Circle GatewayMinter program
    /// CHECK: Address checked against the configured program
    #[account(address = relay_gateway_depository.gateway_minter @ CustomError::InvalidGatewayProgram)]
    pub gateway_minter_program: UncheckedAccount<'info>,

    /// The Circle GatewayMinter state account
    /// CHECK: Validated by the GatewayMinter program
    pub gateway_minter: UncheckedAccount<'info>,

    /// The Circle GatewayMinter custody token account
    /// CHECK: Validated by the GatewayMinter program
    #[account(mut)]
    pub gateway_minter_custody: UncheckedAccount<'info>,

    /// The Circle replay account of the request's transfer spec
    /// CHECK: Validated by the GatewayMinter program
    #[account(mut)]
    pub used_transfer_spec_hash: UncheckedAccount<'info>,

    /// The Circle GatewayMinter event authority
    /// CHECK: Validated by the GatewayMinter program
    pub gateway_minter_event_authority: UncheckedAccount<'info>,

    /// The token program
    pub token_program: Program<'info, Token>,
    /// The system program
    pub system_program: Program<'info, System>,
}

/// Accounts required for executing a routed transfer
///
/// Same accounts and order as `ExecuteTransfer`, plus the router's signer PDA.
#[derive(Accounts)]
#[instruction(request: GatewayRoutedTransferRequest)]
pub struct ExecuteTransferRouted<'info> {
    /// The gateway depository account
    #[account(
        seeds = [RELAY_GATEWAY_DEPOSITORY_SEED],
        bump = relay_gateway_depository.bump,
        has_one = mint @ CustomError::InvalidMint
    )]
    pub relay_gateway_depository: Box<Account<'info, RelayGatewayDepository>>,

    /// The executor of the transfer, who also pays for the replay accounts
    #[account(mut)]
    pub executor: Signer<'info>,

    /// The recipient of the transfer
    /// CHECK: The recipient of the transfer
    pub recipient: UncheckedAccount<'info>,

    /// The vault token account, the Circle destination caller and recipient
    #[account(
        mut,
        seeds = [VAULT_SEED],
        bump = relay_gateway_depository.vault_bump
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    /// The USDC mint
    pub mint: Box<Account<'info, Mint>>,

    /// The recipient's token account
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = recipient
    )]
    pub recipient_token_account: Box<Account<'info, TokenAccount>>,

    /// The account that tracks whether a transfer request has been used
    ///
    /// This account is created for each transfer request to prevent replay attacks.
    #[account(
        init,
        payer = executor,
        space = 8 + UsedRequest::INIT_SPACE,
        seeds = [USED_REQUEST_SEED, &request.get_hash()[..]],
        bump
    )]
    pub used_request: Account<'info, UsedRequest>,

    /// The instruction sysvar for ed25519 verification
    /// CHECK: Address checked against the instructions sysvar
    #[account(address = solana_instructions_sysvar::ID)]
    pub ix_sysvar: AccountInfo<'info>,

    /// The Circle GatewayMinter program
    /// CHECK: Address checked against the configured program
    #[account(address = relay_gateway_depository.gateway_minter @ CustomError::InvalidGatewayProgram)]
    pub gateway_minter_program: UncheckedAccount<'info>,

    /// The Circle GatewayMinter state account
    /// CHECK: Validated by the GatewayMinter program
    pub gateway_minter: UncheckedAccount<'info>,

    /// The Circle GatewayMinter custody token account
    /// CHECK: Validated by the GatewayMinter program
    #[account(mut)]
    pub gateway_minter_custody: UncheckedAccount<'info>,

    /// The Circle replay account of the request's transfer spec
    /// CHECK: Validated by the GatewayMinter program
    #[account(mut)]
    pub used_transfer_spec_hash: UncheckedAccount<'info>,

    /// The Circle GatewayMinter event authority
    /// CHECK: Validated by the GatewayMinter program
    pub gateway_minter_event_authority: UncheckedAccount<'info>,

    /// The token program
    pub token_program: Program<'info, Token>,
    /// The system program
    pub system_program: Program<'info, System>,

    /// The router's signer PDA, derived from `request.router`
    pub router_authority: Signer<'info>,
}

//----------------------------------------
// Custom Types
//----------------------------------------

/// Structure representing a transfer request signed by the allocator
#[derive(AnchorSerialize, AnchorDeserialize, Copy, Clone, PartialEq, Debug)]
pub struct GatewayTransferRequest {
    /// Domain separator
    pub domain: [u8; 32],
    /// The hash of the Circle transfer spec that funds the transfer
    pub transfer_spec_hash: [u8; 32],
    /// The recipient of the transfer
    pub recipient: Pubkey,
    /// The token mint
    pub token: Pubkey,
    /// The amount to transfer
    pub amount: u64,
    /// A unique nonce
    pub nonce: u64,
    /// The expiration timestamp for the request
    pub expiration: i64,
}

impl GatewayTransferRequest {
    /// Computes the hash of the prefixed request for signature verification
    /// and used request tracking
    pub fn get_hash(&self) -> [u8; 32] {
        let mut data = TRANSFER_REQUEST_PREFIX.to_vec();
        self.serialize(&mut data).unwrap();
        hash(&data).to_bytes()
    }
}

/// Structure representing a routed transfer request signed by the allocator
///
/// Only executable through `execute_transfer_routed`, signed by `router`.
#[derive(AnchorSerialize, AnchorDeserialize, Copy, Clone, PartialEq, Debug)]
pub struct GatewayRoutedTransferRequest {
    /// Domain separator
    pub domain: [u8; 32],
    /// The hash of the Circle transfer spec that funds the transfer
    pub transfer_spec_hash: [u8; 32],
    /// The recipient of the transfer
    pub recipient: Pubkey,
    /// The token mint
    pub token: Pubkey,
    /// The amount to transfer
    pub amount: u64,
    /// A unique nonce
    pub nonce: u64,
    /// The expiration timestamp for the request
    pub expiration: i64,
    /// The router program that must sign the transfer
    pub router: Pubkey,
}

impl GatewayRoutedTransferRequest {
    /// Computes the hash of the prefixed request, which never equals a plain
    /// `GatewayTransferRequest` hash
    pub fn get_hash(&self) -> [u8; 32] {
        let mut data = ROUTED_TRANSFER_REQUEST_PREFIX.to_vec();
        self.serialize(&mut data).unwrap();
        hash(&data).to_bytes()
    }
}

//----------------------------------------
// Events
//----------------------------------------

/// Event emitted when a transfer is executed
#[event]
pub struct GatewayTransferExecutedEvent {
    /// The transfer request that was executed
    pub request: GatewayTransferRequest,
    /// The public key of the executor who processed the transfer
    pub executor: Pubkey,
    /// The hash of the request
    pub id: [u8; 32],
}

/// Event emitted when a routed transfer is executed
#[event]
pub struct GatewayRoutedTransferExecutedEvent {
    /// The routed transfer request that was executed
    pub request: GatewayRoutedTransferRequest,
    /// The public key of the executor who processed the transfer
    pub executor: Pubkey,
    /// The hash of the request
    pub id: [u8; 32],
}

/// Event emitted when a deposit is made
#[event]
pub struct DepositEvent {
    /// The account credited for the deposit on the Hub, not necessarily the sender
    pub depositor: Pubkey,
    /// The token mint
    pub token: Pubkey,
    /// The amount deposited
    pub amount: u64,
    /// A unique identifier for the deposit
    pub id: [u8; 32],
}

//----------------------------------------
// Error Definitions
//----------------------------------------

/// Custom error codes for the relay gateway depository program
#[error_code]
pub enum CustomError {
    /// Thrown when the provided mint does not match the expected mint
    #[msg("Invalid mint")]
    InvalidMint,

    /// Thrown when an account attempts an operation it is not authorized for
    #[msg("Unauthorized")]
    Unauthorized,

    /// Thrown when the signature's signer doesn't match the expected allocator
    #[msg("Allocator signer mismatch")]
    AllocatorSignerMismatch,

    /// Thrown when the signed message doesn't match the expected request
    #[msg("Message mismatch")]
    MessageMismatch,

    /// Thrown when the Ed25519 signature data is malformed
    #[msg("Malformed Ed25519 data")]
    MalformedEd25519Data,

    /// Thrown when a required signature is missing
    #[msg("Missing signature")]
    MissingSignature,

    /// Thrown when the signature has expired
    #[msg("Signature expired")]
    SignatureExpired,

    /// Thrown when the recipient doesn't match the expected recipient
    #[msg("Invalid recipient")]
    InvalidRecipient,

    /// Thrown when the domain separator is invalid
    #[msg("Invalid domain separator")]
    InvalidDomainSeparator,

    /// Thrown when the router authority is not the request router's signer PDA
    #[msg("Invalid router authority")]
    InvalidRouterAuthority,

    /// Thrown when a routed transfer is not called directly by a top-level instruction
    #[msg("Invalid router caller")]
    InvalidRouterCaller,

    /// Thrown when a Circle Gateway program doesn't match the configured program
    #[msg("Invalid gateway program")]
    InvalidGatewayProgram,

    /// Thrown when deposits are disabled
    #[msg("Deposits disabled")]
    DepositsDisabled,

    /// Thrown when the new owner is the default public key
    #[msg("Invalid owner")]
    InvalidOwner,

    /// Thrown when the new allocator is the default public key
    #[msg("Invalid allocator")]
    InvalidAllocator,
}

//----------------------------------------
// Helper Functions
//----------------------------------------

/// Accounts used by `process_transfer`, shared by plain and routed transfers
struct TransferAccounts<'a, 'info> {
    relay_gateway_depository: &'a Account<'info, RelayGatewayDepository>,
    executor: &'a Signer<'info>,
    recipient: &'a UncheckedAccount<'info>,
    vault: &'a Account<'info, TokenAccount>,
    mint: &'a Account<'info, Mint>,
    recipient_token_account: &'a Account<'info, TokenAccount>,
    ix_sysvar: &'a AccountInfo<'info>,
    gateway_minter_program: &'a UncheckedAccount<'info>,
    gateway_minter: &'a UncheckedAccount<'info>,
    gateway_minter_custody: &'a UncheckedAccount<'info>,
    used_transfer_spec_hash: &'a UncheckedAccount<'info>,
    gateway_minter_event_authority: &'a UncheckedAccount<'info>,
    token_program: &'a Program<'info, Token>,
    system_program: &'a Program<'info, System>,
}

/// Validates an allocator-signed transfer request, mints its transfer spec from
/// Circle Gateway into the vault and pays the recipient
///
/// # Parameters
/// * `accounts` - The transfer accounts
/// * `request` - The transfer request details
/// * `request_hash` - The hash the allocator signed, also the used request seed
/// * `max_block_height` - The slot the Circle attestation expires after
/// * `circle_signature` - The Circle signature over the attestation
///
/// # Returns
/// * `Ok(())` on success
/// * `Err(error)` if a signature is invalid or the request can't be processed
fn process_transfer(
    accounts: TransferAccounts,
    request: &GatewayTransferRequest,
    request_hash: &[u8; 32],
    max_block_height: u64,
    circle_signature: &[u8; 65],
) -> Result<()> {
    let relay_gateway_depository = accounts.relay_gateway_depository;

    let clock: Clock = Clock::get()?;
    require!(
        clock.unix_timestamp < request.expiration,
        CustomError::SignatureExpired
    );

    // Validate allocator signature
    let cur_index: usize = load_current_index_checked(accounts.ix_sysvar)?.into();
    require!(cur_index > 0, CustomError::MalformedEd25519Data);

    let ed25519_instr_index = cur_index - 1;
    let signature_ix = load_instruction_at_checked(ed25519_instr_index, accounts.ix_sysvar)?;

    validate_ed25519_signature_instruction(
        &signature_ix,
        &relay_gateway_depository.allocator,
        request_hash,
    )?;

    require!(
        request.domain == relay_gateway_depository.domain_separator,
        CustomError::InvalidDomainSeparator
    );

    require_keys_eq!(request.token, accounts.mint.key(), CustomError::InvalidMint);

    require_keys_eq!(
        accounts.recipient.key(),
        request.recipient,
        CustomError::InvalidRecipient
    );

    // Mint the request's transfer spec into the vault. Circle rebuilds the attestation
    // from these values and the accounts, so its signature binds all of them.
    let mut data = GATEWAY_MINT_WITH_PARAMS_DISCRIMINATOR.to_vec();
    data.push(0); // is_default_destination_caller
    data.extend_from_slice(&max_block_height.to_le_bytes());
    data.extend_from_slice(&1u32.to_le_bytes()); // one element
    data.extend_from_slice(&request.amount.to_le_bytes());
    data.extend_from_slice(&request.transfer_spec_hash);
    data.extend_from_slice(&0u32.to_le_bytes()); // empty hook data
    data.extend_from_slice(&(circle_signature.len() as u32).to_le_bytes());
    data.extend_from_slice(circle_signature);

    let vault_seeds: &[&[u8]] = &[VAULT_SEED, &[relay_gateway_depository.vault_bump]];
    invoke_signed(
        &Instruction {
            program_id: accounts.gateway_minter_program.key(),
            accounts: vec![
                AccountMeta::new(accounts.executor.key(), true),
                AccountMeta::new_readonly(accounts.vault.key(), true),
                AccountMeta::new_readonly(accounts.gateway_minter.key(), false),
                AccountMeta::new_readonly(accounts.system_program.key(), false),
                AccountMeta::new_readonly(accounts.token_program.key(), false),
                AccountMeta::new_readonly(accounts.gateway_minter_event_authority.key(), false),
                AccountMeta::new_readonly(accounts.gateway_minter_program.key(), false),
                AccountMeta::new(accounts.gateway_minter_custody.key(), false),
                AccountMeta::new(accounts.vault.key(), false),
                AccountMeta::new(accounts.used_transfer_spec_hash.key(), false),
            ],
            data,
        },
        &[
            accounts.executor.to_account_info(),
            accounts.vault.to_account_info(),
            accounts.gateway_minter.to_account_info(),
            accounts.system_program.to_account_info(),
            accounts.token_program.to_account_info(),
            accounts.gateway_minter_event_authority.to_account_info(),
            accounts.gateway_minter_program.to_account_info(),
            accounts.gateway_minter_custody.to_account_info(),
            accounts.used_transfer_spec_hash.to_account_info(),
        ],
        &[vault_seeds],
    )?;

    let seeds: &[&[u8]] = &[
        RELAY_GATEWAY_DEPOSITORY_SEED,
        &[relay_gateway_depository.bump],
    ];
    transfer_checked(
        CpiContext::new_with_signer(
            accounts.token_program.key(),
            TransferChecked {
                mint: accounts.mint.to_account_info(),
                from: accounts.vault.to_account_info(),
                to: accounts.recipient_token_account.to_account_info(),
                authority: relay_gateway_depository.to_account_info(),
            },
            &[seeds],
        ),
        request.amount,
        accounts.mint.decimals,
    )?;

    Ok(())
}

/// Validates an Ed25519 signature instruction
///
/// Verifies that the signature instruction is properly formatted,
/// signed by the expected signer, and matches the expected request.
///
/// # Parameters
/// * `signature_ix` - The signature instruction to validate
/// * `expected_signer` - The expected signer of the instruction
/// * `expected_hash` - The hash of the request that was signed
///
/// # Returns
/// * `Ok(())` if the signature is valid
/// * `Err(error)` if the signature is invalid
fn validate_ed25519_signature_instruction(
    signature_ix: &Instruction,
    expected_signer: &Pubkey,
    expected_hash: &[u8; 32],
) -> Result<()> {
    // Verify program id
    require_eq!(
        signature_ix.program_id,
        ED25519_PROGRAM_ID,
        CustomError::MissingSignature
    );

    let data = &signature_ix.data;
    require!(
        signature_ix.accounts.is_empty() && data.len() == 144,
        CustomError::MalformedEd25519Data
    );

    // Parse header fields
    let num_signatures = data[0];
    let padding = data[1];
    let sig_off = u16::from_le_bytes(data[2..=3].try_into().unwrap()) as usize;
    let sig_idx = u16::from_le_bytes(data[4..=5].try_into().unwrap());
    let pk_off = u16::from_le_bytes(data[6..=7].try_into().unwrap()) as usize;
    let pk_idx = u16::from_le_bytes(data[8..=9].try_into().unwrap());
    let msg_off = u16::from_le_bytes(data[10..=11].try_into().unwrap()) as usize;
    let msg_len = u16::from_le_bytes(data[12..=13].try_into().unwrap()) as usize;
    let msg_idx = u16::from_le_bytes(data[14..=15].try_into().unwrap());

    // Header checks
    require!(
        num_signatures == 1
            && padding == 0
            && sig_idx == u16::MAX
            && pk_idx == u16::MAX
            && msg_idx == u16::MAX
            && pk_off == 16
            && sig_off == 48,
        CustomError::MalformedEd25519Data
    );

    require!(
        data.len() >= msg_off + msg_len,
        CustomError::MalformedEd25519Data
    );

    let data_pubkey = &data[pk_off..pk_off + 32];
    let data_msg = &data[msg_off..msg_off + msg_len];

    // Extract and verify signer public key bytes
    require!(
        data_pubkey == expected_signer.to_bytes(),
        CustomError::AllocatorSignerMismatch
    );

    // Verify message hash matches request hash
    if data_msg != expected_hash {
        return Err(CustomError::MessageMismatch.into());
    }

    Ok(())
}

/// Creates the expected domain separator hash
///
/// Combines name, version, chain_id and program_id into a single hash
/// for efficient validation and storage.
///
/// # Parameters
/// * `name` - Protocol name (e.g., b"RelayGatewayDepository")
/// * `version` - Version bytes (e.g., b"1")
/// * `chain_id` - Chain identifier (e.g., b"solana-mainnet")
/// * `program_id` - The program ID
///
/// # Returns
/// * 32-byte domain separator hash
pub fn create_domain_separator(
    name: &[u8],
    version: &[u8],
    chain_id: &[u8],
    program_id: &Pubkey,
) -> [u8; 32] {
    let mut data = Vec::new();
    data.extend_from_slice(name);
    data.extend_from_slice(version);
    data.extend_from_slice(chain_id);
    data.extend_from_slice(&program_id.to_bytes());

    hash(&data).to_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(hex: &str) -> Pubkey {
        Pubkey::new_from_array(<[u8; 32]>::try_from(hex_to_bytes(hex)).unwrap())
    }

    fn hex_to_bytes(hex: &str) -> Vec<u8> {
        (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
            .collect()
    }

    fn encoded_len(request: &impl AnchorSerialize) -> usize {
        let mut data = Vec::new();
        request.serialize(&mut data).unwrap();
        data.len()
    }

    // Shared vectors with the Hub payload builder and the SDK
    #[test]
    fn transfer_request_hashes_match_hub_vectors() {
        let routed = GatewayRoutedTransferRequest {
            domain: key("5fe7f977e71dba2ea1a68e21057beebb9be2ac30c6410aa38d4f3fbe41dcffd2")
                .to_bytes(),
            transfer_spec_hash: key(
                "2a01f5587e9faf2b2908b6bb19b2e4f295638407d27de3b5a16ac4f11d355440",
            )
            .to_bytes(),
            recipient: key("d354d13253ad4f7764f5c933ccadca795c052d143e2721ff5716848f1fe390cc"),
            token: key("471500e6828e391e3b31326faa896e01212f976de1ad90ecb7823a2b96e9eb85"),
            amount: 1_000_000,
            nonce: 14_041_958_522_398_838_600,
            expiration: 1_700_000_300,
            router: key("7d01d9c59e2296807ea0d4df99ccf825c028060cba6aa00c2ab482dad32161be"),
        };
        let plain = GatewayTransferRequest {
            domain: routed.domain,
            transfer_spec_hash: routed.transfer_spec_hash,
            recipient: routed.recipient,
            token: routed.token,
            amount: routed.amount,
            nonce: routed.nonce,
            expiration: routed.expiration,
        };

        assert_eq!(TRANSFER_REQUEST_PREFIX.len() + encoded_len(&plain), 193);
        assert_eq!(
            plain.get_hash().to_vec(),
            hex_to_bytes("bfb5e4a075619aac92f01c9f769184a34bbc34dd08b5ea708f05242dd8739592")
        );
        assert_eq!(
            ROUTED_TRANSFER_REQUEST_PREFIX.len() + encoded_len(&routed),
            231
        );
        assert_eq!(
            routed.get_hash().to_vec(),
            hex_to_bytes("d52494471653adc327e82464c67862cf00e8e5c163dacd727457ddfdd1dc9dc6")
        );
    }
}
