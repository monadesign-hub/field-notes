#!/usr/bin/env node
// Fetches upcoming AI events in San Francisco from Luma's public discover feed
// and injects them into index.html between the UPCOMING markers.
//
//   npm run fetch-events
//
// Then commit + push index.html to deploy. No server, no API key.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ── Config ──────────────────────────────────────────────────────────────────
const SF_PLACE_ID = "discplace-BDj7GNbGlsF7Cka"; // Luma "San Francisco" discover place
const API_URL = "https://api.lu.ma/discover/get-paginated-events";
const TZ = "America/Los_Angeles";
const PAGE_LIMIT = 50;
const MAX_PAGES = 30; // safety cap

const HERE = dirname(fileURLToPath(import.meta.url));
const HTML_PATH = join(HERE, "..", "index.html");
const START_MARKER = "<!-- UPCOMING:START -->";
const END_MARKER = "<!-- UPCOMING:END -->";

// ── AI / ML matcher (strict-ish: precision over recall) ──────────────────────
const AI_PHRASES = [
  "artificial intelligence", "machine learning", "deep learning",
  "generative", "gen ai", "genai", "neural net", "computer vision",
  "natural language", "data science", "mlops", "llmops", "fine-tun",
  "fine tun", "diffusion", "transformer", "multimodal", "embedding",
  "retrieval-augmented", "prompt engineering", "vibe coding", "agentic",
  "ai agent", "autonomous", "self-driving", "openai", "anthropic",
  "claude", "chatgpt", "llama", "mistral", "gemini", "hugging face",
  "pytorch", "tensorflow", "langchain", "copilot", "foundation model",
  "language model", "frontier model", "robotics", "inference",
  "reinforcement learning", "stable diffusion", "text-to-", "voice ai",
  "speech recognition", "neural", "datasets", "evals",
];
// Short, ambiguous tokens — require whole-word boundaries.
const AI_WORD_RE = /\b(ai|ml|llm|llms|agi|rag|gpt|nlp|agent|agents|model|models)\b/i;

function isAiEvent(name, calendarName) {
  const text = `${name} ${calendarName}`.toLowerCase();
  if (AI_PHRASES.some((p) => text.includes(p))) return true;
  return AI_WORD_RE.test(text);
}

// ── Date bounds: today → 15 days out (in local/Pacific time) ─────────────────
const WINDOW_DAYS = 15;
function dateBounds() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + WINDOW_DAYS, 23, 59, 59, 999);
  return { start, end };
}

// ── Fetch the SF discover feed, paging until we pass the end bound ───────────
async function fetchSfEvents(end) {
  const out = [];
  let cursor = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({
      discover_place_api_id: SF_PLACE_ID,
      pagination_limit: String(PAGE_LIMIT),
    });
    if (cursor) params.set("pagination_cursor", cursor);

    const res = await fetch(`${API_URL}?${params}`, {
      headers: { "User-Agent": "field-notes/1.0", Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`Luma API ${res.status} ${res.statusText}`);
    const data = await res.json();
    const entries = data.entries ?? [];
    out.push(...entries);

    const last = entries[entries.length - 1];
    const lastStart = last ? new Date(last.event.start_at) : null;
    if (!data.has_more || !data.next_cursor) break;
    if (lastStart && lastStart > end) break; // already past our window
    cursor = data.next_cursor;
  }
  return out;
}

// ── Shape one entry into the fields we render ────────────────────────────────
function shape(entry) {
  const ev = entry.event;
  const cal = entry.calendar ?? {};
  const start = new Date(ev.start_at);
  const isVirtual = ev.location_type !== "offline";
  const geo = ev.geo_address_info ?? {};
  const venue = isVirtual ? "Virtual" : (geo.city_state || geo.city || "San Francisco, CA");
  return {
    name: ev.name?.trim() || "Untitled event",
    url: `https://luma.com/${ev.url}`,
    start,
    venue,
    host: cal.name?.trim() || "",
    isFree: entry.ticket_info?.is_free === true,
    sortKey: ev.start_at,
  };
}

// ── HTML rendering ───────────────────────────────────────────────────────────
function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
const fmt = (d, opts) => new Intl.DateTimeFormat("en-US", { timeZone: TZ, ...opts }).format(d);
const dayKey = (d) => fmt(d, { year: "numeric", month: "2-digit", day: "2-digit" });

function renderItem(e) {
  const time = fmt(e.start, { hour: "numeric", minute: "2-digit", hour12: true });
  const sub = [`📍 ${esc(e.venue)}`, e.host && `· ${esc(e.host)}`].filter(Boolean).join(" ");
  return `      <a class="up-item" href="${esc(e.url)}" target="_blank" rel="noopener noreferrer">
        <div class="up-time">${esc(time)}</div>
        <div class="up-body">
          <div class="up-title">${esc(e.name)}${e.isFree ? '<span class="up-free">Free</span>' : ""}</div>
          <div class="up-sub">${sub}</div>
        </div>
        <span class="up-cta">RSVP</span>
      </a>`;
}

function renderSection(events) {
  if (events.length === 0) {
    return `\n    <div class="up-empty">No upcoming AI events found right now — check back soon.</div>\n  `;
  }
  // Group by calendar day (in Pacific time)
  const groups = new Map();
  for (const e of events) {
    const k = dayKey(e.start);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  const blocks = [];
  for (const [, list] of groups) {
    const header = fmt(list[0].start, { weekday: "long", month: "long", day: "numeric" });
    blocks.push(
      `    <div class="up-group">\n` +
      `      <div class="up-group-date">${esc(header)}</div>\n` +
      list.map(renderItem).join("\n") +
      `\n    </div>`
    );
  }

  const updated = fmt(new Date(), { month: "short", day: "numeric" });
  const meta =
    `    <div class="up-meta">${events.length} events · next ${WINDOW_DAYS} days · ` +
    `from <a href="https://luma.com/sf" target="_blank" rel="noopener noreferrer">Luma</a> · updated ${esc(updated)}</div>`;

  return `\n${meta}\n${blocks.join("\n")}\n  `;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const { start, end } = dateBounds();
  console.log(`[fetch-events] window ${dayKey(start)} → ${dayKey(end)} (${TZ})`);

  const raw = await fetchSfEvents(end);
  console.log(`[fetch-events] fetched ${raw.length} SF events from Luma`);

  const seen = new Set();
  const events = raw
    .map(shape)
    .filter((e) => {
      if (e.start < start || e.start > end) return false;        // date window
      if (!isAiEvent(e.name, e.host)) return false;              // AI filter
      if (seen.has(e.url)) return false;                          // dedupe
      seen.add(e.url);
      return true;
    })
    .sort((a, b) => a.sortKey.localeCompare(b.sortKey));

  console.log(`[fetch-events] ${events.length} AI events in window after filtering`);

  const section = renderSection(events);

  const html = await readFile(HTML_PATH, "utf8");
  const startIdx = html.indexOf(START_MARKER);
  const endIdx = html.indexOf(END_MARKER);
  if (startIdx === -1 || endIdx === -1) {
    throw new Error("Could not find UPCOMING:START / UPCOMING:END markers in index.html");
  }
  const before = html.slice(0, startIdx + START_MARKER.length);
  const after = html.slice(endIdx);
  const next = before + section + after;
  await writeFile(HTML_PATH, next);

  console.log(`[fetch-events] index.html updated ✓`);
}

main().catch((err) => {
  console.error(`[fetch-events] FAILED: ${err.message}`);
  process.exit(1);
});
