/**
 * Kubernetes 클러스터 기본도구 명령 묶음(C22). 갈라 둔 이유는 `ipcDbConnections.ts` 머리말에 적는다.
 */
import type {
  K8sClusterCheckReceipt,
  K8sClusterRef,
  K8sClustersSnapshot,
  SetK8sClusterEnabledRequest,
  SetK8sClusterRequest,
} from "../types";
import { notifyBuiltinTools } from "./builtinToolsSignal";
import { call } from "./ipcTransport";

/** 버전·노드·권한 세 번을 묻는다. 닿지 않는 주소는 연결 시간 초과(8초)마다 끈다. */
const CLUSTER_CHECK_TIMEOUT_MS = 45_000;

/** 등록된 클러스터와 화면 기본값. 토큰·키 값은 어느 필드에도 없다. */
export function getK8sClusters(): Promise<K8sClustersSnapshot> {
  return call<K8sClustersSnapshot>("get_k8s_clusters");
}

/** 클러스터 저장. kubeconfig·토큰을 함께 받으며 값은 OS 보안 저장소로만 간다. */
export function setK8sCluster(request: SetK8sClusterRequest): Promise<K8sClustersSnapshot> {
  return notifyBuiltinTools(call<K8sClustersSnapshot>("set_k8s_cluster", { request }));
}

/** 에이전트 사용 토글. 앱 데이터 안의 변경이다. */
export function setK8sClusterEnabled(request: SetK8sClusterEnabledRequest): Promise<K8sClustersSnapshot> {
  return notifyBuiltinTools(call<K8sClustersSnapshot>("set_k8s_cluster_enabled", { request }));
}

/** 클러스터 삭제. 보안 저장소의 자격증명도 함께 지운다. 클러스터 자체는 바뀌지 않는다. */
export function removeK8sCluster(request: K8sClusterRef): Promise<K8sClustersSnapshot> {
  return notifyBuiltinTools(call<K8sClustersSnapshot>("remove_k8s_cluster", { request }));
}

/** 한 번 붙어 버전·노드·권한을 읽는 확인. 클러스터에는 아무것도 남지 않는다. */
export function checkK8sCluster(request: K8sClusterRef): Promise<K8sClusterCheckReceipt> {
  return call<K8sClusterCheckReceipt>("check_k8s_cluster", { request }, { timeoutMs: CLUSTER_CHECK_TIMEOUT_MS });
}
