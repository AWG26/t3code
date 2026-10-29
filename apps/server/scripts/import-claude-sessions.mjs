#!/usr/bin/env node
/**
 * import-claude-sessions.mjs
 *
 * Seeds T3 projection tables from Claude Code JSONL session files.
 * Reads ~/.claude/projects/ and writes into <base-dir>/userdata/state.sqlite.
 *
 * Usage:
 *   node apps/server/scripts/import-claude-sessions.mjs [options]
 *
 * Options:
 *   --base-dir <path>      T3 base directory  [default: ~/.t3]
 *   --claude-home <path>   Claude home dir    [default: ~/.claude]
 *   --project-dir <path>   Import only sessions under this cwd (substring match)
 *   --dry-run              Preview changes without writing
 *   --help                 Show this message
 *
 * Safety:
 *   Stop the T3 server before running with --base-dir ~/.t3.
 *   The script creates a backup at <db-path>.import-backup-<timestamp> before
 *   any writes.
 */

// @ts-check
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, statSync, cpSync, existsSync } from "node:fs";
import { join, resolve, basename, dirname } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

// ── CLI ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(readFileSync(new URL(import.meta.url), "utf8").split("*/")[0].replace("/**\n", "").replace(/ \* ?/g, ""));
  process.exit(0);
}

function flagValue(flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : undefined;
}

const baseDir = resolve(flagValue("--base-dir") ?? join(homedir(), ".t3"));
const claudeHome = resolve(flagValue("--claude-home") ?? join(homedir(), ".claude"));
const projectDirFilter = flagValue("--project-dir");
const dryRun = args.includes("--dry-run");

// ── Paths ────────────────────────────────────────────────────────────────────

const dbPath = join(baseDir, "userdata", "state.sqlite");
const projectsDir = join(claudeHome, "projects");

console.log(`T3 database  : ${dbPath}`);
console.log(`Claude home  : ${claudeHome}`);
if (projectDirFilter) console.log(`cwd filter   : ${projectDirFilter}`);
if (dryRun) console.log("Dry run      : YES (no writes)");
console.log();

if (!existsSync(dbPath)) {
  console.error(`ERROR: Database not found at ${dbPath}`);
  console.error("Start T3 once so migrations run, then stop it before using this script.");
  process.exit(1);
}

if (!existsSync(projectsDir)) {
  console.error(`ERROR: Claude projects directory not found at ${projectsDir}`);
  process.exit(1);
}

// ── Backup ───────────────────────────────────────────────────────────────────

if (!dryRun) {
  const backupPath = `${dbPath}.import-backup-${Date.now()}`;
  cpSync(dbPath, backupPath);
  console.log(`Backup created: ${backupPath}\n`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Deterministic UUID v5-ish: sha256(seed) → UUID v4 format.
 * Not spec-compliant v5 (no SHA-1 namespace), but stable across runs.
 */
function stableId(seed) {
  const h = Array.from(seed).reduce((acc, ch) => {
    const c = ch.charCodeAt(0);
    return (((acc << 5) - acc) + c) | 0;
  }, 0);
  // Produce a deterministic UUID-shaped string from the hash + seed length
  const hex = (Math.abs(h) * 31 + seed.length).toString(16).padStart(8, "0");
  const extra = Math.abs(seed.charCodeAt(0) * 997 + seed.charCodeAt(seed.length - 1)).toString(16).padStart(8, "0");
  return `${hex.slice(0,8)}-${extra.slice(0,4)}-4${extra.slice(4,7)}-8${hex.slice(1,4)}-${hex}${extra}`.slice(0, 36);
}

function extractTextContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(b => b && typeof b === "object" && b.type === "text")
      .map(b => b.text ?? "")
      .join("");
  }
  return "";
}

function truncate(s, n) {
  if (!s || s.length <= n) return s ?? "";
  return s.slice(0, n - 1) + "…";
}

// ── JSONL reader ──────────────────────────────────────────────────────────────

function readJsonlSession(filePath) {
  const lines = readFileSync(filePath, "utf8").split("\n").filter(Boolean);
  const messages = [];
  let sessionId = null;
  let cwd = null;
  let firstTimestamp = null;
  let lastTimestamp = null;
  let model = null;

  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (!sessionId && entry.sessionId) sessionId = entry.sessionId;
    if (!cwd && entry.cwd) cwd = entry.cwd;
    if (!firstTimestamp && entry.timestamp) firstTimestamp = entry.timestamp;
    if (entry.timestamp) lastTimestamp = entry.timestamp;

    if (entry.type === "user" || entry.type === "assistant") {
      const msg = entry.message ?? {};
      const role = msg.role ?? entry.type;
      const text = extractTextContent(msg.content);
      if (!text.trim()) continue;

      // Extract model hint from assistant messages
      if (role === "assistant" && !model) {
        // Sometimes encoded in summary or message fields
        model = entry.model ?? msg.model ?? null;
      }

      messages.push({
        uuid: entry.uuid ?? randomUUID(),
        role,
        text,
        timestamp: entry.timestamp ?? new Date().toISOString(),
      });
    }
  }

  return { sessionId, cwd, messages, firstTimestamp, lastTimestamp, model };
}

