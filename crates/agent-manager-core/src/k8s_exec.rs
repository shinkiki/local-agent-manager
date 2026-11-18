//! C22-5~C22-9: 등록한 Kubernetes 클러스터에서 읽기 작업을 실행한다.
//!
//! `kubectl` 을 띄우지 않고 API 서버에 직접 HTTPS 로 묻는다. 앱 이미지에 `kubectl` 이 없어도
//! 되고, 자격증명을 파일로 넘길 일이 없으며, 결과를 앱이 정한 모양으로 줄여 돌려줄 수 있다.
//!
//! 여기 있는 작업은 모두 **읽기**다 — GET 과, 권한을 묻는 SelfSubjectRulesReview(서버에
//! 아무것도 남기지 않는 생성 요청) 뿐이다. 결과에서 다음을 지운다.
//!
//! - Secret 의 `data`·`stringData` 값(키 이름과 바이트 수만 남긴다).
//! - 모든 객체의 `managedFields` 와 `last-applied-configuration` 주석(Secret 원문이 그대로
//!   들어 있을 수 있다).
//! - 이름이 비밀번호·토큰처럼 보이는 `env` 항목의 `value`.
//! - 로그 줄 안의 40자 넘는 토큰꼴 값과 키 블록(SSH 출력과 같은 규칙).

use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use zeroize::Zeroizing;

use crate::k8s_clusters::{
    agent_cluster_of, cluster_of, resolve_credential, validate_k8s_name, K8sClusterView,
    MAX_NAMESPACE_CHARS,
};
use crate::CoreError;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(8);
const MAX_RESOURCE_NAME_CHARS: usize = 253;
const DEFAULT_LIST_LIMIT: u32 = 100;
const MAX_LIST_LIMIT: u32 = 500;
const DEFAULT_TAIL_LINES: u32 = 200;
const MAX_TAIL_LINES: u32 = 5_000;
/// 로그·객체 한 번에 돌려주는 크기. 대화 맥락을 태우지 않는 선이다.
const MAX_LOG_BYTES: u64 = 256 * 1024;
const MAX_OBJECT_BYTES: usize = 256 * 1024;
const MAX_EVENTS: usize = 100;
const MAX_SELECTOR_CHARS: usize = 400;
/// 탐색으로 훑는 API 그룹 수의 상한. CRD 가 아주 많은 클러스터에서 한 번의 호출이 끝없이
/// 늘어나지 않게 한다.
const MAX_DISCOVERY_GROUPS: usize = 80;
/// 이 조각이 이름에 들어간 `env` 항목은 값을 가린다(대소문자 무시).
const MASKED_ENV_NAME_PARTS: &[&str] = &[
    "PASS",
    "SECRET",
    "TOKEN",
    "APIKEY",
    "API_KEY",
    "PRIVATE",
    "CREDENTIAL",
];

/// 리소스 종류 하나가 API 경로에서 어디에 있는지.
#[derive(Clone, Debug, PartialEq, Eq)]
struct ResourceType {
    api_version: String,
    kind: String,
    plural: String,
    namespaced: bool,
}

impl ResourceType {
    fn is_secret(&self) -> bool {
        self.api_version == "v1" && self.kind == "Secret"
    }

    /// `/api/v1` 또는 `/apis/<group>/<version>`.
    fn prefix(&self) -> String {
        if self.api_version.contains('/') {
            format!("/apis/{}", self.api_version)
        } else {
            format!("/api/{}", self.api_version)
        }
    }

    fn collection_path(&self, namespace: Option<&str>) -> String {
        match namespace {
            Some(namespace) if self.namespaced => {
                format!("{}/namespaces/{namespace}/{}", self.prefix(), self.plural)
            }
            _ => format!("{}/{}", self.prefix(), self.plural),
        }
    }
}

/// 자주 쓰는 종류는 탐색 없이 바로 찾는다. (별칭들, apiVersion, kind, 복수형, 네임스페이스 소속)
const BUILTIN_TYPES: &[(&[&str], &str, &str, &str, bool)] = &[
    (&["pod", "pods", "po"], "v1", "Pod", "pods", true),
    (
        &["service", "services", "svc"],
        "v1",
        "Service",
        "services",
        true,
    ),
    (
        &["configmap", "configmaps", "cm"],
        "v1",
        "ConfigMap",
        "configmaps",
        true,
    ),
    (&["secret", "secrets"], "v1", "Secret", "secrets", true),
    (
        &["persistentvolumeclaim", "persistentvolumeclaims", "pvc"],
        "v1",
        "PersistentVolumeClaim",
        "persistentvolumeclaims",
        true,
    ),
    (
        &["persistentvolume", "persistentvolumes", "pv"],
        "v1",
        "PersistentVolume",
        "persistentvolumes",
        false,
    ),
    (&["node", "nodes", "no"], "v1", "Node", "nodes", false),
    (
        &["namespace", "namespaces", "ns"],
        "v1",
        "Namespace",
        "namespaces",
        false,
    ),
    (&["event", "events", "ev"], "v1", "Event", "events", true),
    (
        &["serviceaccount", "serviceaccounts", "sa"],
        "v1",
        "ServiceAccount",
        "serviceaccounts",
        true,
    ),
    (&["endpoints", "ep"], "v1", "Endpoints", "endpoints", true),
    (
        &["deployment", "deployments", "deploy"],
        "apps/v1",
        "Deployment",
        "deployments",
        true,
    ),
    (
        &["statefulset", "statefulsets", "sts"],
        "apps/v1",
        "StatefulSet",
        "statefulsets",
        true,
    ),
    (
        &["daemonset", "daemonsets", "ds"],
        "apps/v1",
        "DaemonSet",
        "daemonsets",
        true,
    ),
    (
        &["replicaset", "replicasets", "rs"],
        "apps/v1",
        "ReplicaSet",
        "replicasets",
        true,
    ),
    (&["job", "jobs"], "batch/v1", "Job", "jobs", true),
    (
        &["cronjob", "cronjobs", "cj"],
        "batch/v1",
        "CronJob",
        "cronjobs",
        true,
    ),
    (
        &["ingress", "ingresses", "ing"],
        "networking.k8s.io/v1",
        "Ingress",
        "ingresses",
        true,
    ),
    (
        &["ingressclass", "ingressclasses"],
        "networking.k8s.io/v1",
        "IngressClass",
        "ingressclasses",
        false,
    ),
    (
        &["networkpolicy", "networkpolicies", "netpol"],
        "networking.k8s.io/v1",
        "NetworkPolicy",
        "networkpolicies",
        true,
    ),
    (
        &["storageclass", "storageclasses", "sc"],
        "storage.k8s.io/v1",
        "StorageClass",
        "storageclasses",
        false,
    ),
    (
        &["horizontalpodautoscaler", "horizontalpodautoscalers", "hpa"],
        "autoscaling/v2",
        "HorizontalPodAutoscaler",
        "horizontalpodautoscalers",
        true,
    ),
    (
        &["poddisruptionbudget", "poddisruptionbudgets", "pdb"],
        "policy/v1",
        "PodDisruptionBudget",
        "poddisruptionbudgets",
        true,
    ),
    (
        &["role", "roles"],
        "rbac.authorization.k8s.io/v1",
        "Role",
        "roles",
        true,
    ),
    (
        &["rolebinding", "rolebindings"],
        "rbac.authorization.k8s.io/v1",
        "RoleBinding",
        "rolebindings",
        true,
    ),
    (
        &["clusterrole", "clusterroles"],
        "rbac.authorization.k8s.io/v1",
        "ClusterRole",
        "clusterroles",
        false,
    ),
    (
        &["clusterrolebinding", "clusterrolebindings"],
        "rbac.authorization.k8s.io/v1",
        "ClusterRoleBinding",
        "clusterrolebindings",
        false,
    ),
];

fn builtin_type(kind: &str, api_version: Option<&str>) -> Option<ResourceType> {
    let wanted = kind.trim().to_ascii_lowercase();
    BUILTIN_TYPES
        .iter()
        .find(|(aliases, version, ..)| {
            aliases.contains(&wanted.as_str()) && api_version.is_none_or(|value| value == *version)
        })
        .map(|(_, version, kind, plural, namespaced)| ResourceType {
            api_version: (*version).to_owned(),
            kind: (*kind).to_owned(),
            plural: (*plural).to_owned(),
            namespaced: *namespaced,
        })
}

/// 클러스터에 붙는 방법. 실제 경로는 보안 저장소에서 자격증명을 꺼내고, 시험은 가짜 서버로 붙는다.
type Connector = dyn Fn(&K8sClusterView) -> Result<K8sClient, CoreError>;

/// 클러스터 하나에 붙은 HTTP 클라이언트. 자격증명은 이 값 안에서만 산다.
struct K8sClient {
    base: String,
    http: reqwest::blocking::Client,
    bearer: Option<Zeroizing<String>>,
}

impl K8sClient {
    fn connect(cluster: &K8sClusterView) -> Result<Self, CoreError> {
        let credential = resolve_credential(cluster)?;
        Self::with_credential(cluster, &credential.0)
    }

