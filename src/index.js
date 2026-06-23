import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

const ATTRIBUTION = `資料來源：國家圖書館「臺灣出版新書預告書訊」，依政府資料開放授權條款第1版（https://data.gov.tw/license）公眾釋出。`;

// Field mapping: compact key → display name
const FIELD_NAMES = {
  t: "書名", a: "作者", p: "出版機構", e: "版次", d: "預訂出版日",
  au: "適讀對象", r: "分級註記", c: "分類號", i: "ISBN",
  pg: "頁數", tp: "資料類型", cat: "建議上架分類", lang: "作品語文",
  sub: "圖書主題", tr: "是否為引進版權著作", price: "定價",
  bind: "裝訂方式", form: "出版形式", kw: "關鍵字", pt: "出版機構類型",
};

function formatBook(book) {
  const lines = [];
  const order = ["i", "t", "a", "p", "d", "e", "price", "pg", "cat", "sub",
                  "lang", "au", "r", "tp", "bind", "form", "tr", "kw", "c", "pt"];
  for (const key of order) {
    if (book[key]) {
      lines.push(`${FIELD_NAMES[key]}：${book[key]}`);
    }
  }
  return lines.join("\n");
}

function matchesQuery(book, query, field) {
  const q = query.toLowerCase();
  if (field === "title") return (book.t || "").toLowerCase().includes(q);
  if (field === "author") return (book.a || "").toLowerCase().includes(q);
  if (field === "publisher") return (book.p || "").toLowerCase().includes(q);
  if (field === "isbn") return (book.i || "").includes(query);
  // default: search all text fields
  return (book.t || "").toLowerCase().includes(q) ||
         (book.a || "").toLowerCase().includes(q) ||
         (book.p || "").toLowerCase().includes(q) ||
         (book.kw || "").toLowerCase().includes(q) ||
         (book.sub || "").toLowerCase().includes(q) ||
         (book.cat || "").toLowerCase().includes(q);
}

