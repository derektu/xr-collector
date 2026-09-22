# XR Collector 架構

本文件描述可執行版本的組成。Round 2 的目標模組、服務生命週期與待實作行為集中於 [開發計畫](round-2-plan.md)，避免將規劃視為已交付能力。

## 執行與業務邊界

Electron 啟動本機 Fastify Web Server，載入 React 畫面；Web 開發模式使用 Vite 代理 `/api`。業務畫面透過 HTTP API 操作收集、頻道、排程、文件、搜尋與 Vault，業務邏輯不使用 Electron IPC。

| 模組 | 現行責任 |
| --- | --- |
| `src/electron` | 主視窗、profile、內附 runtime 路徑與程式生命週期 |
| `src/runtime` | 單一 VaultWorkspace、UI／Agent listeners 與啟動／關閉順序 |
| `src/server` | UI／Agent HTTP routes、Bearer 授權與 listener |
| `src/core`、`src/capture` | YouTube URL／字幕處理、收集去重、yt-dlp 擷取 |
| `src/channels` | 頻道清單、批次收集及執行期間的週期排程 |
| `src/vault` | Markdown 保存、active Vault、資料包與合併恢復 |
| `src/search` | Meilisearch 子程序、索引狀態、查詢與重建 |
| `src/web` | React 操作畫面與 HTTP client |

UI 與 Agent 共用 Collector、Vault、頻道、排程和搜尋服務。Agent 使用獨立 loopback HTTP 入口及每次啟動產生的 Bearer token，可操作所有現有業務 routes；跨程序服務發現由 #21 交付。

## Runtime 與資料

搜尋採完整 Meilisearch binary，由程式管理獨立子程序，監聽 loopback 並使用隨機 key。yt-dlp、Deno 與 Meilisearch 由下載腳本固定版本；安裝包內附所需工具。沒有嵌入 milli library 或要求安裝完整 Agent-Reach／summarize。

Vault 保存正式文件與可攜設定；搜尋 database 是裝置上的可重建資料。profile、憑證與連線資訊不隨 Vault 資料包交換。格式與恢復責任分別見 [文件格式](document-format.md)、[儲存與搜尋](storage-and-search.md)。

## Round 2 的架構方向

Collector 服務可獨立於 UI 運作，UI、Agent 與排程使用一致的工作與資料能力。Sources、Documents、Jobs、Activity、Search、VaultWorkspace 的責任及遷移順序以 [Round 2 第 5 節](round-2-plan.md#5-建議模組分工) 為準；不要求先建立通用 plugin framework。

`CollectorRuntime` 是 process 內的服務 owner。Standalone server 與 Electron 提供各自的 profile、runtime binary 與 UI listener 參數，兩者都由同一個 runtime factory 建立 VaultWorkspace、scheduler、搜尋 process 及已授權 Agent listener。關閉時先停止 listeners 並等待已接受的 handler，再等待收集、頻道與資料交換，最後關閉搜尋 process。尚未設定 Vault 或已記錄的 active Vault 不存在時，runtime 進入 `not_ready`，保留 health、Agent 授權與 UI shell，其他業務 API 回傳 503 `vault_not_ready`；不建立替代空 Vault 或搜尋資料。選址與恢復 Ready 的 UI 流程由 #20 提供。

改動正式資料格式或來源契約時，同一張 ticket 須涵蓋既有 Vault 可讀性、匯出／還原／合併及索引影響。原生驗證、CI 與建置方式見 [開發驗證流程](development-validation.md)。
