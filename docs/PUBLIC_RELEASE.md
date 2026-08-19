# GitHub 공개 전환 체크리스트

이 문서는 저장소 가시성을 바꾸기 전에 소유자가 확인할 항목을 정리합니다. 가시성 변경과 이력 강제 갱신은 이 체크리스트가 끝난 뒤 별도로 수행합니다.

## 1. 권리와 개인정보

- [ ] 소스와 아이콘을 공개할 권리가 있는지 확인합니다.
- [x] MIT 라이선스를 선택합니다.
- [x] `LICENSE`를 추가하고 README, npm, Cargo 메타데이터를 MIT로 맞춥니다.
- [x] 공개 `main` 이력을 지정한 공개용 작성자 정보의 단일 커밋으로 재작성합니다.
- [x] 공급자 이름과 상표가 공식 제휴 또는 보증을 의미하지 않는다고 README에 명시합니다.
- [ ] 바이너리를 배포한다면 npm·Cargo 전이 의존성의 라이선스를 감사하고 필요한 third-party notice를 함께 제공합니다.

MIT 라이선스 전문과 저작권 표시는 저장소 루트의 `LICENSE`를 기준으로 합니다.

## 2. 로컬 감사

```bash
git status --short --branch
git ls-files
npm audit --omit=dev --audit-level=high
cargo audit
npm run check
npm run tauri build -- --no-bundle
gitleaks detect --source . --redact --no-banner
```

- [ ] 현재 추적 파일과 전체 Git 이력에서 비밀정보 탐지가 0건인지 확인합니다.
- [ ] 실제 이메일, 사용자명, 세션 ID, Tailnet 호스트, 사설 IP, 로컬 절대 경로가 테스트·문서에 없는지 확인합니다.
- [x] `.env`, 공급자 인증 파일, 개인키와 코드서명 파일이 `.gitignore`에 포함되는지 확인합니다.
- [x] `.claude`, `.agents`, `.codex`, `AGENTS.md` 등 로컬 에이전트 작업공간과 개인 지침을 Git 추적 대상에서 제외합니다.
- [ ] `cargo audit`의 취약점뿐 아니라 `unmaintained`·`unsound` 정보성 경고도 대상 플랫폼과 실제 호출 경로를 기준으로 검토합니다.
- [ ] GitHub에 push할 브랜치와 태그만 검사합니다. 로컬 Codex 체크포인트 ref나 백업 ref를 `--mirror`로 push하지 않습니다.

비밀정보가 과거 커밋에서 발견되면 파일만 삭제하지 말고 먼저 비밀을 폐기·재발급한 뒤 이력을 정리합니다. 이력 재작성과 force push는 협업자에게 영향을 주므로 별도 백업과 공지가 필요합니다.

## 3. GitHub 설정

- [ ] 저장소 설명, 홈페이지, 토픽을 등록합니다.
- [ ] CI와 secret scan이 기본 브랜치에서 성공하는지 확인합니다.
- [ ] Private vulnerability reporting, secret scanning, push protection, dependency graph와 Dependabot alerts를 활성화합니다.
- [ ] `main`에 PR 승인, 필수 CI, 대화 해결, force push·삭제 금지를 포함한 branch protection 또는 ruleset을 적용합니다.
- [ ] 공개 이슈에 비밀정보를 올리지 않도록 SECURITY 정책 링크가 표시되는지 확인합니다.
- [ ] 필요하지 않은 Projects, Discussions, Wiki 기능을 끕니다.

## 4. 공개 직전과 직후

- [ ] 공개할 최종 커밋을 다시 gitleaks와 전체 빌드로 검사합니다.
- [ ] 저장소 백업과 공개 전 커밋 SHA를 기록합니다.
- [ ] GitHub 가시성을 `Public`으로 변경합니다.
- [ ] 로그아웃 브라우저에서 코드, README, 보안 정책, 라이선스 표시를 확인합니다.
- [ ] clone 후 `npm ci`와 문서의 개발 명령이 동작하는지 확인합니다.
- [ ] 첫 Dependabot 및 secret scanning 결과를 확인합니다.

가시성 변경은 되돌릴 수 있지만, 공개된 커밋은 이미 복제되었을 수 있으므로 비밀정보·개인정보 검사는 공개 전에 끝내야 합니다.