    /// 보안 저장소를 거치지 않고 자격증명을 직접 받는다. 시험이 가짜 API 서버에 붙는 자리다.
    fn with_credential(
        cluster: &K8sClusterView,
        credential: &crate::k8s_clusters::K8sCredential,
    ) -> Result<Self, CoreError> {
        let mut builder = reqwest::blocking::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .connect_timeout(CONNECT_TIMEOUT)
            // 다른 호스트로 넘겨 주는 응답을 따라가면 Bearer 토큰이 그쪽으로 실린다.
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(concat!("agent-manager/", env!("CARGO_PKG_VERSION")));
        if !cluster.ca_pem.is_empty() {
            // 등록한 CA 만 믿는다. 같은 이름의 공개 인증서로 바꿔치기한 서버를 받지 않는다.
            let certificates = reqwest::Certificate::from_pem_bundle(cluster.ca_pem.as_bytes())
                .map_err(|_| CoreError::Runtime("저장된 CA 인증서를 읽지 못했습니다".to_owned()))?;
            builder = builder.tls_certs_only(certificates);
        }
        let mut bearer = None;
        match (
            credential.token.as_deref(),
            credential.certificate_pem.as_deref(),
            credential.key_pem.as_deref(),
        ) {
            (Some(token), ..) => bearer = Some(Zeroizing::new(format!("Bearer {token}"))),
            (None, Some(certificate), Some(key)) => {
                let combined = Zeroizing::new(format!("{}\n{}\n", certificate.trim(), key.trim()));
                let identity = reqwest::Identity::from_pem(combined.as_bytes()).map_err(|_| {
                    CoreError::Runtime("저장된 클라이언트 인증서를 읽지 못했습니다".to_owned())
                })?;
                builder = builder.identity(identity);
            }
            _ => {
                return Err(CoreError::Runtime(
                    "저장된 Kubernetes 자격증명이 비어 있습니다".to_owned(),
                ))
            }
        }
        let http = builder.build().map_err(|error| {
            CoreError::Runtime(format!("HTTP 클라이언트를 만들지 못했습니다: {error}"))
        })?;
        Ok(Self {
            base: cluster.server.clone(),
            http,
            bearer,
        })
    }

    /// 기본 주소에 경로와 질의를 붙인다. 값은 URL 인코딩되므로 선택자 안의 `,`·`=` 가 안전하다.
    fn url(&self, path: &str, query: &[(&str, String)]) -> Result<reqwest::Url, CoreError> {
        let mut url = reqwest::Url::parse(&format!("{}{path}", self.base)).map_err(|_| {
            CoreError::InvalidInput(format!("API 경로를 만들지 못했습니다: {path}"))
        })?;
        if !query.is_empty() {
            let mut pairs = url.query_pairs_mut();
            for (key, value) in query {
                pairs.append_pair(key, value);
            }
        }
        Ok(url)
    }

    fn request(
        &self,
        method: reqwest::Method,
        path: &str,
        query: &[(&str, String)],
    ) -> Result<reqwest::blocking::RequestBuilder, CoreError> {
        let mut request = self.http.request(method, self.url(path, query)?);
        if let Some(bearer) = self.bearer.as_ref() {
            request = request.header(reqwest::header::AUTHORIZATION, bearer.as_str());
        }
        Ok(request)
    }

    fn get_json(&self, path: &str, query: &[(&str, String)]) -> Result<Value, CoreError> {
        let response = self
            .request(reqwest::Method::GET, path, query)?
            .header(reqwest::header::ACCEPT, "application/json")
            .send()
            .map_err(transport_error)?;
        json_body(response, path)
    }

    fn post_json(&self, path: &str, body: &Value) -> Result<Value, CoreError> {
        let response = self
            .request(reqwest::Method::POST, path, &[])?
            .header(reqwest::header::ACCEPT, "application/json")
            .json(body)
            .send()
            .map_err(transport_error)?;
        json_body(response, path)
    }

    fn get_text(
        &self,
        path: &str,
        query: &[(&str, String)],
        limit: u64,
    ) -> Result<(String, bool), CoreError> {
        use std::io::Read as _;
        let response = self
            .request(reqwest::Method::GET, path, query)?
            .send()
            .map_err(transport_error)?;
        let status = response.status();
        if !status.is_success() {
            return Err(status_error(
                status,
                &read_capped(response, 16 * 1024).0,
                path,
            ));
        }
        let mut bytes = Vec::new();
        response
            .take(limit + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| CoreError::Runtime(format!("응답을 읽지 못했습니다: {error}")))?;
        let truncated = bytes.len() as u64 > limit;
        bytes.truncate(limit as usize);
        Ok((String::from_utf8_lossy(&bytes).into_owned(), truncated))
    }
}

fn read_capped(response: reqwest::blocking::Response, limit: u64) -> (String, bool) {
    use std::io::Read as _;
    let mut bytes = Vec::new();
    let _ = response.take(limit + 1).read_to_end(&mut bytes);
    let truncated = bytes.len() as u64 > limit;
    bytes.truncate(limit as usize);
    (String::from_utf8_lossy(&bytes).into_owned(), truncated)
}

/// JSON 응답 본문. 큰 목록이 와도 메모리를 끝없이 쓰지 않도록 읽는 양을 묶는다.
fn json_body(response: reqwest::blocking::Response, path: &str) -> Result<Value, CoreError> {
    let status = response.status();
    let (body, truncated) = read_capped(response, 16 * 1024 * 1024);
    if !status.is_success() {
        return Err(status_error(status, &body, path));
    }
    if truncated {
        return Err(CoreError::Runtime(format!(
            "{path} 응답이 너무 큽니다. 네임스페이스·선택자·limit 으로 좁히세요"
        )));
    }
    serde_json::from_str(&body)
        .map_err(|_| CoreError::Runtime(format!("{path} 응답이 JSON 이 아닙니다")))
}

/// 연결 실패. 원인 사슬에 TLS·DNS 진단이 들어 있어 그것까지 펼쳐 보인다.
fn transport_error(error: reqwest::Error) -> CoreError {
    let mut causes = Vec::new();
    let mut source = std::error::Error::source(&error);
    while let Some(inner) = source {
        causes.push(inner.to_string());
        source = inner.source();
    }
    let mut message = error.without_url().to_string();
    for cause in causes {
        message.push_str(": ");
        message.push_str(&cause);
    }
    CoreError::Runtime(format!(
        "API 서버에 닿지 못했습니다: {}",
        crate::ssh_output::redact(&message)
    ))
}

/// 서버가 돌려준 Status 객체를 사람이 읽는 한 문장으로.
fn status_error(status: reqwest::StatusCode, body: &str, path: &str) -> CoreError {
    let message = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| {
            value
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_else(|| body.chars().take(300).collect());
    let message = redact_line(&crate::ssh_output::redact(&message));
    let hint = match status.as_u16() {
        401 => " — 자격증명이 만료됐거나 틀렸습니다. 애드온 → Kubernetes 에서 다시 저장하세요",
        403 => " — 이 계정(RBAC)에 권한이 없습니다",
        404 => " — 없는 리소스이거나 이 클러스터가 그 API 를 제공하지 않습니다",
        _ => "",
    };
    let detail = format!("{} {path}: {message}{hint}", status.as_u16());
    match status.as_u16() {
        404 => CoreError::NotFound(detail),
        400 | 422 => CoreError::InvalidInput(detail),
        _ => CoreError::Runtime(detail),
    }
}

/// 종류 이름을 API 경로로 푼다. 자주 쓰는 종류는 표에서, 나머지(CRD 등)는 탐색으로 찾는다.
fn resolve_type(
    client: &K8sClient,
    kind: &str,
    api_version: Option<&str>,
) -> Result<ResourceType, CoreError> {
    let kind = kind.trim();
    if kind.is_empty()
        || kind.len() > 100
        || !kind.chars().all(|c| c.is_ascii_alphanumeric() || c == '.')
    {
        return Err(CoreError::InvalidInput(format!(
            "알 수 없는 리소스 종류입니다: {kind}"
        )));
    }
    let api_version = api_version.map(str::trim).filter(|value| !value.is_empty());
    if let Some(version) = api_version {
        // 조각마다 영숫자로 시작해야 한다 — `.`·`..` 조각이 섞이면 경로가 /api·/apis 위로
        // 올라가 등록한 서버 접두사 밖을 부른다(C22-4).
        let segments: Vec<&str> = version.split('/').collect();
        let valid = segments.len() <= 2
            && segments.iter().all(|segment| {
                segment
                    .chars()
                    .next()
                    .is_some_and(|c| c.is_ascii_alphanumeric())
                    && !segment.contains("..")
                    && segment.chars().all(|c| {
                        c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '-')
                    })
            });
        if !valid {
            return Err(CoreError::InvalidInput(format!(
                "apiVersion 형식이 아닙니다: {version}"
            )));
        }
    }
    if let Some(found) = builtin_type(kind, api_version) {
        return Ok(found);
    }
    let versions: Vec<String> = match api_version {
        Some(version) => vec![version.to_owned()],
        None => {
            let groups = client.get_json("/apis", &[])?;
            groups
                .get("groups")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|group| {
                    group
                        .pointer("/preferredVersion/groupVersion")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })
                .take(MAX_DISCOVERY_GROUPS)
                .collect()
        }
    };
    let wanted = kind.to_ascii_lowercase();
    for version in versions {
        let path = if version.contains('/') {
            format!("/apis/{version}")
        } else {
            format!("/api/{version}")
        };
        let Ok(list) = client.get_json(&path, &[]) else {
            continue;
        };
        if let Some(found) = match_resource(&list, &version, &wanted) {
            return Ok(found);
        }
    }
    Err(CoreError::NotFound(format!(
        "이 클러스터에서 {kind} 종류를 찾지 못했습니다. apiVersion 을 함께 주거나 철자를 확인하세요"
    )))
}

