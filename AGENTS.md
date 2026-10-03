# Agent Manager Tauri engineering rules

Conditions a change must satisfy before it is reported complete. IDs (`G4`, `C1-8`, `E3`, `W2`)
are stable — cite them in reviews, code comments, and test names so a missing condition is
greppable instead of buried in prose.

## 1. Architecture boundary

| Layer | Owns | Must not |
| --- | --- | --- |
| `src/` | rendering, input collection, typed IPC helper calls | domain logic, direct filesystem or process access |
| `src-tauri/` | thin adapter translating IPC requests into Rust Core calls; windows, dialogs, autostart, packaging | its own `AccountSupervisor`, any domain logic |
| `crates/agent-manager-core/` | domain models, provider adapters, session parsing, indexing, persistence, file watching, process supervision, platform behavior | any dependency on Tauri or frontend types |
| `crates/agent-manager-server/` | the single loopback backend exposing Core over typed HTTP/WebSocket to bundled, browser, and remote UIs | domain logic beyond transport, auth, and write-gating |

## 2. Security invariants

Apply to every change. The only permitted deviations are the numbered exceptions in section 3.

- **G1** Provider-managed authentication, session, history, and state stores may be accessed
  **read-only**, and only when required for account discovery, usage inspection, session
  parsing, indexing, or provider integration.
- **G2** Never directly mutate a provider-owned session, history, settings, plugin, JSONL,
  SQLite, PB, or related state store. Mutation includes writing, replacing, renaming, deleting,
  truncating, copying, linking, changing permissions, migrating schemas, and executing write
  transactions.
- **G3** Writes performed by the provider's official CLI or app-server are allowed. Agent
  Manager may create and select isolated provider profile directories. Authentication inside a
  profile directory that the provider owns must be produced or updated by the provider's official
  process; the only profiles Agent Manager may populate itself are the account-scoped credential
  profiles under its own app data directory described in `C4`.
- **G4** Authentication secrets may be read or replaced only inside the Rust Core credential
  adapter, and only when required for an account-scoped provider request. Secret values stay
  ephemeral outside the OS secure store and the `C4` credential profile store, and are never
  persisted in any other Agent Manager file, copied into provider history, logged, included in
  errors or telemetry, returned over IPC or remote APIs, or exposed to the frontend.
- **G5** Non-secret account metadata (provider account ID, email, organization, plan, profile
  path, token expiry) may be stored after secrets have been removed.
- **G6** Prefer official CLI or app-server account and usage APIs over direct credential parsing
  whenever equivalent functionality exists.
- **G7** Derived indexes, summaries, caches, and device-local metadata are written only to Agent
  Manager-owned storage in the app data directory (for example `manager-state.json`,
  `translation-cache.sqlite3`, `aia-*.json`). User-authored skill and policy sources may also be
  written to the explicitly selected C3/C5 resource repository. Provider-owned source stores
  remain authoritative.
- **G8** Never read or persist unrelated environment variables.
- **G9** Never execute an arbitrary shell string. Resolve an approved executable and pass
  arguments as a structured vector.
- **G10** Validate and canonicalize filesystem paths in Rust before reading or writing.
- **G11** Mutating operations are write-gated. A mutation is additionally reachable from the
  remote UI in write mode only when it stays inside validated app-owned or app-managed targets
  and is recoverable. Anything touching provider-owned state outside that boundary is not
  remote-eligible. Write mode has exactly one stored decision point — `remoteWrite` in
  `backend-service-settings.json`, owned by the host-only Settings → 백엔드 서비스 toggle
  (`set_remote_write_enabled`), applied to the running backend without a restart. Headless
  launches may state the operator's choice with `--remote-write` / `--no-remote-write`, which
  writes that same setting instead of deciding separately.

## 3. Direct-mutation exceptions

The adapters below are the only direct-mutation exceptions. Nothing else may write outside the
default app-data boundary or hold credential material there.

