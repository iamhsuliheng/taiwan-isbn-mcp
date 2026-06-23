# taiwan-isbn-mcp

台灣出版新書預告書訊 MCP Server。

以 Cloudflare Worker + D1 提供台灣 ISBN 書目資料查詢，資料來源為國家圖書館「臺灣出版新書預告書訊」開放資料。

## 工具

| 工具 | 說明 |
|------|------|
| `search_books` | 依書名、作者、出版機構關鍵字搜尋，可指定搜尋欄位 |
| `get_books` | 依 ISBN 批次查詢完整書目（一次最多 50 筆） |
| `browse_new_books` | 瀏覽指定月份的新書清單，可依分類、適讀對象篩選，支援分頁 |
| `get_stats` | 取得資料庫統計資訊（總筆數、涵蓋月份範圍）|
| `get_schema` | 查詢 books 資料表的完整欄位說明 |
| `get_categories` | 查詢資料庫中實際存在的上架分類值清單 |

建議使用順序：`get_stats` → `get_categories` → `search_books` / `browse_new_books`。

## 加入 Claude

Settings → Integrations → 新增 MCP → URL：

```
https://taiwan-isbn-mcp.yesleon-69a.workers.dev/mcp
```

## 部署（維護用）

### 部署 Worker

```bash
# 需要 Workers Scripts Write 與 D1 Write 權限的 token
export CLOUDFLARE_API_TOKEN="..."
npx wrangler deploy
```

### 重新匯入資料

```bash
export CF_ACCOUNT_ID="69abca4b..."
export CF_API_TOKEN="<D1 Write token>"
node scripts/ingest-d1.js
# 或指定月份：node scripts/ingest-d1.js 202601 202602
```

`ingest-d1.js` 會自動下載 CSV、產生 SQL（含 `search_text` 欄）、透過 D1 Import API 匯入。

## 資料授權

提供機關／國家圖書館 [2026]「臺灣出版新書預告書訊」

此開放資料依政府資料開放授權條款（Open Government Data License）進行公眾釋出，使用者於遵守本條款各項規定之前提下，得利用之。

政府資料開放授權條款：https://data.gov.tw/license

## License

MIT
