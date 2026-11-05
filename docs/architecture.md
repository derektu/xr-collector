# XR Collector 架構

本文件描述可執行版本的組成。Round 2 的目標模組、服務生命週期與待實作行為集中於 [開發計畫](round-2-plan.md)，避免將規劃視為已交付能力。

## 執行與業務邊界

Electron 啟動本機 Fastify Web Server，載入 React 畫面；Web 開發模式使用 Vite 代理 `/api`。業務畫面透過 HTTP API 操作收集、訂閱、排程、文件、搜尋與 Vault，業務邏輯不使用 Electron IPC。

| 模組 | 現行責任 |
| --- | --- |
| `src/electron` | 桌面殼層：`main.ts` 把 Electron 接上各模組，並以 `src/server/collector-server.ts` 啟動本程序的 runtime 與 HTTP listener；啟動與 single-instance（`desktop-launch.ts`）、主視窗（`main-window.ts`）、頁面與對話框 IPC（`page-channels.ts`、`desktop-dialogs.ts`）、由環境與封裝內容決定的設定（`desktop-environment.ts`）、驗證專用的控制通道（`validation-control.ts`）、系統匣、通知、登入自啟與更新協調各在自己的檔案，接收注入的 Electron 介面 |
| `src/runtime` | 組裝：`CollectorRuntime` 持有程序內唯一的 Vault workspace、Agent 連線金鑰與設定（`agent-connection.ts`）及啟動／關閉順序，listener 由傳輸層交給它啟動；`vault-workspace.ts` 為每個開啟的 Vault 組出收集、訂閱、工作、排程與搜尋服務，並負責開啟其他知識庫與建立新的知識庫；隨附資源（runtime 程式、Mac 更新小幫手、搜尋詞庫、Agent Skill、系統匣圖示）的路徑只由 `bundled-resources.ts` 依開發版或打包版與平台算出，Electron、Mac 更新安裝、開發 server 與 verify skill 都向它要 |
| `src/server` | UI／Agent HTTP listener。`collector-server.ts` 以 runtime 啟動兩個 listener：先在 Agent 連線的埠開 Agent listener，再開 UI listener。`app.ts` 依序掛上每個請求都會經過的 hook 鏈（Host 檢查、Bearer 授權、Vault 未就緒的 503、知識庫操作鎖、回應標頭與錯誤狀態，錯誤碼對應的 HTTP 狀態在 `error-status.ts`），再依傳入的服務註冊各區塊的 route；每個區塊的 route 在 `routes/` 下自己的檔案（Vault 設定、資料交換、裝置、Agent 連線、文件與搜尋、收集工作、活動記錄、排程、訂閱與來源類型、變動串流），查詢參數的解析與驗證在 `routes/query-params.ts`。兩個 listener 送出的每個 JSON 回應與變動事件，字串值中 process 持有的已知機密（Agent 金鑰、Meilisearch 金鑰）都經 `src/core/redact.ts` 遮蔽，不論來自哪個 route、hook 或沒有對應 route 的回應；Agent 連線資料的成功回應依設計交出金鑰，檔案下載與 UI 頁面原樣送出。出口只比對已知機密的字面值，文件內容與網址裡像憑證的字（`bearer`、`?key=`）照原樣送出；憑證樣式（Authorization、cookie、帶密鑰的網址參數）在可能帶外部程式輸出的訊息產生處遮蔽：錯誤回應、工作錯誤、活動記錄、通知與搜尋引擎的啟動失敗 |
| `src/core` | 共用型別、共用的值、來源類型的宣告值 `SourceDeclarations` 與 server 用的 `SourceRegistry`（`source-registry.ts`）、文件保存與索引（`collector.ts`，刪除紀錄經它的 `DeletionRecords` 介面讀寫，實作在 `src/vault`）。型別依區塊分檔為 `*-types.ts`（文件、搜尋、訂閱、來源資訊、工作、活動記錄、Vault、更新、裝置），這些檔只有型別、只 import 型別，所以 server、Electron 與 Web 引用它們不會帶進任何程式；共用的值各在自己的模組，例如 `CollectorError`（`collector-error.ts`）與訂閱的失敗上限（`subscription-limits.ts`） |
| `src/plugins` | 來源 plugin 介面（`types.ts`）、server 端組裝清單（`index.ts`）與各來源類型的 plugin；`src/plugins/youtube` 含網址辨識、字幕處理、收集設定與 yt-dlp 實作 |
| `src/sources` | 網址辨識的分派與來源列表 |
| `src/jobs` | 收集工作的接受、去重、有界佇列與公平派工（順序在 `job-queue.ts`）、自動重試、請求通道冷卻時的等待、重啟接續（`job-recovery.ts`）與裝置端持久紀錄，以及工作頁的進行中、排隊中與失敗清單；訂閱的檢查計畫與結果經訂閱 port（`subscription-port.ts`）取得與回報（`subscription-reports.ts`），並提供每個訂閱一筆工作事實（進行中檢查是排隊中或更新中與進度、是否有項目在擷取、新增中的請求） |
| `src/activity` | 裝置活動記錄。`activity-log.ts` 只負責事件的儲存、遮蔽、保留與事件 ID：ID 開頭的序號由記錄發出，開啟時從保留中的事件的最大序號接續；`activity-views.ts` 依事件寫入時就帶著的欄位與事件目錄，提供原始分頁與檢查摘要。事件種類與摘要的顯示規則（是否列出、是否列為檢查底下的子列、預設嚴重度）列在 `src/core/event-catalog.ts`，目錄沒有的種類 typecheck 失敗。收集工作的紀錄只把事件交給活動記錄，不持有它；兩者在 `src/runtime/job-records.ts` 組合：記錄補上工作後來得知的標題，掉了事件的工作標記為紀錄不完整 |
| `src/subscriptions` | 訂閱資料唯一的寫入者：建立訂閱、派工與派工時間、收集進度（上次檢查時間、範圍外項目、失敗項目與跨檢查的失敗次數、連續失敗的檢查次數與自動暫停），以及每次檢查的收集規則（範圍內最新 N 則）；整份清單驗證通過才開始的手動檢查、依各訂閱頻率的週期檢查，並把工作事實與訂閱本身的狀態組合成訂閱狀態。訂閱檔的格式、紀錄欄位的分類（`subscription-fields.ts`）與兩份訂閱檔的合併也屬於這裡；Vault 的開啟、匯出與匯入經 `core/subscription-exchange.ts` 的契約使用它們，實作由 `subscriptionFileExchange(registry)` 建立、存在 `SourceRegistry.exchange` |
| `src/pacing` | 依請求群組排隊、間隔與冷卻的請求通道 |
| `src/vault` | Markdown 保存、知識庫操作鎖、匯出檔、以較新為準的匯入合併、使用中 Vault 的匯出與匯入（`vault-exchange.ts`，經 `ExchangeHost` 介面取得使用中的 Vault 與操作鎖）與中斷恢復 |
| `src/search` | Meilisearch 子程序、索引狀態、查詢與重建 |
| `src/web` | React 操作畫面與 HTTP client；來源類型的文字、設定句與文件細節取自元件經 React context 拿到的宣告（`src/plugins/declarations.ts`） |


