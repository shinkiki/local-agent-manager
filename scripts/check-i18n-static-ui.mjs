#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import ts from "typescript";

const ROOT = path.resolve(import.meta.dirname, "..");
const KOREAN = /[가-힣]/;
const PROMPT_EXCLUSIONS = new Set([
  "src/lib/skillTransfer.ts",
  "src/lib/schemaDiscoveryPrompts.ts",
  // AIA 에게 보내는 회차 설계 요청문(M10). 화면 글이 아니라 에이전트 지시문이다.
  "src/lib/roundDesign.ts",
  // 형상관리 화면이 AIA 에게 일을 넘길 때 쓰는 요청문(계획 5-AIA). 위와 같은 범주다 —
  // 화면이 부르지만 결과는 에이전트에게 가는 글이라 카탈로그에 넣을 자리가 없다.
  "src/lib/projectAiaHandoff.ts",
  // 회차 점검표의 채점 규칙. 한국어 문자열은 전부 실패 사유이고 이 파일을 읽는 것은
  // DOM 이 아니라 scripts/project-menu-conformance.mjs 다.
  "src/lib/projectMenuConformance.ts",
]);
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);
/** 생성 파일. 소스의 `text(ko, en)` 짝을 그대로 옮겨 적은 것이라 다시 세면 같은 문구를 두 번 센다. */
const GENERATED_FILES = new Set(["src/lib/i18nGeneratedUiCatalog.ts"]);

function walkFiles(directory, result = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) walkFiles(fullPath, result);
    else if (SOURCE_EXTENSIONS.has(path.extname(entry.name)) && !entry.name.includes(".test.")) result.push(fullPath);
  }
  return result;
}

function literalText(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isJsxText(node)) return node.getText().trim();
  if (ts.isTemplateExpression(node)) {
    return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join("${…}");
  }
  return null;
}

function location(sourceFile, node) {
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `${path.relative(ROOT, sourceFile.fileName).split(path.sep).join("/")}:${line + 1}`;
}

function isTextArgument(node) {
  const call = node.parent;
  return ts.isCallExpression(call)
    && ts.isIdentifier(call.expression)
    && (call.expression.text === "text" || call.expression.text === "runtimeText")
    && (call.arguments[0] === node || call.arguments[1] === node);
}

function enclosingVariable(node, name) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) return current.name.text === name;
  }
  return false;
}

function isOutsideDomSink(node, relativePath) {
  const parent = node.parent;
  if (relativePath === "src/lib/webNotificationContent.ts") return true;
  if (ts.isJsxAttribute(parent) && parent.name.text === "alt") return true;
  for (let current = parent; current; current = current.parent) {
    if (ts.isBinaryExpression(current)
      && current.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && current.left.getText().includes("document.title")) return true;
    if (ts.isCallExpression(current)) {
      const callee = current.expression.getText();
      if (["showNativeNotification", "showNotification", "Notification"].some((name) => callee.endsWith(name))) return true;
    }
  }
  return false;
}

/**
 * 소스에 선언된 `text(ko, en)` 짝 전부. 화면을 방문해야만 채워지던 런타임 등록표
 * (`registerUiEnglish`)와 달리 소스를 읽어 거두므로, 아직 열지 않은 화면의 문구도 빠지지 않는다.
 * 감사와 같은 순회 규칙(리터럴 판정·`text` 호출 판정·프롬프트 제외)을 쓰는 것이 중요해 같은
 * 파일에 둔다 — 두 벌이 되면 한쪽만 늘어난 키가 카탈로그에서 조용히 빠진다.
 */
