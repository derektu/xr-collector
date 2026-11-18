# XR Collector 架構

## 執行與業務邊界

Electron 啟動本機 Fastify Web Server，載入 React 畫面；Web 開發模式使用 Vite 代理 `/api`。業務畫面透過 HTTP API 操作收集、訂閱、排程、文件、搜尋與 Vault，業務邏輯不使用 Electron IPC；IPC 只用於主題、原生檔案選擇、在 Finder／檔案總管顯示與桌面導覽。

| 模組 | 責任 |
| --- | --- |
| `src/desktop/electron` | 桌面殼層：`main.ts` 把 Electron 接上各模組，並以 `src/transport/server` 的 `startCollectorServer`（`collector-server.ts`）啟動本程序的 runtime 與 HTTP listener；啟動與 single-instance（`desktop-launch.ts`）、主視窗（`main-window.ts`）、頁面與對話框 IPC（`page-channels.ts`、`desktop-dialogs.ts`）、由環境與封裝內容決定的設定（`desktop-environment.ts`）、驗證專用的控制通道（`validation-control.ts`）、系統匣、通知、登入自啟與更新協調各在自己的檔案，接收注入的 Electron 介面 |
| `src/transport/server` | UI／Agent HTTP listener。`collector-server.ts` 以 runtime 啟動兩個 listener：先在 Agent 連線的埠開 Agent listener，再開 UI listener。`app.ts` 依序掛上每個請求都會經過的 hook 鏈（遮蔽機密的序列化、Host 檢查、Bearer 授權、Vault 未就緒的 503、變動版本、知識庫操作鎖、回應標頭與錯誤狀態，錯誤碼對應的 HTTP 狀態在 `error-status.ts`），再依傳入的服務註冊各區塊的 route，資料交換的 route 與知識庫操作鎖直接使用 runtime 交出的 `VaultOperations`；每個區塊的 route 在 `routes/` 下自己的檔案（Vault 設定、資料交換、裝置、Agent 連線、文件與搜尋、收集工作、活動記錄、排程、訂閱與來源類型、變動串流），查詢參數的解析與驗證在 `routes/query-params.ts`，斷網時拒絕需要網路的請求在 `routes/network.ts` |
| `src/transport/web` | React 操作畫面與 HTTP client；來源類型的文字、設定句與文件細節取自元件經 React context 拿到的宣告（`src/app/plugins/declarations.ts`） |
| `src/app/runtime` | 組裝：`CollectorRuntime` 持有程序內唯一的 Vault workspace、Agent 連線金鑰與設定（`agent-connection.ts`）及啟動／關閉順序，listener 由傳輸層交給它啟動；workspace 不對外，模組外只經 runtime 的方法取用使用中 Vault 的 ID（`activeVaultId()`）與匯出入狀態（`transferStatus()`），其餘都經 HTTP API；程序的變動串流（`change-feed.ts`）；`vault-workspace.ts` 為每個開啟的 Vault 組出收集、訂閱、工作、排程與搜尋服務，並決定它們啟動與停止的順序；知識庫的操作（開啟、建立、匯出、匯入、中斷恢復）都向 `src/domain/vault` 要：workspace 建立一個 `VaultOperations` 並以 `operations` 屬性交出，runtime 與 HTTP listener 都經它取用知識庫操作與狀態，workspace 經 `OperationsHost` 介面提供使用中的 Vault 與搜尋、收集的暫停與恢復、活動記錄與工作紀錄的寫出、匯入後重排排程，以及切換時建好的新服務；隨附資源（runtime 程式、Mac 更新小幫手、搜尋詞庫、Agent Skill、系統匣圖示）的路徑只由 `bundled-resources.ts` 依開發版或打包版與平台算出，Electron、開發 server 與 verify skill 都向它要，Mac 更新安裝器由 Electron 傳入小幫手路徑 |
| `src/app/plugins` | 產品的來源類型清單（`declarations.ts`，Web 也引用）與 server 端組裝（`index.ts`） |
| `src/domain/jobs` | 收集工作的接受、去重、有界佇列與公平派工（順序在 `job-queue.ts`）、自動重試、請求通道冷卻時的等待、重啟接續（`job-recovery.ts`）與裝置端持久紀錄、沒有網路時暫停收集的網路確認（`connectivity.ts`），以及工作頁的進行中、排隊中與失敗清單；訂閱的檢查計畫與結果經訂閱 port（`subscription-port.ts`）取得與回報（`subscription-reports.ts`）；擷取的文件經 `src/shared/documents/document-collector.ts` 的 `DocumentCollector` 保存與索引；並提供每個訂閱一筆工作事實（進行中檢查是排隊中或更新中與進度、是否有項目在擷取、新增中的請求） |
| `src/domain/subscriptions` | 訂閱資料唯一的寫入者：建立訂閱、派工與派工時間、收集進度（上次檢查時間、範圍外項目、失敗項目與跨檢查的失敗次數、連續失敗的檢查次數與自動暫停），以及每次檢查的收集規則（範圍內最新 N 則）；整份清單驗證通過才開始的手動檢查、依各訂閱頻率的週期檢查，並把工作事實與訂閱本身的狀態組合成訂閱狀態。訂閱檔的格式、紀錄欄位的分類（`subscription-fields.ts`）與兩份訂閱檔的合併也屬於這裡；Vault 的開啟、匯出與匯入經 `src/shared/subscriptions/subscription-exchange.ts` 的契約使用它們，實作由 `subscriptionFileExchange(registry)` 建立、存在 `SourceRegistry.exchange` |
| `src/domain/sources` | 來源類型：網址辨識的分派（`source-types.ts`）、跨類型的訂閱列表（`source-catalog.ts`），以及每個類型在自己子目錄的 plugin：`youtube/`（網址辨識、字幕處理、收集設定與 yt-dlp 實作）、`rss/`（feed 探索與讀取、HTML 轉 Markdown、收集設定）。`index.ts` 匯出跨類型的辨識與列表，server 經它使用來源而不依賴任何一個類型；各類型的 server 入口由 `server-entries.ts` 匯出，只有產品來源清單 `app/plugins` 引用；各類型的宣告由 `declarations.ts` 匯出，這個入口不含 Node 程式，Web 也引用 |
| `src/domain/vault` | 文件保存與索引（`collector.ts` 的 `Collector`，實作收集工作使用的 `DocumentCollector`，經 `src/shared/documents/document-vault.ts` 的介面讀寫文件與刪除紀錄）、Markdown 保存、知識庫操作鎖、匯出檔、以較新為準的匯入合併（`vault-merge.ts`）、原地套用匯入（`vault-import.ts`）與中斷恢復。對外入口以三個物件為主：`DeviceVaults`（`device-vaults.ts`：裝置選擇的 Vault、啟動時要開哪個 Vault 與 Onboarding 時的建立、匯入、開啟，連同失敗時的清除）、`openVault`（`opened-vault.ts`：讀出 Vault ID、收尾中斷的刪除，交出服務要用的檔案、文件與 `Collector`）、`VaultOperations`（`vault-operations.ts`：持有知識庫操作鎖與等待套用的匯入比對，在鎖下執行使用中 Vault 的匯出、匯入（比對、備份後原地套用、更新搜尋索引）、建立新的知識庫與開啟其他知識庫，並在開啟前完成中斷的匯入；操作結束時等工作紀錄寫出才回報結束）。另外匯出預設的匯出與備份目錄（`exportFolder`、`backupFolder`）、匯出檔名（`exportFileName`），以及 route 與 runtime 用到的型別。需要其他領域模組的部分（建服務、停服務、重排排程、寫活動記錄與工作紀錄）由 `src/app/runtime/vault-workspace.ts` 建立 `VaultOperations` 時傳入的 `OperationsHost` 物件提供 |
| `src/domain/search` | Meilisearch 子程序、索引狀態、查詢與重建；Windows 上經 PowerShell 讀殘留引擎的命令列（`windows-powershell.ts`） |
| `src/domain/activity` | 裝置活動記錄。`activity-log.ts` 只負責事件的儲存、遮蔽、保留與事件 ID：ID 開頭的序號由記錄發出，開啟時從保留中的事件的最大序號接續；`activity-views.ts` 依事件寫入時就帶著的欄位與事件目錄，提供原始分頁與檢查摘要。事件種類與摘要的顯示規則（是否列出、是否列為檢查底下的子列、預設嚴重度）列在 `src/shared/activity/event-catalog.ts`，目錄沒有的種類 typecheck 失敗。收集工作的紀錄只把事件交給活動記錄，不持有它；兩者在 `src/app/runtime/job-records.ts` 組合：記錄補上工作後來得知的標題，掉了事件的工作標記為紀錄不完整 |
| `src/domain/pacing` | 依請求群組排隊、間隔與冷卻的請求通道 |
| `src/domain/updates` | App 更新的來源、下載、驗證與原生安裝，見 [更新來源](update-source.md) |
| `src/shared` | 共用型別、共用的值與來源契約，依領域分子目錄：`jobs`（工作型別、工作角色、收集暫停）、`subscriptions`（訂閱型別、失敗上限、訂閱檔交換契約 `subscription-exchange.ts`、檢查間隔、即將到來的時間）、`documents`（文件型別與 ID、文件狀態、正文摘錄、刪除規則、發布時間，以及 Vault 實作的 `DocumentVault`、`DeletionRecords` 介面 `document-vault.ts` 與收集工作保存文件用的 `DocumentCollector` 介面 `document-collector.ts`）、`vault`（Vault 型別、Vault 與匯出檔的格式版本）、`sources`（來源契約 `source-contract.ts`、來源類型的宣告值 `SourceDeclarations` 與 server 用的 `SourceRegistry`（`source-registry.ts`）、來源資訊型別、收集設定）、`activity`（活動型別與事件目錄 `event-catalog.ts`）、`api`（API 表 `api-routes.ts`、變動、搜尋查詢與型別、裝置、更新與登入時開啟的型別）、`lib`（狀態檔寫入、canonical JSON、機密遮蔽與 `CollectorError`）。型別分檔為 `*-types.ts`，這些檔只有型別、只 import 型別，所以 server、Electron 與 Web 引用它們不會帶進任何程式；共用的值各在自己的模組，例如 `CollectorError`（`lib/collector-error.ts`）與訂閱的失敗上限（`subscriptions/subscription-limits.ts`） |

