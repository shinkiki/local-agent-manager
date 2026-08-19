# Agent Manager에 기여하기

이 프로젝트는 로컬 AI 에이전트의 세션과 자격증명을 다루므로 일반적인 UI 변경도 데이터 소유권과 보안 경계를 지켜야 합니다.

## 개발 환경

- Node.js 22 이상
- Rust stable
- macOS: Xcode Command Line Tools
- Windows: Microsoft C++ Build Tools와 WebView2

```bash
npm ci
npm run tauri dev
```

## 변경 원칙

- `src/`는 화면 표시와 입력, typed IPC 호출만 담당합니다.
- `src-tauri/`는 IPC를 Rust Core 호출로 변환하는 얇은 어댑터입니다.
- 도메인·파일·DB·프로세스·플랫폼 동작은 `crates/agent-manager-core/`에 둡니다.
- 공급자가 소유한 세션·히스토리·설정 저장소는 읽기 전용으로 취급합니다. 자격증명 교체는 Core의 검증된 credential adapter 밖에서 구현하지 않습니다.
- 셸 문자열을 조합해 실행하지 말고 승인된 실행 파일과 인자 배열을 사용합니다.
- 경로는 Rust에서 정규화하고 허용된 루트 안인지 검증합니다.
- 테스트와 문서에는 실제 사용자 이메일, 세션 ID, Tailnet 호스트, 토큰 또는 로컬 절대 경로를 넣지 않습니다. `example.com`, `device.example.ts.net`, 임시 디렉터리를 사용합니다.

이 저장소의 공개 아키텍처와 보안 경계는 위 변경 원칙을 기준으로 합니다.

## 로컬 에이전트 설정

`AGENTS.md`, `CLAUDE.md`, `.claude/`, `.agents/`, `.codex/`처럼 개인 개발 환경에서 사용하는 에이전트 지침과 설정은 공개 저장소에 커밋하지 않습니다. 필요한 경우 별도의 비공개 companion 저장소에서 관리하되, 공급자 인증·세션·히스토리·로컬 상태 파일은 비공개 저장소에도 넣지 않습니다.

## 변경 제출

1. 기존 이슈가 있는지 확인하고 변경 목적과 사용자 영향을 설명합니다.
2. 기능 변경에는 정상·실패·경계 조건 테스트를 함께 추가합니다.
3. UI, IPC, Core 중 영향을 받는 모든 계층의 타입과 오류 처리를 확인합니다.
4. 문서 또는 설정이 달라졌다면 README와 관련 가이드를 갱신합니다.
5. PR 체크리스트를 채우고 아래 검증을 통과시킵니다.

```bash
npm run build
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
npm run tauri build -- --no-bundle
```

보안 취약점은 공개 이슈나 PR로 먼저 공개하지 말고 [보안 정책](.github/SECURITY.md)을 따라 제보해 주세요.
