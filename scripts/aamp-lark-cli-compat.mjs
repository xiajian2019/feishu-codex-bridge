#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

const CARD_STATE_VERSION = 1;
const REPLY_PATH_PATTERN = /^\/open-apis\/im\/v1\/messages\/([^/]+)\/reply$/;

/**
 * Detect the public lark-cli API shape used by the official Feishu bridge to
 * send an interactive reply card. Other commands are deliberately left
 * untouched so updates to the official package continue to use lark-cli as
 * usual.
 */
export function parseInteractiveCardReply(args) {
  if (args[0] !== "api" || String(args[1]).toUpperCase() !== "POST") return undefined;
  const path = args[2];
  const match = typeof path === "string" ? REPLY_PATH_PATTERN.exec(path) : undefined;
  if (!match) return undefined;

  const dataText = optionValue(args, "--data");
  if (!dataText) return undefined;
  let data;
  try {
    data = JSON.parse(dataText);
  } catch {
    return undefined;
  }
  if (data?.msg_type !== "interactive" || typeof data.content !== "string") return undefined;

  let replyTo;
  try {
    replyTo = decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
  return { replyTo, data, content: data.content };
}

export function cardContentHash(content) {
  return createHash("sha256").update(content).digest("hex");
}

export function cardDedupKey(replyTo, content) {
  return `${replyTo}:${cardContentHash(content)}`;
}

export function buildCardUpdateArgs(args, messageId, content) {
  const updateArgs = [
    "api",
    "PATCH",
    `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
  ];
  for (let index = 3; index < args.length; index += 1) {
    if (args[index] === "--data") {
      index += 1;
      continue;
    }
    updateArgs.push(args[index]);
  }
  updateArgs.push(
    "--data",
    JSON.stringify({ msg_type: "interactive", content }),
  );
  return updateArgs;
}

export function buildExistingCardResponse(messageId) {
  return `${JSON.stringify({ ok: true, data: { message_id: messageId } })}\n`;
}

export function extractMessageId(output) {
  const parsed = parseJsonOutput(output);
  return parsed ? findMessageId(parsed) : undefined;
}

export function mergeSeededCardEntries(currentEntries, taskState) {
  const next = { ...currentEntries };
  const tasks = asRecord(taskState)?.tasks;
  if (!tasks || typeof tasks !== "object") return next;
  for (const task of Object.values(tasks)) {
    const record = asRecord(task);
    const replyTo = asString(record?.bridgeMessageId);
    const messageId = asString(record?.helpCardMessageId);
    if (replyTo && messageId && next[replyTo]?.messageId !== messageId) {
      next[replyTo] = { messageId };
    }
  }
  return next;
}

function optionValue(args, option) {
  const index = args.indexOf(option);
  if (index < 0 || index + 1 >= args.length) return undefined;
  return args[index + 1];
}

function parseJsonOutput(output) {
  const text = String(output || "").trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    const objectStart = text.indexOf("{");
    if (objectStart < 0) return undefined;
    try {
      return JSON.parse(text.slice(objectStart));
    } catch {
      return undefined;
    }
  }
}

function findMessageId(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findMessageId(item);
      if (found) return found;
    }
    return undefined;
  }
  const record = asRecord(value);
  if (!record) return undefined;
  for (const key of ["message_id", "messageId"]) {
    const messageId = asString(record[key]);
    if (messageId) return messageId;
  }
  for (const item of Object.values(record)) {
    const found = findMessageId(item);
    if (found) return found;
  }
  return undefined;
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function asString(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isCardEntry(value) {
  return Boolean(asString(asRecord(value)?.messageId));
}

function loadCardState(filePath) {
  if (!filePath || !existsSync(filePath)) return { version: CARD_STATE_VERSION, entries: {} };
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    const entries = asRecord(parsed)?.entries;
    if (!entries || typeof entries !== "object") {
      return { version: CARD_STATE_VERSION, entries: {} };
    }
    return {
      version: CARD_STATE_VERSION,
      entries: Object.fromEntries(
        Object.entries(entries).filter(([, value]) => isCardEntry(value)),
      ),
    };
  } catch {
    return { version: CARD_STATE_VERSION, entries: {} };
  }
}

function saveCardState(filePath, state) {
  if (!filePath) return;
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.tmp.${process.pid}`;
  writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporaryPath, filePath);
}

function isSuccessful(result) {
  if (result.status !== 0) return false;
  const parsed = parseJsonOutput(result.stdout);
  return !parsed || parsed.ok !== false;
}

function runCommand(command, args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      resolve({ status: 127, stdout: "", stderr: String(error) });
      return;
    }

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      resolve({ status: 127, stdout, stderr: `${stderr}${String(error)}` });
    });
    child.once("close", (code) => {
      resolve({ status: Number.isInteger(code) ? code : 1, stdout, stderr });
    });
  });
}

function forward(result) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

async function runCompat() {
  const realCli = process.env.AAMP_REAL_LARK_CLI_BIN;
  if (!realCli) {
    process.stderr.write("AAMP_REAL_LARK_CLI_BIN is not configured\n");
    return 127;
  }

  const args = process.argv.slice(2);
  const request = parseInteractiveCardReply(args);
  const statePath = process.env.AAMP_LARK_CARD_DEDUP_STATE;
  if (!request || !statePath || process.env.AAMP_LARK_CARD_DEDUP_DISABLE === "true") {
    const result = await runCommand(realCli, args);
    forward(result);
    return result.status;
  }

  const state = loadCardState(statePath);
  const hash = cardContentHash(request.content);
  const exactKey = `${request.replyTo}:${hash}`;
  const candidate = state.entries[exactKey] || state.entries[request.replyTo];
  if (isCardEntry(candidate)) {
    const patchResult = await runCommand(
      realCli,
      buildCardUpdateArgs(args, candidate.messageId, request.content),
    );
    if (isSuccessful(patchResult)) {
      state.entries[exactKey] = { messageId: candidate.messageId };
      if (exactKey !== request.replyTo) delete state.entries[request.replyTo];
      try {
        saveCardState(statePath, state);
      } catch (error) {
        process.stderr.write(`AAMP card dedup state write failed: ${String(error)}\n`);
      }
      if (patchResult.stderr) process.stderr.write(patchResult.stderr);
      process.stdout.write(buildExistingCardResponse(candidate.messageId));
      return 0;
    }
    if (patchResult.stderr) process.stderr.write(patchResult.stderr);
  }

  const sendResult = await runCommand(realCli, args);
  forward(sendResult);
  if (isSuccessful(sendResult)) {
    const messageId = extractMessageId(sendResult.stdout);
    if (messageId) {
      state.entries[exactKey] = { messageId };
      if (exactKey !== request.replyTo) delete state.entries[request.replyTo];
      try {
        saveCardState(statePath, state);
      } catch (error) {
        process.stderr.write(`AAMP card dedup state write failed: ${String(error)}\n`);
      }
    }
  }
  return sendResult.status;
}

if (process.argv[1] && process.argv[1].endsWith("aamp-lark-cli-compat.mjs")) {
  runCompat()
    .then((status) => { process.exitCode = status; })
    .catch((error) => {
      process.stderr.write(`${String(error)}\n`);
      process.exitCode = 1;
    });
}
