use anchor_lang::{
    prelude::*,
    solana_program::{
        hash::{hash, Hash},
        instruction::Instruction,
        program::invoke,
        instruction::{get_stack_height, TRANSACTION_LEVEL_STACK_HEIGHT},
        program::invoke_signed,
        system_instruction, sysvar,
    },
};
use anchor_spl::token::Token;
use anchor_spl::token_2022::spl_token_2022::{
    self,
    extension::{transfer_fee::TransferFeeConfig, BaseStateWithExtensions, StateWithExtensions},
};
use anchor_spl::{
    associated_token::{get_associated_token_address_with_program_id, AssociatedToken, Create},
    token_interface::{transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked},
};

/// 
/// A Solana relay depository smart contract built with the Anchor framework. 
/// This contract allows users to deposit SOL or SPL tokens and execute transfers with verified signatures.
/// 

/// 
//----------------------------------------
// Constants
//----------------------------------------

const AUTHORIZED_PUBKEY: Pubkey = pubkey!("7LZXYdDQcRTsXnL9EU2zGkninV3yJsqX43m4RMPbs68u");

const RELAY_DEPOSITORY_SEED: &[u8] = b"relay_depository";

const USED_REQUEST_SEED: &[u8] = b"used_request";

const VAULT_SEED: &[u8] = b"vault";

const DOMAIN_NAME: &[u8] = b"RelayDepository";

const DOMAIN_VERSION: &[u8] = b"1";

const ROUTED_TRANSFER_REQUEST_PREFIX: &[u8] = b"RelayDepository:RoutedTransferRequest:v1";

const DEPOSITORY_CALLER_SEED: &[u8] = b"depository_caller";

//----------------------------------------
// Program ID
//----------------------------------------

declare_id!("99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2");

//----------------------------------------
// Program Module
//----------------------------------------

#[program]
pub mod relay_depository {
    use super::*;

    /// Initialize the relay depository program with owner and allocator
    ///
    /// Creates and initializes the relay depository account with the specified
    /// owner, allocator, and calculates the domain separator for cross-chain security.
    ///
    /// # Parameters
    /// * `ctx` - The context containing the accounts
    /// * `chain_id` - The chain identifier (e.g., "solana-mainnet")
    ///
    /// # Returns
    /// * `Ok(())` on success
    pub fn initialize(ctx: Context<Initialize>, chain_id: String) -> Result<()> {
        let relay_depository = &mut ctx.accounts.relay_depository;
        relay_depository.owner = ctx.accounts.owner.key();
        relay_depository.allocator = ctx.accounts.allocator.key();
        relay_depository.vault_bump = ctx.bumps.vault;
        
        // Calculate domain separator internally to ensure correctness
        relay_depository.domain_separator = Some(create_domain_separator(
            DOMAIN_NAME,
            DOMAIN_VERSION,
            chain_id.as_bytes(),
            &ctx.program_id
        ));
        
        Ok(())
    }

    /// Update the allocator public key
    ///
    /// Allows the owner to change the authorized allocator that can sign transfer requests.
    ///
    /// # Parameters
    /// * `ctx` - The context containing the accounts
    /// * `new_allocator` - The public key of the new allocator
    ///
    /// # Returns
    /// * `Ok(())` on success
    /// * `Err(error)` if not authorized
    pub fn set_allocator(ctx: Context<SetAllocator>, new_allocator: Pubkey) -> Result<()> {
        let relay_depository = &mut ctx.accounts.relay_depository;
        require_keys_eq!(
            ctx.accounts.owner.key(),
            relay_depository.owner,
            CustomError::Unauthorized
        );
        relay_depository.allocator = new_allocator;
        Ok(())
    }

    /// Update the owner public key
    ///
    /// Allows the current owner to transfer ownership to a new address.
    ///
    /// # Parameters
    /// * `ctx` - The context containing the accounts
    /// * `new_owner` - The public key of the new owner
    ///
    /// # Returns
    /// * `Ok(())` on success
    /// * `Err(error)` if not authorized
    pub fn set_owner(ctx: Context<SetOwner>, new_owner: Pubkey) -> Result<()> {
        let relay_depository = &mut ctx.accounts.relay_depository;
        require_keys_eq!(
            ctx.accounts.owner.key(),
            relay_depository.owner,
            CustomError::Unauthorized
        );
        relay_depository.owner = new_owner;
        Ok(())
    }

