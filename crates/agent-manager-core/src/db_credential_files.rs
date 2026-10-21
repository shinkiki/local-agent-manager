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
    // libpq처럼 줄 끝의 개행만 떼고 공백은 남긴다 — 공백으로 끝나는 비밀번호도 값이다.
    for line in raw.lines() {
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((patterns, password)) = split_pgpass_line(line) else {
            continue;
        };
        let port = port.to_string();
        let values = [host, port.as_str(), database, user];
        if patterns
            .iter()
            .zip(values)
            .all(|(pattern, value)| pattern.matches(value))
        {
            return Ok(Some(password));
        }
    }
    Ok(None)
}

/// `pgpass` 줄의 앞 네 칸 하나. libpq처럼 이스케이프되지 않은 `*` 한 글자만 와일드카드다 —
/// `\*`는 글자 그대로의 별표다.
enum PgpassPattern {
    Any,
    Exact(String),
}

impl PgpassPattern {
    fn matches(&self, value: &str) -> bool {
        match self {
            Self::Any => true,
            Self::Exact(expected) => expected == value,
        }
    }
}

/// `pgpass` 한 줄을 libpq 규칙대로 나눈다. 칸 안의 `:`·`\`는 `\`로 이스케이프되고
/// (PostgreSQL 문서 "The Password File"). 다섯째 칸은 libpq `passwordFromFile`과 같이
/// 이스케이프되지 않은 `:` 또는 줄 끝까지다.
///
/// `splitn(5, ':')`로 나누던 동안에는 비밀번호의 `\:`가 백슬래시째 남아 틀린 값을 서버에
/// 보냈고, 앞 칸에 이스케이프가 있는 줄은 어떤 접속에도 맞지 않았다.
fn split_pgpass_line(line: &str) -> Option<([PgpassPattern; 4], Zeroizing<String>)> {
    let mut chars = line.chars();
    let mut patterns = Vec::with_capacity(4);
    while patterns.len() < 4 {
        let mut field = String::new();
        let mut escaped_any = false;
        loop {
            match chars.next()? {
                ':' => break,
                '\\' => {
                    field.push(chars.next()?);
                    escaped_any = true;
                }
                other => field.push(other),
            }
        }
        patterns.push(if field == "*" && !escaped_any {
            PgpassPattern::Any
        } else {
            PgpassPattern::Exact(field)
        });
    }
    // 미리 줄 길이만큼 잡아 둔다 — 자라며 재할당되면 앞 버퍼가 지워지지 않은 채 풀린다(G4).
    let mut password = Zeroizing::new(String::with_capacity(line.len()));
    // libpq는 비밀번호도 이스케이프되지 않은 `:`에서 끊고, 뒤에 글자가 없는 `\\`는 그대로 둔다.
    while let Some(next) = chars.next() {
        match next {
            ':' => break,
            '\\' => password.push(chars.next().unwrap_or('\\')),
            other => password.push(other),
        }
    }
    let patterns: [PgpassPattern; 4] = patterns.try_into().ok()?;
    Some((patterns, password))
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

    #[test]
    fn c10_5_pgpass_unescapes_colons_and_backslashes_like_libpq() {
        let dir = TempDir::new().expect("temp");
        let path = dir.path().join(".pgpass");
        std::fs::write(
            &path,
            "db\\:1:5432:*:app:pa\\:ss\\\\w:rd\nother:5432:\\*:app:literal\n\
             h:5432:d:u:end\\\n  h:5432:d:sp:x\nh:5432:d:sp:  spaced \\ \na\\:b:5432:d:u\n",
        )
        .expect("write");
        let found = read_pgpass_password(&path, "db:1", 5432, "x", "app").expect("read");
        assert_eq!(found.as_deref().map(String::as_str), Some("pa:ss\\w"));
        // 이스케이프한 별표는 와일드카드가 아니다.
        let star = read_pgpass_password(&path, "other", 5432, "x", "app").expect("read");
        assert!(star.is_none());
        let literal = read_pgpass_password(&path, "other", 5432, "*", "app").expect("read");
        assert_eq!(literal.as_deref().map(String::as_str), Some("literal"));
        // 뒤에 글자가 없는 백슬래시는 그대로 남는다.
        let trailing = read_pgpass_password(&path, "h", 5432, "d", "u").expect("read");
        assert_eq!(trailing.as_deref().map(String::as_str), Some("end\\"));
        // 앞 공백이 붙은 줄은 호스트가 달라 맞지 않고, 비밀번호의 공백은 깎지 않는다.
        let spaced = read_pgpass_password(&path, "h", 5432, "d", "sp").expect("read");
        assert_eq!(spaced.as_deref().map(String::as_str), Some("  spaced  "));
        // 이스케이프를 풀면 네 칸뿐인 줄은 건너뛴다.
        let short = read_pgpass_password(&path, "a:b", 5432, "d", "u").expect("read");
        assert!(short.is_none());
    }
}
