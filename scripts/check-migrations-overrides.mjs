#!/usr/bin/env node
/**
 * Migrations-image override drift gate.
 *
 * WHY THIS EXISTS
 * ---------------
 * On 2026-09-06 a security fix merged to main and then silently never
 * shipped. PR #636 patched mysql2 (GHSA-3f6p-5ww8-9rcr) via the root
 * package.json `overrides`. Every gate went green and the PR merged — but
 * `apps/api/Dockerfile.migrations` SYNTHESIZES its own package.json and
 * installs it with `npm install`, NOT `npm ci` against the monorepo
 * lockfile. So the root overrides never reached that image, prisma pulled
 * the vulnerable mysql2 back in, Trivy failed on it, and because the deploy
 * gate is fail-closed, migrate/deploy/smoke were all SKIPPED.
 *
 * The result is the worst shape a failure can take: main claimed the
 * advisory was patched, CI was green, and production kept serving an
 * eleven-day-old build. Nobody would have noticed from the PR view.
 *
 * WHAT THIS DOES
 * --------------
 * Resolves the migrations manifest's real dependency tree, then asserts:
 * for every package in that tree which the ROOT overrides pin, the
 * migrations manifest pins it too, at a floor no lower than the root's.
 *
 * It deliberately does NOT require the two override lists to be identical.
 * The root pins plenty the migrations image never installs (postcss, uuid,
 * tmp...), and demanding a copy of those would be noise that teaches people
 * to ignore the gate. Only overlap is enforced.
 *
 * Usage:  node scripts/check-migrations-overrides.mjs
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOCKERFILE = join(REPO_ROOT, 'apps/api/Dockerfile.migrations');

/**
 * Pull the synthesized manifest back out of the Dockerfile.
 *
 * It is written as a single `RUN echo '{ ... }' > package.json` with
 * backslash line continuations, so the continuations have to be joined the
 * same way the Dockerfile parser joins them before the JSON will parse.
 */
function extractSynthesizedManifest(dockerfile) {
  const text = readFileSync(dockerfile, 'utf8').replace(/\r\n/g, '\n');
  const start = text.indexOf("RUN echo '{");
  if (start === -1) {
    fail(
      `Could not find the synthesized manifest in ${dockerfile}.\n` +
        `Expected a line starting with: RUN echo '{\n` +
        `If the image stopped synthesizing its own package.json (e.g. it now uses\n` +
        `npm ci against the root lockfile), this gate is obsolete — delete it.`,
    );
  }
  const end = text.indexOf("' > package.json", start);
  if (end === -1) fail(`Found "RUN echo '{" but no closing "' > package.json" in ${dockerfile}.`);

  const raw = text
    .slice(start + "RUN echo '".length, end)
    .replace(/\\\n/g, '') // join Dockerfile line continuations
    .trim();

  try {
    return JSON.parse(raw);
  } catch (err) {
    fail(`The synthesized manifest in ${dockerfile} is not valid JSON: ${err.message}\n\n${raw}`);
  }
}