    /// Deposit native SOL tokens into the vault
    ///
    /// Transfers SOL from the sender to the vault and emits a deposit event.
    ///
    /// # Parameters
    /// * `ctx` - The context containing the accounts
    /// * `amount` - The amount of SOL to deposit
    /// * `id` - A unique identifier for the deposit
    ///
    /// # Returns
    /// * `Ok(())` on success
    pub fn deposit_native(ctx: Context<DepositNative>, amount: u64, id: [u8; 32]) -> Result<()> {
        // Transfer to vault
        invoke(
            &system_instruction::transfer(
                ctx.accounts.sender.key,
                &ctx.accounts.vault.key(),
                amount,
            ),
            &[
                ctx.accounts.sender.to_account_info(),
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;

        emit!(DepositEvent {
            depositor: ctx.accounts.depositor.key(),
            token: None,
            amount,
            id,
        });

        Ok(())
    }

    /// Deposit SPL tokens into the vault
    ///
    /// Creates the vault's token account if needed, transfers tokens from the sender,
    /// and emits a deposit event.
    ///
    /// # Parameters
    /// * `ctx` - The context containing the accounts
    /// * `amount` - The amount of tokens to deposit
    /// * `id` - A unique identifier for the deposit
    ///
    /// # Returns
    /// * `Ok(())` on success
    pub fn deposit_token(ctx: Context<DepositToken>, amount: u64, id: [u8; 32]) -> Result<()> {
        // Ensure token program is either SPL Token or SPL Token 2022
        require!(
            ctx.accounts.token_program.key() == anchor_spl::token::ID
            || ctx.accounts.token_program.key() == anchor_spl::token_2022::ID,
            CustomError::InvalidTokenProgram
        );

        // Ensure mint is owned by the token program
        require_keys_eq!(
            *ctx.accounts.mint.to_account_info().owner,
            ctx.accounts.token_program.key(),
            CustomError::InvalidMint
        );

        // Create associated token account for the vault if needed
        if ctx.accounts.vault_token_account.data_is_empty() {
            anchor_spl::associated_token::create(CpiContext::new(
                ctx.accounts.associated_token_program.to_account_info(),
                Create {
                    payer: ctx.accounts.sender.to_account_info(),
                    associated_token: ctx.accounts.vault_token_account.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                    token_program: ctx.accounts.token_program.to_account_info(),
                },
            ))?;
        }

        let expected_vault_ata = get_associated_token_address_with_program_id(
            &ctx.accounts.vault.key(),
            &ctx.accounts.mint.key(),
            &ctx.accounts.token_program.key(),
        );

        // Check if the vault token account is the expected associated token account
        require_keys_eq!(
            ctx.accounts.vault_token_account.key(),
            expected_vault_ata,
            CustomError::InvalidVaultTokenAccount
        );

        // Calculate transfer fee
        let mint = &ctx.accounts.mint;
        let transfer_fee = get_transfer_fee(mint, amount)?;

        // Transfer to vault
        transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    mint: ctx.accounts.mint.to_account_info(),
                    from: ctx.accounts.sender_token_account.to_account_info(),
                    to: ctx.accounts.vault_token_account.to_account_info(),
                    authority: ctx.accounts.sender.to_account_info(),
                },
            ),
            amount,
            mint.decimals,
        )?;

        emit!(DepositEvent {
            depositor: ctx.accounts.depositor.key(),
            token: Some(ctx.accounts.mint.key()),
            amount: amount - transfer_fee,
            id,
        });

