# Agent Manager 배포용 서명·공증 (macOS)

배포본에 Apple Developer ID 서명과 공증을 적용하는 절차입니다. 개발 중 안정된 코드서명 신원만
필요하다면 자체서명을 쓰는 [LOCAL_CODE_SIGNING.md](./LOCAL_CODE_SIGNING.md)를 보세요. 두 경로는
서로를 대체하지 않습니다.

전제: Apple Developer Program 유료 멤버십(개인 또는 조직)이 활성 상태여야 합니다.

## 1. Developer ID Application 인증서

배포용 인증서는 `Apple Development`가 아니라 **Developer ID Application**입니다.

1. Xcode → Settings → Accounts에서 Apple 계정을 추가합니다.
2. 팀을 선택하고 `Manage Certificates…` → 왼쪽 아래 `+` → `Developer ID Application`을 만듭니다.
3. 로그인 Keychain에 개인키와 함께 들어갔는지 확인합니다.

```bash
security find-identity -v -p codesigning
# "Developer ID Application: <이름> (<TEAMID>)" 항목이 보여야 합니다.
```

개인 계정은 인증서를 직접 만들 수 있고, 조직 계정은 Account Holder 권한이 필요합니다.
인증서가 여러 개면 `AGENT_MANAGER_APPLE_SIGNING_IDENTITY`에 사용할 이름을 정확히 지정합니다.

## 2. 공증 자격증명

둘 중 하나만 준비하면 됩니다. 여러 기기·CI로 확장할 계획이면 1)을 권합니다.

**1) App Store Connect API 키 (권장)**

App Store Connect → Users and Access → Integrations → App Store Connect API에서 `Developer`
이상 권한의 Team Key를 만들고 `.p8` 파일을 내려받습니다. `.p8`은 최초 1회만 내려받을 수 있으니
저장소 바깥의 안전한 경로(예: `~/.config/agent-manager/`)에 두고 권한을 `600`으로 둡니다.

- `APPLE_API_KEY` — Key ID
- `APPLE_API_ISSUER` — Issuer ID
- `APPLE_API_KEY_PATH` — `.p8` 파일 절대경로

**2) Apple ID + 앱 암호**

appleid.apple.com → 로그인 및 보안 → 앱 암호에서 앱 암호를 발급합니다. 계정 암호를 그대로
쓰지 않습니다.

- `APPLE_ID` — Apple 계정 이메일
- `APPLE_PASSWORD` — 앱 암호
- `APPLE_TEAM_ID` — 10자 팀 식별자

## 3. 자격증명 보관

빌드 스크립트는 `~/.config/agent-manager/apple-signing.env`가 있으면 읽습니다
(`AGENT_MANAGER_APPLE_ENV_FILE`로 경로 변경 가능). 저장소 바깥 경로이며 절대 커밋하지 않습니다.

```bash
mkdir -p ~/.config/agent-manager
cat > ~/.config/agent-manager/apple-signing.env <<'EOF'
APPLE_API_KEY=XXXXXXXXXX
APPLE_API_ISSUER=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
APPLE_API_KEY_PATH=/Users/<사용자>/.config/agent-manager/AuthKey_XXXXXXXXXX.p8
EOF
chmod 600 ~/.config/agent-manager/apple-signing.env
```

이 파일을 쓰지 않고 같은 이름의 환경 변수를 직접 내보내도 됩니다. 환경 변수로 줄 때는 셸 기록에
비밀이 남지 않도록 주의하세요.

## 4. 빌드

```bash
CI=true npm run tauri:build:release-signed -- --bundles dmg
```

`--bundles`를 비롯한 인자는 그대로 `tauri build`에 전달됩니다. 스크립트가 하는 일은 다음과 같습니다.

1. Developer ID Application 신원을 확인하고 `APPLE_SIGNING_IDENTITY`로 넘긴다.
2. 공증 자격증명이 한 벌 갖춰졌는지 먼저 확인하고, 없으면 빌드 전에 멈춘다.
3. `src-tauri/tauri.macos-signing.conf.json`을 덧씌워 하드닝 런타임과
   `src-tauri/entitlements.plist`를 적용해 빌드한다. 앱의 공증과 staple은 Tauri 번들러가 한다.
4. Tauri는 DMG를 서명만 하고 staple하지 않으므로, DMG는 스크립트가 따로 공증해 staple한다.
5. 산출물을 `codesign --verify --deep --strict`, `spctl --assess`, `stapler validate`로 검증한다.
   `--bundles dmg`로 만들면 Tauri가 DMG 생성 후 `.app`을 지우므로, DMG를 마운트해
   안에 든 앱까지 확인한다. 마운트는 그 DMG의 것만 분리한다.

서명은 하되 공증만 건너뛰려면 `AGENT_MANAGER_SKIP_NOTARIZATION=1`을 줍니다. 이렇게 만든
산출물은 다른 기기에서 Gatekeeper를 통과하지 못하므로 배포하지 않습니다.

빌드가 성공하고 공증이 Accepted여도 실행은 별개다. 하드닝 런타임이 기능을 깨지 않았는지는
[../../docs/MACOS_NOTARIZED_SMOKE.md](../../docs/MACOS_NOTARIZED_SMOKE.md)의 스모크 절차로 릴리스마다 확인한다.

## 5. 권한 예외

`src-tauri/entitlements.plist`에는 마이크 입력(`com.apple.security.device.audio-input`)만 있습니다.
눌러서 말하기가 WKWebView 안에서 마이크를 직접 열기 때문입니다. 앱 샌드박스는 켜지 않습니다 —
Agent Manager는 사용자가 지정한 임의의 폴더와 CLI 실행 파일을 다룹니다.

하드닝 런타임 때문에 기능이 깨지면 예외를 추가하기 전에 어떤 API가 막혔는지 먼저 확인하세요.
`log stream --predicate 'subsystem == "com.apple.TCC"'`와 크래시 로그의 `EXC_CRASH (SIGKILL (Code Signature Invalid))`가
단서가 됩니다.

## 6. 공증 실패 진단

공증이 거부되면 제출 ID로 사유를 확인합니다.

```bash
xcrun notarytool history --key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER"
xcrun notarytool log <submission-id> --key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER"
```

자주 나오는 원인은 하드닝 런타임 미적용, 타임스탬프 없는 서명, 번들 안에 서명되지 않은
실행 파일이 섞인 경우입니다.
