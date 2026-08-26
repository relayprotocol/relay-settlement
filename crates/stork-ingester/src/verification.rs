use std::collections::HashSet;

use tracing::debug;

use crate::cache::NANOS_PER_MILLISECOND;
use crate::payload::FastPayload;

const MAX_FUTURE_SECONDS: u64 = 6;
const NANOS_PER_SECOND: u64 = 1_000_000_000;

#[derive(Debug, thiserror::Error)]
pub enum VerificationError {
    #[error("taxonomy {got} does not match configured taxonomy {expected}")]
    TaxonomyMismatch { expected: u16, got: u16 },
    #[error("asset id {asset_id} appears more than once in the payload")]
    DuplicateAssetId { asset_id: u16 },
    #[error("update observed at {source_time_ns}ns is too far ahead of now {now_ns}ns")]
    FutureDated { source_time_ns: u64, now_ns: u64 },
    #[error(
        "update observed at {source_time_ns}ns is older than the {max_age_sec}s freshness window, now {now_ns}ns"
    )]
    Stale {
        source_time_ns: u64,
        now_ns: u64,
        max_age_sec: u64,
    },
}

pub fn verify(
    payload: &FastPayload,
    expected_taxonomy: u16,
    now_ns: u64,
    max_age_sec: u64,
) -> Result<(), VerificationError> {
    if payload.taxonomy_id != expected_taxonomy {
        return Err(VerificationError::TaxonomyMismatch {
            expected: expected_taxonomy,
            got: payload.taxonomy_id,
        });
    }

    let mut asset_ids = HashSet::with_capacity(payload.assets.len());
    for asset in &payload.assets {
        if !asset_ids.insert(asset.asset_id) {
            return Err(VerificationError::DuplicateAssetId {
                asset_id: asset.asset_id,
            });
        }
    }

    let max_future_ns = MAX_FUTURE_SECONDS * NANOS_PER_SECOND;
    if payload.timestamp_ns > now_ns.saturating_add(max_future_ns) {
        return Err(VerificationError::FutureDated {
            source_time_ns: payload.timestamp_ns,
            now_ns,
        });
    }
    if now_ns.saturating_sub(payload.timestamp_ns) > max_age_sec.saturating_mul(NANOS_PER_SECOND) {
        return Err(VerificationError::Stale {
            source_time_ns: payload.timestamp_ns,
            now_ns,
            max_age_sec,
        });
    }

    debug!(
        asset_count = payload.assets.len(),
        taxonomy = payload.taxonomy_id,
        source_time_ms = payload.timestamp_ns / NANOS_PER_MILLISECOND,
        age_ms = now_ns.saturating_sub(payload.timestamp_ns) / NANOS_PER_MILLISECOND,
        "fast batch validated (structure + freshness ok)"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload(taxonomy: u16, timestamp_ns: u64, assets: &[(u16, i128)]) -> FastPayload {
        let mut raw = vec![0u8; 65];
        raw.extend_from_slice(&taxonomy.to_be_bytes());
        raw.extend_from_slice(&timestamp_ns.to_be_bytes());
        for (asset_id, value) in assets {
            raw.extend_from_slice(&asset_id.to_be_bytes());
            raw.extend_from_slice(&value.to_be_bytes());
        }
        FastPayload::from_bytes(raw).unwrap()
    }

    #[test]
    fn accepts_well_formed_batch() {
        let now_ns = 1_700_000_000_000_000_000u64;
        let p = payload(1, now_ns, &[(7, 123_456), (8, -5)]);
        verify(&p, 1, now_ns + 1, 300).unwrap();
    }

    #[test]
    fn rejects_taxonomy_mismatch() {
        let now_ns = 1_700_000_000_000_000_000u64;
        let p = payload(1, now_ns, &[(7, 123_456)]);
        assert!(matches!(
            verify(&p, 2, now_ns + 1, 300),
            Err(VerificationError::TaxonomyMismatch { .. })
        ));
    }

    #[test]
    fn rejects_stale_payload() {
        let now_ns = 1_700_000_000_000_000_000u64;
        let p = payload(1, now_ns, &[(7, 123_456)]);
        assert!(matches!(
            verify(&p, 1, now_ns + 301 * NANOS_PER_SECOND, 300),
            Err(VerificationError::Stale { .. })
        ));
    }

    #[test]
    fn enforces_six_second_future_limit() {
        let now_ns = 1_700_000_000_000_000_000u64;
        let boundary = payload(
            1,
            now_ns + MAX_FUTURE_SECONDS * NANOS_PER_SECOND,
            &[(7, 123_456)],
        );
        let over_limit = payload(
            1,
            now_ns + MAX_FUTURE_SECONDS * NANOS_PER_SECOND + 1,
            &[(7, 123_456)],
        );

        verify(&boundary, 1, now_ns, 300).unwrap();
        assert!(matches!(
            verify(&over_limit, 1, now_ns, 300),
            Err(VerificationError::FutureDated { .. })
        ));
    }

    #[test]
    fn preserves_sub_second_freshness() {
        let source_ns = 1_700_000_000_500_000_000u64;
        let p = payload(1, source_ns, &[(7, 123_456)]);
        verify(&p, 1, source_ns + 999_999_999, 1).unwrap();
        assert!(matches!(
            verify(&p, 1, source_ns + NANOS_PER_SECOND + 1, 1),
            Err(VerificationError::Stale { .. })
        ));
    }

    #[test]
    fn rejects_duplicate_asset_ids() {
        let now_ns = 1_700_000_000_000_000_000u64;
        let p = payload(1, now_ns, &[(7, 123_456), (7, 123_456)]);

        assert!(matches!(
            verify(&p, 1, now_ns, 300),
            Err(VerificationError::DuplicateAssetId { asset_id: 7 })
        ));
    }
}
