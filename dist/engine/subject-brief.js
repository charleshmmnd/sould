// Subject brief (0.10.14): when the assistant's own tool calls name a subject
// the graph holds notes on, hand it the latest of those notes right then.
//
// 2026-11-11, on the live graph. The user's prompts for an hour were short and
// angry ("UPDATE THE SITE"), so prompt-driven retrieval was correctly quiet
// (0.10.9: a prompt with no signal word retrieves nothing). Meanwhile every
// tool call the assistant made named a partner whose feed had gone stale. The
// graph held 40 notes on that partner, including one from six days earlier
// that said the partner had shut the feed off and that an export had been
// asked for. The assistant never looked, spent the hour proving the feed was
// frozen from file dates, and drafted a note to "their contact" asking what
// she had already answered. Retrieval follows the user's words; on a day when
// those words carry no topic, the topic is in the work.
//
// How it decides what a subject is: a word from the tool input that a small
// share of the stored memories mention. Measured on that graph (8,720
// memories): a partner or client name sits between 3 and 110 notes, a person's
// surname at 6, while tooling words (python 244, nginx 238, build 1,258) and
// the user's own site names (300 to 430) sit far above. So the test is
// document frequency between MIN_DF and a ceiling of about 1.4 percent of the
// memory table. No list of names is kept anywhere.
//
// Each subject is briefed once per session. Compaction clears the record (the
// model lost the brief with the rest of its window), and a prompt with no
// retrieval signal re-arms subjects briefed on earlier turns, because a user
// who has stopped naming the topic is usually a user who has been let down on
// it. Everything fails open: a slow or failed lookup returns nothing and the
// tool call proceeds.
import { RATIONALE_STOPWORDS, isNoiseWord } from "./stopwords.js";
import { swallow } from "./errors.js";
export const SUBJECT_MIN_DF = 2;
/** Ceiling as a share of the memory table, with a floor for small graphs. */
export const SUBJECT_MAX_DF_SHARE = 0.014;
export const SUBJECT_MAX_DF_FLOOR = 40;
const MAX_NEW_TERMS_PER_CALL = 12;
const MAX_TERMS_PER_BRIEF = 2;
const NOTES_PER_TERM = 3;
const NOTE_CHARS = 380;
const MAX_BRIEFS_PER_SESSION = 16;
const LOOKUP_BUDGET_MS = 1000;
const DF_TTL_MS = 6 * 60 * 60 * 1000;
const DF_CACHE_MAX = 5000;
const INPUT_SCAN_CHARS = 4096;
const REARM_AFTER_TURNS = 2;
// Words that fill shell commands, paths and code and never name a subject.
// The frequency test would reject most of them anyway; listing them saves the
// lookups.
const TOOLING_WORDS = new Set([
    "ubuntu", "python", "python3", "nginx", "bash", "shell", "script", "scripts", "import", "print", "return",
    "false", "true", "null", "none", "undefined", "const", "function", "class", "async", "await", "export",
    "default", "string", "number", "object", "array", "index", "value", "values", "param", "params", "input",
    "output", "result", "results", "response", "request", "header", "headers", "content", "contents", "query",
    "select", "where", "order", "limit", "group", "count", "table", "tables", "column", "columns", "field",
    "fields", "record", "records", "insert", "delete", "create", "remove", "rename", "config", "configs",
    "setting", "settings", "option", "options", "users", "local", "share", "cache", "files", "folder", "folders",
    "directory", "source", "sources", "target", "public", "private", "static", "assets", "images", "image",
    "style", "styles", "template", "templates", "layout", "pages", "website", "sites", "domain", "server",
    "servers", "client", "clients", "service", "services", "system", "network", "timeout", "background",
    "description", "command", "commands", "pattern", "strict", "sudo", "chmod", "mkdir", "touch", "echo",
    "grep", "rsync", "crontab", "nohup", "sleep", "tail", "head", "curl", "wget", "https", "http", "html",
    "json", "yaml", "toml", "xml", "utf", "ascii", "charles", "claude", "home", "tmp", "mnt", "scratchpad",
    "tasks", "session", "sessions", "memory", "memories", "recall", "sould", "node", "modules", "dist", "src",
    "test", "tests", "main", "master", "origin", "branch", "commit", "push", "pull", "rebase", "merge", "diff",
    "stash", "remote", "clone", "fetch", "github", "readme", "license", "package", "version", "release",
    "install", "update", "upgrade", "daemon", "plugin", "plugins", "hooks", "hook", "logs", "error", "errors",
    "warning", "debug", "stdout", "stderr", "stdin", "devnull", "xargs", "awk", "sed", "sort", "uniq", "find",
    "replace", "string", "strings", "lines", "line", "words", "word", "chars", "bytes", "dates", "date",
    "since", "until", "first", "last", "next", "prev", "previous", "current", "latest", "oldest", "newest",
    "start", "stop", "restart", "reload", "enable", "disable", "status", "check", "verify", "verified",
    "property", "properties", "listing", "listings", "house", "houses", "beach", "shore", "destination",
    "destinations", "email", "emails", "inbox", "mailbox", "message", "messages", "subject", "reply",
]);
const dfCache = new Map();
let memoryTotal = null;
/** @internal test hook */
export function _resetSubjectBriefCaches() {
    dfCache.clear();
    memoryTotal = null;
}
function enabled() {
    const v = (process.env.SOULD_SUBJECT_BRIEF ?? "").toLowerCase();
    return v !== "0" && v !== "false" && v !== "off";
}
/**
 * The text of a tool call that says what the work is about. File bodies are
 * left out on purpose: an Edit that pastes a page of prose would name every
 * noun in it.
 */
