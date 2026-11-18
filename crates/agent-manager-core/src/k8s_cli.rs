//! C22-10: 자기 셸이 있는 에이전트가 부르는 `<CLI> k8s …` 하위 명령.
//!
//! 데이터베이스(C10-13)와 같은 갈래다. 에이전트는 kubeconfig 를 받지 못하므로 `kubectl` 을
//! 직접 부를 수 없고, 클러스터 id 와 리소스 이름만 넘긴다. 지금 있는 작업은 모두 읽기라
//! 떠 있는 백엔드 없이 이 프로세스에서 끝난다. 정책·상한·마스킹은 AIA 경로와 같은 코드가
//! 집행한다.

use std::path::PathBuf;

use serde::Serialize;

use crate::k8s_clusters::K8sClusterRef;
use crate::k8s_exec::{K8sEventsRequest, K8sGetRequest, K8sListRequest, K8sLogsRequest};
use crate::CoreError;

const OPERATIONS: &str = "list | check | resources | get | logs | events";

pub fn run_k8s_cli(args: impl Iterator<Item = String>) -> Result<(), CoreError> {
    let mut args = args;
    let operation = args.next().ok_or_else(|| {
        CoreError::InvalidInput(format!("k8s 다음에 작업이 필요합니다: {OPERATIONS}"))
    })?;
    let options = K8sCliOptions::parse(args)?;
    let dir = options.app_data_dir.clone();
    match operation.as_str() {
        "list" => print(&crate::k8s_clusters::list_agent_k8s_clusters(&dir)?),
        // 화면의 확인 버튼과 달리 에이전트는 열어 준 클러스터만 확인한다.
        "check" => print(&crate::k8s_exec::check_agent_k8s_cluster(
            &dir,
            K8sClusterRef {
                id: options.cluster()?,
            },
        )?),
        "resources" => print(&crate::k8s_exec::list_k8s_resources(
            &dir,
            K8sListRequest {
                cluster_id: options.cluster()?,
                kind: options.required(&options.kind, "--kind")?,
                api_version: options.api_version.clone(),
                namespace: options.namespace.clone(),
                label_selector: options.selector.clone(),
                field_selector: options.field_selector.clone(),
                limit: options.limit,
            },
        )?),
        "get" => print(&crate::k8s_exec::get_k8s_resource(
            &dir,
            K8sGetRequest {
                cluster_id: options.cluster()?,
                kind: options.required(&options.kind, "--kind")?,
                api_version: options.api_version.clone(),
                namespace: options.namespace.clone(),
                name: options.required(&options.name, "--name")?,
            },
        )?),
        "logs" => print(&crate::k8s_exec::get_k8s_logs(
            &dir,
            K8sLogsRequest {
                cluster_id: options.cluster()?,
                namespace: options.required(&options.namespace, "--namespace")?,
                pod: options.required(&options.name, "--name")?,
                container: options.container.clone(),
                tail_lines: options.tail,
                since_seconds: options.since,
                previous: options.previous,
            },
        )?),
        "events" => print(&crate::k8s_exec::get_k8s_events(
            &dir,
            K8sEventsRequest {
                cluster_id: options.cluster()?,
                namespace: options.namespace.clone(),
                involved_name: options.name.clone(),
                involved_kind: options.kind.clone(),
                warnings_only: options.warnings,
            },
        )?),
        other => Err(CoreError::InvalidInput(format!(
            "알 수 없는 작업입니다: {other}. {OPERATIONS} 중 하나를 쓰세요"
        ))),
    }
}

fn print(value: &impl Serialize) -> Result<(), CoreError> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}

#[derive(Debug, Default)]
struct K8sCliOptions {
    cluster: Option<String>,
    kind: Option<String>,
    api_version: Option<String>,
    namespace: Option<String>,
    name: Option<String>,
    container: Option<String>,
    selector: Option<String>,
    field_selector: Option<String>,
    limit: Option<u32>,
    tail: Option<u32>,
    since: Option<u32>,
    previous: bool,
    warnings: bool,
    app_data_dir: PathBuf,
}

