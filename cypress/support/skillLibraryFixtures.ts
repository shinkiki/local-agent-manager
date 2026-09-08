/// <reference types="cypress" />

// 스킬관리(보관 스킬) 스펙 넷이 저마다 `get_skill_library` 응답의 같은 리터럴 세 벌
// (공급자 설치 상태·보관 원본·목록 항목)과 "스킬 화면을 열고 스킬관리 탭을 누른다"는
// 같은 세 걸음을 통째로 적어 두고 있었다. 응답에 필드가 하나 늘 때마다 네 곳을 같이
// 고쳐야 했으므로, 기본 모양과 여는 절차를 여기 한 벌만 두고 스펙은 달라지는 값만 넘긴다.

/** 보관 스킬 필터 네 축의 localStorage 키. 스펙은 앱이 뜨기 전에 이 값을 심는다. */
export const SKILL_FILTERS_KEY = "agent-manager.skill-library-filters.v1";

/** 네 축 모두 '전체'. 표본 전체가 목록에 나오게 하는 씨앗이다. */
export const ALL_SKILL_FILTERS = JSON.stringify({ kind: "all", state: "all", agent: "all", origin: "all" });

export interface SkillProviderFixture {
  provider: string;
  status: string;
  scope: string;
  origin: unknown;
  skillId: string | null;
  path: string;
  directory: string;
  targetDirectory: string;
  readOnly: boolean;
  contentDigest: string;
  divergent: boolean;
  note: string | null;
  installs: unknown[];
}

export interface SkillCommonSourceFixture {
  id: string;
  key: string;
  name: string;
  description: string;
  path: string;
  directory: string;
  contentDigest: string;
  fileCount: number;
  totalBytes: number;
}

export interface SkillEntryFixture {
  key: string;
  createdAtMs: number;
  origin: unknown;
  autoSync: boolean;
  platforms: unknown[];
  active: boolean;
  migrationRequired: boolean;
  activeVariant: unknown;
  name: string;
  description: string;
  originKind: string;
  common: SkillCommonSourceFixture | null;
  managed: boolean;
  directoryName: string;
  providers: SkillProviderFixture[];
  linkedCount: number;
  installedCount: number;
  missingCount: number;
}

export interface SkillLibraryFixture {
  schemaVersion: number;
  commonRoot: string;
  commonRootPresent: boolean;
  currentPlatform: string;
  entries: SkillEntryFixture[];
  adapters: unknown[];
  projects: unknown[];
  issues: unknown[];
}

/**
 * 스펙마다 다른 임시 경로 뿌리(`/tmp/am40` 등) 하나를 받아 그 뿌리에 매인 빌더 묶음을
 * 낸다. 경로는 화면이 저장소 이름·위치를 뽑는 근거라 스펙별로 그대로 유지한다.
 */
export function skillLibraryFixtures(root: string) {
  const commonRoot = `${root}/common`;

  const providerState = (provider: string, overrides: Partial<SkillProviderFixture> = {}): SkillProviderFixture => ({
    provider,
    status: "linked",
    scope: "user",
    origin: null,
    skillId: null,
    path: `${root}/${provider}`,
    directory: `${root}/${provider}`,
    targetDirectory: `${root}/${provider}`,
    readOnly: false,
    contentDigest: "d1",
    divergent: false,
    note: null,
    installs: [],
    ...overrides,
  });

  const commonSource = (key: string): SkillCommonSourceFixture => ({
    id: `common-${key}`,
    key,
    name: key,
    description: `${key} 설명`,
    path: `${commonRoot}/${key}`,
    directory: key,
    contentDigest: "d1",
    fileCount: 1,
    totalBytes: 100,
  });

  const entry = (
    key: string,
    options: { common: boolean; providers: SkillProviderFixture[]; origin?: unknown },
  ): SkillEntryFixture => ({
    key,
    createdAtMs: 1_700_000_000_000,
    origin: options.origin ?? null,
    autoSync: false,
    platforms: [],
    active: true,
    migrationRequired: false,
    activeVariant: null,
    name: key,
    description: `${key} 설명`,
    originKind: "personal",
    common: options.common ? commonSource(key) : null,
    managed: true,
    directoryName: key,
    providers: options.providers,
    linkedCount: options.providers.length,
    installedCount: options.providers.length,
    missingCount: 0,
  });

  const library = (entries: SkillEntryFixture[]): SkillLibraryFixture => ({
    schemaVersion: 1,
    commonRoot,
    commonRootPresent: true,
    currentPlatform: "macos",
    entries,
    adapters: [],
    projects: [],
    issues: [],
  });

  return { commonRoot, providerState, commonSource, entry, library };
}

/**
 * 보관 스킬 목록까지 가는 세 걸음. 스펙마다 뒤에 붙는 확인(필터바·일괄 작업 바·목록
 * 건수)은 관심사가 달라 각 스펙에 남긴다.
 */
export function openSkillLibrary(): void {
  cy.visitApp({ [SKILL_FILTERS_KEY]: ALL_SKILL_FILTERS });
  cy.openView("skills");
  cy.get(".skill-mode-tabs button").contains("스킬관리").click();
}

/** 일괄 작업 바와 그 안의 실행 버튼. 두 스펙이 같은 선택자를 따로 적어 왔다. */
export const skillBulkBar = () => cy.get(".skill-bulk-bar");
export const skillBulkButton = (label: string) => skillBulkBar().contains("button", label);
