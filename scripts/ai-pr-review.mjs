import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const env = process.env;
const repo = required("REPO");
const prNumber = required("PR_NUMBER");
const baseSha = required("BASE_SHA");
const headSha = required("HEAD_SHA");
const token = required("GITHUB_TOKEN");
const model = env.AI_REVIEW_MODEL || "openai/gpt-4.1";
const maxFindings = Number(env.AI_REVIEW_MAX_FINDINGS || 12);
const minSeverity = env.AI_REVIEW_MIN_SEVERITY || "low";
const failOn = new Set((env.AI_REVIEW_FAIL_ON || "critical").split(",").map((s) => s.trim()).filter(Boolean));
const maxDiffChars = Number(env.AI_REVIEW_MAX_DIFF_CHARS || 12000);
const maxContextChars = Number(env.AI_REVIEW_MAX_CONTEXT_CHARS || 4000);
const maxValidationChars = Number(env.AI_REVIEW_MAX_VALIDATION_CHARS || 3000);
const range = `${baseSha}...${headSha}`;

const severities = ["nit", "low", "medium", "high", "critical"];
const cwd = process.cwd();

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  const rawDiff = git(["diff", "--unified=80", "--no-ext-diff", range], 40);
  const changedFiles = git(["diff", "--name-only", range], 5).split("\n").map((s) => s.trim()).filter(Boolean);
  const lineMap = parseReviewableLines(rawDiff);

  const secretHits = scanForSecrets(rawDiff, changedFiles);
  if (secretHits.length > 0) {
    await upsertIssueComment(
      "<!-- ai-pr-review:secrets -->",
      renderSecretBlock(secretHits),
    );
    throw new Error("Potential credential leak detected. The model was not called.");
  }

  const reviewableFiles = changedFiles.filter(isReviewablePath);
  const filteredDiff = filterDiffByPath(rawDiff, new Set(reviewableFiles));
  const projectContext = collectProjectContext(reviewableFiles, maxContextChars);
  const validationLog = readText(env.VALIDATION_LOG_PATH, maxValidationChars);

  if (!filteredDiff.trim()) {
    await upsertIssueComment(
      "<!-- ai-pr-review:summary -->",
      [
        "<!-- ai-pr-review:summary -->",
        "## AI PR Review",
        "",
        "No reviewable source changes were detected after filtering generated, lock, binary, and build artifacts.",
      ].join("\n"),
    );
    return;
  }

  const review = await requestModelReview({
    diff: truncate(filteredDiff, maxDiffChars),
    projectContext,
    validationLog,
    changedFiles: reviewableFiles,
  });

  const findings = normalizeFindings(review.findings || [], lineMap, reviewableFiles)
    .filter((finding) => severityRank(finding.severity) >= severityRank(minSeverity))
    .slice(0, maxFindings);

  const inlineComments = findings
    .filter((finding) => lineMap.get(finding.path)?.has(finding.line))
    .map((finding) => ({
      path: finding.path,
      line: finding.line,
      side: "RIGHT",
      body: renderInlineFinding(finding),
    }));

  const body = renderReviewBody(review.summary, findings, inlineComments.length);
  await createPullRequestReview(body, inlineComments);

  if (findings.some((finding) => failOn.has(finding.severity))) {
    throw new Error(`AI review found blocking severity: ${[...failOn].join(", ")}`);
  }
}

function required(name) {
  if (!env[name]) throw new Error(`Missing required environment variable: ${name}`);
  return env[name];
}

function git(args, maxBufferMb) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: maxBufferMb * 1024 * 1024,
  });
}

function isReviewablePath(filePath) {
  const normalized = filePath.replaceAll("\\", "/").toLowerCase();
  const blocked = [
    /(^|\/)(dist|build|coverage|vendor|node_modules)\//,
    /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|composer\.lock|poetry\.lock)$/,
    /\.(png|jpe?g|gif|webp|ico|pdf|zip|tar|gz|7z|woff2?|ttf|mp4|mov)$/i,
    /\.min\.(js|css)$/i,
    /\.generated\./i,
  ];
  return !blocked.some((pattern) => pattern.test(normalized));
}

function collectProjectContext(changedFiles, maxChars) {
  const projectFiles = [
    "README.md",
    "AGENTS.md",
    ".github/copilot-instructions.md",
    "package.json",
    "tsconfig.json",
    "pyproject.toml",
    "requirements.txt",
    "go.mod",
    "pom.xml",
    "build.gradle",
  ];

  const sections = [];
  for (const file of projectFiles) {
    const content = readText(file, 2000);
    if (content) sections.push(`### ${file}\n${content}`);
  }

  const changedSnapshots = [];
  for (const file of changedFiles.slice(0, 4)) {
    const content = readRepoFile(file, 2000);
    if (content) changedSnapshots.push(`### ${file}\n${content}`);
  }

  return truncate([
    "## Repository signals",
    sections.join("\n\n") || "No repository metadata files detected.",
    "## Changed file snapshots",
    changedSnapshots.join("\n\n") || "No changed file snapshots available.",
  ].join("\n\n"), maxChars);
}