export function toolInputSubjectText(toolName, toolInput) {
    if (!toolInput)
        return "";
    const pick = (...keys) => keys.map((k) => (typeof toolInput[k] === "string" ? toolInput[k] : "")).filter(Boolean).join(" ");
    let text;
    if (toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit" || toolName === "Read" || toolName === "NotebookEdit") {
        text = pick("file_path", "notebook_path");
    }
    else if (toolName === "Bash") {
        text = pick("command", "description");
    }
    else if (toolName === "Grep" || toolName === "Glob") {
        text = pick("pattern", "path", "glob");
    }
    else {
        text = Object.entries(toolInput)
            .filter(([k, v]) => typeof v === "string" && !/content|body|html|text|code|script|old_string|new_string/i.test(k))
            .map(([, v]) => v).join(" ");
    }
    return text.slice(0, INPUT_SCAN_CHARS);
}
/** Words of `text` that could be a subject: letters only, 5 to 24 long, not chatter, not tooling. */
export function extractSubjectCandidates(text) {
    const seen = new Set();
    const out = [];
    for (const raw of (text ?? "").split(/[^A-Za-z]+/)) {
        if (raw.length < 5 || raw.length > 24)
            continue;
        const w = raw.toLowerCase();
        if (seen.has(w) || TOOLING_WORDS.has(w) || isNoiseWord(w, RATIONALE_STOPWORDS))
            continue;
        seen.add(w);
        out.push(w);
    }
    return out;
}
async function withBudget(p, ms, fallback) {
    let timer;
    try {
        return await Promise.race([
            p,
            new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); }),
        ]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
const LIVE = "(status = 'active' OR status IS NONE)";
async function memoryCount(store, now) {
    if (memoryTotal && now - memoryTotal.at < DF_TTL_MS)
        return memoryTotal.n;
    const rows = await store.queryFirst(`SELECT count() AS n FROM memory WHERE ${LIVE} GROUP ALL`);
    memoryTotal = { n: Number(rows[0]?.n ?? 0), at: now };
    return memoryTotal.n;
}
async function documentFrequency(store, term, now) {
    const hit = dfCache.get(term);
    if (hit && now - hit.at < DF_TTL_MS)
        return hit.n;
    const rows = await store.queryFirst(`SELECT count() AS n FROM memory WHERE text @1@ $t AND ${LIVE} GROUP ALL`, { t: term });
    const n = Number(rows[0]?.n ?? 0);
    if (dfCache.size >= DF_CACHE_MAX)
        dfCache.clear();
    dfCache.set(term, { n, at: now });
    return n;
}
export function subjectDfCeiling(total) {
    return Math.max(SUBJECT_MAX_DF_FLOOR, Math.round(total * SUBJECT_MAX_DF_SHARE));
}
function day(v) {
    const s = v instanceof Date ? v.toISOString() : String(v ?? "");
    const m = s.match(/\d{4}-\d{2}-\d{2}/);
    return m ? m[0] : "undated";
}
function clip(text, max) {
    const flat = String(text ?? "").replace(/\s+/g, " ").trim();
    if (flat.length <= max)
        return flat;
    const cut = flat.slice(0, max);
    const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("; "));
    return (stop > max * 0.6 ? cut.slice(0, stop + 1) : cut.replace(/\s+\S*$/, "")) + " [cut]";
}
/**
 * Called from PreToolUse. Returns the brief text when this tool call names a
 * subject not yet briefed in this session, else null. Never throws.
 */
