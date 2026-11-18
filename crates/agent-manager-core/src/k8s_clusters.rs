//! C22-1~C22-4: Kubernetes 클러스터 등록·자격증명·에이전트 공개 목록.
//!
//! # 왜 앱이 클러스터 자격증명을 쥐는가
//!
//! kubeconfig 를 에이전트 셸에 두면 그 에이전트는 `kubectl` 로 무엇이든 바꿀 수 있고, 앱의
//! 범위 제한·마스킹은 지나쳐진다. 데이터베이스(C10)와 같은 이유다 — 에이전트에게는 클러스터
//! id 와 리소스 이름만 받고, API 호출은 언제나 앱이 한다.
//!
//! # 저장하는 것
//!
//! - 앱 데이터 JSON: 이름·환경·API 서버 주소·CA 인증서(공개 정보)·인증 종류·네임스페이스
//!   범위·에이전트 사용 여부. 비밀값은 없다.
//! - OS 보안 저장소: Bearer 토큰, 또는 클라이언트 인증서와 개인키 한 벌. 값은 어느 응답·
//!   로그·영수증에도 실리지 않는다.
//!
//! kubeconfig 는 등록할 때 한 번 해석하고 버린다. 파일 경로를 가리키는 항목(`certificate-
//! authority`, `client-key` 등)과 다른 프로그램을 띄우는 `exec`·`auth-provider` 는 받지
//! 않는다 — 앱이 사용자 파일을 계속 따라 읽거나 임의 실행 파일을 부르게 되기 때문이다.

use std::path::Path;

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::clock::now_ms;
use crate::db_connections::DbEnvironment;
use crate::domain::wire_enum;
use crate::json_store::{JsonStore, SchemaVersioned};
use crate::CoreError;

const STORE_VERSION: u32 = 1;
const STORE: JsonStore = JsonStore {
    file: "k8s-clusters-v1.json",
    lock_file: "k8s-clusters-v1.lock",
    label: "Kubernetes 클러스터 저장소",
    version: STORE_VERSION,
};

/// 토큰·클라이언트 키를 두는 OS 보안 저장소의 서비스명. 데이터베이스와 이름공간을 나눈다.
pub(crate) const K8S_KEYCHAIN_SERVICE: &str = "Agent Manager Kubernetes";

const MAX_CLUSTERS: usize = 32;
const MAX_NAME_CHARS: usize = 60;
const MAX_SERVER_CHARS: usize = 400;
const MAX_KUBECONFIG_BYTES: usize = 128 * 1024;
const MAX_PEM_BYTES: usize = 32 * 1024;
const MAX_TOKEN_CHARS: usize = 8 * 1024;
const MAX_NAMESPACES: usize = 64;
/// Kubernetes 이름(DNS-1123 label)의 길이 상한.
pub(crate) const MAX_NAMESPACE_CHARS: usize = 63;

/// 앱이 클러스터에 자신을 알리는 방법.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum K8sAuthKind {
    /// ServiceAccount 토큰 같은 Bearer 토큰.
    Token,
    /// 클라이언트 인증서와 개인키(k3s 기본 kubeconfig 가 이 모양이다).
    ClientCertificate,
}

wire_enum!(choices K8sAuthKind, "알 수 없는 인증 방식입니다", {
    Token => "token",
    ClientCertificate => "clientCertificate" | "client_certificate",
});

/// 클러스터 하나. 저장본과 화면 표시가 같은 모양이다. 비밀값은 어느 필드에도 없다.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct K8sClusterView {
    pub id: String,
    pub display_name: String,
    /// 데이터베이스와 같은 네 갈래. 운영 클러스터는 이후 쓰기 작업을 열지 않는 근거가 된다.
    pub environment: DbEnvironment,
    /// API 서버 주소(`https://…:6443`). 경로가 붙은 프록시 주소도 받는다.
    pub server: String,
    /// 서버 인증서를 검증할 CA 묶음(PEM). 비어 있으면 OS 기본 신뢰 저장소를 쓴다.
    #[serde(default)]
    pub ca_pem: String,
    /// CA 첫 인증서의 SHA-256 지문(콜론 구분 16진수). 사용자가 서버 쪽 값과 대조한다.
    #[serde(default)]
    pub ca_fingerprint: String,
    pub auth_kind: K8sAuthKind,
    /// 자격증명을 저장한 시각. 값은 OS 보안 저장소에만 있다.
    #[serde(default)]
    pub credential_stored_at: Option<i64>,
    #[serde(default)]
    pub agent_enabled: bool,
    /// 에이전트가 읽을 수 있는 네임스페이스. 비어 있으면 제한하지 않는다.
    #[serde(default)]
    pub namespaces: Vec<String>,
    #[serde(default)]
    pub note: String,
    pub updated_at: i64,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct K8sClustersSnapshot {
    pub schema_version: u32,
    pub clusters: Vec<K8sClusterView>,
    pub issues: Vec<String>,
    pub defaults: K8sClusterDefaults,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct K8sClusterDefaults {
    pub environments: Vec<String>,
    pub auth_kinds: Vec<String>,
}

fn owned(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_owned()).collect()
}

pub fn cluster_defaults() -> K8sClusterDefaults {
    K8sClusterDefaults {
        environments: owned(DbEnvironment::WIRE_CHOICES),
        auth_kinds: owned(K8sAuthKind::WIRE_CHOICES),
    }
}

