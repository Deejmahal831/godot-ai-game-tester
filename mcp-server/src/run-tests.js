#!/usr/bin/env node
// CLI test runner for Godot game suites. CI-friendly: prints a readable report,
// writes JSON + JUnit XML, and exits non-zero if any test failed.
//
// Usage:
//   node src/run-tests.js <suite.json> [--artifacts <dir>] [--json <file>] [--junit <file>] [--godot <path>]
//   GODOT_PATH env var is honored if --godot is omitted.
import fs from "node:fs";
import path from "node:path";
import { runSuiteFile, toJUnitXml } from "./runner.js";

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--artifacts") args.artifacts = argv[++i];
    else if (a === "--json") args.json = argv[++i];
    else if (a === "--junit") args.junit = argv[++i];
    else if (a === "--godot") args.godot = argv[++i];
    else args._.push(a);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (!args._[0]) {
  console.error("Usage: node src/run-tests.js <suite.json> [--artifacts dir] [--json file] [--junit file] [--godot path]");
  process.exit(2);
}

const suitePath = args._[0];
const artifactsDir = args.artifacts || path.join(path.dirname(path.resolve(suitePath)), "test-artifacts");

const C = { dim: "\x1b[2m", red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", bold: "\x1b[1m", reset: "\x1b[0m" };
const onEvent = (e) => {
  if (e.type === "test_start") console.log(`\n${C.bold}▶ ${e.name}${C.reset}`);
  else if (e.type === "assert_pass") console.log(`  ${C.green}✓${C.reset} ${e.desc}`);
  else if (e.type === "assert_fail") console.log(`  ${C.red}✗ ${e.desc}${C.reset}  ${C.dim}(got ${JSON.stringify(e.got)})${C.reset}`);
  else if (e.type === "test_error") console.log(`  ${C.red}✗ ERROR: ${e.error}${C.reset}`);
  else if (e.type === "comment") console.log(`  ${C.dim}# ${e.text}${C.reset}`);
};

try {
  const result = await runSuiteFile(suitePath, { godotPath: args.godot, artifactsDir, onEvent });

  console.log(`\n${C.bold}${result.name}${C.reset}`);
  for (const t of result.tests) {
    const mark = t.ok ? `${C.green}PASS${C.reset}` : `${C.red}FAIL${C.reset}`;
    console.log(`  ${mark}  ${t.name}${t.artifacts.length ? `  ${C.dim}[${t.artifacts.length} artifact(s)]${C.reset}` : ""}`);
  }
  const color = result.failed ? C.red : C.green;
  console.log(`\n${color}${C.bold}${result.passed}/${result.total} passed${C.reset} in ${result.duration_seconds}s`);
  if (result.failed) console.log(`${C.dim}Failure screenshots in ${result.artifacts_dir}${C.reset}`);

  if (args.json) {
    fs.writeFileSync(args.json, JSON.stringify(result, null, 2));
    console.log(`${C.dim}JSON report: ${args.json}${C.reset}`);
  }
  if (args.junit) {
    fs.writeFileSync(args.junit, toJUnitXml(result));
    console.log(`${C.dim}JUnit XML: ${args.junit}${C.reset}`);
  }

  process.exit(result.failed ? 1 : 0);
} catch (e) {
  console.error(`${C.red}Runner error: ${e.message}${C.reset}`);
  process.exit(2);
}
