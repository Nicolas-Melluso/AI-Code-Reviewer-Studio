import { readdirSync, existsSync } from "fs";
import { join, resolve, relative, extname } from "path";
import { select } from "@inquirer/prompts";

// ── Constants ─────────────────────────────────────────────────────────────────

const PROJECT_MARKERS = [
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
];

const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx",
  ".py", ".go", ".rs",
  ".java", ".cs", ".cpp", ".c",
  ".rb", ".php",
]);

const IGNORE_DIRS = new Set([
  "node_modules", ".git", "__pycache__", "dist", "build",
  ".venv", "venv", ".next", "target", "vendor",
  ".mypy_cache", ".pytest_cache", "coverage",
]);

// ── Discovery ─────────────────────────────────────────────────────────────────

function isProjectDir(dir: string): boolean {
  return PROJECT_MARKERS.some((m) => existsSync(join(dir, m)));
}

export function findProjects(rootDir: string, depth = 0, maxDepth = 3): string[] {
  if (depth > maxDepth) return [];
  const results: string[] = [];
  try {
    const entries = readdirSync(rootDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || IGNORE_DIRS.has(entry.name)) continue;
      const fullPath = join(rootDir, entry.name);
      if (isProjectDir(fullPath)) {
        results.push(fullPath);
      } else {
        results.push(...findProjects(fullPath, depth + 1, maxDepth));
      }
    }
  } catch {
    // skip unreadable dirs
  }
  return results;
}

export function findCodeFiles(dir: string, depth = 0, maxDepth = 5): string[] {
  if (depth > maxDepth) return [];
  const results: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...findCodeFiles(fullPath, depth + 1, maxDepth));
      } else if (CODE_EXTENSIONS.has(extname(entry.name))) {
        results.push(fullPath);
      }
    }
  } catch {}
  return results;
}

// ── Interactive browser ───────────────────────────────────────────────────────

export async function browseAndSelectFile(startDir?: string): Promise<string> {
  // Default: go one level up from cwd (workspace root)
  const root = startDir ? resolve(startDir) : resolve(process.cwd(), "..");

  const projects = findProjects(root);
  if (projects.length === 0) {
    throw new Error(
      `No projects found under ${root}.\n  Tip: pass a file directly: npm run review -- <file>`
    );
  }

  const projectChoice = await select({
    message: "Select a project:",
    choices: projects.map((p) => ({
      name: relative(root, p),
      value: p,
    })),
    pageSize: 15,
  });

  const files = findCodeFiles(projectChoice);
  if (files.length === 0) {
    throw new Error(`No code files found in ${projectChoice}.`);
  }

  const fileChoice = await select({
    message: "Select a file to review:",
    choices: files.map((f) => ({
      name: relative(projectChoice, f),
      value: f,
    })),
    pageSize: 20,
  });

  return fileChoice;
}
