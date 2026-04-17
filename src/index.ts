import "dotenv/config";
import { readFileSync, existsSync } from "fs";
import { resolve, extname } from "path";
import { checkbox } from "@inquirer/prompts";
import chalk from "chalk";
import { reviewCode, type Severity, type CodeIssue } from "./reviewer.js";
import { applyFix, backupFile } from "./applier.js";
import { browseAndSelectFile } from "./browser.js";
import { saveReport } from "./reporter.js";

// ── Config ────────────────────────────────────────────────────────────────────

type ChalkFn = (text: string) => string;
const SEVERITY_COLOR: Record<Severity, ChalkFn> = {
  error: chalk.red,
  warning: chalk.yellow,
  suggestion: chalk.cyan,
};

const SEVERITY_ICON: Record<Severity, string> = {
  error: "✖",
  warning: "⚠",
  suggestion: "◆",
};

const CATEGORY_TAG: Record<string, string> = {
  bug: chalk.bgRed.white(" bug "),
  security: chalk.bgMagenta.white(" security "),
  performance: chalk.bgBlue.white(" perf "),
  style: chalk.bgGray.white(" style "),
  readability: chalk.bgGray.white(" readability "),
};

function scoreColor(n: number): ChalkFn {
  if (n >= 8) return chalk.green;
  if (n >= 5) return chalk.yellow;
  return chalk.red;
}

// ── Parse args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes("--help")) {
  console.log(`
${chalk.bold.cyan("ai-code-reviewer")} — AI auto-reviewer for junior developers

${chalk.bold("Usage:")}
  npm run review                            Interactive project browser
  npm run review -- <file> [options]        Review a specific file

${chalk.bold("Options:")}
  --model <name>   GitHub Models model to use  (default: gpt-4o-mini)
  --dry-run        Show what would be changed without writing to disk
  --report         Save a visual HTML report alongside the file
  --help           Show this help message

${chalk.bold("Examples:")}
  npm run review
  npm run review -- src/app.ts
  npm run review -- utils.py --model gpt-4o
  npm run review -- index.js --dry-run --report
`);
  process.exit(0);
}

const modelIdx = args.indexOf("--model");
const model = modelIdx !== -1 && args[modelIdx + 1] ? args[modelIdx + 1] : "gpt-4o-mini";
const dryRun = args.includes("--dry-run");
const withReport = args.includes("--report");

// Resolve file: explicit arg, or interactive browser if none given
const firstArg = args[0];
let filePath: string;

if (!firstArg || firstArg.startsWith("--")) {
  console.log(`\n${chalk.bold.cyan("AI Code Reviewer")} ${chalk.dim("— interactive mode")}\n`);
  try {
    filePath = await browseAndSelectFile();
  } catch (err) {
    console.error(chalk.red(`\n  ${err instanceof Error ? err.message : String(err)}\n`));
    process.exit(1);
  }
} else {
  filePath = resolve(firstArg);
  if (!existsSync(filePath)) {
    console.error(chalk.red(`\n  File not found: ${filePath}\n`));
    process.exit(1);
  }
}

// ── Run ───────────────────────────────────────────────────────────────────────

const code = readFileSync(filePath, "utf-8");
const language = extname(filePath).replace(".", "") || "code";
const divider = chalk.dim("─".repeat(64));

console.log(`
${divider}
  ${chalk.bold.cyan("AI Code Reviewer")} ${chalk.dim("for junior devs")}
  File  : ${chalk.white(filePath)}
  Model : ${chalk.white(model)}${dryRun ? chalk.yellow("  [dry run]") : ""}
${divider}
`);

let review;
try {
  process.stdout.write(chalk.dim("  Analyzing code …\n\n"));
  review = await reviewCode(code, language, model);
} catch (err) {
  console.error(chalk.red(`\n  Error: ${err instanceof Error ? err.message : String(err)}\n`));
  process.exit(1);
}

// ── Display summary ───────────────────────────────────────────────────────────

const scoreStr = scoreColor(review.score)(`${review.score}/10`);
console.log(`  ${chalk.bold("Summary:")} ${review.summary}`);
console.log(`  ${chalk.bold("Score:  ")} ${scoreStr}`);
console.log(`\n${divider}\n`);

if (!review.issues || review.issues.length === 0) {
  console.log(chalk.green("  ✓ No issues found. Clean code!\n"));
  process.exit(0);
}

