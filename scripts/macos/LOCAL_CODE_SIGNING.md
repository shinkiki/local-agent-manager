# Agent Manager 로컬 코드서명

Agent Manager의 다중 계정 자격증명은 macOS Keychain의 단일 Vault 항목에 저장됩니다. Vault와 Claude Keychain 항목은 Apple이 서명한 `/usr/bin/security`를 통해 접근하므로 Keychain 반복 승인 방지를 위해 로컬 앱 인증서를 만들 필요는 없습니다.

이 문서의 로컬 인증서는 Keychain 외의 macOS 권한이나 개발 바이너리 자체에 안정된 코드서명 신원이 필요한 경우에만 선택적으로 사용합니다.

## 최초 설정

1. macOS `키체인 접근`을 열고 `인증서 지원 > 인증서 생성`을 선택합니다.
2. 이름을 `Agent Manager Local Development`로 입력합니다.
3. 신원 유형은 `자체 서명 루트`, 인증서 유형은 `코드 서명`을 선택합니다.
4. 로그인 키체인에 생성한 뒤 인증서의 신뢰 설정에서 코드 서명을 `항상 신뢰`로 설정합니다.
5. 다음 명령에서 유효한 신원이 한 개 이상 표시되는지 확인합니다.

```bash
security find-identity -v -p codesigning
```

인증서 개인키와 암호는 저장소나 환경 파일에 내보내지 않습니다. 다른 이름을 사용했다면 실행 시 `AGENT_MANAGER_CODESIGN_IDENTITY`에 인증서 이름만 지정할 수 있습니다.

## 서명된 실행

```bash
npm run tauri:dev:signed
npm run tauri:build:signed -- --no-bundle
npm run server:build:signed
```

서명 스크립트는 인증서가 없거나 서명 검증이 실패하면 실행을 중단하며 미서명 실행으로 대체하지 않습니다. 모든 바이너리는 `com.shinc.agentmanager` 식별자를 사용합니다.

Keychain 접근은 앱 바이너리가 아니라 `/usr/bin/security`가 수행합니다. 새 Vault와 공식 Claude CLI가 생성한 항목은 같은 접근 주체를 사용하므로 일반 `npm run tauri dev`, `npm run tauri dev --remote-write`, `npm run tauri:dev:remote-write`에서도 앱 재빌드에 따른 반복 암호 확인 창이 없어야 합니다. 로그인 Keychain 자체가 잠긴 경우에는 macOS가 잠금 해제를 요구할 수 있습니다.

macOS `security`는 긴 비밀을 stdin으로 받는 비대화형 인터페이스가 없으므로 저장 시 셸을 거치지 않는 구조화된 `-w` 인자를 사용합니다. 비밀은 파일·로그·오류에 기록하지 않지만, `security`가 실행되는 짧은 동안 같은 사용자 권한의 프로세스 조회에는 노출될 수 있습니다.

## 기존 계정 전환

기존 계정 메타데이터와 예약 요청 참조는 유지되지만 자격증명은 `재인증 필요` 상태가 됩니다. 예전 앱 ACL로 만든 `vault-v2`는 자동으로 읽거나 삭제하지 않으며, 설정에서 각 Codex·Claude 계정을 재인증해 새 단일 Vault를 채웁니다.

모든 계정의 재인증·전환·사용량 조회를 확인한 뒤 Keychain Access에서 구버전 계정별 service `com.agent-manager.provider-credentials`와 이전 단일 Vault account `vault-v2`를 수동 삭제할 수 있습니다. 새 항목의 service는 `com.shinc.agentmanager.credential-vault`, account는 `vault-v3-security`입니다.

정상적인 `vault-v2` 자격증명을 v3로 복구하려면 `npm run keychain:migrate:v2`를 실행합니다. 이 명령은 v2와 내부 계정 JSON을 검증하고 v3 저장값을 다시 읽어 일치함을 확인하며, 성공 전에는 계정 레지스트리를 갱신하지 않습니다. v2 항목은 자동 삭제하지 않습니다.

`/usr/bin/security`를 신뢰 접근자로 사용하면 앱 코드서명과 관계없이 개발 실행이 안정되는 대신, 같은 macOS 사용자 권한으로 실행되는 다른 프로세스도 `/usr/bin/security`를 호출할 수 있습니다. 이는 로컬 개발 편의성을 위해 접근 격리가 낮아지는 선택입니다.
