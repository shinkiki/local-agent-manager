//! 사용자가 화면에서 직접 입력한 폴더 경로를 해석하는 한 곳.
//!
//! 채팅 작업 경로와 문서 폴더는 각자 `fs::canonicalize`를 바로 불러서, 경로가 없으면
//! `std::io`의 ENOENT가 그대로 `CoreError::Io`("파일 처리 중 오류가 발생했습니다: No such
//! file or directory (os error 2)")로 올라왔다. 화면은 그 문구를 분류하지 못해 APP_RUNTIME
//! 으로 찍었고, 사용자는 "무엇이 잘못됐는지"가 아니라 "앱이 고장났다"는 인상만 받았다.
//! 두 입력이 같은 규칙으로 해석되고 같은 문구로 실패하도록 여기에 모은다.
//!
//! 해석 규칙은 세 가지다. 앞뒤 공백을 버리고(붙여넣기에 섞여 오는 개행 포함), `~`와
//! `~/`만 홈으로 펼치며(공급자 CLI도 셸이 없으면 틸드를 풀지 않으므로 여기서 푼다),
//! 그 뒤에는 절대 경로만 받는다.

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::path_guard;
use crate::user_home;
use crate::CoreError;

/// 없는 폴더를 가리키는 실패에 붙는 고정 접두사.
///
/// 화면은 이 접두사로 실패를 알아보고 "새로운 폴더를 만드시겠습니까?" 확인을 띄운다(C6).
/// 문구를 바꾸면 같은 상수를 들고 있는 `src/lib/missingDirectory.ts`도 함께 바꿔야 한다.
pub const MISSING_DIRECTORY_PREFIX: &str = "경로를 찾을 수 없습니다: ";

/// 사용자 확인 뒤 실제로 만든 폴더. 화면은 이 정규 경로를 그대로 다시 제출한다.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedDirectory {
    pub path: String,
}

/// 입력 문자열을 절대 경로로 만든다. 실재 여부는 보지 않는다.
pub fn normalize_user_path(raw: &str) -> Result<PathBuf, CoreError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(CoreError::InvalidInput("경로를 입력하세요".to_owned()));
    }
    let expanded = expand_home(trimmed)?;
    if !expanded.is_absolute() {
        return Err(CoreError::InvalidInput(format!(
            "절대 경로를 입력하세요: {trimmed}"
        )));
    }
    Ok(expanded)
}

/// 입력 문자열을 실재하는 폴더의 정규 경로로 해석한다.
pub fn resolve_existing_directory(raw: &str) -> Result<PathBuf, CoreError> {
    resolve_existing_directory_path(&normalize_user_path(raw)?)
}

/// 이미 절대 경로로 만들어 둔 값을 실재하는 폴더로 해석한다.
///
/// `fs::canonicalize`의 실패를 그대로 흘리지 않고, 사용자가 고칠 수 있는 세 가지 사실
/// (없다·폴더가 아니다·권한이 없다)로 나눈다. 화면의 오류 분류가 이 문구를 읽는다.
pub fn resolve_existing_directory_path(requested: &Path) -> Result<PathBuf, CoreError> {
    let display = requested.display();
    match fs::canonicalize(requested) {
        Ok(canonical) if canonical.is_dir() => Ok(canonical),
        Ok(_) => Err(CoreError::InvalidInput(format!(
            "폴더가 아닙니다: {display}"
        ))),
        Err(error) if error.kind() == ErrorKind::NotFound => Err(CoreError::NotFound(format!(
            "{MISSING_DIRECTORY_PREFIX}{display}"
        ))),
        Err(error) if error.kind() == ErrorKind::PermissionDenied => Err(CoreError::InvalidInput(
            format!("경로에 접근할 권한이 없습니다: {display}"),
        )),
        Err(error) => Err(CoreError::Io(error)),
    }
}