        Ok(())
    }

    /// Execute a transfer with allocator signature
    ///
    /// Verifies the allocator's signature, transfers tokens to the recipient,
    /// and marks the request as used.
    ///
    /// # Parameters
    /// * `ctx` - The context containing the accounts
    /// * `request` - The transfer request details and signature
    ///
    /// # Returns
    /// * `Ok(())` on success
    /// * `Err(error)` if signature is invalid or request can't be processed
    pub fn execute_transfer(ctx: Context<ExecuteTransfer>, request: TransferRequest) -> Result<()> {
        process_transfer(
            TransferAccounts {
                relay_depository: &ctx.accounts.relay_depository,
                used_request: &mut ctx.accounts.used_request,
                recipient: &ctx.accounts.recipient,
                vault: &ctx.accounts.vault,
                mint: ctx.accounts.mint.as_ref(),
                recipient_token_account: ctx.accounts.recipient_token_account.as_ref(),
                vault_token_account: ctx.accounts.vault_token_account.as_ref(),
                ix_sysvar: &ctx.accounts.ix_sysvar,
                token_program: &ctx.accounts.token_program,
                system_program: &ctx.accounts.system_program,
            },
            &request,
            &request.get_hash().to_bytes(),
        )?;

        let used_request = &ctx.accounts.used_request;
        emit!(TransferExecutedEvent {
            id: used_request.key(),
            request: request.clone(),
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
    ///
    /// # Returns
    /// * `Ok(())` on success
    /// * `Err(error)` if the router did not sign or the request can't be processed
    pub fn execute_transfer_routed(
        ctx: Context<ExecuteTransferRouted>,
        request: RoutedTransferRequest,
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

        // Same checks and transfer as a plain request; only the signed hash differs
        process_transfer(
            TransferAccounts {
                relay_depository: &ctx.accounts.relay_depository,
                used_request: &mut ctx.accounts.used_request,
                recipient: &ctx.accounts.recipient,
                vault: &ctx.accounts.vault,
                mint: ctx.accounts.mint.as_deref(),
                recipient_token_account: ctx.accounts.recipient_token_account.as_deref(),
                vault_token_account: ctx.accounts.vault_token_account.as_deref(),
                ix_sysvar: &ctx.accounts.ix_sysvar,
                token_program: &ctx.accounts.token_program,
                system_program: &ctx.accounts.system_program,
            },
            &TransferRequest {
                domain: request.domain,
                recipient: request.recipient,
                token: request.token,
                amount: request.amount,
                nonce: request.nonce,
                expiration: request.expiration,
                vault_address: request.vault_address,
            },
            &request.get_hash().to_bytes(),
        )?;

        let used_request = &ctx.accounts.used_request;
        emit!(RoutedTransferExecutedEvent {
            id: used_request.key(),
            request,
            executor: ctx.accounts.executor.key(),
        });

        Ok(())
    }
}

//----------------------------------------
// Account Structures
//----------------------------------------

/// Relay depository account that stores configuration and state
/// 
/// This account is a PDA derived from the `RELAY_DEPOSITORY_SEED` and
/// contains the ownership and allocation information.
#[account]
#[derive(InitSpace)]
pub struct RelayDepository {
    /// The owner of the relay depository who can update settings
    pub owner: Pubkey,
    /// The authorized allocator that can sign transfer requests
    pub allocator: Pubkey,
    /// The bump seed for the vault PDA, used for deriving the vault address
    pub vault_bump: u8,
    /// Expected domain separator hash for this deployment.
    /// Wrapped in `Option` only to preserve the on-chain layout of accounts
    /// migrated from the pre-`domain_separator` version; `execute_transfer`
    /// hard-requires this to be `Some`.
    pub domain_separator: Option<[u8; 32]>,
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

/// Accounts required for initializing the relay depository
#[derive(Accounts)]
pub struct Initialize<'info> {
    /// The relay depository account to be initialized
    /// This is a PDA derived from the RELAY_DEPOSITORY_SEED
    #[account(
        init,
        payer = owner,
        space = 8 + RelayDepository::INIT_SPACE,
        seeds = [RELAY_DEPOSITORY_SEED],
        constraint = owner.key() == AUTHORIZED_PUBKEY @ CustomError::Unauthorized,
        bump
    )]
    pub relay_depository: Account<'info, RelayDepository>,

    /// PDA that will hold SOL deposits
    /// CHECK: This is a PDA derived from the VAULT_SEED
    #[account(
        mut,
        seeds = [VAULT_SEED],
        bump
    )]
    pub vault: UncheckedAccount<'info>,

    /// The owner account that pays for initialization
    /// Must match the AUTHORIZED_PUBKEY
    #[account(mut)]
    pub owner: Signer<'info>,

    /// The allocator account that will be authorized to sign transfer requests
    /// CHECK: Used as public key only
    pub allocator: UncheckedAccount<'info>,

    // System program
    pub system_program: Program<'info, System>,
}

/// Accounts required for updating the allocator
#[derive(Accounts)]
pub struct SetAllocator<'info> {
    /// The relay depository account to update
    #[account(
        mut,
        seeds = [RELAY_DEPOSITORY_SEED],
        bump
    )]
    pub relay_depository: Account<'info, RelayDepository>,

    /// The owner of the relay depository
    pub owner: Signer<'info>,
}

