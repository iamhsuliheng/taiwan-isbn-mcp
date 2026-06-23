# taiwan-isbn-mcp

台灣出版新書預告書訊 MCP Server。

以 Cloudflare Worker 提供台灣 ISBN 書目資料查詢，資料來源為國家圖書館「臺灣出版新書預告書訊」開放資料。

## 工具

| 工具 | 說明 |
|------|------|
| `search_books` | 依書名、作者、出版社或關鍵字搜尋圖書 |
| `get_book` | 依 ISBN 查詢圖書詳細資料 |
| `browse_new_books` | 瀏覽指定月份的新書預告，可依分類、適讀對象篩選 |
| `get_stats` | 取得資料庫統計資訊 |

## 部署

### 1. 建立 KV namespace

```bash
npx wrangler kv namespace create ISBN_KV
```

把回傳的 namespace ID 填入 `wrangler.toml`。

### 2. 部署 Worker

```bash
npx wrangler deploy
```

或推到 GitHub `main` 分支，GitHub Actions 自動部署。需要在 repo Settings → Secrets → Actions → **Repository secrets** 加入 `CLOUDFLARE_API_TOKEN`。

### 3. 匯入資料

部署完成後，瀏覽器打開 Worker 端點的 `/ingest` 路徑，Worker 會自己從國圖下載 CSV 並寫入 KV。

### 4. 加入 Claude

Settings → Integrations → 新增 MCP → URL 填 Worker 端點的 `/mcp` 路徑。

## 資料授權

提供機關／國家圖書館 [2024–2026] [臺灣出版新書預告書訊]

此開放資料依政府資料開放授權條款 (Open Government Data License) 進行公眾釋出，使用者於遵守本條款各項規定之前提下，得利用之。

政府資料開放授權條款：https://data.gov.tw/license

## License

MIT