// ── Scan JSONL files ──────────────────────────────────────────────────────────

const sessions = [];

for (const projectSlug of readdirSync(projectsDir)) {
  const projectPath = join(projectsDir, projectSlug);
  if (!statSync(projectPath).isDirectory()) continue;

  for (const file of readdirSync(projectPath)) {
    if (!file.endsWith(".jsonl")) continue;
    const filePath = join(projectPath, file);

    let parsed;
    try {
      parsed = readJsonlSession(filePath);
    } catch (err) {
      console.warn(`  SKIP ${file}: ${err.message}`);
      continue;
    }

    if (!parsed.sessionId || parsed.messages.length === 0) continue;

    // Apply cwd filter if specified
    if (projectDirFilter && parsed.cwd && !parsed.cwd.includes(projectDirFilter)) continue;

    sessions.push({ ...parsed, filePath });
  }
}

console.log(`Found ${sessions.length} importable sessions in ${projectsDir}\n`);

if (sessions.length === 0) {
  console.log("Nothing to import.");
  process.exit(0);
}

// ── SQLite writes ─────────────────────────────────────────────────────────────

const db = dryRun ? null : new DatabaseSync(dbPath);

// Cache projects we've already inserted this run
const seenProjectIds = new Set();

let imported = 0;
let skipped = 0;

for (const session of sessions) {
  const { sessionId, cwd, messages, firstTimestamp, lastTimestamp, model: rawModel, filePath } = session;

  const workspaceRoot = cwd ?? "(unknown)";
  const projectTitle = basename(workspaceRoot) || workspaceRoot;
  const projectId = stableId(`claude-import:project:${workspaceRoot}`);
  const threadId = stableId(`claude-import:thread:${sessionId}`);
  const now = new Date().toISOString();
  const createdAt = firstTimestamp ?? now;
  const updatedAt = lastTimestamp ?? now;

  const firstUserMsg = messages.find(m => m.role === "user");
  const threadTitle = firstUserMsg
    ? truncate(firstUserMsg.text.split("\n")[0], 120)
    : `Session ${sessionId.slice(0, 8)}`;

  const providerHint = rawModel?.toLowerCase().includes("claude") === false ? "codex" : "claudeAgent";
  const modelId = rawModel ?? "claude-opus-4-5";
  const modelSelectionJson = JSON.stringify({ provider: providerHint, model: modelId });

  // Check if thread already exists
  if (!dryRun) {
    const existing = db.prepare("SELECT thread_id FROM projection_threads WHERE thread_id = ?").get(threadId);
    if (existing) {
      console.log(`  SKIP  ${sessionId.slice(0, 8)} (already imported)`);
      skipped++;
      continue;
    }
  }

  console.log(`  → ${sessionId.slice(0, 8)}  [${messages.length} msgs]  ${projectTitle}  "${truncate(threadTitle, 60)}"`);

  if (dryRun) {
    imported++;
    continue;
  }

  // Project (insert once per unique workspace root)
  if (!seenProjectIds.has(projectId)) {
    seenProjectIds.add(projectId);
    db.prepare(`
      INSERT OR IGNORE INTO projection_projects
        (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES (?, ?, ?, '[]', ?, ?)
    `).run(projectId, projectTitle, workspaceRoot, createdAt, updatedAt);
  }

  // Thread — uses model_selection_json (migration 016 dropped the plain model column)
  db.prepare(`
    INSERT OR IGNORE INTO projection_threads
      (thread_id, project_id, title, model_selection_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(threadId, projectId, threadTitle, modelSelectionJson, createdAt, updatedAt);

  // Messages
  const insertMsg = db.prepare(`
    INSERT OR IGNORE INTO projection_thread_messages
      (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
    VALUES (?, ?, ?, ?, 0, ?, ?)
  `);

  for (const msg of messages) {
    const messageId = stableId(`claude-import:msg:${msg.uuid}`);
    insertMsg.run(messageId, threadId, msg.role, msg.text, msg.timestamp, msg.timestamp);
  }

  // Thread session record (makes the thread resumable via Claude Code)
  db.prepare(`
    INSERT OR REPLACE INTO projection_thread_sessions
      (thread_id, status, provider_name, provider_session_id, updated_at)
    VALUES (?, 'idle', 'claudeAgent', ?, ?)
  `).run(threadId, sessionId, updatedAt);

  imported++;
}

if (!dryRun) db.close();

console.log();
console.log(`Done. Imported: ${imported}  Skipped: ${skipped}`);
if (imported > 0 && !dryRun) {
  console.log("Restart T3 to see imported sessions in the UI.");
}