function createServer(env) {
  const server = new McpServer({ name: "taiwan-isbn-mcp", version: "1.0.0" });

  server.tool(
    "search_books",
    `搜尋台灣出版圖書。可依書名、作者、出版社或關鍵字搜尋。${ATTRIBUTION}`,
    {
      query: { type: "string", description: "搜尋關鍵字（書名、作者、出版社等）" },
      field: {
        type: "string",
        description: "限定搜尋欄位：title（書名）、author（作者）、publisher（出版社）、isbn。留空則搜尋所有欄位",
      },
      year_month: {
        type: "string",
        description: "限定搜尋月份，格式 YYYYMM（如 202604）。留空則搜尋最近 6 個月",
      },
      limit: {
        type: "number",
        description: "回傳筆數上限，預設 20，最大 50",
      },
    },
    async ({ query, field, year_month, limit }) => {
      if (!query || query.trim().length === 0) {
        return { content: [{ type: "text", text: "請提供搜尋關鍵字。" }] };
      }

      const maxResults = Math.min(limit || 20, 50);
      const searchField = field || "";

      let monthsToSearch = [];
      if (year_month) {
        monthsToSearch = [year_month];
      } else {
        const metaRaw = await env.ISBN_KV.get("meta:info");
        if (!metaRaw) {
          return { content: [{ type: "text", text: "資料庫尚未初始化。" }] };
        }
        const meta = JSON.parse(metaRaw);
        monthsToSearch = meta.months.slice(-6);
      }

      const results = [];
      for (const month of monthsToSearch) {
        if (results.length >= maxResults) break;
        const chunkRaw = await env.ISBN_KV.get(`month:${month}`);
        if (!chunkRaw) continue;
        const books = JSON.parse(chunkRaw);
        for (const book of books) {
          if (results.length >= maxResults) break;
          if (matchesQuery(book, query.trim(), searchField)) {
            results.push(book);
          }
        }
      }

      if (results.length === 0) {
        const rangeDesc = year_month || `最近 ${monthsToSearch.length} 個月`;
        return {
          content: [{
            type: "text",
            text: `在${rangeDesc}的資料中找不到符合「${query}」的圖書。可嘗試不同關鍵字或擴大搜尋範圍。\n\n${ATTRIBUTION}`,
          }],
        };
      }

      let output = `找到 ${results.length} 筆結果：\n\n`;
      for (const book of results) {
        output += `---\n${formatBook(book)}\n`;
      }
      output += `\n${ATTRIBUTION}`;

      return { content: [{ type: "text", text: output }] };
    }
  );

  server.tool(
    "get_book",
    `依 ISBN 查詢台灣出版圖書的詳細資料。${ATTRIBUTION}`,
    {
      isbn: { type: "string", description: "ISBN（13 碼或 10 碼）" },
    },
    async ({ isbn }) => {
      if (!isbn || isbn.trim().length === 0) {
        return { content: [{ type: "text", text: "請提供 ISBN。" }] };
      }

      const cleanIsbn = isbn.replace(/[-\s]/g, "").trim();

      const indexRaw = await env.ISBN_KV.get("isbn_index");
      if (!indexRaw) {
        return { content: [{ type: "text", text: "資料庫尚未初始化。" }] };
      }
      const index = JSON.parse(indexRaw);
      const month = index[cleanIsbn];

      if (!month) {
        return {
          content: [{
            type: "text",
            text: `找不到 ISBN ${cleanIsbn} 的資料。此資料庫收錄 2024 年 1 月至今的新書預告書訊。\n\n${ATTRIBUTION}`,
          }],
        };
      }

      const chunkRaw = await env.ISBN_KV.get(`month:${month}`);
      if (!chunkRaw) {
        return { content: [{ type: "text", text: "資料讀取失敗。" }] };
      }
      const books = JSON.parse(chunkRaw);
      const book = books.find((b) => b.i === cleanIsbn);

      if (!book) {
        return { content: [{ type: "text", text: `索引指向 ${month} 但找不到該筆資料。` }] };
      }

      const output = `${formatBook(book)}\n\n${ATTRIBUTION}`;
      return { content: [{ type: "text", text: output }] };
    }
  );

  server.tool(
    "browse_new_books",
    `瀏覽指定月份的台灣新書預告書訊。可依分類、適讀對象等篩選。${ATTRIBUTION}`,
    {
      year_month: {
        type: "string",
        description: "月份，格式 YYYYMM（如 202604）。留空則顯示最新月份",
      },
      category: {
        type: "string",
        description: "篩選上架分類（如：文學小說、漫畫書、商業理財、人文史地等）。留空不篩選",
      },
      audience: {
        type: "string",
        description: "篩選適讀對象（如：成人(一般)、青少年、學齡前兒童等）。留空不篩選",
      },
      offset: {
        type: "number",
        description: "起始位置，用於翻頁。預設 0",
      },
      limit: {
        type: "number",
        description: "回傳筆數上限，預設 20，最大 50",
      },
    },
    async ({ year_month, category, audience, offset, limit }) => {
      const maxResults = Math.min(limit || 20, 50);
      const startOffset = offset || 0;

      let month = year_month;
      if (!month) {
        const metaRaw = await env.ISBN_KV.get("meta:info");
        if (!metaRaw) {
          return { content: [{ type: "text", text: "資料庫尚未初始化。" }] };
        }
        const meta = JSON.parse(metaRaw);
        month = meta.months[meta.months.length - 1];
      }

      const chunkRaw = await env.ISBN_KV.get(`month:${month}`);
      if (!chunkRaw) {
        return {
          content: [{ type: "text", text: `找不到 ${month} 的資料。` }],
        };
      }

      let books = JSON.parse(chunkRaw);

      if (category) {
        const cat = category.toLowerCase();
        books = books.filter(
          (b) => (b.cat || "").toLowerCase().includes(cat) ||
                 (b.sub || "").toLowerCase().includes(cat)
        );
      }
      if (audience) {
        const aud = audience.toLowerCase();
        books = books.filter((b) => (b.au || "").toLowerCase().includes(aud));
      }

      const total = books.length;
      const page = books.slice(startOffset, startOffset + maxResults);

      const year = month.substring(0, 4);
      const mon = month.substring(4, 6);

      let output = `${year} 年 ${parseInt(mon)} 月新書預告（`;
      if (category || audience) {
        const filters = [];
        if (category) filters.push(`分類：${category}`);
        if (audience) filters.push(`對象：${audience}`);
        output += filters.join("、") + "，";
      }
      output += `共 ${total} 筆，顯示第 ${startOffset + 1}–${startOffset + page.length} 筆）\n\n`;

      for (const book of page) {
        output += `---\n`;
        output += `書名：${book.t || "（未提供）"}\n`;
        output += `作者：${book.a || "（未提供）"}\n`;
        output += `出版：${book.p || ""}\n`;
        if (book.i) output += `ISBN：${book.i}\n`;
        if (book.price && book.price !== "0") output += `定價：${book.price}\n`;
        if (book.cat) output += `分類：${book.cat}\n`;
      }

      if (startOffset + page.length < total) {
        output += `\n（還有 ${total - startOffset - page.length} 筆，使用 offset=${startOffset + maxResults} 查看下一頁）\n`;
      }
      output += `\n${ATTRIBUTION}`;

      return { content: [{ type: "text", text: output }] };
    }
  );

  server.tool(
    "get_stats",
    `取得台灣出版新書預告書訊資料庫的統計資訊。${ATTRIBUTION}`,
    {},
    async () => {
      const metaRaw = await env.ISBN_KV.get("meta:info");
      if (!metaRaw) {
        return { content: [{ type: "text", text: "資料庫尚未初始化。" }] };
      }
      const meta = JSON.parse(metaRaw);

      let output = `台灣出版新書預告書訊 MCP 資料庫\n\n`;
      output += `收錄範圍：${meta.months[0]} ~ ${meta.months[meta.months.length - 1]}\n`;
      output += `收錄月數：${meta.months.length} 個月\n`;
      output += `收錄筆數：${meta.totalRecords.toLocaleString()} 筆\n`;
      output += `資料更新：${meta.lastUpdate}\n`;
      output += `\n可用月份：${meta.months.join("、")}\n`;
      output += `\n${ATTRIBUTION}`;

      return { content: [{ type: "text", text: output }] };
    }
  );

  return server;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response(
        JSON.stringify({
          status: "ok",
          service: "taiwan-isbn-mcp",
          description: "台灣出版新書預告書訊 MCP Server",
          attribution: ATTRIBUTION,
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    if (url.pathname === "/mcp") {
      const server = createServer(env);
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      await server.connect(transport);
      return transport.handleRequest(request);
    }

    return new Response("Not Found", { status: 404 });
  },
};
