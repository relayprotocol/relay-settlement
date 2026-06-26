use alloy_primitives::B256;
use byteorder::BigEndian;
use pythnet_sdk::accumulators::merkle::MerkleRoot;
use pythnet_sdk::hashers::keccak256_160::Keccak160;
use pythnet_sdk::messages::Message;
use pythnet_sdk::wire::from_slice;
use pythnet_sdk::wire::v1::{AccumulatorUpdateData, Proof, WormholeMessage, WormholePayload};

const VAA_VERSION: u8 = 1;
const VAA_HEADER_BS: usize = 6;
const VAA_SIGNATURE_BS: usize = 66;
const VAA_BODY_HEADER_BS: usize = 51;

#[derive(Debug, thiserror::Error)]
pub enum VerificationError {
    #[error("malformed accumulator update: {0}")]
    Accumulator(String),
    #[error("unsupported proof type")]
    UnsupportedProof,
    #[error("malformed wormhole vaa: {0}")]
    Vaa(String),
    #[error("unsupported wormhole vaa version {0}")]
    VaaVersion(u8),
    #[error("malformed wormhole message: {0}")]
    WormholeMessage(String),
    #[error("unsupported wormhole payload")]
    UnsupportedPayload,
    #[error("merkle proof verification failed")]
    MerkleProof,
    #[error("malformed price feed message: {0}")]
    PriceMessage(String),
    #[error("requested feed {0} not present in update")]
    FeedNotPresent(B256),
}

pub fn verify(feed: B256, blob: &[u8]) -> Result<(), VerificationError> {
    let update = AccumulatorUpdateData::try_from_slice(blob)
        .map_err(|e| VerificationError::Accumulator(format!("{e:?}")))?;

    let (vaa, updates) = match update.proof {
        Proof::WormholeMerkle { vaa, updates } => (vaa, updates),
        #[allow(unreachable_patterns)]
        _ => return Err(VerificationError::UnsupportedProof),
    };

    let root = extract_merkle_root(&Vec::from(vaa))?;

    let mut found = false;
    for price_update in updates {
        let message = Vec::from(price_update.message);
        if !root.check(price_update.proof, &message) {
            return Err(VerificationError::MerkleProof);
        }
        let decoded = from_slice::<BigEndian, Message>(&message)
            .map_err(|e| VerificationError::PriceMessage(format!("{e:?}")))?;
        if let Message::PriceFeedMessage(price) = decoded
            && price.feed_id == feed.0
        {
            found = true;
        }
    }

    if found {
        Ok(())
    } else {
        Err(VerificationError::FeedNotPresent(feed))
    }
}

fn extract_merkle_root(vaa: &[u8]) -> Result<MerkleRoot<Keccak160>, VerificationError> {
    if vaa.len() < VAA_HEADER_BS {
        return Err(VerificationError::Vaa("truncated header".to_string()));
    }
    if vaa[0] != VAA_VERSION {
        return Err(VerificationError::VaaVersion(vaa[0]));
    }
    let num_signatures = vaa[5] as usize;
    let payload_offset = VAA_HEADER_BS + num_signatures * VAA_SIGNATURE_BS + VAA_BODY_HEADER_BS;
    if vaa.len() < payload_offset {
        return Err(VerificationError::Vaa("truncated body".to_string()));
    }

    let message = WormholeMessage::try_from_bytes(&vaa[payload_offset..])
        .map_err(|e| VerificationError::WormholeMessage(format!("{e:?}")))?;
    match message.payload {
        WormholePayload::Merkle(root) => Ok(MerkleRoot::new(root.root)),
        #[allow(unreachable_patterns)]
        _ => Err(VerificationError::UnsupportedPayload),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ETH_USD_UPDATE: &str = include_str!("testdata/eth_usd_update.hex");

    fn eth_usd_feed() -> B256 {
        "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace"
            .parse()
            .unwrap()
    }

    fn blob() -> Vec<u8> {
        hex::decode(ETH_USD_UPDATE.trim()).unwrap()
    }

    #[test]
    fn verifies_real_hermes_update() {
        verify(eth_usd_feed(), &blob()).unwrap();
    }

    #[test]
    fn rejects_unrequested_feed() {
        assert!(matches!(
            verify(B256::repeat_byte(0x11), &blob()),
            Err(VerificationError::FeedNotPresent(_))
        ));
    }

    #[test]
    fn rejects_tampered_proof() {
        let mut bytes = blob();
        let last = bytes.len() - 1;
        bytes[last] ^= 0xff;
        assert!(matches!(
            verify(eth_usd_feed(), &bytes),
            Err(VerificationError::MerkleProof)
        ));
    }

    #[test]
    fn rejects_garbage() {
        assert!(matches!(
            verify(eth_usd_feed(), b"not a pyth accumulator update"),
            Err(VerificationError::Accumulator(_))
        ));
    }
}
