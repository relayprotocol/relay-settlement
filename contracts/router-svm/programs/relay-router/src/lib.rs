//! Relay router: a routed depository withdrawal lands at a bundle address derived from the bundle
//! hash, and the executor's own swap runs between `release` and `settle` in one transaction.

use anchor_lang::{
    prelude::*,
    solana_program::{
        instruction::{get_stack_height, AccountMeta, Instruction, TRANSACTION_LEVEL_STACK_HEIGHT},
        program::invoke_signed,
        program_option::COption,
    },
    system_program::{transfer, Transfer},
    Discriminator,
};
use anchor_spl::{
    associated_token::{get_associated_token_address_with_program_id, AssociatedToken},
    token::spl_token::native_mint,
    token_interface::{
        approve, close_account, revoke, sync_native, transfer_checked, Approve, CloseAccount, Mint,
        Revoke, SyncNative, TokenAccount, TokenInterface, TransferChecked,
    },
};
use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked};
use solana_sha256_hasher::hash;

//----------------------------------------
// Constants
//----------------------------------------

const BUNDLE_SEED: &[u8] = b"bundle";

const DEPOSITORY_CALLER_SEED: &[u8] = b"depository_caller";

const CONFIG_SEED: &[u8] = b"config";

const DEPOSITORY_ROLE_SEED: &[u8] = b"depository_role";

const BUNDLE_VERSION: u8 = 1;

/// Anchor discriminator of the depository's `execute_transfer_routed` instruction
const EXECUTE_TRANSFER_ROUTED_DISCRIMINATOR: [u8; 8] = [172, 229, 229, 124, 120, 255, 6, 111];

//----------------------------------------
// Program ID
//----------------------------------------

declare_id!("9QybjuydfDYwJkdDLMJJaHEcQPaYeRoiJ5cYj7qLd5Su");

//----------------------------------------
// Program Module
//----------------------------------------

#[program]
pub mod relay_router {
    use super::*;

    /// Initialize the router config with its owner
    ///
    /// Only the program's upgrade authority can call this, once.
    ///
    /// # Parameters
    /// * `ctx` - The context containing the accounts
    /// * `owner` - The account that grants and revokes depository roles
    pub fn initialize(ctx: Context<Initialize>, owner: Pubkey) -> Result<()> {
        ctx.accounts.config.owner = owner;
        Ok(())
    }

    /// Allow `release` and `release_gateway` to call a depository program
    ///
    /// # Parameters
    /// * `ctx` - The context containing the accounts
    /// * `depository` - The depository program id
    pub fn grant_depository_role(
        _ctx: Context<GrantDepositoryRole>,
        _depository: Pubkey,
    ) -> Result<()> {
        Ok(())
    }

    /// Stop `release` and `release_gateway` from calling a depository program, including already
    /// signed requests
    ///
    /// # Parameters
    /// * `ctx` - The context containing the accounts
    /// * `depository` - The depository program id
    pub fn revoke_depository_role(
        _ctx: Context<RevokeDepositoryRole>,
        _depository: Pubkey,
    ) -> Result<()> {
        Ok(())
    }

    /// Hand the config to a new owner
    ///
    /// # Parameters
    /// * `ctx` - The context containing the accounts
    /// * `new_owner` - The account that grants and revokes depository roles from now on
    pub fn set_owner(ctx: Context<SetOwner>, new_owner: Pubkey) -> Result<()> {
        require_keys_neq!(new_owner, Pubkey::default(), CustomError::InvalidOwner);
        ctx.accounts.config.owner = new_owner;
        Ok(())
    }

