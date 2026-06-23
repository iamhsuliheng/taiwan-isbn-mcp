#!/usr/bin/env node
/**
 * Data ingestion script for taiwan-isbn-mcp
 *
 * Downloads monthly ISBN CSV files from the National Central Library open data,
 * processes them into compact JSON, and uploads to Cloudflare KV.
 *
 * Usage:
 *   # Set environment variables
 *   export CF_ACCOUNT_ID="your_account_id"
 *   export CF_API_TOKEN="your_api_token"
 *   export KV_NAMESPACE_ID="your_kv_namespace_id"
 *
 *   # Run ingestion
 *   node scripts/ingest.js
 *
 *   # Or only ingest specific months
 *   node scripts/ingest.js 202601 202602
 */

const BASE_URL = "https://isbn.ncl.edu.tw/NEW_ISBNNet/opendata";
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const CF_API_TOKEN = process.env.CF_API_TOKEN;
const KV_NAMESPACE_ID = process.env.KV_NAMESPACE_ID;

if (!CF_ACCOUNT_ID || !CF_API_TOKEN || !KV_NAMESPACE_ID) {
  console.error("Missing environment variables: CF_ACCOUNT_ID, CF_API_TOKEN, KV_NAMESPACE_ID");
  process.exit(1);
}

const KV_API = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${KV_NAMESPACE_ID}`;

function getMonthRange(specificMonths) {
  if (specificMonths && specificMonths.length > 0) return specificMonths;
  const months = [];
  const now = new Date();
  const currentYM = now.getFullYear() * 100 + (now.getMonth() + 1);
  let ym = 202401;
  while (ym <= currentYM) {
    months.push(String(ym));
    const y = Math.floor(ym / 100);
    const m = ym % 100;
    if (m === 12) ym = (y + 1) * 100 + 1;
    else ym++;
  }
  return months;
}

function parseCSVLine(line) {
  const fields = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        fields.push(current);
        current = "";
      } else if (ch === "\r") {
        // skip
      } else {
        current += ch;
      }
    }
  }
  fields.push(current);
  return fields;
}

const FIELD_MAP = {
  "申請書名": "t", "作者": "a", "出版機構": "p", "版次": "e",
  "預訂出版日": "d", "適讀對象": "au", "分級註記": "r", "分類號": "c",
  "ISBN": "i", "頁數": "pg", "資料類型": "tp", "建議上架分類": "cat",
  "作品語文": "lang", "圖書主題": "sub", "是否為引進版權著作": "tr",
  "定價": "price", "裝訂方式": "bind", "出版形式": "form",
  "關鍵字": "kw", "出版機構類型": "pt",
};

async function downloadCSV(month) {
  const url = `${BASE_URL}/${month}_isbn.csv`;
  console.log(`  Downloading ${url}...`);
  const res = await fetch(url);
  if (!res.ok) {
    console.log(`  ${month}: HTTP ${res.status}, skipping`);
    return null;
  }
  return await res.text();
}

function parseCSV(csvText) {
  const lines = csvText.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  let headerLine = lines[0];
  if (headerLine.charCodeAt(0) === 0xfeff) headerLine = headerLine.slice(1);
  const headers = parseCSVLine(headerLine);
  const records = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCSVLine(lines[i]);
    const record = {};
    for (let j = 0; j < headers.length; j++) {
      const header = headers[j].trim();
      const value = (fields[j] || "").trim();
      const key = FIELD_MAP[header];
      if (key && value) record[key] = value;
    }
    if (record.i || record.t) records.push(record);
  }
  return records;
}

async function kvPut(key, value) {
  const res = await fetch(`${KV_API}/values/${encodeURIComponent(key)}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${CF_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: typeof value === "string" ? value : JSON.stringify(value),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`KV PUT ${key} failed: ${res.status} ${text}`);
  }
  return true;
}

async function main() {
  const args = process.argv.slice(2);
  const months = getMonthRange(args.length > 0 ? args : null);
  console.log(`Processing ${months.length} months: ${months[0]} ~ ${months[months.length - 1]}`);

  const allMonthsData = {};
  const isbnIndex = {};
  let totalRecords = 0;

  for (const month of months) {
    console.log(`\nProcessing ${month}...`);
    const csv = await downloadCSV(month);
    if (!csv) continue;
    const records = parseCSV(csv);
    console.log(`  Parsed ${records.length} records`);
    if (records.length === 0) continue;
    for (const rec of records) {
      if (rec.i) isbnIndex[rec.i] = month;
    }
    totalRecords += records.length;
    allMonthsData[month] = records;
  }

  console.log(`\nTotal: ${totalRecords} records, ${Object.keys(isbnIndex).length} ISBNs`);
  console.log(`\nUploading to KV...`);

  const successMonths = [];
  for (const [month, records] of Object.entries(allMonthsData)) {
    const json = JSON.stringify(records);
    const sizeKB = Buffer.byteLength(json, "utf8") / 1024;
    console.log(`  month:${month} — ${records.length} records, ${sizeKB.toFixed(0)} KB`);
    await kvPut(`month:${month}`, json);
    successMonths.push(month);
  }

  const indexJson = JSON.stringify(isbnIndex);
  const indexSizeKB = Buffer.byteLength(indexJson, "utf8") / 1024;
  console.log(`  isbn_index — ${Object.keys(isbnIndex).length} entries, ${indexSizeKB.toFixed(0)} KB`);
  await kvPut("isbn_index", indexJson);

  successMonths.sort();
  const meta = {
    months: successMonths,
    totalRecords,
    totalISBNs: Object.keys(isbnIndex).length,
    lastUpdate: new Date().toISOString().split("T")[0],
  };
  console.log(`  meta:info`);
  await kvPut("meta:info", JSON.stringify(meta));

  console.log(`\nDone! Uploaded ${successMonths.length} months + index + meta = ${successMonths.length + 2} KV keys.`);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