/// 사용자가 화면에서 만들기를 확인한 폴더 하나를 만든다(C6).
///
/// 만들 수 있는 것은 **이미 있는 폴더 바로 아래 마지막 한 칸**뿐이다. `create_dir_all`로
/// 상위까지 함께 만들면 `/Users/exmaple/Projects/foo` 같은 오타 하나가 조용히 트리를
/// 만들어버려, 사용자가 확인 대화에서 승인한 것과 실제로 생긴 것이 달라진다. 상위가
/// 없으면 그 상위를 문구에 담아 거절하고, 사용자가 경로를 다시 보게 한다.
///
/// 상위는 정규화한 뒤 그 아래에 이름을 붙이므로, 심볼릭 링크로 경계를 넘어 다른 곳에
/// 폴더가 생기지 않는다. 공급자 홈과 Agent Manager 앱 데이터는 문서 루트와 같은 기준
/// (`store::is_restricted_doc_root`)으로 막는다.
pub fn create_user_directory(app_data_dir: &Path, raw: &str) -> Result<PathBuf, CoreError> {
    let requested = normalize_user_path(raw)?;
    if path_guard::has_parent_dir(&requested) {
        return Err(CoreError::InvalidInput(
            "경로에 상위 디렉터리(..)를 쓸 수 없습니다".to_owned(),
        ));
    }
    // 이미 있으면 그대로 쓴다. 확인 대화 뒤의 재시도가 두 번 도착해도 결과가 같다.
    if let Ok(existing) = fs::symlink_metadata(&requested) {
        if !existing.file_type().is_dir() {
            return Err(CoreError::Conflict(format!(
                "그 자리에 폴더가 아닌 항목이 이미 있습니다: {}",
                requested.display()
            )));
        }
        return resolve_existing_directory_path(&requested);
    }
    let (parent, name) = requested
        .parent()
        .zip(requested.file_name())
        .ok_or_else(|| CoreError::InvalidInput("최상위 경로는 만들 수 없습니다".to_owned()))?;
    let target = resolve_existing_directory_path(parent)?.join(name);
    if crate::store::is_restricted_doc_root(app_data_dir, &target) {
        return Err(CoreError::InvalidInput(
            "공급자 인증 저장소 또는 Agent Manager 앱 데이터와 겹치는 폴더는 만들 수 없습니다"
                .to_owned(),
        ));
    }
    fs::create_dir(&target)?;
    Ok(target)
}

