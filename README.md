# XR Collector

XR Collector 是 local-first 的 YouTube 字幕收集與搜尋工具。使用者可以貼上單支影片網址，或保存一份 YouTube 頻道清單並立即或定時抓取。系統取得影片既有的人工或自動字幕，將 metadata 與整理過的字幕正文保存成 Markdown，並提供瀏覽、全文搜尋與閱讀介面。

本 repository 的可執行交付範圍對應 GitLab Issue #6：單支影片收集、文件保存與搜尋、頻道清單與立即抓取，以及應用程式執行期間的週期排程。已收集內容管理、Agent 存取及跨機還原由後續 tickets 交付。

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

## 收集規則

- 接受 `youtube.com/watch`、`youtu.be`、`youtube.com/shorts` 與 `youtube.com/embed` 的單支影片網址。
- 語言依序偏好繁體中文、簡體中文、英文，再選其他可用語言。
- 同一語言優先使用人工字幕；自動字幕只採用影片原始語言，不採用 YouTube 自動翻譯軌。
- 正規化字幕中的多餘空白，並將來源的零碎字幕片段合併成段落；不摘要或改寫內容，原本重複的文字仍會保留。
- Timestamp 只用於擷取過程，不寫入正式文件。產品不提供 Player UI 或逐句時間跳轉。
- 不下載影片或音訊，也不執行語音轉文字。
- 無字幕、影片無法存取、網路問題與一般擷取失敗以不同錯誤回報。

更完整的產品範圍與架構方向見 [YouTube-only MVP 計畫](docs/mvp-plan.md) 與 [XR Collector 整體架構](docs/architecture.md)。
