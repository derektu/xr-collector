# XR Collector 架構

本文件描述可執行版本的組成。Round 2 的目標模組、服務生命週期與待實作行為集中於 [開發計畫](round-2-plan.md)，避免將規劃視為已交付能力。

## 執行與業務邊界

Electron 啟動本機 Fastify Web Server，載入 React 畫面；Web 開發模式使用 Vite 代理 `/api`。業務畫面透過 HTTP API 操作收集、頻道、排程、文件、搜尋與 Vault，業務邏輯不使用 Electron IPC。

| 模組 | 現行責任 |
| --- | --- |
| `src/electron` | 主視窗、profile、內附 runtime 路徑與程式生命週期 |
| `src/runtime` | 單一 VaultWorkspace、UI／Agent listeners 與啟動／關閉順序 |
| `src/server` | UI／Agent HTTP routes、Bearer 授權與 listener |
| `src/core` | 共用型別、文件保存與索引、字幕處理 |
| `src/sources/youtube`、`src/capture` | YouTube 網址辨識、來源 adapter 介面與 yt-dlp 實作 |
| `src/jobs` | 收集工作的接受、去重、有界佇列、公平派工與裝置端持久紀錄 |
| `src/channels` | 頻道清單、頻道工作提交及執行期間的週期排程 |
| `src/vault` | Markdown 保存、active Vault、資料包與合併恢復 |
| `src/search` | Meilisearch 子程序、索引狀態、查詢與重建 |
| `src/web` | React 操作畫面與 HTTP client |

UI 與 Agent 共用 Collector、Vault、收集工作、頻道、排程和搜尋服務。Agent 使用獨立 loopback HTTP 入口及每次啟動產生的 Bearer token，可操作所有現有業務 routes；跨程序服務依下述固定裝置入口發現 active runtime。

收集以工作執行。HTTP 先把工作寫入 profile 的 `jobs/jobs.json` 再回傳 202，網路解析與擷取都在 `JobManager` 的背景佇列中完成：頻道解析與探索、影片擷取各有並行上限，擷取在提交它的工作之間輪替。每個 Vault bundle 有自己的 `JobManager`，持有該 Vault 的文件、搜尋與頻道物件，因此工作只寫入提交時的 Vault。YouTube 的網路操作集中在 `YouTubeSource` adapter，工作與保存流程只依賴這個介面。Scheduler 到期時提交頻道工作即返回，以工作結束的通知記錄上次結果。

## Runtime 與資料

搜尋採完整 Meilisearch binary，由程式管理獨立子程序，監聽 loopback 並使用隨機 key。yt-dlp、Deno 與 Meilisearch 由下載腳本固定版本；安裝包內附所需工具。沒有嵌入 milli library 或要求安裝完整 Agent-Reach／summarize。

Vault 保存正式文件與可攜設定；搜尋 database 是裝置上的可重建資料。profile、憑證與連線資訊不隨 Vault 資料包交換。格式與恢復責任分別見 [文件格式](document-format.md)、[儲存與搜尋](storage-and-search.md)。

## Round 2 的架構方向

Collector 服務可獨立於 UI 運作，UI、Agent 與排程使用一致的工作與資料能力。Sources、Documents、Jobs、Activity、Search、VaultWorkspace 的責任及遷移順序以 [Round 2 第 5 節](round-2-plan.md#5-建議模組分工) 為準；不要求先建立通用 plugin framework。

`CollectorRuntime` 是 process 內的服務 owner。Standalone server 與 Electron 提供各自的 profile、runtime binary 與 UI listener 參數，兩者都由同一個 runtime factory 建立 VaultWorkspace、scheduler、搜尋 process 及已授權 Agent listener。關閉時先停止 listeners 並等待已接受的 handler，再等待資料交換與執行中的收集步驟，把尚未開始的工作記為已中斷，最後關閉搜尋 process。尚未設定 Vault 或已記錄的 Vault 無法開啟時，runtime 進入 `not_ready`，保留 health、Agent 授權與 Vault 設定 API，其他業務 API 回傳 503 `vault_not_ready`；不建立替代空 Vault 或搜尋資料。UI Onboarding 或 Agent 透過設定 API 建立或開啟 Vault 後，runtime 在同一組 listener 上掛上 workspace 並啟動排程，連線檔的 instance 與 token 不變。原生目錄選擇由 Electron preload 提供，只回傳路徑；建立、開啟與驗證都經由 HTTP API。開發與驗收可用 `XR_COLLECTOR_VAULT` 指定 Vault，空目錄會自動建立，無法辨識的內容則進入 `not_ready`。Vault 目錄規則見 [儲存與搜尋](storage-and-search.md#vault-目錄與選址)。

安裝版將目前 active runtime 的 Agent 連線資訊發布到每位使用者固定的裝置入口：macOS Application Support 或 Windows LocalAppData 下的 `XR Collector/agent-connection.json`。此入口與安裝目錄及 Vault 分離；未打包執行與明確指定 profile 的執行只寫 profile-local 連線檔，因而不覆蓋正式入口。連線檔包含 schema version、instance ID、loopback URL 與每次啟動重建的 token。Agent 先以 authenticated health 比對 instance ID，才使用業務 API；保留的舊連線檔只表示曾啟動，不表示服務仍存活。

改動正式資料格式或來源契約時，同一張 ticket 須涵蓋既有 Vault 可讀性、匯出／還原／合併及索引影響。原生驗證、CI 與建置方式見 [開發驗證流程](development-validation.md)。