/// Accounts required for updating the owner
#[derive(Accounts)]
pub struct SetOwner<'info> {
    /// The relay depository account to update
    #[account(
        mut,
        seeds = [RELAY_DEPOSITORY_SEED],
        bump
    )]
    pub relay_depository: Account<'info, RelayDepository>,

    /// The current owner of the relay depository
    pub owner: Signer<'info>,
}

/// Accounts required for depositing native currency
#[derive(Accounts)]
pub struct DepositNative<'info> {
    /// The relay depository account
    #[account(
        seeds = [RELAY_DEPOSITORY_SEED],
        bump
    )]
    pub relay_depository: Account<'info, RelayDepository>,

    /// The sender of the deposit
    #[account(mut)]
    pub sender: Signer<'info>,

    /// The account credited for the deposit
    /// CHECK: The account credited for the deposit
    pub depositor: UncheckedAccount<'info>,

    /// The vault PDA that will receive the SOL
    /// CHECK: The vault PDA that will receive the SOL
    #[account(
        mut,
        seeds = [VAULT_SEED],
        bump = relay_depository.vault_bump
    )]
    pub vault: UncheckedAccount<'info>,

    /// The system program
    pub system_program: Program<'info, System>,
}

/// Accounts required for depositing tokens
#[derive(Accounts)]
pub struct DepositToken<'info> {
    /// The relay depository account
    #[account(
        seeds = [RELAY_DEPOSITORY_SEED],
        bump
    )]
    pub relay_depository: Account<'info, RelayDepository>,

    /// The sender of the deposit
    #[account(mut)]
    pub sender: Signer<'info>,

    /// The account credited for the deposit
    /// CHECK: The account credited for the deposit
    pub depositor: UncheckedAccount<'info>,

    /// The vault PDA that will receive the tokens
    /// CHECK: The vault PDA that will receive the tokens
    #[account(
        seeds = [VAULT_SEED],
        bump = relay_depository.vault_bump
    )]
    pub vault: UncheckedAccount<'info>,

    /// The mint of the token being deposited
    pub mint: InterfaceAccount<'info, Mint>,

    /// The sender's token account
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = sender,
        associated_token::token_program = token_program
    )]
    pub sender_token_account: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: The vault's token account
    #[account(mut)]
    pub vault_token_account: UncheckedAccount<'info>,

    /// The token program
    pub token_program: Interface<'info, TokenInterface>,
    /// The associated token program
    pub associated_token_program: Program<'info, AssociatedToken>,
    /// The system program
    pub system_program: Program<'info, System>,
}

/// Accounts required for executing a transfer
#[derive(Accounts)]
#[instruction(request: TransferRequest)]
pub struct ExecuteTransfer<'info> {

    /// The relay depository account
    /// CHECK: The relay depository account
    #[account(
        seeds = [RELAY_DEPOSITORY_SEED],
        bump
    )]
    pub relay_depository: Account<'info, RelayDepository>,

    /// The executor of the transfer
    /// CHECK: The executor of the transfer
    #[account(mut)]
    pub executor: Signer<'info>,

    /// The recipient of the transfer
    /// CHECK: The recipient of the transfer
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,

    /// The vault PDA that will receive the tokens
    /// CHECK: The vault PDA that will receive the tokens
    #[account(
        mut,
        seeds = [VAULT_SEED],
        bump = relay_depository.vault_bump
    )]
    pub vault: UncheckedAccount<'info>,

    /// The mint of the token being transferred
    pub mint: Option<InterfaceAccount<'info, Mint>>,

    /// The recipient's token account
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = recipient,
        associated_token::token_program = token_program
    )]
    pub recipient_token_account: Option<InterfaceAccount<'info, TokenAccount>>,

    /// The vault's token account
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = vault,
        associated_token::token_program = token_program
    )]
    pub vault_token_account: Option<InterfaceAccount<'info, TokenAccount>>,

    /// The account that tracks whether a transfer request has been used
    /// 
    /// This account is created for each transfer request to prevent replay attacks.
    #[account(
        init,
        payer = executor,
        space = 8 + UsedRequest::INIT_SPACE,
        seeds = [
            USED_REQUEST_SEED,
            &request.get_hash().to_bytes()[..],
        ],
        bump
    )]
    pub used_request: Account<'info, UsedRequest>,

    /// The instruction sysvar for ed25519 verification
    #[account(address = sysvar::instructions::ID)]
    pub ix_sysvar: AccountInfo<'info>,

    /// The token program
    pub token_program: Interface<'info, TokenInterface>,
    /// The associated token program
    pub associated_token_program: Program<'info, AssociatedToken>,
    /// The system program
    pub system_program: Program<'info, System>,
}

