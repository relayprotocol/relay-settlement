use hmac::{Hmac, KeyInit, Mac};
use sha2::{Digest, Sha256};

pub const HEADER_AUTHORIZATION: &str = "Authorization";
pub const HEADER_TIMESTAMP: &str = "X-Authorization-Timestamp";
pub const HEADER_SIGNATURE: &str = "X-Authorization-Signature-SHA256";

#[derive(Clone)]
pub struct Credentials {
    pub api_key: String,
    pub api_secret: String,
}

impl core::fmt::Debug for Credentials {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("Credentials")
            .field("api_key", &self.api_key)
            .field("api_secret", &"<redacted>")
            .finish()
    }
}

#[derive(Debug, Clone)]
pub struct AuthHeaders {
    pub authorization: String,
    pub timestamp: String,
    pub signature: String,
}

impl AuthHeaders {
    pub fn as_pairs(&self) -> [(&'static str, &str); 3] {
        [
            (HEADER_AUTHORIZATION, self.authorization.as_str()),
            (HEADER_TIMESTAMP, self.timestamp.as_str()),
            (HEADER_SIGNATURE, self.signature.as_str()),
        ]
    }
}

impl Credentials {
    pub fn new(api_key: impl Into<String>, api_secret: impl Into<String>) -> Self {
        Self {
            api_key: api_key.into(),
            api_secret: api_secret.into(),
        }
    }

    pub fn sign(&self, method: &str, path: &str, body: &[u8], timestamp_ms: u128) -> AuthHeaders {
        let body_hash = hex::encode(Sha256::digest(body));
        let to_sign = string_to_sign(method, path, &body_hash, &self.api_key, timestamp_ms);

        let mut mac =
            Hmac::<Sha256>::new_from_slice(self.api_secret.as_bytes()).expect("HMAC takes any key");
        mac.update(to_sign.as_bytes());
        let signature = hex::encode(mac.finalize().into_bytes());

        AuthHeaders {
            authorization: self.api_key.clone(),
            timestamp: timestamp_ms.to_string(),
            signature,
        }
    }
}

fn string_to_sign(
    method: &str,
    path: &str,
    body_hash_hex: &str,
    api_key: &str,
    timestamp_ms: u128,
) -> String {
    format!("{method} {path} {body_hash_hex} {api_key} {timestamp_ms}")
}

#[cfg(test)]
mod tests {
    use super::*;

    const EMPTY_SHA256: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

    #[test]
    fn string_to_sign_is_space_joined_in_field_order() {
        let s = string_to_sign(
            "GET",
            "/api/v1/ws?feedIDs=0xabc",
            EMPTY_SHA256,
            "client-id",
            1_700,
        );
        assert_eq!(
            s,
            format!("GET /api/v1/ws?feedIDs=0xabc {EMPTY_SHA256} client-id 1700")
        );
    }

    #[test]
    fn sign_populates_all_three_headers() {
        let creds = Credentials::new("client-id", "secret");
        let headers = creds.sign("GET", "/api/v1/ws", b"", 1_700);
        assert_eq!(headers.authorization, "client-id");
        assert_eq!(headers.timestamp, "1700");
        assert_eq!(headers.signature.len(), 64);
        assert!(headers.signature.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn signature_is_deterministic_and_input_sensitive() {
        let creds = Credentials::new("client-id", "secret");
        let base = creds.sign("GET", "/api/v1/ws", b"", 1_700);
        assert_eq!(
            base.signature,
            creds.sign("GET", "/api/v1/ws", b"", 1_700).signature
        );
        assert_ne!(
            base.signature,
            creds.sign("GET", "/api/v1/ws", b"", 1_701).signature
        );
        assert_ne!(
            base.signature,
            creds.sign("GET", "/api/v1/feeds", b"", 1_700).signature
        );
        let other = Credentials::new("client-id", "other-secret");
        assert_ne!(
            base.signature,
            other.sign("GET", "/api/v1/ws", b"", 1_700).signature
        );
    }

    #[test]
    fn known_hmac_vector() {
        let creds = Credentials::new("client-id", "secret");
        let headers = creds.sign("GET", "/api/v1/ws", b"", 1_700);

        let mut mac = Hmac::<Sha256>::new_from_slice(b"secret").unwrap();
        mac.update(format!("GET /api/v1/ws {EMPTY_SHA256} client-id 1700").as_bytes());
        let expected = hex::encode(mac.finalize().into_bytes());
        assert_eq!(headers.signature, expected);
    }

    #[test]
    fn debug_redacts_secret() {
        let creds = Credentials::new("client-id", "super-secret");
        let rendered = format!("{creds:?}");
        assert!(rendered.contains("client-id"));
        assert!(!rendered.contains("super-secret"));
    }
}
