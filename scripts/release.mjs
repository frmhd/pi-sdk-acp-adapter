#!/usr/bin/env node
/**
 * Release script for @frmhd/pi-sdk-acp-adapter
 *
 * Orchestrates:
 *   1. Code checks (lint, typecheck, tests)
 *   2. LLM-generated changelog entry (via pi CLI)
 *   3. Interactive version bump (bumpp)
 *   4. Git tag + push
 *   5. GitHub release description ready to paste
 *   6. Publish command suggestion (manual)
 *
 * Usage:
 *   node scripts/release.mjs                    # interactive: pick patch/minor/major
 *   node scripts/release.mjs --release patch      # non-interactive patch
 *   node scripts/release.mjs --release minor      # non-interactive minor
 *   node scripts/release.mjs --release major      # non-interactive major
 *   node scripts/release.mjs --model sonnet       # use specific pi model
 *   node scripts/release.mjs --dry-run --skip-checks
 *
 * Changelog generation requires the pi CLI to be installed and authenticated.
 * If pi is unavailable, the script falls back to a manual/agent prompt file.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const PACKAGE_NAME = "@frmhd/pi-sdk-acp-adapter";
const PROMPT_FILE = ".changelog-prompt.md";
const ENTRY_FILE = ".changelog-entry.md";
const CHANGELOG_FILE = "CHANGELOG.md";

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const skipChecks = args.includes("--skip-checks");
const skipBuild = args.includes("--skip-build");
const quiet = args.includes("--quiet");

const modelFlagIdx = args.indexOf("--model");
const piModel = modelFlagIdx !== -1 ? args[modelFlagIdx + 1] : undefined;

const releaseFlagIdx = args.indexOf("--release");
const releaseType = releaseFlagIdx !== -1 ? args[releaseFlagIdx + 1] : undefined;

function log(...xs) {
  if (!quiet) console.log(...xs);
}

function run(cmd, opts = {}) {
  if (dryRun) {
    log(`[dry-run] ${cmd}`);
    if (cmd.startsWith("git branch --show-current")) return "main";
    if (cmd.includes("git status --short")) return "";
    if (cmd.startsWith("git describe --tags")) return "v0.1.1";
    if (cmd.startsWith("git log")) return "a1b2c3d feat: example commit\ne4f5g6h fix: another fix";
    if (cmd.startsWith("git pull")) return "Already up to date.";
    if (cmd.startsWith("which pi")) return "/usr/bin/pi";
    if (cmd.startsWith("cat package.json")) return '{"version":"0.1.2"}';
    return "";
  }
  const result = execSync(cmd, { encoding: "utf-8", stdio: opts.stdio || "pipe", ...opts });
  return typeof result === "string" ? result.trim() : "";
}

function bail(msg) {
  console.error("\n  ❌ " + msg);
  process.exit(1);
}

function ok(msg) {
  log("  ✅ " + msg);
}

function bumpSemver(version, type) {
  const clean = version.replace(/^v/, "");
  const [major, minor, patch] = clean.split(".").map(Number);
  if (type === "major") return `${major + 1}.0.0`;
  if (type === "minor") return `${major}.${minor + 1}.0`;
  if (type === "patch") return `${major}.${minor}.${patch + 1}`;
  return clean;
}

function extractReleaseNotes(changelog, version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`##\\s*\\[${escaped}\\][^\\n]*\\n([\\s\\S]*?)(?=\\n##\\s*\\[|$)`);
  const match = changelog.match(pattern);
  return match ? match[1].trim() : "";
}

function todayIso() {
  return new Date().toISOString().split("T")[0];
}

// ---------------------------------------------------------------------------
// 1. Preflight checks
// ---------------------------------------------------------------------------
log("\n🔎 Preflight checks…");

const branch = run("git branch --show-current");
if (branch !== "main") {
  bail(`You are on "${branch}". Releases must be cut from main.`);
}
ok("On main branch");

const status = run("git status --short");
if (status) {
  bail("Working directory is not clean. Commit or stash changes first.\n\n" + status);
}
ok("Working directory clean");

run("git pull origin main --ff-only", { stdio: "inherit" });
ok("Pulled latest from origin/main");

// ---------------------------------------------------------------------------
// 2. Code checks
// ---------------------------------------------------------------------------
if (!skipChecks) {
  log("\n🧪 Running code checks…");
  run("vp check", { stdio: "inherit" });
  ok("vp check passed");

  run("vp test", { stdio: "inherit" });
  ok("vp test passed");
} else {
  log("\n⏭️  Skipping code checks (--skip-checks)");
}

// ---------------------------------------------------------------------------
// 3. Build
// ---------------------------------------------------------------------------
if (!skipBuild) {
  log("\n🔨 Building…");
  run("vp pack --dts", { stdio: "inherit" });
  ok("Build passed");
} else {
  log("\n⏭️  Skipping build (--skip-build)");
}

// ---------------------------------------------------------------------------
// 4. Gather commits since last tag
// ---------------------------------------------------------------------------
log("\n📜 Gathering commits since last tag…");

const lastTag = run("git describe --tags --abbrev=0 2>/dev/null || echo ''");
if (!lastTag) {
  bail("No previous git tag found. Create an initial tag (e.g. v0.0.0) first.");
}
ok(`Last tag: ${lastTag}`);

const commitRange = `${lastTag}..HEAD`;
const commits = run(`git log ${commitRange} --pretty=format:"%h %s"`);

if (!commits) {
  bail("No commits since last tag. Nothing to release.");
}
ok(`${commits.split("\n").length} commit(s) since ${lastTag}`);

// ---------------------------------------------------------------------------
// 5. Generate changelog entry
// ---------------------------------------------------------------------------
log("\n🤖 Generating changelog entry…");

const commitList = commits
  .split("\n")
  .map((c) => `- ${c}`)
  .join("\n");

const llmPrompt = `You are a release-note writer for an npm package called "${PACKAGE_NAME}".
Write a concise, human-friendly changelog entry for the upcoming release.

Commits since last release (${lastTag}):
${commitList}

Requirements:
- Group changes into exactly these sections (skip any that have no items):
  ### Breaking Changes
  ### New Features
  ### Bug Fixes
- Use Markdown bullet points under each section.
- Write for package consumers, not contributors (focus on behavioural changes).
- Keep each bullet concise but descriptive (one sentence).
- Do NOT include a version header, date, or introductory text.
- Do NOT wrap the response in code blocks.
- Output ONLY the section groups and their bullets, nothing else.
`;

let changelogEntry = "";

// Resume from a pre-saved entry file (useful when running in two passes)
if (existsSync(ENTRY_FILE)) {
  log(`  → Found existing ${ENTRY_FILE}, using it.`);
  changelogEntry = readFileSync(ENTRY_FILE, "utf-8").trim();
  if (!dryRun) {
    try {
      execSync(`rm -f ${ENTRY_FILE}`);
    } catch {}
  }
  ok("Loaded changelog entry from file");
}

// Generate via pi CLI — only if we don't already have an entry
if (!changelogEntry) {
  let hasPi = false;
  try {
    run("which pi");
    hasPi = true;
  } catch {
    hasPi = false;
  }

  if (hasPi) {
    log("  → Calling pi CLI…");
    let piCmd = `printf '%s' ${JSON.stringify(llmPrompt)} | pi -p --no-tools`;
    if (piModel) {
      piCmd += ` --model ${piModel}`;
      log(`     (model: ${piModel})`);
    } else {
      log("     (using pi's default model)");
    }

    try {
      if (dryRun) {
        log(`[dry-run] ${piCmd}`);
        changelogEntry =
          "### New Features\n\n- Added example feature for release dry-run\n\n### Bug Fixes\n\n- Fixed example bug in dry-run";
      } else {
        changelogEntry = execSync(piCmd, { encoding: "utf-8", shell: true }).trim();
      }
      ok("pi CLI responded");
    } catch (e) {
      log("  ⚠️  pi CLI failed:", e.message);
    }
  }
}

// Fallback: manual/agent mode when pi is unavailable or failed
if (!changelogEntry) {
  log("\n  ⚠️  pi CLI not available or failed.");
  log("     Prompt saved to:", PROMPT_FILE);
  writeFileSync(PROMPT_FILE, llmPrompt, "utf-8");

  if (process.stdin.isTTY) {
    log(
      "\n  ✏️  Please feed the prompt to your LLM and paste the generated changelog entry below.",
    );
    log("     (Press Ctrl+D when done)\n");
    const rl = createInterface({ input: process.stdin });
    const lines = [];
    for await (const line of rl) lines.push(line);
    changelogEntry = lines.join("\n").trim();
  } else {
    log(`\n  ✏️  Non-interactive terminal detected. Feed \`${PROMPT_FILE}\` to your LLM,`);
    log(`     save the result to \`${ENTRY_FILE}\`, then re-run this script.\n`);
    process.exit(0);
  }
}

if (!changelogEntry) {
  bail("Changelog entry is empty. Aborting.");
}

// ---------------------------------------------------------------------------
// 6. Compute version & write CHANGELOG.md
// ---------------------------------------------------------------------------
const currentVersion = JSON.parse(readFileSync("package.json", "utf-8")).version;
const nextVersion = releaseType ? bumpSemver(currentVersion, releaseType) : null;

log("\n📝 Updating CHANGELOG.md…");

let changelogBody = "";
if (existsSync(CHANGELOG_FILE)) {
  changelogBody = readFileSync(CHANGELOG_FILE, "utf-8");
} else {
  changelogBody =
    "# Changelog\n\nAll notable changes to this project will be documented in this file.\n\nThe format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).\n\n";
}

if (nextVersion) {
  // Non-interactive path: we know the version, write a versioned header
  const versionHeader = `## [${nextVersion}] - ${todayIso()}`;
  const unreleasedHeader = "## [Unreleased]";

  if (!changelogBody.includes(unreleasedHeader)) {
    changelogBody += `\n${unreleasedHeader}\n\n`;
  }

  const entryText = `\n${changelogEntry}\n`;
  changelogBody = changelogBody.replace(
    unreleasedHeader,
    `${versionHeader}\n${entryText}\n${unreleasedHeader}`,
  );
} else {
  // Interactive path: write under Unreleased; we'll version it after bumpp
  if (!changelogBody.includes("## [Unreleased]")) {
    changelogBody += "\n## [Unreleased]\n\n";
  }
  const entryText = `\n${changelogEntry}\n`;
  changelogBody = changelogBody.replace("## [Unreleased]", "## [Unreleased]" + entryText);
}

if (dryRun) {
  log("[dry-run] Would write to", CHANGELOG_FILE);
  log("---\n" + changelogEntry + "\n---");
} else {
  writeFileSync(CHANGELOG_FILE, changelogBody, "utf-8");
  ok("CHANGELOG.md updated");
}

// ---------------------------------------------------------------------------
// 7. Commit changelog
// ---------------------------------------------------------------------------
if (!dryRun) {
  run("git add CHANGELOG.md");
  run('git commit -m "chore: update changelog"');
  ok("Committed CHANGELOG.md");
} else {
  log('[dry-run] git add CHANGELOG.md && git commit -m "chore: update changelog"');
}

// ---------------------------------------------------------------------------
// 8. Bump version (bumpp)
// ---------------------------------------------------------------------------
log("\n🔢 Bumping version…");
if (dryRun) {
  if (releaseType) {
    log(`[dry-run] Would run: npx bumpp --release ${releaseType} --no-push`);
  } else {
    log("[dry-run] Would run: npx bumpp --no-push");
    log("             (interactive: choose patch / minor / major)");
  }
} else {
  if (releaseType) {
    run(`npx bumpp --release ${releaseType} --no-push`, { stdio: "inherit" });
  } else {
    run("npx bumpp --no-push", { stdio: "inherit" });
  }
  ok("Version bumped & tagged");
}

// ---------------------------------------------------------------------------
// 9. Post-bumpp: version the changelog header & amend commit (interactive only)
// ---------------------------------------------------------------------------
if (!nextVersion && !dryRun) {
  const bumpedVersion = JSON.parse(readFileSync("package.json", "utf-8")).version;
  log(`\n📝 Versioning changelog header for v${bumpedVersion}…`);

  changelogBody = readFileSync(CHANGELOG_FILE, "utf-8");
  const unreleasedHeader = "## [Unreleased]";
  const versionHeader = `## [${bumpedVersion}] - ${todayIso()}`;

  if (changelogBody.includes(unreleasedHeader)) {
    changelogBody = changelogBody.replace(
      unreleasedHeader,
      `${versionHeader}\n\n${unreleasedHeader}`,
    );
    writeFileSync(CHANGELOG_FILE, changelogBody, "utf-8");

    run("git add CHANGELOG.md");
    run("git commit --amend --no-edit");
    run(`git tag -d v${bumpedVersion}`);
    run(`git tag v${bumpedVersion}`);
    ok(`Amended commit & retagged v${bumpedVersion}`);
  }
}

// ---------------------------------------------------------------------------
// 10. Push commits + tags
// ---------------------------------------------------------------------------
log("\n🚀 Pushing to origin…");
if (dryRun) {
  log("[dry-run] git push origin main --follow-tags");
} else {
  run("git push origin main --follow-tags", { stdio: "inherit" });
  ok("Pushed commits and tags");
}

// ---------------------------------------------------------------------------
// 11. Prepare release notes & suggestions
// ---------------------------------------------------------------------------
const finalVersion = dryRun
  ? nextVersion || "<version>"
  : JSON.parse(readFileSync("package.json", "utf-8")).version;

const finalChangelog = dryRun
  ? `## [${finalVersion}] - ${todayIso()}\n\n${changelogEntry}\n\n## [Unreleased]`
  : readFileSync(CHANGELOG_FILE, "utf-8");

const releaseNotes = extractReleaseNotes(finalChangelog, finalVersion);

log("\n──────────────────────────────────────────────");
log("📦  Release ready!");
log("──────────────────────────────────────────────");
log(`   Version : v${finalVersion}`);
log(`   Tag     : v${finalVersion}`);
log(`   Branch  : main (pushed)`);

if (releaseNotes) {
  log("\n   Release notes for GitHub:");
  log("   ─────────────────────────────");
  log(
    releaseNotes
      .split("\n")
      .map((l) => "   " + l)
      .join("\n"),
  );
  log("   ─────────────────────────────");
}

log("\n👉  Next steps:");
log(`   1. Publish to npm:`);
log(`      npm publish --access public`);
log(`\n   2. Create GitHub release:`);
if (releaseNotes) {
  const notesFile = ".github-release-notes.md";
  if (!dryRun) writeFileSync(notesFile, releaseNotes, "utf-8");
  log(
    `      gh release create v${finalVersion} --title "v${finalVersion}" --notes-file ${notesFile}`,
  );
  log(`      (review ${notesFile} then run the command above)`);
} else {
  log(`      gh release create v${finalVersion} --generate-notes`);
}

log("──────────────────────────────────────────────\n");