export function collectTextPairs(root = ROOT) {
  const pairs = new Map();
  for (const file of walkFiles(path.join(root, "src"))) {
    const relativePath = path.relative(root, file).split(path.sep).join("/");
    if (PROMPT_EXCLUSIONS.has(relativePath) || GENERATED_FILES.has(relativePath)) continue;
    const source = fs.readFileSync(file, "utf8");
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
        && (node.expression.text === "text" || node.expression.text === "runtimeText")) {
        const ko = node.arguments[0] ? literalText(node.arguments[0]) : null;
        const en = node.arguments[1] ? literalText(node.arguments[1]) : null;
        // 보간이 섞인 짝은 `${…}`로 뭉개져 원문과 다른 키가 되므로 싣지 않는다.
        if (ko !== null && en !== null && KOREAN.test(ko) && !ko.includes("${…}") && !en.includes("${…}")) {
          if (!pairs.has(ko)) pairs.set(ko, en);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return new Map([...pairs].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
}

export function auditStaticUi(root = ROOT) {
  const textKeys = new Set();
  const dictionaryKeys = new Set();
  const unwrapped = new Map();
  const outsideDom = [];
  const excluded = [];

  for (const file of walkFiles(path.join(root, "src"))) {
    // Windows 는 역슬래시를 돌려준다. 예외 목록은 슬래시로 적혀 있어 정규화하지 않으면 한 건도 걸리지 않는다.
    const relativePath = path.relative(root, file).split(path.sep).join("/");
    if (GENERATED_FILES.has(relativePath)) continue;
    const source = fs.readFileSync(file, "utf8");
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = (node) => {
      const value = literalText(node);
      if (value !== null && KOREAN.test(value)) {
        if (PROMPT_EXCLUSIONS.has(relativePath)) {
          excluded.push({ value, location: location(sourceFile, node) });
        } else if (isTextArgument(node)) {
          const call = node.parent;
          if (call.arguments[0] === node) textKeys.add(value);
        } else if (enclosingVariable(node, "STATIC_UI_EN") || enclosingVariable(node, "STATIC_UI_SOURCES")) {
          dictionaryKeys.add(value);
        } else {
          const positions = unwrapped.get(value) ?? [];
          positions.push(location(sourceFile, node));
          unwrapped.set(value, positions);
          if (isOutsideDomSink(node, relativePath)) outsideDom.push({ value, location: location(sourceFile, node) });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  const rustTrayPath = path.join(root, "src-tauri/src/lib.rs");
  const rustLines = fs.readFileSync(rustTrayPath, "utf8").split("\n");
  rustLines.forEach((line, index) => {
    if (line.includes("MenuItem::with_id") && KOREAN.test(line)) {
      const value = line.match(/"([^"]*[가-힣][^"]*)"/)?.[1] ?? line.trim();
      outsideDom.push({ value, location: `src-tauri/src/lib.rs:${index + 1}` });
    }
  });

  const catalogKeys = new Set([...textKeys, ...dictionaryKeys]);
  const missingCatalog = [...unwrapped.entries()]
    .filter(([value]) => !catalogKeys.has(value))
    .map(([value, locations]) => ({ value, locations }));
  return {
    counts: {
      unwrappedKorean: unwrapped.size,
      textKeys: textKeys.size,
      dictionaryKeys: dictionaryKeys.size,
      missingCatalog: missingCatalog.length,
      outsideDomSinks: outsideDom.length,
      excludedPromptLiterals: new Set(excluded.map(({ value }) => value)).size,
    },
    exclusions: [...PROMPT_EXCLUSIONS],
    missingCatalog,
    outsideDom,
  };
}

function printReport(report) {
  console.log("i18n static UI audit");
  for (const [name, value] of Object.entries(report.counts)) console.log(`${name}: ${value}`);
  console.log(`prompt exclusions: ${report.exclusions.join(", ")}`);
  if (report.outsideDom.length) {
    console.log("outside-DOM Korean sinks:");
    for (const item of report.outsideDom) console.log(`- ${item.location} ${JSON.stringify(item.value)}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const report = auditStaticUi();
  if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else printReport(report);
  // `unwrappedKorean` grows with the application even when every string is in
  // the catalog, so it is an observability metric rather than a release gate.
  // The baseline lists only actionable regressions: missing catalog entries
  // and Korean text that bypasses DOM localization sinks.
  const baseline = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/i18n-static-ui-baseline.json"), "utf8"));
  const regressions = Object.entries(baseline.maximums)
    .filter(([name, maximum]) => report.counts[name] > maximum)
    .map(([name, maximum]) => `${name}=${report.counts[name]} (maximum ${maximum})`);
  if (regressions.length) {
    console.error(`i18n audit regression: ${regressions.join(", ")}`);
    process.exitCode = 1;
  }
}
