#!/usr/bin/env node
/**
 * Pulls the fulfillment score column out of the Deliberate Living sheet and
 * writes scores.json as [{ date: "YYYY-MM-DD", score: 92.3 }, ...].
 *
 * Only columns A (date) and AG (Fulfillment score) are requested, so this
 * downloads ~110KB instead of the ~9MB the full tab weighs.
 *
 * Usage: node scripts/build-scores.mjs
 * Env:   SCORES_CSV_URL — a "Publish to web" CSV URL for a two-column feed tab.
 *                         Preferred: it works when the document itself is
 *                         Restricted, and its 2PACX id does not reveal the
 *                         real spreadsheet id.
 *        SHEET_ID, SHEET_GID — fallback gviz path, only works while the
 *                         document is readable by anyone with the link.
 */

import { writeFile, readFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const SHEET_ID = process.env.SHEET_ID ?? "1eGDFvkE8t7qI44kOr91k-0XyHj0g7o7k7Q1enokXgiw";
const SHEET_GID = process.env.SHEET_GID ?? "495611238";
const OUT = resolve(process.cwd(), "scores.json");

// Refuse to publish a file that lost a big chunk of history — a permissions
// change or a renamed tab shows up as a near-empty CSV, not as an error.
const MIN_ROWS = 3000;

// "AG * 1" is deliberate: a plain "select A, AG" returns the cell as *displayed*,
// and column AG carries a 0.0% format, so the CSV would hand back "56.3%" for a
// value that is really 56.25%. Multiplying drops the display format and returns
// the underlying number.
const url =
  process.env.SCORES_CSV_URL ??
  `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq` +
    `?tqx=out:csv&gid=${SHEET_GID}&tq=${encodeURIComponent("select A, AG * 1")}`;

/** Minimal RFC4180 parser — the date column contains commas inside quotes. */
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; }
        else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const MONTHS = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

/**
 * "Wednesday, September 16, 2026" -> "2026-09-16".
 * The weekday comma is missing on a handful of 2019 rows, so it's optional.
 */
function parseDate(raw) {
  const m = raw
    .trim()
    .replace(/^[A-Za-z]+,?\s+/, "")
    .match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/);
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase()];
  if (month === undefined) return null;
  const d = new Date(Date.UTC(Number(m[3]), month, Number(m[2])));
  if (d.getUTCDate() !== Number(m[2])) return null;
  return d.toISOString().slice(0, 10);
}

const res = await fetch(url, { redirect: "follow" });
if (!res.ok) throw new Error(`Sheet fetch failed: ${res.status} ${res.statusText}`);
const csv = await res.text();

if (csv.trimStart().startsWith("<")) {
  throw new Error(
    "Sheet returned HTML, not CSV — the tab is probably no longer readable by this caller.",
  );
}

const rows = parseCsv(csv);

// A feed tab may start straight in on data; the raw tab starts with a header.
// Only treat row 1 as a header if it isn't already a date row.
if (rows.length && !parseDate(rows[0][0] ?? "")) {
  const header = rows.shift();
  const label = header[1] ?? "";
  // Guard against a column being inserted upstream, which would silently feed
  // the grid the wrong numbers rather than fail.
  if (label && !/fulfillment|score/i.test(label)) {
    throw new Error(
      `Second column is "${label}", expected the fulfillment score. ` +
        `A column probably moved — fix the source range before trusting this output.`,
    );
  }
}

/**
 * Accepts either form the sheet can hand us and keeps full precision:
 *   "0.5625" — a raw fraction (feed tab formatted as a plain number)
 *   "56.3%"  — already a percentage, rounded by the cell's display format
 * Rounding is left to the component's toFixed(1), so no precision is thrown
 * away here. A genuine 0% stays 0; a genuine 100% reads as 100, not 10000.
 */
function parseScore(text) {
  const n = Number.parseFloat(text.replace("%", "").trim());
  if (!Number.isFinite(n)) return null;
  if (text.includes("%")) return n;
  return n > 0 && n <= 1 ? n * 100 : n;
}

const seen = new Map();
const skipped = [];
const datelessWithScore = [];

for (const [rawDate, rawScore] of rows) {
  const dateText = (rawDate ?? "").trim();
  const scoreText = (rawScore ?? "").trim();

  // A scored row with no date is a hole in the sheet, not a blank future row.
  // Report it rather than dropping it quietly — that's how 2019-05-20 went
  // missing without anyone noticing.
  if (!dateText) {
    if (scoreText) datelessWithScore.push(scoreText);
    continue;
  }
  if (!scoreText) continue; // future rows are pre-dated with an empty score

  const date = parseDate(dateText);
  if (!date) { skipped.push(dateText); continue; }

  const score = parseScore(scoreText);
  if (score === null) { skipped.push(`${dateText} -> "${scoreText}"`); continue; }

  // 4dp is far finer than a checklist of ~16 yes/no answers can express, and
  // renders identically under toFixed(1) — it just keeps the file 18% smaller
  // than carrying 33.33333333333333 around.
  seen.set(date, Math.round(score * 1e4) / 1e4); // last row wins on duplicate dates
}

const scores = [...seen.entries()]
  .map(([date, score]) => ({ date, score }))
  .sort((a, b) => a.date.localeCompare(b.date));

if (scores.length < MIN_ROWS) {
  throw new Error(`Only parsed ${scores.length} rows (expected >= ${MIN_ROWS}). Refusing to write.`);
}

// Keep the file byte-identical when nothing changed, so the daily commit is a
// genuine no-op on days the sheet hasn't moved.
const next = JSON.stringify(scores) + "\n";
const prev = await readFile(OUT, "utf8").catch(() => null);
if (prev === next) {
  console.log(`No change — ${scores.length} days, latest ${scores.at(-1).date}`);
  process.exit(0);
}

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, next);

console.log(
  `Wrote ${scores.length} days to scores.json ` +
    `(${scores[0].date} -> ${scores.at(-1).date}, latest score ${scores.at(-1).score}%)`,
);
if (skipped.length) console.warn(`Skipped ${skipped.length} unparseable row(s):`, skipped.slice(0, 5));
if (datelessWithScore.length) {
  console.warn(
    `${datelessWithScore.length} row(s) have a score but no date in column A, ` +
      `so they are missing from the grid: ${datelessWithScore.join(", ")}`,
  );
}