模組由下而上分五層：共用型別、純函式與來源契約（`src/core`）；領域服務（工作、訂閱、Vault、搜尋、活動記錄、請求通道、通知、更新、來源與各來源類型的 plugin）；組裝（`src/runtime` 與產品的來源清單 `src/plugins/index.ts`、`declarations.ts`）；傳輸（`src/server`、`src/web`）；桌面殼層（`src/electron`），它啟動本程序的 HTTP server。每個模組只 import 自己、較低層，以及同層中明列允許的模組，型別 import 也算；較低層中也有明列不准 import 的模組：桌面殼層只經 IPC 與 HTTP 跟畫面溝通，不 import `src/web`；`tests/tooling/import-layers.test.ts` 檢查每條 import。

UI 與 Agent 共用 Collector、Vault、收集工作、訂閱、排程和搜尋服務。Agent 使用獨立 loopback HTTP 入口及 profile 持久保存的 Bearer token，可操作所有現有業務 routes；人或 Agent 從設定頁下載 Skill 與目前 active 連線資料，不掃描裝置入口。

收集以工作執行。HTTP 先把工作寫入 profile 的 `jobs/jobs.json` 再回傳 202，網路解析與擷取都在 `JobManager` 的背景佇列中完成：訂閱解析與檢查、單一項目擷取各有並行上限（擷取一次一則），擷取在提交它的工作之間輪替。每個 Vault bundle 有自己的 `JobManager`，持有該 Vault 的文件、搜尋與訂閱物件，因此工作只寫入提交時的 Vault。

