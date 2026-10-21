//! C20. 접근 채널 로그인의 OTP — RFC 6238 TOTP(HMAC-SHA1, 6자리, 30초).
//!
//! 순수 함수만 둔다. 시각은 호출자가 넘기므로 시험에서 RFC 부록 벡터를 그대로 돌릴 수 있다.
//! base32는 RFC 4648(패딩 없음)로 손수 구현한다 — 인증 앱이 읽는 수동 키 한 줄에
//! 의존성을 하나 더 들일 이유가 없다.

use hmac::{Hmac, Mac};
use sha1::Sha1;
use subtle::ConstantTimeEq;
use zeroize::Zeroizing;

use crate::CoreError;

pub const TOTP_STEP_SECONDS: u64 = 30;
pub const TOTP_DIGITS: u32 = 6;
/// 서버와 인증 앱의 시계가 어긋나도 받아 주는 폭. ±1 스텝 = ±30초.
pub const TOTP_ALLOWED_SKEW_STEPS: u64 = 1;
/// 새 비밀의 길이. RFC 4226이 권하는 최소 128비트를 넘는 160비트(SHA1 블록 크기).
pub const TOTP_SECRET_BYTES: usize = 20;
pub const TOTP_ISSUER: &str = "Agent Manager";

const BASE32_ALPHABET: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/// `step`번째 30초 창의 코드.
pub fn totp_code(secret: &[u8], step: u64) -> u32 {
    let mut mac = Hmac::<Sha1>::new_from_slice(secret).expect("HMAC accepts any key length");
    mac.update(&step.to_be_bytes());
    let digest = mac.finalize().into_bytes();
    let offset = (digest[digest.len() - 1] & 0x0f) as usize;
    let binary = ((u32::from(digest[offset]) & 0x7f) << 24)
        | (u32::from(digest[offset + 1]) << 16)
        | (u32::from(digest[offset + 2]) << 8)
        | u32::from(digest[offset + 3]);
    binary % 10u32.pow(TOTP_DIGITS)
}

pub fn current_step(now_secs: u64) -> u64 {
    now_secs / TOTP_STEP_SECONDS
}

/// 코드가 지금 창(±허용 폭) 안의 어느 스텝과 맞는지. 맞으면 그 스텝을 돌려주고, 호출자는
/// 그것을 `last_used_step`으로 기록해 같은 코드가 두 번 쓰이지 않게 한다.
///
/// 비교는 상수 시간이고, 창 안의 스텝을 전부 돌아본 뒤에야 답한다 — 어느 스텝에서
/// 맞았는지가 시간으로 새면 안 된다.
pub fn verify_totp(
    secret: &[u8],
    now_secs: u64,
    last_used_step: Option<u64>,
    code: &str,
) -> Option<u64> {
    let code = code.trim();
    if code.len() != TOTP_DIGITS as usize || !code.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let expected = format_code(code.parse::<u32>().ok()?);
    let center = current_step(now_secs);
    let first = center.saturating_sub(TOTP_ALLOWED_SKEW_STEPS);
    let last = center.saturating_add(TOTP_ALLOWED_SKEW_STEPS);
    let mut accepted = None;
    // C20-2: 마지막 사용 스텝이 이미 창 밖이어도 그 코드의 재사용은 거부한다.
    // 첫 인증 때 충돌한 뒤쪽 스텝이 아직 창 밖이면 최신 일치 기록만으로는 부족하다.
    let mut replayed = last_used_step.is_some_and(|step| {
        let used_code = format_code(totp_code(secret, step));
        bool::from(used_code.as_bytes().ct_eq(expected.as_bytes()))
    });
    for step in first..=last {
        let candidate = format_code(totp_code(secret, step));
        let matches = candidate.as_bytes().ct_eq(expected.as_bytes()).into();
        // C20-2: 코드가 여러 스텝에서 같으면 가장 최신 스텝까지 사용한 것으로 기록한다.
        // 첫 일치만 기록하면 창이 이동해 그 스텝이 빠진 뒤 같은 코드가 다시 통과한다.
        if matches {
            replayed |= last_used_step.is_some_and(|used| step <= used);
            accepted = Some(step);
        }
    }
    // 이미 쓴 스텝과 맞으면 더 최신 스텝도 같더라도 재사용이다(C20-2).
    if replayed {
        None
    } else {
        accepted
    }
}

fn format_code(code: u32) -> String {
    format!("{code:0width$}", width = TOTP_DIGITS as usize)
}