`src/` 第一層是五個層級資料夾，由下而上：`shared`（共用型別、純函式與來源契約）、`domain`（領域服務：工作、訂閱、Vault、搜尋、活動記錄、請求通道、通知、更新，以及含各類型 plugin 的來源）、`app`（組裝：`app/runtime` 與產品的來源清單 `app/plugins`）、`transport`（`transport/server`、`transport/web`）、`desktop`（`desktop/electron`，它啟動本程序的 HTTP server）。層級資料夾下的每個資料夾連同底下所有檔案是一個模組，例如 `domain/jobs`、包含 `youtube/` 與 `rss/` 的 `domain/sources`；`shared` 的子目錄只是依領域分組，整層是一個模組，彼此可以互相 import。每個模組只 import 自己、較低層，以及同層中明列允許的模組，型別 import 也算。同層的每項允許註明只取型別或也取值；三項都只取型別，import 了值就失敗：`domain/jobs` 從 `domain/pacing` 取請求通道的型別，`domain/subscriptions` 從 `domain/jobs` 取訂閱 port 與工作事實的型別，`domain/sources` 從 `domain/pacing` 取擷取向請求通道要求的優先序型別。較低層中也有明列不准 import 的模組：桌面殼層只經 IPC 與 HTTP 跟畫面溝通，不 import `src/transport/web`。

