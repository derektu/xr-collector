# 開發驗證流程

PR 的驗證平台由功能影響決定。開發者先用自己的開發機完成適用案例，需要另一個平台時，由另一台機器或另一位 agent 對相同 commit 補驗。GitHub Linux CI 執行 `npm ci` 與 `npm run verify`（只改 Markdown 的修改不執行，見 AGENTS.md）；Mac ARM64 CI 另以 verify skill 的 Web 模式同時三支執行所有已收錄的 Web 回歸流程（Desktop 與真實來源以外的全部層級），並保存每支流程的 `results.json`；push 到 main 的 tree 與 merge 的 PR 最後一個 commit 相同、且那個 commit 的 PR run 已通過 Web 回歸時，main 沿用該結果，不再執行，log 寫出沿用的 PR 與 run。原生操作仍由 agent 實際驗收；GitHub 的 Mac ARM64／Windows x64 打包 smoke 是手動觸發的離線補充檢查，不是正式安裝包來源，也不取代作業系統畫面的驗收。

## 驗證層級

Electron 載入的是同一套 HTTP 畫面與 API，多數產品行為不依賴桌面殼層。驗證依 scenario 實際需要的層級進行，原生 Desktop 驗收只花在瀏覽器無法證明的部分：

| 層級 | 時機 | 內容 |
| --- | --- | --- |
| 自動檢查 | 每次修改 | `npm run verify`：單元、HTTP 與檔案系統整合測試、typecheck、build |
| Web 畫面 | 有畫面或 API 行為變更時，以及改到畫面依賴的狀態或資料流時 | verify skill 的 Web 模式：隔離的 instance 與 headless Playwright，依 scenario 操作、斷言並截圖 |
| 原生 Desktop | 票的結尾，只針對依賴 Electron 或平台能力的 scenario | verify skill 的 Electron 背景模式，Mac 與 Windows 用同一支流程腳本；Windows 見第 5 節 |

依賴 Electron 或平台能力的 scenario 包括：原生對話框、preload bridge、路徑與權限、程序生命週期、視窗行為、Tray／選單列、登入自啟、安裝與更新。其餘 scenario 以 Web 畫面截圖作為執行證據，截圖說明標示為 Web 模式。Web 畫面證據不替代原生 UI 證據。

驗收計畫為每個 scenario 標明驗證層級。狀態轉換、檔案內容、API 回應、去重、中斷與重啟等正確性，以 HTTP 與檔案系統整合測試驗證，測試隨票加入 `npm run verify`，之後每次修改都會重跑；截圖只用於使用者需要看到的畫面狀態。前後相接的 scenario 串成一條流程執行，前一個的結束狀態就是下一個的起點，不各自重建資料與環境。計畫聚焦在本票的風險：最後一列、空狀態、錯誤、操作後的刷新、重啟後的狀態這類邊界；合併重複的案例，`npm run verify` 已涵蓋且沒有畫面的低風險行為不另列 scenario。

**回歸**：票沒有改畫面，但改到畫面依賴的狀態或資料流，例如訂閱狀態、工作排隊與進度、知識庫的鎖與資料交換，仍在 Web 層執行 [功能地圖](../.claude/skills/verify/features/README.md) 中對應功能的流程，確認使用者看到的行為不變。這類行為由多個 module 拼成畫面，單元測試各自通過不代表畫面上的狀態正確。只有畫面完全讀不到的內部行為，才只靠自動檢查。