    /// Pull a routed withdrawal into the bundle address
    ///
    /// Requires the matching `settle` later in the same transaction. The depository
    /// only executes the routed request when this program signs as `router_authority`.
    /// The executor becomes the delegate of exactly the withdrawn amount for its swap,
    /// so `settle` can tell unspent funds from tokens anyone else sent to the account. Bundles with calls, a single currency or a zero
    /// `minimum_amount` are rejected.
    ///
    /// # Parameters
    /// * `ctx` - The context containing the accounts
    /// * `bundle_hash` - The hash of the bundle carried by the matching `settle`
    /// * `bump` - The bump of the bundle address
    /// * `request` - The allocator-signed routed transfer request
    pub fn release<'info>(
        ctx: Context<'info, Release<'info>>,
        bundle_hash: [u8; 32],
        bump: u8,
        request: RoutedTransferRequest,
    ) -> Result<()> {
        let bundle_address = ctx.accounts.bundle_address.key();
        let bump = [bump];
        let seeds: &[&[u8]] = &[BUNDLE_SEED, &bundle_hash, &bump];
        let bundle = checked_release_bundle(
            &ctx.accounts.ix_sysvar,
            &ctx.accounts.executor.key(),
            &ctx.accounts.depository_program.key(),
            &ctx.accounts.depository_role,
            &bundle_address,
            &bundle_hash,
            seeds,
            &ReleaseRequest {
                recipient: request.recipient,
                router: request.router,
                token: request.token,
                amount: request.amount,
            },
        )?;

        execute_transfer_routed(ctx.accounts, &request, ctx.bumps.router_authority)?;

        let token_program = &ctx.accounts.withdraw_token_program;
        let withdraw_account = ctx
            .accounts
            .bundle_withdraw_token_account
            .as_ref()
            .ok_or(CustomError::InvalidTokenAccount)?;
        require_bundle_withdraw_account(
            &withdraw_account.key(),
            &bundle_address,
            &bundle,
            &token_program.key(),
        )?;

        // Native SOL is wrapped so the swap can spend it as WSOL
        if bundle.withdraw_mint.is_none() {
            transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.system_program.key(),
                    Transfer {
                        from: ctx.accounts.bundle_address.to_account_info(),
                        to: withdraw_account.to_account_info(),
                    },
                    &[seeds],
                ),
                request.amount,
            )?;
            sync_native(CpiContext::new(
                token_program.key(),
                SyncNative {
                    account: withdraw_account.to_account_info(),
                },
            ))?;
        }

        delegate_to_executor(
            token_program.key(),
            withdraw_account.to_account_info(),
            ctx.accounts.executor.to_account_info(),
            ctx.accounts.bundle_address.to_account_info(),
            request.amount,
            seeds,
        )?;

        emit!(Released {
            bundle_address,
            bundle_hash,
            amount: request.amount,
        });

        Ok(())
    }

    /// Pull a routed Circle Gateway transfer into the bundle address
    ///
    /// Same as `release` for a request of the gateway depository, which mints the
    /// transfer from Circle Gateway. Gateway transfers are tokens only.
    ///
    /// # Parameters
    /// * `ctx` - The context containing the accounts
    /// * `bundle_hash` - The hash of the bundle carried by the matching `settle`
    /// * `bump` - The bump of the bundle address
    /// * `request` - The allocator-signed routed gateway transfer request
    /// * `max_block_height` - The last slot Circle's attestation can be minted at
    /// * `circle_signature` - Circle's signature over the attestation
    pub fn release_gateway<'info>(
        ctx: Context<'info, ReleaseGateway<'info>>,
        bundle_hash: [u8; 32],
        bump: u8,
        request: GatewayRoutedTransferRequest,
        max_block_height: u64,
        circle_signature: [u8; 65],
    ) -> Result<()> {
        let bundle_address = ctx.accounts.bundle_address.key();
        let bump = [bump];
        let seeds: &[&[u8]] = &[BUNDLE_SEED, &bundle_hash, &bump];
        let bundle = checked_release_bundle(
            &ctx.accounts.ix_sysvar,
            &ctx.accounts.executor.key(),
            &ctx.accounts.depository_program.key(),
            &ctx.accounts.depository_role,
            &bundle_address,
            &bundle_hash,
            seeds,
            &ReleaseRequest {
                recipient: request.recipient,
                router: request.router,
                token: Some(request.token),
                amount: request.amount,
            },
        )?;

        execute_gateway_transfer_routed(
            ctx.accounts,
            &request,
            max_block_height,
            &circle_signature,
            ctx.bumps.router_authority,
        )?;

        let token_program = &ctx.accounts.withdraw_token_program;
        let withdraw_account = &ctx.accounts.bundle_withdraw_token_account;
        require_bundle_withdraw_account(
            &withdraw_account.key(),
            &bundle_address,
            &bundle,
            &token_program.key(),
        )?;

        delegate_to_executor(
            token_program.key(),
            withdraw_account.to_account_info(),
            ctx.accounts.executor.to_account_info(),
            ctx.accounts.bundle_address.to_account_info(),
            request.amount,
            seeds,
        )?;

        emit!(Released {
            bundle_address,
            bundle_hash,
            amount: request.amount,
        });

        Ok(())
    }

    /// Pay the fill to the recipient
    ///
    /// Pays the whole fill balance and checks what the recipient received against
    /// `minimum_amount`, returns unspent withdrawn funds to the recipient, closes the
    /// bundle token accounts and sends any lamports left at the bundle address to the
    /// recipient.
    ///
    /// # Parameters
    /// * `ctx` - The context containing the accounts
    /// * `bundle` - The bundle the withdrawal was routed to
    /// * `bump` - The bump of the bundle address
    pub fn settle(ctx: Context<Settle>, bundle: Bundle, bump: u8) -> Result<()> {
        require!(
            get_stack_height() == TRANSACTION_LEVEL_STACK_HEIGHT,
            CustomError::NotTopLevel
        );
        require!(bundle.version == BUNDLE_VERSION, CustomError::InvalidBundle);

        let bundle_hash = bundle.get_hash();
        let bump = [bump];
        let seeds: &[&[u8]] = &[BUNDLE_SEED, &bundle_hash, &bump];
        let bundle_address = ctx.accounts.bundle_address.key();
        require_bundle_address(&bundle_address, seeds)?;
        require_keys_eq!(
            ctx.accounts.executor.key(),
            bundle.executor,
            CustomError::InvalidExecutor
        );
        require_keys_eq!(
            ctx.accounts.recipient.key(),
            bundle.recipient,
            CustomError::InvalidRecipient
        );
        require_keys_neq!(
            bundle.recipient,
            bundle_address,
            CustomError::InvalidRecipient
        );
        require!(
            has_release(
                &ctx.accounts.ix_sysvar,
                &bundle_hash,
                bump[0],
                &bundle_address
            )?,
            CustomError::MissingRelease
        );

        let accounts = &ctx.accounts;
        let amount_paid = pay_fill(accounts, &bundle, seeds)?;
        let unspent_returned = return_unspent(accounts, &bundle, seeds)?;

        // Rent of closed WSOL accounts and anything sent to the bundle address goes to the recipient
        let leftover = accounts.bundle_address.lamports();
        if leftover > 0 {
            // A recipient left below rent exemption would fail the transaction, so the executor takes it
            let recipient_balance = accounts.recipient.lamports().saturating_add(leftover);
            let to = if recipient_balance < Rent::get()?.minimum_balance(0) {
                accounts.executor.to_account_info()
            } else {
                accounts.recipient.to_account_info()
            };
            transfer_from_bundle(accounts, to, leftover, seeds)?;
        }

        emit!(Settled {
            bundle_address,
            execution_id: bundle.execution_id,
            amount_paid,
            unspent_returned,
        });

        Ok(())
    }
}

//----------------------------------------
// Accounts
//----------------------------------------

/// Router configuration
#[account]
#[derive(InitSpace)]
pub struct RouterConfig {
    /// Grants and revokes depository roles
    pub owner: Pubkey,
}

/// Marker that allows `release` and `release_gateway` to call a depository program
#[account]
#[derive(InitSpace)]
pub struct DepositoryRole {}

//----------------------------------------
// Instruction Contexts
//----------------------------------------

/// Accounts required for initializing the router config
#[derive(Accounts)]
pub struct Initialize<'info> {
    /// The router config
    #[account(
        init,
        payer = authority,
        space = 8 + RouterConfig::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, RouterConfig>,

    /// The program's upgrade authority
    #[account(mut)]
    pub authority: Signer<'info>,

    /// This program
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ CustomError::Unauthorized)]
    pub program: Program<'info, crate::program::RelayRouter>,

    /// This program's data account
    #[account(constraint = program_data.upgrade_authority_address == Some(authority.key()) @ CustomError::Unauthorized)]
    pub program_data: Account<'info, ProgramData>,

    /// The system program
    pub system_program: Program<'info, System>,
}