其他模組只經入口使用一個模組：入口是模組的 `index.ts`，只匯出其他模組實際用到的名稱，其餘檔案是模組內部，改動時不牽動使用它的模組；模組內的檔案彼此直接 import。另有兩種入口：

- `declarations.ts`：`index.ts` 帶有 Node 程式、而 Web 需要其中宣告的模組，以它匯出宣告（`domain/sources` 的各類型宣告、`app/plugins` 的產品來源清單）。從它經保留程式的 import 走得到的檔案都不 import Node 內建模組。
- `server-entries.ts`：只給一個模組組裝的程式。`domain/sources` 以它匯出各類型的 server 入口，只有 `app/plugins` 可以 import；server 經 `index.ts` 做跨類型的辨識與列表，因此不依賴任何一個類型。

`shared` 是一組契約、沒有隱藏的內部，各檔直接以檔名 import。`tests/tooling/import-layers.test.ts` 檢查每條 import 的層級、同層允許的種類與入口，穿過入口或從不該用的模組 import 入口時列出檔案與該用的入口，並檢查每個 `declarations.ts` 走不到 Node 內建模組；`tests/tooling/web-bundle-node.test.ts` 從 Web bundle 的入口做同樣的檢查。

## 機密遮蔽

兩個 listener 送出的每個 JSON 回應與變動事件，字串值中 process 持有的已知機密（Agent 金鑰、Meilisearch 金鑰）都經 `src/shared/lib/redact.ts` 遮蔽，不論來自哪個 route、hook 或沒有對應 route 的回應；Agent 連線資料的成功回應依設計交出金鑰，檔案下載與 UI 頁面原樣送出。出口只比對已知機密的字面值，文件內容與網址裡像憑證的字（`bearer`、`?key=`）照原樣送出；憑證樣式（Authorization、cookie、帶密鑰的網址參數）在可能帶外部程式輸出的訊息產生處遮蔽：錯誤回應、工作錯誤、活動記錄、通知與搜尋引擎的啟動失敗。

