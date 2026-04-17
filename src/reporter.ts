import { writeFileSync } from "fs";
import { basename } from "path";
import type { CodeReview, CodeIssue, Severity } from "./reviewer.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const SEV_COLOR: Record<Severity, string> = {
  error: "#ef4444",
  warning: "#f59e0b",
  suggestion: "#60a5fa",
};

const CAT_COLOR: Record<string, string> = {
  bug: "#dc2626",
  security: "#a855f7",
  performance: "#3b82f6",
  style: "#6b7280",
  readability: "#6b7280",
};

const SEV_ICON: Record<Severity, string> = {
  error: "✖",
  warning: "⚠",
  suggestion: "◆",
};

function scoreSVG(score: number): string {
  const r = 52;
  const circ = 2 * Math.PI * r;
  const filled = (score / 10) * circ;
  const color = score >= 8 ? "#22c55e" : score >= 5 ? "#f59e0b" : "#ef4444";
  return `<svg width="128" height="128" viewBox="0 0 128 128" aria-label="Score ${score}/10">
    <circle cx="64" cy="64" r="${r}" fill="none" stroke="#27272a" stroke-width="12"/>
    <circle cx="64" cy="64" r="${r}" fill="none" stroke="${color}" stroke-width="12"
      stroke-dasharray="${filled.toFixed(2)} ${circ.toFixed(2)}"
      stroke-linecap="round" transform="rotate(-90 64 64)"/>
    <text x="64" y="70" text-anchor="middle" fill="${color}"
      font-size="22" font-weight="700" font-family="system-ui,sans-serif">${score}/10</text>
  </svg>`;
}

function issueCard(issue: CodeIssue, num: number): string {
  const sc = SEV_COLOR[issue.severity] ?? "#6b7280";
  const cc = CAT_COLOR[issue.category] ?? "#6b7280";
  const icon = SEV_ICON[issue.severity] ?? "•";
  const lineTag = issue.line
    ? `<span class="tag mono" style="background:#1e293b;color:#94a3b8">line ${issue.line}</span>`
    : "";
  const diff =
    issue.originalCode && issue.fixedCode
      ? `<details class="diff-details">
          <summary>Show fix ▶</summary>
          <div class="diff-grid">
            <div>
              <div class="diff-label before-label">Before</div>
              <pre class="diff-pre before-pre"><code>${esc(issue.originalCode)}</code></pre>
            </div>
            <div>
              <div class="diff-label after-label">After</div>
              <pre class="diff-pre after-pre"><code>${esc(issue.fixedCode)}</code></pre>
            </div>
          </div>
        </details>`
      : "";

  return `<div class="card" data-sev="${issue.severity}">
    <div class="card-header">
      <span class="num">${num}</span>
      <span class="sev-icon" style="color:${sc}">${icon}</span>
      <span class="card-title">${esc(issue.title)}</span>
      <div class="tags">
        ${lineTag}
        <span class="tag" style="background:${cc}22;color:${cc}">${esc(issue.category)}</span>
        <span class="tag" style="background:${sc}22;color:${sc}">${issue.severity}</span>
        ${issue.originalCode ? `<span class="tag" style="background:#10b98122;color:#10b981">⚡ auto-fix</span>` : ""}
      </div>
    </div>
    <p class="card-desc">${esc(issue.description)}</p>
    ${diff}
  </div>`;
}

// ── HTML generator ────────────────────────────────────────────────────────────