/// 클러스터 저장 요청. kubeconfig 를 주면 그 안의 서버·CA·자격증명이 개별 칸보다 앞선다.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetK8sClusterRequest {
    /// 비어 있으면 새 클러스터를 만든다.
    #[serde(default)]
    pub id: String,
    pub display_name: String,
    #[serde(default)]
    pub environment: String,
    /// 붙여 넣은 kubeconfig 원문. 저장하지 않고 해석만 한다.
    #[serde(default)]
    pub kubeconfig: Option<String>,
    /// kubeconfig 에서 고를 context. 비어 있으면 current-context, 그것도 없으면 유일한 것.
    #[serde(default)]
    pub context: String,
    #[serde(default)]
    pub server: String,
    #[serde(default)]
    pub ca_pem: String,
    #[serde(default)]
    pub auth_kind: String,
    #[serde(default)]
    pub token: Option<String>,
    #[serde(default)]
    pub client_certificate_pem: Option<String>,
    #[serde(default)]
    pub client_key_pem: Option<String>,
    #[serde(default)]
    pub namespaces: Vec<String>,
    #[serde(default)]
    pub note: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct K8sClusterRef {
    pub id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetK8sClusterEnabledRequest {
    pub id: String,
    pub enabled: bool,
}

/// 에이전트가 읽는 목록의 한 줄. 접속 방법이 아니라 무엇이 열려 있고 어디까지인지를 싣는다.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentK8sClusterView {
    pub id: String,
    pub display_name: String,
    pub environment: DbEnvironment,
    pub server: String,
    pub namespaces: Vec<String>,
    pub note: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentK8sClusterSkip {
    pub id: String,
    pub reason: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentK8sClustersView {
    pub schema_version: u32,
    pub clusters: Vec<AgentK8sClusterView>,
    pub skipped: Vec<AgentK8sClusterSkip>,
    pub issues: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct K8sClusterStore {
    schema_version: u32,
    #[serde(default)]
    clusters: Vec<K8sClusterView>,
}

impl Default for K8sClusterStore {
    fn default() -> Self {
        Self {
            schema_version: STORE_VERSION,
            clusters: Vec::new(),
        }
    }
}

impl SchemaVersioned for K8sClusterStore {
    fn schema_version(&self) -> u32 {
        self.schema_version
    }
}

impl K8sClusterStore {
    fn cluster_mut(&mut self, id: &str) -> Result<&mut K8sClusterView, CoreError> {
        self.clusters
            .iter_mut()
            .find(|cluster| cluster.id == id)
            .ok_or_else(|| cluster_not_found(id))
    }
}

fn cluster_not_found(id: &str) -> CoreError {
    CoreError::NotFound(format!("등록되지 않은 Kubernetes 클러스터입니다: {id}"))
}

fn snapshot_from(store: K8sClusterStore) -> K8sClustersSnapshot {
    let mut clusters = store.clusters;
    clusters.sort_by(|left, right| left.display_name.cmp(&right.display_name));
    K8sClustersSnapshot {
        schema_version: STORE_VERSION,
        clusters,
        issues: Vec::new(),
        defaults: cluster_defaults(),
    }
}

pub fn get_k8s_clusters(app_data_dir: &Path) -> Result<K8sClustersSnapshot, CoreError> {
    let store: K8sClusterStore = STORE.read(app_data_dir)?;
    Ok(snapshot_from(store))
}

/// 저장본에서 클러스터 하나. 실행 경로가 정책을 다시 읽는 지점이다.
pub(crate) fn cluster_of(app_data_dir: &Path, id: &str) -> Result<K8sClusterView, CoreError> {
    let store: K8sClusterStore = STORE.read(app_data_dir)?;
    store
        .clusters
        .into_iter()
        .find(|cluster| cluster.id == id)
        .ok_or_else(|| cluster_not_found(id))
}

/// OS 보안 저장소에 한 덩어리로 들어가는 자격증명. 인증 종류마다 한 갈래만 채운다.
///
/// 비밀값 옆에 그 값이 묶인 서버·CA 지문·에이전트 정책을 함께 둔다(C22-2). 앱 데이터 JSON 은
/// 셸 에이전트가 `--app-data-dir` 로 다른 폴더를 가리켜 통째로 바꿔 넣을 수 있지만, 보안
/// 저장소의 항목은 앱만 쓴다. 토큰을 꺼내 쓰는 자리는 두 값이 같을 때만 열린다
/// ([`binding_matches`]) — 그러지 않으면 가짜 저장본 하나로 진짜 토큰을 다른 서버에 보내거나
/// 꺼 둔 클러스터·범위 밖 네임스페이스를 읽을 수 있다.
#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct K8sCredential {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) certificate_pem: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) key_pem: Option<String>,
    #[serde(default)]
    pub(crate) server: String,
    #[serde(default)]
    pub(crate) ca_fingerprint: String,
    #[serde(default)]
    pub(crate) agent_enabled: bool,
    #[serde(default)]
    pub(crate) namespaces: Vec<String>,
}

impl std::fmt::Debug for K8sCredential {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("K8sCredential(<가려짐>)")
    }
}

impl K8sCredential {
    fn kind(&self) -> K8sAuthKind {
        if self.token.is_some() {
            K8sAuthKind::Token
        } else {
            K8sAuthKind::ClientCertificate
        }
    }

    /// 저장본의 현재 서버·CA·정책으로 묶음을 맞춘다. 비밀값은 그대로다.
    fn bind_to(&mut self, cluster: &K8sClusterView) {
        self.server = cluster.server.clone();
        self.ca_fingerprint = cluster.ca_fingerprint.clone();
        self.agent_enabled = cluster.agent_enabled;
        self.namespaces = cluster.namespaces.clone();
    }
}

/// 저장본이 보안 저장소 쪽 묶음과 같은지. 에이전트 사용은 저장본이 "켜짐"이라고 할 때만
/// 보안 저장소도 켜짐이어야 한다 — 꺼진 저장본으로 하는 화면의 연결 확인은 막지 않는다.
pub(crate) fn binding_matches(cluster: &K8sClusterView, credential: &K8sCredential) -> bool {
    credential.server == cluster.server
        && credential.ca_fingerprint == cluster.ca_fingerprint
        && credential.namespaces == cluster.namespaces
        && (!cluster.agent_enabled || credential.agent_enabled)
}

fn read_credential(
    id: &str,
    display_name: &str,
) -> Result<Zeroizing<K8sCredentialHolder>, CoreError> {
    let raw = crate::accounts::read_os_keychain_password(K8S_KEYCHAIN_SERVICE, id)?.ok_or_else(|| {
        CoreError::InvalidInput(format!(
            "{display_name} 클러스터의 자격증명이 보안 저장소에 없습니다. 애드온 → Kubernetes 에서 다시 저장하세요"
        ))
    })?;
    let credential: K8sCredential = serde_json::from_str(&raw).map_err(|_| {
        CoreError::Runtime("보안 저장소의 Kubernetes 자격증명 형식을 읽지 못했습니다".to_owned())
    })?;
    Ok(Zeroizing::new(K8sCredentialHolder(credential)))
}

/// 묶음을 저장본에 맞춰 보안 저장소에 쓴다.
fn write_credential(cluster: &K8sClusterView, credential: &K8sCredential) -> Result<(), CoreError> {
    let mut bound = Zeroizing::new(K8sCredentialHolder(credential.clone()));
    bound.0.bind_to(cluster);
    let serialized = Zeroizing::new(serde_json::to_string(&bound.0)?);
    crate::accounts::write_os_keychain_password(K8S_KEYCHAIN_SERVICE, &cluster.id, &serialized)
}

/// 보안 저장소에서 자격증명을 꺼낸다. 저장본과 묶음이 어긋나면 값을 쓰지 않고 거절한다.
pub(crate) fn resolve_credential(
    cluster: &K8sClusterView,
) -> Result<Zeroizing<K8sCredentialHolder>, CoreError> {
    let credential = read_credential(&cluster.id, &cluster.display_name)?;
    if !binding_matches(cluster, &credential.0) {
        return Err(CoreError::InvalidInput(format!(
            "{} 클러스터의 저장된 설정이 보안 저장소의 자격증명 묶음과 다릅니다(서버·CA·에이전트 사용·네임스페이스). 애드온 → Kubernetes 에서 다시 저장하세요",
            cluster.display_name
        )));
    }
    Ok(credential)
}

/// `Zeroizing` 이 지울 수 있게 감싼 자격증명.
pub(crate) struct K8sCredentialHolder(pub(crate) K8sCredential);

impl zeroize::Zeroize for K8sCredentialHolder {
    fn zeroize(&mut self) {
        for value in [
            self.0.token.as_mut(),
            self.0.certificate_pem.as_mut(),
            self.0.key_pem.as_mut(),
        ]
        .into_iter()
        .flatten()
        {
            value.zeroize();
        }
    }
}

/// 검사를 마친 저장 요청 한 벌.
struct ValidatedCluster {
    display_name: String,
    environment: DbEnvironment,
    server: String,
    ca_pem: String,
    ca_fingerprint: String,
    auth_kind: K8sAuthKind,
    namespaces: Vec<String>,
    note: String,
    /// 새로 받은 자격증명. 없으면 수정 경로가 저장된 값을 그대로 둔다.
    credential: Option<K8sCredential>,
}

impl ValidatedCluster {
    fn new_view(&self, id: String, now: i64) -> K8sClusterView {
        K8sClusterView {
            id,
            display_name: self.display_name.clone(),
            environment: self.environment,
            server: self.server.clone(),
            ca_pem: self.ca_pem.clone(),
            ca_fingerprint: self.ca_fingerprint.clone(),
            auth_kind: self.auth_kind,
            credential_stored_at: None,
            agent_enabled: false,
            namespaces: self.namespaces.clone(),
            note: self.note.clone(),
            updated_at: now,
        }
    }
}

/// kubeconfig 에서 고른 context 하나를 풀어낸 결과.
#[derive(Debug)]
pub(crate) struct ParsedKubeconfig {
    pub(crate) server: String,
    pub(crate) ca_pem: String,
    pub(crate) credential: K8sCredential,
}

#[derive(Deserialize)]
struct Kubeconfig {
    #[serde(default)]
    clusters: Vec<NamedCluster>,
    #[serde(default)]
    users: Vec<NamedUser>,
    #[serde(default)]
    contexts: Vec<NamedContext>,
    #[serde(default, rename = "current-context")]
    current_context: String,
}

#[derive(Deserialize)]
struct NamedCluster {
    name: String,
    cluster: KubeconfigCluster,
}

#[derive(Deserialize)]
struct NamedUser {
    name: String,
    #[serde(default)]
    user: KubeconfigUser,
}

#[derive(Deserialize)]
struct NamedContext {
    name: String,
    context: KubeconfigContext,
}

#[derive(Deserialize)]
struct KubeconfigContext {
    cluster: String,
    #[serde(default)]
    user: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
struct KubeconfigCluster {
    server: String,
    #[serde(default)]
    certificate_authority_data: Option<String>,
    #[serde(default)]
    certificate_authority: Option<String>,
    #[serde(default)]
    insecure_skip_tls_verify: Option<bool>,
    #[serde(default)]
    tls_server_name: Option<String>,
    #[serde(default)]
    proxy_url: Option<String>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "kebab-case")]
struct KubeconfigUser {
    #[serde(default)]
    token: Option<String>,
    // C22-1. 표준 tokenFile과 기존 token-file 모두 파일 경로 거절 검사로 보낸다.
    #[serde(default, rename = "tokenFile", alias = "token-file")]
    token_file: Option<String>,
    #[serde(default)]
    client_certificate_data: Option<String>,
    #[serde(default)]
    client_key_data: Option<String>,
    #[serde(default)]
    client_certificate: Option<String>,
    #[serde(default)]
    client_key: Option<String>,
    #[serde(default)]
    exec: Option<serde_norway::Value>,
    #[serde(default)]
    auth_provider: Option<serde_norway::Value>,
    #[serde(default)]
    username: Option<String>,
}

/// kubeconfig 원문에서 context 하나를 골라 서버·CA·자격증명으로 푼다.
pub(crate) fn parse_kubeconfig(text: &str, context: &str) -> Result<ParsedKubeconfig, CoreError> {
    if text.len() > MAX_KUBECONFIG_BYTES {
        return Err(CoreError::InvalidInput(format!(
            "kubeconfig 는 {}KB 이하여야 합니다",
            MAX_KUBECONFIG_BYTES / 1024
        )));
    }
    // 해석 오류 문구에 원문 조각(토큰 줄)이 실릴 수 있어 위치만 남기지 않고 통째로 버린다.
    let config: Kubeconfig = serde_norway::from_str(text).map_err(|_| {
        CoreError::InvalidInput(
            "kubeconfig 를 읽지 못했습니다. clusters·users·contexts 가 있는 YAML 인지 확인하세요"
                .to_owned(),
        )
    })?;
    let wanted = context.trim();
    let chosen = if !wanted.is_empty() {
        config
            .contexts
            .iter()
            .find(|candidate| candidate.name == wanted)
            .ok_or_else(|| {
                CoreError::InvalidInput(format!("kubeconfig 에 {wanted} context 가 없습니다"))
            })?
    } else if !config.current_context.is_empty() {
        config
            .contexts
            .iter()
            .find(|candidate| candidate.name == config.current_context)
            .ok_or_else(|| {
                CoreError::InvalidInput(format!(
                    "current-context({}) 가 contexts 에 없습니다",
                    config.current_context
                ))
            })?
    } else if config.contexts.len() == 1 {
        &config.contexts[0]
    } else {
        return Err(CoreError::InvalidInput(
            "kubeconfig 에 context 가 여럿이라 하나를 골라야 합니다".to_owned(),
        ));
    };
    let cluster = &config
        .clusters
        .iter()
        .find(|candidate| candidate.name == chosen.context.cluster)
        .ok_or_else(|| {
            CoreError::InvalidInput(format!(
                "context 가 가리키는 cluster({}) 가 없습니다",
                chosen.context.cluster
            ))
        })?
        .cluster;
    let user = &config
        .users
        .iter()
        .find(|candidate| candidate.name == chosen.context.user)
        .ok_or_else(|| {
            CoreError::InvalidInput(format!(
                "context 가 가리키는 user({}) 가 없습니다",
                chosen.context.user
            ))
        })?
        .user;

    if cluster.insecure_skip_tls_verify == Some(true) {
        return Err(CoreError::InvalidInput(
            "insecure-skip-tls-verify 를 켠 클러스터는 등록하지 않습니다. CA 인증서를 함께 넣으세요"
                .to_owned(),
        ));
    }
    if cluster.certificate_authority.is_some() {
        return Err(CoreError::InvalidInput(
            "CA 를 파일 경로(certificate-authority)로 가리키는 kubeconfig 는 받지 않습니다. certificate-authority-data 로 펼친 kubeconfig 를 넣으세요 (kubectl config view --raw --minify --flatten)".to_owned(),
        ));
    }
    if cluster.tls_server_name.is_some() || cluster.proxy_url.is_some() {
        return Err(CoreError::InvalidInput(
            "tls-server-name·proxy-url 을 쓰는 클러스터는 아직 지원하지 않습니다".to_owned(),
        ));
    }
    if user.exec.is_some() || user.auth_provider.is_some() {
        return Err(CoreError::InvalidInput(
            "exec·auth-provider 인증(gke-gcloud-auth-plugin, oci ce 등)은 다른 프로그램을 실행해야 해서 받지 않습니다. 클러스터에 ServiceAccount 를 만들고 그 토큰으로 등록하세요".to_owned(),
        ));
    }
    if user.token_file.is_some() || user.client_certificate.is_some() || user.client_key.is_some() {
        return Err(CoreError::InvalidInput(
            "자격증명을 파일 경로로 가리키는 kubeconfig 는 받지 않습니다. --flatten 으로 펼친 kubeconfig 를 넣으세요".to_owned(),
        ));
    }
    if user.username.is_some() {
        return Err(CoreError::InvalidInput(
            "사용자 이름·비밀번호 인증은 Kubernetes 에서 없어졌습니다. 토큰이나 클라이언트 인증서를 쓰세요".to_owned(),
        ));
    }

    let ca_pem = match cluster.certificate_authority_data.as_deref() {
        Some(data) => decode_pem_data(data, "certificate-authority-data")?,
        None => String::new(),
    };
    let credential = match (
        user.token.as_deref(),
        user.client_certificate_data.as_deref(),
        user.client_key_data.as_deref(),
    ) {
        (Some(token), None, None) => K8sCredential {
            token: Some(token.trim().to_owned()),
            ..K8sCredential::default()
        },
        (None, Some(certificate), Some(key)) => K8sCredential {
            certificate_pem: Some(decode_pem_data(certificate, "client-certificate-data")?),
            key_pem: Some(decode_pem_data(key, "client-key-data")?),
            ..K8sCredential::default()
        },
        (None, None, None) => {
            return Err(CoreError::InvalidInput(
                "kubeconfig 의 user 에 token 이나 client-certificate-data·client-key-data 가 없습니다"
                    .to_owned(),
            ))
        }
        _ => {
            return Err(CoreError::InvalidInput(
                "kubeconfig 의 user 는 token 하나, 또는 client-certificate-data 와 client-key-data 한 쌍만 가져야 합니다".to_owned(),
            ))
        }
    };
    Ok(ParsedKubeconfig {
        server: cluster.server.clone(),
        ca_pem,
        credential,
    })
}

fn decode_pem_data(data: &str, field: &str) -> Result<String, CoreError> {
    let compact: String = data
        .chars()
        .filter(|value| !value.is_whitespace())
        .collect();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(compact)
        .map_err(|_| CoreError::InvalidInput(format!("{field} 가 base64 가 아닙니다")))?;
    String::from_utf8(bytes)
        .map_err(|_| CoreError::InvalidInput(format!("{field} 가 PEM 텍스트가 아닙니다")))
}

/// API 서버 주소. https 만 받고, 평문 http 는 `kubectl proxy` 같은 같은 기기 안 주소에만 연다.
pub(crate) fn validate_server(value: &str) -> Result<String, CoreError> {
    let trimmed = validate_text(value, "API 서버 주소", MAX_SERVER_CHARS, false)?;
    let url = reqwest::Url::parse(&trimmed)
        .map_err(|_| CoreError::InvalidInput("API 서버 주소가 URL 이 아닙니다".to_owned()))?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err(CoreError::InvalidInput(
            "API 서버 주소에 계정 정보를 넣지 마세요".to_owned(),
        ));
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(CoreError::InvalidInput(
            "API 서버 주소에는 질의 문자열을 붙이지 않습니다".to_owned(),
        ));
    }
    let host = url
        .host_str()
        .ok_or_else(|| CoreError::InvalidInput("API 서버 주소에 호스트가 없습니다".to_owned()))?;
    match url.scheme() {
        "https" => {}
        "http" if matches!(host, "127.0.0.1" | "localhost" | "[::1]") => {}
        "http" => {
            return Err(CoreError::InvalidInput(
                "평문 http 는 같은 기기(127.0.0.1) 주소에만 씁니다. https 주소를 넣으세요"
                    .to_owned(),
            ))
        }
        other => {
            return Err(CoreError::InvalidInput(format!(
                "지원하지 않는 주소 형식입니다: {other}"
            )))
        }
    }
    Ok(trimmed.trim_end_matches('/').to_owned())
}

