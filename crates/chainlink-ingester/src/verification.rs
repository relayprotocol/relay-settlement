use alloy_primitives::B256;
use chainlink_data_streams_report::report::decode_full_report;
use chainlink_data_streams_report::report::v3::ReportDataV3;
use num_bigint::Sign;

const V3_SCHEMA: u16 = 0x0003;
const MAX_TIMESTAMP_AHEAD: u64 = 60;

#[derive(Debug, thiserror::Error)]
pub enum VerificationError {
    #[error("malformed full report: {0}")]
    Decode(String),
    #[error("unsupported report schema 0x{0:04x}")]
    UnsupportedSchema(u16),
    #[error("report feed {got} does not match requested feed {expected}")]
    FeedMismatch { expected: B256, got: B256 },
    #[error(
        "incoherent timestamps: validFrom={valid_from} observations={observations} expiresAt={expires_at}"
    )]
    IncoherentTimestamps {
        valid_from: u32,
        observations: u32,
        expires_at: u32,
    },
    #[error("report expired at {expires_at}, now {now}")]
    Expired { expires_at: u32, now: u64 },
    #[error("report observed at {observations} is too far ahead of now {now}")]
    FutureDated { observations: u32, now: u64 },
    #[error(
        "report observed at {observations} is older than the {max_age}s freshness window, now {now}"
    )]
    Stale {
        observations: u32,
        now: u64,
        max_age: u64,
    },
    #[error("benchmark price is not positive")]
    NonPositivePrice,
    #[error("benchmark price is outside the bid/ask band")]
    InvalidBand,
}

fn report_version(feed: &B256) -> u16 {
    u16::from_be_bytes([feed.0[0], feed.0[1]])
}

