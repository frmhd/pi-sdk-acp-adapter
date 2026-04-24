#!/usr/bin/env node
/**
 * Release script for @frmhd/pi-sdk-acp-adapter
 *
 * Orchestrates:
 *   1. Code checks (lint, typecheck, tests)
 *   2. LLM-generated changelog entry (via pi CLI)
 *   3. Interactive approval of changelog
 *   4. Interactive version bump (bumpp)
 *   5. Git tag + push
 *   6. GitHub release with notes from changelog
 *   7. Publish command suggestion (manual)
 *
 * Usage:
 *   node scripts/release.mjs                    # interactive: pick patch/minor/major
 *   node scripts/release.mjs --release patch      # non-interactive patch
 *   node scripts/release.mjs --release minor      # non-interactive minor
 *   node scripts/release.mjs --release major      # non-interactive major
 *   node scripts/release.mjs --model sonnet       # use specific pi model
 *   node scripts/release.mjs --dry-run --skip-checks
 *   node scripts/release.mjs --yes               # auto-approve changelog
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
const yes = args.includes("--yes") || args.includes("-y");

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
// Changelog parse / stringify (robust — avoids brittle regex replacements)
// ---------------------------------------------------------------------------
function parseChangelog(text) {
  const sectionMatch = text.match(/## \[/);
  const preamble = sectionMatch ? text.slice(0, sectionMatch.index).trimEnd() : text.trimEnd();

  const sections = [];
  const headerRe = /^## \[([^\]]+)\](?: - ([\d-]+))? *\n/gm;

  let lastIndex = -1;
  let lastTitle;
  let lastDate;
  let m;

  while ((m = headerRe.exec(text)) !== null) {
    if (lastIndex !== -1) {
      sections.push({
        title: lastTitle,
        date: lastDate,
        content: text.slice(lastIndex, m.index).trim(),
      });
    }
    lastIndex = headerRe.lastIndex;
    lastTitle = m[1];
    lastDate = m[2] || "";
  }

  if (lastIndex !== -1) {
    sections.push({
      title: lastTitle,
      date: lastDate,
      content: text.slice(lastIndex).trim(),
    });
  }

  return { preamble, sections };
}

function stringifyChangelog({ preamble, sections }) {
  let out = preamble + "\n\n";
  for (const s of sections) {
    const header = s.date ? `## [${s.title}] - ${s.date}` : `## [${s.title}]`;
    out += `${header}\n\n${s.content ? s.content + "\n\n" : ""}`;
  }
  return out.trimEnd() + "\n";
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
const originalChangelog = changelogBody;

let { preamble, sections } = parseChangelog(changelogBody);

let unreleased = sections.find((s) => s.title === "Unreleased");
if (!unreleased) {
  unreleased = { title: "Unreleased", date: "", content: "" };
  sections.unshift(unreleased);
} else {
  // Ensure [Unreleased] is always the first section (Keep a Changelog format)
  sections = sections.filter((s) => s.title !== "Unreleased");
  sections.unshift(unreleased);
}

const sep = unreleased.content.trim() ? "\n\n" : "";
unreleased.content = unreleased.content + sep + changelogEntry.trim();

changelogBody = stringifyChangelog({ preamble, sections });

if (dryRun) {
  log("[dry-run] Would write to", CHANGELOG_FILE);
  log("---\n" + changelogEntry + "\n---");
} else {
  writeFileSync(CHANGELOG_FILE, changelogBody, "utf-8");
  ok("CHANGELOG.md updated");
}

// ---------------------------------------------------------------------------
// 7. Approval
// ---------------------------------------------------------------------------
const skipApproval = yes || !!releaseType;

if (!skipApproval) {
  if (!process.stdin.isTTY) {
    bail("Non-interactive terminal detected. Use --yes or --release to skip approval.");
  }

  log("\n📝 Proposed changelog entry:");
  log("─────────────────────────────");
  log(changelogEntry);
  log("─────────────────────────────");

  const answer = await new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question("Approve and continue? [Y/n] ", (ans) => {
      rl.close();
      resolve(ans.trim().toLowerCase());
    });
  });

  if (answer && answer !== "y" && answer !== "yes") {
    log("\n❌ Aborted. Restoring CHANGELOG.md…");
    writeFileSync(CHANGELOG_FILE, originalChangelog, "utf-8");
    process.exit(1);
  }
  ok("Approved");
} else {
  log("\n⏭️  Skipping approval (non-interactive / --yes)");
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
// 9. Version the changelog header & amend commit
// ---------------------------------------------------------------------------
const bumpedVersion = dryRun
  ? nextVersion || "<version>"
  : JSON.parse(readFileSync("package.json", "utf-8")).version;

if (!dryRun) {
  log(`\n📝 Versioning changelog header for v${bumpedVersion}…`);

  changelogBody = readFileSync(CHANGELOG_FILE, "utf-8");
  let { preamble, sections } = parseChangelog(changelogBody);

  const unreleasedIdx = sections.findIndex((s) => s.title === "Unreleased");
  if (unreleasedIdx !== -1) {
    const unreleased = sections[unreleasedIdx];

    const versionSection = {
      title: bumpedVersion,
      date: todayIso(),
      content: unreleased.content,
    };

    // Move unreleased content into the new version section and clear [Unreleased]
    unreleased.content = "";

    // Insert the new version right after [Unreleased] (descending order)
    sections.splice(unreleasedIdx + 1, 0, versionSection);

    writeFileSync(CHANGELOG_FILE, stringifyChangelog({ preamble, sections }), "utf-8");

    run("git add CHANGELOG.md");
    run("git commit --amend --no-edit");
    run(`git tag -d v${bumpedVersion}`);
    run(`git tag v${bumpedVersion}`);
    ok(`Amended commit & retagged v${bumpedVersion}`);
  }
}

// ---------------------------------------------------------------------------
// 10. Push commits + tag
// ---------------------------------------------------------------------------
log("\n🚀 Pushing to origin…");
if (dryRun) {
  log("[dry-run] git push origin main");
  log(`[dry-run] git push origin v${bumpedVersion}`);
} else {
  run("git push origin main", { stdio: "inherit" });
  run(`git push origin v${bumpedVersion}`, { stdio: "inherit" });
  ok("Pushed commits and tag");
}

// ---------------------------------------------------------------------------
// 11. Create GitHub release
// ---------------------------------------------------------------------------
const finalVersion = bumpedVersion;

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
  log("\n   Release notes:");
  log("   ─────────────────────────────");
  log(
    releaseNotes
      .split("\n")
      .map((l) => "   " + l)
      .join("\n"),
  );
  log("   ─────────────────────────────");
}

if (!dryRun) {
  let hasGh = false;
  try {
    run("which gh");
    hasGh = true;
  } catch {
    hasGh = false;
  }

  if (hasGh && releaseNotes) {
    const notesFile = `.github-release-notes-v${finalVersion}.md`;
    writeFileSync(notesFile, releaseNotes, "utf-8");
    log("\n🚀 Creating GitHub release…");
    run(`gh release create v${finalVersion} --title "v${finalVersion}" --notes-file ${notesFile}`, {
      stdio: "inherit",
    });
    try {
      execSync(`rm -f ${notesFile}`);
    } catch {}
    ok("GitHub release created");
  } else if (hasGh) {
    log("\n🚀 Creating GitHub release (auto-generated notes)…");
    run(`gh release create v${finalVersion} --title "v${finalVersion}" --generate-notes`, {
      stdio: "inherit",
    });
    ok("GitHub release created");
  } else {
    log("\n⚠️  gh CLI not found. Create the release manually:");
    const notesFile = `.github-release-notes-v${finalVersion}.md`;
    writeFileSync(notesFile, releaseNotes, "utf-8");
    log(
      `   gh release create v${finalVersion} --title "v${finalVersion}" --notes-file ${notesFile}`,
    );
  }
} else {
  log("\n[dry-run] Would create GitHub release with notes:");
  log(releaseNotes || "(no notes extracted)");
}

log("\n👉  Next step: publish to npm:");
log(`      npm publish --access public`);

log("──────────────────────────────────────────────\n");