/// Accounts required for granting a depository role
#[derive(Accounts)]
#[instruction(depository: Pubkey)]
pub struct GrantDepositoryRole<'info> {
    /// The router config
    #[account(seeds = [CONFIG_SEED], bump, has_one = owner @ CustomError::Unauthorized)]
    pub config: Account<'info, RouterConfig>,

    /// The router owner, pays the role account
    #[account(mut)]
    pub owner: Signer<'info>,

    /// The role for the depository
    #[account(
        init,
        payer = owner,
        space = 8 + DepositoryRole::INIT_SPACE,
        seeds = [DEPOSITORY_ROLE_SEED, depository.as_ref()],
        bump
    )]
    pub depository_role: Account<'info, DepositoryRole>,

    /// The system program
    pub system_program: Program<'info, System>,
}

/// Accounts required for revoking a depository role
#[derive(Accounts)]
#[instruction(depository: Pubkey)]
pub struct RevokeDepositoryRole<'info> {
    /// The router config
    #[account(seeds = [CONFIG_SEED], bump, has_one = owner @ CustomError::Unauthorized)]
    pub config: Account<'info, RouterConfig>,

    /// The router owner, receives the role account's rent
    #[account(mut)]
    pub owner: Signer<'info>,

    /// The role for the depository
    #[account(
        mut,
        close = owner,
        seeds = [DEPOSITORY_ROLE_SEED, depository.as_ref()],
        bump
    )]
    pub depository_role: Account<'info, DepositoryRole>,
}

/// Accounts required for changing the router owner
#[derive(Accounts)]
pub struct SetOwner<'info> {
    /// The router config
    #[account(mut, seeds = [CONFIG_SEED], bump, has_one = owner @ CustomError::Unauthorized)]
    pub config: Account<'info, RouterConfig>,

    /// The current router owner
    pub owner: Signer<'info>,
}

/// Accounts required for releasing a routed withdrawal
///
/// The depository accounts follow `execute_transfer_routed`; the depository validates them.
#[derive(Accounts)]
pub struct Release<'info> {
    /// The executor committed in the bundle, pays the used request account
    #[account(mut)]
    pub executor: Signer<'info>,

    /// The bundle address the withdrawal is routed to
    /// CHECK: Derived from the bundle hash in the handler
    #[account(mut)]
    pub bundle_address: UncheckedAccount<'info>,

    /// The router's signer for the depository
    /// CHECK: PDA of this program, only signs the depository CPI
    #[account(seeds = [DEPOSITORY_CALLER_SEED], bump)]
    pub router_authority: UncheckedAccount<'info>,

    /// The depository program committed in the bundle
    /// CHECK: Address checked against the bundle
    pub depository_program: UncheckedAccount<'info>,

    /// CHECK: Validated by the depository
    pub relay_depository: UncheckedAccount<'info>,

    /// CHECK: Validated by the depository
    #[account(mut)]
    pub vault: UncheckedAccount<'info>,

    /// The withdrawn token mint, `None` for native SOL
    /// CHECK: Validated by the depository
    pub withdraw_mint: Option<UncheckedAccount<'info>>,

    /// The bundle address's token account for the withdrawn currency (WSOL for native SOL)
    /// CHECK: Validated by the depository, or against the associated token address in the handler
    #[account(mut)]
    pub bundle_withdraw_token_account: Option<UncheckedAccount<'info>>,

    /// CHECK: Validated by the depository
    #[account(mut)]
    pub vault_token_account: Option<UncheckedAccount<'info>>,

    /// CHECK: Initialized by the depository
    #[account(mut)]
    pub used_request: UncheckedAccount<'info>,

    /// The instruction sysvar used to find the matching `settle`
    /// CHECK: Address checked against the instructions sysvar
    #[account(address = solana_instructions_sysvar::ID)]
    pub ix_sysvar: UncheckedAccount<'info>,

    /// The token program of the withdrawn currency (SPL Token for native SOL)
    pub withdraw_token_program: Interface<'info, TokenInterface>,
    /// The associated token program
    pub associated_token_program: Program<'info, AssociatedToken>,
    /// The system program
    pub system_program: Program<'info, System>,

    /// The role granted to `bundle.depository`
    /// CHECK: Address and existence checked in the handler, since the bundle is read from `settle`
    pub depository_role: UncheckedAccount<'info>,
}

/// Accounts required for releasing a routed Circle Gateway transfer
///
/// The depository accounts follow the gateway depository's `execute_transfer_routed`;
/// the depository and Circle's GatewayMinter validate them.
#[derive(Accounts)]
pub struct ReleaseGateway<'info> {
    /// The executor committed in the bundle, pays the replay accounts
    #[account(mut)]
    pub executor: Signer<'info>,

    /// The bundle address the transfer is routed to
    /// CHECK: Derived from the bundle hash in the handler
    pub bundle_address: UncheckedAccount<'info>,

    /// The router's signer for the depository
    /// CHECK: PDA of this program, only signs the depository CPI
    #[account(seeds = [DEPOSITORY_CALLER_SEED], bump)]
    pub router_authority: UncheckedAccount<'info>,

    /// The gateway depository program committed in the bundle
    /// CHECK: Address checked against the bundle
    pub depository_program: UncheckedAccount<'info>,

    /// CHECK: Validated by the depository
    pub relay_gateway_depository: UncheckedAccount<'info>,

    /// CHECK: Validated by the depository
    #[account(mut)]
    pub vault: UncheckedAccount<'info>,

    /// The transferred token mint
    /// CHECK: Validated by the depository
    pub withdraw_mint: UncheckedAccount<'info>,

    /// The bundle address's token account for the transferred token
    /// CHECK: Validated by the depository and against the associated token address in the handler
    #[account(mut)]
    pub bundle_withdraw_token_account: UncheckedAccount<'info>,

    /// CHECK: Initialized by the depository
    #[account(mut)]
    pub used_request: UncheckedAccount<'info>,

    /// The instruction sysvar used to find the matching `settle`
    /// CHECK: Address checked against the instructions sysvar
    #[account(address = solana_instructions_sysvar::ID)]
    pub ix_sysvar: UncheckedAccount<'info>,

    /// CHECK: Validated by the depository
    pub gateway_minter_program: UncheckedAccount<'info>,

    /// CHECK: Validated by the GatewayMinter program
    pub gateway_minter: UncheckedAccount<'info>,

    /// CHECK: Validated by the GatewayMinter program
    #[account(mut)]
    pub gateway_minter_custody: UncheckedAccount<'info>,

    /// CHECK: Validated by the GatewayMinter program
    #[account(mut)]
    pub used_transfer_spec_hash: UncheckedAccount<'info>,

    /// CHECK: Validated by the GatewayMinter program
    pub gateway_minter_event_authority: UncheckedAccount<'info>,

    /// The token program of the transferred token
    pub withdraw_token_program: Interface<'info, TokenInterface>,
    /// The system program
    pub system_program: Program<'info, System>,

    /// The role granted to `bundle.depository`
    /// CHECK: Address and existence checked in the handler, since the bundle is read from `settle`
    pub depository_role: UncheckedAccount<'info>,
}