- 先跑相關的已收錄流程（verify skill 的 `flows run`），沒有收錄的才在票的 `.local/` 自己寫。每個功能檔的 `Regression flows` 列出涵蓋它的已收錄流程，從票改到的功能就查得到要跑哪幾支。
- 驗收計畫列出要跑的已收錄流程與原因；功能相關但不跑的，也寫出原因。協調者與使用者審驗收計畫時，以這份清單判斷有沒有漏跑。
- 流程何時收錄、何時更新，依 [verify skill 的收錄規則](../.claude/skills/verify/SKILL.md#已收錄流程)：涵蓋功能地圖子功能、以合成資料就能重跑的流程，寫出它的那張票就收錄；票改變了已收錄流程所檢查的行為時，同一張票更新它。PR 描述的驗證段落列出本票收錄或更新的流程；功能地圖上的功能有寫流程卻沒收錄的，寫出原因。

**基準**：基準是主 checkout（`/Users/derektu/projects/km/xr-collector`，追蹤 main、不放未提交修改）：在票的 worktree 以 `--checkout <主 checkout>` 啟動 instance，跑同一支流程。票的 worktree 一開始改程式就不再等於 main，所以基準不在票的 worktree 跑，也不另建 worktree。基準只用來證明本票新增的斷言在 main 上失敗（見下一段）。確認行為不變的回歸流程不跑基準：main 的每個 commit 都已通過 PR CI 的全部 Web 流程，本票版本與功能檔不一致的，就是本票改變了行為；判斷不了是本票造成還是功能檔本身有誤時，才對那一支跑基準比對，功能檔的問題記在 PR 的待決定問題。

**斷言要能失敗**：證明本票新行為的斷言，在基準上必須失敗；基準上也通過的斷言不證明本票的修改，要改寫到能區分兩者。修正完成後，保留測試與斷言、拿掉修正再跑一次，例如以 `git archive` 匯出基準的程式執行新測試，斷言必須跟著失敗；交付報告附上這次失敗的輸出，只列斷言與數量。單元測試與 Web 流程的斷言都適用。確認行為不變的回歸斷言在本票版本通過即可。

**斷言放在哪一層**：畫面上的狀態讀 DOM 的文字與屬性；資料面的狀態直接讀資料本身，例如 Vault 的檔案、profile 的紀錄與搜尋索引，不只經過本票修改的 API；截圖負責版面、視覺與斷言沒有涵蓋的部分。能寫成斷言的預期不只靠看截圖判斷，因為截圖無法重跑比對。

**真實資料**：合成資料只替代 yt-dlp 與網路上的 feed，看不到限流、實際的字幕軌道、頻道辨識的耗時與真實 feed 的格式差異。改到收集、字幕選軌、頻道或網址辨識、feed 讀取的票，交付前至少以 `--data real` 執行一次相關 scenario，或執行 verify skill 的真實資料 smoke。網路或限流使 scenario 無法完成時記為 blocked，不以合成結果代替。

**本機執行**：本機與 CI 分工，本機不重跑 CI 會跑的東西。

- 本機只跑本票的新 scenario，加上與本票改動相關的已收錄流程：`flows run --feature <功能檔>` 跑涵蓋該功能的流程，`flows run --tier core` 是幾分鐘內的常用路徑回饋；全部 Web 流程由 PR CI 執行。
- 只改流程腳本（verify skill 的 `flows/` 或票的 `.local/` 腳本）時，不重跑 `npm run verify`，只重跑改到的流程。
- 執行 `npm run verify` 或流程的指令保留退出碼：不接 `| tee`，或先 `set -o pipefail`。退出碼是判定失敗的依據，被管線吃掉時失敗不會被發現。
- 需要同時跑多支流程時用 `flows run --jobs <N>`，每支仍是獨立 instance，佔一個 verify slot；`doctor` 列出空著的 slot。

畫面多、流程長的票，Web 畫面 scenario 寫成一支 Playwright 腳本，依計畫順序操作、斷言預期結果並自動截圖，修改後可整條重跑。啟動隔離的 instance、合成資料、等待與截圖由 verify skill 的 CLI 與函式庫提供；涵蓋功能地圖子功能、可重跑的流程收進 verify skill 的 `flows/`；只對本票有意義的腳本放在票的 worktree 的 `.local/ticket-artifacts/<issue>/scripts/`。Playwright 是 devDependency，腳本不加入 `npm run verify`。原生下拉選單等瀏覽器自動化拍不到的狀態，另以手動截圖補足。

### 已收錄流程的門檻與成本

E2E 的價值集中在驗收單張票的新行為，以及產品穩定後作為畫面回歸的安全網；每支流程在每個 PR 都要跑，成本隨功能累加。已收錄流程因此依 [功能地圖的層級](../.claude/skills/verify/features/README.md#流程層級) 標記 `core`、`feature`、`platform` 或 `real`，並符合以下門檻。

**新增流程的門檻**：

- 流程開頭的註解寫明它保護的使用者路徑，以及下層測試為何測不到。能用元件、單元或 HTTP 測試保護的行為放在下層；只有必須經畫面串起多個 module 才看得到的結果，才寫成流程。
- 單支流程在 CI 不超過 60 秒（準備、執行與清理合計）。需要更久時，流程以 `export const overBudget` 寫明理由；`flows run` 結束時的耗時表標出超過 60 秒的流程，以及其中沒寫理由的。
- 等待一律等狀態：`waitFor` 等 DOM、API 或資料面的條件，或 verify server 的完成記號（例如排程輪詢完成時寫的 `schedule-trigger.done`），不用固定的 sleep 等某件事發生。要證明某個狀態在一段時間內維持不變（例如工作結束後徽章不再出現）時，觀察窗寫成具名的取樣並註明為什麼需要。
- 全部 Web 流程以 `--jobs 3` 平行執行，CI 不超過 5 分鐘。新增流程使總時間超過時，同一張票合併或精簡現有流程，使總時間回到預算內，PR 描述列出前後的耗時。

**不穩定的處理**：程式沒變卻失敗的流程，在發現的那張票查出根因並修好；根因在產品就修產品，例如 #177 修正更新面板重新掛載後又定位一次，而不是拉長流程的等待。當下修不了時，開 issue 追蹤並加入看板。不靠拉長 timeout、重新分類層級或重跑到通過讓失敗消失。CI 每次執行都保存每支流程的 `results.json`（artifact `web-regression-results-*`，保留 90 天），`flows history` 從中累積每支流程的失敗次數、原因與耗時。

**定期檢討**：大約每 10 張票 merge 後，以 `flows history --runs <N>` 讀出這段期間 CI 的紀錄，依每支流程的耗時、不穩定次數與它抓到的真問題（下層測試沒有抓到的產品 bug），決定保留、合併或降級（例如改為 `feature` 專項、把斷言移到下層），結果記在 [功能地圖的定期檢討](../.claude/skills/verify/features/README.md#定期檢討)。

開發主力機器是 Mac；Windows 由另一台機器補驗，見第 5 節。需要 Windows 驗收而那台機器無法使用時（例如 VM 沒有開），暫停並通知使用者，由使用者決定補驗，或只完成 Mac 驗收並將 Windows 標為待補。不自行啟動或關閉 VM。

## 1. 先定驗收計畫

實作前在 issue 以 Markdown 記錄驗收計畫：每個 scenario 的 ID、驗證層級、對應的功能地圖檔案、平台需求與原因、操作步驟及預期結果。預期結果寫成可以比對的條件，例如數量、狀態序列、出現次數，流程才能寫成斷言。只需要自動檢查的票，列出作為行為不變依據的現有測試與新增的案例。

| 功能影響 | 平台需求 | 通過條件 |
| --- | --- | --- |
| 共用 UI／業務邏輯，沒有平台差異 | 任一平台 | Mac 或 Windows 任一平台完成 |
| Mac 專屬 | Mac | Mac 完成 |
| Windows 專屬 | Windows | Windows 完成 |
| 兩平台都受影響 | Mac 與 Windows | 兩平台各自完成 |

路徑、權限、程序、runtime、原生視窗／選單／Tray、平台樣式、安裝／更新等變更須評估受影響的平台，不直接套用開發機的平台。影響不確定時納入兩平台。純文件 PR 驗證實際渲染的文件，不硬造產品操作案例。

機器缺少必要平台時，該平台維持「待驗證」。Windows 開發者可先完成共用與 Windows 案例，再找 Mac 補 Mac 案例；反向亦同。

開發中需求或 scenario 有變動時，先更新 issue 的驗收計畫與預期並記錄原因，再驗證對應的版本。無法執行的 scenario 標為未驗證，不以 build 成功或舊截圖宣稱通過。

## 2. 執行

依 verify skill 啟動隔離的 instance、執行流程腳本並清理。port、資料目錄、受測版本、程序辨識與證據位置都由 skill 定義。

- 啟動成功只代表環境就緒，接著仍須實際操作 scenario、比對預期，並執行必要的 API 與資料斷言。
- `results.json` 記錄受測的 commit 與未提交內容的雜湊。交付給 PR 的結果對應 PR 的 HEAD；HEAD 更新後，針對新版本重跑受影響的 scenario。
- 看過每張截圖再判定結果，確認不是錯誤頁、過期畫面或空白。工具不根據 PNG 存在判定成功。

**不符合預期的觀察**：執行時看到與預期、規格或一般使用習慣不一致的地方，例如畫面文字、等待時間、狀態、排版，不記成備註或風險帶過。屬於本票範圍的，修正後重跑；不在範圍內或需要產品判斷的，在交付報告中列為待使用者決定的問題，附截圖與實際觀察。scenario 全部通過不代表沒有這類問題。

## 3. 原生 Desktop 與背景模式

以 Playwright `_electron.launch` 操作的原生 Desktop 驗收，預設設定環境變數 `XR_COLLECTOR_VALIDATION_HIDDEN=1`，verify skill 的 `launchElectron` 預設即為此模式。此模式下主視窗建立後不顯示、不取得焦點，macOS 在程式啟動時即隱藏 Dock 圖示，`second-instance` 等事件也不把視窗帶到前景；視窗關閉 `backgroundThrottling`，隱藏時照常繪製與執行計時器。Playwright 透過 DevTools 協定操作網頁內容與截圖，不依賴視窗顯示，因此截圖是即時的完整畫面，開發者可以同時在同一台機器上工作，不會被跳出的視窗打斷或誤觸受測程式。`XR_COLLECTOR_VALIDATION_HIDDEN` 與 `XR_COLLECTOR_VALIDATION_WINDOW_SIZE` 同屬驗收專用設定，不出現在使用者介面；未設定時 App 照一般方式顯示視窗。

會開啟原生對話框的 scenario（例如選擇資料夾、選擇備份檔），以 verify skill 的 `stubDialogs` 在主程序替換 `dialog.showOpenDialog`、`dialog.showSaveDialog` 的回應，回傳 run 目錄內的路徑並記錄呼叫參數，不開啟真的對話框。替換後證明的是 App 對對話框參數與結果的處理，不證明原生對話框本身；驗證對話框的外觀、預設路徑或平台提示時不替換，以原生截圖為證據。

平台功能（Tray／選單列、登入自啟、更新等）同樣要能由流程查詢與觸發：主程式提供只在驗證模式開啟的控制通道，以環境變數開關，正式使用時不開啟；verify skill 的函式庫提供對應的呼叫方式。只有正確與否取決於作業系統畫面的項目，例如圖示確實出現在選單列、安裝程式與系統安全提示的畫面，才在驗收計畫標為實機目視，數量盡量少。

以下情況關閉背景模式，並在 issue 的驗收計畫註明執行時會跳出視窗：

- scenario 驗證的是視窗顯示、聚焦、Dock、Tray／選單列本身。
- scenario 驗證的是原生對話框本身。
- scenario 要截的是作業系統的畫面，例如系統匣、通知、安裝程式；這類 scenario 需要使用者的桌面，見第 5 節。

## 4. 交付

實作的 session 完成時，給使用者的訊息本身就列出完整結果，不只放在報告檔：每個 scenario 的結果，以及第 2 節的每一個不符合預期的觀察。每個觀察各寫一條：在哪個 scenario 看到、實際觀察、截圖路徑、處理方式（已修正並重跑，或待使用者決定）。報告檔可以更詳細，但不能有訊息裡沒有的觀察。

開 PR 前，開 PR 的人逐條對照 `results.json` 與回報：每個 scenario 的 checks、observations 與記錄的狀態序列，以及功能檔不符的項目。結果檔裡有、回報卻沒提的不一致，先依第 2 節判斷，再補進 PR 的待決定問題。這一步不依賴實作 session 的自我檢查，因為它看漏的通常就是它沒意識到的地方。

證據放在票的 worktree 的 `.local/ticket-artifacts/<issue>/`（gitignored），不提交到 repo，也不上傳 PR；基準與本票版本各放一個子目錄。同一個 label 重跑時，verify skill 改用下一個編號的子目錄，先前的證據保留；回報引用證據時寫實際的子目錄名。PR 描述的驗證段落列出：

- 需求平台與實際驗證的平台、OS 與架構
- 每個 scenario 的層級、資料模式、結果（pass／fail／blocked）與實際觀察
- 精確的 HEAD，以及 CI 結果（含 skipped）
- 證據的本機路徑
- 未驗證的項目與待補的平台
- 第 2 節列為待使用者決定的問題

PR merge 後，先把票的 worktree 的 `.local/ticket-artifacts/<issue>/` 複製到主 checkout 的 `.local/ticket-artifacts/<issue>/`，再刪除 worktree。證據與票的 `.local` 腳本因此留在開發機上，issue 與 PR 寫的證據路徑以主 checkout 為準。複製時不覆寫主 checkout 已有的檔案。

## 5. Windows

Windows 驗收用 verify skill 的原生 Desktop 模式，與 Mac 用同一支流程腳本與同一套證據格式。受測程式是開發版 Electron，或 `npm run package:win` 打包時留在 `release/win-unpacked/` 的 `XR Collector.exe`（`launchElectron({ app })`、`--app`）。Web 模式只在 Mac 執行；共用 UI 的 Web 畫面驗證在 Mac 完成。

在 Windows 上受測的 checkout 先執行 `npm ci`、`npm run download:runtime:win` 與 `npm run build`，打包版另執行 `npm run package:win`，再以 doctor 確認前置條件。doctor 的 `missing` 列出缺少的項目與修正方式，例如 `resources/bin/win`、Electron 執行檔、受測的 `.exe`：

```powershell
node .claude\skills\verify\scripts\verify.mjs doctor --app "release\win-unpacked\XR Collector.exe"
node .claude\skills\verify\scripts\smoke-desktop.mjs --evidence <證據目錄>
node .claude\skills\verify\scripts\smoke-desktop.mjs --app "release\win-unpacked\XR Collector.exe" --evidence <證據目錄>
```

票的流程腳本與 smoke 都是一個指令跑完、不需要互動，結果以 exit code 表示。`--evidence` 指定的目錄收下 `results.json`、截圖與 log，跑完整批取回開發機上票的 worktree 的 `.local/ticket-artifacts/<issue>/`。`results.json` 記錄受測的 commit、未提交內容的雜湊，以及執行的平台、OS 版本、Node 與機器的架構（`environment`）。

另一個平台的實機驗證是選擇性的：開發機沒有的平台，由另一台機器、另一位開發者或 VM 補驗。怎麼連到那台機器、怎麼把程式碼送過去、怎麼取回證據，由開發者自選工具，不屬於共同前置條件。補驗的機器 checkout 受驗的 commit，不放未提交修改。兩個平台的結果以 summary 彙整：

```sh
node .claude/skills/verify/scripts/verify.mjs summary --commit <完整 SHA> --platform darwin --platform win32 <mac>/results.json <windows>/results.json
```

summary 只計入該 commit 的結果；checkout 有未提交修改的 run 是 provisional，不計入。每個 scenario 在每個需要的平台都有 pass、同一平台沒有 fail、計入的 run 本身沒有失敗（`results.json` 沒有 `error`），才算完整；`--scenario` 列出的 scenario 沒有結果時標為 pending，缺少的平台也標為 pending。不完整時 exit code 為 2。

從沒有桌面的入口執行也能完成開發版與打包版的驗證，例如 SSH 登入的 Windows session 0：背景模式不顯示視窗，Playwright 照常操作頁面與截圖；螢幕大小依該入口而定（Windows session 0 是 1024x768），截圖的視窗大小可能與開發機不同。需要使用者桌面的能力，例如視窗聚焦、系統匣、通知、原生對話框本身、整個螢幕的截圖，在這種入口無法驗證；這類 scenario 在驗收計畫標為實機目視，在登入的桌面上執行。

Windows ARM VM 以 x64 Node 模擬執行開發版與打包版時，doctor 的 `platform` 與 `results.json` 的 `environment`（`emulated`、`hostArch`）如實標示 ARM64 host 與 x64 process，不把結果描述成 Intel／AMD host 原生執行。機器停止、桌面鎖定或無法連線時，該平台標為 blocked，恢復後再驗證。

## 6. 平台打包

交付平台固定為 Mac arm64 與 Windows x64，各平台在自己的建置機建置：Mac 在 Apple Silicon Mac 執行 `npm run package:mac`，Windows 以 x64 Node 執行 `npm run package:win`，x64 硬體或 ARM64 硬體上的 x64 模擬都可以。建置機的準備步驟與 `npm run doctor:build` 的檢查項目見 [建置、測試與發布](building.md)。產物在 `release/`，所有入口都使用 `--publish never`。

正式候選產物由兩台建置機從相同乾淨 commit／版本建置。package 入口持有整個 checkout 的獨占鎖，拒絕 dirty checkout，並在完成後從實際 `app.asar` 與 resources 讀回版本、BuildInfo、runtime inventory、Agent Skill、完整 commit、target、bytes 與 SHA-256，任一不一致都不交付；通過後寫出該平台的 release index 與 artifact manifest。artifact manifest 記錄實際 host／process 架構與工具版本。Windows 可以未簽章；Mac 預設仍為 ad-hoc，package gate 以 `codesign --verify --deep --strict` 驗證 bundle 與 sealed resources，不能把它描述成 Developer ID 或 Gatekeeper 信任。

**簽章與公證的使用時機**：每次 Developer ID 建置都要送 Apple 公證兩次並等待結果，成本高，只花在最終發布候選上。

- 開發與反覆驗收，包括功能、更新流程 A→B 與兩平台安裝 smoke，一律使用 Mac ad-hoc 包與 Windows 未簽署包，不使用 `--mac-signing-mode developer-id-notarized`。
- Developer ID 簽章與公證（App 與 DMG 各公證一次）只用於最終發布候選：其他驗收全部通過、使用者確認要建置發布候選之後才執行。
- 發布候選建置後需要修改程式時，修正先以 ad-hoc／未簽署包驗收，確認後再重建正式候選。
- 例外：修改簽章、公證或打包流程本身的票，以一次 Developer ID 實跑驗證該流程。

Mac 正式候選另以 `--mac-signing-mode developer-id-notarized --mac-signing-env <absolute-env> --mac-signing-root <absolute-root>` 明確啟用 Developer ID 模式。env 只接受 `CSC_LINK`、`CSC_KEY_PASSWORD`、`APPLE_API_KEY`、`APPLE_API_KEY_ID`、`APPLE_API_ISSUER`、`APPLE_TEAM_ID`；兩個檔案路徑都相對 signing root，env、p12、p8 必須只允許 owner 讀取。流程以專用 temporary keychain 找到該 p12 唯一且 Team 相符的 identity。因 macOS `codesign --keychain` 仍要求 identity 所在 keychain 可被搜尋，流程在保留既有順序下把自己建立的 keychain 暫時 append 到目前 user search list；正常清理由 `delete-keychain` 移除自己的 keychain，若該命令失敗，fallback 只從當下清單刪除自己的 entry，保留其他 session 同時加入的項目，並讓整次建置以包含主錯與清理錯的診斷失敗，不用舊 snapshot 覆蓋新變更。builder child 不取得 App Store Connect key。Mac Developer ID 產物依下列順序建置與檢查，每份產物只做一次完整檢查：

1. electron-builder `--dir` 產 App；afterPack 簽署 staged runtime，再以 Developer ID 簽署 App。
2. 公證前對 App 跑完整 Developer ID gate：Team、hardened runtime、entitlements、sealed resources 與 signed runtime inventory。
3. App 只送公證一次：以 `ditto` 壓成上傳用 ZIP，`notarytool submit` 後立即用 upload SHA、Team 與用途保存 submission ID，再等待結果並取回 log；中斷後只續查同一 submission，不能盲目重送。`Accepted`、零 issues 才 `stapler staple` 並 `stapler validate` App。
4. 對已 staple 的 App 跑完整 Developer ID gate、`syspolicy_check distribution` 與 `spctl --assess --type execute`；這份 App 的 identity 記為 App 收據的 `stapled`。
5. electron-builder 以 `--prepackaged` 由已 staple 的 App 一次產出 DMG 與 ZIP。
6. DMG 只送公證一次：直接上傳 DMG 本身，與 App 共用同一套 submission 保存、續查與收據規則；`Accepted`、零 issues 才 `stapler staple` 並 `stapler validate` DMG。DMG 收據的 `stapled` 是最終 DMG 的 bytes。
7. DMG gate：`codesign --verify --strict` 與 Team，並以 `spctl --assess --type open --context context:primary-signature -vv` 評估；該命令 exit code 非零，或 `source=` 不是 `Notarized Developer ID`，即失敗。`source=` 行印在 log。
8. 唯讀掛載 DMG，其中唯一的 App bytes 必須等於 `stapled`，並對它跑 `stapler validate`、`syspolicy_check distribution` 與 `spctl --assess --type execute` 各一次。
9. 以 `ditto` 解開 ZIP，其中唯一的 App 做與第 8 步相同的比對與檢查。
10. 讀回 `release/mac-arm64` 的 App：bytes 必須等於 `stapled`，再核對 BuildInfo、runtime 與 resources；步驟 2、4 已驗過相同 bytes，不重跑 Developer ID gate。

這些自動 gate 不取代 clean browser download、Finder 安裝及首次開啟的實機驗收。

```bash
npm run package:mac -- --mac-signing-mode developer-id-notarized --mac-signing-env /absolute/signing/root/.env --mac-signing-root /absolute/signing/root
```

Developer ID 會改變部分 runtime bytes。簽署 hook 只處理 staging copy，raw source pin 不變；runtime Mach-O 葉節點檔案最多 8 個同時簽署，Python.framework 等 bundle 在其內容全部簽完後才簽，維持由內而外；簽署前會把 SHA-256 pin 驗證過的 yt-dlp／Deno archives 另行解壓到隔離目錄，以該獨立重建結果比對 raw source 與 staging tree，不能用可和檔案一起改寫的 manifest 自證。`runtime-signing.json` 同時保存 raw producer identity、final 完整 inventory、Meilisearch raw／final identity及實際 signature。啟動端只接受 raw hash，或接受被有效外層 App seal 保護、final hash 相符且 Meilisearch 與外層 App Team 相同的 Developer ID identity；不能只信任可被單獨覆寫的 sidecar final SHA。Deno 保留固定 upstream 簽章。

GitHub Actions 的打包 smoke 只在手動觸發時建置未簽章的測試包，使用隔離的離線文件檢查實際打包 App、隨附 Meilisearch 搜尋與 yt-dlp／Deno 可執行。它不連真實 YouTube、不保存安裝包，失敗時只保留 `results.json`、截圖與 log 七天。

正式 Release 只接收兩台建置機從同一個乾淨 commit 建置並驗收的 Mac 與 Windows 候選，各平台由自己的建置機以 `npm run release:upload` 上傳；GitHub Actions 與原生 CI 只提供補充檢查，不建置或供應正式 Release 安裝包。公開 repository 的 GitHub Releases 提供免登入下載與各平台的 release index。發布步驟見 [建置、測試與發布](building.md#發布) 與 [Release 發布手冊](release-runbook.md)。
