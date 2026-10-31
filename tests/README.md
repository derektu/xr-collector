# 測試入口

`npm run verify` 執行全部 Vitest 案例、JUnit 輸出、產品程式 typecheck 與 Node／Web build。`npm test` 只跑測試，`npm run test:watch` 用於開發。測試檔由 `tests/**/*.test.ts` 收集。每個測試檔開始前由 `tests/support/register-sources.ts` 登錄產品的來源 plugin；測試檔可再登錄自己的來源類型，登錄只在該檔內有效。

## 按功能分類

| 目錄 | 責任 |
| --- | --- |
| `core` | 文件保存與索引、刪除紀錄與重新收集的互斥及競態；連線偵測（`connectivity.test.ts`：確認失敗即離線、離線時每 30 秒確認、同時的確認共用一次、在線結果 30 秒內重用、睡眠時不確認，以及確認網址只接受已知回應，captive portal 算離線） |
| `plugins` | 核心與來源類型無關（`core-agnostic.test.ts`：以 `tests/support/fake-source-plugin.ts` 的兩個假來源類型 `fake`、`fake2` 走過單一項目、去重、訂閱預覽與檢查、範圍內最新 N 則、重試分類、各請求群組各自冷卻、暫停與移除、刪除後略過與明確重新收集、重啟接續、未登錄類型的工作保持中斷且不執行、訂閱狀態（含 workspace 由 plugin 的登入狀態判斷），以及與 YouTube 並存的匯出、合併與完全取代，以及檢查中失敗項目的次數、略過、重試與收集紀錄、工作頁的排隊順序與失敗區）；來源類型宣告的 Vault 與匯出檔格式版本（`format-versions.test.ts`） |
| `plugins/youtube` | YouTube plugin：網址、語言、字幕整理、收集設定、yt-dlp 輸出解析、字幕軌道選擇、頻道列出，以及失敗原因的分類與用字（`failures.test.ts`） |
| `plugins/rss` | RSS plugin：RSS 2.0／RDF／Atom 解析、文章識別與 key（`feed.test.ts`）、HTML 轉 Markdown（圖片、表格、相對連結、移除的元素，`html.test.ts`）、網址與頁面宣告的 feed、讀取失敗分類、快取與重啟（`source.test.ts`）、經工作與 Vault 的首次收集、範圍與數量、只有摘要（`rss-collection.test.ts`），以及 UI／Agent 共用路由與 Skill（`rss-http.test.ts`）；以 `synthetic-feeds.ts` 的本機 feed 伺服器驗證 |
| `pacing` | 請求通道：單一連線、隨機等待、冷卻與狀態檔 |
| `sources` | 網址辨識；訂閱清單、新增中的訂閱、文件頻道篩選的「已移除」、移除訂閱並刪除文件（擷取中的影片、單支影片加入、超過等待時間、部分刪除失敗）與 UI／Agent 讀到相同欄位的 HTTP 契約（`subscription-http.test.ts`） |
| `jobs` | 收集工作的接受、去重、有界派工、持久紀錄、重啟接續與自動重試，YouTube 冷卻期間的等待與接續，以及系統睡眠時的收集暫停（暫停中的暫時性失敗不計重試、與知識庫資料交換的 hold 並存）與沒有網路時的暫停（`network_error` 後確認離線則回佇列、不計重試，確認在線則照常計入）；以 `tests/support/subscription-recorder.ts` 的 in-memory 訂閱 port 驗證，只斷言工作回報給訂閱的內容 |
| `activity` | 記錄的日檔與舊檔相容、30 天保留與跨時區日界、cursor 分頁、篩選、遮蔽、寫入失敗、手動重試、工作摘要，以及 Vault 鎖與 Not Ready 時的查詢 |
| `subscriptions` | 訂閱、各訂閱的收集設定、失敗項目欄位與設定檔版本檢查、時間邊界、每次檢查的收集規則（範圍內最新 N 則、不往前補足）、暫停／移除收斂、頻道工作提交與排程、系統睡眠期間不派工與喚醒後到期訂閱只檢查一次、檢查發現沒有網路時暫停且離線期間不派工，恢復後到期訂閱只檢查一次、服務計算的訂閱狀態（`subscription-status.test.ts`：更新中、排在其他訂閱後、冷卻、等待重試、到期未派出、自動檢查關閉）；以 `synthetic-youtube.ts` 的合成頻道與可控時鐘驗證。訂閱規則經 `SubscriptionService` 搭配真的 `JobManager` 與假來源 plugin 驗證（`subscription-writer.test.ts`：失敗滿 3 次與不重試錯誤標記為已略過、成功或離開範圍移除失敗項目、範圍外項目、三種派工更新派工時間、重試失敗項目與重啟接續不更新派工時間與上次檢查時間、多類型請求含已暫停訂閱時整個拒絕） |
| `vault` | 文件格式與文件路徑、zip 匯出檔（manifest、路徑與內容檢查、只打包登記的檔案、刪除紀錄與未知欄位）、匯出到檔案與預設匯出目錄、以較新為準的合併（刪除帶回另一台、刪除與新增同時發生、兩邊修改、刪除與修改、兩邊都刪除時採用較新的紀錄、時間相同保留本機、同一支影片、從未交換的知識庫、訂閱的新增修改移除與移除紀錄、沒有需要匯入、完全取代）、匯入前備份與備份目錄、原地套用的中斷恢復（journal 寫入前、改名進行一半）、從匯出檔建立知識庫、資料交換期間的收集暫停、知識庫搬移（目標檢查、逐檔驗證、失敗注入、中斷恢復、清理失敗）、同庫識別與開啟其他知識庫 |
| `search` | 搜尋狀態、索引（含 YouTube 文件內容雜湊的固定值）與真實引擎 |
| `server` | HTTP 契約與 Agent 授權；不分類型的收集、訂閱、排程與請求通道路由，以 YouTube 與假來源 plugin 各跑一次，含類型專屬路由回 404、UI／Agent 讀到相同結果，以及沒有網路時拒絕需要網路的請求、立即檢查先確認網路、health 與排程的 `connectivity`（`subscription-routes.test.ts`）；核心與來源類型宣告的錯誤碼 HTTP 狀態（`error-status.test.ts`）；關閉時等完已接受的請求、送完處理中的回應，並結束沒有請求的連線（`server-close.test.ts`） |
| `runtime` | 共用服務組裝、斷線後完成與生命週期清理；pinned Meilisearch release 準備的 target／實體 host、asset identity 與 executable 驗證、cache identity、destination lock、原子 binary+manifest 替換與 failure preservation；建置環境檢查（`build-doctor.test.ts`：Mac 建置機需要 Git 與 `swiftc`、Windows 建置機只需要 Git、Node 主版本與 host 架構、ARM64 Windows 上的 x64 模擬可以建置、`prepare:runtime` 與 `package:*` 開工前只列缺少的項目、runtime cache 與 Developer ID 簽章只報告狀態）；使用者層級 runtime cache 的位置與覆寫、`prepare:runtime` 入口、cache-only 安裝（不下載，缺少或不符時指出 prepare 指令，第二個 checkout 從共用 cache 安裝）、固定 yt-dlp／Deno archive cache、安裝 inventory、repo 內 Windows app-local CRT 的 SHA-256、檔案版本與 Microsoft 簽章核對，以及 package 參數、BuildInfo、packaged runtime、各平台 release index 與 artifact manifest 契約；`release:upload`（`release-upload.test.ts`，以假的 `gh` 與 Git）：dirty checkout、HEAD 不是建置 commit、本機或 GitHub 的 tag 指向別處、GitHub 沒有該 commit、檔案與 index 的 hash 不符、draft 已有同名不同 hash 的檔案、Release 已公開、上傳後下載核對不符時各自停止，以及建立 tag 與 draft、兩個平台分批加入同一個 draft、同名同 hash 略過；Developer ID 包的步驟順序（App 公證並 staple、由已 staple 的 App 產 DMG 與 ZIP、DMG 公證並 staple、每份最終產物各檢查一次）、App 與 DMG 公證的 submission 保存與續查、DMG 的 `Notarized Developer ID` 來源、runtime Mach-O 的有界並行簽署（最多 8 個，framework 在內容簽完後才簽）；打包的分階段計時（`stage-timings.test.ts`：巢狀與失敗的階段、electron-builder hook 事件換算，以及失敗時仍印出耗時表並寫出 JSON）；測試用假的 executable／archive／HTTP 回應，不建置安裝包也不做大型下載 |
| `electron` | Desktop 殼層的純邏輯：主題偏好檔、選單列／系統匣的選單內容與圖示狀態（`tray-menu.test.ts`），以及第一次關閉提示的紀錄 |
| `updates` | App 更新來源契約、固定版本／target／payload 身分、串流下載與雜湊驗證、ready 快取與安裝嘗試紀錄，以及 Windows NSIS 與 macOS helper 進入前的 adapter 驗證；版本更新不發 OS notification。`electron/update-coordinator.test.ts` 另驗證 Vault 停止、runtime 關閉與 native handoff 的終止邊界。單元測試不代表已安裝 App 能完成原生 A→B；macOS helper 交換與 Windows NSIS 安裝只在各自平台的 packaged acceptance 執行，另一平台必須 skip 而不能用 mock 宣稱通過。 |
| `web` | 畫面使用的狀態／呈現邏輯（含工作頁列的標題、副標與等待文字，`jobs-presentation.test.ts`）、新增選單（含以相同 ID 登錄的 plugin 取代尚未支援的訂閱類型，`add-menu-planned.test.ts`），以及 UI、伺服器訊息與 Skill 的用語掃描（`terminology.test.ts`） |
| `tooling` | 核心檔案與 plugin 契約不提及 YouTube／yt-dlp／RSS、核心不引用 `src/plugins` 下契約與組裝清單以外檔案的掃描（`core-type-agnostic.test.ts`），以及程式與 Skill 只用不分類型的路由、訂閱欄位與錯誤碼的掃描（`api-names.test.ts`），以及 `src/jobs` 不引用訂閱檔讀寫、`src/subscriptions` 不引用工作頁規則、只從 `src/jobs` 引用型別的掃描（`subscription-seam.test.ts`）；verify skill 的函式庫（`verify-skill/`）：證據資料夾、label 與指定的證據目錄、doctor 列出缺少的前置條件（Mac 與 Windows 的案例各自只在該平台執行）、slot lock 的持有者判斷與 `sweep`、程序辨識（含 Windows 命令列的判斷）與 `stop`／`sweep` 只結束 run 自己的程序（真實程序的案例分 Mac／Linux 與 Windows 兩組）、`restart` 期間 slot lock 不被 `sweep` 清掉（Web 模式，不在 Windows 執行）、Windows 程序啟動監看只結束一次且不碰已結束的 PID（`watch-starts.test.ts`，以假的監看程序在各平台執行），多台機器的 `results.json` 以 summary 彙整時的平台完整性、commit 一致、整個 run 失敗與缺少的 scenario（`summary.test.ts`），run 資料狀態的讀取：Vault 與 profile 依檔案格式讀出、讀取不寫入、停止的 run 的 API 與索引標為讀不到、Meilisearch key 從程序環境變數讀取（Mac 與 Linux，`state.test.ts`），證據是否對應目前程式的判斷（`freshness.test.ts`），以及已收錄流程的狀態序列與工作頁分區判斷、recorder 的 check 格式、每支流程都有合法的層級（Desktop 流程是 `platform`）、依名稱／`--web`／層級／功能檔選取流程、耗時表的預算標記、多次 run 的失敗次數、原因與耗時彙整（`flows history`），以及功能地圖的 `Regression flows` 與流程涵蓋的子功能一致、總表列出每份功能檔與它的流程、每份功能檔有不提已收錄流程的 `Backlog`（`flows.test.ts`），以暫存 Git checkout、暫存 `HOME` 與真實程序驗證 |
| `support` | 共用 fixture：來源 plugin 登錄、YouTube plugin 組裝（`youtube-sources.ts`）、YouTube 文件轉換（`youtube-documents.ts`）、頻道探索的測試輔助（`youtube-discovery.ts`）、假來源 plugin（`fake-source-plugin.ts`）、in-memory 訂閱 port（`subscription-recorder.ts`）與合成 feed 伺服器（`synthetic-feeds.ts`） |

