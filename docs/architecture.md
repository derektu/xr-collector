# XR Collector 架構

本文件描述可執行版本的組成。Round 2 的目標模組、服務生命週期與待實作行為集中於 [開發計畫](round-2-plan.md)，避免將規劃視為已交付能力。

## 執行與業務邊界

Electron 啟動本機 Fastify Web Server，載入 React 畫面；Web 開發模式使用 Vite 代理 `/api`。業務畫面透過 HTTP API 操作收集、訂閱、排程、文件、搜尋與 Vault，業務邏輯不使用 Electron IPC。

| 模組 | 現行責任 |
| --- | --- |
| `src/electron` | 主視窗、profile、內附 runtime 路徑與程式生命週期 |
| `src/runtime` | 單一 VaultWorkspace、UI／Agent listeners 與啟動／關閉順序 |
| `src/server` | UI／Agent HTTP routes、Bearer 授權與 listener |
| `src/core` | 共用型別、來源類型登錄（`source-registry.ts`）、文件保存與索引 |
| `src/plugins` | 來源 plugin 介面（`types.ts`）、server 端組裝清單（`index.ts`）與各來源類型的 plugin；`src/plugins/youtube` 含網址辨識、字幕處理、收集設定與 yt-dlp 實作 |
| `src/sources` | 網址辨識的分派與來源列表 |
| `src/jobs` | 收集工作的接受、去重、有界佇列、公平派工與裝置端持久紀錄 |
| `src/subscriptions` | 各來源類型的訂閱與設定檔讀寫、每次檢查的收集規則（範圍內最新 N 則）、檢查工作提交及依各訂閱頻率的週期檢查 |
| `src/pacing` | 依請求群組排隊、間隔與冷卻的請求通道 |
| `src/vault` | Markdown 保存、active Vault、匯出檔、以較新為準的匯入合併、搬移與中斷恢復 |
| `src/search` | Meilisearch 子程序、索引狀態、查詢與重建 |
| `src/web` | React 操作畫面與 HTTP client；來源類型的文字、設定句與文件細節取自 `src/web/plugins.tsx` 組裝的宣告 |

UI 與 Agent 共用 Collector、Vault、收集工作、訂閱、排程和搜尋服務。Agent 使用獨立 loopback HTTP 入口及每次啟動產生的 Bearer token，可操作所有現有業務 routes；跨程序服務依下述固定裝置入口發現 active runtime。

收集以工作執行。HTTP 先把工作寫入 profile 的 `jobs/jobs.json` 再回傳 202，網路解析與擷取都在 `JobManager` 的背景佇列中完成：訂閱解析與檢查、單一項目擷取各有並行上限（擷取一次一則），擷取在提交它的工作之間輪替。每個 Vault bundle 有自己的 `JobManager`，持有該 Vault 的文件、搜尋與訂閱物件，因此工作只寫入提交時的 Vault。

核心（工作、訂閱、排程、Vault、搜尋、活動紀錄、資料交換、HTTP 與共用畫面）不認得任何來源類型，只經由 `src/plugins/types.ts` 的介面與來源類型登錄操作來源。每個 plugin 宣告它接受的網址、項目擷取、訂閱列出項目的方式、失敗的重試分類、請求節奏、訂閱設定、文件的來源專屬 frontmatter、畫面用字、需要的 Vault 與匯出檔格式版本，以及核心之外的錯誤碼與其 HTTP 狀態；工作種類在線上寫為 `<類型>.<名稱>`，去重以來源類型區分。Server 程序與 Electron 由 `src/plugins/index.ts` 的來源清單組裝 plugin，清單每一項是一個來源類型的定義與 plugin factory，factory 從組裝端取得外部程式路徑與所屬請求群組的通道；Web 畫面由 `src/web/plugins.tsx` 登錄宣告。新增訂閱選單中尚未支援的類型（X、Facebook、RSS）是 `src/web/add-menu.ts` 的資料，以相同 ID 登錄的 plugin 會取代它的位置。登錄外的來源類型留下的文件、工作與訂閱照原樣保存，核心不對它們動作。

