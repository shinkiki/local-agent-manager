#Requires -Version 5.1
<#
.SYNOPSIS
    Tauri 번들러가 호출하는 Windows Authenticode 서명 래퍼.

.DESCRIPTION
    tauri.windows-signing.conf.json 의 signCommand 가 파일 하나마다 이 스크립트를
    호출한다(앱 exe, 사이드카, NSIS/MSI 설치본). 서명 도구와 자격증명은 모두
    환경변수로 주입하며, 이 저장소에는 인증서도 비밀값도 두지 않는다.

    Tauri 는 signCommand 를 셸 없이 실행하므로 환경변수를 여기서 직접 읽는다.

.ENVIRONMENT
    공통
      AGENT_MANAGER_WINDOWS_TIMESTAMP_URL  RFC3161 타임스탬프 서버
                                           (기본 http://timestamp.digicert.com)

    Azure Key Vault 방식 (OV 인증서를 Key Vault Premium/HSM 에 보관)
      AZURE_KEY_VAULT_URL                  https://<vault>.vault.azure.net
      AZURE_KEY_VAULT_CERTIFICATE          인증서 이름
      AZURE_CLIENT_ID / AZURE_CLIENT_SECRET / AZURE_TENANT_ID
                                           서비스 주체. 셋 다 없으면 관리 ID로 시도한다.

    로컬 인증서 저장소 방식 (USB 토큰을 꽂은 개발자 PC)
      AGENT_MANAGER_WINDOWS_CERT_THUMBPRINT  서명 인증서 SHA1 지문

    둘 다 없으면 서명하지 않고 실패한다. 미서명 번들을 원하면 이 설정 파일을
    빼고 빌드하면 된다.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Path
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Path)) {
    throw "서명할 파일을 찾지 못했습니다: $Path"
}

$timestampUrl = $env:AGENT_MANAGER_WINDOWS_TIMESTAMP_URL
if ([string]::IsNullOrWhiteSpace($timestampUrl)) {
    $timestampUrl = 'http://timestamp.digicert.com'
}

function Invoke-SigningTool {
    param(
        [string]$Tool,
        [string[]]$Arguments
    )

    # 자격증명이 인수로 들어오므로 실패해도 인수를 그대로 출력하지 않는다.
    & $Tool @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Tool 서명 실패(exit $LASTEXITCODE): $Path"
    }
}

if (-not [string]::IsNullOrWhiteSpace($env:AZURE_KEY_VAULT_URL)) {
    if ([string]::IsNullOrWhiteSpace($env:AZURE_KEY_VAULT_CERTIFICATE)) {
        throw 'AZURE_KEY_VAULT_URL 을 설정했으면 AZURE_KEY_VAULT_CERTIFICATE 도 필요합니다.'
    }

    $azureSignTool = Get-Command 'AzureSignTool' -ErrorAction SilentlyContinue
    if (-not $azureSignTool) {
        throw 'AzureSignTool 을 찾지 못했습니다. `dotnet tool install --global AzureSignTool` 로 설치하세요.'
    }

    $arguments = @(
        'sign',
        '--azure-key-vault-url', $env:AZURE_KEY_VAULT_URL,
        '--azure-key-vault-certificate', $env:AZURE_KEY_VAULT_CERTIFICATE,
        '--file-digest', 'sha256',
        '--timestamp-rfc3161', $timestampUrl,
        '--timestamp-digest', 'sha256'
    )

    if (-not [string]::IsNullOrWhiteSpace($env:AZURE_CLIENT_ID)) {
        $arguments += @(
            '--azure-key-vault-client-id', $env:AZURE_CLIENT_ID,
            '--azure-key-vault-client-secret', $env:AZURE_CLIENT_SECRET,
            '--azure-key-vault-tenant-id', $env:AZURE_TENANT_ID
        )
    }
    else {
        $arguments += '--azure-key-vault-managed-identity'
    }

    $arguments += $Path
    Invoke-SigningTool -Tool $azureSignTool.Source -Arguments $arguments
    Write-Host "서명 완료(Key Vault): $Path"
    exit 0
}

if (-not [string]::IsNullOrWhiteSpace($env:AGENT_MANAGER_WINDOWS_CERT_THUMBPRINT)) {
    $signtool = Get-Command 'signtool.exe' -ErrorAction SilentlyContinue
    if (-not $signtool) {
        # Windows SDK 는 PATH 에 없는 경우가 많다. 설치된 SDK 중 최신 x64 를 고른다.
        $candidate = Get-ChildItem -Path 'C:\Program Files (x86)\Windows Kits\10\bin' `
            -Filter 'signtool.exe' -Recurse -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -match '\\x64\\' } |
            Sort-Object -Property FullName -Descending |
            Select-Object -First 1
        if (-not $candidate) {
            throw 'signtool.exe 를 찾지 못했습니다. Windows SDK 의 Signing Tools 를 설치하세요.'
        }
        $signtool = [pscustomobject]@{ Source = $candidate.FullName }
    }

    $arguments = @(
        'sign',
        '/fd', 'sha256',
        '/tr', $timestampUrl,
        '/td', 'sha256',
        '/sha1', $env:AGENT_MANAGER_WINDOWS_CERT_THUMBPRINT,
        $Path
    )

    Invoke-SigningTool -Tool $signtool.Source -Arguments $arguments
    Write-Host "서명 완료(로컬 인증서 저장소): $Path"
    exit 0
}

throw @'
서명 자격증명이 없습니다. 다음 중 하나를 설정하세요.
  - AZURE_KEY_VAULT_URL + AZURE_KEY_VAULT_CERTIFICATE (+ 서비스 주체 3종)
  - AGENT_MANAGER_WINDOWS_CERT_THUMBPRINT
미서명 번들을 만들려면 --config src-tauri/tauri.windows-signing.conf.json 없이 빌드하세요.
'@