/// Accounts required for settling a bundle
///
/// The fill mint and recipient fill account are `None` for a native SOL fill, and the
/// withdraw mint is `None` for a native SOL withdrawal.
#[derive(Accounts)]
pub struct Settle<'info> {
    /// The executor committed in the bundle, receives the rent of closed token accounts
    #[account(mut)]
    pub executor: Signer<'info>,

    /// The bundle address holding the fill
    /// CHECK: Derived from the bundle hash in the handler
    #[account(mut)]
    pub bundle_address: UncheckedAccount<'info>,

    /// The recipient committed in the bundle
    /// CHECK: Address checked against the bundle
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,

    /// The fill mint, `None` when the fill is native SOL
    pub fill_mint: Option<Box<InterfaceAccount<'info, Mint>>>,

    /// The bundle address's token account for the fill (WSOL for a native fill)
    #[account(mut)]
    pub bundle_fill_token_account: Option<Box<InterfaceAccount<'info, TokenAccount>>>,

    /// The recipient's token account for the fill
    #[account(mut)]
    pub recipient_fill_token_account: Option<Box<InterfaceAccount<'info, TokenAccount>>>,

    /// The withdrawn token mint
    pub withdraw_mint: Option<Box<InterfaceAccount<'info, Mint>>>,

    /// The bundle address's token account for the withdrawn currency (WSOL for native SOL)
    #[account(mut)]
    pub bundle_withdraw_token_account: Option<Box<InterfaceAccount<'info, TokenAccount>>>,

    /// The recipient's token account for unspent withdrawn tokens, only needed when some are left
    #[account(mut)]
    pub recipient_withdraw_token_account: Option<Box<InterfaceAccount<'info, TokenAccount>>>,

    /// The instruction sysvar used to find the matching `release`
    /// CHECK: Address checked against the instructions sysvar
    #[account(address = solana_instructions_sysvar::ID)]
    pub ix_sysvar: UncheckedAccount<'info>,

    /// The token program of the fill
    pub fill_token_program: Option<Interface<'info, TokenInterface>>,
    /// The token program of the withdrawn currency
    pub withdraw_token_program: Option<Interface<'info, TokenInterface>>,
    /// The system program
    pub system_program: Program<'info, System>,
}

//----------------------------------------
// Custom Types
//----------------------------------------

/// The parameters a routed withdrawal commits to through the bundle address
#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Debug)]
pub struct Bundle {
    pub version: u8,
    pub order_id: [u8; 32],
    pub execution_id: [u8; 32],
    pub executor: Pubkey,
    pub depository: Pubkey,
    /// `None` for native SOL
    pub withdraw_mint: Option<Pubkey>,
    pub minimum_withdraw_amount: u64,
    /// The native mint pays native SOL
    pub fill_mint: Pubkey,
    pub recipient: Pubkey,
    pub minimum_amount: u64,
    pub call_accounts: Vec<CallAccount>,
    pub calls: Vec<BundleCall>,
}

impl Bundle {
    /// Computes the hash that derives the bundle address
    pub fn get_hash(&self) -> [u8; 32] {
        let mut data = Vec::new();
        self.serialize(&mut data).unwrap();
        hash(&data).to_bytes()
    }

    fn is_native_fill(&self) -> bool {
        self.fill_mint == native_mint::ID
    }

    /// The withdrawn mint, with native SOL as the native mint
    fn withdraw_currency(&self) -> Pubkey {
        self.withdraw_mint.unwrap_or(native_mint::ID)
    }
}

/// An account referenced by the user calls, reserved for a later version
#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Debug)]
pub struct CallAccount {
    pub pubkey: Pubkey,
    pub is_writable: bool,
}

/// A user call, referencing `call_accounts` by index, reserved for a later version
#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Debug)]
pub struct BundleCall {
    pub program_id_index: u8,
    pub account_indexes: Vec<u8>,
    pub data: Vec<u8>,
}

/// The depository's routed transfer request, in its exact layout
#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Debug)]
pub struct RoutedTransferRequest {
    pub domain: [u8; 32],
    pub recipient: Pubkey,
    pub token: Option<Pubkey>,
    pub amount: u64,
    pub nonce: u64,
    pub expiration: i64,
    pub vault_address: Pubkey,
    pub router: Pubkey,
}

/// The gateway depository's routed transfer request, in its exact layout
#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Debug)]
pub struct GatewayRoutedTransferRequest {
    pub domain: [u8; 32],
    pub transfer_spec_hash: [u8; 32],
    pub recipient: Pubkey,
    pub token: Pubkey,
    pub amount: u64,
    pub nonce: u64,
    pub expiration: i64,
    pub router: Pubkey,
}

/// The fields of a depository request that a release checks against the bundle
struct ReleaseRequest {
    recipient: Pubkey,
    router: Pubkey,
    /// `None` for native SOL
    token: Option<Pubkey>,
    amount: u64,
}

//----------------------------------------
// Events
//----------------------------------------

/// Event emitted when a routed withdrawal reaches the bundle address
#[event]
pub struct Released {
    pub bundle_address: Pubkey,
    pub bundle_hash: [u8; 32],
    pub amount: u64,
}

/// Event emitted when a bundle is paid out
#[event]
pub struct Settled {
    pub bundle_address: Pubkey,
    pub execution_id: [u8; 32],
    pub amount_paid: u64,
    pub unspent_returned: u64,
}