/// APIResourceList 에서 kind·복수형·단수형·짧은 이름이 맞는 항목. 하위 리소스(`pods/log`)는 뺀다.
fn match_resource(list: &Value, version: &str, wanted: &str) -> Option<ResourceType> {
    list.get("resources")?
        .as_array()?
        .iter()
        .filter(|resource| {
            resource
                .get("name")
                .and_then(Value::as_str)
                .is_some_and(|name| !name.contains('/'))
        })
        .find(|resource| {
            let text = |key: &str| {
                resource
                    .get(key)
                    .and_then(Value::as_str)
                    .map(str::to_ascii_lowercase)
            };
            let short = resource
                .get("shortNames")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .any(|name| name.eq_ignore_ascii_case(wanted));
            short
                || [text("kind"), text("name"), text("singularName")]
                    .into_iter()
                    .flatten()
                    .any(|value| value == wanted)
        })
        .map(|resource| ResourceType {
            api_version: version.to_owned(),
            kind: resource["kind"].as_str().unwrap_or_default().to_owned(),
            plural: resource["name"].as_str().unwrap_or_default().to_owned(),
            namespaced: resource
                .get("namespaced")
                .and_then(Value::as_bool)
                .unwrap_or(true),
        })
}

/// 네임스페이스 범위 판정. 범위가 정해진 클러스터에서는 네임스페이스 소속 종류를 범위
/// 밖이나 "전체"로 읽지 못한다. 클러스터 소속 종류(Node 등)는 범위와 무관하다.
fn scoped_namespace(
    cluster: &K8sClusterView,
    namespaced: bool,
    namespace: Option<&str>,
) -> Result<Option<String>, CoreError> {
    let namespace = namespace.map(str::trim).filter(|value| !value.is_empty());
    if !namespaced {
        return Ok(None);
    }
    let namespace = namespace
        .map(|value| validate_k8s_name(value, "네임스페이스", MAX_NAMESPACE_CHARS))
        .transpose()?;
    if cluster.namespaces.is_empty() {
        return Ok(namespace);
    }
    match namespace {
        Some(namespace) if cluster.namespaces.contains(&namespace) => Ok(Some(namespace)),
        Some(namespace) => Err(CoreError::InvalidInput(format!(
            "{namespace} 네임스페이스는 이 클러스터의 에이전트 범위({}) 밖입니다",
            cluster.namespaces.join(", ")
        ))),
        None => Err(CoreError::InvalidInput(format!(
            "이 클러스터는 네임스페이스 범위가 정해져 있어 namespace 를 지정해야 합니다: {}",
            cluster.namespaces.join(", ")
        ))),
    }
}

fn optional_text(value: Option<&str>, label: &str) -> Result<Option<String>, CoreError> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if value.chars().count() > MAX_SELECTOR_CHARS || value.chars().any(char::is_control) {
        return Err(CoreError::InvalidInput(format!(
            "{label}은(는) {MAX_SELECTOR_CHARS}자 이하 한 줄이어야 합니다"
        )));
    }
    Ok(Some(value.to_owned()))
}

// ---------------------------------------------------------------- 연결 확인

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct K8sNodeSummary {
    pub name: String,
    pub ready: bool,
    pub roles: Vec<String>,
    pub kubelet_version: String,
    pub architecture: String,
    pub internal_ip: String,
}

/// 권한 한 줄. SelfSubjectRulesReview 의 resourceRules 를 그대로 줄인 것이다.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct K8sAccessRule {
    pub verbs: Vec<String>,
    pub api_groups: Vec<String>,
    pub resources: Vec<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct K8sClusterCheckReceipt {
    pub id: String,
    pub server: String,
    pub reachable: bool,
    pub server_version: String,
    pub platform: String,
    pub nodes: Vec<K8sNodeSummary>,
    /// 권한을 물어본 네임스페이스.
    pub access_namespace: String,
    pub access: Vec<K8sAccessRule>,
    /// 모든 동사·모든 리소스 권한(cluster-admin 과 같은 폭)이 보이는지.
    pub broad_access: bool,
    pub message: String,
}

/// 한 번 붙어 버전·노드·권한을 읽는다. 클러스터에는 아무것도 남지 않는다. 화면의 확인
/// 버튼도 쓰므로 에이전트 사용 여부와 무관하게 돈다.
/// 에이전트 경로의 연결 확인. 화면 확인과 같은 일을 하되, 사용자가 에이전트 사용을 켠
/// 클러스터만 받는다(C22-3) — 노드 주소와 권한 표도 클러스터 정보다.
pub fn check_agent_k8s_cluster(
    app_data_dir: &Path,
    request: crate::k8s_clusters::K8sClusterRef,
) -> Result<K8sClusterCheckReceipt, CoreError> {
    agent_cluster_of(app_data_dir, &request.id)?;
    check_k8s_cluster(app_data_dir, request)
}

pub fn check_k8s_cluster(
    app_data_dir: &Path,
    request: crate::k8s_clusters::K8sClusterRef,
) -> Result<K8sClusterCheckReceipt, CoreError> {
    let cluster = cluster_of(app_data_dir, &request.id)?;
    let mut receipt = K8sClusterCheckReceipt {
        id: cluster.id.clone(),
        server: cluster.server.clone(),
        reachable: false,
        server_version: String::new(),
        platform: String::new(),
        nodes: Vec::new(),
        access_namespace: cluster
            .namespaces
            .first()
            .cloned()
            .unwrap_or_else(|| "default".to_owned()),
        access: Vec::new(),
        broad_access: false,
        message: String::new(),
    };
    let client = match K8sClient::connect(&cluster) {
        Ok(client) => client,
        Err(error) => {
            receipt.message = error.to_string();
            return Ok(receipt);
        }
    };
    match client.get_json("/version", &[]) {
        Ok(version) => {
            receipt.reachable = true;
            receipt.server_version = text_at(&version, "/gitVersion");
            receipt.platform = text_at(&version, "/platform");
        }
        Err(error) => {
            receipt.message = error.to_string();
            return Ok(receipt);
        }
    }
    let mut notes = Vec::new();
    match client.get_json("/api/v1/nodes", &[("limit", "50".to_owned())]) {
        Ok(list) => receipt.nodes = items(&list).iter().map(node_summary).collect(),
        Err(error) => notes.push(format!("노드 목록: {error}")),
    }
    let review = json!({
        "apiVersion": "authorization.k8s.io/v1",
        "kind": "SelfSubjectRulesReview",
        "spec": {"namespace": receipt.access_namespace},
    });
    match client.post_json(
        "/apis/authorization.k8s.io/v1/selfsubjectrulesreviews",
        &review,
    ) {
        Ok(result) => {
            receipt.access = result
                .pointer("/status/resourceRules")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(|rule| K8sAccessRule {
                    verbs: strings_at(rule, "/verbs"),
                    api_groups: strings_at(rule, "/apiGroups"),
                    resources: strings_at(rule, "/resources"),
                })
                .take(100)
                .collect();
            receipt.broad_access = receipt.access.iter().any(|rule| {
                rule.verbs.iter().any(|verb| verb == "*")
                    && rule.resources.iter().any(|resource| resource == "*")
            });
        }
        Err(error) => notes.push(format!("권한 확인: {error}")),
    }
    receipt.message = if notes.is_empty() {
        format!("{} 에 연결했습니다", receipt.server_version)
    } else {
        notes.join(" / ")
    };
    Ok(receipt)
}

fn node_summary(node: &Value) -> K8sNodeSummary {
    let ready = node
        .pointer("/status/conditions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .any(|condition| {
            condition.get("type").and_then(Value::as_str) == Some("Ready")
                && condition.get("status").and_then(Value::as_str) == Some("True")
        });
    let roles = node
        .pointer("/metadata/labels")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter_map(|(key, _)| key.strip_prefix("node-role.kubernetes.io/"))
        .map(str::to_owned)
        .collect();
    let internal_ip = node
        .pointer("/status/addresses")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|address| address.get("type").and_then(Value::as_str) == Some("InternalIP"))
        .map(|address| text_at(address, "/address"))
        .unwrap_or_default();
    K8sNodeSummary {
        name: text_at(node, "/metadata/name"),
        ready,
        roles,
        kubelet_version: text_at(node, "/status/nodeInfo/kubeletVersion"),
        architecture: text_at(node, "/status/nodeInfo/architecture"),
        internal_ip,
    }
}

