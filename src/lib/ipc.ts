/**
 * 화면이 백엔드에 쓰는 이름 전부를 한 곳에서 다시 내보내는 목록. 정의는 도메인별
 * `ipc*` 모듈에 있고, 이 파일은 그 이름들을 모아 `lib/ipc` 한 경로로 열어 둘 뿐이다 —
 * 화면 쪽 import 경로를 도메인이 갈릴 때마다 따라 고치지 않게 하려는 것이다.
 *
 * 명령 **정의는 여기 두지 않는다.** 새 명령은 성질에 맞는 `ipc*` 모듈에 적고 이 목록에
 * 이름만 얹는다.
 *
 * 목록에 얹는 기준은 **화면이 그 이름을 실제로 가져가는가** 하나다. 손으로 유지하는
 * 목록이라 이름을 얹는 일은 쉽고 걷어내는 일은 잊히기 쉬워, 아무도 import하지 않는
 * 재수출이 쌓였다(오류 클래스 하나, 요청 타입 다섯). 그 줄들은 화면이 쓰는 이름을
 * 세려는 사람에게 그만큼의 거짓 표면이고, 모듈 안에서만 쓰는 이름까지 여기 있으면
 * "이 파일이 곧 화면의 백엔드 접면"이라는 이 목록의 뜻이 흐려진다. 도메인 모듈 안에서만
 * 쓰이는 이름(`call`·`sessionRef`·`*LinkedFileRef` 등)을 애초에 얹지 않은 것과 같은
 * 기준이다 — 쓰는 자리가 생기면 그때 다시 얹는다.
 */
