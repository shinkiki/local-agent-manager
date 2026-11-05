//! Index system-skill entry point; shares all policy and result budgets with UI/AIA.
use crate::CoreError;
use serde_json::json;
use std::path::PathBuf;

pub fn run_index_cli(args: impl Iterator<Item = String>) -> Result<(), CoreError> {
    let mut args = args;
    let operation = args.next().ok_or_else(|| {
        CoreError::InvalidInput("index list | search | read | refresh 작업이 필요합니다".into())
    })?;
    let mut fields = serde_json::Map::new();
    let mut app: Option<PathBuf> = None;
    while let Some(flag) = args.next() {
        let value = args
            .next()
            .ok_or_else(|| CoreError::InvalidInput(format!("{flag} 값이 필요합니다")))?;
        if flag == "--app-data-dir" {
            if app.is_some() {
                return Err(CoreError::InvalidInput(format!("중복 옵션: {flag}")));
            }
            app = Some(value.into());
            continue;
        }
        let key = match flag.as_str() {
            "--source" => "sourceId",
            "--query" => "query",
            "--path" => "relativePath",
            "--digest" => "digest",
            "--start" => "startLine",
            "--end" => "endLine",
            "--limit" => "limit",
            _ => {
                return Err(CoreError::InvalidInput(format!(
                    "알 수 없는 인덱스 옵션: {flag}"
                )))
            }
        };
        let value = if matches!(key, "startLine" | "endLine" | "limit") {
            json!(value
                .parse::<usize>()
                .map_err(|_| CoreError::InvalidInput(format!("{flag}에는 양수가 필요합니다")))?)
        } else {
            json!(value)
        };
        if fields.insert(key.into(), value).is_some() {
            return Err(CoreError::InvalidInput(format!("중복 옵션: {flag}")));
        }
    }
    let app = crate::remote::cli_app_data_dir(app)?;
    let listing = fields.is_empty();
    // 에이전트가 부르는 진입점이라 늘 자기 작업 경로를 싣는다. 프로젝트별로 적용한 폴더는
    // 그 프로젝트 안에서 부른 호출에만 보인다. 경로를 못 읽으면 모든 프로젝트 폴더만 본다.
    let project = std::env::current_dir()
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_default();
    fields.insert("project".into(), json!(project));
    let value = serde_json::Value::Object(fields);
    let result = match operation.as_str() {
        "list" if listing => serde_json::to_value(crate::index_addon::list_agent_index_sources(
            &app,
            serde_json::from_value(value)?,
        )?)?,
        "search" => serde_json::to_value(crate::index_addon::search_index(
            &app,
            serde_json::from_value(value)?,
        )?)?,
        "read" => serde_json::to_value(crate::index_addon::read_index_excerpt(
            &app,
            serde_json::from_value(value)?,
        )?)?,
        "refresh" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Request {
                source_id: String,
                project: String,
            }
            let request: Request = serde_json::from_value(value)?;
            serde_json::to_value(crate::index_addon::refresh_agent_index_source(
                &app,
                crate::AgentIndexSourceRequest {
                    id: request.source_id,
                    project: Some(request.project),
                },
            )?)?
        }
        _ => {
            return Err(CoreError::InvalidInput(
                "index list | search | read | refresh 작업을 확인해 주세요".into(),
            ))
        }
    };
    println!("{}", serde_json::to_string(&result)?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn g7_v2_duplicate_app_data_dir_is_rejected_for_every_operation() {
        let temp = tempfile::tempdir().unwrap();
        let first = temp.path().join("first app data");
        let other = temp.path().join("other app data");
        for operation in ["list", "search", "read", "refresh"] {
            for second in [&first, &other] {
                let error = run_index_cli(
                    [
                        operation,
                        "--app-data-dir",
                        first.to_str().unwrap(),
                        "--app-data-dir",
                        second.to_str().unwrap(),
                    ]
                    .into_iter()
                    .map(str::to_owned),
                )
                .unwrap_err();
                assert!(
                    matches!(error, CoreError::InvalidInput(ref message)
                        if message == "중복 옵션: --app-data-dir"),
                    "{operation}: {error:?}"
                );
            }
        }
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 0);
    }

    #[test]
    fn g7_v2_single_app_data_dir_keeps_index_list_read_only() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app data");
        run_index_cli(
            ["list", "--app-data-dir", app.to_str().unwrap()]
                .into_iter()
                .map(str::to_owned),
        )
        .unwrap();
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 0);
    }
}
