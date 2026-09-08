//! 앱 전체가 쓰는 "사용자 홈"의 단일 정의.
//!
//! `~/.claude`·`~/.codex` 같은 공급자 홈, 셸의 시작 디렉터리, `~` 펼치기, 읽기·쓰기
//! 금지 경계 계산이 모두 사용자 홈에서 출발한다. 그런데 `catalog`·`providers`·
//! `account_tools`·`store`·`terminal`·`user_path`·`accounts`·`cli_updates`가 같은 세 줄을
//! 각자 적어 두었고, 그 사이에 두 갈래가 섞여 있었다.
//!
//! - `HOME`을 먼저 보고 없으면 `USERPROFILE`로 넘어가는 사본
//! - `cfg!(windows)`로 갈라 한쪽 변수만 보는 사본
//!
//! 실제 플랫폼에서는 두 갈래가 같은 값을 내지만, 홈을 못 찾았을 때의 처리가 사본마다
//! 달랐다(어떤 곳은 `HomeDirectoryUnavailable`, 어떤 곳은 조용한 빈 결과). 어느 쪽을
//! 골라야 하는지는 호출부의 성격이 정하는 것이지 모듈이 정할 일이 아니므로, 홈을 읽는
//! 방법은 여기 하나로 두고 없을 때의 처리만 두 함수로 갈라 놓는다.
//!
//! 읽는 변수는 홈 해석에 필요한 `HOME`·`USERPROFILE` 두 개뿐이다(G8).

use std::env;
use std::path::PathBuf;

use crate::CoreError;

/// 사용자 홈을 읽는다. 값이 없거나 빈 문자열이면 `None`.
///
/// 홈이 없어도 조회 자체는 성공해야 하는 호출부(도구 목록, 금지 경계 계산)가 쓴다.
pub(crate) fn optional_home_dir() -> Option<PathBuf> {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
}

/// 사용자 홈을 읽고, 없으면 `HomeDirectoryUnavailable`로 실패한다.
///
/// 홈 없이는 결과가 성립하지 않는 호출부(공급자 홈 경로 조립, 셸 시작 디렉터리,
/// `~` 펼치기)가 쓴다.
pub(crate) fn home_dir() -> Result<PathBuf, CoreError> {
    optional_home_dir().ok_or(CoreError::HomeDirectoryUnavailable)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 두 함수는 같은 값을 봐야 한다. 한쪽만 변수를 더 보게 되면 홈이 있는데도 실패하는
    /// 경로가 생긴다.
    #[test]
    fn both_readers_agree_on_the_resolved_home() {
        match optional_home_dir() {
            Some(home) => assert_eq!(home_dir().expect("home must resolve"), home),
            None => assert!(matches!(
                home_dir(),
                Err(CoreError::HomeDirectoryUnavailable)
            )),
        }
    }

    /// 테스트 환경에는 홈이 있으므로 절대 경로가 나와야 한다. 상대 경로가 나오면 이
    /// 값으로 조립한 공급자 홈이 작업 디렉터리에 따라 달라진다.
    #[test]
    fn the_resolved_home_is_absolute() {
        let home = home_dir().expect("test environment must have a home");
        assert!(home.is_absolute(), "{}", home.display());
    }
}