/// CA 묶음을 확인하고 첫 인증서의 지문을 낸다. 비어 있으면 OS 기본 신뢰 저장소를 쓴다.
pub(crate) fn validate_ca(ca_pem: &str) -> Result<(String, String), CoreError> {
    let trimmed = ca_pem.trim();
    if trimmed.is_empty() {
        return Ok((String::new(), String::new()));
    }
    if trimmed.len() > MAX_PEM_BYTES {
        return Err(CoreError::InvalidInput(
            "CA 인증서가 너무 큽니다".to_owned(),
        ));
    }
    let ders = pem_blocks(trimmed, "CERTIFICATE");
    if ders.is_empty() {
        return Err(CoreError::InvalidInput(
            "CA 인증서에서 -----BEGIN CERTIFICATE----- 블록을 찾지 못했습니다".to_owned(),
        ));
    }
    reqwest::Certificate::from_pem_bundle(trimmed.as_bytes())
        .map_err(|_| CoreError::InvalidInput("CA 인증서를 읽지 못했습니다".to_owned()))?;
    Ok((format!("{trimmed}\n"), fingerprint(&ders[0])))
}

/// PEM 텍스트에서 주어진 종류의 블록 본문(DER)만 뽑는다.
fn pem_blocks(text: &str, label: &str) -> Vec<Vec<u8>> {
    let begin = format!("-----BEGIN {label}-----");
    let end = format!("-----END {label}-----");
    let mut blocks = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find(&begin) {
        let after = &rest[start + begin.len()..];
        let Some(stop) = after.find(&end) else {
            break;
        };
        let body: String = after[..stop]
            .chars()
            .filter(|value| !value.is_whitespace())
            .collect();
        if let Ok(der) = base64::engine::general_purpose::STANDARD.decode(body) {
            blocks.push(der);
        }
        rest = &after[stop + end.len()..];
    }
    blocks
}

