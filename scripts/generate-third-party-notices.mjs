#!/usr/bin/env node
// THIRD-PARTY-NOTICES.md 생성기.
// Cargo.lock의 전이 의존성과 package-lock.json의 배포 대상(non-dev) 패키지를 모아
// SPDX 식별자와 각 패키지가 배포하는 라이선스 전문을 수집한다.
// 동일한 전문은 해시로 묶어 한 번만 실으므로 파일 크기가 패키지 수에 비례해 늘지 않는다.
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, existsSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'THIRD-PARTY-NOTICES.md')
const WORKSPACE_CRATES = new Set(['agent-manager-tauri', 'agent-manager-server', 'agent-manager-core'])
const LICENSE_FILE = /^(LICEN[SC]E|COPYING|COPYRIGHT|NOTICE|UNLICENSE)/i
const TEXT_LIMIT = 64 * 1024

const sha = (s) => createHash('sha256').update(s).digest('hex')
// 줄 끝 공백과 빈 줄 개수만 다른 사본은 같은 고지로 묶는다.
const canonical = (s) =>
  s
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')

function collectLicenseTexts(dir) {
  const out = []
  if (!dir || !existsSync(dir)) return out
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !LICENSE_FILE.test(entry.name)) continue
    const path = join(dir, entry.name)
    try {
      if (statSync(path).size > TEXT_LIMIT) continue
      const text = readFileSync(path, 'utf8').replace(/\r\n/g, '\n').trim()
      if (text) out.push({ file: entry.name, text })
    } catch {
      /* 읽을 수 없는 고지 파일은 건너뛰고 SPDX 식별자만 남긴다 */
    }
  }
  return out
}

function cargoRegistryIndex() {
  const index = new Map()
  const base = join(homedir(), '.cargo', 'registry', 'src')
  if (!existsSync(base)) return index
  for (const registry of readdirSync(base)) {
    const dir = join(base, registry)
    let entries = []
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of entries) if (!index.has(name)) index.set(name, join(dir, name))
  }
  return index
}

function readCargoManifestLicense(dir) {
  const manifest = join(dir, 'Cargo.toml')
  if (!existsSync(manifest)) return null
  const text = readFileSync(manifest, 'utf8')
  const spdx = text.match(/^license\s*=\s*"([^"]+)"/m)
  if (spdx) return spdx[1]
  const file = text.match(/^license-file\s*=\s*"([^"]+)"/m)
  return file ? `see ${file[1]}` : null
}

function cargoPackages() {
  const lock = readFileSync(join(ROOT, 'Cargo.lock'), 'utf8')
  const index = cargoRegistryIndex()
  const packages = []
  for (const block of lock.split('[[package]]').slice(1)) {
    const name = block.match(/^\s*name = "([^"]+)"/m)?.[1]
    const version = block.match(/^\s*version = "([^"]+)"/m)?.[1]
    if (!name || !version || WORKSPACE_CRATES.has(name)) continue
    const dir = index.get(`${name}-${version}`)
    packages.push({
      ecosystem: 'cargo',
      name,
      version,
      license: (dir && readCargoManifestLicense(dir)) || 'UNKNOWN',
      texts: collectLicenseTexts(dir),
      resolved: Boolean(dir),
    })
  }
  return packages.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
}

function readNpmLicense(dir, declaredLicense) {
  let license = declaredLicense || 'UNKNOWN'
  if (license === 'UNKNOWN' && existsSync(join(dir, 'package.json'))) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      const raw = pkg.license || pkg.licenses
      if (raw) license = raw
    } catch {
      /* package.json을 못 읽으면 UNKNOWN으로 남긴다 */
    }
  }
  return typeof license === 'string' ? license : JSON.stringify(license)
}

function npmPackages() {
  const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'))
  const packages = []
  for (const [path, meta] of Object.entries(lock.packages || {})) {
    if (!path || meta.dev || meta.link) continue
    const dir = join(ROOT, path)
    const name = meta.name || path.replace(/^(?:.*node_modules\/)/, '')
    packages.push({
      ecosystem: 'npm',
      name,
      version: meta.version || '',
      license: readNpmLicense(dir, meta.license),
      texts: collectLicenseTexts(dir),
      resolved: existsSync(dir),
    })
  }
  return packages.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
}

