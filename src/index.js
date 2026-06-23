import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

// 顯名聲明依 OGDL 第一版附件格式。
// [2026] 為資料取得年份；跨年重新 ingest 後須同步更新。
const ATTRIBUTION = `提供機關／國家圖書館 [2026]「臺灣出版新書預告書訊」此開放資料依政府資料開放授權條款（Open Government Data License）進行公眾釋出，使用者於遵守本條款各項規定之前提下，得利用之。政府資料開放授權條款：https://data.gov.tw/license`;

const VERSION = "3.1.0";

// books 表欄位說明（供 get_schema 工具回傳）
const SCHEMA = [
  { column: "isbn",        description: "ISBN 書號" },
  { column: "title",       description: "書名" },
  { column: "author",      description: "作者" },
  { column: "publisher",   description: "出版機構" },
  { column: "edition",     description: "版次" },
  { column: "pub_date",    description: "預訂出版日（YYYY-MM-DD）" },
  { column: "ym",          description: "資料月份（YYYYMM），建議用於時間範圍查詢" },
  { column: "audience",    description: "適讀對象" },
  { column: "rating",      description: "分級註記" },
  { column: "class_no",    description: "分類號" },
  { column: "pages",       description: "頁數（文字欄位）" },
  { column: "doc_type",    description: "資料類型，如「圖書」「數位平台電子書」「有聲出版品」" },
  { column: "category",    description: "常用上架分類，如「漫畫書」「小說」「人文史地」；可用值請以 get_categories 查詢" },
  { column: "language",    description: "作品語文" },
  { column: "subject",     description: "圖書主題" },
  { column: "translated",  description: "是否為翻譯書（引進版權著作）" },
  { column: "price",       description: "定價（文字欄位，數值運算需 CAST(price AS INTEGER)）" },
  { column: "binding",     description: "裝訂方式" },
  { column: "form",        description: "出版形式" },
  { column: "keywords",    description: "關鍵字" },
  { column: "pub_type",    description: "出版機構類型" },
  { column: "search_text", description: "全文搜尋欄（書名+作者+出版機構+主題+關鍵字合併，ingest 時生成）；重新 ingest 後可用" },
];

// ── 格式化工具函數 ────────────────────────────────────────────────────────────
// format: "json"（預設，AI 處理）| "text"（格式化純文字，人類可讀）
function formatResults(results, format) {
  if (format === "text") {
    return results.map(r => {
      const lines = [];
      if (r.title)     lines.push(`書名：${r.title}`);
      if (r.author)    lines.push(`作者：${r.author}`);
      if (r.publisher) lines.push(`出版社：${r.publisher}`);
      if (r.pub_date)  lines.push(`出版日：${r.pub_date}`);
      if (r.category)  lines.push(`分類：${r.category}`);
      if (r.doc_type)  lines.push(`類型：${r.doc_type}`);
      if (r.price)     lines.push(`定價：${r.price}`);
      if (r.isbn)      lines.push(`ISBN：${r.isbn}`);
      return lines.join("\n");
    }).join("\n\n");
  }
  return JSON.stringify(results);
}

const FORMAT_PARAM = z.enum(["json", "text"])
  .optional().default("json")
  .describe("回傳格式：json（預設，AI 處理效率最佳）、text（格式化純文字，適合純文字客戶端人類閱讀）");