pub fn random_secret() -> Zeroizing<Vec<u8>> {
    use rand_core::{OsRng, RngCore};
    let mut bytes = Zeroizing::new(vec![0u8; TOTP_SECRET_BYTES]);
    OsRng.fill_bytes(&mut bytes);
    bytes
}

/// RFC 4648 base32, 패딩 없음. 인증 앱의 "키 직접 입력"이 받는 형식이다.
pub fn base32_encode(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len().div_ceil(5) * 8);
    let mut buffer: u64 = 0;
    let mut bits = 0u32;
    for &byte in bytes {
        buffer = (buffer << 8) | u64::from(byte);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            let index = ((buffer >> bits) & 0x1f) as usize;
            output.push(BASE32_ALPHABET[index] as char);
        }
    }
    if bits > 0 {
        let index = ((buffer << (5 - bits)) & 0x1f) as usize;
        output.push(BASE32_ALPHABET[index] as char);
    }
    output
}

/// 패딩·공백·소문자를 받아 주는 느슨한 디코더. 잘못된 글자가 하나라도 있으면 `None`.
pub fn base32_decode(text: &str) -> Option<Zeroizing<Vec<u8>>> {
    let mut output = Zeroizing::new(Vec::with_capacity(text.len() * 5 / 8));
    let mut buffer: u64 = 0;
    let mut bits = 0u32;
    for byte in text.bytes() {
        if byte == b'=' || byte == b' ' {
            continue;
        }
        let value = BASE32_ALPHABET
            .iter()
            .position(|&candidate| candidate == byte.to_ascii_uppercase())?;
        buffer = (buffer << 5) | value as u64;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            output.push(((buffer >> bits) & 0xff) as u8);
        }
    }
    Some(output)
}

/// 인증 앱이 읽는 등록 주소. 계정 이름과 발급자는 퍼센트 인코딩한다.
pub fn otpauth_url(account: &str, secret_base32: &str) -> String {
    format!(
        "otpauth://totp/{issuer}:{account}?secret={secret}&issuer={issuer}&algorithm=SHA1&digits={digits}&period={period}",
        issuer = percent_encode(TOTP_ISSUER),
        account = percent_encode(account),
        secret = secret_base32,
        digits = TOTP_DIGITS,
        period = TOTP_STEP_SECONDS,
    )
}

fn percent_encode(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            output.push(byte as char);
        } else {
            output.push_str(&format!("%{byte:02X}"));
        }
    }
    output
}

/// 등록 주소를 QR SVG로 그린다. 화면은 이것을 `data:image/svg+xml` `<img>`로 보여 준다.
pub fn qr_svg(data: &str) -> Result<String, CoreError> {
    let code = qrcode::QrCode::new(data.as_bytes())
        .map_err(|error| CoreError::Runtime(format!("QR 코드를 만들지 못했습니다: {error}")))?;
    Ok(code
        .render::<qrcode::render::svg::Color>()
        .min_dimensions(220, 220)
        .quiet_zone(true)
        .build())
}

#[cfg(test)]
mod tests {
    use super::*;

    const RFC_SECRET: &[u8] = b"12345678901234567890";

    /// RFC 6238 부록 B(SHA1)의 8자리 벡터를 6자리로 자른 값.
    #[test]
    fn rfc_6238_appendix_b_vectors_hold_for_sha1() {
        for (time, expected) in [
            (59u64, "287082"),
            (1_111_111_109, "081804"),
            (1_234_567_890, "005924"),
            (2_000_000_000, "279037"),
            (20_000_000_000, "353130"),
        ] {
            assert_eq!(
                format_code(totp_code(RFC_SECRET, current_step(time))),
                expected
            );
        }
    }

    #[test]
    fn accepts_one_step_of_skew_and_rejects_two() {
        let now = 1_234_567_890u64;
        let center = current_step(now);
        let code_at = |step: u64| format_code(totp_code(RFC_SECRET, step));
        assert_eq!(
            verify_totp(RFC_SECRET, now, None, &code_at(center)),
            Some(center)
        );
        assert_eq!(
            verify_totp(RFC_SECRET, now, None, &code_at(center - 1)),
            Some(center - 1)
        );
        assert_eq!(
            verify_totp(RFC_SECRET, now, None, &code_at(center + 1)),
            Some(center + 1)
        );
        assert_eq!(
            verify_totp(RFC_SECRET, now, None, &code_at(center - 2)),
            None
        );
        assert_eq!(
            verify_totp(RFC_SECRET, now, None, &code_at(center + 2)),
            None
        );
    }