export {
  attachProjectInstructionDeployment,
  checkProjectInstructionDelete,
  createProjectInstruction,
  deleteProjectInstructionDeployment,
  deleteSharedProjectInstruction,
  detachProjectInstructionDeployment,
  getDeployedInstructionLinkedFile,
  getProjectInstructionLibrary,
  getProjectInstructionMigrationPlan,
  importProjectInstruction,
  listInstructionTrash,
  previewProjectInstructionImport,
  publishProjectInstruction,
  purgeInstructionTrash,
  readDeployedInstructionFile,
  readProjectInstructionFile,
  restoreInstructionTrash,
  setProjectInstructionAutoSync,
  setProjectInstructionPlatforms,
  syncProjectInstructionFromDeployment,
  unarchiveSharedProjectInstruction,
  updateProjectInstruction,
} from "./ipcInstructions";
export {
  acknowledgeDocumentOfflineReport,
  createDoc,
  createDocRoot,
  createDocumentTrigger,
  deleteDocRoot,
  deleteDocumentTrigger,
  getDocLinkedFile,
  getDocRoots,
  getDocumentAutomationSnapshot,
  getDocumentFile,
  listDocumentEntries,
  putDoc,
  runDocumentTriggerTest,
  searchDocumentEntries,
  setDocumentTriggerEnabled,
  updateDocumentTrigger,
} from "./ipcDocuments";
export {
  cancelFileDownload,
  downloadChatLinkedFile,
  downloadDeployedInstructionLinkedFile,
  downloadDocLinkedFile,
  downloadDocumentFile,
  downloadSessionLinkedFile,
} from "./ipcLinkedFile";
export {
  cancelUiTranslation,
  getMenuTranslations,
  getSystemAutomationSnapshot,
  getTranslatedDetail,
  requestSystemLanguage,
  resetMenuTranslation,
  retryMenuTranslation,
  retryUiTranslation,
  setSystemAutomationSettings,
  translateResource,
} from "./ipcTranslation";
export {
  deleteSystemWorkflow,
  executeSystemWorkflow,
  getSystemWorkflow,
  getSystemWorkflows,
  proposeSystemWorkflow,
  registerSystemWorkflow,
  setSystemWorkflowPacing,
} from "./ipcWorkflows";
export {
  getAgentBuiltinTools,
} from "./ipcBuiltinTools";
export {
  checkDbConnection,
  getDbConnections,
  removeDbConnection,
  setDbConnection,
  setDbConnectionEnabled,
} from "./ipcDbConnections";
export {
  getLocalLlmConnection,
  getLocalLlmConnections,
  probeLocalLlmConnection,
  removeLocalLlmConnection,
  setDefaultLocalLlmConnection,
  setLocalLlmConnection,
  upsertLocalLlmConnection,
} from "./ipcLocalLlm";
export {
  createRoundGoal,
  deleteRoundGoal,
  deleteRoundReport,
  getRoundGoals,
  getRoundReport,
  listRoundReports,
  resolveRoundDecision,
  updateRoundGoal,
} from "./ipcRounds";
export {
  checkSshEndpoint,
  deleteSshKey,
  generateSshKey,
  getSshKeys,
  readSshPublicKey,
  setSshKeyEndpoint,
  setSshKeyNote,
} from "./ipcSshKeys";
export {
  beginExternalPluginOAuth,
  cancelExternalPluginOAuth,
  getExternalPlugins,
  registerExternalPlugin,
  removeExternalPlugin,
  setExternalPluginEnabled,
  setExternalPluginToken,
  setExternalPluginToolPolicies,
  setExternalPluginToolPolicy,
  updateExternalPlugin,
  verifyExternalPlugin,
} from "./ipcExternalPlugins";
export {
  addCypressWorkspace,
  deleteCypressWorkspaceFile,
  getCypressRegistry,
  getCypressRunStatus,
  installCypressModule,
  listCypressRuns,
  listCypressWorkspaceFiles,
  openCypressRunner,
  readCypressEnvFile,
  readCypressWorkspaceFile,
  removeCypressWorkspace,
  runCypressSpec,
  setCypressEnabled,
  setCypressWorkspaceOptions,
  stopCypressRun,
  writeCypressEnvFile,
  writeCypressWorkspaceFile,
} from "./ipcCypress";
export {
  BackendBusyError,
  RemoteConnectionError,
  getWebAccessStatus,
} from "./ipcTransport";
export type { WebAccessStatus } from "./ipcTransport";
export {
  getBackendServiceSettings,
  initializeBackendService,
  setBackendServiceSettings,
} from "./ipcBackendService";
export type { BackendServiceSettings } from "./ipcBackendService";
export {
  beginProviderAccountLogin,
  cancelProviderAccountLogin,
  consumeAccountResetCredit,
  deleteProviderAccount,
  finishProviderAccountLogin,
  getAccountTools,
  getAccountUsageHistory,
  getAntigravityPacingUsage,
  getAntigravityUsage,
  getProviderAccounts,
  refreshProviderAccountUsage,
  refreshProviderAccountUsages,
  revalidateProviderAccountCredential,
  setAutoSwitchPolicy,
  setAutoSwitchResume,
  setAutoSwitchUsageGap,
  setProviderAccountAutoSwitch,
  setProviderAccountAutoSwitchPriority,
  setProviderAccountDisabled,
  setProviderAccountLabel,
  setProviderAccountNote,
  setResumeAccountPolicy,
  switchActiveProviderAccount,
} from "./ipcAccounts";
export {
  checkProviderCliUpdate,
  clearProviderModelCaches,
  getCliUpdateStatus,
  getProviderRuntimeCounts,
  updateProviderCli,
} from "./ipcProviderCli";
export {
  compareSkillInstall,
  createCommonSkill,
  deleteSharedSkill,
  deleteSkill,
  getCommonSkillDetail,
  getCommonSkillDigests,
  getSkillDetail,
  getSkillLibrary,
  getSkillMigrationPlan,
  importSkillToCommon,
  listSkillTrash,
  publishCommonSkill,
  purgeSkillTrash,
  readCommonSkillFile,
  restoreSkillTrash,
  setSkillAutoSync,
  setSkillPlatforms,
  syncSkillFromInstall,
  unarchiveSharedSkill,
  updateCommonSkill,
} from "./ipcSkills";
export {
  clearSessionCleanupTombstones,
  createSessionFolder,
  deleteSessionFolder,
  directSessionTranscriptImageUrl,
  getCatalogHealth,
  getSessionCleanupStatus,
  getSessionDetail,
  getSessionLinkedFile,
  getSessionMeta,
  getSessionSummary,
  openProviderSessionApp,
  patchSessionMeta,
  readSessionTranscriptImage,
  reconcileSessionCatalog,
  refreshSessionCatalog,
  reorderSessionFolder,
  runSessionCleanup,
  setSessionCleanupPolicy,
  updateSessionFolder,
} from "./ipcSessions";
export {
  analyzeAiaEvent,
  answerUiQuery,
  clearReadChatAttention,
  dismissChatAttention,
  getChatAttentionSnapshot,
  getChatLinkedFile,
  getAiaOnboardingCatalog,
  getAiaSuggestionCatalog,
  getChatProviderOptions,
  getDetachedChatForSession,
  getLiveChats,
  getShutdownImpact,
  markAllChatAttentionRead,
  markChatAttentionRead,
} from "./ipcChat";
export type { AiaBackgroundAnalysis } from "./ipcChat";
export { listAllChatSecrets, listChatSecrets, listSavedSecrets, readChatSecretValue, readSavedSecretValue, rememberChatSecret, removeChatSecret, removeSavedSecret, saveSecret, setChatSecret, setSavedSecretAgentEnabled } from "./ipcChatSecrets";
export {
  cancelScheduledRun,
  createScheduledRequest,
  deleteScheduledRequest,
  getScheduledRequestDetail,
  getScheduledRunDetail,
  getSchedulerSnapshot,
  runScheduledRequestNow,
  setScheduleEnabled,
  setSchedulesPaused,
  updateScheduledRequest,
} from "./ipcScheduler";
export {
  acknowledgeDrainNotice,
  getUsageBudget,
  setUsageBudgetAccount,
  setUsageBudgetConsumer,
  setUsageBudgetPolicy,
  setUsageBudgetSavings,
} from "./ipcUsageBudget";
export {
  getBackgroundSettings,
  getSleepPrevention,
  getTailscaleServiceStatus,
  hasTauriRuntime,
  respondToQuit,
  restartApp,
  setBackgroundSettings,
  setRemoteWriteEnabled,
  setSleepPrevention,
  setTailscaleServiceEnabled,
  showNativeNotification,
} from "./ipcHost";
export type { SleepPreventionStatus, TailscaleServiceStatus } from "./ipcHost";
export {
  getClaudePluginBranchRules,
  getClaudeSettingsStates,
  removeClaudePluginBranchRule,
  setClaudePluginBranchRule,
  setClaudePluginEnabled,
  setClaudeSkillOverride,
} from "./ipcClaudeSettings";
export {
  getProviderTelemetry,
  setProviderTelemetryOption,
} from "./ipcProviderTelemetry";
export {
  commitProjectGit,
  fetchProjectGit,
  getProjectGitCommitFiles,
  getProjectGitDiff,
  getProjectGitLog,
  getProjectGitOverview,
  getProjectGitStatus,
  listProjectEntries,
  pullProjectGit,
  pushProjectGit,
  readProjectFile,
  rebaseProjectGit,
  stageProjectGitPaths,
  stashProjectGit,
  switchProjectGitBranch,
  unstageProjectGitPaths,
} from "./ipcProjects";
export {
  createDirectory,
  getAgentDetail,
  getArtifactDetail,
  getManagerSnapshot,
  getManagerSnapshotSync,
  getProjectRegistry,
  getResourceRepository,
  getStorageOverview,
  previewDirectoryCreation,
  setProjectActive,
  setResourceRepository,
} from "./ipcWorkspace";