// ---------------------------------------------------------------- 목록

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct K8sListRequest {
    pub cluster_id: String,
    pub kind: String,
    #[serde(default)]
    pub api_version: Option<String>,
    #[serde(default)]
    pub namespace: Option<String>,
    #[serde(default)]
    pub label_selector: Option<String>,
    #[serde(default)]
    pub field_selector: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct K8sResourceList {
    pub cluster_id: String,
    pub api_version: String,
    pub kind: String,
    /// 비어 있으면 전체 네임스페이스(또는 클러스터 소속 종류).
    pub namespace: String,
    /// 종류별로 줄인 요약. 전체 객체는 get_k8s_resource 로 읽는다.
    pub items: Vec<Value>,
    pub truncated: bool,
}

pub fn list_k8s_resources(
    app_data_dir: &Path,
    request: K8sListRequest,
) -> Result<K8sResourceList, CoreError> {
    let cluster = agent_cluster_of(app_data_dir, &request.cluster_id)?;
    list_k8s_resources_on(&cluster, &K8sClient::connect, request)
}

fn list_k8s_resources_on(
    cluster: &K8sClusterView,
    connect: &Connector,
    request: K8sListRequest,
) -> Result<K8sResourceList, CoreError> {
    let cluster = cluster.clone();
    let client = connect(&cluster)?;
    let resource = resolve_type(&client, &request.kind, request.api_version.as_deref())?;
    let namespace = scoped_namespace(&cluster, resource.namespaced, request.namespace.as_deref())?;
    let limit = request
        .limit
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_LIST_LIMIT)
        .min(MAX_LIST_LIMIT);
    let mut query = vec![("limit", limit.to_string())];
    if let Some(selector) = optional_text(request.label_selector.as_deref(), "labelSelector")? {
        query.push(("labelSelector", selector));
    }
    if let Some(selector) = optional_text(request.field_selector.as_deref(), "fieldSelector")? {
        query.push(("fieldSelector", selector));
    }
    let list = client.get_json(&resource.collection_path(namespace.as_deref()), &query)?;
    let truncated = list
        .pointer("/metadata/continue")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.is_empty());
    Ok(K8sResourceList {
        cluster_id: cluster.id,
        api_version: resource.api_version.clone(),
        kind: resource.kind.clone(),
        namespace: namespace.unwrap_or_default(),
        items: items(&list)
            .iter()
            .map(|item| summarize(&resource, item))
            .collect(),
        truncated,
    })
}

fn items(list: &Value) -> Vec<Value> {
    list.get("items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn text_at(value: &Value, pointer: &str) -> String {
    match value.pointer(pointer) {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(number)) => number.to_string(),
        Some(Value::Bool(flag)) => flag.to_string(),
        _ => String::new(),
    }
}

fn number_at(value: &Value, pointer: &str) -> i64 {
    value.pointer(pointer).and_then(Value::as_i64).unwrap_or(0)
}

fn strings_at(value: &Value, pointer: &str) -> Vec<String> {
    value
        .pointer(pointer)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

fn container_images(item: &Value, pointer: &str) -> Vec<String> {
    item.pointer(pointer)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|container| text_at(container, "/image"))
        .collect()
}

/// 종류별 요약 한 줄. kubectl get 의 기본 열과 비슷한 것만 남긴다.
fn summarize(resource: &ResourceType, item: &Value) -> Value {
    let mut row = Map::new();
    row.insert("name".to_owned(), json!(text_at(item, "/metadata/name")));
    let namespace = text_at(item, "/metadata/namespace");
    if !namespace.is_empty() {
        row.insert("namespace".to_owned(), json!(namespace));
    }
    row.insert(
        "created".to_owned(),
        json!(text_at(item, "/metadata/creationTimestamp")),
    );
    let extra = match (resource.api_version.as_str(), resource.kind.as_str()) {
        ("v1", "Pod") => {
            let statuses = item
                .pointer("/status/containerStatuses")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let ready = statuses
                .iter()
                .filter(|status| status.get("ready").and_then(Value::as_bool) == Some(true))
                .count();
            let restarts: i64 = statuses
                .iter()
                .map(|status| number_at(status, "/restartCount"))
                .sum();
            let waiting: Vec<String> = statuses
                .iter()
                .map(|status| text_at(status, "/state/waiting/reason"))
                .filter(|reason| !reason.is_empty())
                .collect();
            json!({
                "phase": text_at(item, "/status/phase"),
                "ready": format!("{ready}/{}", statuses.len()),
                "restarts": restarts,
                "waiting": waiting,
                "node": text_at(item, "/spec/nodeName"),
                "podIP": text_at(item, "/status/podIP"),
            })
        }
        ("apps/v1", "Deployment" | "StatefulSet" | "ReplicaSet") => json!({
            "replicas": number_at(item, "/spec/replicas"),
            "ready": number_at(item, "/status/readyReplicas"),
            "updated": number_at(item, "/status/updatedReplicas"),
            "available": number_at(item, "/status/availableReplicas"),
            "images": container_images(item, "/spec/template/spec/containers"),
        }),
        ("apps/v1", "DaemonSet") => json!({
            "desired": number_at(item, "/status/desiredNumberScheduled"),
            "ready": number_at(item, "/status/numberReady"),
            "images": container_images(item, "/spec/template/spec/containers"),
        }),
        ("v1", "Service") => json!({
            "type": text_at(item, "/spec/type"),
            "clusterIP": text_at(item, "/spec/clusterIP"),
            "ports": item.pointer("/spec/ports").and_then(Value::as_array).into_iter().flatten()
                .map(|port| format!("{}/{}", text_at(port, "/port"), text_at(port, "/protocol")))
                .collect::<Vec<_>>(),
        }),
        ("networking.k8s.io/v1", "Ingress") => json!({
            "hosts": item.pointer("/spec/rules").and_then(Value::as_array).into_iter().flatten()
                .map(|rule| text_at(rule, "/host")).collect::<Vec<_>>(),
            "class": text_at(item, "/spec/ingressClassName"),
        }),
        ("v1", "Node") => {
            let node = node_summary(item);
            json!({
                "ready": node.ready,
                "roles": node.roles,
                "version": node.kubelet_version,
                "architecture": node.architecture,
                "internalIP": node.internal_ip,
            })
        }
        ("batch/v1", "Job") => json!({
            "succeeded": number_at(item, "/status/succeeded"),
            "failed": number_at(item, "/status/failed"),
            "active": number_at(item, "/status/active"),
        }),
        ("batch/v1", "CronJob") => json!({
            "schedule": text_at(item, "/spec/schedule"),
            "suspend": item.pointer("/spec/suspend").and_then(Value::as_bool).unwrap_or(false),
            "lastSchedule": text_at(item, "/status/lastScheduleTime"),
        }),
        ("v1", "PersistentVolumeClaim") => json!({
            "phase": text_at(item, "/status/phase"),
            "capacity": text_at(item, "/status/capacity/storage"),
            "storageClass": text_at(item, "/spec/storageClassName"),
        }),
        ("v1", "Secret") => json!({
            "type": text_at(item, "/type"),
            "keys": object_keys(item, "/data"),
        }),
        ("v1", "ConfigMap") => json!({
            "keys": object_keys(item, "/data"),
        }),
        ("v1", "Namespace") => json!({
            "phase": text_at(item, "/status/phase"),
        }),
        _ => Value::Null,
    };
    if let Value::Object(extra) = extra {
        row.extend(extra);
    }
    Value::Object(row)
}

fn object_keys(item: &Value, pointer: &str) -> Vec<String> {
    item.pointer(pointer)
        .and_then(Value::as_object)
        .map(|map| map.keys().cloned().collect())
        .unwrap_or_default()
}