async function requestModelReview({ diff, projectContext, validationLog, changedFiles }) {
  const prompt = [
    "Review this pull request as a senior engineer.",
    "",
    "Goals:",
    "- Detect bugs, security risks, data loss, broken edge cases, missing tests, performance regressions, and deviations from existing project patterns.",
    "- Prefer high-signal findings over style-only feedback.",
    "- If suggesting a change, make the suggestion directly applicable.",
    "- Only comment on code changed by this PR.",
    "- Return strict JSON only.",
    "",
    "JSON schema:",
    JSON.stringify({
      summary: "short PR review summary",
      findings: [
        {
          severity: "critical|high|medium|low|nit",
          path: "changed/file.ext",
          line: 123,
          title: "short title",
          body: "why this matters and how to validate it",
          suggestion: "optional replacement code without markdown fences",
        },
      ],
    }, null, 2),
    "",
    `PR title: ${env.PR_TITLE || ""}`,
    `PR author: ${env.PR_AUTHOR || ""}`,
    `Changed files: ${changedFiles.join(", ")}`,
    `Validation status: ${env.VALIDATION_STATUS === "0" ? "passed" : "failed or partially failed"}`,
    "",
    "Validation output:",
    validationLog || "No validation output.",
    "",
    "Project context:",
    projectContext,
    "",
    "Unified diff:",
    diff,
  ].join("\n");

  const endpoint = env.GITHUB_MODELS_ORG
    ? `https://models.github.ai/orgs/${env.GITHUB_MODELS_ORG}/inference/chat/completions`
    : "https://models.github.ai/inference/chat/completions";

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        { role: "system", content: "You are a precise code-review agent. Output valid JSON only." },
        { role: "user", content: prompt },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`GitHub Models request failed: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  return parseModelJson(data.choices?.[0]?.message?.content || "{}");
}

function parseModelJson(text) {
  const cleaned = text.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const first = cleaned.indexOf("{");
    const last = cleaned.lastIndexOf("}");
    if (first >= 0 && last > first) return JSON.parse(cleaned.slice(first, last + 1));
    throw new Error(`Model did not return valid JSON: ${text.slice(0, 500)}`);
  }
}

function normalizeFindings(findings, lineMap, changedFiles) {
  const changed = new Set(changedFiles);
  return findings.flatMap((finding) => {
    const normalized = {
      severity: normalizeSeverity(finding.severity),
      path: normalizePath(finding.path || ""),
      line: Number(finding.line),
      title: String(finding.title || "Review finding").slice(0, 120),
      body: String(finding.body || "").slice(0, 2000),
      suggestion: finding.suggestion ? String(finding.suggestion).replaceAll("```", "").slice(0, 4000) : "",
    };

    if (!changed.has(normalized.path)) return [];
    if (!Number.isInteger(normalized.line)) return [];
    if (!normalized.body.trim()) return [];
    if (!lineMap.get(normalized.path)?.has(normalized.line)) {
      normalized.inlineUnavailable = true;
    }
    return [normalized];
  });
}

function normalizeSeverity(value) {
  const severity = String(value || "low").toLowerCase();
  return severities.includes(severity) ? severity : "low";
}

function severityRank(severity) {
  return severities.indexOf(severity);
}