pub fn verify(
    feed: B256,
    full_report: &[u8],
    now: u64,
    max_age_sec: u64,
) -> Result<(), VerificationError> {
    let schema = report_version(&feed);
    if schema != V3_SCHEMA {
        return Err(VerificationError::UnsupportedSchema(schema));
    }

    let (_context, report_blob) =
        decode_full_report(full_report).map_err(|e| VerificationError::Decode(format!("{e:?}")))?;
    let report = ReportDataV3::decode(&report_blob)
        .map_err(|e| VerificationError::Decode(format!("{e:?}")))?;

    let got = B256::from(report.feed_id.0);
    if got != feed {
        return Err(VerificationError::FeedMismatch {
            expected: feed,
            got,
        });
    }

    let valid_from = report.valid_from_timestamp;
    let observations = report.observations_timestamp;
    let expires_at = report.expires_at;
    if !(valid_from <= observations && observations <= expires_at) {
        return Err(VerificationError::IncoherentTimestamps {
            valid_from,
            observations,
            expires_at,
        });
    }
    if now > u64::from(expires_at) {
        return Err(VerificationError::Expired { expires_at, now });
    }
    if u64::from(observations) > now + MAX_TIMESTAMP_AHEAD {
        return Err(VerificationError::FutureDated { observations, now });
    }
    if now.saturating_sub(u64::from(observations)) > max_age_sec {
        return Err(VerificationError::Stale {
            observations,
            now,
            max_age: max_age_sec,
        });
    }

    if report.benchmark_price.sign() != Sign::Plus {
        return Err(VerificationError::NonPositivePrice);
    }
    if report.bid > report.benchmark_price || report.benchmark_price > report.ask {
        return Err(VerificationError::InvalidBand);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy_primitives::aliases::{I192, U192};
    use alloy_sol_types::{SolValue, sol};

    const NOW: u64 = 1_000_000;
    const MAX_AGE: u64 = 300;

    sol! {
        struct FullReport {
            bytes32[3] reportContext;
            bytes reportData;
            bytes32[] rawRs;
            bytes32[] rawSs;
            bytes32 rawVs;
        }

        struct ReportV3 {
            bytes32 feedId;
            uint32 validFromTimestamp;
            uint32 observationsTimestamp;
            uint192 nativeFee;
            uint192 linkFee;
            uint32 expiresAt;
            int192 price;
            int192 bid;
            int192 ask;
        }
    }

    fn feed(schema: u16, suffix: u8) -> B256 {
        let mut bytes = [0u8; 32];
        bytes[..2].copy_from_slice(&schema.to_be_bytes());
        bytes[31] = suffix;
        B256::from(bytes)
    }

    fn v3_feed(suffix: u8) -> B256 {
        feed(V3_SCHEMA, suffix)
    }

    struct Report {
        feed_id: B256,
        valid_from: u32,
        observations: u32,
        expires_at: u32,
        price: i128,
        bid: i128,
        ask: i128,
    }

    impl Report {
        fn valid(feed_id: B256) -> Self {
            let now = NOW as u32;
            Self {
                feed_id,
                valid_from: now - 100,
                observations: now - 50,
                expires_at: now + 100,
                price: 100,
                bid: 90,
                ask: 110,
            }
        }

        fn encode(&self) -> Vec<u8> {
            let report = ReportV3 {
                feedId: self.feed_id,
                validFromTimestamp: self.valid_from,
                observationsTimestamp: self.observations,
                nativeFee: U192::ZERO,
                linkFee: U192::ZERO,
                expiresAt: self.expires_at,
                price: I192::try_from(self.price).unwrap(),
                bid: I192::try_from(self.bid).unwrap(),
                ask: I192::try_from(self.ask).unwrap(),
            };
            let full = FullReport {
                reportContext: [B256::ZERO; 3],
                reportData: report.abi_encode_params().into(),
                rawRs: Vec::new(),
                rawSs: Vec::new(),
                rawVs: B256::ZERO,
            };
            full.abi_encode_params()
        }
    }

    fn verify_valid(feed_id: B256, report: &Report) -> Result<(), VerificationError> {
        verify(feed_id, &report.encode(), NOW, MAX_AGE)
    }

    #[test]
    fn verifies_well_formed_report() {
        let feed_id = v3_feed(0x01);
        verify_valid(feed_id, &Report::valid(feed_id)).unwrap();
    }

    #[test]
    fn rejects_unsupported_schema() {
        let feed_id = feed(0x0008, 0x01);
        assert!(matches!(
            verify_valid(feed_id, &Report::valid(feed_id)),
            Err(VerificationError::UnsupportedSchema(0x0008))
        ));
    }

    #[test]
    fn rejects_garbage() {
        assert!(matches!(
            verify(v3_feed(0x01), b"not a chainlink report", NOW, MAX_AGE),
            Err(VerificationError::Decode(_))
        ));
    }

    #[test]
    fn rejects_mismatched_feed() {
        let report = Report::valid(v3_feed(0x02));
        assert!(matches!(
            verify_valid(v3_feed(0x01), &report),
            Err(VerificationError::FeedMismatch { .. })
        ));
    }

    #[test]
    fn rejects_incoherent_timestamps() {
        let feed_id = v3_feed(0x01);
        let mut report = Report::valid(feed_id);
        report.valid_from = report.observations + 1;
        assert!(matches!(
            verify_valid(feed_id, &report),
            Err(VerificationError::IncoherentTimestamps { .. })
        ));
    }

    #[test]
    fn rejects_expired_report() {
        let feed_id = v3_feed(0x01);
        let mut report = Report::valid(feed_id);
        report.expires_at = NOW as u32 - 1;
        assert!(matches!(
            verify_valid(feed_id, &report),
            Err(VerificationError::Expired { .. })
        ));
    }

    #[test]
    fn rejects_future_dated_report() {
        let feed_id = v3_feed(0x01);
        let mut report = Report::valid(feed_id);
        report.observations = NOW as u32 + MAX_TIMESTAMP_AHEAD as u32 + 10;
        assert!(matches!(
            verify_valid(feed_id, &report),
            Err(VerificationError::FutureDated { .. })
        ));
    }

    #[test]
    fn rejects_stale_report() {
        let feed_id = v3_feed(0x01);
        assert!(matches!(
            verify(feed_id, &Report::valid(feed_id).encode(), NOW, 30),
            Err(VerificationError::Stale { .. })
        ));
    }

    #[test]
    fn rejects_non_positive_price() {
        let feed_id = v3_feed(0x01);
        let mut report = Report::valid(feed_id);
        report.price = 0;
        assert!(matches!(
            verify_valid(feed_id, &report),
            Err(VerificationError::NonPositivePrice)
        ));
    }

    #[test]
    fn rejects_inverted_band() {
        let feed_id = v3_feed(0x01);
        let mut report = Report::valid(feed_id);
        report.bid = report.price + 1;
        assert!(matches!(
            verify_valid(feed_id, &report),
            Err(VerificationError::InvalidBand)
        ));
    }
}