export function generateReport(filePath: string, review: CodeReview, model: string): string {
  const filename = basename(filePath);
  const date = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const errors = review.issues.filter((i) => i.severity === "error").length;
  const warnings = review.issues.filter((i) => i.severity === "warning").length;
  const suggestions = review.issues.filter((i) => i.severity === "suggestion").length;
  const withFix = review.issues.filter((i) => i.originalCode && i.fixedCode).length;

  const cards = review.issues.map((issue, i) => issueCard(issue, i + 1)).join("\n");

  const statRow = (color: string, label: string, count: number) =>
    count > 0
      ? `<div class="stat-row">
          <span class="stat-dot" style="background:${color}"></span>
          <span class="stat-label">${label}</span>
          <span class="stat-val" style="color:${color}">${count}</span>
        </div>`
      : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Review — ${esc(filename)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg: #09090b;
      --surface: #18181b;
      --border: #27272a;
      --text: #e4e4e7;
      --muted: #71717a;
      --dimmer: #52525b;
      --font: system-ui, -apple-system, sans-serif;
      --mono: 'Cascadia Code', 'Fira Code', Consolas, monospace;
    }

    body {
      font-family: var(--font);
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      display: grid;
      grid-template-rows: 56px 1fr;
      grid-template-columns: 240px 1fr;
      grid-template-areas: "header header" "sidebar main";
    }

    /* ── Header ── */
    header {
      grid-area: header;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 24px;
      gap: 16px;
    }
    .header-left { display: flex; align-items: center; gap: 12px; }
    .logo { font-weight: 700; font-size: 15px; color: #a78bfa; letter-spacing: -0.3px; }
    .file-chip {
      background: var(--border);
      border-radius: 5px;
      padding: 3px 9px;
      font-family: var(--mono);
      font-size: 12px;
      color: #94a3b8;
    }
    .header-right { display: flex; align-items: center; gap: 12px; }
    .date-label { font-size: 12px; color: var(--dimmer); }
    .btn-print {
      background: var(--border);
      border: 1px solid #3f3f46;
      color: var(--muted);
      border-radius: 6px;
      padding: 5px 12px;
      cursor: pointer;
      font-size: 12px;
      font-family: var(--font);
      transition: all .15s;
    }
    .btn-print:hover { background: #3f3f46; color: var(--text); }

    /* ── Sidebar ── */
    aside {
      grid-area: sidebar;
      background: var(--surface);
      border-right: 1px solid var(--border);
      padding: 24px 16px;
      display: flex;
      flex-direction: column;
      gap: 24px;
      overflow-y: auto;
    }
    .score-wrap { display: flex; flex-direction: column; align-items: center; gap: 6px; }
    .score-sub { font-size: 10px; text-transform: uppercase; letter-spacing: 1px; color: var(--dimmer); }

    .section-label {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: var(--dimmer);
      margin-bottom: 6px;
    }
    .stat-row { display: flex; align-items: center; gap: 8px; font-size: 13px; margin-bottom: 6px; }
    .stat-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
    .stat-label { flex: 1; color: var(--muted); }
    .stat-val { font-weight: 700; font-variant-numeric: tabular-nums; }

    .fix-pill {
      background: #052e16;
      border: 1px solid #166534;
      border-radius: 8px;
      padding: 10px 12px;
      font-size: 12px;
      color: #4ade80;
      line-height: 1.5;
      text-align: center;
    }
    .fix-pill .sub { color: #16a34a; font-size: 10px; }

    .model-chip {
      background: var(--border);
      border-radius: 6px;
      padding: 8px 10px;
      font-size: 11px;
      color: var(--dimmer);
      line-height: 1.6;
      text-align: center;
    }
    .model-chip strong { color: var(--muted); }

    /* ── Main ── */
    main {
      grid-area: main;
      padding: 24px;
      overflow-y: auto;
    }

    .summary-box {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 16px 20px;
      margin-bottom: 20px;
    }
    .summary-box .label {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: var(--dimmer);
      margin-bottom: 6px;
    }
    .summary-box p { font-size: 14px; color: #a1a1aa; line-height: 1.65; }

    /* Filter bar */
    .filter-bar { display: flex; gap: 8px; margin-bottom: 18px; flex-wrap: wrap; }
    .fbtn {
      background: var(--surface);
      border: 1px solid var(--border);
      color: var(--muted);
      border-radius: 20px;
      padding: 4px 14px;
      font-size: 12px;
      cursor: pointer;
      font-family: var(--font);
      transition: all .15s;
    }
    .fbtn:hover, .fbtn.on { background: #3f3f46; color: var(--text); border-color: #52525b; }

    /* Issue cards */
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 16px 20px;
      margin-bottom: 12px;
      transition: border-color .15s;
    }
    .card:hover { border-color: #3f3f46; }

    .card-header {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 10px;
    }
    .num {
      font-size: 11px;
      color: var(--dimmer);
      font-variant-numeric: tabular-nums;
      margin-top: 2px;
      flex-shrink: 0;
    }
    .sev-icon { font-size: 14px; flex-shrink: 0; margin-top: 1px; }
    .card-title { font-size: 14px; font-weight: 600; flex: 1; min-width: 180px; }
    .tags { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin-left: auto; }
    .tag {
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.4px;
      border-radius: 4px;
      padding: 2px 7px;
    }
    .mono { font-family: var(--mono) !important; font-size: 10px !important; }

    .card-desc { font-size: 13px; color: #a1a1aa; line-height: 1.65; margin-bottom: 10px; }

    /* Diff */
    details.diff-details summary {
      font-size: 12px;
      color: #818cf8;
      cursor: pointer;
      user-select: none;
      list-style: none;
      display: inline-block;
    }
    details.diff-details summary::-webkit-details-marker { display: none; }
    details[open].diff-details summary { color: #a5b4fc; }
    .diff-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      margin-top: 10px;
    }
    .diff-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; padding: 5px 10px; }
    .before-label { background: #450a0a; color: #fca5a5; border-radius: 5px 5px 0 0; }
    .after-label  { background: #052e16; color: #86efac; border-radius: 5px 5px 0 0; }
    .diff-pre {
      margin: 0;
      padding: 10px 12px;
      font-family: var(--mono);
      font-size: 12px;
      line-height: 1.5;
      overflow-x: auto;
      border-radius: 0 0 5px 5px;
    }
    .before-pre { background: #1c0606; border: 1px solid #7f1d1d; border-top: none; }
    .after-pre  { background: #061a10; border: 1px solid #14532d; border-top: none; }
    .diff-pre code { color: #d4d4d8; }

    .no-issues {
      text-align: center;
      padding: 48px;
      background: #052e16;
      border: 1px solid #14532d;
      border-radius: 10px;
      color: #22c55e;
      font-size: 16px;
      font-weight: 600;
    }

    @media (max-width: 720px) {
      body { grid-template-columns: 1fr; grid-template-areas: "header" "main"; }
      aside { display: none; }
      .diff-grid { grid-template-columns: 1fr; }
    }

    @media print {
      body { background: #fff; color: #111; grid-template-columns: 1fr; grid-template-areas: "header" "main"; }
      aside { display: none; }
      header { background: #fff; border-bottom: 1px solid #e5e7eb; }
      .btn-print, .filter-bar { display: none; }
      .card { background: #fff; border-color: #e5e7eb; page-break-inside: avoid; }
      .summary-box { background: #f9fafb; border-color: #e5e7eb; }
      details[open] { display: block; }
      .diff-pre { background: #f3f4f6 !important; border-color: #d1d5db !important; }
      .diff-pre code { color: #111 !important; }
    }
  </style>
</head>
<body>
  <header>
    <div class="header-left">
      <span class="logo">⬡ AI Code Reviewer</span>
      <span class="file-chip">${esc(filename)}</span>
    </div>
    <div class="header-right">
      <span class="date-label">${esc(model)} · ${date}</span>
      <button class="btn-print" onclick="window.print()">⎙ Print / Save PDF</button>
    </div>
  </header>

  <aside>
    <div class="score-wrap">
      <div class="score-sub">Quality Score</div>
      ${scoreSVG(review.score)}
    </div>

    <div>
      <div class="section-label">Issues found</div>
      ${statRow("#ef4444", "Errors", errors)}
      ${statRow("#f59e0b", "Warnings", warnings)}
      ${statRow("#60a5fa", "Suggestions", suggestions)}
      ${review.issues.length === 0 ? `<div style="color:#22c55e;font-size:13px">✓ No issues</div>` : ""}
    </div>

    ${
      withFix > 0
        ? `<div class="fix-pill">
            ⚡ ${withFix} auto-fix${withFix > 1 ? "es" : ""} available
            <br><span class="sub">Run CLI to apply</span>
          </div>`
        : ""
    }

    <div class="model-chip">
      <strong>Model</strong><br>${esc(model)}<br>
      <strong>File</strong><br>${esc(filename)}
    </div>
  </aside>

  <main>
    <div class="summary-box">
      <div class="label">Summary</div>
      <p>${esc(review.summary)}</p>
    </div>

    ${
      review.issues.length > 1
        ? `<div class="filter-bar">
            <button class="fbtn on" onclick="filter('all',this)">All (${review.issues.length})</button>
            ${errors > 0 ? `<button class="fbtn" onclick="filter('error',this)">✖ Errors (${errors})</button>` : ""}
            ${warnings > 0 ? `<button class="fbtn" onclick="filter('warning',this)">⚠ Warnings (${warnings})</button>` : ""}
            ${suggestions > 0 ? `<button class="fbtn" onclick="filter('suggestion',this)">◆ Suggestions (${suggestions})</button>` : ""}
          </div>`
        : ""
    }

    <div id="list">
      ${review.issues.length === 0 ? `<div class="no-issues">✓ No issues found — clean code!</div>` : ""}
      ${cards}
    </div>
  </main>

  <script>
    function filter(sev, btn) {
      document.querySelectorAll('.fbtn').forEach(b => b.classList.remove('on'));
      btn.classList.add('on');
      document.querySelectorAll('.card').forEach(c => {
        c.style.display = sev === 'all' || c.dataset.sev === sev ? '' : 'none';
      });
    }
  </script>
</body>
</html>`;
}

export function saveReport(filePath: string, review: CodeReview, model: string): string {
  const html = generateReport(filePath, review, model);
  const out = filePath + ".review.html";
  writeFileSync(out, html, "utf-8");
  return out;
}