分類不代表測試層級：同一功能可能包含單元、HTTP 與檔案系統整合。`web` 的函式測試不是完整畫面 E2E，yt-dlp 的 fixture 測試也不是 YouTube 真實連線驗收。Web 畫面與原生操作的驗證層級依 [開發驗證流程](../docs/development-validation.md#驗證層級)，只在有實際自動化案例時建立 E2E 測試目錄。

## 真實搜尋與平台邊界

`npm run test:meilisearch:mac` 下載固定的 yt-dlp／Deno 與 Mac Meilisearch runtime，再執行 search、殘留引擎清理、Agent、匯出入、合併匯入與搬移六個相關檔案，包含其中的非引擎案例。這些檔案的真實引擎案例目前使用 `resources/bin/mac/meilisearch`，缺少合法 binary/manifest pair 時會 skip 或在 runtime 啟動時 fail closed。此命令供 Mac arm64 執行；Windows／Linux 的綠燈不能視為已通過這六項真實引擎驗收。

`.github/workflows/meilisearch-native.yml` 在 Mac arm64 與 Windows x64 runner 下載固定的 Meilisearch release（Windows 另放上 repo 內的 `vcruntime140.dll`），再用臨時 database 驗證 canonical settings、中文／英文索引、filter、page、highlight/crop 與 restart persistence。這組 native smoke 與一般 Vitest 分開，不能用模擬 runner 或單元測試取代，也不是正式 Release 安裝包的來源。

平台擴充時一起調整 binary 選擇與 skip 規則；先保留真實結果，不以 fixture 冒充另一平台通過。

verify skill 的整合 smoke（`npm run test:verify-skill:mac`）啟動真的 Web 模式 instance 與 headless Chromium，只在 Mac 本機執行，不在 `npm run verify` 與 CI 中；Desktop smoke（Mac 是 `npm run test:verify-skill:desktop:mac`，Windows 是 `npm run test:verify-skill:desktop:win`）啟動開發版 Electron 或 `--app` 指定的打包版，收集一支真實影片，在 Mac 或 Windows 本機執行。內容見 [verify skill](../.claude/skills/verify/SKILL.md#自我測試)。

## Round 2 修改原則

既有案例保護已交付行為。需求變更在對應 ticket 內更新斷言，例如 #22 的 Agent 寫入授權，以及 #18／#27／#28 的派工與恢復；分類整理不先解除這些限制。共用 fixture 只在確實重複時抽取，避免不同案例的前置條件被隱藏。
