/// <reference types="cypress" />
// 애드온 → Kubernetes 탭(`K8sClustersCard.tsx`, C22)의 세 자리를 본다.
//
// 1) 새 탭이 서고, 격리 백엔드에는 등록된 클러스터가 없다.
// 2) exec 인증을 쓰는 kubeconfig 는 저장 전에 백엔드가 거절하고, 그 이유가 화면에 선다
//    (k8s_clusters.rs C22-1). 이 거절은 보안 저장소에 닿기 전에 끝나므로 격리 백엔드에서도 돈다.
// 3) 연결 확인 영수증이 노드와 권한을 보이고, 모든 권한(broadAccess)이면 경고를 띄운다.
//    격리 백엔드에는 클러스터도 보안 저장소도 없으므로 목록과 확인 응답은 가로챈다.
const EXEC_KUBECONFIG = [
  "clusters:",
  "- name: gke",
  "  cluster:",
  "    server: https://34.0.0.1",
  "contexts:",
  "- name: gke",
  "  context: {cluster: gke, user: gke}",
  "current-context: gke",
  "users:",
  "- name: gke",
  "  user:",
  "    exec:",
  "      command: gke-gcloud-auth-plugin",
].join("\n");

const CLUSTER = {
  id: "oci-k3s",
  displayName: "OCI k3s",
  environment: "production",
  server: "https://100.101.102.103:6443",
  caPem: "",
  caFingerprint: "AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89",
  authKind: "clientCertificate",
  credentialStoredAt: 1,
  agentEnabled: true,
  namespaces: ["qa-lite"],
  note: "",
  updatedAt: 1,
};

describe("Kubernetes 애드온 탭", () => {
  it("탭이 서고, exec 인증 kubeconfig 는 저장 전에 이유와 함께 거절된다", () => {
    cy.visitApp();
    cy.openAddonsView("k8s");
    cy.anchor("addons.k8s-content").should("be.visible");
    cy.get('[data-ui-anchor="addons.k8s-content"] .plugin-empty-state').should("contain.text", "등록된 클러스터가 없습니다");

    cy.anchor("addons.k8s.add").click();
    cy.get(".db-connection-editor").should("be.visible");
    cy.get(".db-connection-editor input").first().type("GKE");
    cy.get(".db-connection-editor textarea").first().type(EXEC_KUBECONFIG, { delay: 0, parseSpecialCharSequences: false });
    cy.contains(".db-connection-editor button", "저장").should("be.enabled").click();

    cy.get('[data-ui-anchor="addons.k8s-content"]').should("contain.text", "exec·auth-provider 인증");
    cy.get('[data-ui-anchor="addons.k8s-content"] .plugin-empty-state').should("exist");
  });

  it("연결 확인이 노드·권한을 보이고 모든 권한이면 경고한다", () => {
    cy.stubInvoke("get_k8s_clusters", {
      statusCode: 200,
      body: { schemaVersion: 1, clusters: [CLUSTER], issues: [], defaults: { environments: ["local", "dev", "staging", "production"], authKinds: ["token", "clientCertificate"] } },
    });
    cy.stubInvoke("check_k8s_cluster", {
      statusCode: 200,
      body: {
        id: "oci-k3s",
        server: CLUSTER.server,
        reachable: true,
        serverVersion: "v1.31.4+k3s1",
        platform: "linux/arm64",
        nodes: [{ name: "oci-a1", ready: true, roles: ["control-plane", "master"], kubeletVersion: "v1.31.4+k3s1", architecture: "arm64", internalIp: "10.0.0.5" }],
        accessNamespace: "qa-lite",
        access: [{ verbs: ["*"], apiGroups: ["*"], resources: ["*"] }],
        broadAccess: true,
        message: "v1.31.4+k3s1 에 연결했습니다",
      },
    }).as("check");
    cy.visitApp();
    cy.openAddonsView("k8s");
    cy.get(".db-connection-row").should("contain.text", "OCI k3s").and("contain.text", "범위 qa-lite");
    cy.contains(".db-connection-row button", "연결 확인").click();
    cy.wait("@check");
    cy.get(".db-connection-row .db-connection-receipt.ok")
      .should("contain.text", "v1.31.4+k3s1")
      .and("contain.text", "oci-a1")
      .and("contain.text", "arm64")
      .and("contain.text", "cluster-admin");
  });
});