/// Accounts required for executing a routed transfer
///
/// Same accounts and order as `ExecuteTransfer`, plus the router's signer PDA.
#[derive(Accounts)]
#[instruction(request: RoutedTransferRequest)]
pub struct ExecuteTransferRouted<'info> {
    /// The relay depository account
    #[account(
        seeds = [RELAY_DEPOSITORY_SEED],
        bump
    )]
    pub relay_depository: Box<Account<'info, RelayDepository>>,

    /// The executor of the transfer
    #[account(mut)]
    pub executor: Signer<'info>,

    /// The recipient of the transfer
    /// CHECK: The recipient of the transfer
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,

    /// The vault PDA that holds the funds
    /// CHECK: The vault PDA that holds the funds
    #[account(
        mut,
        seeds = [VAULT_SEED],
        bump = relay_depository.vault_bump
    )]
    pub vault: UncheckedAccount<'info>,

    /// The mint of the token being transferred
    pub mint: Option<Box<InterfaceAccount<'info, Mint>>>,

    /// The recipient's token account
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = recipient,
        associated_token::token_program = token_program
    )]
    pub recipient_token_account: Option<Box<InterfaceAccount<'info, TokenAccount>>>,

    /// The vault's token account
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = vault,
        associated_token::token_program = token_program
    )]
    pub vault_token_account: Option<Box<InterfaceAccount<'info, TokenAccount>>>,

    /// The account that tracks whether a transfer request has been used
    ///
    /// Shares the plain request namespace; the routed hash prefix keeps them disjoint.
    #[account(
        init,
        payer = executor,
        space = 8 + UsedRequest::INIT_SPACE,
        seeds = [
            USED_REQUEST_SEED,
            &request.get_hash().to_bytes()[..],
        ],
        bump
    )]
    pub used_request: Account<'info, UsedRequest>,

    /// The instruction sysvar for ed25519 verification
    /// CHECK: Address checked against the instructions sysvar
    #[account(address = sysvar::instructions::ID)]
    pub ix_sysvar: AccountInfo<'info>,

    /// The token program
    pub token_program: Interface<'info, TokenInterface>,
    /// The associated token program
    pub associated_token_program: Program<'info, AssociatedToken>,
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
pub struct TransferRequest {
    /// Domain separator
    pub domain: [u8; 32],
    /// The recipient of the transfer
    pub recipient: Pubkey,
    /// The token mint (None for native SOL, Some(mint) for SPL tokens)
    pub token: Option<Pubkey>,
    /// The amount to transfer
    pub amount: u64,
    /// A unique nonce
    pub nonce: u64,
    /// The expiration timestamp for the request
    pub expiration: i64,
    /// The vault address that funds will be withdrawn from
    pub vault_address: Pubkey,
}

impl TransferRequest {
    /// Computes a hash of the serialized request for signature verification
    /// and used request tracking
    pub fn get_hash(&self) -> Hash {
        hash(&self.try_to_vec().unwrap())
    }
}

/// Structure representing a routed transfer request signed by the allocator
///
/// Only executable through `execute_transfer_routed`, signed by `router`.
#[derive(AnchorSerialize, AnchorDeserialize, Copy, Clone, PartialEq, Debug)]
pub struct RoutedTransferRequest {
    /// Domain separator
    pub domain: [u8; 32],
    /// The recipient of the transfer
    pub recipient: Pubkey,
    /// The token mint (None for native SOL, Some(mint) for SPL tokens)
    pub token: Option<Pubkey>,
    /// The amount to transfer
    pub amount: u64,
    /// A unique nonce
    pub nonce: u64,
    /// The expiration timestamp for the request
    pub expiration: i64,
    /// The vault address that funds will be withdrawn from
    pub vault_address: Pubkey,
    /// The router program that must sign the transfer
    pub router: Pubkey,
}

impl RoutedTransferRequest {
    /// Computes the hash of the prefixed request, which never equals a plain
    /// `TransferRequest` hash
    pub fn get_hash(&self) -> Hash {
        let mut data = ROUTED_TRANSFER_REQUEST_PREFIX.to_vec();
        data.extend_from_slice(&self.try_to_vec().unwrap());
        hash(&data)
    }
}

//----------------------------------------
// Events
//----------------------------------------