/** Lowest version a semver range admits — enough to compare two pins. */
function floorOf(range) {
  const m = String(range).match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function lower(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

function fail(msg) {
  console.error(`\n${msg}\n`);
  process.exit(1);
}

// ── the two manifests ──────────────────────────────────────────────────────
const rootOverrides = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).overrides ?? {};
const migManifest = extractSynthesizedManifest(DOCKERFILE);
const migOverrides = migManifest.overrides ?? {};

// ── what does the migrations image actually install? ───────────────────────
// Resolve rather than guess: an override only matters if the package is in
// the tree. This is the difference between a gate that reflects reality and
// one that enforces a list somebody has to remember to curate.
const work = mkdtempSync(join(tmpdir(), 'migoverrides-'));
let installed;
try {
  writeFileSync(join(work, 'package.json'), JSON.stringify(migManifest, null, 2));
  // npm is a .cmd shim on Windows, which execFileSync cannot spawn directly
  // (ENOENT, then EINVAL) without a shell. Args here are all hardcoded, so
  // the usual shell-injection concern does not apply. CI runs Linux; this
  // branch only exists so the gate is runnable locally too.
  const isWin = process.platform === 'win32';
  execFileSync(isWin ? 'npm.cmd' : 'npm', ['install', '--package-lock-only', '--ignore-scripts'], {
    cwd: work,
    stdio: 'pipe',
    shell: isWin,
  });
  const lock = JSON.parse(readFileSync(join(work, 'package-lock.json'), 'utf8'));
  installed = new Set(
    Object.keys(lock.packages ?? {})
      .filter(Boolean)
      .map((k) => k.split('node_modules/').pop()),
  );
} catch (err) {
  fail(`Could not resolve the migrations manifest: ${err.message}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

// ── the assertion ──────────────────────────────────────────────────────────
const problems = [];
for (const [pkg, rootRange] of Object.entries(rootOverrides)) {
  if (!installed.has(pkg)) continue; // not in this image — nothing to enforce

  const migRange = migOverrides[pkg];
  if (!migRange) {
    problems.push(
      `  ${pkg}: root pins "${rootRange}", migrations image pins NOTHING\n` +
        `      -> the image installs ${pkg} but will resolve it freely`,
    );
    continue;
  }
  const rootFloor = floorOf(rootRange);
  const migFloor = floorOf(migRange);
  if (rootFloor && migFloor && lower(migFloor, rootFloor)) {
    problems.push(`  ${pkg}: root pins "${rootRange}" but migrations image pins "${migRange}" (lower)`);
  }
}

// ── the prisma pin ─────────────────────────────────────────────────────────
// Second way these two files drift. Dockerfile.migrations hardcodes the prisma
// CLI version, and its own comment says it MUST match apps/api because the
// engine bundled in the CLI has to match the schema the client was generated
// against. Nothing enforced that, and a Dependabot bump only ever touches
// package.json — #639 proposes prisma 7.10.0 and would have left the image
// running the 7.9.1 CLI against a 7.10.0 schema.
//
// Checked here rather than in a new script because it is the same failure:
// a value duplicated between the manifest and the image, with only a comment
// holding them together.
const apiPkg = JSON.parse(readFileSync(join(REPO_ROOT, 'apps/api/package.json'), 'utf8'));
const apiPrisma = (apiPkg.devDependencies ?? {}).prisma;
const apiClient = (apiPkg.dependencies ?? {})['@prisma/client'];
const migPrisma = (migManifest.dependencies ?? {}).prisma;

if (apiPrisma && migPrisma && apiPrisma !== migPrisma) {
  problems.push(
    `  prisma: apps/api devDependencies pins "${apiPrisma}" but the migrations image pins "${migPrisma}"\n` +
      `      -> the migration CLI and the generated client would disagree on the engine`,
  );
}
if (apiPrisma && apiClient && apiPrisma !== apiClient) {
  problems.push(
    `  prisma: apps/api devDependencies pins "${apiPrisma}" but @prisma/client is "${apiClient}"\n` +
      `      -> CLI and client must be the same version`,
  );
}

const checked = Object.keys(rootOverrides).filter((p) => installed.has(p));
console.log(`=== migrations-image override drift ===`);
console.log(`    root overrides:       ${Object.keys(rootOverrides).length}`);
console.log(`    migrations overrides: ${Object.keys(migOverrides).length}`);
console.log(`    packages in BOTH the root overrides and the migrations tree: ${checked.length}`);
if (checked.length) console.log(`      ${checked.join(', ')}`);
console.log(`    prisma pin: apps/api=${apiPrisma} client=${apiClient} migrations-image=${migPrisma}`);

if (problems.length) {
  const hasOverrideDrift = problems.some((p) => p.includes('pins NOTHING') || p.includes('(lower)'));
  const hasPrismaDrift = problems.some((p) => p.trimStart().startsWith('prisma:'));

  let why = `\n\nWHY THIS BLOCKS THE MERGE\n`;
  if (hasOverrideDrift) {
    why +=
      `Dockerfile.migrations synthesizes its own package.json and runs\n` +
      `\`npm install\`, not \`npm ci\` against the monorepo lockfile — so the root\n` +
      `\`overrides\` do NOT apply to that image. A transitive CVE patched at the\n` +
      `repo root has to be repeated in the Dockerfile's own overrides block, or\n` +
      `Trivy fails on the migrations image and the deploy gate SKIPS\n` +
      `migrate/deploy/smoke. The PR merges, CI is green, and production silently\n` +
      `never updates. That is exactly what happened on 2026-09-06.\n` +
      `  FIX: add the pins above to the \`overrides\` block in\n` +
      `       apps/api/Dockerfile.migrations.\n`;
  }
  if (hasPrismaDrift) {
    why +=
      `The prisma CLI version is duplicated between apps/api/package.json and\n` +
      `the manifest synthesized in Dockerfile.migrations, and only a comment held\n` +
      `them together. They must match: the engine bundled in the CLI has to match\n` +
      `the schema the client was generated against. A dependency bump only ever\n` +
      `edits package.json, so the image silently keeps running the old CLI.\n` +
      `  FIX: bump \`"prisma":"…"\` in apps/api/Dockerfile.migrations to the same\n` +
      `       version, in the SAME pull request.\n`;
  }

  fail(`Drift between the root/apps/api manifests and ${DOCKERFILE}:\n\n` + problems.join('\n') + why);
}

console.log(`\n✅ No override drift: every root pin that the migrations image installs is pinned there too.`);
