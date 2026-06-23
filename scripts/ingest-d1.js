#!/usr/bin/env node
/**
 * D1 ingestion script for taiwan-isbn-mcp
 *
 * Downloads monthly ISBN CSV files from the National Central Library,
 * generates SQL (with search_text column), and imports to Cloudflare D1.
 *
 * search_text = title + author + publisher + subject + keywords (concatenated)
 * Used by search_books for cross-field search. Future work: add 繁簡 normalization.
 *
 * Usage:
 *   export CF_ACCOUNT_ID="69abca4b..."
 *   export CF_API_TOKEN="<token with D1 Write permission>"
 *   export D1_DATABASE_ID="41e18b75-198a-41a9-a607-4ff1e0673382"  # optional, has default
 *   node scripts/ingest-d1.js
 *   node scripts/ingest-d1.js 202601 202602   # specific months only
 */

import { createHash } from "crypto";

const BASE_URL = "https://isbn.ncl.edu.tw/NEW_ISBNNet/opendata";
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const CF_API_TOKEN = process.env.CF_API_TOKEN;
const D1_DATABASE_ID = process.env.D1_DATABASE_ID || "41e18b75-198a-41a9-a607-4ff1e0673382";

if (!CF_ACCOUNT_ID || !CF_API_TOKEN) {
  console.error("Missing required env vars: CF_ACCOUNT_ID, CF_API_TOKEN");
  process.exit(1);
}

