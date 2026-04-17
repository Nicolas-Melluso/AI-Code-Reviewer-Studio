const healthEl = document.getElementById("health");
const projectSelect = document.getElementById("projectSelect");
const fileSelect = document.getElementById("fileSelect");
const modelInput = document.getElementById("modelInput");
const analyzeBtn = document.getElementById("analyzeBtn");
const refreshBtn = document.getElementById("refreshBtn");
const summaryBox = document.getElementById("summaryBox");
const toolbar = document.getElementById("toolbar");
const issuesEl = document.getElementById("issues");
const applySelectedBtn = document.getElementById("applySelectedBtn");
const tpl = document.getElementById("issueTpl");

const state = {
  projects: [],
  files: [],
  review: null,
  filePath: "",
  filter: "all",
};

function esc(s = "") {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function getJSON(url, options) {
  const res = await fetch(url, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

function setBusy(isBusy, text = "") {
  analyzeBtn.disabled = isBusy;
  refreshBtn.disabled = isBusy;
  applySelectedBtn.disabled = isBusy;
  if (text) healthEl.textContent = text;
}

function setHealth(text, ok = true) {
  healthEl.textContent = text;
  healthEl.style.borderColor = ok ? "#2a6f4f" : "#7a2b39";
  healthEl.style.background = ok ? "#173426" : "#4e2028";
}

async function loadHealth() {
  try {
    const data = await getJSON("/api/health");
    setHealth(`ready: ${data.workspaceRoot}`);
  } catch (err) {
    setHealth(`error: ${err.message}`, false);
  }
}

async function loadProjects() {
  setBusy(true, "loading projects...");
  try {
    const data = await getJSON("/api/projects");
    state.projects = data.projects;
    projectSelect.innerHTML = state.projects
      .map((p) => `<option value="${esc(p.path)}">${esc(p.relativePath)}</option>`)
      .join("");

    if (state.projects.length > 0) {
      await loadFiles(state.projects[0].path);
    } else {
      fileSelect.innerHTML = "";
    }

    setHealth(`projects: ${state.projects.length}`);
  } catch (err) {
    setHealth(`error loading projects: ${err.message}`, false);
  } finally {
    setBusy(false);
  }
}

async function loadFiles(projectPath) {
  setBusy(true, "loading files...");
  try {
    const data = await getJSON(`/api/files?projectPath=${encodeURIComponent(projectPath)}`);
    state.files = data.files;
    fileSelect.innerHTML = state.files
      .map((f) => `<option value="${esc(f.path)}">${esc(f.relativePath)}</option>`)
      .join("");
    setHealth(`files: ${state.files.length}`);
  } catch (err) {
    setHealth(`error loading files: ${err.message}`, false);
  } finally {
    setBusy(false);
  }
}

function severityOrder(s) {
  if (s === "error") return 0;
  if (s === "warning") return 1;
  return 2;
}

function currentIssues() {
  const issues = state.review?.review?.issues;
  return Array.isArray(issues) ? issues : [];
}

function renderSummary() {
  if (!state.review) {
    summaryBox.innerHTML = `<h2>Resultados</h2><p class="muted">Todavia no hay analisis.</p>`;
    return;
  }

  const issues = currentIssues();
  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.filter((i) => i.severity === "warning").length;
  const suggestions = issues.filter((i) => i.severity === "suggestion").length;
  const score = state.review?.review?.score ?? "-";
  const summary = state.review?.review?.summary || "Sin resumen";

  summaryBox.innerHTML = `
    <h2>Resultados</h2>
    <p><strong>Archivo:</strong> ${esc(state.review.relativePath || state.filePath)}</p>
    <p><strong>Score:</strong> ${esc(score)}/10</p>
    <p>${esc(summary)}</p>
    <p class="muted">Errores: ${errors} | Warnings: ${warnings} | Sugerencias: ${suggestions}</p>
  `;
}

function issueVisible(issue) {
  return state.filter === "all" || issue.severity === state.filter;
}

function renderIssues() {
  issuesEl.innerHTML = "";

  if (!state.review) {
    toolbar.classList.add("hidden");
    return;
  }

  const allIssues = [...currentIssues()].sort(
    (a, b) => severityOrder(a.severity) - severityOrder(b.severity)
  );

  const visible = allIssues.filter(issueVisible);
  toolbar.classList.toggle("hidden", allIssues.length === 0);

  if (visible.length === 0) {
    issuesEl.innerHTML = `<p class="muted">No hay issues para este filtro.</p>`;
    return;
  }

  visible.forEach((issue, idx) => {
    const frag = tpl.content.cloneNode(true);
    const card = frag.querySelector(".issue-card");
    const check = frag.querySelector(".fix-check");
    const title = frag.querySelector(".issue-title");
    const tags = frag.querySelector(".issue-tags");
    const desc = frag.querySelector(".issue-desc");
    const diff = frag.querySelector(".diff");
    const before = frag.querySelector(".before");
    const after = frag.querySelector(".after");

    title.textContent = `${idx + 1}. ${issue.title}`;
    desc.textContent = issue.description;

    tags.innerHTML = `
      <span class="tag ${issue.severity}">${issue.severity}</span>
      <span class="tag">${issue.category}</span>
      ${issue.line ? `<span class="tag">line ${issue.line}</span>` : ""}
      ${issue.originalCode && issue.fixedCode ? `<span class="tag fix">auto-fix</span>` : ""}
    `;

    if (issue.originalCode && issue.fixedCode) {
      check.dataset.fix = "true";
      check.dataset.title = issue.title;
      check.dataset.original = issue.originalCode;
      check.dataset.fixed = issue.fixedCode;
      check.checked = issue.severity === "error";
      before.textContent = issue.originalCode;
      after.textContent = issue.fixedCode;
      diff.classList.remove("hidden");
    } else {
      check.disabled = true;
      diff.remove();
    }

    card.dataset.sev = issue.severity;
    issuesEl.appendChild(frag);
  });
}

async function analyze() {
  const filePath = fileSelect.value;
  const model = modelInput.value.trim() || "gpt-4o-mini";
  if (!filePath) {
    setHealth("selecciona un archivo", false);
    return;
  }

  setBusy(true, "analyzing...");
  try {
    const data = await getJSON("/api/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath, model }),
    });

    state.review = data;
    state.filePath = filePath;
    renderSummary();
    renderIssues();
    setHealth("analysis complete");
  } catch (err) {
    setHealth(`analysis error: ${err.message}`, false);
  } finally {
    setBusy(false);
  }
}

async function applySelected() {
  if (!state.review) return;

  const checks = [...document.querySelectorAll(".fix-check")].filter(
    (c) => c.checked && c.dataset.fix === "true"
  );

  if (checks.length === 0) {
    setHealth("no seleccionaste fixes", false);
    return;
  }

  const fixes = checks.map((c) => ({
    title: c.dataset.title,
    originalCode: c.dataset.original,
    fixedCode: c.dataset.fixed,
  }));

  setBusy(true, "applying fixes...");
  try {
    const result = await getJSON("/api/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath: state.filePath, fixes, backup: true }),
    });

    setHealth(`applied ${result.applied}, failed ${result.failed}`);
  } catch (err) {
    setHealth(`apply error: ${err.message}`, false);
  } finally {
    setBusy(false);
  }
}

projectSelect.addEventListener("change", () => loadFiles(projectSelect.value));
analyzeBtn.addEventListener("click", analyze);
refreshBtn.addEventListener("click", loadProjects);
applySelectedBtn.addEventListener("click", applySelected);

document.querySelectorAll(".filter").forEach((b) => {
  b.addEventListener("click", () => {
    document.querySelectorAll(".filter").forEach((x) => x.classList.remove("on"));
    b.classList.add("on");
    state.filter = b.dataset.filter;
    renderIssues();
  });
});

await loadHealth();
await loadProjects();
