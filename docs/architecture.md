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
| `src/jobs` | 收集工作的接受、去重、有界佇列、公平派工、自動重試、請求通道冷卻時的等待、重啟接續與裝置端持久紀錄，以及工作頁的進行中、排隊中與失敗清單；訂閱的檢查計畫與結果經訂閱 port（`subscription-port.ts`）取得與回報，並提供每個訂閱一筆工作事實（進行中檢查是排隊中或更新中與進度、是否有項目在擷取、新增中的請求） |
| `src/subscriptions` | 訂閱資料唯一的寫入者：建立訂閱、派工與派工時間、收集進度（上次檢查時間、範圍外項目、失敗項目與跨檢查的失敗次數、連續失敗的檢查次數與自動暫停），以及每次檢查的收集規則（範圍內最新 N 則）；整份清單驗證通過才開始的手動檢查、依各訂閱頻率的週期檢查，並把工作事實與訂閱本身的狀態組合成訂閱狀態 |
| `src/pacing` | 依請求群組排隊、間隔與冷卻的請求通道 |
| `src/vault` | Markdown 保存、active Vault、知識庫操作鎖、匯出檔、以較新為準的匯入合併、搬移與中斷恢復 |
| `src/search` | Meilisearch 子程序、索引狀態、查詢與重建 |
| `src/web` | React 操作畫面與 HTTP client；來源類型的文字、設定句與文件細節取自 `src/web/plugins.tsx` 組裝的宣告 |

UI 與 Agent 共用 Collector、Vault、收集工作、訂閱、排程和搜尋服務。Agent 使用獨立 loopback HTTP 入口及 profile 持久保存的 Bearer token，可操作所有現有業務 routes；人或 Agent 從設定頁下載 Skill 與目前 active 連線資料，不掃描裝置入口。

收集以工作執行。HTTP 先把工作寫入 profile 的 `jobs/jobs.json` 再回傳 202，網路解析與擷取都在 `JobManager` 的背景佇列中完成：訂閱解析與檢查、單一項目擷取各有並行上限（擷取一次一則），擷取在提交它的工作之間輪替。每個 Vault bundle 有自己的 `JobManager`，持有該 Vault 的文件、搜尋與訂閱物件，因此工作只寫入提交時的 Vault。

`JobManager` 與訂閱之間只有訂閱 port 這一條 seam；正式環境由 `SubscriptionServices` 實作。只有開始探索的新檢查算一次派工，由 `SubscriptionService` 送出並更新派工時間：定時檢查、立即檢查與新增訂閱後的首次檢查。新增訂閱的工作解析完網址後，把結果與接受時的收集設定交給 `SubscriptionService` 建立訂閱並派工首次檢查。重試失敗項目與重啟後接續中斷的檢查不是派工，不更新派工時間。檢查結束時（項目全部結束，或檢查本身失敗）`JobManager` 回報結束時間與失敗原因，`SubscriptionService` 據此寫入上次檢查時間、累計或清除連續失敗，並在達到門檻時自動暫停；因暫停、移除或較新工作取代而略過的檢查，以及只重試失敗項目的工作，不回報結束；暫停或移除時已在擷取的項目完成後，檢查只記錄時間，不改連續失敗。檢查開始探索前向 port 取得計畫（收集範圍、要排除的項目，或訂閱已暫停／移除）；項目工作寫入持久紀錄後才回報這次的候選，收集進度因此一定在項目工作之後寫入。工作內暫時性錯誤的自動重試次數屬於 `JobManager`，同一項目跨檢查的失敗次數屬於 `SubscriptionService`，兩者分開計算。

檢查中收集失敗的項目記在訂閱的 `failures`，不讓檢查失敗；之後的檢查重試它，失敗滿 3 次或屬 plugin 分類為不重試的錯誤時略過。檢查只有列出訂閱失敗時才算失敗。單一項目與新增訂閱的失敗留在工作頁的失敗區，可重試或移除。