`JobManager` 與訂閱之間只有訂閱 port 這一條 seam；正式環境由 `SubscriptionServices` 實作。只有開始探索的新檢查算一次派工，由 `SubscriptionService` 送出並更新派工時間：定時檢查、立即檢查與新增訂閱後的首次檢查。新增訂閱的工作解析完網址後，把結果與接受時的收集設定交給 `SubscriptionService` 建立訂閱並派工首次檢查。重試失敗項目與重啟後接續中斷的檢查不是派工，不更新派工時間。檢查結束時（項目全部結束，或檢查本身失敗）`JobManager` 回報結束時間與失敗原因，`SubscriptionService` 據此寫入上次檢查時間、累計或清除連續失敗，並在達到門檻時自動暫停；因暫停、移除或較新工作取代而略過的檢查，以及只重試失敗項目的工作，不回報結束；暫停或移除時已在擷取的項目完成後，檢查只記錄時間，不改連續失敗。檢查開始探索前向 port 取得計畫，或得知訂閱已暫停／移除；計畫帶著訂閱的候選規則（`src/subscriptions/candidates.ts`：收集範圍、項目上限、要排除的項目），`JobManager` 只列出來源、把清單交給計畫，依它挑出的項目排入工作；項目工作寫入持久紀錄後才回報這次的候選，收集進度因此一定在項目工作之後寫入。工作內暫時性錯誤的自動重試次數屬於 `JobManager`，同一項目跨檢查的失敗次數屬於 `SubscriptionService`，兩者分開計算。

檢查中收集失敗的項目記在訂閱的 `failures`，不讓檢查失敗；之後的檢查重試它，失敗滿 3 次或屬 plugin 分類為不重試的錯誤時略過。檢查只有列出訂閱失敗時才算失敗。單一項目與新增訂閱的失敗留在工作頁的失敗區，可重試或移除。

核心（工作、訂閱、排程、Vault、搜尋、活動紀錄、資料交換、HTTP 與共用畫面）不認得任何來源類型，只經由 `src/core/source-contract.ts` 的介面與傳給它的 `SourceRegistry` 操作來源。`SourceRegistry`（`src/core/source-registry.ts`）是一次建好、不可變的值：各類型的宣告與 server 定義、涵蓋所有類型訂閱的排程檔，以及 Vault 讀寫訂閱檔用的 subscription exchange；module 層級沒有可變狀態，Vault、訂閱、工作、搜尋、來源與 HTTP 都由建構或參數取得它，所以同一個程序內兩個帶不同類型的 runtime 各自運作。每個 plugin 宣告它接受的網址、項目擷取、訂閱列出項目的方式、失敗的重試分類、請求節奏、訂閱設定、文件的來源專屬 frontmatter、畫面用字、引入它的 Vault 與匯出檔格式版本（程式的版本取所有類型中最高者），以及核心之外的錯誤碼與其 HTTP 狀態；工作種類在線上寫為 `<類型>.<名稱>`，去重以來源類型區分。HTTP 的收集與訂閱路由不分類型：`POST /api/submissions`、`POST /api/items` 與 `POST /api/subscriptions` 由網址找到所屬的來源類型，訂閱以 `/api/subscriptions/:type/:id` 識別，排程（`/api/schedule`）涵蓋所有類型，請求通道狀態（`/api/pacing`）每個請求群組一筆；回應以訂閱為名詞（`subscription`、`subscriptions`、`subscriptionId`），新增來源類型不需要新路由。產品提供的來源類型與順序只列在 `src/plugins/declarations.ts` 一處，這份宣告清單不含 Node 專用的程式，server 與 Web 共用。Server 程序與 Electron 由 `src/plugins/index.ts` 的 `createSourcePlugins` 依這份清單組裝 plugin，並用這些 plugin 建出 registry，一起回傳 `{ registry, plugins, pacing }`：每個類型對應一個定義與 plugin factory，宣告與 server 項目任一邊缺少時載入就失敗；factory 從組裝端取得外部程式路徑與所屬請求群組的通道。`CollectorRuntime.start` 以必填的 `sources` 取得 registry，確認傳入的 plugin 正是 registry 的類型、順序相同，否則不啟動。Web 畫面由 `src/web/plugins.tsx` 以同一份宣告建立不可變的 `SourceDeclarations`，`src/web/main.tsx` 經 React context（`src/web/source-declarations.tsx`）提供給元件，元件以 `useSourceDeclarations()` 取得，再當參數傳給 presentation 函式與 `src/core/job-role.ts`；`plugins.tsx` 也為每個類型提供圖示，徽章顏色在 `src/web/plugins.css`。一個網址屬於清單中第一個認領它的類型；RSS 認領所有 web 網址，所以排在最後。新增訂閱選單中尚未支援的類型（X、Facebook、RSS）是 `src/web/add-menu.ts` 的資料，以相同 ID 宣告的類型會取代它的位置。registry 沒有的來源類型留下的文件、工作與訂閱照原樣保存，核心不對它們動作。