每個程序對每個請求群組有一條請求通道（`PacingGate`），群組內的請求都經過它：同一時間只有一個請求，相鄰請求間依 plugin 宣告隨機等待，讓取用節奏接近一般使用者、不形成固定規律；被限制連線時通道冷卻（5 分鐘起、連續限制加倍、上限 60 分鐘），冷卻狀態存於 profile 的 `<群組>-pacing.json`，冷卻期間工作留在佇列並標示等待，不消耗重試次數，其他群組不受影響。YouTube plugin 的群組是 `youtube`，所有 yt-dlp 請求都經過它，相鄰請求間等待 4–12 秒。字幕選擇只採原文軌道：自動字幕以 yt-dlp 實際下載的格式判斷是否為翻譯，同一語言優先 `-orig` 軌道。

Scheduler 涵蓋所有來源類型的訂閱，到期時提交檢查工作即返回，以工作結束的通知記錄上次結果。

## Runtime 與資料

搜尋採完整 Meilisearch binary，由程式管理獨立子程序，監聽 loopback 並使用隨機 key。yt-dlp、Deno 與 Meilisearch 由下載腳本固定版本；安裝包內附所需工具。沒有嵌入 milli library 或要求安裝完整 Agent-Reach／summarize。

文件、搜尋與 UI 使用來源無關的文件欄位（文件 ID、來源類型與來源內 ID、publisher、日期），來源專屬資訊放在各自的欄位區塊，例如 YouTube 的字幕語言；篩選以來源類型與 publisher ID 進行，不依賴顯示名稱。

Vault 保存正式文件與可攜設定；搜尋 database 是裝置上的可重建資料。profile、憑證與連線資訊不隨匯出檔交換。格式與恢復責任分別見 [文件格式](document-format.md)、[儲存與搜尋](storage-and-search.md)。

## Round 2 的架構方向

Collector 服務可獨立於 UI 運作，UI、Agent 與排程使用一致的工作與資料能力。Sources、Documents、Jobs、Activity、Search、VaultWorkspace 的責任及遷移順序以 [Round 2 第 5 節](round-2-plan.md#5-建議模組分工) 為準；來源類型以上述 plugin 介面加入。

`CollectorRuntime` 是 process 內的服務 owner。Standalone server 與 Electron 提供各自的 profile、runtime binary 與 UI listener 參數，兩者都由同一個 runtime factory 建立 VaultWorkspace、scheduler、搜尋 process 及已授權 Agent listener。關閉時先停止 listeners 並等待已接受的 handler，再等待資料交換與執行中的收集步驟，把尚未開始的工作記為已中斷，最後關閉搜尋 process。開啟 Vault 時，workspace 先接續該 Vault 的中斷工作，再啟動排程，讓重啟後的第一次檢查併入接續中的工作。尚未設定 Vault 或已記錄的 Vault 無法開啟時，runtime 進入 `not_ready`，保留 health、Agent 授權與 Vault 設定 API，其他業務 API 回傳 503 `vault_not_ready`；不建立替代空 Vault 或搜尋資料。UI Onboarding 或 Agent 透過設定 API 建立或開啟 Vault 後，runtime 在同一組 listener 上掛上 workspace 並啟動排程，連線檔的 instance 與 token 不變。原生目錄選擇由 Electron preload 提供，只回傳路徑；建立、開啟與驗證都經由 HTTP API。開發與驗收可用 `XR_COLLECTOR_VAULT` 指定 Vault，空目錄會自動建立，無法辨識的內容則進入 `not_ready`。Vault 目錄規則見 [儲存與搜尋](storage-and-search.md#vault-目錄與選址)。

安裝版將目前 active runtime 的 Agent 連線資訊發布到每位使用者固定的裝置入口：macOS Application Support 或 Windows LocalAppData 下的 `XR Collector/agent-connection.json`。此入口與安裝目錄及 Vault 分離；未打包執行與明確指定 profile 的執行只寫 profile-local 連線檔，因而不覆蓋正式入口。連線檔包含 schema version、instance ID、loopback URL 與每次啟動重建的 token。Agent 先以 authenticated health 比對 instance ID，才使用業務 API；保留的舊連線檔只表示曾啟動，不表示服務仍存活。

改動正式資料格式或來源契約時，同一張 ticket 須涵蓋既有 Vault 可讀性、匯出／匯入（修改時間與刪除紀錄的比較）及索引影響。原生驗證、CI 與建置方式見 [開發驗證流程](development-validation.md)。