//----------------------------------------
// Error Definitions
//----------------------------------------

#[error_code]
pub enum CustomError {
    #[msg("Must be a top-level instruction")]
    NotTopLevel,
    #[msg("Missing settle instruction")]
    MissingSettle,
    #[msg("Missing release instruction")]
    MissingRelease,
    #[msg("Only one release and one settle per transaction")]
    MultipleBundleInstructions,
    #[msg("Invalid bundle")]
    InvalidBundle,
    #[msg("Invalid bundle address")]
    InvalidBundleAddress,
    #[msg("Invalid executor")]
    InvalidExecutor,
    #[msg("Invalid depository")]
    InvalidDepository,
    #[msg("Invalid router")]
    InvalidRouter,
    #[msg("Invalid mint")]
    InvalidMint,
    #[msg("Invalid recipient")]
    InvalidRecipient,
    #[msg("Invalid token account")]
    InvalidTokenAccount,
    #[msg("Withdrawal below the bundle minimum")]
    InsufficientWithdrawal,
    #[msg("Fill below the bundle minimum")]
    InsufficientFill,
    #[msg("Bundle calls are not supported")]
    CallsNotSupported,
    #[msg("Depository not allowed")]
    DepositoryNotAllowed,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Withdraw and fill currency must differ")]
    SameCurrencyNotSupported,
    #[msg("Invalid owner")]
    InvalidOwner,
}

//----------------------------------------
// Helper Functions
//----------------------------------------

fn depository_role_address(depository: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[DEPOSITORY_ROLE_SEED, depository.as_ref()], &crate::ID).0
}

fn require_bundle_address(address: &Pubkey, seeds: &[&[u8]]) -> Result<()> {
    let expected = Pubkey::create_program_address(seeds, &crate::ID)
        .map_err(|_| error!(CustomError::InvalidBundleAddress))?;
    require_keys_eq!(*address, expected, CustomError::InvalidBundleAddress);
    Ok(())
}

/// Returns the arguments of a top-level instruction of this program with the given discriminator
fn router_instruction_args<'a>(ix: &'a Instruction, discriminator: &[u8]) -> Option<&'a [u8]> {
    let n = discriminator.len();
    if ix.program_id == crate::ID && ix.data.len() >= n && &ix.data[..n] == discriminator {
        Some(&ix.data[n..])
    } else {
        None
    }
}

/// Returns the arguments of a top-level `release` or `release_gateway` of this program, and
/// whether it is the gateway one
fn release_args(ix: &Instruction) -> Option<(&[u8], bool)> {
    router_instruction_args(ix, crate::instruction::Release::DISCRIMINATOR)
        .map(|args| (args, false))
        .or_else(|| {
            router_instruction_args(ix, crate::instruction::ReleaseGateway::DISCRIMINATOR)
                .map(|args| (args, true))
        })
}

/// Runs the checks a release makes before calling the depository and returns the bundle of
/// the matching `settle`
#[allow(clippy::too_many_arguments)]
fn checked_release_bundle(
    ix_sysvar: &AccountInfo,
    executor: &Pubkey,
    depository_program: &Pubkey,
    depository_role: &AccountInfo,
    bundle_address: &Pubkey,
    bundle_hash: &[u8; 32],
    seeds: &[&[u8]],
    request: &ReleaseRequest,
) -> Result<Bundle> {
    require!(
        get_stack_height() == TRANSACTION_LEVEL_STACK_HEIGHT,
        CustomError::NotTopLevel
    );

    let bundle = find_settle_bundle(ix_sysvar, bundle_hash)?;
    require!(bundle.version == BUNDLE_VERSION, CustomError::InvalidBundle);
    require!(bundle.minimum_amount > 0, CustomError::InvalidBundle);
    require!(
        bundle.call_accounts.is_empty() && bundle.calls.is_empty(),
        CustomError::CallsNotSupported
    );
    require!(
        bundle.withdraw_currency() != bundle.fill_mint,
        CustomError::SameCurrencyNotSupported
    );
    require_keys_eq!(*executor, bundle.executor, CustomError::InvalidExecutor);
    require_keys_eq!(
        *depository_program,
        bundle.depository,
        CustomError::InvalidDepository
    );
    require!(
        depository_role.key() == depository_role_address(&bundle.depository)
            && depository_role.owner == &crate::ID
            && !depository_role.data_is_empty(),
        CustomError::DepositoryNotAllowed
    );
    require!(
        bundle.withdraw_mint != Some(native_mint::ID),
        CustomError::InvalidMint
    );

    require_bundle_address(bundle_address, seeds)?;

    require_keys_eq!(
        request.recipient,
        *bundle_address,
        CustomError::InvalidRecipient
    );
    require_keys_eq!(request.router, crate::ID, CustomError::InvalidRouter);
    require!(
        request.token == bundle.withdraw_mint,
        CustomError::InvalidMint
    );
    require!(
        request.amount >= bundle.minimum_withdraw_amount,
        CustomError::InsufficientWithdrawal
    );

    Ok(bundle)
}

/// Checks that a token account is the bundle address's account for the withdrawn currency
fn require_bundle_withdraw_account(
    account: &Pubkey,
    bundle_address: &Pubkey,
    bundle: &Bundle,
    token_program: &Pubkey,
) -> Result<()> {
    require_keys_eq!(
        *account,
        get_associated_token_address_with_program_id(
            bundle_address,
            &bundle.withdraw_currency(),
            token_program
        ),
        CustomError::InvalidTokenAccount
    );
    Ok(())
}

/// Makes the executor the delegate of the withdrawn amount in the bundle withdraw account
fn delegate_to_executor<'info>(
    token_program: Pubkey,
    withdraw_account: AccountInfo<'info>,
    executor: AccountInfo<'info>,
    bundle_address: AccountInfo<'info>,
    amount: u64,
    seeds: &[&[u8]],
) -> Result<()> {
    approve(
        CpiContext::new_with_signer(
            token_program,
            Approve {
                to: withdraw_account,
                delegate: executor,
                authority: bundle_address,
            },
            &[seeds],
        ),
        amount,
    )
}