// ---------------------------------------------------------------- 객체 하나

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct K8sGetRequest {
    pub cluster_id: String,
    pub kind: String,
    #[serde(default)]
    pub api_version: Option<String>,
    #[serde(default)]
    pub namespace: Option<String>,
    pub name: String,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct K8sResourceReceipt {
    pub cluster_id: String,
    pub api_version: String,
    pub kind: String,
    pub namespace: String,
    pub name: String,
    pub object: Value,
    /// 가린 자리 수(Secret 값·비밀꼴 env 값).
    pub masked: usize,
    /// 크기 상한 때문에 status 를 뺐으면 참.
    pub status_omitted: bool,
}

pub fn get_k8s_resource(
    app_data_dir: &Path,
    request: K8sGetRequest,
) -> Result<K8sResourceReceipt, CoreError> {
    let cluster = agent_cluster_of(app_data_dir, &request.cluster_id)?;
    get_k8s_resource_on(&cluster, &K8sClient::connect, request)
}

fn get_k8s_resource_on(
    cluster: &K8sClusterView,
    connect: &Connector,
    request: K8sGetRequest,
) -> Result<K8sResourceReceipt, CoreError> {
    let cluster = cluster.clone();
    let name = validate_k8s_name(&request.name, "이름", MAX_RESOURCE_NAME_CHARS)?;
    let client = connect(&cluster)?;
    let resource = resolve_type(&client, &request.kind, request.api_version.as_deref())?;
    let namespace = scoped_namespace(&cluster, resource.namespaced, request.namespace.as_deref())?;
    if resource.namespaced && namespace.is_none() {
        return Err(CoreError::InvalidInput(format!(
            "{} 은(는) 네임스페이스 소속이라 namespace 가 필요합니다",
            resource.kind
        )));
    }
    let path = format!("{}/{name}", resource.collection_path(namespace.as_deref()));
    let mut object = client.get_json(&path, &[])?;
    let masked = sanitize_object(&mut object, resource.is_secret());
    let mut status_omitted = false;
    if serde_json::to_vec(&object)
        .map(|bytes| bytes.len())
        .unwrap_or(0)
        > MAX_OBJECT_BYTES
    {
        if let Some(map) = object.as_object_mut() {
            map.remove("status");
            status_omitted = true;
        }
        if serde_json::to_vec(&object)
            .map(|bytes| bytes.len())
            .unwrap_or(0)
            > MAX_OBJECT_BYTES
        {
            return Err(CoreError::InvalidInput(format!(
                "{} {name} 은(는) {}KB 를 넘어 돌려줄 수 없습니다",
                resource.kind,
                MAX_OBJECT_BYTES / 1024
            )));
        }
    }
    Ok(K8sResourceReceipt {
        cluster_id: cluster.id,
        api_version: resource.api_version,
        kind: resource.kind,
        namespace: namespace.unwrap_or_default(),
        name,
        object,
        masked,
        status_omitted,
    })
}

/// 객체에서 비밀값과 소음을 지우고, 가린 자리 수를 센다.
fn sanitize_object(object: &mut Value, is_secret: bool) -> usize {
    let mut masked = 0;
    if is_secret {
        for field in ["data", "stringData"] {
            if let Some(values) = object.get_mut(field).and_then(Value::as_object_mut) {
                for value in values.values_mut() {
                    let length = match value {
                        Value::String(text) if field == "data" => (text.len() / 4 * 3)
                            .saturating_sub(text.chars().rev().take_while(|c| *c == '=').count()),
                        Value::String(text) => text.len(),
                        _ => 0,
                    };
                    *value = json!(format!("<가려짐: {length}바이트>"));
                    masked += 1;
                }
            }
        }
    }
    masked + sanitize_nested_values(object)
}

/// 비밀값이 흔히 실리는 자리를 가린다.
///
/// - 이름이 비밀번호·토큰처럼 보이거나, 값이 계정이 든 URL(`postgres://u:p@…`)인 `{name, value}`
///   항목의 값. 컨테이너 `env` 가 이 모양이다.
/// - 컨테이너 `args`·`command` 안의 `--token=…`·`password: …` 꼴 값과, `--token` 다음 인자.
/// - 모든 객체의 `metadata` 에서 관리 필드와 원문이 담길 수 있는 적용 이력 주석(C22-7).
fn sanitize_nested_values(value: &mut Value) -> usize {
    match value {
        Value::Object(map) => {
            let mut masked = 0;
            if let Some(metadata) = map.get_mut("metadata").and_then(Value::as_object_mut) {
                metadata.remove("managedFields");
                if let Some(annotations) = metadata
                    .get_mut("annotations")
                    .and_then(Value::as_object_mut)
                {
                    if annotations
                        .remove("kubectl.kubernetes.io/last-applied-configuration")
                        .is_some()
                    {
                        masked += 1;
                    }
                }
            }
            let secretish = map
                .get("name")
                .and_then(Value::as_str)
                .map(str::to_ascii_uppercase)
                .is_some_and(|name| MASKED_ENV_NAME_PARTS.iter().any(|part| name.contains(part)));
            if let Some(slot) = map.get_mut("value") {
                let credential_url = slot.as_str().is_some_and(has_url_credentials);
                if slot.is_string() && (secretish || credential_url) {
                    *slot = json!("<가려짐>");
                    masked += 1;
                }
            }
            for key in ["args", "command"] {
                if let Some(Value::Array(items)) = map.get_mut(key) {
                    masked += mask_arguments(items);
                }
            }
            masked + map.values_mut().map(sanitize_nested_values).sum::<usize>()
        }
        Value::Array(values) => values.iter_mut().map(sanitize_nested_values).sum(),
        _ => 0,
    }
}

/// 인자 목록에서 비밀꼴 값을 가린다. `--token=x` 는 `=` 뒤만, `--token x` 는 다음 인자를 가린다.
fn mask_arguments(items: &mut [Value]) -> usize {
    let mut masked = 0;
    let mut mask_next = false;
    for item in items.iter_mut() {
        let Some(text) = item.as_str().map(str::to_owned) else {
            mask_next = false;
            continue;
        };
        if mask_next {
            *item = json!("<가려짐>");
            masked += 1;
            mask_next = false;
            continue;
        }
        if has_url_credentials(&text) {
            *item = json!("<가려짐>");
            masked += 1;
            continue;
        }
        let flag = text.trim_start_matches('-');
        let split = flag.find(['=', ':']);
        let (name, rest) = match split {
            Some(index) => (
                &flag[..index],
                Some(&text[text.len() - flag.len() + index + 1..]),
            ),
            None => (flag, None),
        };
        let upper = name.to_ascii_uppercase();
        if !MASKED_ENV_NAME_PARTS
            .iter()
            .any(|part| upper.contains(part))
            || name.contains(' ')
        {
            continue;
        }
        match rest {
            Some(value) if !value.trim().is_empty() => {
                let prefix = &text[..text.len() - value.len()];
                *item = json!(format!("{prefix}<가려짐>"));
                masked += 1;
            }
            Some(_) => {}
            None if text.starts_with('-') => mask_next = true,
            None => {}
        }
    }
    masked
}

/// `scheme://user:password@host` 처럼 URL 에 계정이 들어 있는지.
fn has_url_credentials(text: &str) -> bool {
    text.match_indices("://").any(|(index, _)| {
        let authority = text[index + 3..]
            .split(|c: char| c == '/' || c.is_whitespace())
            .next()
            .unwrap_or_default();
        authority
            .rsplit_once('@')
            .is_some_and(|(userinfo, _)| userinfo.contains(':'))
    })
}

// ---------------------------------------------------------------- 로그

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct K8sLogsRequest {
    pub cluster_id: String,
    pub namespace: String,
    pub pod: String,
    #[serde(default)]
    pub container: Option<String>,
    #[serde(default)]
    pub tail_lines: Option<u32>,
    #[serde(default)]
    pub since_seconds: Option<u32>,
    #[serde(default)]
    pub previous: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct K8sLogsReceipt {
    pub cluster_id: String,
    pub namespace: String,
    pub pod: String,
    pub container: String,
    pub text: String,
    pub truncated: bool,
}

pub fn get_k8s_logs(
    app_data_dir: &Path,
    request: K8sLogsRequest,
) -> Result<K8sLogsReceipt, CoreError> {
    let cluster = agent_cluster_of(app_data_dir, &request.cluster_id)?;
    get_k8s_logs_on(&cluster, &K8sClient::connect, request)
}

fn get_k8s_logs_on(
    cluster: &K8sClusterView,
    connect: &Connector,
    request: K8sLogsRequest,
) -> Result<K8sLogsReceipt, CoreError> {
    let cluster = cluster.clone();
    let namespace = scoped_namespace(&cluster, true, Some(&request.namespace))?
        .ok_or_else(|| CoreError::InvalidInput("로그에는 namespace 가 필요합니다".to_owned()))?;
    let pod = validate_k8s_name(&request.pod, "파드 이름", MAX_RESOURCE_NAME_CHARS)?;
    let container = request
        .container
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(|value| validate_k8s_name(value, "컨테이너 이름", MAX_NAMESPACE_CHARS))
        .transpose()?;
    let tail = request
        .tail_lines
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_TAIL_LINES)
        .min(MAX_TAIL_LINES);
    let mut query = vec![
        ("tailLines", tail.to_string()),
        ("limitBytes", MAX_LOG_BYTES.to_string()),
    ];
    if let Some(container) = container.as_ref() {
        query.push(("container", container.clone()));
    }
    if let Some(seconds) = request.since_seconds.filter(|value| *value > 0) {
        query.push(("sinceSeconds", seconds.to_string()));
    }
    if request.previous {
        query.push(("previous", "true".to_owned()));
    }
    let client = connect(&cluster)?;
    let path = format!("/api/v1/namespaces/{namespace}/pods/{pod}/log");
    let (raw, truncated) = client.get_text(&path, &query, MAX_LOG_BYTES)?;
    Ok(K8sLogsReceipt {
        cluster_id: cluster.id,
        namespace,
        pod,
        container: container.unwrap_or_default(),
        text: redact_log(&raw),
        truncated,
    })
}

/// 줄 모양은 그대로 두고 키 블록과 긴 토큰꼴 값만 지운다.
fn redact_log(text: &str) -> String {
    crate::ssh_output::strip_key_blocks(text)
        .lines()
        .map(redact_line)
        .collect::<Vec<_>>()
        .join("\n")
}

/// 한 줄에서 비밀꼴 값을 지운다. 공백으로만 자르는 SSH 규칙(C9)은 `"access_token":"…"`·
/// `token=….` 처럼 구두점에 붙은 값을 놓치므로, 그 규칙 뒤에 글자 집합의 연속 구간을 두 번 본다.
///
/// 1. `[A-Za-z0-9_-]` 와 `.` 의 구간이 점 셋 조각의 JWT 면 지운다(끝의 마침표는 남긴다).
/// 2. `[A-Za-z0-9+=_-]` 구간이 32자 이상이고, 전부 16진수이거나 대문자·소문자·숫자를 모두
///    담으면 지운다. 파드 이름·UUID 처럼 소문자와 숫자만 쓰는 이름은 남는다.
fn redact_line(line: &str) -> String {
    let line = crate::ssh_output::mask_long_tokens(line);
    let line = mask_runs(
        &line,
        |c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'),
        |run| {
            let body = run.trim_end_matches('.');
            let segments: Vec<&str> = body.split('.').collect();
            let jwt = body.len() >= 40
                && segments.len() == 3
                && segments[..2].iter().all(|segment| segment.len() >= 8);
            jwt.then(|| format!("[생략된 값]{}", &run[body.len()..]))
        },
    );
    mask_runs(
        &line,
        |c| c.is_ascii_alphanumeric() || matches!(c, '+' | '=' | '_' | '-'),
        |run| {
            let hex = run.chars().all(|c| c.is_ascii_hexdigit());
            let classes = [
                run.chars().any(|c| c.is_ascii_lowercase()),
                run.chars().any(|c| c.is_ascii_uppercase()),
                run.chars().any(|c| c.is_ascii_digit()),
            ];
            (run.len() >= 32 && (hex || classes.iter().all(|present| *present)))
                .then(|| "[생략된 값]".to_owned())
        },
    )
}

/// `member` 글자의 연속 구간마다 `replace` 를 물어 바꾼다. 다른 글자는 그대로 둔다.
fn mask_runs(
    line: &str,
    member: impl Fn(char) -> bool,
    replace: impl Fn(&str) -> Option<String>,
) -> String {
    let mut output = String::with_capacity(line.len());
    let mut run = String::new();
    let flush = |run: &mut String, output: &mut String| {
        match replace(run) {
            Some(replacement) => output.push_str(&replacement),
            None => output.push_str(run),
        }
        run.clear();
    };
    for value in line.chars() {
        if member(value) {
            run.push(value);
        } else {
            flush(&mut run, &mut output);
            output.push(value);
        }
    }
    flush(&mut run, &mut output);
    output
}

// ---------------------------------------------------------------- 이벤트

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct K8sEventsRequest {
    pub cluster_id: String,
    #[serde(default)]
    pub namespace: Option<String>,
    /// 이 이름의 객체에 대한 이벤트만.
    #[serde(default)]
    pub involved_name: Option<String>,
    #[serde(default)]
    pub involved_kind: Option<String>,
    /// Normal 은 빼고 Warning 만.
    #[serde(default)]
    pub warnings_only: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct K8sEventRow {
    pub last_seen: String,
    pub r#type: String,
    pub reason: String,
    pub object: String,
    pub namespace: String,
    pub count: i64,
    pub message: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct K8sEventsReceipt {
    pub cluster_id: String,
    pub namespace: String,
    pub events: Vec<K8sEventRow>,
    pub truncated: bool,
}

pub fn get_k8s_events(
    app_data_dir: &Path,
    request: K8sEventsRequest,
) -> Result<K8sEventsReceipt, CoreError> {
    let cluster = agent_cluster_of(app_data_dir, &request.cluster_id)?;
    get_k8s_events_on(&cluster, &K8sClient::connect, request)
}

fn get_k8s_events_on(
    cluster: &K8sClusterView,
    connect: &Connector,
    request: K8sEventsRequest,
) -> Result<K8sEventsReceipt, CoreError> {
    let cluster = cluster.clone();
    let namespace = scoped_namespace(&cluster, true, request.namespace.as_deref())?;
    let mut selectors = Vec::new();
    if let Some(name) = request
        .involved_name
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        selectors.push(format!(
            "involvedObject.name={}",
            validate_k8s_name(name, "대상 이름", MAX_RESOURCE_NAME_CHARS)?
        ));
    }
    if let Some(kind) = request
        .involved_kind
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        if !kind.chars().all(|c| c.is_ascii_alphanumeric()) {
            return Err(CoreError::InvalidInput(format!(
                "종류 이름이 아닙니다: {kind}"
            )));
        }
        selectors.push(format!("involvedObject.kind={kind}"));
    }
    if request.warnings_only {
        selectors.push("type=Warning".to_owned());
    }
    let mut query = vec![("limit", "500".to_owned())];
    if !selectors.is_empty() {
        query.push(("fieldSelector", selectors.join(",")));
    }
    let path = match namespace.as_deref() {
        Some(namespace) => format!("/api/v1/namespaces/{namespace}/events"),
        None => "/api/v1/events".to_owned(),
    };
    let client = connect(&cluster)?;
    let list = client.get_json(&path, &query)?;
    let mut events: Vec<K8sEventRow> = items(&list).iter().map(event_row).collect();
    events.sort_by(|left, right| right.last_seen.cmp(&left.last_seen));
    // 서버가 다 주지 못한 이벤트가 남았으면, 정렬한 100개가 가장 최근이라는 보장이 없다.
    let more_on_server = list
        .pointer("/metadata/continue")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.is_empty());
    let truncated = more_on_server || events.len() > MAX_EVENTS;
    events.truncate(MAX_EVENTS);
    Ok(K8sEventsReceipt {
        cluster_id: cluster.id,
        namespace: namespace.unwrap_or_default(),
        events,
        truncated,
    })
}

