import "dotenv/config";
import express from "express";
import { readFileSync, existsSync } from "fs";
import { extname, resolve, relative, normalize, sep } from "path";
import { applyFix, backupFile } from "./applier.js";
import { findProjects, findCodeFiles } from "./browser.js";
import { reviewCode } from "./reviewer.js";

interface ApplyItem {
  title?: string;
  originalCode: string;
  fixedCode: string;
}

const app = express();
const PORT = Number(process.env.WEB_PORT || 3399);

// Workspace root: parent folder of this repo, so it sees sibling projects
const workspaceRoot = resolve(process.cwd(), "..");

app.use(express.json({ limit: "4mb" }));
app.use(express.static(resolve(process.cwd(), "web")));

function isInsideWorkspace(inputPath: string): boolean {
  const target = normalize(resolve(inputPath));
  const root = normalize(workspaceRoot + sep);
  return target.startsWith(root);
}

function toRel(p: string): string {
  return relative(workspaceRoot, p).split("\\").join("/");
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, workspaceRoot });
});

app.get("/api/projects", (_req, res) => {
  const projects = findProjects(workspaceRoot).sort((a, b) => a.localeCompare(b));
  res.json({
    projects: projects.map((p) => ({
      path: p,
      relativePath: toRel(p),
    })),
  });
});

app.get("/api/files", (req, res) => {
  const projectPath = String(req.query.projectPath || "");
  if (!projectPath) {
    return res.status(400).json({ error: "projectPath is required" });
  }

  if (!existsSync(projectPath) || !isInsideWorkspace(projectPath)) {
    return res.status(400).json({ error: "Invalid projectPath" });
  }

  const files = findCodeFiles(projectPath).sort((a, b) => a.localeCompare(b));
  return res.json({
    files: files.map((f) => ({
      path: f,
      relativePath: relative(projectPath, f).split("\\").join("/"),
    })),
  });
});

app.post("/api/review", async (req, res) => {
  try {
    const filePath = String(req.body?.filePath || "");
    const model = String(req.body?.model || "gpt-4o-mini");

    if (!filePath) {
      return res.status(400).json({ error: "filePath is required" });
    }
    if (!existsSync(filePath) || !isInsideWorkspace(filePath)) {
      return res.status(400).json({ error: "Invalid filePath" });
    }

    const code = readFileSync(filePath, "utf-8");
    const language = extname(filePath).replace(".", "") || "code";
    const review = await reviewCode(code, language, model);

    return res.json({
      filePath,
      relativePath: toRel(filePath),
      model,
      review,
    });
  } catch (err) {
    return res.status(500).json({
      error: err instanceof Error ? err.message : "Unknown error",
    });
  }
});

app.post("/api/apply", (req, res) => {
  try {
    const filePath = String(req.body?.filePath || "");
    const fixes = Array.isArray(req.body?.fixes) ? (req.body.fixes as ApplyItem[]) : [];
    const makeBackup = req.body?.backup !== false;

    if (!filePath || fixes.length === 0) {
      return res.status(400).json({ error: "filePath and fixes are required" });
    }
    if (!existsSync(filePath) || !isInsideWorkspace(filePath)) {
      return res.status(400).json({ error: "Invalid filePath" });
    }

    if (makeBackup) {
      backupFile(filePath);
    }

    let applied = 0;
    let failed = 0;
    const results = fixes.map((f) => {
      const r = applyFix(filePath, f.originalCode, f.fixedCode, false);
      if (r.success) applied++;
      else failed++;
      return {
        title: f.title || "Untitled fix",
        success: r.success,
        reason: r.reason,
      };
    });

    return res.json({
      filePath,
      applied,
      failed,
      backup: makeBackup ? `${filePath}.bak` : null,
      results,
    });
  } catch (err) {
    return res.status(500).json({
      error: err instanceof Error ? err.message : "Unknown error",
    });
  }
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`AI Code Reviewer SPA running at http://localhost:${PORT}`);
});