/// Returns the bundle of the single `settle` after the current `release`, rejecting
/// any other `release` or `settle` in the transaction
fn find_settle_bundle(ix_sysvar: &AccountInfo, bundle_hash: &[u8; 32]) -> Result<Bundle> {
    let current_index: usize = load_current_index_checked(ix_sysvar)?.into();
    let mut settle_bundle = None;

    let mut index = 0;
    while let Ok(ix) = load_instruction_at_checked(index, ix_sysvar) {
        if release_args(&ix).is_some() {
            require!(
                index == current_index,
                CustomError::MultipleBundleInstructions
            );
        } else if let Some(args) =
            router_instruction_args(&ix, crate::instruction::Settle::DISCRIMINATOR)
        {
            require!(
                index > current_index && settle_bundle.is_none(),
                CustomError::MultipleBundleInstructions
            );
            let settle = crate::instruction::Settle::try_from_slice(args)
                .map_err(|_| error!(CustomError::InvalidBundle))?;
            require!(
                &settle.bundle.get_hash() == bundle_hash,
                CustomError::MissingSettle
            );
            settle_bundle = Some(settle.bundle);
        }
        index += 1;
    }

    settle_bundle.ok_or(error!(CustomError::MissingSettle))
}

/// Checks that a `release` for the same bundle hash and bundle address precedes the current `settle`
fn has_release(
    ix_sysvar: &AccountInfo,
    bundle_hash: &[u8; 32],
    bump: u8,
    bundle_address: &Pubkey,
) -> Result<bool> {
    let current_index: usize = load_current_index_checked(ix_sysvar)?.into();
    for index in 0..current_index {
        let ix = load_instruction_at_checked(index, ix_sysvar)?;
        // Both instructions start with the bundle hash and bump, with the bundle address second
        let (release_hash, release_bump) = match release_args(&ix) {
            Some((args, false)) => crate::instruction::Release::try_from_slice(args)
                .map(|release| (release.bundle_hash, release.bump)),
            Some((args, true)) => crate::instruction::ReleaseGateway::try_from_slice(args)
                .map(|release| (release.bundle_hash, release.bump)),
            None => continue,
        }
        .map_err(|_| error!(CustomError::InvalidBundle))?;
        // A non-canonical bump would settle a different address than the one released to
        if &release_hash == bundle_hash
            && release_bump == bump
            && ix.accounts.get(1).map(|meta| meta.pubkey) == Some(*bundle_address)
        {
            return Ok(true);
        }
    }
    Ok(false)
}

/// CPIs the depository's `execute_transfer_routed`, signing as `router_authority`
fn execute_transfer_routed(
    accounts: &Release,
    request: &RoutedTransferRequest,
    router_authority_bump: u8,
) -> Result<()> {
    let depository = accounts.depository_program.key();
    // Anchor reads an optional account passed as the program id as `None`
    let optional =
        |account: &Option<UncheckedAccount>, is_token: bool, is_writable: bool| match account
            .as_ref()
            .filter(|_| is_token)
        {
            Some(account) if is_writable => AccountMeta::new(account.key(), false),
            Some(account) => AccountMeta::new_readonly(account.key(), false),
            None => AccountMeta::new_readonly(depository, false),
        };
    let is_token = request.token.is_some();

    let mut data = EXECUTE_TRANSFER_ROUTED_DISCRIMINATOR.to_vec();
    request.serialize(&mut data)?;
    let ix = Instruction {
        program_id: depository,
        accounts: vec![
            AccountMeta::new_readonly(accounts.relay_depository.key(), false),
            AccountMeta::new(accounts.executor.key(), true),
            AccountMeta::new(accounts.bundle_address.key(), false),
            AccountMeta::new(accounts.vault.key(), false),
            optional(&accounts.withdraw_mint, is_token, false),
            optional(&accounts.bundle_withdraw_token_account, is_token, true),
            optional(&accounts.vault_token_account, is_token, true),
            AccountMeta::new(accounts.used_request.key(), false),
            AccountMeta::new_readonly(accounts.ix_sysvar.key(), false),
            AccountMeta::new_readonly(accounts.withdraw_token_program.key(), false),
            AccountMeta::new_readonly(accounts.associated_token_program.key(), false),
            AccountMeta::new_readonly(accounts.system_program.key(), false),
            AccountMeta::new_readonly(accounts.router_authority.key(), true),
        ],
        data,
    };

    let mut infos = vec![
        accounts.relay_depository.to_account_info(),
        accounts.executor.to_account_info(),
        accounts.bundle_address.to_account_info(),
        accounts.vault.to_account_info(),
        accounts.used_request.to_account_info(),
        accounts.ix_sysvar.to_account_info(),
        accounts.withdraw_token_program.to_account_info(),
        accounts.associated_token_program.to_account_info(),
        accounts.system_program.to_account_info(),
        accounts.router_authority.to_account_info(),
        accounts.depository_program.to_account_info(),
    ];
    for account in [
        &accounts.withdraw_mint,
        &accounts.bundle_withdraw_token_account,
        &accounts.vault_token_account,
    ]
    .into_iter()
    .flatten()
    {
        infos.push(account.to_account_info());
    }

    invoke_signed(
        &ix,
        &infos,
        &[&[DEPOSITORY_CALLER_SEED, &[router_authority_bump]]],
    )
    .map_err(Into::into)
}

