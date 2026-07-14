use tracing::debug;

use crate::payload::FastPayload;

const MAX_TIME_AHEAD_SEC: u64 = 60;
const NANOS_PER_MS: u64 = 1_000_000;

#[derive(Debug, thiserror::Error)]
pub enum VerificationError {
    #[error("taxonomy {got} does not match configured taxonomy {expected}")]
    TaxonomyMismatch { expected: u16, got: u16 },
    #[error("update observed at {source_time_ms}ms is too far ahead of now {now_ms}ms")]
    FutureDated { source_time_ms: u64, now_ms: u64 },
    #[error(
        "update observed at {source_time_ms}ms is older than the {max_age_sec}s freshness window, now {now_ms}ms"
    )]
    Stale {
        source_time_ms: u64,
        now_ms: u64,
        max_age_sec: u64,
    },
}

pub fn verify(
    payload: &FastPayload,
    expected_taxonomy: u16,
    now_ms: u64,
    max_age_sec: u64,
) -> Result<(), VerificationError> {
    if payload.taxonomy_id != expected_taxonomy {
        return Err(VerificationError::TaxonomyMismatch {
            expected: expected_taxonomy,
            got: payload.taxonomy_id,
        });
    }

    let source_time_ms = payload.timestamp_ns / NANOS_PER_MS;
    if source_time_ms > now_ms + MAX_TIME_AHEAD_SEC * 1000 {
        return Err(VerificationError::FutureDated {
            source_time_ms,
            now_ms,
        });
    }
    if now_ms.saturating_sub(source_time_ms) > max_age_sec.saturating_mul(1000) {
        return Err(VerificationError::Stale {
            source_time_ms,
            now_ms,
            max_age_sec,
        });
    }

    debug!(
        asset_count = payload.assets.len(),
        taxonomy = payload.taxonomy_id,
        source_time_ms,
        age_ms = now_ms.saturating_sub(source_time_ms),
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
        let now_ms = 1_700_000_000_000u64;
        let p = payload(1, now_ms * NANOS_PER_MS, &[(7, 123_456), (8, -5)]);
        verify(&p, 1, now_ms + 1, 300).unwrap();
    }

    #[test]
    fn rejects_taxonomy_mismatch() {
        let now_ms = 1_700_000_000_000u64;
        let p = payload(1, now_ms * NANOS_PER_MS, &[(7, 123_456)]);
        assert!(matches!(
            verify(&p, 2, now_ms + 1, 300),
            Err(VerificationError::TaxonomyMismatch { .. })
        ));
    }

    #[test]
    fn rejects_stale_and_future() {
        let now_ms = 1_700_000_000_000u64;
        let p = payload(1, now_ms * NANOS_PER_MS, &[(7, 123_456)]);
        assert!(matches!(
            verify(&p, 1, now_ms + 10_000_000, 300),
            Err(VerificationError::Stale { .. })
        ));
        assert!(matches!(
            verify(&p, 1, now_ms - 100_000, 300),
            Err(VerificationError::FutureDated { .. })
        ));
    }

    #[test]
    fn preserves_sub_second_freshness() {
        let now_ms = 1_700_000_000_500u64;
        let p = payload(1, now_ms * NANOS_PER_MS, &[(7, 123_456)]);
        verify(&p, 1, now_ms + 400, 1).unwrap();
        assert!(matches!(
            verify(&p, 1, now_ms + 1_001, 1),
            Err(VerificationError::Stale { .. })
        ));
    }
}