function normalizePath(filePath) {
  return String(filePath).replaceAll("\\", "/").replace(/^\.\//, "").replace(/^b\//, "");
}

function renderInlineFinding(finding) {
  return [
    `**[${finding.severity}] ${finding.title}**`,
    "",
    finding.body,
    finding.suggestion ? `\n\`\`\`suggestion\n${finding.suggestion}\n\`\`\`` : "",
  ].join("\n");
}

function renderReviewBody(summary, findings, inlineCount) {
  const fallback = findings.filter((finding) => finding.inlineUnavailable);
  return [
    "<!-- ai-pr-review:summary -->",
    "## AI PR Review",
    "",
    summary || "Review completed.",
    "",
    `Inline comments: ${inlineCount}`,
    `Total findings: ${findings.length}`,
    "",
    fallback.length ? "### Findings that could not be placed inline" : "",
    ...fallback.map((finding) => [
      `- **[${finding.severity}] ${finding.path}:${finding.line} - ${finding.title}**`,
      `  ${finding.body}`,
    ].join("\n")),
  ].filter(Boolean).join("\n");
}

async function createPullRequestReview(body, comments) {
  try {
    const payload = {
      event: "COMMENT",
      body,
    };
    if (comments.length) payload.comments = comments;
    await github("POST", `/repos/${repo}/pulls/${prNumber}/reviews`, payload);
  } catch (error) {
    if (!comments.length) throw error;
    await github("POST", `/repos/${repo}/pulls/${prNumber}/reviews`, {
      event: "COMMENT",
      body: `${body}\n\nInline publishing failed, so this run was published as a summary-only review.\n\nError: ${String(error.message).slice(0, 1000)}`,
    });
  }
}

async function upsertIssueComment(marker, body) {
  const comments = await github("GET", `/repos/${repo}/issues/${prNumber}/comments?per_page=100`);
  const existing = comments.find((comment) => comment.body?.includes(marker));
  if (existing) {
    await github("PATCH", `/repos/${repo}/issues/comments/${existing.id}`, { body });
    return;
  }
  await github("POST", `/repos/${repo}/issues/${prNumber}/comments`, { body });
}

async function github(method, apiPath, body) {
  const response = await fetch(`https://api.github.com${apiPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    throw new Error(`${method} ${apiPath} failed: ${response.status} ${await response.text()}`);
  }

  if (response.status === 204) return null;
  return response.json();
}

function parseReviewableLines(diff) {
  const map = new Map();
  let currentPath = "";
  let newLine = 0;

  for (const line of diff.split("\n")) {
    const fileMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (fileMatch) {
      currentPath = normalizePath(fileMatch[2]);
      if (!map.has(currentPath)) map.set(currentPath, new Set());
      continue;
    }

    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      newLine = Number(hunkMatch[1]);
      continue;
    }

    if (!currentPath || !newLine) continue;

    if (line.startsWith("+") && !line.startsWith("+++")) {
      map.get(currentPath).add(newLine);
      newLine += 1;
    } else if (line.startsWith(" ") || line === "") {
      newLine += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      continue;
    }
  }

  return map;
}

function filterDiffByPath(diff, allowedFiles) {
  const chunks = [];
  let current = [];

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      if (current.length) chunks.push(current.join("\n"));
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length) chunks.push(current.join("\n"));

  return chunks.filter((chunk) => {
    const match = chunk.match(/^diff --git a\/(.+?) b\/(.+)$/m);
    return match && allowedFiles.has(normalizePath(match[2]));
  }).join("\n");
}

function scanForSecrets(diff, changedFiles) {
  const hits = [];
  const secretPathPatterns = [
    /(^|\/)\.env(\..*)?$/i,
    /(^|\/)\.npmrc$/i,
    /(^|\/)(id_rsa|id_dsa|id_ed25519)$/i,
    /\.(pem|p12|pfx|key)$/i,
    /(^|\/)(credentials|service-account|serviceAccount|firebase-adminsdk).*\.json$/i,
  ];
  const examplePathPatterns = [/\.env\.example$/i, /example\.env$/i, /\.sample$/i];

  for (const file of changedFiles) {
    const normalized = normalizePath(file);
    if (
      secretPathPatterns.some((pattern) => pattern.test(normalized)) &&
      !examplePathPatterns.some((pattern) => pattern.test(normalized))
    ) {
      hits.push({ path: normalized, line: "-", kind: "credential-like file path" });
    }
  }

  const contentPatterns = [
    { kind: "private key", pattern: /-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
    { kind: "GitHub token", pattern: /gh[pousr]_[A-Za-z0-9_]{30,}/ },
    { kind: "AWS access key", pattern: /AKIA[0-9A-Z]{16}/ },
    { kind: "Google API key", pattern: /AIza[0-9A-Za-z\-_]{35}/ },
    { kind: "Slack token", pattern: /xox[baprs]-[A-Za-z0-9-]{20,}/ },
    { kind: "generic credential assignment", pattern: /\b(api[_-]?key|secret|token|password|passwd|pwd)\b\s*[:=]\s*["']?[^"'\s]{16,}/i },
  ];

  let currentPath = "";
  let newLine = 0;
  for (const line of diff.split("\n")) {
    const fileMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (fileMatch) {
      currentPath = normalizePath(fileMatch[2]);
      continue;
    }
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      newLine = Number(hunkMatch[1]);
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      const added = line.slice(1);
      for (const { kind, pattern } of contentPatterns) {
        if (pattern.test(added)) {
          hits.push({ path: currentPath, line: newLine, kind });
        }
      }
      newLine += 1;
    } else if (line.startsWith(" ") || line === "") {
      newLine += 1;
    }
  }

  return hits.slice(0, 30);
}

function renderSecretBlock(hits) {
  return [
    "<!-- ai-pr-review:secrets -->",
    "## AI PR Review blocked",
    "",
    "Potential credential material was detected in this PR. The model was not called and no code was sent for AI review.",
    "",
    "Detected locations:",
    ...hits.map((hit) => `- \`${hit.path}:${hit.line}\` - ${hit.kind}`),
    "",
    "Remove the credential material, rotate any exposed secret, and push a new commit. The workflow will run again automatically.",
  ].join("\n");
}

function readRepoFile(file, maxChars) {
  const absolute = path.resolve(cwd, file);
  if (!absolute.startsWith(cwd)) return "";
  return readText(absolute, maxChars);
}

function readText(file, maxChars) {
  try {
    if (!file || !fs.existsSync(file)) return "";
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 512 * 1024) return "";
    const buffer = fs.readFileSync(file);
    if (buffer.includes(0)) return "";
    return truncate(buffer.toString("utf8"), maxChars);
  } catch {
    return "";
  }
}

function truncate(text, maxChars) {
  if (!text || text.length <= maxChars) return text || "";
  return `${text.slice(0, maxChars)}\n\n[truncated ${text.length - maxChars} chars]`;
}
