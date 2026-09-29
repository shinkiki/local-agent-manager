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

/// 한 번의 확인으로 만들 수 있는 새 칸 수(C6-4).
///
/// `docs/milestones`처럼 프로젝트 안에 두 칸을 함께 만드는 일이 실제 용법이라 한 칸
/// 제한은 온보딩이 폴더를 준비하지 못하게 막았다. 그렇다고 `create_dir_all`로 열면
/// `/Users/exmaple/…` 같은 오타 하나가 승인 화면에 없던 트리를 만든다. 확인 대화가
/// 만들 칸을 **모두 나열**하고(C6-4b), 그 목록이 사람이 한눈에 검토할 수 있는 길이를
/// 넘지 않도록 세 칸에서 끊는다.
pub const MAX_NEW_DIRECTORY_SEGMENTS: usize = 3;

/// 사람에게 보여 줄 경로 모양.
///
/// Windows의 `fs::canonicalize`는 `\\?\F:\…` 확장 길이 경로를 돌려준다. 그 접두어는 파일
/// 입출력의 사정이지 사용자가 읽을 것이 아니다 — 폴더를 만든 뒤 화면이 그 값을 작업 경로
/// 칸에 그대로 넣으므로, 접두어가 한 번 새어 나오면 그다음 실패 문구와 확인 대화가 모두
/// `경로를 찾을 수 없습니다: \\?\F:\…`처럼 읽힌다. 자식 프로세스에게 넘길 때와 같은 모양
/// (`path_guard::child_facing`)으로 벗겨서 내보내고, 경계 검사(G10)는 정규 경로끼리 한다.
fn shown(path: &Path) -> String {
    path_guard::child_facing(path)
        .to_string_lossy()
        .into_owned()
}

/// 사용자 확인 뒤 실제로 만든 폴더. 화면은 이 경로를 그대로 다시 제출한다.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedDirectory {
    pub path: String,
}

/// 만들기 전에 화면이 보여 줄 계획(C6-4b).
///
/// 승인한 것과 실제로 생기는 것이 같아야 한다는 C6의 취지는 "한 칸만 만든다"가 아니라
/// "만들 것을 모두 보여 준다"에 있다. 여러 칸을 열면서 그 취지를 지키려면 화면이 목록을
/// 그릴 재료가 필요하므로, 만들기와 같은 규칙으로 계산한 계획을 조회로 먼저 내준다.
///
/// 담긴 경로는 모두 [`shown`] 모양이다 — 확인 대화에 그대로 나열되는 값이라, 파일
/// 입출력용 접두어가 아니라 사람이 읽는 경로여야 한다.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryCreationPlan {
    /// 이미 있는 가장 깊은 조상. 새 칸은 모두 이 아래에 생긴다.
    pub anchor: String,
    /// `anchor` 아래에 차례로 생길 절대 경로. 이미 있으면 빈 목록이다.
    pub creates: Vec<String>,
    /// 만들기가 끝난 뒤의 최종 경로.
    pub target: String,
    /// 이미 그 폴더가 있어 만들 것이 없는 상태.
    pub exists: bool,
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
    let display = shown(requested);
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

/// 계획을 세운 그대로의 경로. 만들기는 이 정규 경로로 진행하고, 화면에 나가는
/// [`DirectoryCreationPlan`]은 여기서 [`shown`]으로 한 번 벗겨 만든다. 보여 줄 모양으로
/// 먼저 바꿔 두면 만들기가 그 문자열로 `create_dir`를 부르고, 다시 정규화한 결과가 원래
/// 문자열과 달라 "승인한 자리를 벗어났다"는 자기 검사에 걸린다.
struct DirectoryPlan {
    anchor: PathBuf,
    creates: Vec<PathBuf>,
    target: PathBuf,
    exists: bool,
}

/// 만들기 전에, 무엇이 생기는지 계산한다(C6-4b).
///
/// 이미 있는 가장 깊은 조상(`anchor`)을 찾고 그 아래로 새로 생길 칸을 차례대로 담는다.
/// 만들기와 규칙이 같은 한 함수에서 나오므로, 확인 대화에 나열된 목록과 실제로 생기는
/// 것이 어긋날 수 없다. 조회라서 파일시스템을 바꾸지 않는다.
pub fn plan_user_directory(
    app_data_dir: &Path,
    raw: &str,
) -> Result<DirectoryCreationPlan, CoreError> {
    let plan = plan_user_directory_paths(app_data_dir, raw)?;
    Ok(DirectoryCreationPlan {
        anchor: shown(&plan.anchor),
        creates: plan.creates.iter().map(|path| shown(path)).collect(),
        target: shown(&plan.target),
        exists: plan.exists,
    })
}