// ── Display issues ────────────────────────────────────────────────────────────

interface ApplicableIssue {
  index: number;
  issue: CodeIssue;
}

const applicable: ApplicableIssue[] = [];

review.issues.forEach((issue: CodeIssue, i: number) => {
  const color = SEVERITY_COLOR[issue.severity] ?? chalk.white;
  const icon = SEVERITY_ICON[issue.severity] ?? "•";
  const tag = CATEGORY_TAG[issue.category] ?? chalk.bgGray.white(` ${issue.category} `);
  const lineRef = issue.line ? chalk.dim(` · line ${issue.line}`) : "";
  const canApply = !!(issue.originalCode && issue.fixedCode);
  const applyBadge = canApply ? chalk.green(" [auto-fix available]") : "";

  console.log(
    `  ${chalk.dim(`[${i + 1}]`)} ${color(icon)} ${chalk.bold(issue.title)}${lineRef}`
  );
  console.log(`       ${tag}${applyBadge}`);
  console.log(`       ${issue.description}`);

  if (canApply && issue.originalCode && issue.fixedCode) {
    const beforeLine = issue.originalCode.split("\n")[0];
    const afterLine = issue.fixedCode.split("\n")[0];
    const hasMore = (s: string) => (s.includes("\n") ? chalk.dim(" …") : "");
    console.log(
      `       ${chalk.dim("Before:")} ${chalk.red(beforeLine)}${hasMore(issue.originalCode)}`
    );
    console.log(
      `       ${chalk.dim("After: ")} ${chalk.green(afterLine)}${hasMore(issue.fixedCode)}`
    );
    applicable.push({ index: i, issue });
  }

  console.log();
});

console.log(divider);

// ── HTML Report ───────────────────────────────────────────────────────────────

if (withReport) {
  try {
    const reportPath = saveReport(filePath, review, model);
    console.log(chalk.dim(`\n  HTML report saved → ${chalk.white(reportPath)}`));
    console.log(chalk.dim(`  Open: start "${reportPath}"\n`));
  } catch (err) {
    console.warn(chalk.yellow(`  Warning: could not save report — ${err instanceof Error ? err.message : String(err)}`));
  }
}

// ── Interactive fix selection ─────────────────────────────────────────────────

if (applicable.length === 0) {
  console.log(chalk.dim("\n  No auto-applicable fixes for this file.\n"));
  process.exit(0);
}

const choices = applicable.map(({ index, issue }) => ({
  name: `[${index + 1}] ${SEVERITY_ICON[issue.severity] ?? "•"} ${issue.title}`,
  value: index,
  checked: issue.severity === "error",
}));

console.log();
let selected: number[];
try {
  selected = await checkbox({
    message: "Select fixes to apply automatically (Space to toggle, Enter to confirm):",
    choices,
    pageSize: 12,
  });
} catch {
  console.log(chalk.dim("\n  Cancelled.\n"));
  process.exit(0);
}

if (selected.length === 0) {
  console.log(chalk.dim("\n  No fixes selected. Exiting.\n"));
  process.exit(0);
}

// ── Apply fixes ───────────────────────────────────────────────────────────────

if (!dryRun) {
  backupFile(filePath);
  console.log(chalk.dim(`\n  Backup saved → ${filePath}.bak`));
}

console.log();
let applied = 0;
let failed = 0;

for (const idx of selected) {
  const issue = review.issues[idx];
  if (!issue.originalCode || !issue.fixedCode) continue;

  const result = applyFix(filePath, issue.originalCode, issue.fixedCode, dryRun);

  if (result.success) {
    const label = dryRun ? chalk.dim(" (dry run — not written)") : "";
    console.log(`  ${chalk.green("✓")} ${issue.title}${label}`);
    applied++;
  } else {
    console.log(`  ${chalk.red("✗")} ${issue.title}`);
    console.log(`    ${chalk.dim(result.reason)}`);
    failed++;
  }
}

console.log();
if (dryRun) {
  console.log(chalk.cyan(`  Dry run complete. ${applied} fix(es) would be applied.\n`));
} else {
  const ok = applied > 0 ? chalk.green(`${applied} fix(es) applied`) : "";
  const bad = failed > 0 ? chalk.yellow(` · ${failed} skipped`) : "";
  console.log(`  ${ok}${bad}\n`);
}
