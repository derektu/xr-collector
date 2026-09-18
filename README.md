# XR Collector

XR Collector 是 local-first 的 YouTube 字幕收集與搜尋工具。使用者可以貼上單支影片網址，或保存一份 YouTube 頻道清單並立即或定時抓取。系統取得影片既有的人工或自動字幕，將 metadata 與整理過的字幕正文保存成 Markdown，並提供瀏覽、全文搜尋與閱讀介面。

本 repository 的可執行交付範圍涵蓋單支影片收集、文件保存與搜尋、頻道清單與立即抓取、應用程式執行期間的週期排程，以及 Issue #7 的 Agent 只讀存取。已收集內容管理及跨機還原由其他 tickets 交付。

## 執行模式

開發與主要測試使用獨立 Web 模式：一般瀏覽器連到 Web 開發伺服器，前端透過相對路徑 `/api` 呼叫本機 API。這個模式不需要啟動 Electron。

安裝版由 Electron 啟動同一個 Web Server，並在應用程式視窗中載入同一份 Web UI。Electron 內部使用動態 port；該 port 不構成對一般瀏覽器公開的產品介面。業務畫面不使用 Electron IPC。

## 本機開發

需求：

- Node.js 22.12 或更新版本
- npm
- macOS arm64 開發環境

安裝套件：

```bash
npm install
npm run download:runtime
```

啟動 Web UI 與 API：

```bash
npm run dev
```

瀏覽器開啟 `http://127.0.0.1:7176/`。API 使用 `127.0.0.1:7175`，開發用 Meilisearch 只監聽 `127.0.0.1:7177`。正式文件保存在 `.data/dev-vault`，可重建的搜尋資料保存在 `.data/dev-search`。

已完成 production build 時，也可以只啟動單一 Web Server：

```bash
npm run build
npm start
```

此模式由 `http://127.0.0.1:7175/` 同時提供 UI 與 API。

## 測試與建置

```bash
npm test
npm run typecheck
npm run build
```

單元與 HTTP 整合測試不存取 YouTube。Meilisearch 整合測試使用下載後的本機 binary，驗證索引持久化與重建。真實字幕驗收需連線至 YouTube，並以 Web UI 貼入影片網址或加入頻道操作。

macOS arm64 安裝產物包含固定版本且通過 SHA-256 驗證的 `yt-dlp`、Deno 與 Meilisearch：

```bash
npm run package:mac
```

產物輸出至 `release/`。MVP 安裝包未簽章，並使用預設 Electron 圖示。

## 資料保存

每支影片使用 YouTube video ID 作為穩定識別，保存在：

```text
<vault>/documents/youtube/<video-id>.md
```

文件包含可追溯來源的 YAML frontmatter，以及可直接閱讀及交給其他工具使用的字幕正文。影片 URL 只保存在 frontmatter；正文不包含逐句 timestamp 或重複的來源連結。已存在相同 video ID 時，系統回傳既有文件，不覆寫檔案。

不同執行模式的預設 vault：

- Web 開發／standalone server：`.data/dev-vault`
- Electron 安裝版：Electron application data 目錄下的 `vault`

開發或測試可以用 `XR_COLLECTOR_VAULT` 指定其他位置。

## 頻道清單與立即抓取

頻道可以用 YouTube 頻道網址或 `@handle` 加入。設定保存在 `<vault>/settings/youtube-channels.json`；重新啟動後會保留清單與啟用狀態。移除頻道只刪除追蹤設定，不刪除已保存的字幕文件。

「抓取已啟用頻道」處理清單中所有已啟用頻道；每個頻道也可以不受啟用狀態限制而手動執行。每次執行探索該頻道最近 10 支影片，不預設回溯完整歷史。影片依序沿用單支影片的收集、vault 保存與搜尋索引流程，因此相同 video ID 經不同入口或重複執行都會略過既有文件。

畫面顯示目前頻道、已發現及已處理數量，以及每支影片的新增、略過或失敗結果。單支影片或單一頻道探索失敗不會中止其餘清單。無字幕影片以可辨認的失敗項目呈現，不啟動語音轉寫；再次執行該頻道會略過成功項目並重試失敗項目。

## 頻道排程

使用者可以在頻道區設定 1 分鐘至每天的抓取週期，並啟用或暫停自動抓取。畫面顯示目前排程狀態、上次開始與完成時間、下次執行時間，以及上次新增／略過／失敗數量。設定與必要進度保存在 `<vault>/settings/youtube-schedule.json`，重新啟動應用程式後會繼續使用。

排程只在 XR Collector 執行且電腦醒著時檢查，不建立背景系統服務。若程式關閉、重新啟動或電腦休眠期間漏過多個週期，恢復後只執行一次到期檢查，不逐次補跑。下一次時間從該次實際完成時間計算，因此畫面顯示的是目前真正等待的執行時間。

