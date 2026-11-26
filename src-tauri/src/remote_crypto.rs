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

/// Parowanie kodem (bez QR): X25519 między telefonem a komputerem. Z sekretu wyliczamy klucz urządzenia i 6-cyfrowy
/// kod pokazywany na obu ekranach; użytkownik porównuje kody, więc nikt pośrodku nie podmieni kluczy niezauważony.
/// Ten sam algorytm jest w src/lib/remote-crypto.ts (nearDerive). Wektor wspólny: tests/remote-near.hex.
pub fn near_derive(shared: &[u8], cs: &[u8], cc: &[u8], pk_phone: &[u8], pk_pc: &[u8]) -> ([u8; 32], String) {
    let k = hmac::Key::new(hmac::HMAC_SHA512, shared);
    let msg = |label: &[u8]| { let mut m = label.to_vec(); for p in [cs, cc, pk_phone, pk_pc] { m.extend_from_slice(p); } m };
    let key_tag = hmac::sign(&k, &msg(b"hermitty-near-key"));
    let sas_tag = hmac::sign(&k, &msg(b"hermitty-near-sas"));
    let mut key = [0u8; 32];
    key.copy_from_slice(&key_tag.as_ref()[..32]);
    let n = u32::from_be_bytes(sas_tag.as_ref()[..4].try_into().unwrap()) % 1_000_000;
    (key, format!("{n:06}"))
}

/// Strona komputera: klucz efemeryczny, wspólny sekret z kluczem telefonu, klucz urządzenia i kod.
/// Zwraca (klucz publiczny komputera, klucz urządzenia, kod).
pub fn near_pc(pk_phone: &[u8], cs: &[u8], cc: &[u8]) -> Result<(Vec<u8>, [u8; 32], String), String> {
    use ring::agreement::{agree_ephemeral, EphemeralPrivateKey, UnparsedPublicKey, X25519};
    if pk_phone.len() != 32 {
        return Err("zły klucz telefonu".into());
    }
    let rng = ring::rand::SystemRandom::new();
    let sk = EphemeralPrivateKey::generate(&X25519, &rng).map_err(|_| "brak losowości".to_string())?;
    let pk = sk.compute_public_key().map_err(|_| "klucz".to_string())?.as_ref().to_vec();
    let (key, sas) = agree_ephemeral(sk, &UnparsedPublicKey::new(&X25519, pk_phone), |shared| near_derive(shared, cs, cc, pk_phone, &pk))
        .map_err(|_| "nieudana wymiana kluczy".to_string())?;
    Ok((pk, key, sas))
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

    /// Wektor wspólny z telefonem (tests/remote-crypto.test.ts liczy to samo w TS).
    #[test]
    fn near_derive_matches_js() {
        let (key, sas) = near_derive(&[5u8; 32], &[1u8; 16], &[2u8; 16], &[3u8; 32], &[4u8; 32]);
        let want = include_str!("../../tests/remote-near.hex").trim().to_string();
        assert_eq!(format!("{} {}", hex(&key), sas), want);
    }

    #[test]
    fn near_pc_agrees_with_phone_side() {
        use ring::agreement::{agree_ephemeral, EphemeralPrivateKey, UnparsedPublicKey, X25519};
        let rng = ring::rand::SystemRandom::new();
        let phone = EphemeralPrivateKey::generate(&X25519, &rng).unwrap();
        let pk_phone = phone.compute_public_key().unwrap().as_ref().to_vec();
        let (pk_pc, key_pc, sas_pc) = near_pc(&pk_phone, &[1; 16], &[2; 16]).unwrap();
        let (key_ph, sas_ph) = agree_ephemeral(phone, &UnparsedPublicKey::new(&X25519, &pk_pc), |s| near_derive(s, &[1; 16], &[2; 16], &pk_phone, &pk_pc)).unwrap();
        assert_eq!(key_pc, key_ph);
        assert_eq!(sas_pc, sas_ph);
        assert_eq!(sas_pc.len(), 6);
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