/// Event emitted when a transfer is executed
#[event]
pub struct TransferExecutedEvent {
    /// The transfer request that was executed
    pub request: TransferRequest,
    /// The public key of the executor who processed the transfer
    pub executor: Pubkey,
    /// The unique identifier for the used request account
    pub id: Pubkey,
}

/// Event emitted when a routed transfer is executed
#[event]
pub struct RoutedTransferExecutedEvent {
    /// The routed transfer request that was executed
    pub request: RoutedTransferRequest,
    /// The public key of the executor who processed the transfer
    pub executor: Pubkey,
    /// The unique identifier for the used request account
    pub id: Pubkey,
}

/// Event emitted when a deposit is made
#[event]
pub struct DepositEvent {
    /// The public key of the depositor
    pub depositor: Pubkey,
    /// The token mint (None for native SOL, Some(mint) for SPL tokens)
    pub token: Option<Pubkey>,
    /// The amount deposited
    pub amount: u64,
    /// A unique identifier for the deposit
    pub id: [u8; 32],
}

//----------------------------------------
// Error Definitions
//----------------------------------------

/// Custom error codes for the relay depository program
#[error_code]
pub enum CustomError {
    /// Thrown when trying to execute a transfer request that has already been used
    #[msg("Transfer request has already been executed")]
    TransferRequestAlreadyUsed,

    /// Thrown when the provided mint does not match the expected mint
    #[msg("Invalid mint")]
    InvalidMint,

    /// Thrown when the provided token program does not match the expected token program
    #[msg("Invalid token program")]
    InvalidTokenProgram,

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

    /// Thrown when the vault token account doesn't match the expected address
    #[msg("Invalid vault token account")]
    InvalidVaultTokenAccount,

    /// Thrown when a transfer would leave the vault with insufficient balance for rent
    #[msg("Vault has insufficient balance to remain rent-exempt after transfer")]
    InsufficientVaultBalance,

    /// Thrown when the domain separator is invalid
    #[msg("Invalid domain separator")]
    InvalidDomainSeparator,

    // Retain retired migration errors to preserve subsequent error codes.
    /// Thrown when trying to set domain separator on an already migrated contract
    #[msg("Domain separator already set")]
    DomainSeparatorAlreadySet,

    /// Thrown when the vault address doesn't match the expected vault
    #[msg("Invalid vault address")]
    InvalidVaultAddress,

    /// Thrown when the account data write fails
    #[msg("Failed to write account data")]
    AccountWriteFailed,

    /// Thrown when the relay depository PDA is invalid
    #[msg("Invalid RelayDepository PDA")]
    InvalidRelayDepositoryPDA,

    /// Thrown when the account data is malformed
    #[msg("Malformed account data")]
    MalformedAccount,

    /// Thrown when the account discriminator is invalid
    #[msg("Invalid account discriminator")]
    InvalidAccountDiscriminator,

    /// Thrown when reentrancy is detected
    #[msg("Reentrancy detected")]
    ReentrancyDetected,

    /// Thrown when the account size doesn't match expected legacy size
    #[msg("Invalid account size for migration")]
    InvalidAccountSize,

    /// Thrown when the router authority is not the request router's signer PDA
    #[msg("Invalid router authority")]
    InvalidRouterAuthority,

    /// Thrown when a routed transfer is not called directly by a top-level instruction
    #[msg("Invalid router caller")]
    InvalidRouterCaller,
}

//----------------------------------------
// Helper Functions
//----------------------------------------

/// Accounts used by `process_transfer`, shared by plain and routed transfers
struct TransferAccounts<'a, 'info> {
    relay_depository: &'a Account<'info, RelayDepository>,
    used_request: &'a mut Account<'info, UsedRequest>,
    recipient: &'a UncheckedAccount<'info>,
    vault: &'a UncheckedAccount<'info>,
    mint: Option<&'a InterfaceAccount<'info, Mint>>,
    recipient_token_account: Option<&'a InterfaceAccount<'info, TokenAccount>>,
    vault_token_account: Option<&'a InterfaceAccount<'info, TokenAccount>>,
    ix_sysvar: &'a AccountInfo<'info>,
    token_program: &'a Interface<'info, TokenInterface>,
    system_program: &'a Program<'info, System>,
}