每個程序對每個請求群組有一條請求通道（`PacingGate`），群組內的請求都經過它：同一時間只有一個請求，相鄰請求間依 plugin 宣告隨機等待，讓取用節奏接近一般使用者、不形成固定規律；被限制連線時通道冷卻（5 分鐘起、連續限制加倍、上限 60 分鐘），冷卻狀態存於 profile 的 `<群組>-pacing.json`，冷卻期間工作留在佇列並標示等待，不消耗重試次數，其他群組不受影響。YouTube plugin 的群組是 `youtube`，所有 yt-dlp 請求都經過它，相鄰請求間等待 4–12 秒。字幕選擇只採原文軌道：自動字幕以 yt-dlp 實際下載的格式判斷是否為翻譯，同一語言優先 `-orig` 軌道。

Scheduler 涵蓋所有來源類型的訂閱，到期時經 `SubscriptionService` 派工即返回，以工作結束的通知記錄上次結果；「檢查全部」也一律經由它的 `runNow`。`POST /api/subscription-checks` 列出的訂閱由 `SubscriptionServices` 先驗證整份清單，任何一個不存在或已暫停就整個拒絕，不開始任何工作。

## Runtime 與資料

搜尋採 Meilisearch 官方 release binary（版本、asset URL、bytes 與 SHA-256 釘在 `src/search/meilisearch-runtime-pins.json`），由程式管理獨立子程序，監聽 loopback 上隨機分配的 port 並使用隨機 key。binary 旁的 manifest 記錄 release asset 與 binary identity；runtime cache、安裝替換與 native smoke 以該 raw SHA/bytes 驗證完整 pair。App 啟動時以內附 manifest 作為 bundle 信任邊界，要求它與 pin 完全一致，並核對實際 executable header 架構及 `--version`；Developer ID 簽章改變 bytes 時，改以被 App seal 保護的簽署 identity 認證。驗證失敗不啟動、也不清除搜尋資料。啟動前會結束同一 database 上一次執行被強制結束時留下的引擎程序，以 database 旁的 pid 檔辨識，並核對紀錄與命令列中的執行檔及 database 路徑；無法證明 ownership 或無法確認退出時 fail closed。每個 Vault 的可重建 database 另有只描述 engine/index 語意的 profile marker，與 binary SHA、簽章及建置時間分離；profile 不符才清除該 Vault 的 database/state/pid/marker，完整重建成功後才原子寫入新 marker。中文查詢的命中範圍由 App 的搜尋正規化、contiguous fragment 查詢與 COCT 詞庫決定；引擎的分詞影響相關度排序。

yt-dlp、Deno 與 Meilisearch 都由 `prepare:runtime` 下載固定版本並核對 SHA-256。Windows 的 Meilisearch 依賴 `vcruntime140.dll`，安裝包附帶 repo 內釘住版本、經 Microsoft 簽章核對的 app-local 副本。終端使用者不需安裝任何 runtime。yt-dlp 採官方資料夾版（執行檔與 `_internal`），放在 runtime 目錄的 `yt-dlp/` 下：單一執行檔版每次執行都要先解壓到新的暫存目錄，系統又會檢查這些新檔案，每次呼叫因此多花數秒。沒有嵌入 milli library 或要求安裝完整 Agent-Reach／summarize。

