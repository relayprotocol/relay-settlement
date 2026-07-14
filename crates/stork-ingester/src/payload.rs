pub const SIGNATURE_BYTES: usize = 65;
pub const TAXONOMY_ID_BYTES: usize = 2;
pub const TIMESTAMP_NS_BYTES: usize = 8;
pub const ASSET_ID_BYTES: usize = 2;
pub const QUANTIZED_VALUE_BYTES: usize = 16;
pub const ASSET_BYTES: usize = ASSET_ID_BYTES + QUANTIZED_VALUE_BYTES;

pub const TAXONOMY_ID_OFFSET: usize = SIGNATURE_BYTES;
pub const TIMESTAMP_NS_OFFSET: usize = TAXONOMY_ID_OFFSET + TAXONOMY_ID_BYTES;
pub const ASSETS_OFFSET: usize = TIMESTAMP_NS_OFFSET + TIMESTAMP_NS_BYTES;

#[derive(Debug, thiserror::Error)]
pub enum PayloadError {
    #[error("invalid hex payload: {0}")]
    Hex(String),
    #[error("payload too short: {len} bytes, need at least {min}")]
    TooShort { len: usize, min: usize },
    #[error("payload body is not a whole number of {ASSET_BYTES}-byte assets: {trailing} trailing")]
    Misaligned { trailing: usize },
    #[error("payload declares no assets")]
    NoAssets,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssetValue {
    pub asset_id: u16,
    pub quantized_value: i128,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FastPayload {
    pub raw: Vec<u8>,
    pub taxonomy_id: u16,
    pub timestamp_ns: u64,
    pub assets: Vec<AssetValue>,
}

impl FastPayload {
    pub fn from_hex(raw: &str) -> Result<Self, PayloadError> {
        let bytes = hex::decode(raw.strip_prefix("0x").unwrap_or(raw))
            .map_err(|e| PayloadError::Hex(e.to_string()))?;
        Self::from_bytes(bytes)
    }

    pub fn from_bytes(bytes: Vec<u8>) -> Result<Self, PayloadError> {
        if bytes.len() < ASSETS_OFFSET {
            return Err(PayloadError::TooShort {
                len: bytes.len(),
                min: ASSETS_OFFSET,
            });
        }
        let body = bytes.len() - ASSETS_OFFSET;
        if !body.is_multiple_of(ASSET_BYTES) {
            return Err(PayloadError::Misaligned {
                trailing: body % ASSET_BYTES,
            });
        }
        if body == 0 {
            return Err(PayloadError::NoAssets);
        }

        let taxonomy_id =
            u16::from_be_bytes([bytes[TAXONOMY_ID_OFFSET], bytes[TAXONOMY_ID_OFFSET + 1]]);
        let timestamp_ns = u64::from_be_bytes(
            bytes[TIMESTAMP_NS_OFFSET..ASSETS_OFFSET]
                .try_into()
                .expect("8-byte timestamp"),
        );

        let mut assets = Vec::with_capacity(body / ASSET_BYTES);
        let mut i = ASSETS_OFFSET;
        while i < bytes.len() {
            let asset_id = u16::from_be_bytes([bytes[i], bytes[i + 1]]);
            let value_bytes: [u8; QUANTIZED_VALUE_BYTES] = bytes
                [i + ASSET_ID_BYTES..i + ASSET_BYTES]
                .try_into()
                .expect("16-byte value");
            assets.push(AssetValue {
                asset_id,
                quantized_value: i128::from_be_bytes(value_bytes),
            });
            i += ASSET_BYTES;
        }

        Ok(Self {
            raw: bytes,
            taxonomy_id,
            timestamp_ns,
            assets,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_PAYLOAD: &str = "0x435766eac9298f4dcbfe8bdfe46361161d6eeca88f783e3cd215db90c0581cd1511382180840e70bfd43e5382aa4e4c2910aca251ee2c3a5e27d5343fb105556010001187d265fe630404b000100000000000000000de029bae7734fef000200000000000000000ddffc432d25cd5c000a0000000000000000b02db33d2f95811c0022000000000000009480fc8e62b51ff1ac";

    #[test]
    fn parses_doc_payload() {
        let p = FastPayload::from_hex(TEST_PAYLOAD).unwrap();
        assert_eq!(p.taxonomy_id, 1);
        assert_eq!(p.timestamp_ns, 0x187d265fe630404b);
        assert_eq!(p.assets.len(), 4);
        assert_eq!(p.assets[0].asset_id, 1);
        assert_eq!(p.assets[1].asset_id, 2);
        assert_eq!(p.assets[2].asset_id, 10);
        assert_eq!(p.assets[3].asset_id, 34);
    }

    #[test]
    fn rejects_short_and_misaligned() {
        assert!(matches!(
            FastPayload::from_bytes(vec![0u8; 10]),
            Err(PayloadError::TooShort { .. })
        ));
        assert!(matches!(
            FastPayload::from_bytes(vec![0u8; ASSETS_OFFSET]),
            Err(PayloadError::NoAssets)
        ));
        assert!(matches!(
            FastPayload::from_bytes(vec![0u8; ASSETS_OFFSET + 1]),
            Err(PayloadError::Misaligned { .. })
        ));
    }

    #[test]
    fn rejects_bad_hex() {
        assert!(matches!(
            FastPayload::from_hex("0xnothex"),
            Err(PayloadError::Hex(_))
        ));
    }
}