核心（工作、訂閱、排程、Vault、搜尋、活動紀錄、資料交換、HTTP 與共用畫面）不認得任何來源類型，只經由 `src/plugins/types.ts` 的介面與來源類型登錄操作來源。每個 plugin 宣告它接受的網址、項目擷取、訂閱列出項目的方式、失敗的重試分類、請求節奏、訂閱設定、文件的來源專屬 frontmatter、畫面用字、需要的 Vault 與匯出檔格式版本，以及核心之外的錯誤碼與其 HTTP 狀態；工作種類在線上寫為 `<類型>.<名稱>`，去重以來源類型區分。HTTP 的收集與訂閱路由不分類型：`POST /api/submissions`、`POST /api/items` 與 `POST /api/subscriptions` 由網址找到所屬的來源類型，訂閱以 `/api/subscriptions/:type/:id` 識別，排程（`/api/schedule`）涵蓋所有類型，請求通道狀態（`/api/pacing`）每個請求群組一筆；回應以訂閱為名詞（`subscription`、`subscriptions`、`subscriptionId`），新增來源類型不需要新路由。Server 程序與 Electron 由 `src/plugins/index.ts` 的來源清單組裝 plugin，清單每一項是一個來源類型的定義與 plugin factory，factory 從組裝端取得外部程式路徑與所屬請求群組的通道；Web 畫面由 `src/web/plugins.tsx` 登錄宣告。新增訂閱選單中尚未支援的類型（X、Facebook、RSS）是 `src/web/add-menu.ts` 的資料，以相同 ID 登錄的 plugin 會取代它的位置。登錄外的來源類型留下的文件、工作與訂閱照原樣保存，核心不對它們動作。

每個程序對每個請求群組有一條請求通道（`PacingGate`），群組內的請求都經過它：同一時間只有一個請求，相鄰請求間依 plugin 宣告隨機等待，讓取用節奏接近一般使用者、不形成固定規律；被限制連線時通道冷卻（5 分鐘起、連續限制加倍、上限 60 分鐘），冷卻狀態存於 profile 的 `<群組>-pacing.json`，冷卻期間工作留在佇列並標示等待，不消耗重試次數，其他群組不受影響。YouTube plugin 的群組是 `youtube`，所有 yt-dlp 請求都經過它，相鄰請求間等待 4–12 秒。字幕選擇只採原文軌道：自動字幕以 yt-dlp 實際下載的格式判斷是否為翻譯，同一語言優先 `-orig` 軌道。

Scheduler 涵蓋所有來源類型的訂閱，到期時經 `SubscriptionService` 派工即返回，以工作結束的通知記錄上次結果；「檢查全部」也一律經由它的 `runNow`。`POST /api/subscription-checks` 列出的訂閱由 `SubscriptionServices` 先驗證整份清單，任何一個不存在或已暫停就整個拒絕，不開始任何工作。

## Runtime 與資料

搜尋採從固定 upstream commit 建置的 Chinese Meilisearch binary，由程式管理獨立子程序，監聽 loopback 上隨機分配的 port 並使用隨機 key。建置 manifest 記錄 source、Cargo.lock、Rust、target 與 build 前 binary identity；build cache、安裝替換與 native smoke 以該 raw SHA/bytes 驗證完整 pair。App 啟動時以已內附 manifest 作為 bundle 信任邊界，核對固定 recipe/target、實際 executable header 架構及 `--version`，不以 build 前 raw SHA 認證簽章後的來源 bits；驗證失敗不啟動、也不清除搜尋資料。啟動前會結束同一 database 上一次執行被強制結束時留下的引擎程序，以 database 旁的 pid 檔辨識，並核對紀錄與命令列中的執行檔及 database 路徑；無法證明 ownership 或無法確認退出時 fail closed。每個 Vault 的可重建 database 另有只描述 engine/index 語意的 profile marker，與 binary SHA、簽章、建置時間及 runner 分離；profile 不符才清除該 Vault 的 database/state/pid/marker，完整重建成功後才原子寫入新 marker。搜尋 settings 與 query contract 不因 build profile 改變。

yt-dlp 與 Deno 由下載腳本固定版本；Meilisearch 則由專用 source build 指令固定版本、commit、lockfile、toolchain 與 Chinese feature。安裝包內附 runtime 及 Meilisearch build manifest，終端使用者不需 Rust。yt-dlp 採官方資料夾版（執行檔與 `_internal`），放在 runtime 目錄的 `yt-dlp/` 下：單一執行檔版每次執行都要先解壓到新的暫存目錄，系統又會檢查這些新檔案，每次呼叫因此多花數秒。沒有嵌入 milli library 或要求安裝完整 Agent-Reach／summarize。