export async function buildSubjectBrief(store, session, toolName, toolInput, now = Date.now()) {
    try {
        return await brief(store, session, toolName, toolInput, now);
    }
    catch (e) {
        // A hook must not fail a tool call over a brief.
        swallow.warn("subject-brief", e);
        return null;
    }
}
async function brief(store, session, toolName, toolInput, now) {
    if (!enabled() || !store.isAvailable())
        return null;
    // The memory tools answer for themselves; briefing on a recall query would echo it.
    if (toolName.includes("sould"))
        return null;
    if (session._subjectBriefCount >= MAX_BRIEFS_PER_SESSION)
        return null;
    const fresh = extractSubjectCandidates(toolInputSubjectText(toolName, toolInput))
        .filter((w) => !session._subjectTermsRejected.has(w) && !session._subjectsBriefed.has(w))
        .slice(0, MAX_NEW_TERMS_PER_CALL);
    if (fresh.length === 0)
        return null;
    // The lookup reports what it found; the session is only marked once the
    // brief is really going back to the model. A lookup that loses the race
    // keeps running, warms the frequency cache, and marks nothing, so the next
    // call that names the subject gets the brief.
    let found = null;
    try {
        found = await withBudget(lookUp(store, session, fresh, now), LOOKUP_BUDGET_MS, null);
    }
    catch (e) {
        swallow.warn("subject-brief:lookup", e);
        return null;
    }
    if (!found)
        return null;
    for (const w of found.terms)
        session._subjectsBriefed.set(w, session.userTurnCount);
    if (!found.text)
        return null;
    session._subjectBriefCount += 1;
    return found.text;
}
async function lookUp(store, session, fresh, now) {
    const total = await memoryCount(store, now);
    const ceiling = subjectDfCeiling(total);
    const dfs = await Promise.all(fresh.map(async (w) => ({ w, n: await documentFrequency(store, w, now) })));
    const subjects = [];
    for (const { w, n } of dfs) {
        if (n >= SUBJECT_MIN_DF && n <= ceiling)
            subjects.push({ w, n });
        else
            session._subjectTermsRejected.add(w);
    }
    if (subjects.length === 0)
        return null;
    // The rarest word is the most name-like. The rest stay un-briefed, so a
    // later call that names them again gets its own brief.
    subjects.sort((a, b) => a.n - b.n);
    const chosen = subjects.slice(0, MAX_TERMS_PER_BRIEF);
    // Notes this session wrote are already in the model's window.
    const before = new Date(session.createdAtMs);
    const seenNotes = new Set();
    const sections = [];
    for (const { w, n } of chosen) {
        const where = `text @1@ $t AND ${LIVE} AND created_at < $before`;
        const [rows, corrections] = await Promise.all([
            store.queryFirst(`SELECT id, text, created_at FROM memory WHERE ${where} ORDER BY created_at DESC LIMIT ${NOTES_PER_TERM}`, { t: w, before }),
            // The newest correction about the subject rides along even when newer
            // notes have pushed it out of the top few: it is the note that was
            // written because this subject already went wrong once.
            store.queryFirst(`SELECT id, text, created_at FROM memory WHERE ${where} AND string::starts_with(text, '[CORRECTION]') ` +
                `ORDER BY created_at DESC LIMIT 1`, { t: w, before }),
        ]);
        const lines = [...rows, ...corrections]
            .filter((r) => { const k = String(r.id); if (seenNotes.has(k))
            return false; seenNotes.add(k); return true; })
            .map((r) => `- ${day(r.created_at)} ${clip(r.text, NOTE_CHARS)}`);
        if (lines.length > 0)
            sections.push(`"${w}" (${n} notes in memory), newest first:\n${lines.join("\n")}`);
    }
    const terms = chosen.map((c) => c.w);
    if (sections.length === 0)
        return { terms, text: null };
    return { terms, text: [
            "[Sould] Subject brief. The work in this tool call names a subject the memory graph already holds notes on.",
            ...sections,
            "Earlier sessions saved these. Read them before diagnosing, deciding or drafting anything about this subject, " +
                "and call recall with the subject's name for the rest. Each note is a claim about the past: " +
                "check it against the live system before acting on it.",
        ].join("\n") };
}
/**
 * A prompt with no retrieval signal re-arms subjects briefed two or more user
 * turns ago, so the next tool call that names one is briefed again. Called
 * from UserPromptSubmit before the turn counter moves. The two-turn gap keeps
 * a run of "yes" and "ok" from repeating a brief the model has just read.
 */
export function rearmSubjectBriefs(session) {
    let n = 0;
    for (const [w, turn] of session._subjectsBriefed) {
        if (session.userTurnCount - turn >= REARM_AFTER_TURNS) {
            session._subjectsBriefed.delete(w);
            n += 1;
        }
    }
    return n;
}
/** Compaction dropped every brief from the window: start over. */
export function resetSubjectBriefs(session) {
    session._subjectsBriefed.clear();
    session._subjectBriefCount = 0;
}