/// CPIs the gateway depository's `execute_transfer_routed`, signing as `router_authority`
fn execute_gateway_transfer_routed(
    accounts: &ReleaseGateway,
    request: &GatewayRoutedTransferRequest,
    max_block_height: u64,
    circle_signature: &[u8; 65],
    router_authority_bump: u8,
) -> Result<()> {
    // Both depositories name the instruction `execute_transfer_routed`
    let mut data = EXECUTE_TRANSFER_ROUTED_DISCRIMINATOR.to_vec();
    request.serialize(&mut data)?;
    max_block_height.serialize(&mut data)?;
    circle_signature.serialize(&mut data)?;
    let ix = Instruction {
        program_id: accounts.depository_program.key(),
        accounts: vec![
            AccountMeta::new_readonly(accounts.relay_gateway_depository.key(), false),
            AccountMeta::new(accounts.executor.key(), true),
            AccountMeta::new_readonly(accounts.bundle_address.key(), false),
            AccountMeta::new(accounts.vault.key(), false),
            AccountMeta::new_readonly(accounts.withdraw_mint.key(), false),
            AccountMeta::new(accounts.bundle_withdraw_token_account.key(), false),
            AccountMeta::new(accounts.used_request.key(), false),
            AccountMeta::new_readonly(accounts.ix_sysvar.key(), false),
            AccountMeta::new_readonly(accounts.gateway_minter_program.key(), false),
            AccountMeta::new_readonly(accounts.gateway_minter.key(), false),
            AccountMeta::new(accounts.gateway_minter_custody.key(), false),
            AccountMeta::new(accounts.used_transfer_spec_hash.key(), false),
            AccountMeta::new_readonly(accounts.gateway_minter_event_authority.key(), false),
            AccountMeta::new_readonly(accounts.withdraw_token_program.key(), false),
            AccountMeta::new_readonly(accounts.system_program.key(), false),
            AccountMeta::new_readonly(accounts.router_authority.key(), true),
        ],
        data,
    };

    let infos = [
        accounts.relay_gateway_depository.to_account_info(),
        accounts.executor.to_account_info(),
        accounts.bundle_address.to_account_info(),
        accounts.vault.to_account_info(),
        accounts.withdraw_mint.to_account_info(),
        accounts.bundle_withdraw_token_account.to_account_info(),
        accounts.used_request.to_account_info(),
        accounts.ix_sysvar.to_account_info(),
        accounts.gateway_minter_program.to_account_info(),
        accounts.gateway_minter.to_account_info(),
        accounts.gateway_minter_custody.to_account_info(),
        accounts.used_transfer_spec_hash.to_account_info(),
        accounts.gateway_minter_event_authority.to_account_info(),
        accounts.withdraw_token_program.to_account_info(),
        accounts.system_program.to_account_info(),
        accounts.router_authority.to_account_info(),
        accounts.depository_program.to_account_info(),
    ];

    invoke_signed(
        &ix,
        &infos,
        &[&[DEPOSITORY_CALLER_SEED, &[router_authority_bump]]],
    )
    .map_err(Into::into)
}

/// Reads the balance of a token account owned by a token program
fn token_amount(account: &AccountInfo) -> Result<u64> {
    let data = account.try_borrow_data()?;
    let token_account = TokenAccount::try_deserialize(&mut &data[..])?;
    require!(
        [anchor_spl::token::ID, anchor_spl::token_2022::ID].contains(account.owner),
        CustomError::InvalidTokenAccount
    );
    Ok(token_account.amount)
}

fn transfer_from_bundle<'info>(
    accounts: &Settle<'info>,
    to: AccountInfo<'info>,
    lamports: u64,
    seeds: &[&[u8]],
) -> Result<()> {
    transfer(
        CpiContext::new_with_signer(
            accounts.system_program.key(),
            Transfer {
                from: accounts.bundle_address.to_account_info(),
                to,
            },
            &[seeds],
        ),
        lamports,
    )
}

/// Closes a bundle token account into the bundle address and returns its rent to the executor
fn close_to_executor<'info>(
    accounts: &Settle<'info>,
    account: &InterfaceAccount<'info, TokenAccount>,
    token_program: &Interface<'info, TokenInterface>,
    seeds: &[&[u8]],
) -> Result<()> {
    let info = account.to_account_info();
    // Read live: a transfer earlier in `settle` also moved a native account's lamports
    let native_amount = if account.is_native() {
        token_amount(&info)?
    } else {
        0
    };
    let rent = info
        .lamports()
        .checked_sub(native_amount)
        .ok_or(CustomError::InvalidTokenAccount)?;
    close_account(CpiContext::new_with_signer(
        token_program.key(),
        CloseAccount {
            account: account.to_account_info(),
            destination: accounts.bundle_address.to_account_info(),
            authority: accounts.bundle_address.to_account_info(),
        },
        &[seeds],
    ))?;
    transfer_from_bundle(accounts, accounts.executor.to_account_info(), rent, seeds)
}

/// Checks that a token account is the owner's associated token account
fn associated_token_account<'a, 'info>(
    account: &'a Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    owner: &Pubkey,
    mint: &Pubkey,
    token_program: &Interface<'info, TokenInterface>,
) -> Result<&'a InterfaceAccount<'info, TokenAccount>> {
    let account = account.as_deref().ok_or(CustomError::InvalidTokenAccount)?;
    require_keys_eq!(
        account.key(),
        get_associated_token_address_with_program_id(owner, mint, &token_program.key()),
        CustomError::InvalidTokenAccount
    );
    // An SPL Token account can be handed to another owner and keep its address
    require_keys_eq!(account.owner, *owner, CustomError::InvalidTokenAccount);
    Ok(account)
}

/// Checks the mint and the recipient's associated token account for a payment from the bundle
fn recipient_token_account<'a, 'info>(
    mint: &'a Option<Box<InterfaceAccount<'info, Mint>>>,
    account: &'a Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    expected_mint: &Pubkey,
    recipient: &Pubkey,
    token_program: &Interface<'info, TokenInterface>,
) -> Result<(
    &'a InterfaceAccount<'info, Mint>,
    &'a InterfaceAccount<'info, TokenAccount>,
)> {
    let mint = mint.as_deref().ok_or(CustomError::InvalidMint)?;
    require_keys_eq!(mint.key(), *expected_mint, CustomError::InvalidMint);
    let account = associated_token_account(account, recipient, expected_mint, token_program)?;
    Ok((mint, account))
}

fn transfer_checked_from_bundle<'info>(
    accounts: &Settle<'info>,
    from: &InterfaceAccount<'info, TokenAccount>,
    to: &InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>,
    token_program: &Interface<'info, TokenInterface>,
    amount: u64,
    seeds: &[&[u8]],
) -> Result<()> {
    transfer_checked(
        CpiContext::new_with_signer(
            token_program.key(),
            TransferChecked {
                mint: mint.to_account_info(),
                from: from.to_account_info(),
                to: to.to_account_info(),
                authority: accounts.bundle_address.to_account_info(),
            },
            &[seeds],
        ),
        amount,
        mint.decimals,
    )
}