手動與定時抓取共用同一個頻道收集 run；已有 run 執行時，新的要求會等待或取得該次 run，不會同時探索和寫入同一批影片。網路或字幕取得失敗會保留在上次結果中，已保存文件不會遺失，下一個週期會再次探索並重試尚未成功的影片。暫停排程只阻止後續自動觸發，不中止已經開始的收集。

## 搜尋與索引

Markdown vault 是正式資料，Meilisearch 是每台裝置上可重建的搜尋投影。收集流程先保存 vault，再更新該份文件的索引。索引更新失敗不會刪除或回滾已保存的 Markdown；畫面會顯示錯誤並提供重建操作。

搜尋索引包含影片標題、頻道名稱與字幕正文。結果依 Meilisearch 關聯性排序，顯示命中位置附近的字幕片段，可以再以頻道和影片發布日期篩選。點選結果後，畫面以文件 ID 透過 `GET /api/documents/:id` 讀取完整文件。

Desktop 啟動時自動啟動只監聽 loopback 的 Meilisearch process，並追蹤「啟動中、更新中、重建中、已就緒、錯誤」狀態。搜尋資料目錄不存在時，Collector 從 vault 重建全部索引；目錄存在且文件數一致時，重啟直接沿用持久化索引。繁簡轉換與進階中文調校不屬於 Issue #4 搜尋契約。

## Agent 存取

應用程式啟動時建立獨立的 loopback HTTP 入口，與 UI 共用同一個 Collector、vault 與搜尋服務。Agent 入口只允許帶 Bearer token 的文件列表、搜尋、全文及索引狀態讀取；所有寫入與其他 routes 回傳 403。這是 Agent API 的權限邊界，不是對本機使用者或 UI 的作業系統隔離。UI 本身的收集與排程操作仍由既有本機入口提供。

畫面上方「Agent 存取」顯示 HTTP 位址、連線檔及 Skill 目錄。每次啟動重新產生 port 與 token，連線檔原子更新且在 macOS 限定目前使用者讀寫（0600）。連線檔位於 vault 之外，不應分享或納入資料搬移；程式關閉後保留最後的連線資訊，Agent 連線失敗時會重新讀取一次並提示確認程式狀態。

- Web 開發／standalone：`.data/agent-connection.json`；Skill 位於 repository 的 `skills/xr-collector-agent`。
- 安裝版：Electron application data 目錄下的 `agent-connection.json`；Skill 隨安裝包放在 `XR Collector.app/Contents/Resources/skills/xr-collector-agent`。實際位置以畫面為準。

Skill 以標準 HTTP/JSON 定義操作，不包含可執行腳本，也不要求用戶端安裝 Python、Node.js 或其他 runtime。Agent 使用自身已有的工具讀取本機連線檔、解析 JSON，並向 loopback HTTP 發送帶 Authorization header 的 GET 請求。只有雲端瀏覽能力、無法存取本機檔案或 localhost 的 Agent 不適用。

可以直接請 Agent 讀取 Skill 目錄中的 `SKILL.md`，並提供畫面上的連線檔位置；也可以把整個 `xr-collector-agent` 目錄複製到該 Agent 的 Skill 安裝目錄。操作與 HTTP 契約見 [Agent Skill](skills/xr-collector-agent/SKILL.md)。macOS／Windows 使用同一份 Skill 與 API 契約，路徑由畫面提供；跨平台契約不代表 Windows 安裝版已完成驗證。

試用時可以交給本機 Agent 以下要求，並把路徑替換為畫面顯示的位置：

```text
請使用 <Skill 目錄>/SKILL.md，連線檔是 <連線檔路徑>。
先列出已保存文件，再搜尋 math，讀取一份命中文件並附上來源。
```

列表預設每頁 50 份，回傳下一頁 offset；收集期間列表可能移動，跨頁使用穩定文件 ID 去重。搜尋與 UI 使用相同關聯性排序及篩選，支援 offset/limit；搜尋命中數是估計值，Meilisearch 預設可翻閱前 1000 個命中。索引未就緒時搜尋回報 503，列表與全文仍直接讀取 vault。第一版不提供 MCP，也不透過 Agent 啟動收集或修改資料。

## 收集規則

- 接受 `youtube.com/watch`、`youtu.be`、`youtube.com/shorts` 與 `youtube.com/embed` 的單支影片網址。
- 語言依序偏好繁體中文、簡體中文、英文，再選其他可用語言。
- 同一語言優先使用人工字幕；自動字幕只採用影片原始語言，不採用 YouTube 自動翻譯軌。
- 正規化字幕中的多餘空白，並將來源的零碎字幕片段合併成段落；不摘要或改寫內容，原本重複的文字仍會保留。
- Timestamp 只用於擷取過程，不寫入正式文件。產品不提供 Player UI 或逐句時間跳轉。
- 不下載影片或音訊，也不執行語音轉文字。
- 無字幕、影片無法存取、網路問題與一般擷取失敗以不同錯誤回報。

更完整的產品範圍與架構方向見 [YouTube-only MVP 計畫](docs/mvp-plan.md) 與 [XR Collector 整體架構](docs/architecture.md)。