文件、搜尋與 UI 使用來源無關的文件欄位（文件 ID、來源類型與來源內 ID、publisher、日期），來源專屬資訊放在各自的欄位區塊，例如 YouTube 的字幕語言；篩選以來源類型與 publisher ID 進行，不依賴顯示名稱。

Vault 保存正式文件與可攜設定；搜尋 database 是裝置上的可重建資料。profile、憑證與連線資訊不隨匯出檔交換。格式與恢復責任分別見 [文件格式](document-format.md)、[儲存與搜尋](storage-and-search.md)。

## Round 2 的架構方向

Collector 服務可獨立於 UI 運作，UI、Agent 與排程使用一致的工作與資料能力。Sources、Documents、Jobs、Activity、Search、VaultWorkspace 的責任及遷移順序以 [Round 2 第 5 節](round-2-plan.md#5-建議模組分工) 為準；來源類型以上述 plugin 介面加入。

`CollectorRuntime` 是 process 內的服務 owner。Standalone server 與 Electron 提供各自的 profile、runtime binary 與 UI listener 參數，兩者都經 `startCollectorServer` 由同一個 runtime 建立 VaultWorkspace、scheduler、搜尋 process 及已授權 Agent listener。啟動時先讀出 Agent 金鑰並在所有輸出中遮蔽，再開啟 Vault（接續的工作此時就可能失敗並寫出錯誤），最後啟動 listener。關閉時先停止 listeners 並等待已接受的 handler，再等待資料交換與執行中的收集步驟，把尚未開始的工作記為已中斷，最後關閉搜尋 process。開啟 Vault 時，workspace 先接續該 Vault 的中斷工作，再啟動排程，讓重啟後的第一次檢查併入接續中的工作。尚未設定 Vault 或已記錄的 Vault 無法開啟時，runtime 進入 `not_ready`，保留 health、Agent 授權與 Vault 設定 API，其他業務 API 回傳 503 `vault_not_ready`；不建立替代空 Vault 或搜尋資料。UI Onboarding 或 Agent 透過設定 API 建立或開啟 Vault 後，runtime 在同一組 listener 上掛上 workspace 並啟動排程。原生目錄選擇由 Electron preload 提供，只回傳路徑；建立、開啟與驗證都經由 HTTP API。開發與驗收可用 `XR_COLLECTOR_VAULT` 指定 Vault，空目錄會自動建立，無法辨識的內容則進入 `not_ready`。Vault 目錄規則見 [儲存與搜尋](storage-and-search.md#vault-目錄與選址)。

`VaultWorkspace` 持有一個知識庫操作鎖，匯出、匯入、建立新的知識庫與開啟其他知識庫都經同一個生命週期執行：停止派工、等待進行中的收集、執行操作、恢復收集，再發布完成或錯誤狀態。套用匯入時鎖會升級為連讀取也拒絕；如果匯入無法收尾，鎖進入停止狀態並維持寫入與排程停止，等待重新啟動恢復。HTTP route config 把路由分為知識庫讀取、知識庫寫入、裝置資料與知識庫操作；沒有宣告時依 method 推定，鎖依分類決定是否接受請求。

`AgentConnectionService` 在 profile 內保存私有金鑰與連線埠模式；金鑰跨重啟維持，只有使用者重設後才更新。自動模式由平台起始埠往後找十個候選，再交由作業系統配置可用埠；固定模式只嘗試指定埠，失敗只讓 Agent listener 顯示無法連線，不阻止 UI、Vault 與已接受工作啟動。設定修改先持久化，於下次啟動套用，現有 listener 不熱換。App 只透過設定頁輸出目前 active URL 與金鑰；下載包包含通用 Skill 與同層 `connection.json`，產品不發布作業系統固定 discovery file，也不以安裝目錄、Vault 或 instance ID 配對。

改動正式資料格式或來源契約時，同一張 ticket 須涵蓋既有 Vault 可讀性、匯出／匯入（修改時間與刪除紀錄的比較）及索引影響。原生驗證、CI 與建置方式見 [開發驗證流程](development-validation.md)。