| # | Adapter | Write target | Recovery | Remote in write mode |
| --- | --- | --- | --- | --- |
| C1 | credential adapter (`accounts.rs`, `external_processes.rs`) | verified active Codex `auth.json`, Claude `.credentials.json`, or OS Keychain item | secret-free recovery journal + restore on failed verification | no |
| C2 | CLI update adapter (`cli_updates.rs`) | allowlisted model catalog cache — today exactly `CODEX_HOME/models_cache.json` | provider CLI regenerates it; carries no user state | yes |
| C3 | skill library adapter (`skill_library.rs`, `skill_trash.rs`, `resource_repository.rs`) | configured common repository plus installable provider skill roots (user and registered-project) | app-owned trash with manifest; atomic staged replace | yes, except repository path selection |
| C4 | credential profile adapter (`credential_profiles.rs`, `accounts.rs`) | account-scoped credential profile under `<app data>/credential-profiles/<provider>/<account id>/`, and the OS Keychain item derived from that path | Vault stays authoritative; the profile is rebuilt from it and removed with the account registration | no |
| C5 | project policy adapter (`project_instructions.rs`) | configured policy repository, `AGENTS.md`, `CLAUDE.md`, or `GEMINI.md` inside a registered project or provider home config directory, and the linked documents that instruction imports, at their own relative paths under the same root | atomic staged replace per file; existing policy or linked-document changes require explicit overwrite; removal moves files to the app-owned trash as one group | yes, except repository path selection |
| C6 | user directory adapter (`user_path.rs`) | up to three missing directories under an existing anchor the user typed, outside provider homes and app data | the created directories are empty; removing them restores the previous state | yes |
| C8 | Claude settings adapter (`claude_settings.rs`) | only `enabledPlugins` and `skillOverrides` entries in user settings or an active registered project's local settings | private pre-write backups plus atomic same-directory replacement | yes |
| C9 | SSH key adapter (`ssh_keys.rs`, `ssh_endpoints.rs`, `ssh_exec.rs`, `ssh_approvals.rs`) | one new Ed25519 key pair directly under `~/.ssh`, plus renaming one existing pair into `~/.ssh/.agent-manager-trash/`; key memos and per-key endpoints in the app data directory | creation: same-directory staging plus no-clobber hard-link publication, removing the staged files and any half-published link on failure. removal: the pair is moved, never erased, and is restored by moving it back out of the trash | yes |
| C10 | database connection adapter (`db_connections.rs`, `db_sql.rs`, `db_exec.rs`, `db_approvals.rs`, `db_cli.rs`) | the external databases the user registered and enabled for agents, plus connection metadata in the app data directory and the OS Keychain item derived from the connection id | reads run inside an engine-level read-only transaction; writes run inside a transaction after a previewed row count, and the receipt records both the previewed and the committed count | registration, credential entry and statement execution are host-only; listing, the agent-use toggle and the connection check are remote-eligible in write mode |
| C11 | session cleanup adapter (`session_cleanup.rs`) | app-data session stores, and session transcripts inside a `C4` credential profile — never a shared provider home | app-owned trash with manifest, purged after the configured retention | yes |
| C13 | provider telemetry adapter (`provider_telemetry.rs`) | the usage-collection switches of installed provider CLIs — `env.DISABLE_TELEMETRY`, `env.DISABLE_ERROR_REPORTING`, `env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` in Claude user settings, `[otel] exporter` and `[otel] log_user_prompt` in `CODEX_HOME/config.toml`, `privacy.usageStatisticsEnabled` and `telemetry.enabled` in `~/.gemini/settings.json` | private pre-write backups plus atomic same-directory replacement | yes |
| C12 | HOME isolation profile adapter (`credential_profiles.rs`, `accounts.rs`) | Antigravity account profile under `<app data>/credential-profiles/antigravity/<account id>/` — its own token files plus directory symlinks into the shared home; on Windows additionally **clearing** (never writing) the machine-global Credential Manager entry `gemini:antigravity` before a login or a start (`C12-11`) | Vault stays authoritative; the profile is rebuilt from it, and conversation bodies are confirmed before it is removed. The cleared entry is a copy of a login the Vault already holds, and the CLI recreates it on its next refresh | no |
| C15 | chat secret broker (`chat_secrets.rs`, `chat_secret_cli.rs`) | nothing on disk — named secret values the user hands to one chat live only in backend memory, and the only place a value leaves that memory is the environment of a child process the backend spawns on the agent's behalf | values expire, are dropped with the chat, and are scrubbed from the child's captured output; the agent never receives a value, only its name | yes — the whole feature follows the one `remoteWrite` switch (`C15-7`) |
| C17 | saved secret vault (`saved_secrets.rs`) | the OS Keychain item derived from a secret name, plus its name, purpose, agent-use flag and timestamps in the app data directory | the user saved it deliberately and deletes it the same way; no provider state is touched | yes — the whole feature follows the one `remoteWrite` switch (`C17-7`) |
| C14 | local provider execution harness (`acp.rs`, `opencode_config.rs`, `local_llm.rs`) | exactly two keys in the user-owned `~/.config/opencode/opencode.json` — `provider.agent-manager-local` and the `agent.agent-manager-local*` entries — plus the connection record in the app data directory and the OS Keychain item holding its API key | every other key is read and written back untouched and the file is replaced atomically; turning the connection off removes the two keys rather than leaving a stale address behind | yes — registering the connection and probing a server address are both write-gated, the probe deliberately so (`C14-7`) |
| C16 | project git adapter (`project_git.rs`) | the git repository whose worktree contains an **active registered project** — index, refs, stash and worktree files — only through the user's own `git` binary; a repository whose top-level is the user's home or a restricted root is refused | every offered operation leaves a reflog / `ORIG_HEAD` / stash anchor on its receipt (`headBefore`, `headAfter`, `droppedStashSha`); irrecoverable commands (`reset --hard`, `clean`, discarding worktree changes, `branch -D`, `--force*`, `--amend`, interactive rebase) are not offered at all | yes, except `push_project_git` (host-only: it publishes outward with the host user's credentials) |
| C18 | cask quarantine release (`cli_quarantine.rs`) | the `com.apple.quarantine` extended attribute — nothing else — on regular files directly inside the resolved provider CLI's `Caskroom/<token>/<version>/…` folder, for a cask token registered in `TRUSTED_CASK_SIGNERS` and a file whose signature satisfies that vendor's Developer ID team | the attribute only makes Gatekeeper re-evaluate a notarized binary on every exec; file contents, permissions and every other attribute stay as installed, and the next cask upgrade stamps a fresh folder anyway | yes — it runs as part of resolving an executable, never as its own operation |
| C19 | local overlay adapter (`project_overlays.rs`) | 앱 데이터의 `<app data>/git-overlays/`, 그리고 스냅샷·적용 시점에만 **등록된 활성 프로젝트** 작업 트리의 선택된 추적 파일 | patch를 먼저 쓰고 digest까지 확인한 뒤에만 되돌리고, 재적용은 `git apply --check`가 통과할 때만 한다. 세트 삭제는 앱 소유 휴지통으로 옮긴다 | 읽기는 열려 있고, 세트 저장·삭제와 작업 트리를 바꾸는 스냅샷·적용 모두 write mode에서 원격 가능(2026-10-02 사용자 결정) |

### C1 — credential adapter

- **C1-1** Atomically replace only the verified active Codex `auth.json` or Claude
  `.credentials.json` / OS Keychain credential item.
- **C1-2** Take the provider account lock before replacing.
- **C1-3** Record a secret-free recovery journal before replacing.
- **C1-4** A manual active account change first stops every Agent Manager-managed runtime for
  that provider that reads the shared credential. Runtimes started with a `C4` credential profile
  read only their own account credential, so they are neither stopped nor counted.
- **C1-5** Escalate a failed graceful stop to a PID-based SIGKILL.
- **C1-6** Verify the shared-credential runtime count is zero under the provider account lock
  before replacing the shared credential. Runtimes bound to a `C4` credential profile are
  excluded from that count; account-unscoped runtimes (setup terminals) always count because they
  run in the shared CLI home.
- **C1-7** If any managed runtime still fails to stop after escalation, the credential must not
  change.
- **C1-8** A manual active account change also terminates externally launched provider CLI
  processes owned by the current user (SIGTERM, then SIGKILL escalation) before replacing.
- **C1-9** External termination targets only processes whose command resolves to the provider CLI
  executable, including `node`/`bun` wrappers.
- **C1-10** External termination excludes Agent Manager itself with its descendants and
  ancestors. Descendants of a matched process (MCP servers and other session-spawned helpers)
  are terminated with it as one session tree.
- **C1-11** External-termination failures are reported on the receipt and do not block the
  credential change.
- **C1-12** Terminating external processes is otherwise allowed only through the dedicated
  explicit operation, never as a side effect of another command.
- **C1-13** Verify the selected account after replacement.
- **C1-14** Restore the previous credential if verification fails.
- **C1-15** Restore the previous active account after a temporary scheduled run.

### C2 — model catalog cache cleanup

- **C2-1** Delete only a file registered in the provider cache allowlist in `cli_updates.rs`.
- **C2-2** Register a file only after verifying, in the provider's own layout, that it exists and
  serves as a version-keyed model catalog cache.
- **C2-3** Delete only when the cache records a client version newer than the running CLI version,
  or when the cache cannot be parsed. A cache recorded by an older client is reported but never
  deleted: the provider home can be shared with other clients, and the running CLI restamps the
  file on its next catalog fetch.
- **C2-4** Delete only after the provider's managed chats and terminals are stopped and
  externally launched provider CLI processes are terminated.
- **C2-5** Delete only a regular file whose parent canonicalizes to the selected provider home.
  Never a symlink, never a directory.
- **C2-6** Never register and never delete authentication, configuration, session or conversation
  history, account, plugin, skill, or log files.
- **C2-7** Execution is write-gated and remote-eligible in write mode, as is CLI update
  execution, because the cache is regenerated by the provider's own CLI on its next run.

### C3 — skill library

- **C3-1** The publish source is `<resource repository>/skills/<key>`. The repository defaults to `<app data>/resource-repository` and may be changed to a user-selected absolute folder such as a cloud-drive subfolder. Path selection is host-only; the stored setting remains device-local.
- **C3-2** A personal publish target must be a root an adapter marks installable — today exactly
  `~/.claude/skills`, `~/.codex/skills`, `~/.gemini/config/skills`, and
  `~/.config/opencode/skill` for Claude, Codex, Antigravity, and the local provider respectively.
- **C3-3** A project publish target must be `<project>/.claude/skills`,
  `<project>/.codex/skills`, `<project>/.agents/skills`, or `<project>/.opencode/skill` for
  Claude, Codex, Antigravity, and the local provider
  respectively, inside a **registered** project. Registered projects come from the unified Agent
  Manager session catalog across all four providers, not from `~/.claude.json` alone.
  The requested path is canonicalized and must match exactly; an unregistered path is rejected. A
  project the user marked inactive in Settings (device-local `excludedProjects` in
  `manager-state.json`) is dropped together with its sessions when the catalog snapshot is composed,
  so it is never a registered project.
- **C3-4** Provider- and plugin-owned skill roots are read-only and are never a publish target:
  `~/.codex/skills/.system`, `~/.gemini/*/builtin/skills`, and Claude plugin install paths
  recorded in `~/.claude/plugins/installed_plugins.json` (marketplace clones are catalog
  copies, not installs, and are not scanned).
- **C3-5** On first initialization, legacy `~/.agents/skills` directories may be copied into the
  default repository without changing the legacy source. Never read or write
  `~/.agents/.skill-lock.json`, and refuse symlinked legacy content.
- **C3-6** A skill key must be a single validated path component.
- **C3-7** Every copied path must stay inside the resolved target root.
- **C3-8** Symlinked content is refused rather than followed.
- **C3-9** Stage a full copy, then atomic rename, so a failure leaves the previous install
  intact.
- **C3-10** Replace an existing install only on an explicit overwrite request. The default
  policy is to fail.
- **C3-11** Deletion never removes files outright. Move the install — or, for a shared skill, the
  source plus its deployments as one group — into the Agent Manager-owned trash with a manifest.
  The manifest is written last, so a manifest-less directory is incomplete and stays out of the
  listing.
  Unarchiving is the narrow form of the same move: only the archived source goes to the trash and
  every agent install stays where it is, so the skill returns to being an unarchived install.
- **C3-12** Deleting a symlink moves only the link, never the link target. Restore recreates the
  link from the manifest target when the content itself is gone.
- **C3-13** Restore puts an item back only when the original path is free.
- **C3-14** Publishing, importing, creating, deleting, variant updates, and trash restore/purge are
  write-gated and remote-eligible in write mode. Selecting the repository path is host-only.
  Reading the library and checking compatibility perform no writes and stay available remotely
  without write access.
- **C3-15** A resource without platform metadata is portable. A resource with metadata activates
  only its declared base platforms or an exact current-OS overlay. Publishing an unsupported OS
  is rejected and routed to an AIA migration plan.
- **C3-16** AIA may write a platform overlay only through the typed variant operation with an
  expected source digest. Model-generated scripts are never executed automatically during
  migration.

### C5 — project policy library

- **C5-1** Common policy sources live only under `<resource repository>/policies/<key>` and use
  the same platform metadata and device-local repository selection as C3.
- **C5-2** Publish targets are exactly `<project>/CLAUDE.md`, `<project>/AGENTS.md`, and
  `<project>/GEMINI.md` for Claude, Codex, and Antigravity respectively. The local provider reads
  `<project>/AGENTS.md` like Codex does, so it publishes nowhere of its own; its personal
  instructions go to `~/.config/opencode`. Plus the linked documents
  archived with that instruction, each written to its own relative path under the same deployment
  root.
- **C5-3** A target project must canonicalize to a visible project in the unified Agent Manager
  session catalog, or to a location already recorded in that instruction's deployment ledger
  (C5-10). Hidden sessions and the internal AIA workspace never register a project; a project that
  drops out of the catalog stays reachable only through its ledger entry, so an existing deployment
  can still be updated or withdrawn. An inactive project (C3-3) is the exception: its ledger
  deployments are neither shown, redeployed, adopted, nor withdrawn until the project is re-enabled;
  the ledger records themselves are kept, and a shared delete reports them as left in place.
- **C5-4** Symlinked sources or targets are refused. Existing target files are unchanged unless
  the request explicitly selects overwrite; replacement uses a same-directory stage and rollback
  backup. Redeployment (`update`, `sync`) is not such a request: it writes only where the current
  content still matches the digest this device last deployed there, and reports every other
  location as skipped instead of overwriting it. The same rule applies per linked document.
- **C5-5** Creating, importing, publishing, platform-metadata, and platform-variant writes are write-gated and
  remote-eligible in write mode. Repository path selection remains host-only.
- **C5-6** Policy migration follows C3-15 and C3-16: exact-OS activation, optimistic digest
  checks, and no automatic execution of generated commands or scripts.
- **C5-7** A linked document is archived and published only when the instruction reaches it through
  an `@path` import or Markdown link that resolves inside the deployment root. Location-bound links
  (`~/...`, absolute paths), links that escape the root, oversized files, and paths colliding with
  the archive's own layout are refused and reported as reasons, never silently dropped. Link
  extraction follows one rule shared with the frontend, verified by the same case file
  (`src/lib/markdownLinkCases.json`).
- **C5-8** A linked-document write creates only missing directories under the deployment root and
  refuses any symlink on that path. Linked documents are written before the instruction file so a
  failure never leaves a new instruction pointing at documents that are not there.
- **C5-9** A deployment is compared with its source as one set: the instruction file plus its
  archived linked documents. Adopting a deployment (`sync`) adopts that location's whole set, and
  deleting one moves the instruction file and the linked documents that still match the source into
  a single trash group. Externally edited linked documents are left in place and reported.
- **C5-10** Deployment ownership comes from a device-local ledger, never from file existence. The
  publish target names are fixed per provider (C5-2), so a project's own `AGENTS.md` is
  indistinguishable by name from one this device deployed; treating presence as ownership makes
  every unrelated project look externally edited and puts it in the blast radius of the next edit.
  The ledger lives in `<app data>/instruction-meta.json` beside the auto-sync flag (G7) and records,
  per instruction and location, the provider, scope, project path, and the digests last written for
  the instruction file and each linked document. Entries are added by publish, import, adopt
  (`sync`), and an explicit attach, and removed by deployment delete, source delete, unarchive
  (which withdraws the archived source only and leaves every deployed file and linked document in
  place), and detach.
  Set comparison, drift detection, auto-adopt, redeployment, and shared-delete collection consider
  ledger locations only; a file that merely exists is reported as present and never as divergent.
  Repositories carrying deployments made before the ledger existed are migrated exactly once per
  instruction, adopting only locations whose instruction file still matches the source digest;
  anything else needs an explicit attach, which never touches file content. That one-time migration
  is recorded only while an archived source actually exists, so restoring a source withdrawn by
  unarchive still re-adopts the deployments whose content it wrote.


### C4 — credential profile adapter

Parallel requests from more than one account require each runtime to carry its own credential.
Splitting the whole provider home would split transcripts, skills, settings, and MCP config with
it and break the session catalog, so only the credential is split: Claude through
`CLAUDE_SECURESTORAGE_CONFIG_DIR`, Codex through a per-account `CODEX_HOME` whose
`CODEX_SQLITE_HOME` still points at the shared thread database. Antigravity has no such variable —
it is covered by `C12`, which splits `HOME` itself.

- **C4-1** A profile lives only under `<app data>/credential-profiles/<provider>/<account id>/`,
  created `0700`, with the account id rejected if it can escape that root.
- **C4-2** The Vault (OS secure store) remains the authoritative credential. A profile holds a
  working copy for the provider CLI and is rebuilt from the Vault whenever the two differ.
- **C4-3** A profile credential lives in the OS Keychain item derived from the profile path from
  its very first write, never starting as a file that a later CLI token rotation would strand. A
  profile file (`0600`) is written only where the platform or provider has no Keychain path (Codex
  `auth.json`, non-macOS), and a leftover profile file is deleted once the Keychain item is
  authoritative. A write to a provider-owned home instead follows whichever store that CLI already
  uses, so the switch stays visible to it.
- **C4-4** Adopt a CLI-rotated profile credential into the Vault only when its parsed identity
  matches the account and it has not expired; otherwise overwrite the profile from the Vault.
- **C4-5** Profile paths and provider settings may be shared with the provider home by **link**
  (Codex `config.toml`, `hooks.json`, `plugins`, `skills`, `rules`, `AGENTS.md`). The shared entry
  stays the one authoritative copy; the profile never holds a duplicate of it. Which link kind is
  used is whatever the machine permits, decided in `symlink_entry` alone: a symlink where one can be
  created, and on Windows without `SeCreateSymbolicLinkPrivilege` — the default install, where
  symlink creation fails with `ERROR_PRIVILEGE_NOT_HELD` and used to block Codex and Antigravity
  isolation outright — a junction for a directory and a hard link for a file. A copy is never the
  fallback: an isolated session would read a stale snapshot of `skills` and `rules` while its own
  writes never reached the shared home, and both of those fail silently. When no link kind succeeds
  the profile is refused with the setting to change. Existing entries are compared by whether they
  already resolve to the same file, not by link kind, so a junction or hard link is not torn down
  and rebuilt on every preparation. Credentials are never linked.
- **C4-6** Verify isolation with the provider's own authentication-status command before using a
  profile, and fall back to shared-home execution when it fails. Never infer support from the
  environment variable alone.
- **C4-7** Deleting an account registration removes its profile directory and the Keychain item
  derived from that path.
- **C4-8** A profile credential is never logged, returned over IPC or remote APIs, or exposed to
  the frontend. Only the non-secret facts (isolation on/off, fallback reason) cross that line.
- **C4-9** Accepted risk: where no Keychain path exists -- Codex, and any non-macOS platform --
  the account credential exists as a `0600` file inside the app data directory, so it is protected
  by file permissions and full-disk encryption rather than the OS secure store. The shared provider
  home already stores the same secret the same way, so this adds a copy rather than a new class of
  exposure. Claude profiles are outside this risk: they are Keychain-only.

### C6 — user directory adapter

Chat working paths and document folders are typed by hand. Until now both called
`fs::canonicalize` directly, so a path that did not exist surfaced the raw `std::io` ENOENT
(`파일 처리 중 오류가 발생했습니다: No such file or directory (os error 2)`), which the frontend
could not classify and reported as `APP_RUNTIME`. `user_path.rs` is the single place that
interprets such input, and the only place Agent Manager creates a directory the user chose.

- **C6-1** One interpretation for every hand-typed folder path: trim surrounding whitespace,
  expand a leading `~` or `~/` (and `~\` on Windows) from `HOME`/`USERPROFILE`, then require an
  absolute path. `~other` is shell syntax for another user's home and is never expanded.
- **C6-2** A path that does not exist fails as `CoreError::NotFound` prefixed with
  `MISSING_DIRECTORY_PREFIX`. A path that exists but is not a directory, and a path that cannot be
  opened for permissions, fail as `InvalidInput` with their own wording. Raw `Io` stays for
  everything else.
- **C6-3** The frontend decides whether to offer directory creation from that prefix alone
  (`src/lib/missingDirectory.ts`). The two constants are asserted equal by a Rust test, because a
  one-sided edit silently removes the confirmation instead of failing.
- **C6-4** Creation makes up to `MAX_NEW_DIRECTORY_SEGMENTS` (3) missing segments under an
  anchor that already resolves to a directory — a project needs `docs/milestones`, not one rung
  at a time. Never `create_dir_all`: segments are created one at a time, each re-canonicalized
  and re-checked against the anchor and `store::is_restricted_doc_root` before the next one, so
  a symlink swapped in mid-run cannot move the rest of the tree. A request needing a fourth new
  segment fails as `InvalidInput` — **not** the `MISSING_DIRECTORY_PREFIX` `NotFound` — because
  the prefix is what makes the frontend offer creation, and offering it for a path that will be
  refused again is a loop.
- **C6-4a** A failure part-way through removes only the segments that call created, in reverse.
  Never a half-built tree, never a pre-existing directory.
- **C6-4b** The confirmation lists **every** segment that will be created, not just the final
  path. What the user approved and what appears must still match; with more than one segment
  that is only true if the list is shown. The list comes from `plan_user_directory`
  (`preview_directory_creation`), the same function creation itself plans with, so the two
  cannot drift. When the preview call fails the dialog falls back to the final path alone.
- **C6-5** The parent is canonicalized before the name is joined, so a symlink cannot move the new
  directory outside the confirmed location. Targets inside a provider home or the app data
  directory are refused with the same rule document folders use
  (`store::is_restricted_doc_root`). An existing directory at the target is returned unchanged, so
  a repeated confirmation is a no-op; a non-directory there is a `Conflict`.
- **C6-6** `create_directory` is write-gated and **remote-eligible in write mode** (user
  decision, 2026-09-20). The target is still a location the user picked rather than an app-owned
  one, but remote editing has a single stored decision point (`G11`), and "editing is allowed"
  is understood to include creating the folder the edit needs. What remains is an empty
  directory, provider homes and app data are still refused, and `C6-4b` shows every segment
  before it is created. Creation is always preceded by an explicit confirmation in the UI, never
  inferred from a failed start.

### C7 — Cypress automation workspaces (`cypress_workspaces.rs`, `cypress_runs.rs`)

A workspace is an explicitly registered Cypress project folder (`cypress.config.*`,
`cypress.env.json`, `support/`, `e2e/*.cy.js`) that the user edits in Add-ons → Cypress and that the
user or AIA runs for web tests, information lookup, crawling, or macros. There is no implicit
default workspace. Every file and run operation carries the selected workspace id. A registered
folder may use its own or another module directory (`node_modules/cypress`).

- **C7-1** The feature is **off by default**, and the `enabled` flag is the one gate a human opens.
  `run_cypress_spec` refuses while it is false. The flag itself (`set_cypress_enabled`),
  de-registration (`remove_cypress_workspace`) and the env file (`read/write_cypress_env_file`) are
  **not** in the AIA catalog — AIA guides the user to `settings.cypress` instead. Registration and
  installation (`add_cypress_workspace`, `install_cypress_module`) **are** in the catalog as
  Execute operations, but `require_cypress_enabled_for_aia` (`remote.rs`) refuses them from the AIA
  actor while the flag is false (user decision, 2026-08-29: once the toggle is on AIA already runs
  arbitrary host code through `run_cypress_spec`, so attaching one more validated folder is not a
  new risk, and per-project registration friction was blocking real work). All of these are
  write-gated commands allowed from the remote UI in write mode (user decision, 2026-08-29: the
  remote path is Tailscale-authenticated and the user configures workspaces from a phone);
  `read_cypress_env_file` is a read but sits in the write list so remote read-only mode never sees
  env plain text.
- **C7-2** `cypress.env.json` is the only file that holds secrets. It is written with mode 0600 and
  its plain text leaves the backend only through `read_cypress_env_file`. Every other reader
  (`read_cypress_workspace_file`, AIA, remote UI) receives a copy with all string values masked;
  the structure and keys stay so scripts can reference `Cypress.env("KEY")`.
- **C7-3** The backend never reads env values to run Cypress — the runner receives the job as a
  stdin JSON document (no argv, no environment variables) and Cypress loads the env file itself.
  Captured runner output and inline artifact bodies are scrubbed of the env file's string values
  before they are stored or returned. Credential-profile variables are removed from the child
  environment.
- **C7-4** File access is confined to the workspace root: relative paths only, `..`/absolute paths
  refused, `node_modules/`, `artifacts/` and `.git/` excluded, 512 KB per file, 2,000 files.
  External registration refuses provider homes and the app data directory
  (`store::is_restricted_doc_root`) and requires a `cypress.config.*`.
- **C7-5** Runs are asynchronous jobs (`jobId` + `get_cypress_run_status`) because MCP tool calls
  are synchronous. The runner is spawned in its own process group and killed with the group on the
  20-minute timeout so browsers do not survive it. Artifacts are read from
  `artifacts/runs/<jobId>/` only; JSON/text up to 64 KB is returned inline, images by path.
- **C7-5a** A workspace stores one explicit execution type. `standard` invokes Cypress with the
  registered project configuration. `agentManagerIsolated` requires a regular, non-symlink
  `scripts/e2e.mjs` inside the workspace root — the harness contract, not a particular repository:
  the backend invokes that fixed entrypoint with structured arguments and a stdin JSON job
  (`spec`, `summaryPath`, `screenshotsDir`, `port`, `timeoutMs`, `env`, `headed`, `video`) and the
  harness owns starting the app on that port with temporary state, readiness, the summary file,
  and cleanup. Isolation is a property of that lifecycle, so a project without the harness is
  refused with what to add rather than run unisolated. A running production listener is never its
  base URL. The old `default` registration is removed on registry load and its
  app-owned directory is renamed into `<app data>/cypress-workspace-trash/`, preserving any
  user-authored specs for manual recovery.
- **C7-6** Enabling the feature lets user- or AIA-authored scripts run arbitrary browser and Node
  code (`cy.exec`, `setupNodeEvents`) on the host. That is the accepted risk of the opt-in; the
  Execute approval on `run_cypress_spec` and the host-only gate are the controls, not sandboxing.

- **C7-7** Cypress is available to all agents through a dedicated loopback MCP endpoint. Claude/Codex attach it at standard-chat start; other shell-capable agents receive the bundled cypress-automation skill and app-owned endpoint pointer. Each tools/list and tools/call rechecks the enabled flag. Only the explicit Cypress allowlist is callable; enabling, removal and env plaintext remain UI-only. The existing opt-in permits host execution (C7-6); the agent runtime applies its tool/shell approval policy. No general aia_system capability is attached.

- **C7-8** `open_cypress_runner` launches the same runner in `cypress.open()` mode so a person can
  pick a spec in the Cypress launcher and step through it (`cy.pause()` is ignored by `cypress.run`,
  so a headed run cannot do this). It is absent from the AIA catalog — a tool that waits on a person
  cannot be one an agent calls — but it is **not** host-only: it carries the same authority as
  `run_cypress_spec`, which the remote UI may already call in write mode, and the window landing on
  the host is a fact to state rather than a permission boundary. `stop_cypress_run` ends any live
  run (the only way to close a launcher opened from a remote screen) and reports it as `closed`
  rather than an error. The job
  carries no spec (the launcher owns that choice) and refuses a second window while any run of that
  workspace is live. An `agentManagerIsolated` workspace opens too: the job sets `open` and the
  harness holds its temporary port, app data and HOME around the launcher, tearing them down when
  the window closes; its own timeout follows the launcher cap so it never reclaims a window a person
  is still using. It waits under a separate 8-hour cap, runs without `CI=1`, and ends in the
  `closed` state — closing a launcher, like stopping a run, is neither a pass nor a failure, and
  only a launcher that failed to start is an `error`.

### C8 — Claude plugin and skill settings (`claude_settings.rs`)

- **C8-1** The adapter may change only one `enabledPlugins` boolean entry or one
  `skillOverrides` entry whose value is `on`, `name-only`, `user-invocable-only`, or `off`.
  Arrays, objects, unknown values, and policy values are read-only and never overwritten.
- **C8-2** Every write first parses the whole file as a JSON object with a 1 MB cap. A malformed
  file, non-object root, symlink, non-regular file, or unexpected section shape is refused. Every
  unrelated key and value is preserved semantically; key order and whitespace may be normalized.
- **C8-3** Writes hold an Agent Manager app-data lock, save the previous bytes to the private
  `claude-settings-backups` store (five versions per target), write and fsync a same-directory
  temporary file, atomically replace the target, fsync its parent, and preserve an existing file's
  permissions. A newly created settings file is owner-only.
- **C8-4** Writable targets are exactly `~/.claude/settings.json` and
  `<active registered project>/.claude/settings.local.json`. Project `settings.json`, managed
  policy settings, inactive or unknown projects, and any flag-provided settings are read-only.
- **C8-5** Never write `~/.claude.json`, the plugin install registry or payload, another settings
  key, or a plugin-provided skill override. Plugin inventory and manifests remain read-only.
- **C8-6** Both setters are write-gated and remote-eligible in write mode: the path and project
  are validated, the mutation is bounded to two keys, and the previous file is recoverable from
  the app-data backup. A provider process may still write the same settings file concurrently;
  reloading and reapplying the toggle is the supported recovery path.
- **C8-7** The UI must state that an already running Claude Code session observes an external
  change only after `/reload-plugins` or a restart.

### C13 — provider CLI telemetry switches (`provider_telemetry.rs`)

Each provider CLI decides on its own whether to send usage statistics and error reports to its
vendor, and records that decision in a settings file the provider owns. Reading those files is
already permitted by `G1`; turning the switch off is a write, so it needs an exception. The
exception is deliberately the narrowest shape that answers the question a user actually asks —
"is this CLI reporting on me, and can I stop it" — and nothing wider.

- **C13-1** The adapter may change only a key listed in the `OPTIONS` table in
  `provider_telemetry.rs`. A request naming any other key is refused, not ignored. Adding a row
  to that table is a change to this exception and must update this section in the same commit.
- **C13-2** The contract speaks in one direction — **blocked**. Providers disagree on polarity
  (Claude turns collection off by setting `DISABLE_*`, Gemini by clearing
  `usageStatisticsEnabled`), and a UI that passes that disagreement through to the user invites
  the exact mistake the switch exists to prevent. The mapping from `blocked` to the value on disk
  lives only in `OptionLocation`.
- **C13-3** Unblocking **removes** the key instead of writing the opposite value, and drops a
  section the adapter emptied. All three providers treat an absent key as collecting, so removal
  restores the provider default and follows it if the provider later changes that default.
- **C13-4** A current value the adapter cannot interpret locks the toggle and is reported with
  the raw value, never overwritten or guessed at. This includes a configured OTLP exporter
  (`[otel] exporter` set to anything other than `none` or `statsig`): the user built that
  pipeline, and a privacy toggle must not quietly take it down.
- **C13-5** Reads and writes follow `C8-2` and `C8-3` through the shared
  `provider_settings_file` guard — whole-file parse with a 1 MB cap; refusal on a malformed
  file, non-object root, symlink, or non-regular file; every unrelated key preserved
  semantically; an app-data lock, a private pre-write backup (five versions per target), a
  fsynced same-directory temporary file, atomic replacement, and a fsynced parent. Codex is
  edited with `toml_edit` so comments and formatting in a hand-written `config.toml` survive.
- **C13-6** Writable targets are exactly the Claude user settings file (`CLAUDE_CONFIG_DIR` or
  `~/.claude`), `CODEX_HOME/config.toml` (or `~/.codex`), and `~/.gemini/settings.json`. Project
  settings, managed policy settings, and every other key in those files are read-only. Only the
  three documented environment variables are read (`G8`).
- **C13-7** The setter is write-gated and remote-eligible in write mode on the same grounds as
  `C8-6`: the target set is fixed, the mutation is bounded to one key, and the previous file is
  recoverable from the app-data backup.
- **C13-8** This is not model-training consent. Whether a provider trains on conversations is
  decided by the account and organization policy, has no entry in any CLI settings file, and is
  neither read nor written here. The UI must say so rather than let the toggles imply otherwise,
  and the UI must state that a running CLI session keeps the setting it started with.
- **C13-9** The Antigravity CLI exposes no such switch — it has no telemetry flag and no settings
  file entry of this kind. It is absent from the table for that reason, and the UI says so
  instead of leaving the user to wonder whether it was missed.

### C9 — SSH key inventory, generation, endpoints, and execution (`ssh_keys.rs`, `ssh_endpoints.rs`, `ssh_exec.rs`, `ssh_approvals.rs`)

- **C9-1** Inventory reads only bounded, direct-child, regular, non-symlink `*.pub` files under the
  canonical `~/.ssh` directory. It validates the OpenSSH public blob and derives only the file name,
  path, public-key algorithm, SHA-256 fingerprint, comment, and whether a same-name regular,
  non-symlink private-key file exists. The private-key file is checked with metadata only and is
  never opened or returned.
- **C9-2** Generation creates only a new Ed25519 pair at `~/.ssh/<validated name>` and
  `~/.ssh/<validated name>.pub`. Both final paths must be absent; overwriting, importing, truncating,
  changing permissions on, or otherwise modifying the contents of an existing SSH file is forbidden.
  The one permitted change to an existing file is the C9-7 rename into the trash directory.
- **C9-3** Resolve the allowlisted official `ssh-keygen` executable and pass a structured argument
  vector. Generate without a passphrase in a new owner-only staging directory directly under
  `~/.ssh`; never execute a shell string and never include private-key bytes in process output,
  logs, errors, IPC, or remote APIs.
- **C9-4** Validate and canonicalize the home and SSH roots in Rust, refuse symlinked roots and
  targets, bound file-name and comment input, and publish the public key then private key with
  same-filesystem no-clobber hard links. A failed second link removes only the public link created
  by that request; staged files are removed on every path.
- **C9-5** `generate_ssh_key` and `delete_ssh_key` are write-gated and, since the 2026-09-03 user
  decision, remote-eligible in write mode: generation only creates the validated new C9-2/C9-4 paths
  with no-clobber publication, and removal is the recoverable C9-7 move into the trash inside
  `~/.ssh`, never an erase. `get_ssh_keys` and `read_ssh_public_key` are secret-free reads that may
  be used by the remote UI; they never expose private-key contents. `set_ssh_key_note` is write-gated
  and remote-eligible because it only writes app-owned metadata. No C9 path opens a private key, so
  remote eligibility never widens what a key discloses (G4).
- **C9-6** `read_ssh_public_key` discloses the validated single line of one `*.pub` file, chosen by
  file name plus the fingerprint the inventory showed. A file name that is not a bounded direct-child
  `*.pub` name, or a fingerprint that no longer matches the file, returns nothing. Public-key bytes
  are not secret; private-key files stay unopened on this path as well.
- **C9-7** Removal never erases and never opens a key. The `*.pub` file and, when present, the
  same-name regular non-symlink private key are **renamed** into a new owner-only
  `~/.ssh/.agent-manager-trash/<deleted at>-<uuid>/` directory, verified to canonicalize to a direct
  child of the canonical trash root inside `~/.ssh`. The request carries the fingerprint the user
  saw and is refused when it no longer matches. A failed second rename returns the first file to its
  original path. Private-key bytes never move into app data, so the OS-level file permissions and
  the user's ability to restore the pair by moving it back are both preserved.
- **C9-8** Key memos are device-local metadata keyed by fingerprint and are stored only in the app
  data directory (G7, `ssh-key-notes-v1.json`). A memo never modifies a file in `~/.ssh` — the
  comment inside a public key belongs to the key, the memo does not. Memos are bounded in count and
  length, are accepted only for a fingerprint present in the current inventory, and are dropped when
  that key is removed. A memo store that cannot be read is reported as an inventory issue instead of
  failing the key list.
- **C9-9** An endpoint (host, port, user, agent-use flag) is device-local metadata keyed by
  fingerprint under the same rules as C9-8 (G7, `ssh-key-endpoints-v1.json`), bounded to 512
  entries, accepted only for a fingerprint in the current inventory, and dropped with the key.
  Nothing in `~/.ssh` is written — `config`, `known_hosts`, and the key files are user-owned and
  stay untouched. Host, port, and user become `ssh` arguments, so they are validated to a bounded
  character set that cannot start with `-` or contain whitespace; agent use cannot be turned on for
  a public key with no usable private key.
- **C9-10** Saving an endpoint and checking it are write-gated and, since the 2026-09-03 user
  decision, **remote-eligible in write mode**. An endpoint is secret-free app-data (host, port,
  user, agent-use flag) that clearing restores, and by the time remote write is on the remote UI
  can already have an agent do anything on the host, so opening one server is not a new risk.
  Key generation and removal followed in the same decision (C9-5).
- **C9-11** The connection check resolves the allowlisted official `ssh` executable, passes a
  structured argument vector with `IdentitiesOnly=yes` and `BatchMode=yes`, and runs exactly one
  fixed no-op remote command with a bounded timeout (G9). Host-key checking is never disabled and
  the app never accepts an unknown host key on the user's behalf: `Host key verification failed` is
  reported with the guidance to connect once from a terminal. The receipt carries the destination
  and the `ssh` diagnostic, never private-key bytes.
- **C9-12** Agents reach these endpoints through exactly two paths, both gated by the same agent-use
  flag. An agent with its own shell (Claude, Codex) uses the bundled `ssh-endpoints` system skill and
  the read-only `<CLI> ssh list` subcommand, which lists exactly the entries whose agent-use flag is
  on, with the identity **path** and the `ssh` arguments to use; it runs `ssh` itself unless that
  server's output-streaming flag routes it through the backend (C9-18). AIA has no
  shell, so it reads the same listing through `list_agent_ssh_endpoints` and hands execution to the
  C9-14/C9-15 operations. Entries the user enabled but that cannot be used are reported with a reason
  instead of being dropped silently. No code path opens a private-key file — `ssh` and `scp` receive
  the identity path only (G4).
- **C9-13** An endpoint additionally carries the command lists the user set for that server:
  `allowedCommands` (empty means "anything not denied") and `deniedCommands`, each bounded to 64
  entries of 120 control-character-free characters, trimmed and deduplicated. The defaults a new
  endpoint starts from live in `ssh_endpoints.rs` and reach the UI through the inventory snapshot,
  so the screen and the skill never disagree about them. The lists are shipped to the agent in the
  C9-12 listing together with the resolved mode, and the skill states them as binding instructions —
  deny wins, prefix match, no rewriting a command to get around a rule. On the **skill** path they
  are a rule the agent is told to follow and nothing enforces them, because the agent runs `ssh`
  itself. On the **C9-14** path the backend builds the argv, so the same lists are enforced there.
  Neither path substitutes for a server-side restriction such as a forced command in
  `authorized_keys`. Describe a list as enforced only for the C9-14 path, and never as a server-side
  guarantee.

- **C9-14** `execute_ssh_command` runs one command on an endpoint whose agent-use flag is on, and it
  is the one place a user command list is enforced. `ssh host <string>` is parsed by the **remote**
  login shell, so the backend building the local argv proves nothing about what runs there; the line
  is instead parsed by `ssh_command_line.rs` (C9-20) and only what that parser understood is re-quoted
  and sent. Deny rules win and match a token prefix where the last rule token may match a prefix of
  the word; allow rules require the tokens to be equal. Rules are tokenized by the same parser, so a
  rule and a command agree on where a word ends. An empty allow list refuses execution outright — unlike the skill path's
  `denylistOnly`, an operation the app performs itself needs a command the user named. Shell,
  interpreter, and network-fetch heads (`sh`, `bash`, `env`, `eval`, `exec`, `curl`, `wget`, `python`,
  `awk`, `xargs`, …) are refused even when the user allows them, checked at every command position a
  wrapper (`sudo`, `nohup`, `timeout`, …) can introduce. `sudo` and `rm` are not refused outright —
  that would remove remote installation entirely — they are in the default **deny** list, so a new
  endpoint refuses them until the user opens that server explicitly. The allow-list comparison is the
  one check a user may answer for a single run (C9-17); every other refusal on this path stands.
  A per-endpoint **unrestricted** toggle (`unrestrictedCommands`, confirmed once in a warning dialog
  before it can be switched on, storable only where agent use is on) removes exactly that one check:
  the allow list is not consulted and no approval card is raised. The deny list and the shell,
  interpreter and network-fetch refusals are unaffected — they are the answers a card could not
  reverse either, so a toggle that only replaces the approval seat must not reach them. The derived
  `commandPolicyMode` reports `unrestricted` so the skill path reads the same decision.
- **C9-20** The command line understands pipes, redirection, quoting and globs, and **every stage of a
  pipeline passes the same checks** — heads, deny rules and allow rules. Stopping at the first head
  would let `tail x | xargs rm` through on a `tail` rule, which is the same way a widened character
  set makes the list decorative. What is refused is the syntax that *joins or creates* commands: `;`,
  `&&`, `||`, `&`, command substitution, `$VAR` (a value the app cannot see is a value no rule can
  judge), backslash escapes, `{}` and `()`. The parse result is re-rendered and that canonical string
  is what runs, what the approval card shows and what the receipt reports: rendering closes the gap
  between this parser and the remote shell's grammar, so a construct the parser does not know has no
  way to execute. A word keeps its glob only if it arrived unquoted, and mixing a quoted and an
  unquoted glob character inside one word is refused rather than silently resolved one way.
  File-writing redirection (`>`, `>>`) needs the unrestricted toggle — its target is not a command, so
  no allow or deny rule can judge it, while `<` and `2>&1` leave nothing behind and are always
  allowed. A pipeline approved for the allow list is written back as **one rule per stage**, since
  rules are matched per stage. `maxLines` caps the receipt at whole lines regardless of what the
  command did; it composes with the character cap and both feed one `truncated`.
- **C9-15** `upload_ssh_file` and `download_ssh_file` move one file with `scp` (OpenSSH 9 and later
  carries it over the SFTP protocol) under one **transfer permission separate from the command
  lists**: `fileTransferEnabled` plus a validated `transferRoot`, storable only on an endpoint whose
  agent-use flag is on. Separation is the point — allowing an artifact transfer is not allowing a
  command, and either without the other is a legitimate user choice. One permission opens both
  directions and one folder bounds both: the remote path is resolved only under `transferRoot` from a
  relative path with no `..`, no `~`, no whitespace and no metacharacter. An absolute remote path is
  **refused, not folded** under the root — keeping the target inside the boundary and telling the
  caller what the contract is are different jobs, and folding `/etc/passwd` into
  `<root>/etc/passwd` leaves the caller believing it touched a system file. The transfer permission
  implies exactly three fixed app-owned remote commands, `sha256sum`, the `shasum -a 256` fallback,
  and `wc -c`, never a string an agent supplied: the digest serves as both the pre-transfer existence
  check (an existing target needs `overwrite`) and the post-transfer verification, and the size lets
  an oversized download be refused before a byte reaches the disk — and before the remote spends
  effort hashing it, which is why the size probe runs first. Every timeout scales with the size
  (`transfer_timeout`, `digest_timeout`): a fixed timeout plus a raised cap is the one combination
  that lets the cap admit a size that always fails, so `MAX_TRANSFER_BYTES` is derived from the
  timeout ceiling rather than chosen independently, and a test asserts the cap still fits under it.
  The bytes-per-second figures are guaranteed floors, not measurements — assuming real throughput
  would make large files fail silently on a slow link. Each receipt carries the path,
  byte count and both digests with their comparison; a remote host with neither digest tool reports
  `verified: false` with the reason instead of failing.
- **C9-16** Both local ends share one boundary — a path that may not be read out may not be written
  over either. An upload source is canonicalized first, then bounded: a regular non-symlink file, at
  most `MAX_TRANSFER_BYTES` (1 GiB), outside provider homes, the app data directory and redirected credential directories
  (`store::is_restricted_doc_root`, the same predicate document roots and C6 use), and outside the
  credential-bearing path segments named in `ssh_exec.rs` — which is what keeps `~/.ssh` out.
  Canonicalizing first is what closes the symlink route into those roots (G10). A download
  destination adds nothing of its own: it reuses the local write boundary the agent already has
  (`user_path::create_user_directory`, C6) — a `~`-expanded absolute path, no `..`, **the parent must
  already exist and no directory is created**, and the name is joined onto the canonicalized parent so
  a symlinked parent cannot move the write outside. An existing target needs `overwrite` and must be a
  regular file; a directory or symlink there is refused, and a failed transfer removes only a file
  this request created. Remote output is capped and scrubbed of PEM blocks, and diagnostics
  additionally of long base64/hex-looking tokens, before reaching a receipt; host-key checking is
  never disabled and `Host key verification failed`, `Permission denied` and timeouts are reported as
  distinct outcomes with the guidance for each. All four execution operations are write-gated and
  **host-only**: unlike saving an endpoint or checking it, they change another system's state or the
  local disk with no recovery path inside the app, which is the `execute_external_plugin_tool` class.
  AIA arrives through the system interface, so that boundary restricts the remote browser UI, not AIA.
- **C9-17** A command outside the allow list is not refused outright on the C9-14 path when the call
  arrives from an AIA conversation — it becomes a **one-shot user approval** (`ssh_approvals.rs`).
  Refusing outright leaves the agent one move: ask the user to widen the list, and a list entry is
  permanent, so the only available answer to "run this once" would be a permanent grant. The receipt
  then carries `approvalRequired: true` with `approvalId`, `expiresAt`, `reason` plus the target
  `destination` and the normalized `command`, and **nothing is executed** — the receipt is the
  request, and the same four fields are what the agent must show the user.
  - **C9-17-1** A token is bound to four values — conversation, fingerprint, the *normalized*
    command string, and scope — and is single-use. Any mismatch refuses. So a granted approval
    cannot be extended (`ls /srv` → `ls /srv /etc`), retargeted at another endpoint, or replayed;
    a consumed token is not returned by a failed run, because a host-key, permission, or timeout
    failure is not permission to try again. Expiry is short (`SSH_APPROVAL_TTL_MS`), and the store
    is process memory only — an approval that survived a backend restart would no longer be "this
    conversation".
  - **C9-17-5** A card the user never answered **closes itself when the token expires**, and
    answering a card whose token is already gone closes it too instead of failing. Both one-shot
    card kinds (SSH and C10-12) share that path (`close_unanswerable_one_shot_approval`). Without
    it an expired card could be neither answered nor dismissed — the store refuses accept and
    decline alike — so it sat on the conversation forever. The close carries a `note` saying the
    approval window passed, because the user did not cancel it; a screen keeps the **first**
    resolution it received, so a late close never relabels a card the user did answer. That close
    is the app's own housekeeping and is not counted as provider response progress.
  - **C9-17-2** The token substitutes for the allow-list comparison and nothing else. The agent-use
    toggle, private-key presence, command normalization (control characters, shell metacharacters,
    quoting, length), the shell/interpreter/network-fetch heads, and that server's deny list are all
    checked **before** the approval site is reached, so no card is ever offered for them. Transfer
    permission (C9-15) is untouched: an execution approval is not a transfer approval.
  - **C9-17-3** One-shot is the default and permanent widening is a **different request with its own
    approval**: `allow_ssh_command_permanently` appends one line to that endpoint's `allowedCommands`
    and never connects to the remote. The two token scopes cannot be used for each other, the card
    wording and the accept-button label differ, and the execution card deliberately offers only
    accept/decline — `acceptForSession` is refused, because "for this session" reads as a standing
    grant. The append writes one line rather than replacing the list, so this path cannot delete a
    rule the user wrote. A line that the hard refusals would reject is not stored either.
  - **C9-17-4** Only a real user decision grants. `SshApprovalStore::resolve` is reachable only from
    the chat approval-card response path (`{"type":"approve"}` on the chat socket); no system
    operation reaches it, and the AIA cursor refuses to click anything inside `.chat-approval`
    (`uiClickRefusal`) even when the run-settings click permission is "all clicks". A call with no
    conversation (a workflow step) has no gate, so an out-of-list command is refused outright there
    as before.
- **C9-18** An endpoint carries a per-server **output-streaming flag** (`terminalEnabled`, device-local
  like C9-9, storable only when agent use is on, off in older stores). It changes two things and
  nothing else. First, on the C9-14 path the backend does not wait for exit: it spawns `ssh` with
  the same argv, reads stdout and stderr line by line, and forwards each line to the conversation
  that made the call as `ChatEvent::Tool` appends on one card per run (`ChatSupervisor::ssh_terminal`,
  any profile). The receipt is unchanged and remains the record; the stream is a display copy with
  the same key-block filter (`KeyBlockFilter`, applied per line so a PEM block spanning lines never
  reaches the screen) and the same character cap, after which one truncation notice is sent. No
  stdin and no PTY — this is a read-only terminal, and interactive programs are unsupported. A call
  with no conversation (a workflow step) streams nowhere and behaves exactly as before. Second, the
  skill path stops running `ssh` itself for that server: the C9-12 listing carries `terminalEnabled`
  and `relayArgs`, and the skill runs `<CLI> ssh exec --fingerprint <fp> -- <command…>`. That
  subcommand never spawns `ssh`; it reads the backend port the running backend recorded in the CLI
  pointer file and posts `relay_ssh_command` (write-gated and host-only like `execute_ssh_command`)
  to the loopback API, so the command list is **enforced** on that path with no approval card — an
  out-of-list command is refused and the agent asks the user to edit the list. The conversation the
  output flows to is chosen by `AGENT_MANAGER_CHAT_ID`, which the backend sets on every managed chat
  child (`RELAY_CHAT_ID_ENV`); it selects a display target and grants nothing, and an unknown or
  missing id means the command runs without streaming. If the backend is not running, the relay
  fails closed and the skill tells the user to start the app instead of falling back to raw `ssh`.

- **C9-19** A saved endpoint can also be opened as an **interactive terminal the user drives**
  (`ssh_terminal_launch`, `TerminalSupervisor::open_ssh`), reusing the existing PTY supervisor and
  xterm surface rather than a second terminal stack. Three things separate it from every agent path.
  It ignores the agent-use toggle, because that toggle decides what agents may reach and this is the
  user connecting with their own key. It drops `BatchMode=yes`, which is the whole point: the
  passphrase, password, and host-key prompts must reach the person typing, so a host missing from
  `known_hosts` is answered here once instead of being refused. And it enforces **no command list** —
  a prefix comparison on a stream of keystrokes is not enforcement, and the lists bind agents, not
  the user. Consequently it is host-only (`authorize_terminal_open_request`), like remote execution
  and transfers: a shell reaching a third-party server with the host's key does not belong in a
  remote browser. `SessionKey::source` becomes `Option<ProviderId>` so this terminal carries no
  provider — it takes no account lease, is excluded from per-provider bulk stops, and its lock file
  is named from the sanitized fingerprint so one server maps to one reattachable terminal. Private
  keys are still passed by path only (G4).
- **C9-20** The same interactive window has a second mode that **installs this key's public half
  into the server's `authorized_keys`** (`ssh_key_install_launch`, `TerminalSshMode::InstallKey`).
  It exists because Windows ships no `ssh-copy-id`, so the one step that bootstraps every later
  key-only connection was the one step the user had to do by hand. **The app never takes a
  password.** It builds no credential field, stores nothing in the keychain, and reads nothing back:
  the launch is the C9-19 terminal without `BatchMode`, so the server's password prompt reaches the
  person at the keyboard exactly as a passphrase or host-key prompt already does, and once the key
  is in place every path reverts to the key-only contract above. The remote command is
  **idempotent** — it fixes the `~/.ssh` and `authorized_keys` modes OpenSSH insists on, then adds
  the line only when `grep -qxF` does not already find it — so pressing the button twice changes
  nothing. The key is offered as usual (`-i`, `IdentitiesOnly=yes`), which means an
  already-installed server never prompts at all. The public key is **rebuilt from the validated
  algorithm and body** rather than copied from the file, and the comment — free-form user text —
  keeps only `[A-Za-z0-9@._+-]` before being wrapped in single quotes, so nothing in a key file can
  close that quote and become a command on the remote shell. The session id is
  `ssh-install-<fingerprint>`, distinct from the shell's, because a shared id would reattach to an
  open shell and silently skip the install. Host-only for the same reason as C9-19, and more
  pointedly: this is a window a password gets typed into.

### C10 — database connections, statements, and approvals (`db_connections.rs`, `db_sql.rs`, `db_exec.rs`, `db_approvals.rs`, `db_cli.rs`)

A connection is an app-owned record (engine, host, port, user, database, environment label,
credential source, write mode, schema scope, masked columns, row cap) that the user registers in
Add-ons → 데이터베이스. Drivers are compiled in (`mysql`, `postgres`, bundled `rusqlite`), so no
client is installed on the host and nothing is downloaded at runtime.

- **C10-1** Connection records are device-local metadata stored only in the app data directory
  (G7, `db-connections-v1.json`), bounded to 64 entries with validated, whitespace-free host, user,
  and database values that cannot start with `-`. The user's own client configuration
  (`~/.my.cnf`, `~/.mylogin.cnf`, `~/.pgpass`, `~/.pg_service.conf`) is never written.
- **C10-2** Only engines with an in-tree pure-Rust driver are supported: MySQL, MariaDB,
  PostgreSQL, and SQLite. Adding an engine means adding a driver behind the same internal
  interface — it never means running a package manager, and no adapter downloads or installs code
  at runtime.
- **C10-3** MySQL and MariaDB stay separate engine values even though one driver serves both,
  because the statement-timeout session variable differs (`max_execution_time` vs
  `max_statement_time`) and sending the wrong one fails the connection.
- **C10-4** Every connection carries a bounded statement timeout, connect timeout, row cap
  (default 200, ceiling 5,000) and response-size cap (64 KB). Truncation is reported, never
  silent.
- **C10-5** Secrets are never persisted by Agent Manager outside the OS secure store. An
  `appKeychain` connection keeps its password in the OS Keychain under a dedicated service name
  and records only the storage timestamp in app data; a `clientFile` connection reads the user's
  `~/.mylogin.cnf` login path or `~/.pgpass` line **at connect time only** (G1 read-only) and
  copies nothing into app data. Resolved secrets are `Zeroizing`, never returned over IPC, never
  logged, and never included in receipts or errors (G4). Diagnostics from the engine are scrubbed
  and length-capped before they leave the adapter.
- **C10-6** The connection check opens one connection, reads the server version, and closes it.
  Nothing on the server changes and no secret appears in the receipt.
- **C10-7** Agents reach a connection only when the user turned on agent use for it. The listing
  (`list_agent_db_connections`, `<CLI> db list`) carries the destination, write mode, schema
  scope, masked columns and row cap — never a credential. Entries the user enabled but that
  cannot be used are reported with a reason instead of being dropped.
- **C10-8** One call executes exactly one statement. A second statement, an unterminated quote or
  comment, a backslash client command, or a control character is refused. Statement kind is
  derived from the leading keyword, and a `WITH` statement that contains a write keyword is a
  write.
- **C10-9** Reads run inside an engine-level read-only transaction (`START TRANSACTION READ ONLY`,
  `BEGIN TRANSACTION READ ONLY`, or opening the SQLite file read-only), so a statement that the
  text checks misclassified is still refused by the engine. The read path never reaches
  `run_db_statement` and the write path never reaches `run_db_query`.
- **C10-10** `DROP`, `TRUNCATE`, `GRANT`, `REVOKE`, `SET`, `USE`, `CALL`, `EXECUTE`, `LOAD`,
  `COPY`, `PRAGMA`, `ATTACH`, `VACUUM`, transaction control, and any statement naming a file or
  shell path (`INTO OUTFILE`, `LOAD_FILE`, `pg_read_file`, `xp_cmdshell`, …) are refused
  regardless of write mode and cannot be unlocked by an approval. Schema scope is matched as a
  prefix against referenced names; like the SSH command lists (C9-16) it narrows this app's
  execution path and is not a server-side restriction.
- **C10-11** A connection labelled `production` cannot be given a write mode, and the execution
  path re-checks the label before running a statement.
- **C10-12** Every write takes a one-shot user approval bound to (chat, connection, normalized
  SQL, statement kind). A DML statement is first executed inside a transaction and rolled back so
  the card states the row count the user is approving; DDL has no preview because the engine
  commits it implicitly, and the card says so. The token is consumed once, expires, and is not
  interchangeable with an SSH approval. Unlike SSH approvals the card may open in any managed
  chat, because shell-capable agents hand writes to the backend as well. A call with no approval
  gate changes nothing. The card closes itself at expiry under C9-17-5.
- **C10-13** Shell-capable agents use the bundled `db-connections` system skill: `<CLI> db list`
  and `<CLI> db query` run in that process against the same policy code, and `<CLI> db exec`
  relays to the running backend because only the backend can raise the approval card.
- **C10-14** Registration, credential entry, and statement execution (including the CLI relay) are
  host-only; listing, the agent-use toggle, the connection check and reads are write-gated and
  remote-eligible in write mode. No new permission switch is introduced — the two existing
  decision points (`remoteWrite` and the host-only command list) carry this.

### C11 — session cleanup (`session_cleanup.rs`)

Session records accumulate without any way to reduce them: the only session mutation before this
adapter was the `hidden` flag. Cleanup has two mechanisms because reducing the list and reclaiming
disk are not the same job. A **tombstone** keeps a session key out of the catalog so the list and
the snapshot shrink; a **file removal** frees bytes, and it is only ever applied inside the app data
directory. Sessions whose transcript lives in a shared provider home are tombstoned and never
deleted, so `G1`/`G2` hold unchanged for `~/.claude`, `~/.codex`, and `~/.gemini`.

- **C11-1** Remove files only under a root registered in the cleanup allowlist in
  `session_cleanup.rs`. Today that is exactly
  `<app data>/credential-profiles/<provider>/<account id>/sessions/` and
  `<app data>/chat-inputs/<chat id>/`.
- **C11-2** A root is registrable only if it canonicalizes under the app data directory. A root
  derived from a provider home — directly or through `CLAUDE_SECURESTORAGE`, `CODEX_HOME`,
  `GEMINI_*`, or any other provider home variable — is refused, and the refusal is a test, not a
  convention.
- **C11-3** Remove only a regular file carrying the extension the root registers for transcripts
  (today `.jsonl`), or a directory whose name is the chat id that owns it. Transcripts are nested
  inside the root, so containment is checked by canonicalizing and comparing against the
  canonicalized root — not by parent equality. Never a symlink, never a path that canonicalizes
  outside the root. The extension requirement is not cosmetic: an account credential profile holds
  `auth.json`, `models_cache.json`, and `installation_id` beside the transcripts, so a root
  registered without a shape would put the account credential in reach of one bad session path.
- **C11-4** Never write a provider-owned index (`state_5.sqlite`,
  `conversation_summaries.db`). Rows left pointing at a removed transcript are an accepted outcome:
  `catalog.rs::resolve_rollout_path` already tolerates a row whose file is gone, because the Codex
  CLI itself moves transcripts to `archived_sessions` without rewriting the row.
- **C11-5** Skip a session whose managed chat is still running, and record the reason on the
  receipt. "Running" must include unattended runtimes: `ChatSupervisor::live_chats` deliberately
  hides them because it backs a user-facing list, so cleanup reads `active_chats` instead — an
  unattended scheduled run is the very thing cleanup is about to delete. The set is re-read
  immediately before the irreversible step, because a pass can move thousands of files after the
  verdicts were computed. Terminals are not session-scoped, so they are not consulted. Unattended
  cleanup never stops a runtime to make room for itself — that is the difference from `C1-4` and
  `C2-4`, where a human asked for the operation.
- **C11-6** Never clean a session referenced by a scheduled request
  (`ScheduledRequest.input.provider_session_id`) or by a handoff link
  (`SessionMeta.handoff_origin` / `handoff_targets`).
- **C11-7** File removal moves the content into the app-owned trash with a manifest, and the trash
  entry is purged only after the configured retention elapses. Unattended execution does not get to
  erase without a recovery path.
- **C11-8** Policy changes and execution are write-gated and remote-eligible in write mode. None of
  the cleanup operations are exposed in the AIA catalog — what to delete and when is a human
  decision, and a status read would only invite AIA to act on it.

### C17 — saved secret vault (`saved_secrets.rs`)

`C15` keeps a value in memory for one chat and one hour, and that expiry is the safeguard. It is
also what makes the user paste the same API key every morning. User decision, 2026-09-29: a value
the user explicitly saves is kept **globally** on the device and **used automatically** when an
agent asks for that name. Nothing in `C15` becomes persistent on its own — this exception covers
only what the user chose to save.

- **C17-1** The value lives in the OS Keychain under service `Agent Manager Saved Secrets` with the
  secret name as the account, sharing the `os_keychain` path with the account vault, DB passwords
  (`C10-5`) and plugin tokens (`P2`) while keeping its own namespace. The app data store
  (`saved-secrets-v1.json`, G7) holds only the name, purpose, agent-use flag and timestamps (G5).
  A value never reaches any other file, log, receipt, chat event or error (G4). At most 64 entries.
- **C17-2** Names follow the `C15` rule — uppercase identifiers, because a name becomes an
  environment variable — and purpose and value reuse the `C15` validators, so a saved value and a
  chat value cannot disagree about what is acceptable.
- **C17-2a** A value enters the vault at exactly two moments, both a deliberate user action: the
  **"비밀값 저장" checkbox on the `C15` request card** (off by default), which saves the same value
  the card is already handing to the chat, and `remember_chat_secret` from the storage screen for a
  value the chat already holds. The checkbox sits beside the input because that is the only moment
  the value exists outside the user's clipboard — it never reaches a chat event, so a card that has
  closed cannot be followed back to it. A save failure does not fail the card: the chat already has
  the value, and the agent is told the keeping failed rather than losing the turn.
  The checkbox rides the chat socket, on the same message that already carried the value (`C17-7`).
- **C17-3** A saved value reaches a chat only by being loaded into the `C15` memory store, where it
  keeps the `C15` TTL, scrubbing, and injection rules unchanged. It is loaded at two moments and no
  others: `request_chat_secret` for that name, and the run/write path resolving a name the chat does
  not hold. The loaded entry carries `source: saved`, so the chat panel and the storage screen both
  show which values were used without being asked for.
- **C17-4** Exactly one command returns a value — `read_saved_secret_value`, behind the eye icon in
  Storage → Secrets. It is write-gated like the rest of the feature and absent from the AIA
  catalog, as are saving, editing, deleting and the toggle. That absence is the boundary that
  matters: the agent may read `list_saved_secrets` (names, purposes, flags, timestamps) and nothing
  more, because the point of a stored credential is that the agent uses it without ever holding it.
  Whether the **person** reading it sits at the host or at a remote screen is the `remoteWrite`
  question, answered once in `C17-7`.
- **C17-5** Auto-use is per value (`agentEnabled`), on for a newly created secret (user decision,
  2026-09-29) and on for a store written before the flag existed — every value saved then was saved
  to be used. Turning it off leaves the value in place and sends the request back to the `C15` card,
  so closing a value for a while never costs the value itself.
- **C17-6** Saving writes the Keychain item first and the metadata only after it succeeds, so a
  failure leaves no entry whose value is missing. Deleting removes both. A metadata entry whose
  Keychain item has disappeared is treated as absent by the auto-use path — the answer to a value
  the OS no longer holds is to ask for it as usual, not to fail the run.
- **C17-7** One decision point, the same as `C15-7`: `remoteWrite`. `list_saved_secrets` is a read;
  the card's save checkbox, `save_secret`, `remember_chat_secret`, `set_saved_secret_agent_enabled`,
  `remove_saved_secret` and `read_saved_secret_value` are write-gated and remote-eligible in write
  mode. Nothing here is host-only (user decision, 2026-09-29).
  The save checkbox rides the chat socket, which the host-only list does not reach, so this is the
  rule the code already followed; the rest was brought in line rather than the checkbox being fenced
  off. The save runs off the socket task, because it touches the OS Keychain and a locked store
  while the card answer used to be memory-only.

### C14 — local provider execution harness (`acp.rs`, `opencode_config.rs`, `local_llm.rs`)

- **C14-1** The local provider owns no CLI of its own. It runs through an ACP (Agent Client
  Protocol) harness — today `opencode acp` over stdio — and the model comes from a user-run
  OpenAI-compatible server registered in `local-llm-connection-v1.json`. Codex is **not** used:
  it declares 26 tools to the model and cannot be trimmed below 6 by configuration, and local
  models fail to call tools at that count (measured 2026-09-24: 26 → invented names, 10 → code
  block instead of a call, 3 → correct call).
- **C14-2** The app owns exactly two keys in the user-owned `~/.config/opencode/opencode.json`:
  the `provider.agent-manager-local` entry and the `agent.agent-manager-local*` entries. Every
  other key is read and written back untouched, and the file is replaced atomically. Turning the
  connection off removes those keys rather than leaving a stale address behind.
- **C14-3** Only a trimmed tool set reaches the model. Every MCP server attached at `session/new`
  stays attached for the whole session — ACP fixes the list there — so each agent must close every
  other group's tools **explicitly**: the workspace agent keeps `bash`, `read` and `write`, the
  system agent keeps `agent-manager_*`, and the plugin agent keeps the shell's `plugins_*`; each
  sets the others to false. Closing only one direction leaves that group holding its own tools plus
  everything else, which is the count that already failed. Keys use the harness's `<server>_<tool>`
  naming with `*` as the wildcard, and a group never mixes `x_*: true` with `x_one: false` — which
  key wins would depend on the order the harness resolves them.
- **C14-3b** External plugins reach the local provider through a **shell**, not as themselves.
  Attaching the real servers would declare one plugin's whole surface — Notion alone is 45 tools —
  which is past the count where these models stop calling tools at all. The app attaches one
  endpoint exposing `find_tool` and `call_tool`, so the declared count is two however many plugins
  are connected, and the schema for a tool is fetched only when it is looked up. This narrows what
  is *declared*, not what is *permitted*: a call goes through the same proxy operation AIA uses, so
  the enable toggle, credentials, the current `readOnlyHint`, approval and audit all still apply.
  The builtin Cypress server is attached as itself — the shell reads only the external-plugin
  registry, so a run with Cypress and no external plugin gets no shell at all.
  Which providers can be given servers per run is `supports_run_scoped_mcp`, not `can_run_system_agent` — the two questions differ, and conflating
  them is why local chats were told `directMcp` was available while nothing was attached.
  Antigravity is the one provider that cannot, so it uses the CLI's own global MCP config.
  The local harness has a global config too, but it is not used for this: writing plugin servers
  into `~/.config/opencode/opencode.json` would follow the user into their own `opencode` sessions,
  which `C14-2` exists to prevent.
- **C14-3c** Agent names for every group live under the `agent-manager-local` prefix, and the
  session catalog selects the app's conversations by that prefix rather than by a list of names.
  A fixed list of names silently drops conversations from the catalog and blocks resume the moment
  a group is added, which has already happened once.
- **C14-3a** The app picks the group from the user's own words before the turn — it never asks the
  model, because that costs a round trip and the model can get it wrong. The word list is a static
  set of app vocabulary plus the names of the external plugins registered right now, read at turn
  time so the list does not fall behind as plugins are added; Korean spellings of the brands we
  ship presets for are carried in an alias table, since "노션" appears in no plugin id. A name that
  matches a plugin actually attached to this run selects that plugin's group; the same name in a
  chat where only the system MCP is attached selects the system group, which reaches the plugin
  through the proxy instead. Ambiguous wording stays on the workspace group.
- **C14-4** Approval grades map one-to-one onto ACP permission options by `kind`, never by
  `optionId`. `AcceptAll` folds to `allow_once` so a plan-review grade cannot widen a single
  request, and a grade the harness did not offer answers `cancelled` rather than substituting a
  nearby one.
- **C14-5** The harness delegates file reads and writes to the client (`fs/read_text_file`,
  `fs/write_text_file`). The app therefore enforces both bounds itself: the chat's write mode
  (`ChatMode::Plan` writes nothing even after approval) and the workspace boundary (a path outside
  the chat's roots is refused regardless of approval). Failures answer with a JSON-RPC `error`
  member — a failure placed inside `result` reads as success and the model then reports a file it
  never wrote.
- **C14-6** Session records live in the harness database
  (`~/.local/share/opencode/opencode.db`), not in Codex rollouts. The catalog claims only sessions
  whose `agent` column is one of the app's own agents, so a user's own OpenCode conversations never
  appear in the app.
- **C14-7** Probing a server address is an outward action even though it touches no stored state.
  It sits behind the remote **write** gate; exposing it as a read lets a read-only remote client
  make the host reach arbitrary internal addresses.

### C16 — project git adapter (`project_git.rs`, `project_files.rs`)

The 프로젝트 view shows a registered project's files and drives its git repository. Reading a
branch name (`git_refs.rs`) never needed git, but status, diff, log, commit, rebase and the remote
operations do, so this adapter runs the user's own `git` binary. It is the first adapter that
mutates a user project directly rather than an app-owned store, which is why the offered command
set is closed and every offered command is recoverable.

- **C16-1** The target is the repository whose worktree contains an active registered project
  (`validated_registered_project` in `remote.rs`, the `C8-4` check). A project that is a subfolder
  of a larger repository targets that repository, and every path in requests and results is
  relative to the repository top-level so porcelain output and request paths share one base.
  A top-level that is the user's home directory or a restricted root
  (`store::is_restricted_doc_root`) is refused as `restrictedRepository` — a home dotfiles
  repository must not surface through a project screen. Bare repositories and non-repositories are
  reported as reasons, never as errors, and the file tab stays on the registered folder.
- **C16-2** Only the resolved `git` executable runs (`resolve_named_executable`, G9), with a
  structured argument vector, `--literal-pathspecs`, the repository top-level as the working
  directory and `GIT_CEILING_DIRECTORIES` set to its parent. Inherited redirections (`GIT_DIR`,
  `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`, `GIT_COMMON_DIR`, `GIT_NAMESPACE`,
  `GIT_PREFIX`) and askpass variables are removed from the child, and credential-profile variables
  are stripped (`strip_inherited_credential_env`). `git` needs at least 2.25
  (`--pathspec-from-file`, `--end-of-options`); an older binary is reported as `gitTooOld`.
- **C16-3** Execution is non-interactive: `GIT_TERMINAL_PROMPT=0`, an empty `GIT_ASKPASS`,
  `GIT_EDITOR=true`, `GIT_SEQUENCE_EDITOR=true`, `LC_ALL=C`. A credential prompt therefore fails
  fast as an `authFailed` receipt with the guidance to run the command once from a terminal, never
  hangs. Reads run with `GIT_OPTIONAL_LOCKS=0`. Every command has a timeout (reads 20 s, local
  mutations 60 s, network 120 s) and a timeout kills the process group so `ssh` and credential
  helpers die with it. One mutation per repository at a time; an overlapping call returns `busy`.
- **C16-4** The offered mutations are exactly: stage / unstage (`add -A`, `restore --staged`, or
  `rm --cached` before the first commit), commit (`commit -F -`), switch and create a branch
  (`switch --no-guess`), stash push / pop / apply / drop, rebase start / continue / skip / abort
  (`--no-autostash`), fetch, pull (`--ff-only` by default, `--rebase --no-autostash` on request),
  and push (`push <remote> HEAD`, optionally `--set-upstream`). Never offered: any `--force*`,
  `reset --hard`, `clean`, `restore` or `checkout` of worktree files, `branch -D`, `--amend`,
  interactive rebase, `--autostash`. Adding a command to this list is a change to this exception.
- **C16-5** Every ref, branch, remote, stash index and message is bounded, refused when it starts
  with `-` or contains control characters, and verified against the repository before it reaches
  argv (`check-ref-format --branch`, `rev-parse --verify --end-of-options <ref>^{commit}`, exact
  membership in `git remote`, `expectedSha` for a stash entry). Paths go through
  `classify_relative_path` and `assert_within_root`, refuse `.git` components and pathspec magic,
  and reach git only through stdin (`--pathspec-from-file=- --pathspec-file-nul`), as does the
  commit message — neither appears in argv or `ps`.
- **C16-6** A conflict, blocked switch, non-fast-forward, missing upstream, rejected push, missing
  identity, or locked index is a structured receipt (`outcome`, `conflictedFiles`, `blockedFiles`,
  `message`), not a bare error. Every receipt carries `headBefore` and `headAfter`; a stash drop
  additionally carries the dropped SHA, so the recovery command is always derivable from the
  receipt.
- **C16-7** Reads (overview, status, diff, commit file list, log) are ungated and open to the read-only remote UI.
  All mutations are write-gated and remote-eligible in write mode (user decision, 2026-09-28, on
  the same grounds as C6-6 / C9-5 / C9-10: everything offered is recoverable and remote write
  already lets a chat change the host) **except push**, which is host-only and additionally
  confirmed in the UI. Every operation is registered for AIA — reads as `Read`, mutations as
  `Execute` — and switch, stash, rebase, pull and push carry `HARD_TO_RECOVER_OPERATIONS` entries
  (W3).
- **C16-8** Remote URLs and captured output have `scheme://user:token@` userinfo redacted before
  they leave Core, and nothing else is masked — the SSH output redaction would erase commit SHAs.
  No other secret enters a receipt (G4).
- **C16-9** The file tab (`project_files.rs`) needs no exception: it is a G1-style read of the
  registered project folder. It lists and reads regular files only — dot-entries are shown, `.git`
  is hidden at every depth, symbolic links are hidden in listings and refused on read at every
  path segment, pages are bounded, previews are capped at 5 MiB, and binary or oversized files are
  reported as a kind rather than content. There is no write path.
### C15 — chat secret broker (`chat_secrets.rs`, `chat_secret_cli.rs`)

Generalises the C9-19 sudo password channel to any named secret the user hands a chat: the agent
gets a **name**, the backend holds the **value**, and the value only ever reaches a child process
the backend spawns for that chat.

- **C15-1** Values live in backend memory only — never on disk, never in the OS Keychain, never in
  a chat event, transcript, receipt, log, error, or remote/IPC response. The one value that outlives
  the chat is one the user explicitly saved under `C17`, which keeps it in the OS Keychain and never
  in a C15 file. `Debug` output hides
  them. They expire after `CHAT_SECRET_TTL_MS` (refreshed on use) and are discarded with the chat
  alongside the C9-17/C10-12 approvals. The one response that carries a value is
  `read_chat_secret_value`, the write-gated command behind the eye icon in Storage → Secrets: it
  returns the user's own value to the user's own screen and is absent from the AIA catalog.
- **C15-2** Only the user can put a value in: the `secretRequest` approval card raised by
  `request_chat_secret`, whose value travels on the `secret` channel the C9-19 card already uses —
  never in `answers`, and with the C17-2a save checkbox travelling beside it as its own boolean for
  the same reason — or the chat's secret panel (`set_chat_secret`). The panel is drawn only
  once that chat already holds a value, so the **first** value always arrives through the card:
  a standing empty form under every chat is an input box nobody asked for, and the card is where
  the user already answers an agent's request. No agent-reachable tool accepts a value as an
  argument.
- **C15-3** A value is bound to (chat, name). AIA calls are pinned to the originating chat by the
  system interface and ignore any `chatId` in the body; the CLI relay names its own chat via
  `AGENT_MANAGER_CHAT_ID`.
- **C15-4** Values leave memory through exactly two consumers. `run_with_chat_secrets` resolves
  argv[0] on `PATH` or as an absolute path (G9 — no shell string), injects values as environment
  variables of that child and substitutes `{{secret:NAME}}` placeholders in argv[1..] and stdin,
  strips the C4 credential-isolation variables, caps the run with a timeout, and refuses if any
  referenced name is missing or nothing would be injected. `write_file_with_chat_secrets` fills
  placeholders in a caller-supplied body and writes it with the C9-16 local write boundary
  (absolute `~`-expanded path, no `..`, existing parent, no provider home / app data / credential
  segments, no symlink or directory target, explicit `overwrite`), as a private file; a body with
  no placeholder is refused because value-free writes belong to the agent's own tools. Names are
  uppercase identifiers so they are valid environment variable names.
- **C15-5** Captured stdout/stderr are scrubbed of every value the chat holds (exact match) before
  they are returned. This guards against accidental echo, not deliberate exfiltration; the
  `chat-secrets` system skill and the catalog text state that boundary to the agent.
- **C15-6** Shell-capable agents use the bundled `chat-secrets` system skill: `<CLI> secret list`,
  `request`, `run`, and `write` all relay to the running backend because only the backend holds
  the values and can raise the card.
- **C15-7** This feature has **one** remote decision point: `remoteWrite` (G11, user decision
  2026-09-29). `list_chat_secrets` and `list_all_chat_secrets` are reads. Everything else —
  `set_chat_secret`, `read_chat_secret_value`, `run_with_chat_secrets`,
  `write_file_with_chat_secrets`, `remove_chat_secret`, `request_chat_secret` — is write-gated and
  remote-eligible in write mode; none of it is host-only.
  The earlier split (a value in the request body means host-only) did not hold up.
  `request_chat_secret` was already remote-eligible and its card answer carries the value over the
  same chat socket, so a remote screen in write mode could always put a secret into backend memory.
  The remaining locks only made the user retype the same value on every device but one, and left the
  eye icon and the edit form as dead controls on a remote screen. What bounds this is the switch
  itself: with `remoteWrite` off the remote UI reaches none of it, and `set_remote_write_enabled`
  stays host-only — a switch a remote screen can flip gates nothing.
  The agent-facing boundary is untouched and is what actually protects the values: no
  agent-reachable tool takes or returns a value (`C15-2`, `C15-4`), and `read_chat_secret_value` is
  absent from the AIA catalog.

### C12 — HOME isolation profile adapter (Antigravity)

Antigravity's CLI (`agy`) resolves its credential, conversations, settings and MCP config from
`HOME` alone: there is no credential-only variable and no per-run flag. Isolating an account here
means handing the process a different `HOME`, a wider blast radius than `C4` — it moves git
identity, SSH, caches and the browser profile with it. This exception exists to bound that width.

- **C12-1** Applies to Antigravity only. No other provider receives a `HOME` override, and the
  shared helpers `C4` uses keep their signatures, constant lists and cleanup specs unchanged. On
  Windows the override is `HOME` **and** `USERPROFILE` with the same value
  (`antigravity_home_env`): the CLI resolves its home the way Go's `os.UserHomeDir()` does, from
  `USERPROFILE`, and a child given only `HOME` created nothing under the profile and wrote to the
  real home's `cli.log` (measured 2026-09-26). The run profile and the login terminal take that
  list from the one helper, so neither can drop the second variable on its own. Neither name goes
  into `CREDENTIAL_ENV_KEYS` (`C12-6`).
- **C12-2** A profile lives under `<app data>/credential-profiles/antigravity/<account id>/`, the
  same root as `C4-1`, created `0700` with the same account-id escape check.
- **C12-3** The two login tokens (`.gemini/antigravity-cli/antigravity-oauth-token` and
  `.gemini/jetski-standalone-oauth-token`) are real `0600` files inside the profile and are never
  linked by any of the `C4-5` kinds: the CLI replaces them with an atomic rename, which deletes a
  symlink and strands a hard link on the old file, leaving the refresh outside the profile. The CLI has no Keychain path here, so `C4-9` applies unchanged.
- **C12-4** Provider state is shared with the shared home only by directory link (`C4-5`), and only
  these entries: `.gemini/config` (MCP, hooks, skills, projects), `.gitconfig`, `.ssh`. Conversations,
  `brain`, logs and `installation_id` stay profile-owned. Sharing the conversation directory would
  make an isolated run open every other account's conversation database and write sqlite sidecars
  into it — forbidden by `G1` and `G2`, and it exposes one account's content to another.
- **C12-4a** A profile `HOME` also owns its keychain. macOS resolves the keychain search list
  from `$HOME/Library/Keychains`, so a split home finds none, and the Antigravity CLI — which
  stores its login in the keyring first and falls back to a file only when that call **times
  out** — raises a "no keychain to save in" modal instead. A human answering that modal is not a
  timeout, so the fallback never runs and the token lands nowhere. Each profile therefore gets
  its own keychain, created empty-passworded with auto-lock disabled, before the provider CLI
  runs in it. Linking the shared home's keychain instead is forbidden: the modal would stop but
  every account would contend for the same item, which is the isolation this exception exists to
  provide. Account login runs inside that profile like any other run — never in the shared home.
- **C12-5** Every registered account runs in its own profile, the active one included. Letting the
  active account use the shared home instead looks like it preserves the user's existing
  conversations, but `set_active` only rewrites the registry — it never replaces the shared home's
  login. The two then drift apart, and the account card reports another login's quota while runs
  spend it (observed 2026-09-18). Conversations already in the shared home are reached through
  `C12-5a` instead.
- **C12-5a** A conversation that lives in another home is reached by symlinking **that one
  conversation** into the running account's profile, never by sharing the conversation directory
  (`C12-4`). The original stays in place and the continued turns accumulate there; the writer is the
  provider's own CLI, which `G3` allows. This is what keeps conversations created before accounts
  existed — or by the CLI's own login — resumable, without exposing every other conversation in that
  home to the account doing the resuming.
- **C12-6** `HOME` is never added to `CREDENTIAL_ENV_KEYS`. That list drives
  `strip_inherited_credential_env`, which would strip `HOME` from unrelated children (Cypress runs,
  plugin processes), and `inherited_credential_dirs`, which would turn the whole home into a
  forbidden document root through `is_restricted_doc_root`. The override travels on its own
  runtime-only path.
- **C12-7** Verify a profile with the provider's own command before using it: the token files must
  exist and `agy --print /usage` must answer. Antigravity has no authentication-only command, so
  that single call serves as both probe and usage read. A failed probe refuses the run and never
  falls back to the shared home, which holds a different account's login.
- **C12-8** A session is bound to the account that last ran it, regardless of
  `ResumeAccountPolicy`. Antigravity has no shared index — no `CLAUDE_CONFIG_DIR` as for Claude, no
  `CODEX_SQLITE_HOME` as for Codex — so resuming under another account's `HOME` makes the CLI print
  a warning, start a **new** conversation and still report success. When the bound account is
  unusable the resume is refused, and when the conversation id the stream reports differs from the
  one that was requested the run errors instead of rebinding the session.
- **C12-9** Deleting an account registration removes its profile as in `C4-7`, but the conversation
  bodies inside it are confirmed first. They are the only copy: the summary index carries titles
  and previews, not the conversation.
- **C12-10** Accepted risk: a profile `HOME` gives that account its own git identity, browser
  profile and `installation_id` unless the `C12-4` whitelist buys them back. That whitelist is the
  only place the width is narrowed, so an entry is added to it only with its reason recorded here.
- **C12-11** Authentication is a **chain**, not one store (`ChainedAuth: authenticated via %s
  (effective: %s)` in `auth.go`). Its links include `keyringAuth` and `cliFileTokenStorage`
  (`CLITokenFilePath`, `NewCLITokenStorage`, `NewDefaultChain`), and the keyring link falls through
  on its own failures — `keyringAuth: timed out after %v, skipping keyring auth`,
  `failed to load stored token`. macOS splits the keyring itself per `HOME` (`C12-4a`), so the first
  link already resolves per account there. Windows cannot split it: the login lives in the Credential
  Manager under target `gemini:antigravity`, which `CredRead`/`CredWrite` resolve through LSA against
  the logged-on Windows user, and `HOME`, `USERPROFILE`, `APPDATA` and `LOCALAPPDATA` redirected
  together do not move it (measured 2026-09-24, Windows 11, `agy` 0.11.x — nothing appeared under the
  redirected `Microsoft\Credentials`). The documented bypass is Linux-only: "the CLI now bypasses the
  keyring when no D-Bus session bus is present (headless…)"; no `DISABLE_KEYRING`, `NO_KEYRING`,
  `AGY_KEYRING` or `KEYRING_DISABLED` exists in the binary, `agy --help` offers no storage flag, and
  `JETSKI_OAUTH_TOKEN` is ignored.
  **So while that one entry exists, every `HOME` collapses onto the account it holds** — the probe
  succeeds, the card reports one account and the run spends another's quota, which is the
  silent-success failure `C12-8` documents. Presence checks must therefore never be made to pass on
  Windows by themselves.
  **Windows isolation is still reachable, by the file link.** Measured 2026-09-24: with
  `gemini:antigravity` deleted (absence confirmed by `CredRead`) and a fresh `HOME` carrying only the
  planted `C12-3` token files, `agy --print /usage` authenticated and reported that token's own
  expiry. The real home held no token files and exactly one credential entry existed, so the file was
  the only possible source. Per-account `HOME` plus per-account token files therefore give real
  per-account identity, and with it the parallel use this exception exists for.
  Taking that path means Agent Manager owns the credential: lift the login into the Vault, remove the
  machine-global entry, and keep each profile's token files from it. Two follow-up measurements
  (2026-09-24, same machine) fix the shape of that design:
  - A **refreshed** token is written back to the Credential Manager, not to the file. With the entry
    absent and a profile file whose access token had been forced expired, the run authenticated from
    the file, refreshed, left both token files byte-identical, and **recreated** `gemini:antigravity`
    with the new access token. The refresh token itself did not rotate. So file-only isolation is
    not self-sustaining: after the first refresh the global entry exists again and the next process
    to start would collapse onto it.
  - `ANTIGRAVITY_BROWSER` is **ignored**: set to a script that drops a marker file, no marker
    appeared and a browser did open. Windows therefore still has no browser block (`c2fb2416`'s
    `PATH` shim is unix-only, `b05783ad`).
  The consequence is a per-**start** protocol rather than a per-install one, and the account is
  always the Google login the user picked in the browser, never the `HOME` directory as such:
  1. Login for account *B* first **clears the global entry** (after the account it holds has been
     lifted into the Vault), then runs as usual in the temporary profile `HOME`. Without that clear
     the login terminal never reaches the browser: the CLI finds the existing entry, prints the
     current account's quota and reports success, so no other Google account can be chosen
     (observed 2026-09-24 in the 계정 추가 dialog — quota printed, no browser). With the entry gone
     the CLI opens the browser, the user picks *B*, and the CLI lands *B*'s token in the global entry;
     the app immediately lifts it into the Vault and *B*'s profile token files, then clears the entry
     again. Capture on Windows must therefore read the Credential Manager entry, not only the `C12-3`
     files. The very first account is adopted the same way from whatever the entry already holds.
  2. Before **every** Antigravity start, under the provider account lock: clear the global entry,
     write that account's current token files, spawn with the profile `HOME`. Only the start is
     serialized; runs overlap freely, which is what keeps parallel use intact.
  3. Immediately after start, read the profile's `cli.log` for `applyAuthResult: email=…` and
     compare it with the account's identity (`antigravity_identity`, G5 metadata). A mismatch kills
     the run and reports it. This is the same seat as `C12-7`: the provider's own signal, checked
     before the run is trusted. It turns the remaining race — another run's refresh recreating the
     entry between the clear and this process's read — from a silent wrong-account spend into a
     detected refusal.
  4. Whatever the global entry holds afterwards is treated as a stale copy: the Vault stays
     authoritative (`C4-2`) and rotations are adopted from it under `C4-4`'s identity check, since a
     refresh by account *A* leaves *A*'s token there even while *B* runs.
  Implemented 2026-09-24 as exactly that protocol, gated on one predicate —
  `credential_profiles::antigravity_login_is_machine_global()`, true only on Windows — so macOS
  keeps `C12-4a` unchanged and Linux (`C12-12`) stays inert: `begin_login` and `finish_login` clear
  the entry (step 1), `capture_credentials` falls back to the entry when the temporary profile holds
  no token files and places its value under both `C12-3` file keys (the entry's value is one token
  file's content; `id_token` inside it gives the identity), `runtime_credential_profile` clears the
  entry before the probe and again right before handing the profile to the spawn (step 2, under the
  provider switch lock), and `chat.rs::verify_antigravity_runtime_identity` reads the profile's
  `cli.log` for the **last** `applyAuthResult: email=` on the first stream message and stops the run
  on a mismatch (step 3). Clearing goes through `os_keychain::delete_foreign_secret`; nothing in
  this exception ever **writes** the global entry.
  Stated behaviour of the user's own bare `agy` on Windows: after the app clears the entry, a bare
  `agy` in a terminal finds no login and asks to log in again; its login recreates the entry, and the
  next app-managed start clears it. This is a cost of owning the credential, not a bug to patch
  around by writing the entry back — that write would need its own exception and would reintroduce
  the collapse for whichever process starts next.
  The browser block on Windows (`no_browser_dir`, 2026-09-26). The CLI opens the login page
  through `rundll32 url.dll,FileProtocolHandler <url>`, resolved through `PATH` (`exec.LookPath`),
  so a `PATH`-first `rundll32.exe` is intercepted exactly as `open` is on macOS — measured with
  the entry cleared and an empty profile: the shim ran, no browser appeared, the CLI waited for a
  code. The shim is a **hard link to the app's own executable** in the same temp directory the
  unix shim uses. Windows ships no `true`, and a `.cmd` shim is refused even though `PATHEXT`
  would find it: `cmd.exe` parses the OAuth URL it is handed and `&` in the query string becomes
  a command separator — the shell-string execution `G9` forbids, and the reason `c2fb2416` chose
  a symlink to `/usr/bin/true` over a script. Both entry points (`src-tauri/src/main.rs`, which
  already re-executes itself with `--backend`, and `agent-manager-server`) therefore call
  `exit_if_invoked_as_browser_shim` before anything else: a first argument of
  `url.dll,FileProtocolHandler` ends the process with status 0 before a window, a single-instance
  lock or a server exists. The link is checked for identity with the running executable on every
  start and rebuilt after an update; where the install volume differs from the temp volume it is
  a copy, accepted while its size matches and it is not older than the executable. The test binary
  has no such branch, so under `cfg(test)` no shim is created. As on macOS the block applies only
  to background probes; the login terminal must reach the browser and never takes this `PATH`.
  Still unverified, to be settled with a real run longer than one token lifetime: whether a live
  process ever re-reads the store after start (a mid-run re-read would bypass step 3).
- **C12-12** Linux is **unverified** and is the same question as Windows, not as macOS: `go-keyring`
  reaches Secret Service over the session D-Bus, which the child's `HOME` does not select. A desktop
  session holding an entry there would collapse accounts the way Windows does, while a session with no
  Secret Service takes the CLI's own documented bypass and resolves per `HOME`. Until someone runs the
  `C12-11` measurements there, assume neither, and treat the platform the way `C12-7` treats a failed
  probe — refuse, never fall back.


### C18 — cask quarantine release (`cli_quarantine.rs`)

Homebrew stamps `com.apple.quarantine` on every file of a freshly installed or upgraded cask.
Codex's `codex-code-mode-host` then stalls in Gatekeeper evaluation on every exec, and every
code-mode-only model fails with `timed out negotiating with the code-mode host`. Upgrades also
happen in a terminal outside the app, so the release runs where an executable is resolved
(`chat::resolve_executable`, `cli_updates::resolve_status`), not only after an in-app update.

- **C18-1** Consider only regular files directly inside the resolved executable's folder, and only
  when that folder sits below `Caskroom/<token>/<version>/`. Never follow a symlink, never descend
  into a subfolder, never touch a Cellar, npm or standalone install.
- **C18-2** Release only for a cask token listed in `TRUSTED_CASK_SIGNERS`, and only a file that
  passes `/usr/bin/codesign --verify --strict` against a Developer ID Application requirement
  pinned to that token's team. Register a token only after reading `TeamIdentifier=` from the
  installed binaries. An unsigned, ad-hoc or foreign-team file keeps its attribute and is logged.
- **C18-3** Remove exactly the `com.apple.quarantine` attribute. File contents, permissions and all
  other attributes stay untouched.
- **C18-4** A failure never blocks the caller's launch; the outcome is logged only. A folder is
  remembered as settled only when nothing was refused, so a refused file is retried on the next
  resolution.


### C19 — local overlay adapter

브랜치마다 다른 로컬 설정(디버그 플래그, 로컬 포트, 실험용 상수)을 브랜치를 옮길 때마다 손으로
되돌리는 일을 없앤다. overlay는 추적 중인 파일의 unstaged 변경을 patch로 떠서 앱 데이터에
보관하고, 작업 트리를 HEAD 원본으로 되돌렸다가, 나중에 같은 patch를 다시 적용한다. 그 되돌림이
`git restore --source=HEAD --worktree`이고 **C16-4가 명시로 금지한 명령**이라, C16 안에서는 쓸 수
없다. 또 patch는 캐시가 아니라 **사용자 로컬 데이터**다 — C2처럼 "공급자가 다시 만든다"는 복구
근거가 없으므로 복구 근거를 patch 저장 순서 자체가 진다.

- **C19-1** 세트는 `<app data>/git-overlays/<저장소 식별자>/<세트 id>/`에만 쓴다. 사용자 저장소
  안에는 patch도 메타데이터도 잠금 파일도 두지 않는다 — 저장소 안에 두면 그 파일이 브랜치를
  따라다니고, overlay가 없애려던 문제를 overlay가 다시 만든다. 식별자와 세트 id는 단일 경로
  성분으로 검증하고(C3-6), 대상 파일 경로는 `classify_relative_path`·`assert_within_root`를
  지나며 `.git` 성분과 pathspec 매직을 거절한다(C16-5, G10). patch는
  `git diff --binary --full-index`로 뜬다 — `--full-index`가 없으면 축약 blob 해시가 재적용
  시점에 모호해지고 `--binary`가 없으면 바이너리 변경이 조용히 빠진다. 저장은 staged write 뒤
  atomic replace이고 디렉터리는 `0700`, patch 파일은 `0600`이다. 메타데이터는 repository
  identity, canonical root, 대상 경로, snapshot id, 생성 시점, 기준 HEAD, patch digest, 적용
  상태만 담는다. 파일 내용과 patch 본문은 메타데이터에 들어가지 않는다.
- **C19-2** patch 본문에는 파일 **내용**이 그대로 들어가므로, `.env`, `*.pem`, `*.key`, `id_*`,
  `credential`/`credentials`, `secrets`, `.npmrc`, `.netrc`에 걸리는 경로는 기본 제외하고 **사유와
  함께 거절**한다. G4가 금지하는 것은 Agent Manager 파일에 비밀값을 남기는 것이고, 앱 데이터
  안의 patch가 바로 그 파일이다. 거절은 조용하지 않다 — 어느 경로가 어느 규칙에 걸렸는지
  영수증에 싣는다.
  - v1은 예외 등록을 제공하지 않는다. 거절 사유만 보여 주고, 민감 경로를
    overlay에 넣는 길은 열지 않는다.
- **C19-3** 이 예외가 더하는 git 명령은 정확히 둘이다 — `git restore --source=HEAD --worktree`
  (patch 저장이 성공한 **뒤에만**)와 `git apply`(재적용). C16-4가 금지한 나머지는 여전히
  금지다: 어떤 `--force*`도, `reset --hard`도, `clean`도, `--amend`도, 대화형 rebase도 이 예외가
  열지 않는다. `git checkout`은 worktree 복원에 쓰지 않는다(`restore`가 범위가 좁다). 순서가
  안전의 전부다 — patch를 쓰고 fsync하고 digest를 확인한 뒤에 되돌리므로, 저장이 실패하면 작업
  트리는 한 글자도 바뀌지 않는다. 재적용은 `git apply --check`가 먼저 돌고, 실패하면 아무것도
  적용하지 않은 채 `overlayNeedsResolution`과 충돌한 `affected` 경로를 돌려준다. 부분 적용과
  3-way 자동 병합은 v1에 없다 — 절반 적용된 작업 트리는 이 기능이 되돌릴 수 없는 상태다.
  자동 검사·적용은 **앱이 시작한** Git 작업(switch/pull/rebase/merge) 뒤에만 하고, 터미널 같은
  외부 Git 작업을 감지한 경우에는 자동 적용하지 않고 검사 결과와 적용 버튼만 내민다. Git 작업
  자체가 실패하면 이전 브랜치에서 재적용을 시도하고, 그 재적용까지 실패해도 **patch는
  보존하고** 복구 영수증을 남긴다 — patch를 잃는 경로는 어디에도 없다. v1이 지원하는 것은
  HEAD에 있는 추적된 일반 파일의 unstaged 변경뿐이고, `untracked`, `staged`, `deleted`,
  `rename`, `modeChange`, `submodule`, `conflicted`, `symlink`, `unbornHead`는 등록 또는 스냅샷
  생성을 사유와 함께 거절한다. 저장소 하나에 변경 하나다 — C16-3의 저장소 단위 잠금을 git
  어댑터와 **공유**해 overlay 적용과 `git` 변경이 서로를 가로지르지 않게 하고, 겹치면 `busy`를
  돌려준다.
- **C19-4** 읽기(`list_project_overlay_sets`, `check_project_overlay_apply`)는 원격 UI에 열린다.
  세트 저장·삭제(`save_project_overlay_set`, `delete_project_overlay_set`)와 작업 트리를 바꾸는
  둘(`snapshot_project_overlay`, `apply_project_overlay`)은 모두 쓰기 게이트를 지나고 **write
  mode에서 원격 가능**하다(2026-10-02 사용자 결정). 초안은 뒤의 둘을 C16-7의 push와 같은 부류로
  보아 호스트 전용으로 제안했으나, push가 호스트 전용인 이유는 호스트 사용자의 자격증명으로
  **바깥으로** 내보내기 때문이고 overlay는 바깥으로 나가지 않는다. 남는 위험은 "화면 앞에 없는
  사이 작업 트리가 바뀐다"인데, 그 답은 권한 경계가 아니라 복구성이다 — patch를 먼저 쓰고
  digest까지 확인한 뒤에만 되돌리고, 재적용은 `--check`가 통과할 때만 하고, 모든 변경이 C19-5의
  영수증을 남기므로 무엇이 왜 바뀌었는지 영수증만으로 되짚을 수 있다. G11의 하나뿐인 결정
  지점(`remoteWrite`)이 이것을 진다. 따라서 호스트 전용 목록(`is_host_only_command`)에는 overlay
  명령이 **하나도 들어가지 않는다**.
- **C19-5** 모든 overlay 변경은 오류가 아니라 영수증을 남긴다(C16-6과 같은 모양). 최소 필드는
  `head_before`/`head_after`(되돌림의 기준점), `snapshot_id`, `patch_digest`(저장한 patch의
  SHA-256, 적용 시점에 같은 patch인지 확인한다), `outcome`(`applied`/`overlayNeedsResolution`/
  `rejected`/`busy`), `affected`(검사 실패 시 충돌한 경로), `rejected`(거절한 경로와 사유),
  `trigger`(`app`/`external` — 자동 적용했는지 버튼을 내밀었는지)다. 영수증에는 patch 본문도
  파일 내용도 싣지 않는다(G4). 세트 삭제는 지우지 않고 앱 소유 휴지통으로 옮긴다(C3-11) —
  patch는 사용자 로컬 데이터이고, 지우면 그 변경의 유일한 사본이 사라진다.


## 4. External MCP interfaces (`mcp_registry.rs`)

Third-party MCP servers are the only outbound network dependency AIA can acquire at runtime.

- **E1** Only a user-approved interface is callable. `interface_register` stores the endpoint and
  an explicit `enabledTools` list, and rejects a tool absent from the probed catalog.
- **E2** A remote endpoint must be HTTPS. Plain HTTP is accepted only for loopback hosts
  (`localhost`, `127.0.0.1`, `::1`).
- **E3** Reject credentials in the URL — both userinfo (`user:secret@host`) and credential query
  parameters (`?token=`).
- **E4** HTTP redirects are not followed.
- **E5** Reads go through `interface_read` and mutations through `interface_execute`. Never call a
  tool outside the stored `enabledTools`.
- **E6** A grant may carry `grantExpiresAt`, which must be in the future at registration. An
  expired grant is reported as `expired` and must not be used. `interface_revoke` withdraws it.
- **E7** Limits: 32 interfaces, 64 enabled tools per interface, 512 KB remote response body,
  256 KB exposed result.
- **E8** The store `aia-mcp-interfaces.json` (lock file, temp write, atomic rename, fsync) and the
  audit log `aia-mcp-audit.jsonl` (rotated to `.previous.jsonl` at 2 MB) live in the app data
  directory. Neither the audit log nor the catalog may contain secrets.

## 4c. External plugins (`external_plugins.rs`)

An external plugin is an MCP server (Notion and the like) attached directly to **standard** chats
per run and exposed to AIA only through typed proxy operations. It is the second outbound network
dependency after 4, and the only one a standard chat acquires.
User decisions (2026-08-30): credentials are **device-scoped**, the remote UI **cannot
authenticate**, and Notion works both through OAuth (hosted `mcp.notion.com`) and through an
internal integration token (`ntn_…`) served by the official open-source server.
User decision (2026-09-01): Google's official Workspace remote MCP servers (Gmail, Drive,
Calendar, Docs) are offered as OAuth presets backed by a user-created GCP OAuth client.
User decision (2026-09-02): every plugin tool carries an **allow / ask / deny** choice; Jira
(Atlassian's remote MCP) is an OAuth preset with a **user-chosen scope**; GitHub is reached
through the **device flow** because its authorization server has no dynamic registration.

- **P1** The CLI never sees a credential. Every plugin is exposed to the CLI as
  `http://127.0.0.1:<port>/plugins/<route key>/<id>` on the loopback server in `system_mcp.rs`; the
  proxy attaches `Authorization` server-side. Tokens go neither into argv nor into `--mcp-config`
  JSON nor into a child environment the CLI inherits.
- **P2** Secrets live only in the OS secure store (service `Agent Manager External Plugins`,
  account = plugin id). `external-plugins.json` records existence and timestamps, never values.
  Views, snapshots, errors, and logs carry no token, refresh token, or client secret (G4).
- **P3** OAuth follows the MCP authorization spec: protected-resource metadata → authorization
  server metadata → dynamic client registration (RFC 7591) as a public client → PKCE S256 with
  `state` → loopback callback → code exchange with `resource` (RFC 8707). The registered
  `client_id` and callback port are persisted and reused; re-registering per session orphans the
  previous refresh token. Rotated refresh tokens are written immediately under the store lock.
  For authorization servers without RFC 7591 (Google), a manually entered `client_id` — with an
  optional `client_secret`, accepted only alongside it — takes the registration's place; the
  secret lives only in the keychain `SecretDocument` and is sent solely on the exchange and
  refresh forms. `OAuthDevice` is the same contract without a callback: RFC 8628 device
  authorization with a required manual `client_id` and no secret, polled at the interval the
  server returns (`slow_down` adds five seconds), storing the same tokens under the same rules.
  The authorize scope is resolved as **stored user choice → preset override → discovery →
  preset default**; changing the scope counts as a connection change, so the old registration
  and refresh token are dropped and consent is asked again.
- **P4** Registration, editing, token entry, removal, OAuth cancel, the enable toggle and the
  connection check are write-gated and **remote-eligible in write mode** (user decision,
  2026-09-30). The earlier boundary ("a token is never accepted over a remote path", 2026-08-30)
  stopped holding on 2026-09-29, when `C15-7`/`C17-7` put every secret path behind the single
  `remoteWrite` switch: a remote screen in write mode already hands values to the backend and
  saves them to the OS secure store. Keeping plugin tokens out blocked connecting Notion from a
  phone without closing any disclosure path. Removal follows registration — what is registered
  remotely must be removable remotely, and what it deletes is an app-owned record plus a token the
  user can reissue at the provider.
  **`begin_external_plugin_oauth` stays host-only**, and that is a physical limit rather than a
  permission: the callback `redirect_uri` is the host's loopback, so approving in a remote browser
  redirects nowhere and only leaves a pending flow the remote screen cannot finish. Connecting
  from a remote screen therefore means a token method. `set_external_plugin_tool_policy` /
  `set_external_plugin_tool_policies` also stay host-only — `allow` removes an approval card, and
  a decision that widens authority is taken at the host (same rule as `set_remote_write_enabled`).
  AIA can inspect and toggle plugins, list the current tools of an enabled, credential-ready
  plugin, and call them only through the typed read/execute proxy operations; it never receives a
  credential.
- **P5** Endpoints follow E2–E4: HTTPS remote, loopback HTTP allowed, no credentials in the URL,
  no redirects followed. Plugin ids are `[a-z0-9][a-z0-9_-]{0,31}` because they become the MCP
  server name for both Claude (`--mcp-config`, additive, never strict) and Codex
  (`mcp_servers.<id>` dotted leaf, never the nested object).
- **P6** `NotionToken` starts `npx -y @notionhq/notion-mcp-server --transport http` on a fresh
  loopback port with a random per-launch bearer on argv and the integration token **only** in the
  child's `NOTION_TOKEN`; credential-profile variables are removed from that environment. The
  executable is resolved from PATH (G9), the process lives in its own group, restarts lazily when
  it dies or the token changes, and is killed when the loopback server drops.
- **P7** Direct attachment is decided at standard-chat start from `enabled && credential ready`;
  a running standard chat keeps the set it started with (the CLI reads `tools/list` once). AIA
  never gets a plugin MCP server directly: it uses `get_external_plugin_tools`,
  `read_external_plugin_tool`, and `execute_external_plugin_tool` through `aia_system`, with the
  enabled/credential-ready state and current `readOnlyHint` revalidated for every call.
  Antigravity never gets plugins.
- **P8** Limits: 16 plugins, 1 MB request body, 8 MB proxied response, 10-minute callback wait,
  90-second managed-server start.
- **P9** Hosted presets are defined once in the backend `HOSTED_MCPS` table (id, URL, auth kind,
  brand, default scope, selectable scopes, scope mode) and reach the UI through the snapshot.
  `Fallback` scope mode (Google) uses the default only when discovery yields none; `Override`
  (Atlassian, GitHub) prefers the default because those protected-resource metadata documents
  advertise delete and manage scopes the user did not ask for. When protected-resource metadata
  is absent for a Google table URL, discovery falls back to `accounts.google.com` as the
  authorization server; authorize requests to `accounts.google.com` add `access_type=offline`
  and `prompt=consent` so Google issues a refresh token. Figma's remote server is deliberately
  absent — it rejects dynamic registration from any client outside its own catalog (HTTP 403),
  so the preset points at the desktop app's Dev Mode server on loopback with no auth.
- **P10** Plugin descriptions and results exposed to AIA are untrusted data, not instructions.
  Read-only tools use the read operation; every other tool uses the approval-gated execute
  operation. Results above 256 KB are replaced with a bounded truncation receipt. Dynamic plugin
  calls cannot be embedded in a system workflow because their contracts are controlled by the
  external server. A mutating plugin call is host-only because it changes non-app-owned state and
  is not recoverable under G11.
- **P11** Each tool of a plugin is `allow`, `ask` (default, nothing stored) or `deny`. `deny` is
  enforced in the proxy for every provider: the tool is filtered out of `tools/list` responses
  (JSON and `text/event-stream` alike) and a `tools/call` for it is answered with an MCP tool
  error without touching the upstream server. `allow` is resolved at the approval layer — a
  standard chat carries the policies it started with (P7) and auto-approves those Claude
  `can_use_tool` requests. Setting a policy is a **host-only** command like token entry, because
  `allow` removes an approval the user would otherwise see.

## 4b. Session context reads (`session_context.rs`)

Reading another agent's session is the only path by which one runtime sees another
conversation's content. It is capability-gated: a **channel** is the MCP address bound to one
runtime, and a **grant** is the scope that runtime may read. No grant, no tools.

- **X1** A grant is issued only from a policy confirmed at save time — the `sessionReference`
  stored on a scheduled request, or an explicit `grant_chat_session_context` call. Nothing about
  the scope is decided at read time except resolving relative dates to an absolute window.
- **X2** Every read revalidates the principal and grant server-side. Tool arguments accept only a
  cursor and a session identity; unknown arguments are refused rather than ignored, so an agent
  cannot widen provider, project, period, status, detail level, or output budget by asking.
- **X3** A scheduler grant lives for one run; a chat grant lives for the one reserved turn. A chat
  grant is invalid before that turn starts, after it ends, and in any other turn or chat. The
  `chat` scope persists the policy, never the grant: each turn mints a new one.
- **X4** `selected` and `allRegistered` resolve only against Agent Manager registered projects
  (the unified session catalog, `C5-3` rules; inactive projects excluded). A path that does not
  canonicalize into that set is dropped with a stated reason, never substituted or widened.
- **X5** Session detail is reachable only for sessions a prior list call in the same grant
  returned. Linked-file reads additionally require `includeLinkedFiles`.
- **X6** Fixed safeguards the user cannot turn off: read-only, principal binding, short expiry,
  audit records (`actor: sessionContext` with the principal as `subject`), credential removal, and
  marking session content as untrusted data so an instruction inside a past conversation is never
  taken as a new command.
- **X7** A standard chat a person started is never given `aia_system`. The one exception is a run a
  registered workflow launched (chat origin `workflow`): registration is the approval, and those runs
  must reach `record_round_report` and the rest of the round catalog (2026-10-02). They keep the
  standard profile — only the tools open, not the AIA persona, cwd, or session volatility — and the
  server is merged next to the plugin servers, so `--strict-mcp-config` stays AIA-only and the chat
  keeps Cypress and the user's own MCP servers. The separate `agent_manager_Cypress` endpoint exposes
  only the C7 allowlist when enabled; it cannot call other system operations or read env plaintext. Session context tools are attached only when
  the chat was started with `sessionContext`, and `tools/list` returns nothing while no grant is
  live. Provider MCP config is merged at the leaf (`mcp_servers.<name>`) so a chat keeps the
  user's own MCP servers.
- **X8** When the policy cannot be satisfied — no registered project in scope, a provider with no
  per-run MCP config, the access layer absent — the scope is never widened. The read returns
  metadata only or an explicit partial-report reason, and a scheduled run records that reason in
  its history.

## 5. AIA workflows and suggestion packs

- **W1** A workflow step may call only an operation registered in the system catalog. Arbitrary
  code evaluation, shell commands, arbitrary file or URL access, unregistered operations, and
  self-privilege-escalation are structurally unrepresentable and rejected at validation.
- **W2** Workflow meta-operations are forbidden as steps — `propose_system_workflow_schema`,
  `register_system_workflow`, `execute_system_workflow`, `delete_system_workflow`. Dynamic
  external-plugin calls are also forbidden because the external server controls their live
  contract. A workflow cannot register, run, or delete workflows or hide a dynamic external call.
- **W3** An operation listed in `HARD_TO_RECOVER_OPERATIONS` must surface its stated consequence
  on the approval screen. Adding such an operation means adding its entry in the same change.
- **W4** Limits: 64 workflows, 10 versions per workflow, 20 steps, 16 input fields, 32 enum
  values, 100 `forEach` iterations, 200 total operation calls, 32 KB contract, 8 KB `$format`
  result.
- **W7** `forEach` takes **either** `step` (iterate a prior step's result) **or** `items` (a
  literal list written into the contract), never both and never neither. `items` exists because
  repeating "the same work with different values" as copied step pairs burns the 20-step budget
  — the session-routing contract grew to 9 groups / 18 steps and had to drop groups to fit.
  Iterating a contract literal instead of a step result changes nothing about authority: the
  step still calls only registered operations. Token objects inside `items` are rejected at
  registration, because items are data and are never substituted.
- **W8** `$format` composes one string from `{input.name}`, `{step.id.path}`, `{item.path}`,
  and `{run.field}` holes (`{{`/`}}` escape a literal brace). Holes are validated **at
  registration** against the declared inputs, prior steps, `forEach` scope, and `paced` flag, so
  it does not reintroduce the failure that `reject_inline_token` guards against — a `$input.`
  written inside an ordinary string is never substituted and arrives at the agent as a literal.
  `parse_format` is shared by validation and resolution so the two cannot read holes
  differently. Objects and arrays in a hole are refused; `null` renders as empty.
- **W5** Suggestion packs (`aia_suggestions.rs`) read only the bundled default packs and the
  configured common skill repository. A pack expresses wording and limited parameters, never
  code, tool, or network execution.
- **W6** Onboarding packs (`aia_onboarding.rs`) render the Add-ons → Automation cards from data
  so a new onboarding is a pack, not a React component. Same source boundary as `W5`: the
  bundled pack plus `references/aia-onboarding.json` inside a common-repository skill. A pack
  expresses wording, a field schema, and outcome **arguments** — never code, shell, URLs, or
  operation names. All pack structs are `deny_unknown_fields`.
  - **W6-1** Outcome kinds are a closed list (`createDirectory`, `registerWorkflow`,
    `createScheduledRequest`). Each maps to one already-registered write-gated operation and
    inherits that operation's approval and remote gating. Adding a kind means adding that
    mapping in the same change.
  - **W6-2** A pack never describes workflow steps. It supplies the id, names, the unattended
    instruction, and `projectPathField`; the app builds the paced contract skeleton (one
    `start_chat` with `$run` tokens). Obtaining a pack therefore never obtains new authority.
  - **W6-3** Icons and field kinds are closed enums, and the four picker kinds are the only
    app data a pack can pull onto the screen. A picker field may not carry its own options.
  - **W6-4** `{{name}}` in any template resolves only to a field key declared by that same card
    or to `DERIVED_TEMPLATE_VARIABLES`; anything else fails the load rather than silently
    substituting empty. Conditions are equality only, matching the workflow contract.
  - **W6-5** Limits: 64 KB per pack, 16 cards total, 8 steps per card, 12 fields per step,
    4 outcomes per card. Pack text is rendered as plain text; control characters other than
    newline and tab are refused.
  - **W6-6** A broken pack is skipped with its reason in `issues`, never cached as
    last-known-good — the card is a screen the user opens, so a silent disappearance would be
    less informative than a visible failure.
  - **W6-7** AIA adds and edits cards by writing the pack skill (C3). Deleting one is the
    user's action in the Automation tab — it moves that skill to the app trash — and bundled
    cards, having no file to remove, are hidden through `hiddenOnboardingCards` in the system
    automation settings.
  - **W6-8** A pack declares parallelism with one line (`workflow.parallel`); the app owns
    everything that follows. It appends the reserved parallel field group
    (`PARALLEL_FIELD_KEYS` in `src/lib/aiaOnboarding.ts`) to the card's last step, prefixes the
    instruction with the lane preamble, sets the round's `pacing.maxRuns`, and adds
    `parallel-round-lanes` to `requiredSkills`. **Parallel is off by default** — a lane pool,
    disk headroom, and pushing to a dev line are not a given on every project, so the card
    asks rather than assumes.
  - **W6-9** A generated contract's instruction carries **values only**; the procedure lives in
    a skill. A pack names the bundled source with `workflow.procedure` (`BUNDLED_SKILLS` in
    `aia_onboarding.rs`), and creating the workflow copies that body into a **common skill named
    after the workflow itself** — onboarding runs once per project, so each project owns its
    procedure and editing one never changes another project's rounds. An existing key is left
    alone; the user may have edited it. The lane skill is the exception: it is machinery, not a
    procedure, so it stays shared. Copying a procedure into the instruction instead would freeze
    it into every contract already registered. A bundled test asserts every bundled workflow
    declares a `procedure` and that its instruction holds no numbered steps.
  - **W6-11** Before registering, `workflowIdProblems` refuses an identifier that `slugify`
    strips to nothing. Two projects whose identifiers are written only in Hangul or symbols
    would otherwise produce the same workflow id — registering a new version over the other
    project's contract and sharing one procedure skill between them.
  - **W6-10** A parallel round must not mark work done outside the repository (milestone item,
    ticket, history row) until landing succeeds. A commit stranded on a lane branch while its
    item reads "done" is skipped by the next round.

## 6. One-time storage reset (`storage_reset.rs`)

- **S1** The reset removes only the obsolete Agent Manager-owned stores in its explicit
  three-file allowlist, once, before supervisors start, and records a marker. Provider homes and
  the `manager-state.json` settings store are deliberately outside the allowlist. Adding a file
  requires the same verification discipline as C2-2.

## 7. AIA catalog registration

- When you add or change a feature — a new or changed typed IPC operation, system command,
  workflow primitive, or option schema — register the change in the AIA system catalog in
  `crates/agent-manager-core/src/system_mcp.rs`. Update the `capability!` entry in
  `SYSTEM_CAPABILITIES` and the matching entry in `operation_catalog()` together, and keep both
  consistent with what the `invoke_system_command` dispatcher actually accepts.
- Register read-only operations as `Read` and mutating operations as `Execute` (write-gated).
- Renaming or removing an operation must update or remove its catalog entries in the same change.
- A feature AIA cannot or must not drive — for example interactive terminal authentication — is
  not registered as an operation. Document the limitation in the catalog's `limits` text so AIA
  can guide the user to the UI, and give the UI location a `show_ui_guide` target so AIA can
  point at it: add an entry to `src/lib/uiGuideTargets.json` (shared by the backend via
  `include_str!` and by the frontend via JSON import) and put the matching `data-ui-anchor` on
  the element. Targets reachable only through drawers or modals are not registered; AIA can
  still point at any visible button or input without an anchor through `find_ui_elements`
  (screen scan answered by the frontend) and `show_ui_guide` with `element`, and can press
  opening controls (tabs, nav, drawer/pane toggles — anything `isUiOpener` in
  `src/lib/uiElements.ts` accepts) with `open_ui_element`. Other buttons need the approval-gated
  `click_ui_element` unless the system-agent run setting `uiClickPolicy` is `all`; buttons inside
  `.modal-backdrop` are always refused by the frontend.
- Changing an `interface_*` operation also means keeping the `mcp_registry.rs` catalog payload
  (schemes, limits, authentication note) accurate.

## 8. Verification

Scope verification to what changed, and keep its **output** small. The crate has 461 lib tests
and `src/lib` has 32 test files; run verbosely and a one-line fix costs ~10k tokens of passing
test output. The V-conditions below are measured, not estimated.

### V1 — quiet reporters are mandatory

Both flags keep full failure diagnostics (panic message, assertion left/right, `file:line`) and
only suppress per-test success lines. Never run these commands without them.

| Command | Without | With | Cut |
| --- | --- | --- | --- |
| `cargo test -p agent-manager-core --lib` (461 tests) | 39,017 B | `-q` → 622 B | 63× |
| `node --test src/lib/*.test.mjs` (32 files) | 17,213 B | `--test-reporter=dot` → 212 B | 81× |
| `cypress run` (E2E, via `npm run test:e2e`) | per-step spec log | `--reporter dot --quiet` (the harness sets both) | — |

### V2 — climb the ladder, do not start at the top

Pick the narrowest rung that covers the change. Escalate only on a failure, or when the change
crosses module boundaries.

| Rung | When | Command | Cost |
| --- | --- | --- | --- |
| 0 | only comments, `//!` docs, or `*.md` changed | nothing, beyond V3 if Rust files were touched | 0 |
| 1 | one Rust module's internals | `cargo test -q -p <crate> --lib <module>::` | ~157 B, 0.1 s |
| 2 | shared types, public API, or two or more modules in a crate | `cargo test -q -p <crate> --lib` | ~622 B, 5 s |
| 3 | release prep or explicit request only | `npm run check` | ~1.2 KB, 85 s + build |
| 4 | UI shell, routing, settings tabs, or AIA screen-guide/cursor changes | `npm run test:e2e` (isolated backend on a temp app-data dir + Cypress, see `docs/E2E.md`) | one-line summary, ~1 min |

### V3 — formatting

Run `cargo fmt --all` to apply, then `cargo fmt --all --check` to confirm (silent, exit 0).
Running only `--check` on unformatted code dumps an unbounded diff you then have to fix anyway.

### V4 — frontend

- `npx tsc --noEmit` cannot be narrowed (whole project, 3.4 s, silent when clean). Run it **once
  at the end**, not after each edit.
- The full `src/lib` suite with the dot reporter is 212 B and 0.44 s, cheaper than reasoning about
  which files to select. Run all of it:
  `node --experimental-strip-types --test --test-reporter=dot src/lib/*.test.mjs`

### V5 — one pass per change

Verify after the edits for a task are complete, not after each intermediate edit. Re-running a
suite that already passed, because a later unrelated edit landed, is waste unless that edit
touches the same module.

### V6 — never quote passing output

Report the `test result:` counts line and nothing else. On failure, quote only the failing test's
diagnostic block, not the surrounding run.

Run `npm run tauri build -- --no-bundle` only when packaging, capabilities, Tauri commands, or
native dependencies change.

## 9. Committing finished work

- **D1** A change is not complete until it is committed. When the section 8 rung for the change
  passes, commit in the same turn and report the hash. Verified work left in the working tree
  hands the next session a diff it did not write and cannot safely stage.
- **D2** Commit **only the files this session changed**. Hunks another session left behind stay in
  the tree — you did not write them, cannot tell finished work from scratch work in them, and
  committing them puts their author's unfinished state under your message.

  ```sh
  git status --short                  # read the whole tree, foreign hunks included
  git diff -- <your files>            # know your own change well enough to describe it
  git add -- <your files>             # name them; never `git add -A` in a shared worktree
  git diff --cached --stat            # confirm the staged set is exactly yours
  ```

  Stage your own set even when it spans several files — a frontend call and the backend command it
  invokes go in together, because a commit that does not build is worse than a wide one. If you
  genuinely cannot tell whether a hunk is yours, leave it: an uncommitted change is recoverable,
  a commit attributing someone else's half-written work to you is not.

  Two conditions before staging. The section 8 rung must pass for **your** change — run it in the
  tree as it stands, and if a foreign hunk breaks the build or a test, say so in the report rather
  than committing around it or fixing it silently. And your own set must be complete: never leave
  part of your change behind to be committed later.

- **D3** One commit per turn, covering your own change. Korean subject naming the behavior that
  changed; when your change spans several workstreams, name the largest one in the subject and list
  the rest in the body. The body states what was wrong, why each fix is shaped that way, and what
  deliberately stayed the same; close with the `Co-Authored-By` trailer. Reach for the
  `split-commit` skill only when the user asks for separated commits.
- **D4** Commit on the current branch and stop there. Do not push, tag, branch, or switch branches
  unless asked — a branch switch in a shared worktree pulls the ground out from under the other
  sessions. Releases go through the `release-agent-manager` skill.
- **D5** Unattended rounds land on `private/dev-history` roughly a hundred times a day, so a file
  you are part-way through is likely to move under you. Reserve it. `.rounds/reserved-paths` is an
  untracked, line-per-entry file the refactor, QA and public-readiness rounds read before they pick
  work; anything listed there is off limits to them.

  ```
  2026-09-22 crates/agent-manager-core/src/scheduler.rs   # 예약 정산 다시 보는 중
  2026-09-22 src/components/WorkflowsView.tsx
  ```

  One entry per line: `YYYY-MM-DD <path glob> [# note]`. Blank lines and `#` lines are ignored, and
  an entry older than three days is ignored too, so a forgotten line thaws by itself instead of
  freezing a path forever. Delete your lines when you are done — do not edit anyone else's.

  The same rounds fast-forward this worktree to the dev line after they land, but only when it is
  clean, on `dev-history`, purely behind, and `.rounds/.lease/maintree` is absent. Dirty work is
  never touched. If you need the tree held still for a long stretch, `date > .rounds/.lease/maintree`
  stops the fast-forward, and `rm` it when you are done (it is ignored after 180 minutes).