fn event_row(event: &Value) -> K8sEventRow {
    let last_seen = [
        "/lastTimestamp",
        "/eventTime",
        "/series/lastObservedTime",
        "/metadata/creationTimestamp",
    ]
    .iter()
    .map(|pointer| text_at(event, pointer))
    .find(|value| !value.is_empty())
    .unwrap_or_default();
    K8sEventRow {
        last_seen,
        r#type: text_at(event, "/type"),
        reason: text_at(event, "/reason"),
        object: format!(
            "{}/{}",
            text_at(event, "/involvedObject/kind"),
            text_at(event, "/involvedObject/name")
        ),
        namespace: text_at(event, "/metadata/namespace"),
        count: number_at(event, "/count").max(1),
        message: redact_line(&text_at(event, "/message")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db_connections::DbEnvironment;
    use crate::k8s_clusters::K8sAuthKind;

    fn cluster(namespaces: &[&str]) -> K8sClusterView {
        K8sClusterView {
            id: "oci".to_owned(),
            display_name: "oci".to_owned(),
            environment: DbEnvironment::Dev,
            server: "https://k3s.example:6443".to_owned(),
            ca_pem: String::new(),
            ca_fingerprint: String::new(),
            auth_kind: K8sAuthKind::Token,
            credential_stored_at: Some(1),
            agent_enabled: true,
            namespaces: namespaces.iter().map(|value| (*value).to_owned()).collect(),
            note: String::new(),
            updated_at: 1,
        }
    }

    /// 127.0.0.1 에 뜨는 가짜 API 서버. 경로 접두사로 응답을 고르고, 받은 요청 줄과
    /// Authorization 헤더를 남긴다.
    struct FakeApi {
        base: String,
        seen: std::sync::Arc<std::sync::Mutex<Vec<(String, String)>>>,
    }

    fn fake_api(routes: Vec<(&'static str, u16, String)>) -> FakeApi {
        use std::io::{BufRead as _, BufReader, Write as _};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let base = format!("http://{}", listener.local_addr().expect("addr"));
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let log = seen.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let mut reader = BufReader::new(stream.try_clone().expect("clone"));
                let mut line = String::new();
                if reader.read_line(&mut line).is_err() {
                    continue;
                }
                let target = line.split(' ').nth(1).unwrap_or_default().to_owned();
                let mut authorization = String::new();
                let mut length = 0usize;
                loop {
                    let mut header = String::new();
                    if reader.read_line(&mut header).is_err() || header.trim().is_empty() {
                        break;
                    }
                    let lower = header.to_ascii_lowercase();
                    if lower.starts_with("authorization:") {
                        authorization = header["authorization:".len()..].trim().to_owned();
                    }
                    if let Some(value) = lower.strip_prefix("content-length:") {
                        length = value.trim().parse().unwrap_or(0);
                    }
                }
                let mut body = vec![0u8; length];
                let _ = std::io::Read::read_exact(&mut reader, &mut body);
                log.lock()
                    .expect("log")
                    .push((target.clone(), authorization));
                let path = target.split('?').next().unwrap_or_default();
                let (status, response) = routes
                    .iter()
                    .filter(|(prefix, ..)| {
                        path == *prefix || path.starts_with(&format!("{prefix}/"))
                    })
                    .max_by_key(|(prefix, ..)| prefix.len())
                    .map(|(_, status, body)| (*status, body.clone()))
                    .unwrap_or((404, r#"{"kind":"Status","message":"not found"}"#.to_owned()));
                let _ = write!(
                    stream,
                    "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",
                    response.len()
                );
            }
        });
        FakeApi { base, seen }
    }

    fn connect_fake(cluster: &K8sClusterView) -> Result<K8sClient, CoreError> {
        K8sClient::with_credential(
            cluster,
            &crate::k8s_clusters::K8sCredential {
                token: Some("test-token-value".to_owned()),
                ..Default::default()
            },
        )
    }

    fn fake_cluster(api: &FakeApi, namespaces: &[&str]) -> K8sClusterView {
        K8sClusterView {
            server: api.base.clone(),
            ..cluster(namespaces)
        }
    }

    #[test]
    fn c22_8_list_sends_bearer_scope_and_encoded_selector() {
        let api = fake_api(vec![(
            "/api/v1/namespaces/qa-lite/pods",
            200,
            json!({"items": [{"metadata": {"name": "qa-lite-1", "namespace": "qa-lite"}, "status": {"phase": "Running"}}], "metadata": {"continue": "abc"}}).to_string(),
        )]);
        let cluster = fake_cluster(&api, &["qa-lite"]);
        let list = list_k8s_resources_on(
            &cluster,
            &connect_fake,
            K8sListRequest {
                cluster_id: "oci".to_owned(),
                kind: "po".to_owned(),
                api_version: None,
                namespace: Some("qa-lite".to_owned()),
                label_selector: Some("app=qa-lite,tier in (web)".to_owned()),
                field_selector: None,
                limit: Some(9999),
            },
        )
        .expect("list");
        assert_eq!(list.items[0]["phase"], "Running");
        assert!(list.truncated);
        let seen = api.seen.lock().expect("seen");
        let (target, authorization) = &seen[0];
        assert!(target.starts_with("/api/v1/namespaces/qa-lite/pods?limit=500&labelSelector=app%3Dqa-lite%2Ctier+in+%28web%29"), "{target}");
        assert_eq!(authorization, "Bearer test-token-value");
        drop(seen);
        // 범위 밖 네임스페이스는 서버에 묻기 전에 거절된다.
        let error = list_k8s_resources_on(
            &cluster,
            &connect_fake,
            K8sListRequest {
                cluster_id: "oci".to_owned(),
                kind: "secrets".to_owned(),
                api_version: None,
                namespace: Some("kube-system".to_owned()),
                label_selector: None,
                field_selector: None,
                limit: None,
            },
        )
        .expect_err("outside scope");
        assert!(error.to_string().contains("범위"));
        assert_eq!(api.seen.lock().expect("seen").len(), 1);
    }

    #[test]
    fn c22_7_secret_read_end_to_end_never_returns_values() {
        let api = fake_api(vec![(
            "/api/v1/namespaces/qa-lite/secrets/db",
            200,
            json!({"apiVersion": "v1", "kind": "Secret", "metadata": {"name": "db"}, "data": {"password": "aHVudGVyMg=="}}).to_string(),
        )]);
        let receipt = get_k8s_resource_on(
            &fake_cluster(&api, &[]),
            &connect_fake,
            K8sGetRequest {
                cluster_id: "oci".to_owned(),
                kind: "Secret".to_owned(),
                api_version: None,
                namespace: Some("qa-lite".to_owned()),
                name: "db".to_owned(),
            },
        )
        .expect("get");
        assert_eq!(receipt.masked, 1);
        assert!(!serde_json::to_string(&receipt)
            .expect("json")
            .contains("aHVudGVyMg"));
    }

    #[test]
    fn c22_7_get_redacts_nested_template_and_array_metadata() {
        let metadata = json!({
            "labels": {"app": "web"},
            "managedFields": [{"manager": "kubectl"}],
            "annotations": {
                "kubectl.kubernetes.io/last-applied-configuration": "nested-sensitive-value",
                "example.com/note": "keep"
            }
        });
        let api = fake_api(vec![(
            "/apis/apps/v1/namespaces/qa-lite/statefulsets/web",
            200,
            json!({
                "apiVersion": "apps/v1", "kind": "StatefulSet",
                "metadata": metadata.clone(),
                "spec": {
                    "template": {
                        "metadata": metadata.clone(),
                        "spec": {"containers": [{"name": "web", "env": [
                            {"name": "APP_TOKEN", "value": "env-sensitive-value"},
                            {"name": "MODE", "value": "production"}
                        ]}]}
                    },
                    "volumeClaimTemplates": [{"metadata": metadata, "spec": {"storageClassName": "fast"}}]
                }
            }).to_string(),
        )]);
        let receipt = get_k8s_resource_on(
            &fake_cluster(&api, &[]),
            &connect_fake,
            K8sGetRequest {
                cluster_id: "oci".to_owned(),
                kind: "StatefulSet".to_owned(),
                api_version: None,
                namespace: Some("qa-lite".to_owned()),
                name: "web".to_owned(),
            },
        )
        .expect("get");
        let text = serde_json::to_string(&receipt).expect("receipt");
        assert!(!text.contains("nested-sensitive-value"));
        assert!(!text.contains("env-sensitive-value"));
        assert!(!text.contains("managedFields"));
        assert_eq!(receipt.masked, 4);
        for path in [
            "/metadata",
            "/spec/template/metadata",
            "/spec/volumeClaimTemplates/0/metadata",
        ] {
            let metadata = receipt.object.pointer(path).expect("metadata preserved");
            assert_eq!(metadata["labels"]["app"], "web");
            assert_eq!(metadata["annotations"]["example.com/note"], "keep");
        }
        assert_eq!(
            receipt.object["spec"]["volumeClaimTemplates"][0]["spec"]["storageClassName"],
            "fast"
        );
        assert_eq!(
            receipt.object["spec"]["template"]["spec"]["containers"][0]["env"][1]["value"],
            "production"
        );
    }

    #[test]
    fn c22_9_logs_are_capped_and_redacted_and_rbac_errors_explain_themselves() {
        let jwt = "eyJhbGciOiJSUzI1NiIsImtpZCI6IjEyMyJ9.eyJzdWIiOiJzeXN0ZW0.c2lnbmF0dXJl";
        let api = fake_api(vec![
            ("/api/v1/namespaces/qa-lite/pods/web-1/log", 200, format!("boot\ntoken={jwt}\nready")),
            (
                "/api/v1/namespaces/qa-lite/pods/web-2/log",
                403,
                json!({"kind": "Status", "message": "pods \"web-2\" is forbidden: User \"system:serviceaccount:qa-lite:am\" cannot get resource \"pods/log\""}).to_string(),
            ),
        ]);
        let cluster = fake_cluster(&api, &[]);
        let logs = |pod: &str| {
            get_k8s_logs_on(
                &cluster,
                &connect_fake,
                K8sLogsRequest {
                    cluster_id: "oci".to_owned(),
                    namespace: "qa-lite".to_owned(),
                    pod: pod.to_owned(),
                    container: None,
                    tail_lines: None,
                    since_seconds: None,
                    previous: true,
                },
            )
        };
        let receipt = logs("web-1").expect("logs");
        assert_eq!(receipt.text.lines().count(), 3);
        assert!(!receipt.text.contains(jwt));
        let target = api.seen.lock().expect("seen")[0].0.clone();
        assert!(
            target.contains("tailLines=200")
                && target.contains("limitBytes=262144")
                && target.contains("previous=true"),
            "{target}"
        );
        let error = logs("web-2").expect_err("forbidden");
        let message = error.to_string();
        assert!(
            message.contains("403") && message.contains("RBAC"),
            "{message}"
        );
        assert!(!message.contains("test-token-value"));
    }

    #[test]
    fn c22_5_unknown_kinds_are_found_through_discovery() {
        let api = fake_api(vec![
            ("/apis", 200, json!({"groups": [{"preferredVersion": {"groupVersion": "traefik.io/v1alpha1"}}]}).to_string()),
            (
                "/apis/traefik.io/v1alpha1",
                200,
                json!({"resources": [{"name": "ingressroutes", "singularName": "ingressroute", "kind": "IngressRoute", "namespaced": true}]}).to_string(),
            ),
            ("/apis/traefik.io/v1alpha1/namespaces/qa-lite/ingressroutes", 200, json!({"items": []}).to_string()),
        ]);
        let list = list_k8s_resources_on(
            &fake_cluster(&api, &[]),
            &connect_fake,
            K8sListRequest {
                cluster_id: "oci".to_owned(),
                kind: "IngressRoute".to_owned(),
                api_version: None,
                namespace: Some("qa-lite".to_owned()),
                label_selector: None,
                field_selector: None,
                limit: None,
            },
        )
        .expect("discovered");
        assert_eq!(list.api_version, "traefik.io/v1alpha1");
        assert_eq!(list.kind, "IngressRoute");
    }

    #[test]
    fn c22_5_builtin_kinds_resolve_to_api_paths() {
        let deployment = builtin_type("deploy", None).expect("alias");
        assert_eq!(
            deployment.collection_path(Some("qa-lite")),
            "/apis/apps/v1/namespaces/qa-lite/deployments"
        );
        let node = builtin_type("Node", None).expect("case-insensitive");
        assert_eq!(node.collection_path(Some("ignored")), "/api/v1/nodes");
        assert!(builtin_type("deployment", Some("apps/v1beta1")).is_none());
        assert!(builtin_type("ingressroute", None).is_none());
    }

    #[test]
    fn c22_5_discovery_matches_kind_plural_singular_and_short_names() {
        let list = json!({"resources": [
            {"name": "ingressroutes", "singularName": "ingressroute", "kind": "IngressRoute", "namespaced": true, "shortNames": ["ir"]},
            {"name": "ingressroutes/status", "kind": "IngressRoute", "namespaced": true},
        ]});
        for wanted in ["ingressroute", "ingressroutes", "ir"] {
            let found = match_resource(&list, "traefik.io/v1alpha1", wanted).expect(wanted);
            assert_eq!(
                found.collection_path(Some("x")),
                "/apis/traefik.io/v1alpha1/namespaces/x/ingressroutes"
            );
        }
        assert!(match_resource(&list, "traefik.io/v1alpha1", "status").is_none());
    }

    #[test]
    fn c22_6_namespace_scope_is_enforced_for_namespaced_kinds_only() {
        let open = cluster(&[]);
        assert_eq!(scoped_namespace(&open, true, None).expect("all"), None);
        let scoped = cluster(&["qa-lite", "money-note"]);
        assert_eq!(
            scoped_namespace(&scoped, true, Some("qa-lite")).expect("inside"),
            Some("qa-lite".to_owned())
        );
        assert!(scoped_namespace(&scoped, true, Some("kube-system")).is_err());
        assert!(scoped_namespace(&scoped, true, None).is_err());
        assert_eq!(
            scoped_namespace(&scoped, false, Some("kube-system")).expect("node"),
            None
        );
        assert!(scoped_namespace(&open, true, Some("../x")).is_err());
    }

    #[test]
    fn c22_7_secret_values_last_applied_and_secretish_env_are_masked() {
        let mut secret = json!({
            "metadata": {
                "name": "db",
                "managedFields": [{"manager": "kubectl"}],
                "annotations": {"kubectl.kubernetes.io/last-applied-configuration": "{\"data\":{\"password\":\"aHVudGVyMg==\"}}"}
            },
            "data": {"password": "aHVudGVyMg==", "user": "YWRtaW4="},
            "stringData": {"extra": "plain"}
        });
        let masked = sanitize_object(&mut secret, true);
        let text = secret.to_string();
        assert!(!text.contains("aHVudGVyMg"));
        assert!(!text.contains("plain"));
        assert!(!text.contains("managedFields"));
        assert_eq!(secret["data"]["password"], "<가려짐: 7바이트>");
        assert_eq!(masked, 4);

        let mut deployment = json!({"spec": {"template": {"spec": {"containers": [{"env": [
            {"name": "DB_PASSWORD", "value": "hunter2"},
            {"name": "SPRING_PROFILES_ACTIVE", "value": "prod"},
            {"name": "API_TOKEN", "valueFrom": {"secretKeyRef": {"name": "t", "key": "k"}}}
        ]}]}}}});
        assert_eq!(sanitize_object(&mut deployment, false), 1);
        let text = deployment.to_string();
        assert!(!text.contains("hunter2"));
        assert!(text.contains("prod"));
        assert!(text.contains("secretKeyRef"));
    }

    #[test]
    fn c22_8_pod_and_deployment_rows_carry_the_kubectl_columns() {
        let pod = builtin_type("pod", None).expect("pod");
        let row = summarize(
            &pod,
            &json!({
                "metadata": {"name": "qa-lite-7c9", "namespace": "qa-lite", "creationTimestamp": "2026-11-10T00:00:00Z"},
                "spec": {"nodeName": "oci-a1"},
                "status": {"phase": "Running", "podIP": "10.42.0.7", "containerStatuses": [
                    {"ready": true, "restartCount": 2, "state": {"running": {}}},
                    {"ready": false, "restartCount": 1, "state": {"waiting": {"reason": "CrashLoopBackOff"}}}
                ]}
            }),
        );
        assert_eq!(row["ready"], "1/2");
        assert_eq!(row["restarts"], 3);
        assert_eq!(row["waiting"][0], "CrashLoopBackOff");
        let secret = builtin_type("secret", None).expect("secret");
        let row = summarize(
            &secret,
            &json!({"metadata": {"name": "s"}, "type": "Opaque", "data": {"a": "eA=="}}),
        );
        assert_eq!(row["keys"][0], "a");
        assert!(!row.to_string().contains("eA=="));
    }

    #[test]
    fn c22_9_log_lines_keep_shape_but_lose_tokens() {
        let token = "eyJhbGciOiJSUzI1NiIsImtpZCI6IjEyMyJ9.eyJzdWIiOiJzeXN0ZW0.c2lnbmF0dXJl";
        let text = format!("start\nAuthorization: Bearer {token}\nok");
        let redacted = redact_log(&text);
        assert_eq!(redacted.lines().count(), 3);
        assert!(!redacted.contains(token));
        assert!(redacted.starts_with("start"));
        // 점으로 이은 평범한 이름은 남긴다.
        assert_eq!(
            redact_line("pulled registry.example.com/qa-lite:18af69c"),
            "pulled registry.example.com/qa-lite:18af69c"
        );
    }

    /// 리뷰가 찾은 구멍: 구두점에 붙은 OAuth 토큰, 마침표로 끝나는 JWT, JSON 안의 16진수 키.
    #[test]
    fn c22_8_tokens_glued_to_punctuation_are_masked_but_names_survive() {
        let oauth = format!("ya29.a0AfH6SMB{}", "Xy9".repeat(30));
        let jwt = "eyJhbGciOiJSUzI1NiIsImtpZCI6IjEyMyJ9.eyJzdWIiOiJzeXN0ZW0.c2lnbmF0dXJl";
        let hex = "a3f9".repeat(16);
        for (line, secret) in [
            (format!("{{\"access_token\":\"{oauth}\"}}"), oauth.as_str()),
            (format!("using {jwt}."), jwt),
            (format!("{{\"apiKey\":\"{hex}\"}}"), hex.as_str()),
        ] {
            let redacted = redact_line(&line);
            assert!(
                !redacted.contains(&secret[secret.len() - 20..]),
                "{redacted}"
            );
        }
        assert!(redact_line(&format!("using {jwt}.")).ends_with('.'));
        for keep in [
            "pod qa-lite-7c9f8d6b5-x2k9p restarted",
            "request 550e8400-e29b-41d4-a716-446655440000 done",
            "SPRING_PROFILES_ACTIVE=production",
        ] {
            assert_eq!(redact_line(keep), keep);
        }
    }

    #[test]
    fn c22_7_credential_urls_and_secret_arguments_are_masked() {
        let mut pod = json!({"spec": {"containers": [{
            "env": [
                {"name": "DATABASE_URL", "value": "postgres://app:hunter2@db:5432/app"},
                {"name": "DB_PASS", "value": "hunter3"},
                {"name": "PUBLIC_URL", "value": "https://app.example.com"}
            ],
            "args": ["--token=abc123", "--password", "hunter4", "--port=8080", "redis://:hunter5@cache:6379"],
            "command": ["/app"]
        }]}});
        let masked = sanitize_object(&mut pod, false);
        let text = pod.to_string();
        for secret in ["hunter2", "hunter3", "abc123", "hunter4", "hunter5"] {
            assert!(!text.contains(secret), "{secret}: {text}");
        }
        assert!(text.contains("https://app.example.com"));
        assert!(text.contains("--port=8080"));
        assert!(text.contains("--token=<가려짐>"));
        assert_eq!(masked, 5);
    }

    #[test]
    fn c22_4_api_versions_cannot_climb_out_of_the_api_prefix() {
        let api = fake_api(vec![]);
        let client = connect_fake(&fake_cluster(&api, &[])).expect("client");
        for bad in ["../..", "./v1", "apps/..", "a..b/v1", "/v1"] {
            let error = resolve_type(&client, "thing", Some(bad)).expect_err(bad);
            assert!(error.to_string().contains("apiVersion"), "{bad}: {error}");
        }
        assert!(api.seen.lock().expect("seen").is_empty());
    }

    #[test]
    fn c22_9_event_rows_prefer_last_timestamp_and_mask_tokens() {
        let row = event_row(&json!({
            "type": "Warning", "reason": "BackOff", "count": 4,
            "lastTimestamp": "2026-11-10T01:00:00Z",
            "metadata": {"namespace": "qa-lite", "creationTimestamp": "2026-11-09T00:00:00Z"},
            "involvedObject": {"kind": "Pod", "name": "qa-lite-7c9"},
            "message": "Back-off restarting failed container"
        }));
        assert_eq!(row.last_seen, "2026-11-10T01:00:00Z");
        assert_eq!(row.object, "Pod/qa-lite-7c9");
        assert_eq!(row.count, 4);
    }
}