文件、搜尋與 UI 使用來源無關的文件欄位（文件 ID、來源類型與來源內 ID、publisher、日期），來源專屬資訊放在各自的欄位區塊，例如 YouTube 的字幕語言；篩選以來源類型與 publisher ID 進行，不依賴顯示名稱。

Vault 保存正式文件與可攜設定；搜尋 database 是裝置上的可重建資料。profile、憑證與連線資訊不隨匯出檔交換。格式與恢復責任分別見 [文件格式](document-format.md)、[儲存與搜尋](storage-and-search.md)。

## Round 2 的架構方向

Collector 服務可獨立於 UI 運作，UI、Agent 與排程使用一致的工作與資料能力。Sources、Documents、Jobs、Activity、Search、VaultWorkspace 的責任及遷移順序以 [Round 2 第 5 節](round-2-plan.md#5-建議模組分工) 為準；來源類型以上述 plugin 介面加入。

`CollectorRuntime` 是 process 內的服務 owner。Standalone server 與 Electron 提供各自的 profile、runtime binary 與 UI listener 參數，兩者都由同一個 runtime factory 建立 VaultWorkspace、scheduler、搜尋 process 及已授權 Agent listener。關閉時先停止 listeners 並等待已接受的 handler，再等待資料交換與執行中的收集步驟，把尚未開始的工作記為已中斷，最後關閉搜尋 process。開啟 Vault 時，workspace 先接續該 Vault 的中斷工作，再啟動排程，讓重啟後的第一次檢查併入接續中的工作。尚未設定 Vault 或已記錄的 Vault 無法開啟時，runtime 進入 `not_ready`，保留 health、Agent 授權與 Vault 設定 API，其他業務 API 回傳 503 `vault_not_ready`；不建立替代空 Vault 或搜尋資料。UI Onboarding 或 Agent 透過設定 API 建立或開啟 Vault 後，runtime 在同一組 listener 上掛上 workspace 並啟動排程。原生目錄選擇由 Electron preload 提供，只回傳路徑；建立、開啟與驗證都經由 HTTP API。開發與驗收可用 `XR_COLLECTOR_VAULT` 指定 Vault，空目錄會自動建立，無法辨識的內容則進入 `not_ready`。Vault 目錄規則見 [儲存與搜尋](storage-and-search.md#vault-目錄與選址)。

`VaultWorkspace` 持有一個知識庫操作鎖，匯出、匯入、搬移與開啟其他知識庫都經同一個生命週期執行：停止派工、等待進行中的收集、執行操作、恢復收集，再發布完成或錯誤狀態。套用匯入時鎖會升級為連讀取也拒絕；如果匯入無法收尾，鎖進入停止狀態並維持寫入與排程停止，等待重新啟動恢復。HTTP route config 把路由分為知識庫讀取、知識庫寫入、裝置資料與知識庫操作；沒有宣告時依 method 推定，鎖依分類決定是否接受請求。

`AgentConnectionService` 在 profile 內保存私有金鑰與連線埠模式；金鑰跨重啟維持，只有使用者重設後才更新。自動模式由平台起始埠往後找十個候選，再交由作業系統配置可用埠；固定模式只嘗試指定埠，失敗只讓 Agent listener 顯示無法連線，不阻止 UI、Vault 與已接受工作啟動。設定修改先持久化，於下次啟動套用，現有 listener 不熱換。App 只透過設定頁輸出目前 active URL 與金鑰；下載包包含通用 Skill 與同層 `connection.json`，產品不發布作業系統固定 discovery file，也不以安裝目錄、Vault 或 instance ID 配對。

改動正式資料格式或來源契約時，同一張 ticket 須涵蓋既有 Vault 可讀性、匯出／匯入（修改時間與刪除紀錄的比較）及索引影響。原生驗證、CI 與建置方式見 [開發驗證流程](development-validation.md)。