const D1_API = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/d1/database/${D1_DATABASE_ID}`;
const CF_HEADERS = { "Authorization": `Bearer ${CF_API_TOKEN}`, "Content-Type": "application/json" };

// CSV 欄位 → D1 欄名對照
const FIELD_MAP = {
  "申請書名":     "title",
  "作者":         "author",
  "出版機構":     "publisher",
  "版次":         "edition",
  "預訂出版日":   "pub_date",
  "適讀對象":     "audience",
  "分級註記":     "rating",
  "分類號":       "class_no",
  "ISBN":         "isbn",
  "頁數":         "pages",
  "資料類型":     "doc_type",
  "建議上架分類": "category",
  "作品語文":     "language",
  "圖書主題":     "subject",
  "是否為引進版權著作": "translated",
  "定價":         "price",
  "裝訂方式":     "binding",
  "出版形式":     "form",
  "關鍵字":       "keywords",
  "出版機構類型": "pub_type",
};

const COLS = [
  "isbn", "title", "author", "publisher", "edition", "pub_date", "ym",
  "audience", "rating", "class_no", "pages", "doc_type", "category", "language",
  "subject", "translated", "price", "binding", "form", "keywords", "pub_type",
  "search_text",
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function getMonthRange(specificMonths) {
  if (specificMonths && specificMonths.length > 0) return specificMonths;
  const months = [];
  const now = new Date();
  const currentYM = now.getFullYear() * 100 + (now.getMonth() + 1);
  let ym = 202401;
  while (ym <= currentYM) {
    months.push(String(ym));
    const y = Math.floor(ym / 100), m = ym % 100;
    ym = m === 12 ? (y + 1) * 100 + 1 : ym + 1;
  }
  return months;
}

function parseCSVLine(line) {
  const fields = [];
  let current = "", inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') { current += '"'; i++; }
        else inQuotes = false;
      } else current += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { fields.push(current); current = ""; }
      else if (ch !== '\r') current += ch;
    }
  }
  fields.push(current);
  return fields;
}

function parseCSV(csvText, month) {
  const lines = csvText.split("\n").filter(l => l.trim().length > 0);
  if (lines.length === 0) return [];
  let headerLine = lines[0];
  if (headerLine.charCodeAt(0) === 0xfeff) headerLine = headerLine.slice(1);
  const headers = parseCSVLine(headerLine);
  const records = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCSVLine(lines[i]);
    const row = { ym: month };
    for (let j = 0; j < headers.length; j++) {
      const col = FIELD_MAP[headers[j].trim()];
      const val = (fields[j] || "").trim();
      if (col && val) row[col] = val;
    }
    if (row.isbn || row.title) {
      // search_text: 書名+作者+出版機構+主題+關鍵字 合併，未來可加繁簡 normalize
      row.search_text = [row.title, row.author, row.publisher, row.subject, row.keywords]
        .filter(Boolean).join(" ");
      records.push(row);
    }
  }
  return records;
}

function escapeSql(val) {
  if (val === null || val === undefined) return "NULL";
  return "'" + String(val).replace(/'/g, "''") + "'";
}

function generateSQL(allRecords) {
  const lines = [];

  // DROP + CREATE ensures schema is always up to date (handles column additions)
  lines.push(`DROP TABLE IF EXISTS books;`);
  lines.push(`CREATE TABLE IF NOT EXISTS books (
  isbn        TEXT,
  title       TEXT,
  author      TEXT,
  publisher   TEXT,
  edition     TEXT,
  pub_date    TEXT,
  ym          TEXT,
  audience    TEXT,
  rating      TEXT,
  class_no    TEXT,
  pages       TEXT,
  doc_type    TEXT,
  category    TEXT,
  language    TEXT,
  subject     TEXT,
  translated  TEXT,
  price       TEXT,
  binding     TEXT,
  form        TEXT,
  keywords    TEXT,
  pub_type    TEXT,
  search_text TEXT
);`);

  lines.push(`CREATE INDEX IF NOT EXISTS idx_ym      ON books(ym);`);
  lines.push(`CREATE INDEX IF NOT EXISTS idx_isbn    ON books(isbn);`);
  lines.push(`CREATE INDEX IF NOT EXISTS idx_title   ON books(title);`);
  lines.push(`CREATE INDEX IF NOT EXISTS idx_author  ON books(author);`);
  lines.push(`DELETE FROM books;`);

  const BATCH = 100;
  for (let i = 0; i < allRecords.length; i += BATCH) {
    const batch = allRecords.slice(i, i + BATCH);
    const vals = batch.map(row =>
      "(" + COLS.map(c => escapeSql(row[c] ?? null)).join(", ") + ")"
    ).join(",\n  ");
    lines.push(`INSERT INTO books (${COLS.join(", ")}) VALUES\n  ${vals};`);
  }

  return lines.join("\n\n");
}

// ── D1 Import API ─────────────────────────────────────────────────────────────

async function importToD1(sqlContent) {
  const etag = createHash("md5").update(sqlContent).digest("hex");

  // Step 1: init → get upload_url + filename
  console.log("  [D1] init...");
  const initRes = await fetch(`${D1_API}/import`, {
    method: "POST",
    headers: CF_HEADERS,
    body: JSON.stringify({ action: "init", etag }),
  });
  const initData = await initRes.json();
  if (!initData.success) throw new Error(`init failed: ${JSON.stringify(initData.errors)}`);
  const { upload_url, filename } = initData.result;
  if (!upload_url) throw new Error(`init returned no upload_url: ${JSON.stringify(initData.result)}`);

  // Step 2: PUT SQL to R2 presigned URL
  const sizeMB = (Buffer.byteLength(sqlContent, "utf8") / 1024 / 1024).toFixed(1);
  console.log(`  [D1] uploading ${sizeMB} MB...`);
  const uploadRes = await fetch(upload_url, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: sqlContent,
  });
  if (!uploadRes.ok) throw new Error(`upload failed: HTTP ${uploadRes.status}`);

  // Step 3: ingest
  console.log("  [D1] ingest...");
  const ingestRes = await fetch(`${D1_API}/import`, {
    method: "POST",
    headers: CF_HEADERS,
    body: JSON.stringify({ action: "ingest", filename, etag }),
  });
  const ingestData = await ingestRes.json();
  if (!ingestData.success) throw new Error(`ingest failed: ${JSON.stringify(ingestData.errors)}`);

  const ingestResult = ingestData.result;
  if (ingestResult.messages?.length) console.log(`    ${ingestResult.messages.join(", ")}`);

  // If already complete (small imports finish synchronously)
  if (ingestResult.status === "complete") {
    const meta = ingestResult.result?.meta;
    if (meta) console.log(`    rows_written: ${meta.rows_written}, changes: ${meta.changes}`);
    return;
  }

  // Step 4: poll until complete using at_bookmark
  const atBookmark = ingestResult.at_bookmark;
  if (!atBookmark) throw new Error(`ingest returned no at_bookmark: ${JSON.stringify(ingestResult)}`);

  console.log("  [D1] polling...");
  for (;;) {
    await new Promise(r => setTimeout(r, 2000));
    const pollRes = await fetch(`${D1_API}/import`, {
      method: "POST",
      headers: CF_HEADERS,
      body: JSON.stringify({ action: "poll", current_bookmark: atBookmark }),
    });
    const pollData = await pollRes.json();
    if (!pollData.success) throw new Error(`poll failed: ${JSON.stringify(pollData.errors)}`);
    const { status, messages, result: pollResult } = pollData.result;
    if (messages?.length) console.log(`    ${messages.join(", ")}`);
    if (status === "complete") {
      const meta = pollResult?.meta;
      if (meta) console.log(`    rows_written: ${meta.rows_written}, changes: ${meta.changes}`);
      break;
    }
    if (status === "error") throw new Error(`import error: ${JSON.stringify(pollData.result)}`);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const months = getMonthRange(args.length > 0 ? args : null);
  console.log(`Processing ${months.length} months: ${months[0]} ~ ${months[months.length - 1]}`);

  const allRecords = [];
  for (const month of months) {
    process.stdout.write(`\n${month}... `);
    const url = `${BASE_URL}/${month}_isbn.csv`;
    const res = await fetch(url);
    if (!res.ok) { console.log(`HTTP ${res.status}, skip`); continue; }
    const csv = await res.text();
    const records = parseCSV(csv, month);
    console.log(`${records.length} records`);
    allRecords.push(...records);
  }

  console.log(`\nTotal: ${allRecords.length} records`);
  console.log("Generating SQL...");
  const sql = generateSQL(allRecords);
  console.log(`SQL: ${(sql.length / 1024 / 1024).toFixed(1)} MB`);

  console.log("Importing to D1...");
  await importToD1(sql);

  console.log("\nDone!");
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