fn fingerprint(der: &[u8]) -> String {
    Sha256::digest(der)
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<Vec<_>>()
        .join(":")
}

fn validate_credential(credential: &K8sCredential) -> Result<(), CoreError> {
    match (
        credential.token.as_deref(),
        credential.certificate_pem.as_deref(),
        credential.key_pem.as_deref(),
    ) {
        (Some(token), None, None) => {
            let token = token.trim();
            if token.is_empty() || token.chars().count() > MAX_TOKEN_CHARS {
                return Err(CoreError::InvalidInput(format!(
                    "토큰은 1~{MAX_TOKEN_CHARS}자여야 합니다"
                )));
            }
            if token
                .chars()
                .any(|value| value.is_whitespace() || value.is_control())
            {
                return Err(CoreError::InvalidInput(
                    "토큰에 공백이나 제어 문자가 들어 있습니다".to_owned(),
                ));
            }
            Ok(())
        }
        (None, Some(certificate), Some(key)) => {
            if certificate.len() > MAX_PEM_BYTES || key.len() > MAX_PEM_BYTES {
                return Err(CoreError::InvalidInput(
                    "클라이언트 인증서·개인키가 너무 큽니다".to_owned(),
                ));
            }
            if pem_blocks(certificate, "CERTIFICATE").is_empty() {
                return Err(CoreError::InvalidInput(
                    "클라이언트 인증서에서 CERTIFICATE 블록을 찾지 못했습니다".to_owned(),
                ));
            }
            if !key.contains("PRIVATE KEY-----") {
                return Err(CoreError::InvalidInput(
                    "클라이언트 개인키에서 PRIVATE KEY 블록을 찾지 못했습니다".to_owned(),
                ));
            }
            let mut combined = Zeroizing::new(String::new());
            combined.push_str(certificate.trim());
            combined.push('\n');
            combined.push_str(key.trim());
            combined.push('\n');
            reqwest::Identity::from_pem(combined.as_bytes()).map_err(|_| {
                CoreError::InvalidInput(
                    "클라이언트 인증서와 개인키를 함께 읽지 못했습니다".to_owned(),
                )
            })?;
            Ok(())
        }
        _ => Err(CoreError::InvalidInput(
            "자격증명은 토큰 하나, 또는 클라이언트 인증서와 개인키 한 쌍이어야 합니다".to_owned(),
        )),
    }
}

