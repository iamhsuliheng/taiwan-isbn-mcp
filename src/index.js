import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

const ATTRIBUTION = `資料來源：國家圖書館「臺灣出版新書預告書訊」，依政府資料開放授權條款第1版（https://data.gov.tw/license）公眾釋出。`;
const BASE_CSV_URL = "https://isbn.ncl.edu.tw/NEW_ISBNNet/opendata";

const FIELD_NAMES = {
  t: "書名", a: "作者", p: "出版機構", e: "版次", d: "預訂出版日",
  au: "適讀對象", r: "分級註記", c: "分類號", i: "ISBN",
  pg: "頁數", tp: "資料類型", cat: "建議上架分類", lang: "作品語文",
  sub: "圖書主題", tr: "是否為引進版權著作", price: "定價",
  bind: "裝訂方式", form: "出版形式", kw: "關鍵字", pt: "出版機構類型",
};

const FIELD_MAP = {
  "申請書名": "t", "作者": "a", "出版機構": "p", "版次": "e",
  "預訂出版日": "d", "適讀對象": "au", "分級註記": "r", "分類號": "c",
  "ISBN": "i", "頁數": "pg", "資料類型": "tp", "建議上架分類": "cat",
  "作品語文": "lang", "圖書主題": "sub", "是否為引進版權著作": "tr",
  "定價": "price", "裝訂方式": "bind", "出版形式": "form",
  "關鍵字": "kw", "出版機構類型": "pt",
};

function parseCSVLine(line) {
  const fields = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') { current += '"'; i++; }
        else inQuotes = false;
      } else current += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ",") { fields.push(current); current = ""; }
      else if (ch !== "\r") current += ch;
    }
  }
  fields.push(current);
  return fields;
}