function summarize(packages) {
  const counts = new Map()
  for (const pkg of packages) counts.set(pkg.license, (counts.get(pkg.license) || 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}

function renderTable(packages) {
  const rows = packages.map((p) => `| \`${p.name}\` | ${p.version} | ${p.license} |`)
  return ['| 패키지 | 버전 | 라이선스 (SPDX) |', '| --- | --- | --- |', ...rows].join('\n')
}

/** 같은 고지 전문을 배포하는 패키지를 한 묶음으로 모은다. 많이 쓰이는 전문이 앞에 온다. */
function groupLicenseTexts(packages) {
  const texts = new Map()
  for (const pkg of packages) {
    for (const { file, text } of pkg.texts) {
      const key = sha(canonical(text))
      if (!texts.has(key)) texts.set(key, { text, users: [] })
      texts.get(key).users.push(`${pkg.name} ${pkg.version} (${file})`)
    }
  }
  return [...texts.values()].sort((a, b) => b.users.length - a.users.length)
}

function renderLicenseMatrix(cargo, npm) {
  const cargoCounts = new Map(summarize(cargo))
  const npmCounts = new Map(summarize(npm))
  const total = (key) => (cargoCounts.get(key) || 0) + (npmCounts.get(key) || 0)
  const keys = [...new Set([...cargoCounts.keys(), ...npmCounts.keys()])].sort(
    (a, b) => total(b) - total(a) || a.localeCompare(b),
  )
  return [
    '| 라이선스 (SPDX) | Rust | npm |',
    '| --- | --- | --- |',
    ...keys.map((key) => `| ${key} | ${cargoCounts.get(key) || 0} | ${npmCounts.get(key) || 0} |`),
  ]
}

function renderMissingSection(missing) {
  if (!missing.length) return []
  return [
    '## 고지 전문이 패키지에 포함되지 않은 의존성',
    '',
    '아래 패키지는 배포 아카이브에 라이선스 파일을 포함하지 않습니다. 위 표의 SPDX 식별자가 해당 패키지의 라이선스이며, 전문은 같은 식별자를 쓰는 아래 고지 전문을 따릅니다.',
    '',
    ...missing.map((pkg) => `- \`${pkg.name}\` ${pkg.version} — ${pkg.license}${pkg.resolved ? '' : ' (로컬 캐시 없음)'}`),
    '',
  ]
}

function renderNoticeGroup(group, index) {
  return [
    `### 고지 ${index + 1} — 적용 패키지 ${group.users.length}개`,
    '',
    '<details><summary>적용 패키지 보기</summary>',
    '',
    ...group.users.sort().map((user) => `- ${user}`),
    '',
    '</details>',
    '',
    '```text',
    group.text,
    '```',
    '',
  ]
}

function renderDocument({ cargo, npm, groups, missing }) {
  const lines = [
    '# 써드파티 저작권 고지',
    '',
    'Agent Manager 본체는 [MIT](LICENSE-MIT) 또는 [Apache License 2.0](LICENSE-APACHE) 중 선택하여 사용할 수 있습니다.',
    '이 문서는 배포물에 포함되는 써드파티 의존성의 라이선스와 저작권 고지를 모은 것입니다.',
    '',
    '`npm run notices:generate`로 다시 만듭니다. 직접 편집하지 마십시오.',
    '',
    '## 요약',
    '',
    `- Rust(Cargo) 의존성: ${cargo.length}개 (워크스페이스 자체 크레이트 제외)`,
    `- npm 배포 대상 의존성: ${npm.length}개 (devDependencies 제외)`,
    `- 수집한 고지 전문: ${groups.length}종`,
    '',
    ...renderLicenseMatrix(cargo, npm),
    '',
    '## Rust (Cargo) 의존성',
    '',
    renderTable(cargo),
    '',
    '## npm 의존성 (배포 대상)',
    '',
    renderTable(npm),
    '',
    ...renderMissingSection(missing),
    '## 라이선스 및 저작권 고지 전문',
    '',
    '동일한 전문은 한 번만 싣고 해당 전문을 배포하는 패키지를 함께 표시합니다.',
    '',
    ...groups.flatMap(renderNoticeGroup),
  ]
  return `${lines.join('\n')}\n`
}

function main() {
  const cargo = cargoPackages()
  const npm = npmPackages()
  const all = [...cargo, ...npm]
  const groups = groupLicenseTexts(all)
  const missing = all.filter((p) => p.texts.length === 0)

  writeFileSync(OUT, renderDocument({ cargo, npm, groups, missing }), 'utf8')
  console.log(`THIRD-PARTY-NOTICES.md 생성: Rust ${cargo.length}개, npm ${npm.length}개, 고지 전문 ${groups.length}종, 전문 미포함 ${missing.length}개`)
}

main()
