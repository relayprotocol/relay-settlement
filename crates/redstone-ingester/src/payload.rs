use alloy_primitives::{Address, B256, U256, keccak256};
use k256::ecdsa::{RecoveryId, Signature, VerifyingKey};

const TIMESTAMP_BS: usize = 6;
const DATA_POINTS_COUNT_BS: usize = 3;
const DATA_POINT_VALUE_BYTE_SIZE_BS: usize = 4;
const DEFAULT_NUM_VALUE_BS: usize = 32;
const DATA_PACKAGES_COUNT_BS: usize = 2;
const UNSIGNED_METADATA_BYTE_SIZE_BS: usize = 3;
const SIGNATURE_BS: usize = 65;
const DATA_FEED_ID_BS: usize = 32;
const DEFAULT_NUM_VALUE_DECIMALS: u32 = 8;
const REDSTONE_MARKER: [u8; 9] = [0x00, 0x00, 0x02, 0xed, 0x57, 0x01, 0x1e, 0x00, 0x00];

#[derive(Debug, thiserror::Error)]
pub enum PayloadError {
    #[error("value {0:?} is not a non-negative decimal number")]
    InvalidValue(String),
    #[error("value {0:?} overflows a 32-byte integer")]
    ValueOverflow(String),
    #[error("signature must be {SIGNATURE_BS} bytes, got {0}")]
    SignatureLength(usize),
    #[error("signature recovery id {0} is out of range")]
    RecoveryId(u8),
    #[error("failed to recover signer: {0}")]
    Recover(String),
}

pub fn feed_id_from_symbol(symbol: &str) -> Result<B256, PayloadError> {
    let bytes = symbol.as_bytes();
    if bytes.len() > DATA_FEED_ID_BS - 1 {
        return Ok(keccak256(bytes));
    }
    let mut id = [0u8; DATA_FEED_ID_BS];
    id[..bytes.len()].copy_from_slice(bytes);
    Ok(B256::from(id))
}

pub fn scale_value(raw: &str) -> Result<U256, PayloadError> {
    let decimals = DEFAULT_NUM_VALUE_DECIMALS as usize;
    let raw = raw.trim();
    let invalid = || PayloadError::InvalidValue(raw.to_string());

    if raw.is_empty() || !raw.bytes().all(|b| b.is_ascii_digit() || b == b'.') {
        return Err(invalid());
    }

    let (int_part, frac_part) = match raw.split_once('.') {
        Some((i, f)) => (i, f),
        None => (raw, ""),
    };
    if int_part.is_empty() && frac_part.is_empty() {
        return Err(invalid());
    }

    let mut scaled_frac = String::with_capacity(decimals);
    let mut frac_iter = frac_part.bytes();
    for _ in 0..decimals {
        scaled_frac.push(frac_iter.next().map(|b| b as char).unwrap_or('0'));
    }
    let round_up = matches!(frac_iter.next(), Some(d) if d >= b'5');

    let digits = format!("{int_part}{scaled_frac}");
    let trimmed = digits.trim_start_matches('0');
    let mut value = if trimmed.is_empty() {
        U256::ZERO
    } else {
        U256::from_str_radix(trimmed, 10)
            .map_err(|_| PayloadError::ValueOverflow(raw.to_string()))?
    };
    if round_up {
        value = value
            .checked_add(U256::from(1))
            .ok_or_else(|| PayloadError::ValueOverflow(raw.to_string()))?;
    }
    Ok(value)
}

pub fn serialize_data_point(feed_id: B256, value: U256) -> Vec<u8> {
    let mut out = Vec::with_capacity(DATA_FEED_ID_BS + DEFAULT_NUM_VALUE_BS);
    out.extend_from_slice(feed_id.as_slice());
    out.extend_from_slice(&value.to_be_bytes::<DEFAULT_NUM_VALUE_BS>());
    out
}

pub fn serialize_signable(
    data_points: &[u8],
    data_point_count: usize,
    timestamp_ms: u64,
) -> Vec<u8> {
    let mut out = Vec::with_capacity(
        data_points.len() + TIMESTAMP_BS + DATA_POINT_VALUE_BYTE_SIZE_BS + DATA_POINTS_COUNT_BS,
    );
    out.extend_from_slice(data_points);
    push_uint_be(&mut out, timestamp_ms, TIMESTAMP_BS);
    push_uint_be(
        &mut out,
        DEFAULT_NUM_VALUE_BS as u64,
        DATA_POINT_VALUE_BYTE_SIZE_BS,
    );
    push_uint_be(&mut out, data_point_count as u64, DATA_POINTS_COUNT_BS);
    out
}

pub fn recover_signer(signable: &[u8], signature: &[u8]) -> Result<Address, PayloadError> {
    if signature.len() != SIGNATURE_BS {
        return Err(PayloadError::SignatureLength(signature.len()));
    }
    let digest = keccak256(signable);
    let recovery_byte = signature[64];
    let recovery_id = match recovery_byte {
        27 | 28 => recovery_byte - 27,
        0 | 1 => recovery_byte,
        other => return Err(PayloadError::RecoveryId(other)),
    };
    let sig = Signature::from_slice(&signature[..64])
        .map_err(|e| PayloadError::Recover(e.to_string()))?;
    let recovery_id =
        RecoveryId::from_byte(recovery_id).ok_or(PayloadError::RecoveryId(recovery_byte))?;
    let verifying_key = VerifyingKey::recover_from_prehash(digest.as_slice(), &sig, recovery_id)
        .map_err(|e| PayloadError::Recover(e.to_string()))?;
    let point = verifying_key.to_encoded_point(false);
    let hash = keccak256(&point.as_bytes()[1..]);
    Ok(Address::from_slice(&hash[12..]))
}

