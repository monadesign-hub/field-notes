#!/usr/bin/env node
// Fetches the latest news from OpenAI, Anthropic, and Google's official sites
// and injects a three-card "Daily Briefing" section into index.html.
//
//   npm run fetch-news
//
// OpenAI + Google publish RSS feeds; Anthropic has no feed, so we parse its
// public newsroom page. Build-time only — no server, no API key.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const HTML_PATH = join(HERE, "..", "index.html");
const START_MARKER = "<!-- NEWS:START -->";
const END_MARKER = "<!-- NEWS:END -->";
const PER_CARD = 3; // latest N headlines per company
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) field-notes/1.0";

const SOURCES = [
  { key: "openai", name: "OpenAI", site: "https://openai.com/news/", kind: "rss", feed: "https://openai.com/blog/rss.xml" },
  { key: "anthropic", name: "Anthropic", site: "https://www.anthropic.com/news", kind: "anthropic", feed: "https://www.anthropic.com/news" },
  { key: "google", name: "Google", site: "https://blog.google/technology/ai/", kind: "rss", feed: "https://blog.google/technology/ai/rss/" },
];

// ── Tiny HTML/feed helpers (no deps) ─────────────────────────────────────────
const pick = (s, re) => { const m = s.match(re); return m ? m[1] : ""; };
const stripTags = (s) => s.replace(/<[^>]+>/g, "");

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  "#39": "'", "#34": '"', "#8217": "’", "#8216": "‘",
  "#8220": "“", "#8221": "”", "#8211": "–", "#8212": "—",
  "#8230": "…", "#38": "&",
};
function decode(s) {
  return s.replace(/&(#?\w+);/g, (m, e) => {
    if (e in ENTITIES) return ENTITIES[e];
    if (e[0] === "#") {
      const code = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return m;
  }).trim();
}
function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

async function get(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "*/*" } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.text();
}

// ── Parsers ──────────────────────────────────────────────────────────────────
function parseRss(xml) {
  const out = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const b = m[1];
    const title = pick(b, /<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
    const link = pick(b, /<link>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/);
    const date = pick(b, /<pubDate>([\s\S]*?)<\/pubDate>/) || pick(b, /<dc:date>([\s\S]*?)<\/dc:date>/);
    if (!title || !link) continue;
    out.push({ title: decode(stripTags(title)), url: link.trim(), date: date ? new Date(date) : null });
  }
  return out;
}

function parseAnthropic(html) {
  const out = [];
  const seen = new Set();
  for (const m of html.matchAll(/<a[^>]+href="(\/news\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const inner = m[2];
    const title = pick(inner, /class="[^"]*title[^"]*"[^>]*>([\s\S]*?)<\/span>/);
    if (!title) continue;
    const url = "https://www.anthropic.com" + m[1];
    if (seen.has(url)) continue;
    seen.add(url);
    const date = pick(inner, /<time[^>]*>([\s\S]*?)<\/time>/);
    out.push({ title: decode(stripTags(title)), url, date: date ? new Date(date) : null });
  }
  return out;
}

async function loadSource(src) {
  const raw = await get(src.feed);
  const items = src.kind === "rss" ? parseRss(raw) : parseAnthropic(raw);
  // newest first; items without a date keep page order (already newest-first)
  items.sort((a, b) => (b.date?.getTime() || 0) - (a.date?.getTime() || 0));
  return items.slice(0, PER_CARD);
}

// ── Rendering ────────────────────────────────────────────────────────────────
const fmtDate = (d) =>
  d ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(d) : "";

function renderCard(src, items, ok) {
  const rows = ok && items.length
    ? items.map((it) =>
        `        <li><a class="news-item" href="${esc(it.url)}" target="_blank" rel="noopener noreferrer">` +
        `<span class="news-date">${esc(fmtDate(it.date))}</span>` +
        `<span class="news-title">${esc(it.title)}</span></a></li>`
      ).join("\n")
    : `        <li class="news-empty">Couldn't load right now.</li>`;
  return `    <div class="news-card news-${src.key}">
      <a class="news-card-head" href="${esc(src.site)}" target="_blank" rel="noopener noreferrer">
        <span class="news-co">${esc(src.name)}</span><span class="news-arrow">↗</span>
      </a>
      <ul class="news-list">
${rows}
      </ul>
    </div>`;
}

function renderSection(cards) {
  const updated = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date());
  return `\n    <div class="news-meta">Latest from the labs · updated ${esc(updated)}</div>\n` +
    `    <div class="news-grid">\n${cards.join("\n")}\n    </div>\n  `;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const results = await Promise.allSettled(SOURCES.map(loadSource));
  const cards = SOURCES.map((src, i) => {
    const r = results[i];
    if (r.status === "fulfilled") {
      console.log(`[fetch-news] ${src.name}: ${r.value.length} items`);
      return renderCard(src, r.value, true);
    }
    console.warn(`[fetch-news] ${src.name}: FAILED — ${r.reason.message}`);
    return renderCard(src, [], false);
  });

  const section = renderSection(cards);
  const html = await readFile(HTML_PATH, "utf8");
  const s = html.indexOf(START_MARKER);
  const e = html.indexOf(END_MARKER);
  if (s === -1 || e === -1) throw new Error("Could not find NEWS:START / NEWS:END markers in index.html");
  const next = html.slice(0, s + START_MARKER.length) + section + html.slice(e);
  await writeFile(HTML_PATH, next);
  console.log("[fetch-news] index.html updated ✓");
}

main().catch((err) => {
  console.error(`[fetch-news] FAILED: ${err.message}`);
  process.exit(1);
});
