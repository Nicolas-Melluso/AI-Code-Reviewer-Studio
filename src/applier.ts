import { readFileSync, writeFileSync, copyFileSync } from "fs";

export interface ApplyResult {
  success: boolean;
  reason?: string;
}

/**
 * Creates a .bak backup of the file before modifying it.
 */
export function backupFile(filePath: string): void {
  copyFileSync(filePath, `${filePath}.bak`);
}

/**
 * Applies a single fix by replacing originalCode with fixedCode in the file.
 */
export function applyFix(
  filePath: string,
  originalCode: string,
  fixedCode: string,
  dryRun: boolean = false
): ApplyResult {
  const content = readFileSync(filePath, "utf-8");

  if (content.includes(originalCode)) {
    if (!dryRun) {
      // Replace only the first occurrence to stay safe
      writeFileSync(filePath, content.replace(originalCode, fixedCode), "utf-8");
    }
    return { success: true };
  }

  // Try normalizing trailing whitespace in case the model differed slightly
  const normalized = normalizeWhitespace(originalCode);
  const match = findNormalized(content, normalized);

  if (!match) {
    return {
      success: false,
      reason:
        "Original snippet not found in file — may have been changed by a previous fix, or the model returned an inexact match",
    };
  }

  if (!dryRun) {
    writeFileSync(filePath, content.replace(match, fixedCode), "utf-8");
  }
  return { success: true };
}

function normalizeWhitespace(code: string): string {
  return code
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n")
    .trim();
}

function findNormalized(content: string, normalizedTarget: string): string | null {
  const lines = normalizedTarget.split("\n");
  const pattern = lines.map((l) => escapeRegex(l.trim())).join("\\s*\\n\\s*");
  const re = new RegExp(pattern);
  const m = content.match(re);
  return m ? m[0] : null;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