/// Pays the whole fill to the recipient and returns the amount it received
fn pay_fill<'info>(accounts: &Settle<'info>, bundle: &Bundle, seeds: &[&[u8]]) -> Result<u64> {
    let bundle_address = accounts.bundle_address.key();
    let recipient = accounts.recipient.to_account_info();

    let token_program = accounts
        .fill_token_program
        .as_ref()
        .ok_or(CustomError::InvalidTokenAccount)?;
    let fill_account = associated_token_account(
        &accounts.bundle_fill_token_account,
        &bundle_address,
        &bundle.fill_mint,
        token_program,
    )?;
    let amount = fill_account.amount;

    let received = if bundle.is_native_fill() {
        // After the close, so the rent refund is not counted when the recipient is the executor
        close_to_executor(accounts, fill_account, token_program, seeds)?;
        let before = recipient.lamports();
        transfer_from_bundle(accounts, recipient.clone(), amount, seeds)?;
        recipient.lamports() - before
    } else {
        let (mint, recipient_account) = recipient_token_account(
            &accounts.fill_mint,
            &accounts.recipient_fill_token_account,
            &bundle.fill_mint,
            &bundle.recipient,
            token_program,
        )?;

        let before = recipient_account.amount;
        transfer_checked_from_bundle(
            accounts,
            fill_account,
            recipient_account,
            mint,
            token_program,
            amount,
            seeds,
        )?;
        close_to_executor(accounts, fill_account, token_program, seeds)?;

        let data = recipient_account
            .to_account_info()
            .try_borrow_data()?
            .to_vec();
        TokenAccount::try_deserialize(&mut &data[..])?
            .amount
            .checked_sub(before)
            .ok_or(CustomError::InsufficientFill)?
    };

    require!(
        received >= bundle.minimum_amount,
        CustomError::InsufficientFill
    );
    Ok(received)
}

/// Returns the unspent withdrawn funds to the recipient and closes the account the executor was delegated
///
/// For a token withdrawal the whole balance goes to the recipient's token account when it is
/// passed; without it the delegation must be spent, and tokens left in the account stay there.
fn return_unspent<'info>(
    accounts: &Settle<'info>,
    bundle: &Bundle,
    seeds: &[&[u8]],
) -> Result<u64> {
    let token_program = accounts
        .withdraw_token_program
        .as_ref()
        .ok_or(CustomError::InvalidTokenAccount)?;
    let withdraw_account = associated_token_account(
        &accounts.bundle_withdraw_token_account,
        &accounts.bundle_address.key(),
        &bundle.withdraw_currency(),
        token_program,
    )?;

    let unspent = match bundle.withdraw_mint {
        // Unspent WSOL is unwrapped and paid with the leftover lamports
        None => {
            let unspent = withdraw_account.amount;
            close_to_executor(accounts, withdraw_account, token_program, seeds)?;
            unspent
        }
        Some(withdraw_mint) => {
            let delegated = if withdraw_account.delegate == COption::Some(bundle.executor) {
                withdraw_account
                    .delegated_amount
                    .min(withdraw_account.amount)
            } else {
                0
            };
            let unspent = if accounts.recipient_withdraw_token_account.is_some() {
                withdraw_account.amount
            } else {
                require!(delegated == 0, CustomError::InvalidTokenAccount);
                0
            };
            if unspent > 0 {
                let (mint, recipient_account) = recipient_token_account(
                    &accounts.withdraw_mint,
                    &accounts.recipient_withdraw_token_account,
                    &withdraw_mint,
                    &bundle.recipient,
                    token_program,
                )?;
                transfer_checked_from_bundle(
                    accounts,
                    withdraw_account,
                    recipient_account,
                    mint,
                    token_program,
                    unspent,
                    seeds,
                )?;
            }
            if withdraw_account.amount == unspent {
                close_to_executor(accounts, withdraw_account, token_program, seeds)?;
            } else {
                revoke(CpiContext::new_with_signer(
                    token_program.key(),
                    Revoke {
                        source: withdraw_account.to_account_info(),
                        authority: accounts.bundle_address.to_account_info(),
                    },
                    &[seeds],
                ))?;
            }
            unspent
        }
    };
    Ok(unspent)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn execute_transfer_routed_discriminator() {
        assert_eq!(
            EXECUTE_TRANSFER_ROUTED_DISCRIMINATOR,
            hash(b"global:execute_transfer_routed").to_bytes()[..8]
        );
    }

    // Shared vector with the SDK and the oracle: a bundle without calls
    #[test]
    fn bundle_matches_sdk_vector() {
        let bundle = Bundle {
            version: 1,
            order_id: [0x0a; 32],
            execution_id: hex_bytes(
                "261c17c292d6bcbde6ae5e230a85a554a501fc5364909bf864b733d8e0383734",
            )
            .try_into()
            .unwrap(),
            executor: pubkey!("F7p3dFrjRTbtRp8FRF6qHLomXbKRBzpvBLjtQcfcgmNe"),
            depository: pubkey!("99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2"),
            withdraw_mint: Some(pubkey!("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")),
            minimum_withdraw_amount: 1_000_000,
            fill_mint: native_mint::ID,
            recipient: pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
            minimum_amount: 5_000_000,
            call_accounts: vec![],
            calls: vec![],
        };
        let mut bytes = Vec::new();
        bundle.serialize(&mut bytes).unwrap();
        assert_eq!(bytes, hex_bytes("010a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a261c17c292d6bcbde6ae5e230a85a554a501fc5364909bf864b733d8e0383734d1c24bcb2cf2f78791a8e63d2e528be4e923944900af6d8826f0063e91d1515f792689378ecd51d80406eb0caa3b62795beb10b6c5dc96bc2e0df03cbfee1abf01c6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d6140420f0000000000069b8857feab8184fb687f634618c035dac439dc1aeb3b5598a0f0000000000106ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9404b4c00000000000000000000000000"));

        let bundle_hash = bundle.get_hash();
        assert_eq!(
            bundle_hash.to_vec(),
            hex_bytes("8b6e8059654b31b7c1483ef9e5ad1d474222778558e790f45d83c4cacfe042b5")
        );
        let (address, bump) =
            Pubkey::find_program_address(&[BUNDLE_SEED, &bundle_hash], &crate::ID);
        assert_eq!(
            address,
            pubkey!("859QPdV9yayCRTfk8g6G8RPWm7Y5Vw8iSZQnz2LfxfQQ")
        );
        assert_eq!(bump, 252);
    }

    fn hex_bytes(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }
}