fn plan_user_directory_paths(app_data_dir: &Path, raw: &str) -> Result<DirectoryPlan, CoreError> {
    let requested = normalize_user_path(raw)?;
    if path_guard::has_parent_dir(&requested) {
        return Err(CoreError::InvalidInput(
            "경로에 상위 디렉터리(..)를 쓸 수 없습니다".to_owned(),
        ));
    }
    // 이미 있으면 만들 것이 없다. 확인 대화 뒤의 재시도가 두 번 도착해도 결과가 같다.
    if let Ok(existing) = fs::symlink_metadata(&requested) {
        if !existing.file_type().is_dir() {
            return Err(CoreError::Conflict(format!(
                "그 자리에 폴더가 아닌 항목이 이미 있습니다: {}",
                shown(&requested)
            )));
        }
        let canonical = resolve_existing_directory_path(&requested)?;
        return Ok(DirectoryPlan {
            anchor: canonical.clone(),
            creates: Vec::new(),
            target: canonical,
            exists: true,
        });
    }

    // 없는 칸을 위로 훑어 이미 있는 가장 깊은 조상을 찾는다. 세 칸을 넘으면 사람이
    // 확인 대화에서 검토하기 어려운 트리라, 만들지 않고 경로를 다시 보게 한다.
    let mut names = Vec::new();
    let mut cursor = requested.as_path();
    let anchor = loop {
        let (parent, name) = cursor
            .parent()
            .zip(cursor.file_name())
            .ok_or_else(|| CoreError::InvalidInput("최상위 경로는 만들 수 없습니다".to_owned()))?;
        names.push(name.to_owned());
        if fs::symlink_metadata(parent).is_ok() {
            break resolve_existing_directory_path(parent)?;
        }
        if names.len() >= MAX_NEW_DIRECTORY_SEGMENTS {
            return Err(CoreError::InvalidInput(format!(
                "한 번에 만들 수 있는 하위 폴더는 {MAX_NEW_DIRECTORY_SEGMENTS}칸까지입니다. 이미 있는 폴더를 고르거나 경로를 줄이세요: {}",
                shown(&requested)
            )));
        }
        cursor = parent;
    };
    names.reverse();

    let mut creates = Vec::with_capacity(names.len());
    let mut target = anchor.clone();
    for name in names {
        target = target.join(name);
        // 중간 칸도 최종 칸과 같은 기준으로 막는다. 마지막만 보면 공급자 홈 아래에
        // 중간 폴더가 먼저 생기고 나서 거절되는 구멍이 남는다.
        if crate::store::is_restricted_doc_root(app_data_dir, &target) {
            return Err(CoreError::InvalidInput(
                "공급자 인증 저장소 또는 Agent Manager 앱 데이터와 겹치는 폴더는 만들 수 없습니다"
                    .to_owned(),
            ));
        }
        creates.push(target.clone());
    }

    Ok(DirectoryPlan {
        anchor,
        creates,
        target,
        exists: false,
    })
}

/// 사용자가 화면에서 만들기를 확인한 폴더를 만든다(C6).
///
/// 만들 수 있는 것은 **이미 있는 폴더 아래로 세 칸까지**다(`MAX_NEW_DIRECTORY_SEGMENTS`).
/// `create_dir_all`은 쓰지 않는다 — 한 칸씩 만들고 매번 다시 정규화해, 만드는 사이에
/// 심볼릭 링크가 끼어들어도 승인받은 자리 밖에 다음 칸이 생기지 않게 한다. 중간에서
/// 실패하면 이번 호출이 만든 칸만 역순으로 지워, 절반만 남은 트리를 남기지 않는다.
///
/// 공급자 홈과 Agent Manager 앱 데이터는 문서 루트와 같은 기준
/// (`store::is_restricted_doc_root`)으로 중간 칸까지 막는다.
pub fn create_user_directory(app_data_dir: &Path, raw: &str) -> Result<PathBuf, CoreError> {
    let plan = plan_user_directory_paths(app_data_dir, raw)?;
    if plan.exists {
        return Ok(plan.target);
    }

    let mut created: Vec<PathBuf> = Vec::new();
    let mut cursor = plan.anchor;
    for next in plan.creates {
        if let Err(error) = fs::create_dir(&next) {
            rollback_created(&created);
            return Err(CoreError::Io(error));
        }
        created.push(next.clone());
        let canonical = match resolve_existing_directory_path(&next) {
            Ok(path) => path,
            Err(error) => {
                rollback_created(&created);
                return Err(error);
            }
        };
        if canonical != next
            || !canonical.starts_with(&cursor)
            || crate::store::is_restricted_doc_root(app_data_dir, &canonical)
        {
            rollback_created(&created);
            return Err(CoreError::InvalidInput(format!(
                "만드는 도중에 경로가 승인한 자리를 벗어났습니다: {}",
                shown(&next)
            )));
        }
        cursor = canonical;
    }
    Ok(cursor)
}

/// 실패한 만들기가 남긴 빈 칸을 역순으로 거둔다. 이번 호출이 만든 것만 지우므로
/// 비어 있고, 지우지 못해도 원래 실패를 덮지 않도록 결과는 보지 않는다.
fn rollback_created(created: &[PathBuf]) {
    for path in created.iter().rev() {
        let _ = fs::remove_dir(path);
    }
}