fn credential_from_fields(
    auth_kind: K8sAuthKind,
    request: &SetK8sClusterRequest,
) -> Option<K8sCredential> {
    let present = |value: &Option<String>| {
        value
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    };
    match auth_kind {
        K8sAuthKind::Token => present(&request.token).map(|token| K8sCredential {
            token: Some(token),
            ..K8sCredential::default()
        }),
        K8sAuthKind::ClientCertificate => {
            let certificate = present(&request.client_certificate_pem);
            let key = present(&request.client_key_pem);
            if certificate.is_none() && key.is_none() {
                return None;
            }
            Some(K8sCredential {
                certificate_pem: certificate,
                key_pem: key,
                ..K8sCredential::default()
            })
        }
    }
}

fn validate_request(request: &SetK8sClusterRequest) -> Result<ValidatedCluster, CoreError> {
    let display_name = validate_text(
        &request.display_name,
        "클러스터 이름",
        MAX_NAME_CHARS,
        false,
    )?;
    let note = validate_text(&request.note, "메모", 200, true)?;
    let environment = if request.environment.trim().is_empty() {
        DbEnvironment::Dev
    } else {
        request.environment.parse()?
    };
    let namespaces = validate_namespaces(&request.namespaces)?;

    let kubeconfig = request
        .kubeconfig
        .as_deref()
        .filter(|value| !value.trim().is_empty());
    let (server, ca_pem, auth_kind, credential) = if let Some(text) = kubeconfig {
        let parsed = parse_kubeconfig(text, &request.context)?;
        let kind = parsed.credential.kind();
        (parsed.server, parsed.ca_pem, kind, Some(parsed.credential))
    } else {
        let auth_kind = if request.auth_kind.trim().is_empty() {
            K8sAuthKind::Token
        } else {
            request.auth_kind.parse()?
        };
        let credential = credential_from_fields(auth_kind, request);
        (
            request.server.clone(),
            request.ca_pem.clone(),
            auth_kind,
            credential,
        )
    };
    let server = validate_server(&server)?;
    let (ca_pem, ca_fingerprint) = validate_ca(&ca_pem)?;
    if let Some(credential) = credential.as_ref() {
        validate_credential(credential)?;
    }
    Ok(ValidatedCluster {
        display_name,
        environment,
        server,
        ca_pem,
        ca_fingerprint,
        auth_kind,
        namespaces,
        note,
        credential,
    })
}

pub fn set_k8s_cluster(
    app_data_dir: &Path,
    request: SetK8sClusterRequest,
) -> Result<K8sClustersSnapshot, CoreError> {
    let validated = validate_request(&request)?;
    let store = STORE.update(app_data_dir, |store: &mut K8sClusterStore| {
        let now = now_ms();
        let id = if request.id.trim().is_empty() {
            if validated.credential.is_none() {
                return Err(CoreError::InvalidInput(
                    "새 클러스터에는 kubeconfig 나 토큰·클라이언트 인증서가 필요합니다".to_owned(),
                ));
            }
            if store.clusters.len() >= MAX_CLUSTERS {
                return Err(CoreError::InvalidInput(format!(
                    "Kubernetes 클러스터는 최대 {MAX_CLUSTERS}개까지 등록할 수 있습니다"
                )));
            }
            let id = next_id(store, &validated.display_name);
            store.clusters.push(validated.new_view(id.clone(), now));
            id
        } else {
            let id = request.id.trim().to_owned();
            let existing = store.cluster_mut(&id)?;
            if validated.credential.is_none() {
                // 인증 종류가 바뀌었는데 새 자격증명이 없으면, 저장된 값은 다른 종류라 쓸 수 없다.
                if existing.auth_kind != validated.auth_kind {
                    return Err(CoreError::InvalidInput(
                        "인증 방식을 바꾸려면 새 자격증명을 함께 넣으세요".to_owned(),
                    ));
                }
                // 저장된 토큰을 새 주소·새 CA 로 그대로 보내지 않는다(C22-2).
                if existing.server != validated.server
                    || existing.ca_fingerprint != validated.ca_fingerprint
                {
                    return Err(CoreError::InvalidInput(
                        "API 서버 주소나 CA 를 바꾸려면 자격증명을 다시 넣으세요".to_owned(),
                    ));
                }
            }
            // 에이전트 사용은 목록의 토글(set_k8s_cluster_enabled)만 바꾼다. 편집기가 연 순간의
            // 값을 저장 때 되돌려 쓰면, 그 사이 꺼 둔 사용이 다시 켜진다.
            *existing = K8sClusterView {
                credential_stored_at: existing.credential_stored_at,
                agent_enabled: existing.agent_enabled,
                ..validated.new_view(id.clone(), now)
            };
            id
        };
        let cluster = store.cluster_mut(&id)?;
        match validated.credential.as_ref() {
            Some(credential) => {
                cluster.credential_stored_at = Some(now);
                write_credential(cluster, credential)?;
            }
            // 범위만 바뀌어도 묶음을 다시 써야 실행 경로가 새 범위를 받아들인다.
            None if cluster.credential_stored_at.is_some() => {
                let stored = read_credential(&cluster.id, &cluster.display_name)?;
                write_credential(cluster, &stored.0)?;
            }
            None => {}
        }
        Ok(true)
    })?;
    Ok(snapshot_from(store))
}

