//! C10-5: 사용자 소유 클라이언트 자격증명 파일(`~/.mylogin.cnf`·`~/.pgpass`) 해석.
//!
//! 연결 레코드를 다루는 [`crate::db_connections`]와는 결이 다른 일이다. 여기 있는 것은
//! 앱이 만들지도 고치지도 않는 **남의 파일 포맷을 읽는 코드**다 — MySQL 클라이언트의
//! 난독화 규칙과 PostgreSQL의 `pgpass` 줄 형식. 연결 등록·검증·저장소 잠금과 한 파일에
//! 섞여 있으면 "연결 저장소를 고치러 왔다가 AES 블록 해독을 읽는" 일이 생기고, 반대로
//! 포맷을 손볼 때도 저장소 쪽 상수와 잠금을 함께 지나가야 했다.
//!
//! 어느 경로든 읽은 값은 [`Zeroizing`]으로 감싸 돌려주고 앱 안에 사본을 만들지 않는다(G1).

use std::path::{Path, PathBuf};

use zeroize::Zeroizing;

use crate::db_connections::DbConnectionView;
use crate::user_home::home_dir;
use crate::CoreError;

/// 클라이언트 자격증명 파일의 자리. 엔진은 두 갈래가 아니라 세 갈래다 — MySQL 계열은
/// `~/.mylogin.cnf`, PostgreSQL은 `~/.pgpass`, 파일 엔진은 자격증명 자체가 없어 없음이다.
pub(crate) fn client_credential_path(connection: &DbConnectionView) -> Option<PathBuf> {
    if connection.engine.is_file_based() {
        return None;
    }
    let home = home_dir().ok()?;
    Some(if connection.engine.uses_mysql_driver() {
        home.join(".mylogin.cnf")
    } else {
        home.join(".pgpass")
    })
}

/// `~/.mylogin.cnf`의 한 로그인 경로에서 비밀번호를 읽는다.
///
/// 이 파일은 **암호화가 아니라 난독화**다 — 고정 규칙으로 접은 AES-128-ECB 키가 파일
/// 머리에 그대로 들어 있다. 그래서 읽는 쪽이 특별한 권한을 갖는 것이 아니고, 같은 사용자
/// 권한으로 열 수 있는 값을 접속 순간에만 메모리로 가져오는 것이다(G1/G4).
pub(crate) fn read_mylogin_password(
    path: &Path,
    login_path: &str,
) -> Result<Option<Zeroizing<String>>, CoreError> {
    let Some(document) = decode_mylogin(path)? else {
        return Ok(None);
    };
    Ok(mylogin_field(&document, login_path, "password").map(Zeroizing::new))
}

/// 난독화를 풀어 INI 본문을 돌려준다. 파일이 없으면 `None`이다.
fn decode_mylogin(path: &Path) -> Result<Option<Zeroizing<String>>, CoreError> {
    use aes::cipher::generic_array::GenericArray;
    use aes::cipher::{BlockDecrypt, KeyInit};

    if !path.is_file() {
        return Ok(None);
    }
    let raw = std::fs::read(path)?;
    if raw.len() < 24 {
        return Err(CoreError::InvalidInput(format!(
            "{} 형식을 해석할 수 없습니다",
            path.display()
        )));
    }
    // 앞 4바이트는 예약, 그다음 20바이트가 키 원본이다.
    let mut key = [0u8; 16];
    for (index, byte) in raw[4..24].iter().enumerate() {
        key[index % 16] ^= byte;
    }
    let cipher = aes::Aes128::new(GenericArray::from_slice(&key));
    let mut plain = Vec::new();
    let mut cursor = 24;
    while cursor + 4 <= raw.len() {
        let length = u32::from_le_bytes([
            raw[cursor],
            raw[cursor + 1],
            raw[cursor + 2],
            raw[cursor + 3],
        ]) as usize;
        cursor += 4;
        if length == 0 || !length.is_multiple_of(16) || cursor + length > raw.len() {
            break;
        }
        let mut chunk = raw[cursor..cursor + length].to_vec();
        cursor += length;
        for block in chunk.chunks_mut(16) {
            cipher.decrypt_block(GenericArray::from_mut_slice(block));
        }
        // PKCS#7 패딩을 떼어 낸다. 값이 범위를 벗어나면 이 덩이는 버린다.
        if let Some(padding) = chunk.last().copied() {
            if padding as usize <= 16 && padding as usize <= chunk.len() {
                chunk.truncate(chunk.len() - padding as usize);
            }
        }
        plain.extend_from_slice(&chunk);
    }
    let text = String::from_utf8_lossy(&plain).into_owned();
    Ok(Some(Zeroizing::new(text)))
}

/// 해독한 INI에서 한 구역의 값 하나를 읽는다.
fn mylogin_field(document: &str, section: &str, field: &str) -> Option<String> {
    let mut current = String::new();
    for line in document.lines() {
        let line = line.trim();
        if line.starts_with('[') && line.ends_with(']') {
            current = line[1..line.len() - 1].trim().to_owned();
            continue;
        }
        if current != section {
            continue;
        }
        let Some((name, value)) = line.split_once('=') else {
            continue;
        };
        if name.trim() != field {
            continue;
        }
        let value = value.trim();
        let value = value
            .strip_prefix('"')
            .and_then(|value| value.strip_suffix('"'))
            .unwrap_or(value);
        return Some(value.to_owned());
    }
    None
}

/// `~/.pgpass`에서 이 접속에 맞는 줄의 비밀번호를 읽는다. 형식은
/// `host:port:database:user:password`이고 `*`는 어느 값에나 맞는다.
pub(crate) fn read_pgpass_password(
    path: &Path,
    host: &str,
    port: u16,
    database: &str,
    user: &str,
) -> Result<Option<Zeroizing<String>>, CoreError> {
    if !path.is_file() {
        return Ok(None);
    }
    let raw = Zeroizing::new(std::fs::read_to_string(path)?);
    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let fields = line.splitn(5, ':').collect::<Vec<_>>();
        if fields.len() != 5 {
            continue;
        }
        let matches = |pattern: &str, value: &str| pattern == "*" || pattern == value;
        if matches(fields[0], host)
            && matches(fields[1], &port.to_string())
            && matches(fields[2], database)
            && matches(fields[3], user)
        {
            return Ok(Some(Zeroizing::new(fields[4].to_owned())));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn c10_5_mylogin_sections_are_read_without_exposing_other_fields() {
        let document = "[client]\nuser = shared\n[kbfps-dev]\nuser = uhrms\npassword = \"pw\"\nhost = 10.0.0.1\n";
        assert_eq!(
            mylogin_field(document, "kbfps-dev", "password").as_deref(),
            Some("pw")
        );
        assert_eq!(
            mylogin_field(document, "kbfps-dev", "user").as_deref(),
            Some("uhrms")
        );
        assert_eq!(mylogin_field(document, "missing", "password"), None);
    }

    #[test]
    fn c10_5_pgpass_matches_wildcards_and_skips_comments() {
        let dir = TempDir::new().expect("temp");
        let path = dir.path().join(".pgpass");
        std::fs::write(&path, "# comment\nhost:5432:*:app:secret\n").expect("write");
        let found = read_pgpass_password(&path, "host", 5432, "anything", "app").expect("read");
        assert_eq!(found.as_deref().map(String::as_str), Some("secret"));
        let missing = read_pgpass_password(&path, "host", 5432, "anything", "other").expect("read");
        assert!(missing.is_none());
    }
}