pub fn assemble_payload(packages: &[Vec<u8>]) -> Vec<u8> {
    let body: usize = packages.iter().map(Vec::len).sum();
    let mut out = Vec::with_capacity(
        body + DATA_PACKAGES_COUNT_BS + UNSIGNED_METADATA_BYTE_SIZE_BS + REDSTONE_MARKER.len(),
    );
    for package in packages {
        out.extend_from_slice(package);
    }
    push_uint_be(&mut out, packages.len() as u64, DATA_PACKAGES_COUNT_BS);
    push_uint_be(&mut out, 0, UNSIGNED_METADATA_BYTE_SIZE_BS);
    out.extend_from_slice(&REDSTONE_MARKER);
    out
}

fn push_uint_be(out: &mut Vec<u8>, value: u64, bytes: usize) {
    let be = value.to_be_bytes();
    out.extend_from_slice(&be[be.len() - bytes..]);
}

#[cfg(test)]
mod tests {
    use super::*;
    use k256::ecdsa::SigningKey;

    #[test]
    fn feed_id_right_pads_short_symbols() {
        let id = feed_id_from_symbol("ETH").unwrap();
        assert_eq!(&id.as_slice()[..3], b"ETH");
        assert!(id.as_slice()[3..].iter().all(|b| *b == 0));
    }

    #[test]
    fn scale_value_pads_and_rounds() {
        assert_eq!(scale_value("1.147").unwrap(), U256::from(114_700_000u64));
        assert_eq!(scale_value("3120").unwrap(), U256::from(312_000_000_000u64));
        assert_eq!(scale_value("0.000000005").unwrap(), U256::from(1u64));
        assert_eq!(scale_value("0.000000004").unwrap(), U256::ZERO);
        assert_eq!(scale_value("0").unwrap(), U256::ZERO);
    }

    #[test]
    fn scale_value_rejects_non_decimal() {
        assert!(scale_value("-1").is_err());
        assert!(scale_value("1e3").is_err());
        assert!(scale_value("abc").is_err());
        assert!(scale_value("").is_err());
    }

    #[test]
    fn data_point_layout() {
        let point = serialize_data_point(
            feed_id_from_symbol("ETH").unwrap(),
            U256::from(114_700_000u64),
        );
        assert_eq!(point.len(), 64);
        assert_eq!(&point[..3], b"ETH");
        assert_eq!(
            U256::from_be_slice(&point[32..]),
            U256::from(114_700_000u64)
        );
    }

    #[test]
    fn signable_layout_field_sizes() {
        let point = serialize_data_point(feed_id_from_symbol("ETH").unwrap(), U256::from(1u64));
        let signable = serialize_signable(&point, 1, 1_700_000_000_000);
        assert_eq!(signable.len(), 64 + 6 + 4 + 3);
        let value_byte_size = &signable[64 + 6..64 + 6 + 4];
        assert_eq!(u32::from_be_bytes(value_byte_size.try_into().unwrap()), 32);
        let count = &signable[64 + 6 + 4..];
        assert_eq!(count, &[0, 0, 1]);
    }

    #[test]
    fn payload_ends_with_marker_and_counts() {
        let package = vec![0xaa; 142];
        let payload = assemble_payload(std::slice::from_ref(&package));
        assert_eq!(&payload[payload.len() - 9..], &REDSTONE_MARKER);
        let metadata_size = &payload[payload.len() - 12..payload.len() - 9];
        assert_eq!(metadata_size, &[0, 0, 0]);
        let packages_count = &payload[payload.len() - 14..payload.len() - 12];
        assert_eq!(packages_count, &[0, 1]);
        assert_eq!(&payload[..142], package.as_slice());
    }

    #[test]
    fn recover_signer_matches_signing_key() {
        let signing_key = SigningKey::from_slice(&[0x11u8; 32]).unwrap();
        let point = serialize_data_point(feed_id_from_symbol("BTC").unwrap(), U256::from(42u64));
        let signable = serialize_signable(&point, 1, 1_700_000_000_000);
        let digest = keccak256(&signable);

        let (sig, recid) = signing_key
            .sign_prehash_recoverable(digest.as_slice())
            .unwrap();
        let mut signature = sig.to_bytes().to_vec();
        signature.push(27 + recid.to_byte());

        let expected = {
            let vk = signing_key.verifying_key();
            let p = vk.to_encoded_point(false);
            Address::from_slice(&keccak256(&p.as_bytes()[1..])[12..])
        };
        assert_eq!(recover_signer(&signable, &signature).unwrap(), expected);
    }

    #[test]
    fn recover_signer_rejects_bad_length() {
        assert!(matches!(
            recover_signer(b"x", &[0u8; 10]),
            Err(PayloadError::SignatureLength(10))
        ));
    }
}