    #[test]
    fn a_used_step_cannot_be_replayed() {
        let now = 1_234_567_890u64;
        let center = current_step(now);
        let code = format_code(totp_code(RFC_SECRET, center));
        assert_eq!(verify_totp(RFC_SECRET, now, Some(center), &code), None);
        assert_eq!(
            verify_totp(RFC_SECRET, now, Some(center - 1), &code),
            Some(center)
        );
    }

    #[test]
    fn c20_2_colliding_steps_cannot_replay_the_code_after_the_window_moves() {
        // 공개 RFC 키에서 인접한 두 스텝이 같은 6자리 코드를 만든다.
        let earlier = 910_737;
        let later = earlier + 1;
        let code = "911617";
        assert_eq!(format_code(totp_code(RFC_SECRET, earlier)), code);
        assert_eq!(format_code(totp_code(RFC_SECRET, later)), code);

        let used_before_collision =
            verify_totp(RFC_SECRET, (earlier - 1) * TOTP_STEP_SECONDS, None, code);
        assert_eq!(used_before_collision, Some(earlier));
        assert_eq!(
            verify_totp(
                RFC_SECRET,
                (later + 1) * TOTP_STEP_SECONDS,
                used_before_collision,
                code,
            ),
            None,
            "마지막 사용 스텝이 창 밖으로 나간 뒤에도 같은 코드는 재사용이다",
        );
        for center in [earlier, later] {
            assert_eq!(
                verify_totp(
                    RFC_SECRET,
                    center * TOTP_STEP_SECONDS,
                    used_before_collision,
                    code,
                ),
                None,
                "이미 쓴 코드가 최신 스텝과도 같아도 재사용이다",
            );
            let accepted = verify_totp(RFC_SECRET, center * TOTP_STEP_SECONDS, None, code);
            for replay_center in [center, later + 1] {
                assert_eq!(
                    verify_totp(
                        RFC_SECRET,
                        replay_center * TOTP_STEP_SECONDS,
                        accepted,
                        code,
                    ),
                    None,
                    "코드 충돌도 재사용할 수 없다: {center} -> {replay_center}",
                );
            }
            assert_eq!(accepted, Some(later));
        }
        let next_code = format_code(totp_code(RFC_SECRET, later + 1));
        assert_ne!(next_code, code);
        assert_eq!(
            verify_totp(
                RFC_SECRET,
                (later + 1) * TOTP_STEP_SECONDS,
                Some(later),
                &next_code,
            ),
            Some(later + 1),
        );
    }

    #[test]
    fn malformed_codes_are_rejected_before_any_comparison() {
        for code in ["", "12345", "1234567", "12a456", " 287082x"] {
            assert_eq!(verify_totp(RFC_SECRET, 59, None, code), None, "{code:?}");
        }
        assert_eq!(verify_totp(RFC_SECRET, 59, None, " 287082 "), Some(1));
    }

    #[test]
    fn base32_round_trips_and_matches_rfc_4648() {
        assert_eq!(base32_encode(b""), "");
        assert_eq!(base32_encode(b"f"), "MY");
        assert_eq!(base32_encode(b"fo"), "MZXQ");
        assert_eq!(base32_encode(b"foo"), "MZXW6");
        assert_eq!(base32_encode(b"foob"), "MZXW6YQ");
        assert_eq!(base32_encode(b"fooba"), "MZXW6YTB");
        assert_eq!(base32_encode(b"foobar"), "MZXW6YTBOI");
        let secret = random_secret();
        let decoded = base32_decode(&base32_encode(&secret)).expect("decode");
        assert_eq!(decoded.as_slice(), secret.as_slice());
        assert_eq!(
            base32_decode("mzxw 6ytb oi==").expect("lenient").as_slice(),
            b"foobar"
        );
        assert!(base32_decode("MZXW1").is_none());
    }

    #[test]
    fn otpauth_url_encodes_the_account_and_names_the_issuer() {
        let url = otpauth_url("shin c/2", "MZXW6YTBOI");
        assert_eq!(
            url,
            "otpauth://totp/Agent%20Manager:shin%20c%2F2?secret=MZXW6YTBOI&issuer=Agent%20Manager&algorithm=SHA1&digits=6&period=30"
        );
    }

    #[test]
    fn qr_svg_renders_the_url() {
        let svg = qr_svg(&otpauth_url("user", "MZXW6YTBOI")).expect("svg");
        assert!(svg.starts_with("<?xml") || svg.starts_with("<svg"));
        assert!(svg.contains("</svg>"));
    }
}
