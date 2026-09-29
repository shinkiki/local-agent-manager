/**
 * 문서(등록 루트·항목 탐색·파일 읽기와 저장·문서 자동화 트리거) 명령 묶음.
 *
 * `ipc.ts`는 백엔드 명령을 한 줄씩 얹은 목록이라, 문서 화면 하나가 쓰는 열다섯 개가
 * 아티팩트·Antigravity 사용량과 시스템 워크플로 사이에 끼어 있었다. 실제로 `getDocRoots`부터
 * `acknowledgeDocumentOfflineReport`까지는 한 덩어리인데 `getDocLinkedFile`·`putDoc`만 워크플로
 * 명령 뒤로 떨어져 있어, 문서 명령을 다 보려면 목록을 두 번 훑어야 했다. 스킬(`ipcSkills`)·
 * 지침(`ipcInstructions`)·애드온 도구(`ipcCypress` 등)과 같은 규칙으로 이 묶음을 따로 낸다.
 *
 * 링크 파일 **다운로드**는 여기 두지 않는다. 그쪽은 `call` 한 줄이 아니라 저장 갈래를 타는
 * 별개의 통로라 이미 `ipcLinkedFile`이 가진다 — 여기 있는 `getDocLinkedFile`은 링크가 가리키는
 * 대상을 읽기만 하는 명령이다.
 *
 * `ipc.ts`가 이 파일의 이름을 그대로 다시 내보내므로 화면 쪽 import 경로는 예전 그대로
 * `lib/ipc`다.
 */
import type { DocFile, DocRootStatus, DocumentAutomationSnapshot, DocumentEntryPage, DocumentFile, DocumentTrigger, DocumentTriggerInput, DocumentTriggerRun, LinkedFile } from "../types";
import { call } from "./ipcTransport";

export function getDocRoots(): Promise<DocRootStatus[]> {
  return call<DocRootStatus[]>("get_doc_roots");
}

/**
 * 문서 루트를 등록한다. `createIfMissing`은 없는 경로를 만들고 등록하라는 뜻으로,
 * 사용자가 "만들까요?" 확인에 동의했을 때만 켠다. 폴더 생성 자체는 호스트 전용이지만
 * 이 등록 경로는 원격에서도 열려 있다.
 */
export function createDocRoot(name: string, path: string, createIfMissing = false): Promise<DocRootStatus> {
  return call<DocRootStatus>("create_doc_root", { request: { name, path, createIfMissing } });
}

export function deleteDocRoot(id: string): Promise<void> {
  return call<void>("delete_doc_root", { id });
}

export function listDocumentEntries(
  rootId: string,
  parentPath = "",
  cursor: string | null = null,
  limit = 200,
): Promise<DocumentEntryPage> {
  return call<DocumentEntryPage>("list_document_entries", { rootId, parentPath, cursor, limit });
}

export function searchDocumentEntries(
  rootId: string,
  query: string,
  cursor: string | null = null,
  limit = 200,
): Promise<DocumentEntryPage> {
  return call<DocumentEntryPage>("search_document_entries", { rootId, query, cursor, limit });
}

export function getDocumentFile(rootId: string, relativePath: string): Promise<DocumentFile> {
  return call<DocumentFile>("get_document_file", { rootId, relativePath });
}

/** 문서 본문에 적힌 링크 하나를 가리키는 요청 본문. `currentPath`는 링크를 만난 문서의
 *  루트 기준 상대 경로다. 읽기와 내려받기가 같은 모양을 쓴다(`sessionLinkedFileRef`와
 *  같은 규칙). */
export type DocLinkedFileRef = {
  rootId: string;
  currentPath: string;
  href: string;
};

export function docLinkedFileRef(
  rootId: string,
  currentPath: string,
  href: string,
): DocLinkedFileRef {
  return { rootId, currentPath, href };
}

export function getDocLinkedFile(
  rootId: string,
  currentPath: string,
  href: string,
): Promise<LinkedFile> {
  return call<LinkedFile>("get_doc_linked_file", { request: docLinkedFileRef(rootId, currentPath, href) });
}

/**
 * 새 문서를 만든다. 같은 경로가 이미 있으면 백엔드가 Conflict로 거절한다 — 저장(`putDoc`)과
 * 달리 이 입구는 덮어쓰지 않는다(QA #65).
 */
export function createDoc(rootId: string, relativePath: string, content: string): Promise<DocFile> {
  return call<DocFile>("create_doc", { request: { rootId, relativePath, content } });
}

export function putDoc(
  rootId: string,
  relativePath: string,
  content: string,
  expectedModifiedAt: number | null,
): Promise<DocFile> {
  return call<DocFile>("put_doc", {
    request: { rootId, relativePath, content, expectedModifiedAt },
  });
}

export function getDocumentAutomationSnapshot(): Promise<DocumentAutomationSnapshot> {
  return call<DocumentAutomationSnapshot>("get_document_automation_snapshot");
}

export function createDocumentTrigger(request: DocumentTriggerInput): Promise<DocumentTrigger> {
  return call<DocumentTrigger>("create_document_trigger", { request });
}

export function updateDocumentTrigger(id: string, input: DocumentTriggerInput): Promise<DocumentTrigger> {
  return call<DocumentTrigger>("update_document_trigger", { id, input });
}

export function deleteDocumentTrigger(id: string): Promise<void> {
  return call<void>("delete_document_trigger", { id });
}

export function setDocumentTriggerEnabled(id: string, enabled: boolean): Promise<DocumentTrigger> {
  return call<DocumentTrigger>("set_document_trigger_enabled", { id, enabled });
}

export function runDocumentTriggerTest(id: string): Promise<DocumentTriggerRun> {
  return call<DocumentTriggerRun>("run_document_trigger_test", { id });
}

export function acknowledgeDocumentOfflineReport(id: string): Promise<void> {
  return call<void>("acknowledge_document_offline_report", { id });
}