fn expand_home(trimmed: &str) -> Result<PathBuf, CoreError> {
    let rest = match trimmed.strip_prefix('~') {
        Some("") => "",
        Some(rest) if rest.starts_with('/') || (cfg!(windows) && rest.starts_with('\\')) => {
            &rest[1..]
        }
        // `~other`는 다른 사용자의 홈을 뜻하는 셸 문법이라 여기서 풀지 않는다.
        _ => return Ok(PathBuf::from(trimmed)),
    };
    let home = user_home::home_dir()?;
    Ok(if rest.is_empty() {
        home
    } else {
        home.join(rest)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_directory_is_reported_with_the_shared_prefix_and_the_path() {
        let temp = tempfile::tempdir().expect("temp directory must exist");
        let absent = temp.path().join("absent");
        let error = resolve_existing_directory(&absent.to_string_lossy()).expect_err("missing");
        let message = error.to_string();
        assert!(
            message.starts_with(MISSING_DIRECTORY_PREFIX),
            "화면이 접두사로 알아본다: {message}"
        );
        assert!(message.contains("absent"), "{message}");
        assert!(matches!(error, CoreError::NotFound(_)));
    }

    /// 화면은 이 접두사 하나로 "폴더를 만들까요?" 확인을 띄운다. 한쪽만 고치면 확인이
    /// 조용히 사라지고 사용자는 다시 원인 없는 오류만 보게 되므로, 두 정의를 묶어 둔다.
    #[test]
    fn the_frontend_shares_the_same_missing_directory_prefix() {
        let source = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../src/lib/missingDirectory.ts")
            .canonicalize()
            .expect("frontend helper must exist");
        let text = fs::read_to_string(source).expect("frontend helper must be readable");
        assert!(
            text.contains(&format!(
                "export const MISSING_DIRECTORY_PREFIX = \"{MISSING_DIRECTORY_PREFIX}\";"
            )),
            "src/lib/missingDirectory.ts의 접두사가 Rust와 다릅니다"
        );
    }

    #[test]
    fn surrounding_whitespace_and_a_leading_tilde_are_resolved() {
        let temp = tempfile::tempdir().expect("temp directory must exist");
        let nested = temp.path().join("nested");
        fs::create_dir(&nested).expect("nested directory");
        let padded = format!("  {}\n", nested.to_string_lossy());
        assert_eq!(
            resolve_existing_directory(&padded).expect("padded path"),
            fs::canonicalize(&nested).expect("canonical nested")
        );

        let home = user_home::home_dir().expect("home directory");
        assert_eq!(
            normalize_user_path("~/gsProjects").expect("tilde path"),
            home.join("gsProjects")
        );
        assert_eq!(normalize_user_path("~").expect("bare tilde"), home);
        // `~other`는 다른 사용자의 홈을 뜻하는 셸 문법이라 펼치지 않는다. 펼치지 않은
        // 값은 절대 경로가 아니므로 "절대 경로를 입력하세요"로 끝난다.
        assert!(matches!(
            normalize_user_path("~other/x").expect_err("other user"),
            CoreError::InvalidInput(_)
        ));
    }

    #[test]
    fn a_relative_or_empty_path_is_rejected_before_the_filesystem_is_touched() {
        assert!(matches!(
            normalize_user_path("   ").expect_err("empty"),
            CoreError::InvalidInput(_)
        ));
        assert!(matches!(
            normalize_user_path("gsProjects/foo").expect_err("relative"),
            CoreError::InvalidInput(_)
        ));
    }

    #[test]
    fn a_file_on_the_path_is_reported_as_not_a_directory() {
        let temp = tempfile::tempdir().expect("temp directory must exist");
        let file = temp.path().join("note.md");
        fs::write(&file, b"x").expect("file");
        let error = resolve_existing_directory(&file.to_string_lossy()).expect_err("file");
        assert!(error.to_string().starts_with("폴더가 아닙니다"), "{error}");
    }

    #[test]
    fn create_makes_only_the_last_segment_under_an_existing_parent() {
        let temp = tempfile::tempdir().expect("temp directory must exist");
        let app_data = temp.path().join("app-data");
        fs::create_dir(&app_data).expect("app data");
        let target = temp.path().join("project-management");

        let created = create_user_directory(&app_data, &target.to_string_lossy()).expect("created");
        assert!(created.is_dir());
        assert_eq!(created, fs::canonicalize(&target).expect("canonical"));

        // 두 번째 요청도 같은 폴더를 돌려준다(확인 대화 뒤 재시도가 겹쳐도 안전).
        assert_eq!(
            create_user_directory(&app_data, &target.to_string_lossy()).expect("idempotent"),
            created
        );

        // 상위가 없으면 그 상위를 문구에 담아 거절하고, 트리를 만들지 않는다.
        let deep = temp.path().join("absent-parent").join("leaf");
        let error = create_user_directory(&app_data, &deep.to_string_lossy()).expect_err("deep");
        assert!(
            error.to_string().starts_with(MISSING_DIRECTORY_PREFIX),
            "{error}"
        );
        assert!(!temp.path().join("absent-parent").exists());
    }

    #[test]
    fn create_refuses_the_app_data_directory_and_parent_traversal() {
        let temp = tempfile::tempdir().expect("temp directory must exist");
        let app_data = temp.path().join("app-data");
        fs::create_dir(&app_data).expect("app data");

        let inside = app_data.join("docs");
        assert!(matches!(
            create_user_directory(&app_data, &inside.to_string_lossy()).expect_err("app data"),
            CoreError::InvalidInput(_)
        ));
        assert!(!inside.exists());

        let traversal = format!("{}/../x", temp.path().to_string_lossy());
        assert!(matches!(
            create_user_directory(&app_data, &traversal).expect_err("traversal"),
            CoreError::InvalidInput(_)
        ));
    }
}
