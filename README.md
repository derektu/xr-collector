# XR Collector

XR Collector 是 local-first 的 YouTube 字幕收集工具。使用者貼上 YouTube 影片網址後，系統取得影片既有的人工或自動字幕，將 metadata 與整理過的字幕正文保存成 Markdown，並提供閱讀介面。

目前交付範圍對應 GitLab Issue #3：單支影片收集、重複辨識、錯誤回報、文件保存與重啟後讀取。頻道清單、排程、搜尋、Agent 存取及跨機還原由後續 tickets 交付。

## 執行模式

開發與主要測試使用獨立 Web 模式：一般瀏覽器連到 Web 開發伺服器，前端透過相對路徑 `/api` 呼叫本機 API。這個模式不需要啟動 Electron。

安裝版由 Electron 啟動同一個 Web Server，並在應用程式視窗中載入同一份 Web UI。Electron 內部使用動態 port；該 port 不構成對一般瀏覽器公開的產品介面。業務畫面不使用 Electron IPC。

## 本機開發

需求：

- Node.js 22.12 或更新版本
- npm
- 開發機可執行的 `yt-dlp`
- Deno；用於執行 YouTube 擷取所需的 JavaScript runtime

安裝套件：

```bash
npm install
```

啟動 Web UI 與 API：

```bash
XR_COLLECTOR_YTDLP=/path/to/yt-dlp \
XR_COLLECTOR_DENO=/path/to/deno \
npm run dev
```

瀏覽器開啟 `http://127.0.0.1:7176/`。API 使用 `127.0.0.1:7175`；開發資料保存在 `.data/dev-vault`。

已完成 production build 時，也可以只啟動單一 Web Server：

```bash
npm run build
XR_COLLECTOR_YTDLP=/path/to/yt-dlp \
XR_COLLECTOR_DENO=/path/to/deno \
npm start
```

此模式由 `http://127.0.0.1:7175/` 同時提供 UI 與 API。

## 測試與建置

```bash
npm test
npm run typecheck
npm run build
```

單元與 HTTP 整合測試不存取 YouTube。真實字幕驗收需連線至 YouTube，並以 Web UI 貼入影片網址操作。

macOS arm64 安裝產物包含固定版本且通過 SHA-256 驗證的 `yt-dlp` 與 Deno：

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

## 目前收集規則

- 接受 `youtube.com/watch`、`youtu.be`、`youtube.com/shorts` 與 `youtube.com/embed` 的單支影片網址。
- 語言依序偏好繁體中文、簡體中文、英文，再選其他可用語言。
- 同一語言優先使用人工字幕；自動字幕只採用影片原始語言，不採用 YouTube 自動翻譯軌。
- 正規化字幕中的多餘空白，並將來源的零碎字幕片段合併成段落；不摘要或改寫內容，原本重複的文字仍會保留。
- Timestamp 只用於擷取過程，不寫入正式文件。產品不提供 Player UI 或逐句時間跳轉。
- 不下載影片或音訊，也不執行語音轉文字。
- 無字幕、影片無法存取、網路問題與一般擷取失敗以不同錯誤回報。

更完整的產品範圍與架構方向見 [YouTube-only MVP 計畫](docs/mvp-plan.md) 與 [XR Collector 整體架構](docs/architecture.md)。