/// Validates an allocator-signed transfer request and moves funds from the vault
///
/// # Parameters
/// * `accounts` - The transfer accounts
/// * `request` - The transfer request details
/// * `request_hash` - The hash the allocator signed, also the used request seed
///
/// # Returns
/// * `Ok(())` on success
/// * `Err(error)` if signature is invalid or request can't be processed
fn process_transfer(
    accounts: TransferAccounts,
    request: &TransferRequest,
    request_hash: &[u8; 32],
) -> Result<()> {
    let relay_depository = accounts.relay_depository;
    let used_request = accounts.used_request;
    let vault_bump = relay_depository.vault_bump;

    require!(
        !used_request.is_used,
        CustomError::TransferRequestAlreadyUsed
    );

    let clock: Clock = Clock::get()?;
    require!(
        clock.unix_timestamp < request.expiration,
        CustomError::SignatureExpired
    );

    // Validate vault address matches the expected vault
    require_keys_eq!(
        accounts.vault.key(),
        request.vault_address,
        CustomError::InvalidVaultAddress
    );

    // Validate allocator signature
    let cur_index: usize =
        sysvar::instructions::load_current_index_checked(accounts.ix_sysvar)?.into();
    require!(cur_index > 0, CustomError::MalformedEd25519Data);

    let ed25519_instr_index = cur_index - 1;
    let signature_ix = sysvar::instructions::load_instruction_at_checked(
        ed25519_instr_index,
        accounts.ix_sysvar,
    )?;

    validate_ed25519_signature_instruction(
        &signature_ix,
        &relay_depository.allocator,
        request_hash,
    )?;

    // Validate domain separator (hard-required: reject if unset)
    let expected_domain = relay_depository
        .domain_separator
        .ok_or(CustomError::InvalidDomainSeparator)?;
    require!(
        request.domain == expected_domain,
        CustomError::InvalidDomainSeparator
    );

    used_request.is_used = true;

    let seeds: &[&[u8]] = &[VAULT_SEED, &[vault_bump]];

    // Execute the transfer based on the token type
    match request.token {
        // Transfer native
        None => {
            require_keys_eq!(
                accounts.recipient.key(),
                request.recipient,
                CustomError::InvalidRecipient
            );

            // Ensure vault maintains rent-exempt status after transfer
            let min_rent = Rent::get()?.minimum_balance(0);
            let vault_balance = accounts.vault.lamports();
            let max_transferable = vault_balance.saturating_sub(min_rent);
            require!(
                request.amount <= max_transferable,
                CustomError::InsufficientVaultBalance
            );

            invoke_signed(
                &system_instruction::transfer(
                    &accounts.vault.key(),
                    &accounts.recipient.key(),
                    request.amount,
                ),
                &[
                    accounts.vault.to_account_info(),
                    accounts.recipient.to_account_info(),
                    accounts.system_program.to_account_info(),
                ],
                &[seeds],
            )?;
        }
        // Transfer token
        Some(token_mint) => {
            let mint = accounts.mint.ok_or(CustomError::InvalidMint)?;

            require_keys_eq!(token_mint, mint.key(), CustomError::InvalidMint);

            let vault_token_account = accounts
                .vault_token_account
                .ok_or(CustomError::InvalidMint)?;
            let recipient_token_account = accounts
                .recipient_token_account
                .ok_or(CustomError::InvalidMint)?;

            require_keys_eq!(
                recipient_token_account.owner,
                request.recipient,
                CustomError::InvalidRecipient
            );

            // Ensure token program is either SPL Token or SPL Token 2022
            require!(
                accounts.token_program.key() == anchor_spl::token::ID
                || accounts.token_program.key() == anchor_spl::token_2022::ID,
                CustomError::InvalidTokenProgram
            );

            // Ensure mint is owned by the token program
            require_keys_eq!(
                *mint.to_account_info().owner,
                accounts.token_program.key(),
                CustomError::InvalidMint
            );

            transfer_checked(
                CpiContext::new_with_signer(
                    accounts.token_program.to_account_info(),
                    TransferChecked {
                        mint: mint.to_account_info(),
                        from: vault_token_account.to_account_info(),
                        to: recipient_token_account.to_account_info(),
                        authority: accounts.vault.to_account_info(),
                    },
                    &[seeds],
                ),
                request.amount,
                mint.decimals,
            )?;
        }
    }

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

    // Taken from:
    // https://github.com/solana-labs/perpetuals/blob/ebfb4972ea5d1cde8580a7e8c7b9dbd1fdb2b002/programs/perpetuals/src/instructions/set_custom_oracle_price_permissionless.rs#L90
    
    // Verify program id
    require_eq!(
        signature_ix.program_id,
        solana_program::ed25519_program::id(),
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

    require!(data.len() >= pk_off + 32, CustomError::MalformedEd25519Data);
    require!(data.len() >= sig_off + 64, CustomError::MalformedEd25519Data);
    require!(data.len() >= msg_off + msg_len, CustomError::MalformedEd25519Data);

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
/// * `name` - Protocol name (e.g., b"RelayDepository")
/// * `version` - Version bytes (e.g., b"1")
/// * `chain_id` - Chain identifier (e.g., b"solana-mainnet")
/// * `program_id` - The program ID
///
/// # Returns
/// * 32-byte domain separator hash
pub fn create_domain_separator(name: &[u8], version: &[u8], chain_id: &[u8], program_id: &Pubkey) -> [u8; 32] {
    use anchor_lang::solana_program::hash::hash;
    
    let mut data = Vec::new();
    data.extend_from_slice(name);
    data.extend_from_slice(version);
    data.extend_from_slice(chain_id);
    data.extend_from_slice(&program_id.to_bytes());
    
    hash(&data).to_bytes()
}

/// Calculates the transfer fee for a token
///
/// Determines the fee amount for the given mint and transfer amount,
/// taking into account the token extension for transfer fees if present.
///
/// # Parameters
/// * `mint_account` - The mint account of the token
/// * `pre_fee_amount` - The amount to transfer before fees
///
/// # Returns
/// * The calculated fee amount
pub fn get_transfer_fee(mint_account: &InterfaceAccount<Mint>, pre_fee_amount: u64) -> Result<u64> {
    /// Taken from:
    /// https://github.com/raydium-io/raydium-clmm/blob/eb7c392be9c8ef8af6eefb92ff834fc41ab975e3/programs/amm/src/util/token.rs#L218C1-L238C2
    let mint_info = mint_account.to_account_info();
    if *mint_info.owner == Token::id() {
        return Ok(0);
    }
    let mint_data = mint_info.try_borrow_data()?;
    let mint = StateWithExtensions::<spl_token_2022::state::Mint>::unpack(&mint_data)?;

    let fee = if let Ok(transfer_fee_config) = mint.get_extension::<TransferFeeConfig>() {
        transfer_fee_config
            .calculate_epoch_fee(Clock::get()?.epoch, pre_fee_amount)
            .unwrap()
    } else {
        0
    };
    Ok(fee)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retired_migration_instruction_is_rejected() {
        let mut data = hash(b"global:migrate_domain_separator").to_bytes()[..8].to_vec();
        "solana-mainnet".to_string().serialize(&mut data).unwrap();

        assert_eq!(
            entry(&crate::ID, &[], &data),
            Err(anchor_lang::solana_program::program_error::ProgramError::Custom(
                anchor_lang::error::ErrorCode::InstructionFallbackNotFound as u32,
            ))
        );
    }

    fn key(hex: &str) -> Pubkey {
        Pubkey::new_from_array(<[u8; 32]>::try_from(hex_to_bytes(hex)).unwrap())
    }

    fn hex_to_bytes(hex: &str) -> Vec<u8> {
        (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
            .collect()
    }

    // Shared vector with the Hub payload builder and the SDK
    #[test]
    fn routed_transfer_request_hash_matches_hub_vector() {
        let request = RoutedTransferRequest {
            domain: key("5fe7f977e71dba2ea1a68e21057beebb9be2ac30c6410aa38d4f3fbe41dcffd2").to_bytes(),
            recipient: key("d354d13253ad4f7764f5c933ccadca795c052d143e2721ff5716848f1fe390cc"),
            token: Some(key("471500e6828e391e3b31326faa896e01212f976de1ad90ecb7823a2b96e9eb85")),
            amount: 1_000_000,
            nonce: 14_041_958_522_398_838_600,
            expiration: 1_700_000_300,
            vault_address: key("1fa427265aebc381e466efb16f55b95fc3d44af745a3c52f6c599d3a7ec6b19a"),
            router: key("7d01d9c59e2296807ea0d4df99ccf825c028060cba6aa00c2ab482dad32161be"),
        };
        assert_eq!(
            ROUTED_TRANSFER_REQUEST_PREFIX.len() + request.try_to_vec().unwrap().len(),
            225
        );
        assert_eq!(
            request.get_hash().to_bytes().to_vec(),
            hex_to_bytes("baac8f151b7e4a8db284ac7c47affad9d7dcd8c8df0f6235b80dbe0e2ca887a3")
        );
    }
}
