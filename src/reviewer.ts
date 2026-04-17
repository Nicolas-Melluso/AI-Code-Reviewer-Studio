import OpenAI from "openai";

// ── Types ─────────────────────────────────────────────────────────────────────

export type Severity = "error" | "warning" | "suggestion";
export type Category = "bug" | "security" | "performance" | "style" | "readability";

export interface CodeIssue {
  line?: number;
  severity: Severity;
  category: Category;
  title: string;
  description: string;
  originalCode?: string;
  fixedCode?: string;
}

export interface CodeReview {
  summary: string;
  score: number;
  issues: CodeIssue[];
}

// ── Tool definition ───────────────────────────────────────────────────────────

const REVIEW_TOOL: OpenAI.Chat.ChatCompletionTool = {
  type: "function",
  function: {
    name: "submitCodeReview",
    description: "Submit a structured code review with actionable, educational feedback",
    parameters: {
      type: "object",
      required: ["summary", "score", "issues"],
      properties: {
        summary: {
          type: "string",
          description: "Brief overall assessment of the code",
        },
        score: {
          type: "number",
          description: "Code quality score from 1 (terrible) to 10 (excellent)",
        },
        issues: {
          type: "array",
          items: {
            type: "object",
            required: ["severity", "category", "title", "description"],
            properties: {
              line: {
                type: "number",
                description: "Approximate line number where the issue occurs",
              },
              severity: {
                type: "string",
                enum: ["error", "warning", "suggestion"],
                description:
                  "error = bug/security risk, warning = bad practice, suggestion = improvement",
              },
              category: {
                type: "string",
                enum: ["bug", "security", "performance", "style", "readability"],
              },
              title: {
                type: "string",
                description: "Short title for the issue (max 60 chars)",
              },
              description: {
                type: "string",
                description:
                  "Educational explanation for a junior developer: what is wrong AND why it matters",
              },
              originalCode: {
                type: "string",
                description:
                  "EXACT verbatim code from the file to replace (no line numbers). Must match the file character-for-character so it can be auto-applied.",
              },
              fixedCode: {
                type: "string",
                description: "The corrected replacement code",
              },
            },
          },
        },
      },
    },
  },
};

const SYSTEM_PROMPT = `You are an expert code reviewer helping junior developers grow.

Your goals:
- Find real issues: bugs, security risks, performance problems, bad practices
- Explain WHY each issue matters in plain terms a junior developer understands
- Provide safe, minimal fixes that change only what's needed
- Be encouraging, not harsh — frame everything as learning opportunities

Rules for originalCode / fixedCode:
- Only provide them when you can give an EXACT verbatim snippet from the file (no line numbers, no ellipsis)
- The originalCode must appear literally in the file — it's used for automatic text replacement
- Keep the fix minimal: change only the problematic part, preserve surrounding code style
- Do NOT include originalCode/fixedCode for architectural issues that need broader refactoring`;

// ── Main export ───────────────────────────────────────────────────────────────

export async function reviewCode(
  code: string,
  language: string,
  model: string = "gpt-4o-mini"
): Promise<CodeReview> {
  if (!process.env.GITHUB_TOKEN) {
    throw new Error(
      "GITHUB_TOKEN environment variable is required.\n  Set it with: export GITHUB_TOKEN=your_token\n  Or copy .env.example to .env and fill it in."
    );
  }

  const client = new OpenAI({
    baseURL: "https://models.inference.ai.azure.com",
    apiKey: process.env.GITHUB_TOKEN,
  });

  // Add line numbers to help the model reference exact locations
  const numberedCode = code
    .split("\n")
    .map((line, i) => `${String(i + 1).padStart(4, " ")} | ${line}`)
    .join("\n");

  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `Review this ${language} code:\n\n\`\`\`${language}\n${numberedCode}\n\`\`\``,
      },
    ],
    tools: [REVIEW_TOOL],
    tool_choice: { type: "function", function: { name: "submitCodeReview" } },
  });

  const toolCall = response.choices[0]?.message?.tool_calls?.[0];
  if (!toolCall) {
    throw new Error("Model did not return a structured review. Try again.");
  }

  return JSON.parse(toolCall.function.arguments) as CodeReview;
}
