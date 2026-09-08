# Windows 코드 서명

Windows 설치 경고는 두 가지이고 원인이 다릅니다.

| 경고 | 원인 | 해결 |
| --- | --- | --- |
| UAC "알 수 없는 게시자" | Authenticode 서명 없음 | 서명하면 즉시 사라짐 |
| SmartScreen "Windows에서 PC를 보호했습니다" | 파일·게시자 평판 없음 | 서명한 뒤 같은 신원으로 배포를 이어가며 평판이 쌓여야 사라짐 |

NSIS 설치본은 `installMode: currentUser`(관리자 권한 불필요)로 만들기 때문에 UAC 승격
대화상자 자체가 뜨지 않습니다. 남는 것은 SmartScreen이고, 이건 서명만으로 즉시 해결되지
않습니다. EV 인증서의 "즉시 SmartScreen 신뢰"는 2024년 Microsoft 신뢰 루트 정책 개정으로
없어졌으므로, 같은 목적에 EV를 OV보다 비싸게 살 이유는 없습니다.

## 인증서 선택

| 방법 | 비용 | 제약 |
| --- | --- | --- |
| Azure Artifact Signing (구 Trusted Signing) | 월 $9.99 | 조직은 미국·캐나다·EU·영국, 개인은 미국·캐나다만 가입 가능. **한국 발행자는 현재 대상 아님** |
| OV 인증서 + Azure Key Vault Premium | 인증서 연 20~40만원 + Key Vault 사용료 | CI 자동 서명 가능. 이 저장소가 지원하는 기본 경로 |
| OV 인증서 + USB 하드웨어 토큰 | 인증서 연 20~40만원 | 토큰을 꽂은 PC에서만 서명 가능. CI 불가 |
| SignPath.io OSS 프로그램 | 무료 | 오픈소스 프로젝트 심사 필요 |

2023년 CA/B 포럼 규정으로 코드 서명 개인키는 반드시 하드웨어(HSM/토큰)에 있어야 합니다.
CI에서 자동 서명하려면 Key Vault 계열이 사실상 유일한 선택입니다.

## 파이프라인 구조

- `src-tauri/tauri.conf.json` — 서명과 무관한 Windows 번들 설정(게시자, NSIS 설치 모드,
  언어, 다이제스트·타임스탬프 알고리즘). 인증서가 없어도 항상 적용됩니다.
- `src-tauri/tauri.windows-signing.conf.json` — `signCommand`만 담은 덮어쓰기 설정.
  **서명할 때만** `--config`로 얹습니다.
- `scripts/windows/sign-windows-binary.ps1` — 번들러가 파일 하나마다 호출하는 래퍼.
  환경변수를 보고 AzureSignTool 또는 signtool을 고릅니다. Tauri는 `signCommand`를 셸 없이
  실행하므로 환경변수 확장이 이 스크립트 안에서 일어납니다.
- `.github/workflows/release-windows.yml` — 태그 푸시나 수동 실행으로 NSIS·MSI 번들을
  만듭니다. 시크릿이 없으면 미서명으로 빌드하고 아티팩트만 남깁니다.

인증서도 비밀값도 저장소에 두지 않습니다.

## 인증서를 붙일 때

1. OV 인증서를 발급받아 Azure Key Vault(Premium)에 가져옵니다.
2. Key Vault에 접근할 서비스 주체를 만들고 인증서 서명 권한(`Key Vault Certificate User` +
   키 `Sign` 권한)을 부여합니다.
3. 저장소 시크릿에 다음을 등록합니다. `AZURE_KEY_VAULT_URL`이 비어 있는 동안에는 워크플로가
   미서명 경로로 계속 동작합니다.

   | 시크릿 | 값 |
   | --- | --- |
   | `AZURE_KEY_VAULT_URL` | `https://<vault>.vault.azure.net` |
   | `AZURE_KEY_VAULT_CERTIFICATE` | Key Vault 안의 인증서 이름 |
   | `AZURE_CLIENT_ID` | 서비스 주체 애플리케이션 ID |
   | `AZURE_CLIENT_SECRET` | 서비스 주체 비밀 |
   | `AZURE_TENANT_ID` | 디렉터리(테넌트) ID |

4. 워크플로를 수동 실행해 `Verify signature` 단계가 `Valid`를 보고하는지 확인합니다.

## 로컬(개발자 PC)에서 서명해 보기

USB 토큰을 꽂았거나 인증서를 사용자 저장소에 넣어 둔 경우:

```powershell
$env:AGENT_MANAGER_WINDOWS_CERT_THUMBPRINT = "<인증서 SHA1 지문>"
$env:AGENT_MANAGER_WINDOWS_SIGN_SCRIPT = "$PWD\scripts\windows\sign-windows-binary.ps1"
npm run tauri -- build --bundles nsis --config src-tauri/tauri.windows-signing.conf.json
```

`--config`를 빼면 같은 명령이 미서명 번들을 만듭니다.

## 서명한 뒤에도 경고가 남는다면

- 인증서(게시자 신원)를 바꾸지 말고 같은 신원으로 릴리스를 이어가야 평판이 붙습니다.
- 개별 파일 차단은 <https://www.microsoft.com/en-us/wdsi/filesubmission> 에 오탐으로
  신고해 풀 수 있습니다.
- 릴리스 노트에 SHA256 해시를 같이 올려 사용자가 받은 파일을 확인할 수 있게 합니다.
  릴리스 워크플로의 `Report artifact hashes` 단계가 로그에 남깁니다.
