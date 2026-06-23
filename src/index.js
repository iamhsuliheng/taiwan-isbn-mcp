import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

// 顯名聲明依 OGDL 第一版附件格式（提供機關／年份／資料名稱＋標準聲明＋條款連結）。
// [2026] 為資料取得年份；跨年重新 ingest 資料後須同步更新此年份。
const ATTRIBUTION = `提供機關／國家圖書館 [2026]「臺灣出版新書預告書訊」此開放資料依政府資料開放授權條款（Open Government Data License）進行公眾釋出，使用者於遵守本條款各項規定之前提下，得利用之。政府資料開放授權條款：https://data.gov.tw/license`;

function createServer(env) {
  const server = new McpServer({ name: "taiwan-isbn-mcp", version: "2.0.0" });

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
        const out = JSON.stringify(capped);
        return { content: [{ type: "text", text: `${out}${note}\n\n${ATTRIBUTION}` }] };
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
      return new Response(JSON.stringify({ status: "ok", service: "taiwan-isbn-mcp", version: "2.0.0", attribution: ATTRIBUTION }), { headers: { "Content-Type": "application/json" } });
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
