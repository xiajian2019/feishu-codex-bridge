import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TASK_FEATURE_MODEL = "gpt-5.6-luna";
const TASK_FEATURE_REASONING_EFFORT = "low";
const TASK_FEATURE_WORD_MIN = 3;
const TASK_FEATURE_WORD_MAX = 5;
const TASK_FEATURE_TIMEOUT_MS = 60_000;
const TASK_FEATURE_OUTPUT_LIMIT = 16 * 1024;
const OPAQUE_TASK_WORD = /^(?:[0-9a-f]{8,}|[0-9]{6,})$/i;

export interface TaskFeatureNameRequest {
  codexPath: string;
  summary: string;
  description: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Ask the configured Codex CLI for the short feature name used in Git refs.
 * Naming is deliberately isolated from the task worker: it is a read-only,
 * ephemeral call and never receives a repository working directory.
 */
export async function summarizeTaskFeatureName(request: TaskFeatureNameRequest): Promise<string | null> {
  const scratchDirectory = await mkdtemp(join(tmpdir(), "feishu-codex-bridge-task-name-"));
  const outputPath = join(scratchDirectory, "last-message.txt");
  try {
    const result = await runCodexNameCommand(request, outputPath);
    if (result.exitCode !== 0) return null;
    const response = await readFile(outputPath, "utf8").catch(() => result.stdout);
    return parseTaskFeatureName(response);
  } catch {
    return null;
  } finally {
    await rm(scratchDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function fallbackTaskFeatureName(value: string): string | null {
  return normalizeTaskFeatureName(value);
}

export function parseTaskFeatureName(value: string): string | null {
  const text = value.replace(/\r\n?/g, "\n").trim();
  const candidates = text.split("\n").map((line) => {
    let candidate = line.trim();
    if (!candidate || candidate.startsWith("```")) return null;
    candidate = candidate.replace(/^(?:summary|feature(?: name)?|name|slug)\s*:\s*/i, "");
    candidate = candidate.replace(/^[`"'*_]+|[`"'*_.,:;]+$/g, "");
    return candidate.trim() || null;
  }).filter((candidate): candidate is string => candidate !== null);
  const lineCandidate = candidates.find((candidate) => /^[a-z0-9]+(?:[-\s]+[a-z0-9]+)+$/i.test(candidate));
  if (lineCandidate) return normalizeTaskFeatureName(lineCandidate);
  const kebabCandidate = text.match(/\b[a-z][a-z0-9]*(?:-[a-z0-9]+){1,}\b/i)?.[0];
  return kebabCandidate ? normalizeTaskFeatureName(kebabCandidate) : null;
}

function normalizeTaskFeatureName(value: string): string | null {
  const slug = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const words = slug.split("-").filter(Boolean);
  if (words.length === 0) return null;
  const meaningfulWords = words.filter((word) => !OPAQUE_TASK_WORD.test(word));
  const selectedWords = (meaningfulWords.length >= 2 ? meaningfulWords : words).slice(0, TASK_FEATURE_WORD_MAX);
  if (selectedWords.length < 2) return selectedWords[0] ?? null;
  return selectedWords.join("-");
}

function taskFeaturePrompt(summary: string, description: string): string {
  let content = `${summary.trim()}\n\n${description.trim()}`.trim();
  if (content.length > 48_000) content = `${content.slice(0, 48_000)}\n[task content truncated for naming]`;
  return [
    "You are naming a software engineering task before a Git branch and worktree are created.",
    "Identify the main user-visible function or change from the task below.",
    "",
    `Return exactly one concise English feature name. Prefer ${TASK_FEATURE_WORD_MIN} to ${TASK_FEATURE_WORD_MAX} meaningful words when practical.`,
    "Use only lowercase ASCII words joined by single hyphens, for example:",
    "extract-weight-from-serving-size or prevent-duplicate-submissions.",
    "Do not include dates, IDs, hashes, file names, or explanations.",
    "",
    "<task>",
    content,
    "</task>",
  ].join("\n");
}

async function runCodexNameCommand(
  request: TaskFeatureNameRequest,
  outputPath: string,
): Promise<{ exitCode: number | null; stdout: string }> {
  const args = [
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--color",
    "never",
    "--model",
    TASK_FEATURE_MODEL,
    "--config",
    `model_reasoning_effort=\"${TASK_FEATURE_REASONING_EFFORT}\"`,
    "--output-last-message",
    outputPath,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(request.codexPath, args, {
      cwd: tmpdir(),
      env: { ...process.env, ...request.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let settled = false;
    const finish = (result: { exitCode: number | null; stdout: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= TASK_FEATURE_OUTPUT_LIMIT) stdout.push(chunk);
    });
    child.once("error", fail);
    child.once("close", (exitCode) => finish({ exitCode, stdout: Buffer.concat(stdout).toString("utf8") }));
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      fail(new Error("task feature name request timed out"));
    }, TASK_FEATURE_TIMEOUT_MS);
    child.stdin.end(taskFeaturePrompt(request.summary, request.description));
  });
}