pub(crate) fn expand_home(trimmed: &str) -> Result<PathBuf, CoreError> {
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
    fn create_makes_the_missing_segments_under_an_existing_anchor() {
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

        // C6-4: `docs/milestones`처럼 없는 칸이 여러 개여도 세 칸까지 함께 만든다.
        let nested = temp.path().join("project").join("docs").join("milestones");
        let made = create_user_directory(&app_data, &nested.to_string_lossy()).expect("nested");
        assert!(made.is_dir());
        assert_eq!(made, fs::canonicalize(&nested).expect("canonical nested"));
    }

    /// C6-4b: 확인 대화가 나열할 목록은 만들기와 같은 함수에서 나온다.
    #[test]
    fn the_plan_lists_every_segment_that_will_be_created() {
        let temp = tempfile::tempdir().expect("temp directory must exist");
        let app_data = temp.path().join("app-data");
        fs::create_dir(&app_data).expect("app data");
        let anchor = fs::canonicalize(temp.path()).expect("canonical temp");
        let nested = anchor.join("project").join("docs").join("milestones");

        let plan = plan_user_directory(&app_data, &nested.to_string_lossy()).expect("plan");
        assert!(!plan.exists);
        assert_eq!(plan.anchor, shown(&anchor));
        assert_eq!(
            plan.creates,
            vec![
                shown(&anchor.join("project")),
                shown(&anchor.join("project").join("docs")),
                shown(&nested),
            ]
        );
        assert_eq!(plan.target, shown(&nested));
        // 계획은 조회다. 아무것도 만들지 않는다.
        assert!(!anchor.join("project").exists());

        // 이미 있으면 만들 것이 없다고 알려 화면이 확인을 띄우지 않는다.
        let existing = plan_user_directory(&app_data, &anchor.to_string_lossy()).expect("existing");
        assert!(existing.exists);
        assert!(existing.creates.is_empty());
    }

    /// 화면에 나가는 경로에는 Windows 확장 길이 접두어가 붙지 않는다.
    ///
    /// 폴더를 만들면 화면이 돌려받은 경로를 작업 경로 칸에 그대로 넣고 다시 제출한다.
    /// 정규 경로(`\\?\F:\…`)를 그대로 내주면 그 값이 다음 실패 문구와 확인 대화에 다시
    /// 실려, 사용자는 `경로를 찾을 수 없습니다: \\?\F:\…`를 읽게 된다. 계획·만들기·실패
    /// 문구가 모두 같은 모양으로 나가는지 한자리에서 묶어 둔다.
    #[test]
    fn paths_shown_to_the_user_carry_no_extended_length_prefix() {
        let temp = tempfile::tempdir().expect("temp directory must exist");
        let app_data = temp.path().join("app-data");
        fs::create_dir(&app_data).expect("app data");
        let target = temp.path().join("workspace").join("docs");

        let plan = plan_user_directory(&app_data, &target.to_string_lossy()).expect("plan");
        for path in [&plan.anchor, &plan.target]
            .into_iter()
            .chain(plan.creates.iter())
        {
            assert!(!path.starts_with(r"\\?\"), "{path}");
        }

        // 없는 폴더의 실패 문구도 같은 모양이다 — 화면은 이 문구에서 경로를 떼어
        // 확인 대화에 싣는다(C6-3).
        let message = resolve_existing_directory(&target.to_string_lossy())
            .expect_err("missing")
            .to_string();
        assert!(!message.contains(r"\\?\"), "{message}");

        // 정규 경로를 그대로 다시 입력해도(만든 뒤 화면이 되돌려 보내는 값) 같다.
        let created = create_user_directory(&app_data, &target.to_string_lossy()).expect("created");
        let replanned =
            plan_user_directory(&app_data, &created.to_string_lossy()).expect("replanned");
        assert!(replanned.exists);
        assert!(
            !replanned.target.starts_with(r"\\?\"),
            "{}",
            replanned.target
        );
    }

    /// C6-4: 네 칸부터는 거절한다. NotFound가 아니라 InvalidInput이라, 화면이 같은
    /// 경로로 "만들까요?"를 다시 묻는 고리에 빠지지 않는다.
    #[test]
    fn create_refuses_more_new_segments_than_the_limit() {
        let temp = tempfile::tempdir().expect("temp directory must exist");
        let app_data = temp.path().join("app-data");
        fs::create_dir(&app_data).expect("app data");
        let too_deep = temp.path().join("a").join("b").join("c").join("d");

        let error =
            create_user_directory(&app_data, &too_deep.to_string_lossy()).expect_err("too deep");
        assert!(matches!(error, CoreError::InvalidInput(_)), "{error}");
        assert!(error.to_string().contains("3칸"), "{error}");
        assert!(!temp.path().join("a").exists(), "아무것도 만들지 않는다");
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

        // 중간 칸도 같은 기준으로 막는다. 마지막만 보면 앱 데이터 아래에 중간 폴더가
        // 먼저 생기고 나서 거절되는 구멍이 남는다.
        let deep_inside = inside.join("milestones");
        assert!(matches!(
            create_user_directory(&app_data, &deep_inside.to_string_lossy())
                .expect_err("app data nested"),
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