pub fn set_k8s_cluster_enabled(
    app_data_dir: &Path,
    request: SetK8sClusterEnabledRequest,
) -> Result<K8sClustersSnapshot, CoreError> {
    let store = STORE.update(app_data_dir, |store: &mut K8sClusterStore| {
        let cluster = store.cluster_mut(&request.id)?;
        if request.enabled && cluster.credential_stored_at.is_none() {
            return Err(CoreError::InvalidInput(
                "자격증명이 아직 저장되지 않았습니다. 먼저 저장하세요".to_owned(),
            ));
        }
        cluster.agent_enabled = request.enabled;
        cluster.updated_at = now_ms();
        if cluster.credential_stored_at.is_some() {
            let stored = read_credential(&cluster.id, &cluster.display_name)?;
            write_credential(cluster, &stored.0)?;
        }
        Ok(true)
    })?;
    Ok(snapshot_from(store))
}

pub fn remove_k8s_cluster(
    app_data_dir: &Path,
    request: K8sClusterRef,
) -> Result<K8sClustersSnapshot, CoreError> {
    let store = STORE.update(app_data_dir, |store: &mut K8sClusterStore| {
        let before = store.clusters.len();
        store.clusters.retain(|cluster| cluster.id != request.id);
        if store.clusters.len() == before {
            return Err(cluster_not_found(&request.id));
        }
        crate::accounts::delete_os_keychain_password(K8S_KEYCHAIN_SERVICE, &request.id)?;
        Ok(true)
    })?;
    Ok(snapshot_from(store))
}

pub fn list_agent_k8s_clusters(app_data_dir: &Path) -> Result<AgentK8sClustersView, CoreError> {
    let store: K8sClusterStore = STORE.read(app_data_dir)?;
    let mut clusters = Vec::new();
    let mut skipped = Vec::new();
    for cluster in store.clusters {
        if !cluster.agent_enabled {
            continue;
        }
        if cluster.credential_stored_at.is_none() {
            skipped.push(AgentK8sClusterSkip {
                id: cluster.id,
                reason: "자격증명이 저장되지 않았습니다".to_owned(),
            });
            continue;
        }
        clusters.push(AgentK8sClusterView {
            id: cluster.id,
            display_name: cluster.display_name,
            environment: cluster.environment,
            server: cluster.server,
            namespaces: cluster.namespaces,
            note: cluster.note,
        });
    }
    Ok(AgentK8sClustersView {
        schema_version: STORE_VERSION,
        clusters,
        skipped,
        issues: Vec::new(),
    })
}

/// 에이전트 실행 경로가 쓰는 클러스터. 사용자가 열어 주지 않았으면 이름을 알아도 쓰지 못한다.
pub(crate) fn agent_cluster_of(app_data_dir: &Path, id: &str) -> Result<K8sClusterView, CoreError> {
    let cluster = cluster_of(app_data_dir, id)?;
    if !cluster.agent_enabled {
        return Err(CoreError::InvalidInput(format!(
            "{} 클러스터는 에이전트 사용이 꺼져 있습니다. 애드온 → Kubernetes 에서 켜야 합니다",
            cluster.display_name
        )));
    }
    Ok(cluster)
}

/// Kubernetes 이름 규칙에 맞는지. 경로 조각으로 들어가므로 `/`·`..`·`?` 같은 값이 섞이면
/// 다른 API 를 부르게 된다. 네임스페이스는 DNS-1123 label(`-` 만), 리소스 이름은 그보다
/// 넓게 `.`·`:`(예: `system:node`)까지 받는다.
pub(crate) fn validate_k8s_name(value: &str, label: &str, max: usize) -> Result<String, CoreError> {
    let trimmed = value.trim();
    let extra: &[char] = if max == MAX_NAMESPACE_CHARS {
        &['-']
    } else {
        &['-', '.', ':']
    };
    let valid = !trimmed.is_empty()
        && trimmed.len() <= max
        && trimmed.chars().all(|value| {
            value.is_ascii_lowercase() || value.is_ascii_digit() || extra.contains(&value)
        })
        && trimmed
            .chars()
            .next()
            .is_some_and(|value| value.is_ascii_alphanumeric())
        && trimmed
            .chars()
            .last()
            .is_some_and(|value| value.is_ascii_alphanumeric())
        && !trimmed.contains("..");
    if !valid {
        return Err(CoreError::InvalidInput(format!(
            "{label}은(는) 소문자·숫자와 {} 로 된 Kubernetes 이름이어야 합니다: {trimmed}",
            extra
                .iter()
                .map(|value| format!("'{value}'"))
                .collect::<Vec<_>>()
                .join("·")
        )));
    }
    Ok(trimmed.to_owned())
}

fn validate_namespaces(values: &[String]) -> Result<Vec<String>, CoreError> {
    let mut namespaces = Vec::new();
    for value in values {
        if value.trim().is_empty() {
            continue;
        }
        let namespace = validate_k8s_name(value, "네임스페이스", MAX_NAMESPACE_CHARS)?;
        if !namespaces.contains(&namespace) {
            namespaces.push(namespace);
        }
    }
    if namespaces.len() > MAX_NAMESPACES {
        return Err(CoreError::InvalidInput(format!(
            "네임스페이스는 {MAX_NAMESPACES}개까지 지정할 수 있습니다"
        )));
    }
    Ok(namespaces)
}

fn next_id(store: &K8sClusterStore, display_name: &str) -> String {
    let base: String = display_name
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    let base = base.trim_matches('-');
    let base = if base.is_empty() {
        "k8s".to_owned()
    } else {
        base.chars().take(24).collect()
    };
    let mut candidate = base.clone();
    let mut suffix = 2;
    while store.clusters.iter().any(|cluster| cluster.id == candidate) {
        candidate = format!("{base}-{suffix}");
        suffix += 1;
    }
    candidate
}

fn validate_text(
    value: &str,
    label: &str,
    max_chars: usize,
    allow_empty: bool,
) -> Result<String, CoreError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        if allow_empty {
            return Ok(String::new());
        }
        return Err(CoreError::InvalidInput(format!("{label}을(를) 입력하세요")));
    }
    if trimmed.chars().count() > max_chars {
        return Err(CoreError::InvalidInput(format!(
            "{label}은(는) {max_chars}자 이하여야 합니다"
        )));
    }
    if trimmed.chars().any(char::is_control) {
        return Err(CoreError::InvalidInput(format!(
            "{label}에 제어 문자를 쓸 수 없습니다"
        )));
    }
    Ok(trimmed.to_owned())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// 시험용 자체 서명 CA 와 그 CA 가 서명한 클라이언트 인증서(공개 정보). 실제 클러스터와
    /// 무관하고, 짝이 되는 개인키는 만들고 바로 지웠다. 저장소는 `*.pem` 을 받지 않으므로
    /// 파일이 아니라 문자열로 둔다.
    const TEST_CA_PEM: &str = "-----BEGIN CERTIFICATE-----
