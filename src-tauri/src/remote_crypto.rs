//! Szyfrowany kanał zdalnego dostępu z przeglądarki telefonu (remote.rs + remote/index.html).
//! Klucz sesji = HMAC-SHA512(klucz urządzenia, etykieta kierunku ‖ wyzwanie komputera ‖ wyzwanie telefonu),
//! pierwsze 32 bajty. Każdy kierunek ma własny klucz i licznik ramek w nonce (XSalsa20-Poly1305),
//! więc nagranej ramki nie da się powtórzyć ani w tej sesji, ani w następnej (inne wyzwania = inne klucze).
//! Ten sam algorytm jest w kliencie JS (tweetnacl: nacl.hash = SHA-512, nacl.secretbox).

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use crypto_secretbox::aead::{Aead, KeyInit};
use crypto_secretbox::{Key, Nonce, XSalsa20Poly1305};
use ring::hmac;

/// Klucz jednego kierunku sesji.
pub fn session_key(base: &[u8; 32], label: &[u8], cs: &[u8], cc: &[u8]) -> [u8; 32] {
    let k = hmac::Key::new(hmac::HMAC_SHA512, base);
    let mut msg = label.to_vec();
    msg.extend_from_slice(cs);
    msg.extend_from_slice(cc);
    let tag = hmac::sign(&k, &msg);
    let mut out = [0u8; 32];
    out.copy_from_slice(&tag.as_ref()[..32]);
    out
}

/// Nonce z licznikiem ramek (big-endian w ostatnich 8 bajtach).
fn nonce(n: u64) -> [u8; 24] {
    let mut b = [0u8; 24];
    b[16..].copy_from_slice(&n.to_be_bytes());
    b
}

/// Jeden kierunek kanału: klucz i licznik ramek. Ramka w sieci to base64 samego szyfrogramu (nonce wynika z licznika).
pub struct Dir {
    cipher: XSalsa20Poly1305,
    n: u64,
}

impl Dir {
    pub fn new(key: &[u8; 32]) -> Self {
        Dir { cipher: XSalsa20Poly1305::new(Key::from_slice(key)), n: 0 }
    }

    pub fn seal(&mut self, plain: &str) -> String {
        let ct = self.cipher.encrypt(Nonce::from_slice(&nonce(self.n)), plain.as_bytes()).unwrap_or_default();
        self.n += 1;
        STANDARD.encode(ct)
    }

    /// Odszyfrowuje ramkę o oczekiwanym numerze. Ramka powtórzona, przestawiona albo podrobiona daje None.
    pub fn open(&mut self, frame: &str) -> Option<String> {
        let raw = STANDARD.decode(frame.trim()).ok()?;
        let pt = self.cipher.decrypt(Nonce::from_slice(&nonce(self.n)), raw.as_slice()).ok()?;
        self.n += 1;
        String::from_utf8(pt).ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }

    /// Wektor wspólny z klientem JS (tests/remote-crypto.test.ts liczy to samo przez tweetnacl).
    #[test]
    fn session_key_matches_js_client() {
        let base = [7u8; 32];
        let (cs, cc) = ([1u8; 16], [2u8; 16]);
        assert_eq!(hex(&session_key(&base, b"c2s", &cs, &cc)), include_str!("../../tests/remote-crypto.c2s.hex").trim());
    }

    #[test]
    fn rejects_replay_and_reorder() {
        let k = session_key(&[9u8; 32], b"c2s", &[3u8; 16], &[4u8; 16]);
        let (mut a, mut b) = (Dir::new(&k), Dir::new(&k));
        let f1 = a.seal("pierwsza");
        let f2 = a.seal("druga");
        // Przestawiona kolejność nie przechodzi i nie przesuwa licznika.
        assert!(b.open(&f2).is_none());
        assert_eq!(b.open(&f1).as_deref(), Some("pierwsza"));
        // Powtórzona ramka ma stary licznik.
        assert!(b.open(&f1).is_none());
        assert_eq!(b.open(&f2).as_deref(), Some("druga"));
    }

    #[test]
    fn new_challenges_give_new_keys() {
        let base = [5u8; 32];
        let old = session_key(&base, b"c2s", &[1u8; 16], &[2u8; 16]);
        let new = session_key(&base, b"c2s", &[8u8; 16], &[2u8; 16]);
        let other_dir = session_key(&base, b"s2c", &[1u8; 16], &[2u8; 16]);
        let recorded = Dir::new(&old).seal(r#"{"t":"auth"}"#);
        // Nagrane uwierzytelnienie z poprzedniej sesji nie otwiera się w nowej.
        assert!(Dir::new(&new).open(&recorded).is_none());
        assert!(Dir::new(&other_dir).open(&recorded).is_none());
    }
}
