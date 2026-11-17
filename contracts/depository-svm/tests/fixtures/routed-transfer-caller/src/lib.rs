//! Test-only router stand-in: signs as its `depository_caller` PDA and calls the depository at depth 1,
//! or self-invokes first. Data: `depth ‖ depository data`; accounts: self, depository, depository accounts.

use solana_program::{
    account_info::AccountInfo,
    entrypoint,
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
    program_error::ProgramError,
    pubkey::Pubkey,
};

entrypoint!(process_instruction);

fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let (&depth, depository_data) = data
        .split_first()
        .ok_or(ProgramError::InvalidInstructionData)?;
    if depth == 0 || accounts.len() < 2 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let (authority, bump) = Pubkey::find_program_address(&[b"depository_caller"], program_id);
    let metas = |accounts: &[AccountInfo]| -> Vec<AccountMeta> {
        accounts
            .iter()
            .map(|account| AccountMeta {
                pubkey: *account.key,
                is_signer: account.is_signer || *account.key == authority,
                is_writable: account.is_writable,
            })
            .collect()
    };

    let ix = if depth > 1 {
        let mut data = vec![depth - 1];
        data.extend_from_slice(depository_data);
        Instruction {
            program_id: *program_id,
            accounts: metas(accounts),
            data,
        }
    } else {
        Instruction {
            program_id: *accounts[1].key,
            accounts: metas(&accounts[2..]),
            data: depository_data.to_vec(),
        }
    };
    invoke_signed(&ix, accounts, &[&[b"depository_caller", &[bump]]])
}