MIIBlzCCAT2gAwIBAgIUUL4PxL2gfTDMKwddWghFQIleBXAwCgYIKoZIzj0EAwIw
IDEeMBwGA1UEAwwVYWdlbnQtbWFuYWdlci10ZXN0LWNhMCAXDTI2MTExMDA1MTQ1
OVoYDzIxMjYxMDE3MDUxNDU5WjAgMR4wHAYDVQQDDBVhZ2VudC1tYW5hZ2VyLXRl
c3QtY2EwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAAQcdl0eBGoiF72jo11eVQsZ
OmoiJ3tdxbJ7YlMY6rEen7M+2VkjBI1tlabok8ISfb347tgEz5r030lw0pebBp9k
o1MwUTAdBgNVHQ4EFgQUS+g9qxNMXfeeGtyHR9UzWygFdgcwHwYDVR0jBBgwFoAU
S+g9qxNMXfeeGtyHR9UzWygFdgcwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQD
AgNIADBFAiEA0XmuixcrsUxrYNPbi7ZETCRUGPcDpN1bmxRN7E5SJQICIHHnK4EM
kZMwJ3Xkqid1fLgD2C31AGSz6uIZP4k6A+QZ
-----END CERTIFICATE-----\n";
    const TEST_CLIENT_CERT_PEM: &str = "-----BEGIN CERTIFICATE-----