function createServer(env) {
  const server = new McpServer({ name: "taiwan-isbn-mcp", version: VERSION });

  // ── 1. search_books ──────────────────────────────────────────────────────────
  server.tool(
    "search_books",
    `搜尋台灣出版書目。支援書名、作者、出版機構關鍵字搜尋。
收錄 2024/01–2026/04 約 14 萬筆。
注意：使用字串子字串比對（LIKE），繁簡字差異可能影響結果。
${ATTRIBUTION}`,
    {
      query: z.string().describe("搜尋關鍵字"),
      field: z.enum(["title", "author", "publisher", "all"])
        .optional().default("all")
        .describe("搜尋欄位：title（書名）、author（作者）、publisher（出版機構）、all（全部，預設）"),
      limit: z.number().int().min(1).max(50)
        .optional().default(10)
        .describe("最多回傳幾筆，預設 10，最大 50"),
      format: FORMAT_PARAM,
    },
    async ({ query, field, limit, format }) => {
      if (!query?.trim()) return { content: [{ type: "text", text: "請提供搜尋關鍵字。" }] };
      const q = `%${query.trim()}%`;
      let whereClause;
      if (field === "title")          whereClause = "title LIKE ?1";
      else if (field === "author")    whereClause = "author LIKE ?1";
      else if (field === "publisher") whereClause = "publisher LIKE ?1";
      else whereClause = "(title LIKE ?1 OR author LIKE ?1 OR publisher LIKE ?1 OR subject LIKE ?1 OR keywords LIKE ?1)";
      try {
        const sql = `SELECT isbn, title, author, publisher, pub_date, category, doc_type, price FROM books WHERE ${whereClause} LIMIT ?2`;
        const { results } = await env.ISBN_DB.prepare(sql).bind(q, limit).all();
        if (!results || results.length === 0) {
          return { content: [{ type: "text", text: `查無符合「${query}」的書目。\n\n${ATTRIBUTION}` }] };
        }
        return { content: [{ type: "text", text: `${formatResults(results, format)}\n\n${ATTRIBUTION}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `查詢錯誤：${e.message}` }] };
      }
    }
  );

  // ── 2. get_books ─────────────────────────────────────────────────────────────
  server.tool(
    "get_books",
    `以 ISBN 書號查詢完整書目資料，支援批次查詢（一次最多 50 筆）。
${ATTRIBUTION}`,
    {
      isbns: z.array(z.string()).min(1).max(50)
        .describe("ISBN 書號陣列，如 [\"9786263148765\", \"9789571398501\"]"),
      format: FORMAT_PARAM,
    },
    async ({ isbns, format }) => {
      const placeholders = isbns.map((_, i) => `?${i + 1}`).join(", ");
      try {
        const sql = `SELECT isbn, title, author, publisher, pub_date, category, doc_type, price, audience, subject, keywords FROM books WHERE isbn IN (${placeholders})`;
        const { results } = await env.ISBN_DB.prepare(sql).bind(...isbns).all();
        if (!results || results.length === 0) {
          return { content: [{ type: "text", text: `查無符合的書目。\n\n${ATTRIBUTION}` }] };
        }
        return { content: [{ type: "text", text: `${formatResults(results, format)}\n\n${ATTRIBUTION}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `查詢錯誤：${e.message}` }] };
      }
    }
  );

  // ── 3. browse_new_books ───────────────────────────────────────────────────────
  server.tool(
    "browse_new_books",
    `瀏覽特定月份的新書清單，可依分類或適讀對象篩選，支援分頁。
月份格式：YYYYMM（如 202601）。
可用分類值建議先以 get_categories 工具查詢，避免分類名稱不一致。
${ATTRIBUTION}`,
    {
      month: z.string().regex(/^\d{6}$/)
        .describe("月份，格式 YYYYMM，如 202601"),
      category: z.string().optional()
        .describe("上架分類篩選，如「小說」「人文史地」。建議先用 get_categories 查詢可用值。"),
      audience: z.string().optional()
        .describe("適讀對象篩選，如「成人」「兒童」"),
      limit: z.number().int().min(1).max(100)
        .optional().default(20)
        .describe("每頁筆數，預設 20，最大 100"),
      offset: z.number().int().min(0)
        .optional().default(0)
        .describe("跳過幾筆（分頁用），預設 0"),
      format: FORMAT_PARAM,
    },
    async ({ month, category, audience, limit, offset, format }) => {
      const conditions = ["ym = ?1"];
      const bindings = [month];
      let p = 2;
      if (category) { conditions.push(`category LIKE ?${p}`); bindings.push(`%${category}%`); p++; }
      if (audience) { conditions.push(`audience LIKE ?${p}`); bindings.push(`%${audience}%`); p++; }
      const where = conditions.join(" AND ");
      try {
        const [dataRes, countRes] = await env.ISBN_DB.batch([
          env.ISBN_DB.prepare(
            `SELECT isbn, title, author, publisher, pub_date, category, audience, doc_type, price FROM books WHERE ${where} LIMIT ?${p} OFFSET ?${p + 1}`
          ).bind(...bindings, limit, offset),
          env.ISBN_DB.prepare(
            `SELECT COUNT(*) as total FROM books WHERE ${where}`
          ).bind(...bindings),
        ]);
        const results = dataRes.results ?? [];
        const total = countRes.results?.[0]?.total ?? 0;
        if (results.length === 0) {
          return { content: [{ type: "text", text: `${month} 查無符合條件的書目（共 ${total} 筆）。\n\n${ATTRIBUTION}` }] };
        }
        const note = `（${month} 共 ${total} 筆，目前第 ${offset + 1}–${offset + results.length} 筆）`;
        return { content: [{ type: "text", text: `${formatResults(results, format)}\n${note}\n\n${ATTRIBUTION}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `查詢錯誤：${e.message}` }] };
      }
    }
  );

  // ── 4. get_stats ─────────────────────────────────────────────────────────────
  server.tool(
    "get_stats",
    `查詢台灣 ISBN 書目資料庫的統計資訊：總書目數、涵蓋月份範圍。
建議在進行其他查詢前先呼叫，確認資料庫收錄範圍。
${ATTRIBUTION}`,
    {},
    async () => {
      try {
        const [countRes, rangeRes] = await env.ISBN_DB.batch([
          env.ISBN_DB.prepare("SELECT COUNT(*) as total FROM books"),
          env.ISBN_DB.prepare("SELECT MIN(ym) as min_ym, MAX(ym) as max_ym, COUNT(DISTINCT ym) as months FROM books"),
        ]);
        const total = countRes.results?.[0]?.total ?? 0;
        const { min_ym, max_ym, months } = rangeRes.results?.[0] ?? {};
        const stats = {
          total_books: total,
          earliest_month: min_ym,
          latest_month: max_ym,
          total_months: months,
          month_format: "YYYYMM",
        };
        return { content: [{ type: "text", text: `${JSON.stringify(stats)}\n\n${ATTRIBUTION}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `查詢錯誤：${e.message}` }] };
      }
    }
  );

  // ── 5. get_schema ─────────────────────────────────────────────────────────────
  server.tool(
    "get_schema",
    `查詢 books 資料表的完整欄位說明。
用於了解可查詢的欄位名稱與含義，適合需要精確欄位名稱的進階情境。`,
    {},
    async () => {
      return { content: [{ type: "text", text: JSON.stringify(SCHEMA) }] };
    }
  );

  // ── 6. get_categories ────────────────────────────────────────────────────────
  server.tool(
    "get_categories",
    `查詢資料庫中實際存在的上架分類（category）值清單。
在使用 browse_new_books 的 category 參數篩選前，建議先呼叫此工具確認可用分類名稱，
避免因分類名稱不一致而查無結果。`,
    {},
    async () => {
      try {
        const { results } = await env.ISBN_DB.prepare(
          "SELECT DISTINCT category FROM books WHERE category IS NOT NULL AND category != '' ORDER BY category"
        ).all();
        const categories = results.map(r => r.category);
        return { content: [{ type: "text", text: JSON.stringify(categories) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `查詢錯誤：${e.message}` }] };
      }
    }
  );

  return server;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response(
        JSON.stringify({ status: "ok", service: "taiwan-isbn-mcp", version: VERSION, attribution: ATTRIBUTION }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    if (url.pathname === "/mcp") {
      const server = createServer(env);
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);

      let patchedRequest = request;
      if (request.method === "POST") {
        try {
          const body = await request.clone().json();
          if (body?.method === "tools/call" && body?.params?.arguments == null) {
            const patched = { ...body, params: { ...body.params, arguments: {} } };
            patchedRequest = new Request(request.url, {
              method: request.method,
              headers: request.headers,
              body: JSON.stringify(patched),
            });
          }
        } catch {
          // body 不是合法 JSON，直接讓 transport 自己處理
        }
      }

      return transport.handleRequest(patchedRequest);
    }

    return new Response("Not Found", { status: 404 });
  },
};