function parseCSV(csvText) {
  const lines = csvText.split("\n").filter(l => l.trim().length > 0);
  if (lines.length === 0) return [];
  let headerLine = lines[0];
  if (headerLine.charCodeAt(0) === 0xFEFF) headerLine = headerLine.slice(1);
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

function getMonthRange() {
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

function formatBook(book) {
  const lines = [];
  const order = ["i","t","a","p","d","e","price","pg","cat","sub","lang","au","r","tp","bind","form","tr","kw","c","pt"];
  for (const key of order) { if (book[key]) lines.push(`${FIELD_NAMES[key]}：${book[key]}`); }
  return lines.join("\n");
}

function matchesQuery(book, query, field) {
  const q = query.toLowerCase();
  if (field === "title") return (book.t || "").toLowerCase().includes(q);
  if (field === "author") return (book.a || "").toLowerCase().includes(q);
  if (field === "publisher") return (book.p || "").toLowerCase().includes(q);
  if (field === "isbn") return (book.i || "").includes(query);
  return (book.t||"").toLowerCase().includes(q) || (book.a||"").toLowerCase().includes(q) ||
         (book.p||"").toLowerCase().includes(q) || (book.kw||"").toLowerCase().includes(q) ||
         (book.sub||"").toLowerCase().includes(q) || (book.cat||"").toLowerCase().includes(q);
}

function createServer(env) {
  const server = new McpServer({ name: "taiwan-isbn-mcp", version: "1.0.0" });

  server.tool("search_books", `搜尋台灣出版圖書。${ATTRIBUTION}`, {
    query: { type: "string", description: "搜尋關鍵字" },
    field: { type: "string", description: "限定欄位：title/author/publisher/isbn，留空搜全部" },
    year_month: { type: "string", description: "限定月份 YYYYMM，留空搜最近6月" },
    limit: { type: "number", description: "上限，預設20，最奇50" },
  }, async ({ query, field, year_month, limit }) => {
    if (!query?.trim()) return { content: [{ type: "text", text: "請提供搜尋關鍵字。" }] };
    const max = Math.min(limit || 20, 50);
    let months = [];
    if (year_month) { months = [year_month]; }
    else {
      const m = await env.ISBN_KV.get("meta:info");
      if (!m) return { content: [{ type: "text", text: "資料庫尚未初始化。" }] };
      months = JSON.parse(m).months.slice(-6);
    }
    const results = [];
    for (const mo of months) {
      if (results.length >= max) break;
      const raw = await env.ISBN_KV.get(`month:${mo}`);
      if (!raw) continue;
      for (const book of JSON.parse(raw)) {
        if (results.length >= max) break;
        if (matchesQuery(book, query.trim(), field || "")) results.push(book);
      }
    }
    if (!results.length) return { content: [{ type: "text", text: `找不到「${query}」。\n\n${ATTRIBUTION}` }] };
    let out = `找到 ${results.length} 筆：\n\n`;
    for (const b of results) out += `---\n${formatBook(b)}\n`;
    return { content: [{ type: "text", text: out + `\n${ATTRIBUTION}` }] };
  });

  server.tool("get_book", `依ISBN查詢圖書。${ATTRIBUTION}`, {
    isbn: { type: "string", description: "ISBN" },
  }, async ({ isbn }) => {
    if (!isbn?.trim()) return { content: [{ type: "text", text: "請提供ISBN。" }] };
    const clean = isbn.replace(/[-\s]/g, "");
    const idx = await env.ISBN_KV.get("isbn_index");
    if (!idx) return { content: [{ type: "text", text: "資料庫尚未初始化。" }] };
    const mo = JSON.parse(idx)[clean];
    if (!mo) return { content: [{ type: "text", text: `找不到 ${clean}。\n\n${ATTRIBUTION}` }] };
    const raw = await env.ISBN_KV.get(`month:${mo}`);
    if (!raw) return { content: [{ type: "text", text: "讀取失敗。" }] };
    const book = JSON.parse(raw).find(b => b.i === clean);
    if (!book) return { content: [{ type: "text", text: "索引不一致。" }] };
    return { content: [{ type: "text", text: `${formatBook(book)}\n\n${ATTRIBUTION}` }] };
  });

  server.tool("browse_new_books", `瀏覽月份新書。${ATTRIBUTION}`, {
    year_month: { type: "string", description: "YYYYMM，留空最新月" },
    category: { type: "string", description: "篩選分類" },
    audience: { type: "string", description: "篩選對象" },
    offset: { type: "number", description: "起始位置" },
    limit: { type: "number", description: "上限，預設20" },
  }, async ({ year_month, category, audience, offset, limit }) => {
    const max = Math.min(limit || 20, 50), off = offset || 0;
    let mo = year_month;
    if (!mo) {
      const m = await env.ISBN_KV.get("meta:info");
      if (!m) return { content: [{ type: "text", text: "資料庫尚未初始化。" }] };
      const meta = JSON.parse(m); mo = meta.months[meta.months.length - 1];
    }
    const raw = await env.ISBN_KV.get(`month:${mo}`);
    if (!raw) return { content: [{ type: "text", text: `找不到 ${mo}。` }] };
    let books = JSON.parse(raw);
    if (category) { const c = category.toLowerCase(); books = books.filter(b => (b.cat||"").toLowerCase().includes(c) || (b.sub||"").toLowerCase().includes(c)); }
    if (audience) { const a = audience.toLowerCase(); books = books.filter(b => (b.au||"").toLowerCase().includes(a)); }
    const total = books.length, page = books.slice(off, off + max);
    let out = `${mo.slice(0,4)} 年 ${parseInt(mo.slice(4))} 月（共 ${total} 筆，第 ${off+1}–${off+page.length}）\n\n`;
    for (const b of page) { out += `---\n書名：${b.t||"?"}\n作者：${b.a||"?"}\n出版：${b.p||""}\n${b.i?"ISBN："+b.i+"\n":""}${b.price&&b.price!=="0"?"定價："+b.price+"\n":""}${b.cat?"分類："+b.cat+"\n":""}`; }
    if (off + page.length < total) out += `\n（還有 ${total-off-page.length} 筆，offset=${off+max}）\n`;
    return { content: [{ type: "text", text: out + `\n${ATTRIBUTION}` }] };
  });

  server.tool("get_stats", `資料庫統計。${ATTRIBUTION}`, {}, async () => {
    const m = await env.ISBN_KV.get("meta:info");
    if (!m) return { content: [{ type: "text", text: "資料庫尚未初始化。" }] };
    const meta = JSON.parse(m);
    return { content: [{ type: "text", text: `收錄：${meta.months[0]}~${meta.months[meta.months.length-1]}，${meta.months.length}月，${meta.totalRecords.toLocaleString()}筆\n更新：${meta.lastUpdate}\n\n${ATTRIBUTION}` }] };
  });

  return server;
}

async function handleIngest(env) {
  const months = getMonthRange();
  const log = [`Starting ingestion: ${months.length} months`];
  const isbnIndex = {};
  let totalRecords = 0;
  const successMonths = [];

  for (const month of months) {
    try {
      const url = `${BASE_CSV_URL}/${month}_isbn.csv`;
      const res = await fetch(url);
      if (!res.ok) { log.push(`${month}: HTTP ${res.status}, skip`); continue; }
      const text = await res.text();
      const records = parseCSV(text);
      if (records.length === 0) { log.push(`${month}: 0 records, skip`); continue; }
      for (const rec of records) { if (rec.i) isbnIndex[rec.i] = month; }
      await env.ISBN_KV.put(`month:${month}`, JSON.stringify(records));
      totalRecords += records.length;
      successMonths.push(month);
      log.push(`${month}: ${records.length} records ✓`);
    } catch (e) {
      log.push(`${month}: ERROR ${e.message}`);
    }
  }

  await env.ISBN_KV.put("isbn_index", JSON.stringify(isbnIndex));
  log.push(`isbn_index: ${Object.keys(isbnIndex).length} entries ✓`);

  successMonths.sort();
  const meta = { months: successMonths, totalRecords, totalISBNs: Object.keys(isbnIndex).length, lastUpdate: new Date().toISOString().split("T")[0] };
  await env.ISBN_KV.put("meta:info", JSON.stringify(meta));
  log.push(`meta:info ✓`);
  log.push(`\nDone: ${totalRecords} records, ${successMonths.length} months, ${Object.keys(isbnIndex).length} ISBNs`);

  return new Response(log.join("\n"), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok", service: "taiwan-isbn-mcp", attribution: ATTRIBUTION }), { headers: { "Content-Type": "application/json" } });
    }

    if (url.pathname === "/ingest") {
      return handleIngest(env);
    }

    if (url.pathname === "/mcp") {
      const server = createServer(env);
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      return transport.handleRequest(request);
    }

    return new Response("Not Found", { status: 404 });
  },
};