impl K8sCliOptions {
    fn parse(args: impl Iterator<Item = String>) -> Result<Self, CoreError> {
        let mut args = args;
        let mut options = Self::default();
        let mut app_data_dir = None;
        while let Some(flag) = args.next() {
            // 값 없는 스위치.
            match flag.as_str() {
                "--previous" => {
                    options.previous = true;
                    continue;
                }
                "--warnings" => {
                    options.warnings = true;
                    continue;
                }
                _ => {}
            }
            let value = args
                .next()
                .ok_or_else(|| CoreError::InvalidInput(format!("{flag} 값이 필요합니다")))?;
            let number = |value: &str| {
                value
                    .parse::<u32>()
                    .map_err(|_| CoreError::InvalidInput(format!("{flag}는 숫자여야 합니다")))
            };
            // 같은 인자를 두 번 주면 앞의 값이 조용히 사라져 에이전트가 고른 것과 다른
            // 대상을 읽게 된다. 어느 쪽이 의도인지 알 수 없으므로 거절한다.
            let slot_taken = match flag.as_str() {
                "--cluster" => options.cluster.replace(value.clone()).is_some(),
                "--kind" => options.kind.replace(value.clone()).is_some(),
                "--api-version" => options.api_version.replace(value.clone()).is_some(),
                "--namespace" | "-n" => options.namespace.replace(value.clone()).is_some(),
                "--name" => options.name.replace(value.clone()).is_some(),
                "--container" | "-c" => options.container.replace(value.clone()).is_some(),
                "--selector" | "-l" => options.selector.replace(value.clone()).is_some(),
                "--field-selector" => options.field_selector.replace(value.clone()).is_some(),
                "--limit" => options.limit.replace(number(&value)?).is_some(),
                "--tail" => options.tail.replace(number(&value)?).is_some(),
                "--since" => options.since.replace(number(&value)?).is_some(),
                "--app-data-dir" => app_data_dir.replace(PathBuf::from(&value)).is_some(),
                other => {
                    return Err(CoreError::InvalidInput(format!(
                        "알 수 없는 인자입니다: {other}"
                    )))
                }
            };
            if slot_taken {
                return Err(CoreError::InvalidInput(format!(
                    "{flag}가 두 번 지정됐습니다. 하나만 남기세요"
                )));
            }
        }
        options.app_data_dir = crate::remote::cli_app_data_dir(app_data_dir)?;
        Ok(options)
    }

    fn cluster(&self) -> Result<String, CoreError> {
        self.required(&self.cluster, "--cluster")
    }

    fn required(&self, value: &Option<String>, flag: &str) -> Result<String, CoreError> {
        value
            .clone()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| CoreError::InvalidInput(format!("{flag} 값이 필요합니다")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(values: &[&str]) -> Result<K8sCliOptions, CoreError> {
        let mut args: Vec<String> = values.iter().map(|value| (*value).to_owned()).collect();
        args.extend(["--app-data-dir".to_owned(), "/tmp/app".to_owned()]);
        K8sCliOptions::parse(args.into_iter())
    }

    #[test]
    fn c22_10_flags_and_switches_are_parsed() {
        let options = parse(&[
            "--cluster",
            "oci",
            "-n",
            "qa-lite",
            "--name",
            "qa-lite-7c9",
            "--tail",
            "50",
            "--previous",
        ])
        .expect("parse");
        assert_eq!(options.cluster.as_deref(), Some("oci"));
        assert_eq!(options.namespace.as_deref(), Some("qa-lite"));
        assert_eq!(options.tail, Some(50));
        assert!(options.previous);
        assert!(!options.warnings);
    }

    #[test]
    fn c22_10_unknown_repeated_and_non_numeric_flags_are_refused() {
        assert!(parse(&["--kubeconfig", "x"]).is_err());
        let repeated = parse(&["--cluster", "a", "--cluster", "b"]).expect_err("repeated");
        assert!(repeated.to_string().contains("두 번"));
        assert!(parse(&["--tail", "many"]).is_err());
    }
}
