import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

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

  server.tool("search_books",
    `搜尋台灣出版圖書。可依書名、作者、出版社或關鍵字搜尋。${ATTRIBUTION}`,
    {
      query: z.string().describe("搜尋關鍵字（書名、作者、出版社等）"),
      field: z.enum(["title", "author", "publisher", "isbn", ""]).optional().describe("限定搜尋欄位：title/author/publisher/isbn，留空搜全部"),
      year_month: z.string().optional().describe("限定月份 YYYYMM，留空搜最近6月"),
      limit: z.number().optional().describe("上限，預設20，最大50"),
    },
    async ({ query, field, year_month, limit }) => {
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
    }
  );

  server.tool("get_book",
    `依ISBN查詢台灣出版圖書。${ATTRIBUTION}`,
    { isbn: z.string().describe("ISBN（13碼或10碼）") },
    async ({ isbn }) => {
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
    }
  );

  server.tool("browse_new_books",
    `瀏覽指定月份的台灣新書預告書訊。${ATTRIBUTION}`,
    {
      year_month: z.string().optional().describe("YYYYMM，留空最新月"),
      category: z.string().optional().describe("篩選上架分類"),
      audience: z.string().optional().describe("篩選適讀對象"),
      offset: z.number().optional().describe("起始位置，預設0"),
      limit: z.number().optional().describe("上限，預設20，最大50"),
    },
    async ({ year_month, category, audience, offset, limit }) => {
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
    }
  );

  server.tool("get_stats",
    `台灣出版新書預告書訊資料庫統計。${ATTRIBUTION}`,
    {},
    async () => {
      const m = await env.ISBN_KV.get("meta:info");
      if (!m) return { content: [{ type: "text", text: "資料庫尚未初始化。" }] };
      const meta = JSON.parse(m);
      return { content: [{ type: "text", text: `收錄：${meta.months[0]}~${meta.months[meta.months.length-1]}，${meta.months.length}月，${meta.totalRecords.toLocaleString()}筆\n更新：${meta.lastUpdate}\n\n${ATTRIBUTION}` }] };
    }
  );

  server.tool("run_query",
    `對台灣出版書目資料庫執行唯讀 SQL 查詢，用於資料分析（統計、聚合、趨勢、篩選）。

資料表 books，每列一本書，欄位：
- isbn（ISBN）, title（書名）, author（作者）, publisher（出版機構）, edition（版次）
- pub_date（預訂出版日，格式 YYYY-MM-DD）, ym（資料月份 YYYYMM，建議用此欄做時間分析）
- audience（適讀對象）, rating（分級註記）, class_no（分類號）, pages（頁數，文字）
- doc_type（資料類型，如「圖書」「數位平台電子書」「有聲出版品」）
- category（常用分類，如「漫畫書」「小說」「人文史地」）, language（作品語文）
- subject（圖書主題）, translated（是否為翻譯書）, price（定價，文字）
- binding（裝訂方式）, form（出版形式）, keywords（關鍵字）, pub_type（出版機構類型）

收錄 2024/01–2026/04 共 28 個月、約 14 萬筆。只接受單一 SELECT 查詢。數值欄位（price、pages）以文字儲存，運算時需 CAST(price AS INTEGER)。${ATTRIBUTION}`,
    {
      sql: z.string().describe("單一 SELECT SQL 查詢語句。表名 books。"),
    },
    async ({ sql }) => {
      if (!sql?.trim()) return { content: [{ type: "text", text: "請提供 SQL 查詢。" }] };
      const q = sql.trim().replace(/;+\s*$/, "");
      // 唯讀防護：必須以 SELECT 或 WITH 開頭，禁止寫入/結構變更關鍵字與多語句
      if (!/^\s*(SELECT|WITH)\b/i.test(q)) {
        return { content: [{ type: "text", text: "只允許 SELECT 查詢。" }] };
      }
      if (/;/.test(q)) {
        return { content: [{ type: "text", text: "只允許單一查詢語句，不可含分號。" }] };
      }
      if (/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|ATTACH|DETACH|PRAGMA|VACUUM)\b/i.test(q)) {
        return { content: [{ type: "text", text: "偵測到非唯讀關鍵字，已拒絕。" }] };
      }
      try {
        const stmt = env.ISBN_DB.prepare(q);
        const { results } = await stmt.all();
        if (!results || results.length === 0) {
          return { content: [{ type: "text", text: `查詢成功，但沒有結果。\n\n${ATTRIBUTION}` }] };
        }
        const capped = results.slice(0, 200);
        const note = results.length > 200 ? `\n（結果共 ${results.length} 列，僅顯示前 200 列）` : "";
        const out = JSON.stringify(capped, null, 2);
        return { content: [{ type: "text", text: `${out}${note}\n\n${ATTRIBUTION}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `查詢錯誤：${e.message}` }] };
      }
    }
  );

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