MIIBSzCB8wIUEvVb7BimGFFD6xbik0OB+DIXU3AwCgYIKoZIzj0EAwIwIDEeMBwG
A1UEAwwVYWdlbnQtbWFuYWdlci10ZXN0LWNhMCAXDTI2MTExMDA1MTQ1OVoYDzIx
MjYxMDE3MDUxNDU5WjAwMRUwEwYDVQQDDAxzeXN0ZW06YWRtaW4xFzAVBgNVBAoM
DnN5c3RlbTptYXN0ZXJzMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEPb1qK5Zv
6xtL3/Hzn5pLFYjRL7pg4ndj8txjKMYg4mk+K25IzVZRCvw0Jd/pL9hVOCF1aoGH
UPeOtLeT4w1EszAKBggqhkjOPQQDAgNHADBEAiBn85HotQqr1xjsDaAwqI8oWvP4
d6L09fmf6cIOQy2gxwIgRPad334EcCMXBQ+e8wOZtiPJqwkb5rr5bri95xNcvOI=
-----END CERTIFICATE-----\n";

    /// 개인키는 저장소에 두지 않고 시험마다 만든다. 해석만 보는 자리라 인증서와 짝이 맞을 필요는 없다.
    fn test_client_key_pem() -> String {
        use ring::signature::{EcdsaKeyPair, ECDSA_P256_SHA256_ASN1_SIGNING};
        let pkcs8 = EcdsaKeyPair::generate_pkcs8(
            &ECDSA_P256_SHA256_ASN1_SIGNING,
            &ring::rand::SystemRandom::new(),
        )
        .expect("generate key");
        let body = base64::engine::general_purpose::STANDARD.encode(pkcs8.as_ref());
        let lines: Vec<&str> = body
            .as_bytes()
            .chunks(64)
            .map(|chunk| std::str::from_utf8(chunk).expect("ascii"))
            .collect();
        format!(
            "-----BEGIN PRIVATE KEY-----\n{}\n-----END PRIVATE KEY-----\n",
            lines.join("\n")
        )
    }

    fn b64(text: &str) -> String {
        base64::engine::general_purpose::STANDARD.encode(text)
    }

    fn k3s_kubeconfig() -> String {
        format!(
            "apiVersion: v1\nclusters:\n- cluster:\n    certificate-authority-data: {}\n    server: https://127.0.0.1:6443\n  name: default\ncontexts:\n- context:\n    cluster: default\n    user: default\n  name: default\ncurrent-context: default\nkind: Config\npreferences: {{}}\nusers:\n- name: default\n  user:\n    client-certificate-data: {}\n    client-key-data: {}\n",
            b64(TEST_CA_PEM),
            b64(TEST_CLIENT_CERT_PEM),
            b64(&test_client_key_pem())
        )
    }

    #[test]
    fn c22_1_k3s_kubeconfig_yields_server_ca_and_client_certificate() {
        let parsed = parse_kubeconfig(&k3s_kubeconfig(), "").expect("parse");
        assert_eq!(parsed.server, "https://127.0.0.1:6443");
        assert!(parsed.ca_pem.contains("BEGIN CERTIFICATE"));
        assert_eq!(parsed.credential.kind(), K8sAuthKind::ClientCertificate);
        validate_credential(&parsed.credential).expect("certificate and key pair");
        let (_, fingerprint) = validate_ca(&parsed.ca_pem).expect("ca");
        assert_eq!(fingerprint.split(':').count(), 32);
    }

    #[test]
    fn c22_1_token_kubeconfig_picks_the_named_context() {
        let text = format!(
            "clusters:\n- name: a\n  cluster:\n    server: https://a.example:6443\n    certificate-authority-data: {}\n- name: b\n  cluster:\n    server: https://b.example\ncontexts:\n- name: ctx-a\n  context: {{cluster: a, user: sa}}\n- name: ctx-b\n  context: {{cluster: b, user: sa}}\nusers:\n- name: sa\n  user:\n    token: abc.def\n",
            b64(TEST_CA_PEM)
        );
        let error = parse_kubeconfig(&text, "").expect_err("two contexts, none current");
        assert!(error.to_string().contains("여럿"));
        let parsed = parse_kubeconfig(&text, "ctx-b").expect("parse");
        assert_eq!(parsed.server, "https://b.example");
        assert!(parsed.ca_pem.is_empty());
        assert_eq!(parsed.credential.token.as_deref(), Some("abc.def"));
    }

    /// exec 플러그인·파일 경로·검증 끄기는 앱이 임의 프로그램을 띄우거나 사용자 파일을
    /// 따라 읽거나 중간자 공격을 받아들이게 한다. 해석 단계에서 막는다.
    #[test]
    fn c22_1_exec_file_paths_and_insecure_tls_are_refused() {
        let base = |cluster: &str, user: &str| {
            format!(
                "clusters:\n- name: c\n  cluster:\n    server: https://x:6443\n{cluster}contexts:\n- name: x\n  context: {{cluster: c, user: u}}\ncurrent-context: x\nusers:\n- name: u\n  user:\n{user}"
            )
        };
        for (cluster, user, needle) in [
            (
                "",
                "    exec:\n      command: gke-gcloud-auth-plugin\n",
                "exec",
            ),
            ("", "    auth-provider:\n      name: oidc\n", "exec"),
            (
                "    certificate-authority: /etc/ca.crt\n",
                "    token: t\n",
                "파일 경로",
            ),
            ("", "    token-file: /var/run/token\n", "파일 경로"),
            (
                "    insecure-skip-tls-verify: true\n",
                "    token: t\n",
                "insecure",
            ),
            ("", "    username: admin\n    password: x\n", "비밀번호"),
        ] {
            let error = parse_kubeconfig(&base(cluster, user), "").expect_err(needle);
            assert!(error.to_string().contains(needle), "{needle}: {error}");
        }
    }

    /// C22-1. 파일 기반 설정을 인라인 토큰만 있는 설정으로 잘못 받아들이면 안 된다.
    #[test]
    fn c22_1_token_file_spellings_never_fall_back_to_inline_tokens() {
        let config = concat!(
            "clusters:\n- name: c\n  cluster:\n    server: https://cluster.example\n",
            "contexts:\n- name: c\n  context: {cluster: c, user: u}\n",
            "current-context: c\nusers:\n- name: u\n  user:\n",
        );
        let request = |user: &str| SetK8sClusterRequest {
            display_name: "fixture".to_owned(),
            kubeconfig: Some(format!("{config}{user}")),
            ..SetK8sClusterRequest::default()
        };
        let inline = "    token: inline-fixture\n";
        let valid = validate_request(&request(inline)).expect("inline token remains supported");
        assert_eq!(
            valid
                .credential
                .and_then(|credential| credential.token)
                .as_deref(),
            Some("inline-fixture")
        );
        for field in ["tokenFile", "token-file"] {
            for path in ["/unread/credential-token", ""] {
                for token in [inline, ""] {
                    let user = format!("{token}    {field}: \"{path}\"\n");
                    let error = validate_request(&request(&user))
                        .err()
                        .expect("file credentials must be refused before inline token fallback");
                    assert!(matches!(&error, CoreError::InvalidInput(_)));
                    let message = error.to_string();
                    assert!(message.contains("파일 경로"), "{field}: {message}");
                    assert!(!message.contains("/unread/credential-token"));
                    assert!(!message.contains("inline-fixture"));
                }
            }
        }
    }

    #[test]
    fn c22_1_kubeconfig_errors_do_not_echo_the_source() {
        let error = parse_kubeconfig("users: [ {name: u, user: {token: SECRET-TOKEN-VALUE", "")
            .expect_err("broken yaml");
        assert!(!error.to_string().contains("SECRET-TOKEN-VALUE"));
    }

    #[test]
    fn c22_1_server_must_be_https_except_on_loopback() {
        assert_eq!(
            validate_server("https://k3s.example:6443/").expect("https"),
            "https://k3s.example:6443"
        );
        validate_server("http://127.0.0.1:8001").expect("kubectl proxy");
        for bad in [
            "http://10.0.0.5:6443",
            "https://user:pw@k3s.example",
            "https://k3s.example?x=1",
            "ftp://k3s.example",
        ] {
            assert!(validate_server(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn c22_2_names_cannot_escape_the_api_path() {
        validate_k8s_name("qa-lite", "네임스페이스", MAX_NAMESPACE_CHARS).expect("plain");
        validate_k8s_name("system:node", "이름", 253).expect("rbac name");
        validate_k8s_name("coredns.v1", "이름", 253).expect("dotted");
        assert!(validate_k8s_name("a.b", "네임스페이스", MAX_NAMESPACE_CHARS).is_err());
        for bad in [
            "",
            "../secrets",
            "a/b",
            "Upper",
            "-x",
            "x-",
            "a..b",
            "a b",
            "a?b",
        ] {
            assert!(validate_k8s_name(bad, "이름", 253).is_err(), "{bad}");
        }
    }

    /// C22-2. 셸 에이전트가 만든 가짜 저장본(다른 서버·켜진 사용·넓힌 범위)으로는 보안
    /// 저장소의 토큰을 꺼내 쓰지 못한다.
    #[test]
    fn c22_2_forged_store_values_do_not_match_the_keychain_binding() {
        let cluster = K8sClusterView {
            id: "oci".to_owned(),
            display_name: "oci".to_owned(),
            environment: DbEnvironment::Dev,
            server: "https://k3s.example:6443".to_owned(),
            ca_pem: String::new(),
            ca_fingerprint: "AA".to_owned(),
            auth_kind: K8sAuthKind::Token,
            credential_stored_at: Some(1),
            agent_enabled: false,
            namespaces: vec!["qa-lite".to_owned()],
            note: String::new(),
            updated_at: 1,
        };
        let mut credential = K8sCredential {
            token: Some("t".to_owned()),
            ..K8sCredential::default()
        };
        credential.bind_to(&cluster);
        assert!(binding_matches(&cluster, &credential));
        for forged in [
            K8sClusterView {
                server: "https://evil.example".to_owned(),
                ..cluster.clone()
            },
            K8sClusterView {
                ca_fingerprint: String::new(),
                ..cluster.clone()
            },
            K8sClusterView {
                agent_enabled: true,
                ..cluster.clone()
            },
            K8sClusterView {
                namespaces: Vec::new(),
                ..cluster.clone()
            },
        ] {
            assert!(!binding_matches(&forged, &credential), "{forged:?}");
        }
        // 사용을 끈 저장본으로 하는 화면 확인은 켜진 묶음과도 맞는다.
        let mut enabled = credential.clone();
        enabled.agent_enabled = true;
        assert!(binding_matches(&cluster, &enabled));
    }

    #[test]
    fn c22_1_credential_debug_never_prints_values() {
        let credential = K8sCredential {
            token: Some("very-secret".to_owned()),
            ..K8sCredential::default()
        };
        assert!(!format!("{credential:?}").contains("very-secret"));
    }

    #[test]
    fn c22_3_agent_list_shows_only_enabled_clusters_with_credentials() {
        let dir = tempfile::tempdir().expect("tempdir");
        STORE
            .update(dir.path(), |store: &mut K8sClusterStore| {
                let base = K8sClusterView {
                    id: String::new(),
                    display_name: "x".to_owned(),
                    environment: DbEnvironment::Dev,
                    server: "https://x".to_owned(),
                    ca_pem: String::new(),
                    ca_fingerprint: String::new(),
                    auth_kind: K8sAuthKind::Token,
                    credential_stored_at: Some(1),
                    agent_enabled: true,
                    namespaces: vec!["qa-lite".to_owned()],
                    note: String::new(),
                    updated_at: 1,
                };
                store.clusters.push(K8sClusterView {
                    id: "open".to_owned(),
                    ..base.clone()
                });
                store.clusters.push(K8sClusterView {
                    id: "closed".to_owned(),
                    agent_enabled: false,
                    ..base.clone()
                });
                store.clusters.push(K8sClusterView {
                    id: "no-credential".to_owned(),
                    credential_stored_at: None,
                    ..base
                });
                Ok(true)
            })
            .expect("seed");
        let view = list_agent_k8s_clusters(dir.path()).expect("list");
        assert_eq!(
            view.clusters
                .iter()
                .map(|c| c.id.as_str())
                .collect::<Vec<_>>(),
            ["open"]
        );
        assert_eq!(view.skipped.len(), 1);
        assert_eq!(view.skipped[0].id, "no-credential");
        assert!(agent_cluster_of(dir.path(), "closed").is_err());
        assert!(agent_cluster_of(dir.path(), "open").is_ok());
    }
}