## Runtime 生命週期

`CollectorRuntime` 是 process 內的服務 owner。Standalone server 與 Electron 提供各自的 profile、runtime binary 與 UI listener 參數，兩者都經 `startCollectorServer` 由同一個 runtime 建立 `VaultWorkspace`、scheduler、搜尋 process 及已授權 Agent listener。

啟動時先讀出 Agent 金鑰並在所有輸出中遮蔽，再開啟 Vault（接續的工作此時就可能失敗並寫出錯誤），最後啟動 listener。開啟 Vault 時，先撤回 Onboarding 中被中斷且選擇沒有指向的匯入、完成知識庫內被中斷的原地匯入，接著 workspace 接續該 Vault 的中斷工作，再啟動排程，讓重啟後的第一次檢查併入接續中的工作。關閉時先停止網路確認與變動追蹤，停止 listeners 並等待已接受的 handler；再由 workspace 等待進行中的知識庫操作、停止排程與收集（等待執行中的步驟，把其餘工作記為中斷）並關閉搜尋 process；最後關閉工作紀錄與活動記錄。

尚未設定 Vault 或已記錄的 Vault 無法開啟時，runtime 進入 `not_ready`：標為裝置資料的 route（health、Vault 狀態與設定、Agent 連線、裝置、工作、活動記錄、請求通道、變動串流）照常回應，其他業務 API 回傳 503 `vault_not_ready`；不建立替代空 Vault 或搜尋資料。UI Onboarding 或 Agent 透過設定 API 建立或開啟 Vault 後，runtime 在同一組 listener 上掛上 workspace 並啟動排程。原生目錄選擇由 Electron preload 提供，只回傳路徑；建立、開啟與驗證都經由 HTTP API。開發與驗收可用 `XR_COLLECTOR_VAULT` 指定 Vault，空目錄會自動建立，無法辨識的內容則進入 `not_ready`。Vault 目錄規則見 [儲存與搜尋](storage-and-search.md#vault-目錄與選址)。

每個 `VaultWorkspace` 的 `VaultOperations`（`operations` 屬性）持有一個知識庫操作鎖，匯出、匯入、建立新的知識庫與開啟其他知識庫都經同一個生命週期執行：停止派工、等待進行中的收集、執行操作、恢復收集，再發布完成或錯誤狀態。套用匯入時鎖會升級為連讀取也拒絕；如果匯入無法收尾，鎖進入停止狀態並維持寫入與排程停止，等待重新啟動恢復。HTTP route config 把路由分為知識庫讀取、知識庫寫入、裝置資料與知識庫操作；沒有宣告時依 method 推定，鎖依分類決定是否接受請求。

## Agent 入口

UI 與 Agent 共用 Collector、Vault、收集工作、訂閱、排程和搜尋服務。Agent 使用獨立 loopback HTTP 入口及 profile 持久保存的 Bearer token，可操作所有業務 routes；人或 Agent 從設定頁下載 Skill 與目前 active 連線資料，不掃描裝置入口。

`AgentConnectionService` 在 profile 內保存私有金鑰與連線埠模式；金鑰跨重啟維持，只有使用者重設後才更新。自動模式從起始埠（桌面版 7222、開發 server 7232，可由 `XR_COLLECTOR_AGENT_PORT` 覆寫）往後試十個候選埠，都被占用時交由作業系統配置可用埠；固定模式只嘗試指定埠，失敗只讓 Agent listener 顯示無法連線，不阻止 UI、Vault 與已接受工作啟動。設定修改先持久化，於下次啟動套用，現有 listener 不熱換。App 只透過設定頁輸出目前 active URL 與金鑰；下載包包含通用 Skill 與同層 `connection.json`，產品不發布作業系統固定 discovery file，也不以安裝目錄、Vault 或 instance ID 配對。

## 收集工作與訂閱

收集以工作執行，規則細節見 [收集流程](collection-flow.md)。HTTP 先把工作寫入 profile 的 `jobs/jobs.json` 再回傳 202，網路解析與擷取都在 `JobManager` 的背景佇列中完成：訂閱解析與檢查、單一項目擷取各有並行上限（擷取一次一則），擷取在提交它的工作之間輪替。每個 Vault bundle 有自己的 `JobManager`，持有該 Vault 的文件、搜尋與訂閱物件，因此工作只寫入提交時的 Vault。

`JobManager` 與訂閱之間只有訂閱 port 這一條 seam；正式環境由 `SubscriptionServices` 實作。只有開始探索的新檢查算一次派工，由 `SubscriptionService` 送出並更新派工時間：定時檢查、立即檢查與新增訂閱後的首次檢查。新增訂閱的工作解析完網址後，把結果與接受時的收集設定交給 `SubscriptionService` 建立訂閱並派工首次檢查。重試失敗項目與重啟後接續中斷的檢查不是派工，不更新派工時間。檢查結束時 `JobManager` 回報結束時間與失敗原因，`SubscriptionService` 據此寫入收集進度並決定是否自動暫停。檢查開始探索前向 port 取得計畫，或得知訂閱已暫停／移除；計畫帶著訂閱的候選規則（`src/domain/subscriptions/candidates.ts`：收集範圍、項目上限、要排除的項目），`JobManager` 只列出來源、把清單交給計畫，依它挑出的項目排入工作；項目工作寫入持久紀錄後才回報這次的候選，收集進度因此一定在項目工作之後寫入。工作內暫時性錯誤的自動重試次數屬於 `JobManager`，同一項目跨檢查的失敗次數屬於 `SubscriptionService`，兩者分開計算。

Scheduler 涵蓋所有來源類型的訂閱，到期時經 `SubscriptionService` 派工即返回，以工作結束的通知記錄上次結果；「檢查全部」也一律經由它的 `runNow`。`POST /api/subscription-checks` 先確認網路，再由 `startChecks`（`src/domain/subscriptions/subscription-service.ts`）驗證所有類型的整份清單，任何一個不存在或已暫停就整個拒絕，不開始任何工作。

## 來源類型與 plugin

核心（工作、訂閱、排程、Vault、搜尋、活動紀錄、資料交換、HTTP 與共用畫面）不認得任何來源類型，只經由 `src/shared/sources/source-contract.ts` 的介面與傳給它的 `SourceRegistry` 操作來源。`SourceRegistry`（`src/shared/sources/source-registry.ts`）是一次建好、不可變的值：各類型的宣告與 server 定義、涵蓋所有類型訂閱的排程檔，以及 Vault 讀寫訂閱檔用的 subscription exchange；module 層級沒有可變狀態，Vault、訂閱、工作、搜尋、來源與 HTTP 都由建構或參數取得它，所以同一個程序內兩個帶不同類型的 runtime 各自運作。

每個 plugin 宣告它接受的網址（`owns`、`classify`）、項目擷取、訂閱列出項目的方式、失敗的重試分類、請求節奏、訂閱設定、文件的類型與來源專屬 frontmatter、畫面用字、引入它的 Vault 與匯出檔格式版本（程式的版本取所有類型中最高者），以及核心之外的錯誤碼與其 HTTP 狀態；工作種類在線上寫為 `<類型>.<名稱>`，去重以來源類型區分。HTTP 的收集與訂閱路由不分類型：`POST /api/submissions`、`POST /api/items` 與 `POST /api/subscriptions` 由網址找到所屬的來源類型，訂閱以 `/api/subscriptions/:type/:id` 識別，排程（`/api/schedule`）涵蓋所有類型，請求通道狀態（`/api/pacing`）每個請求群組一筆；回應以訂閱為名詞（`subscription`、`subscriptions`、`subscriptionId`），新增來源類型不需要新路由。

產品提供的來源類型與順序只列在 `src/app/plugins/declarations.ts` 一處，這份宣告清單不含 Node 專用的程式，server 與 Web 共用。Server 程序與 Electron 由 `src/app/plugins/index.ts` 的 `createSourcePlugins` 依這份清單組裝 plugin，並用這些 plugin 建出 registry，一起回傳 `{ registry, plugins, pacing }`：每個類型對應一個定義與 plugin factory，宣告與 server 項目任一邊缺少時載入就失敗；factory 從組裝端取得外部程式路徑與所屬請求群組的通道。`CollectorRuntime.start` 以必填的 `sources` 取得 registry，有 workspace 時確認傳入的 plugin 正是 registry 的類型、順序相同，否則不啟動。Web 畫面由 `src/transport/web/plugins.tsx` 以同一份宣告建立不可變的 `SourceDeclarations`（`PRODUCT_SOURCES`），`src/transport/web/main.tsx` 經 React context（`src/transport/web/source-declarations.tsx`）提供給元件，元件以 `useSourceDeclarations()` 取得，再當參數傳給 presentation 函式與 `src/shared/jobs/job-role.ts`；`plugins.tsx` 也為每個類型提供圖示，徽章顏色在 `src/transport/web/plugins.css`。一個網址屬於清單中第一個認領它的類型；RSS 認領所有 web 網址，所以排在最後。新增訂閱選單中尚未支援的類型（X、Facebook）是 `src/transport/web/add-menu.ts` 的資料，以相同 ID 宣告的類型會取代它的位置。registry 沒有的來源類型留下的文件、工作與訂閱照原樣保存，核心不對它們動作。

每個程序對每個請求群組有一條請求通道（`PacingGate`），群組內的請求都經過它：同一時間只有一個請求，相鄰請求間依 plugin 宣告隨機等待，讓取用節奏接近一般使用者、不形成固定規律。宣告冷卻的群組被限制連線時整條通道冷卻（5 分鐘起、連續限制加倍、上限 60 分鐘，2 小時沒有再被限制就從頭算），冷卻狀態存於 profile 的 `<群組>-pacing.json`，其他群組不受影響；冷卻與等待的規則見 [收集流程](collection-flow.md#冷卻)。YouTube plugin 的群組是 `youtube`，所有 yt-dlp 請求都經過它，相鄰請求間等待 4–12 秒，會冷卻；RSS 的群組是 `rss`，等待 1–3 秒，不冷卻。YouTube 字幕選擇只採原文軌道：人工字幕優先；自動字幕以 yt-dlp 實際下載的格式判斷是否為翻譯，同一語言優先 `-orig` 軌道。

## Runtime binary 與資料

搜尋採 Meilisearch 官方 release binary（版本、asset URL、bytes 與 SHA-256 釘在 `src/domain/search/meilisearch-runtime-pins.json`），由程式管理獨立子程序，監聽 loopback 上隨機分配的 port 並使用隨機 key。binary 旁的 manifest 記錄 release asset 與 binary identity；runtime cache、安裝替換與 native smoke 以該 raw SHA/bytes 驗證完整 pair。App 啟動時以內附 manifest 作為 bundle 信任邊界，要求它與 pin 完全一致，並核對實際 executable header 架構及 `--version`；Developer ID 簽章改變 bytes 時，以被 App seal 保護的簽署 identity 認證。驗證失敗不啟動、也不清除搜尋資料。啟動前會結束同一 database 上一次執行被強制結束時留下的引擎程序，以 database 旁的 pid 檔辨識，並核對紀錄與命令列中的執行檔及 database 路徑；無法證明 ownership 或無法確認退出時 fail closed。每個 Vault 的可重建 database 另有只描述 engine/index 語意的 profile marker，與 binary SHA、簽章及建置時間分離；profile 不符才清除該 Vault 的 database/state/pid/marker，完整重建成功後才原子寫入新 marker。中文查詢的命中範圍由 App 的搜尋正規化、contiguous fragment 查詢與 COCT 詞庫決定；引擎的分詞影響相關度排序，見 [儲存與搜尋](storage-and-search.md#搜尋投影)。

yt-dlp、Deno 與 Meilisearch 都由 `prepare:runtime` 下載固定版本並核對 SHA-256。Windows 的 Meilisearch 依賴 `vcruntime140.dll`，安裝包附帶 repo 內釘住版本、經 Microsoft 簽章核對的 app-local 副本。終端使用者不需安裝任何 runtime。yt-dlp 採官方資料夾版（執行檔與 `_internal`），放在 runtime 目錄的 `yt-dlp/` 下：單一執行檔版每次執行都要先解壓到新的暫存目錄，系統又會檢查這些新檔案，每次呼叫因此多花數秒。

文件、搜尋與 UI 使用來源無關的文件欄位（文件 ID、來源類型與來源內 ID、publisher、日期），來源專屬資訊放在各自的欄位區塊，例如 YouTube 的字幕語言；篩選以來源類型與 publisher ID 進行，不依賴顯示名稱。

Vault 保存正式文件與可攜設定；搜尋 database 是裝置上的可重建資料。profile、憑證與連線資訊不隨匯出檔交換。格式與恢復責任分別見 [文件格式](document-format.md)、[儲存與搜尋](storage-and-search.md)；原生驗證、CI 與建置方式見 [專案驗證設定](project-validation.md)。
