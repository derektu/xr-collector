# 開發驗證流程

驗證分三處：做票驗收在本機，嚴格並涵蓋邊界，證明本票的新行為正確；PR 門檻在 Mac CI，確認改動沒弄壞程式；nightly 與發布前在 Mac 與 Windows 跑完整的測試、E2E 與打包。原生操作由 agent 實際驗收，不以 build 成功或 CI 通過代替。

## 驗證層級

Electron 載入的是同一套 HTTP 畫面與 API，多數產品行為不依賴桌面殼層。驗證依 scenario 實際需要的層級進行，原生 Desktop 驗收只花在瀏覽器無法證明的部分：

| 層級 | 時機 | 內容 |
| --- | --- | --- |
| 自動檢查 | 每次修改 | `npm run verify`：單元、HTTP 與檔案系統整合測試、typecheck、build |
| Web 畫面 | 有畫面或 API 行為變更時，以及改到畫面依賴的狀態或資料流時 | verify skill 的 Web 模式：隔離的 instance 與 headless Playwright，依 scenario 操作、斷言並截圖 |
| 原生 Desktop | 票的結尾，只針對依賴 Electron 或平台能力的 scenario | verify skill 的 Electron 背景模式，Mac 與 Windows 用同一支流程腳本；Windows 見第 5 節 |

依賴 Electron 或平台能力的 scenario 包括：原生對話框、preload bridge、路徑與權限、程序生命週期、視窗行為、Tray／選單列、登入自啟、安裝與更新。其餘 scenario 以 Web 畫面截圖作為執行證據，截圖說明標示為 Web 模式。Web 畫面證據不替代原生 UI 證據。

驗收計畫為每個 scenario 標明驗證層級。狀態轉換、檔案內容、API 回應、去重、中斷與重啟等正確性，以 HTTP 與檔案系統整合測試驗證，測試隨票加入 `npm run verify`；截圖只用於使用者需要看到的畫面狀態。前後相接的 scenario 串成一條流程執行，前一個的結束狀態就是下一個的起點，不各自重建資料與環境。計畫聚焦在本票的風險，合併重複的案例；`npm run verify` 已涵蓋且沒有畫面的行為不另列 scenario。

票沒有改畫面，但改到畫面依賴的狀態或資料流時，例如訂閱狀態、工作排隊與進度、知識庫的鎖與資料交換，做票驗收仍在 Web 層執行 [功能地圖](../.claude/skills/verify/features/README.md) 中對應功能的流程。這類行為由多個 module 拼成畫面，單元測試各自通過不代表畫面上的狀態正確。只有畫面完全讀不到的內部行為，才只靠自動檢查。

- 每個功能檔的 `Regression flows` 列出涵蓋它的已收錄流程，從票改到的功能查出要跑哪幾支（verify skill 的 `flows run --feature`）；沒有收錄的才在票的 `.local/` 自己寫。
- 驗收計畫列出要跑的已收錄流程與原因；功能相關但不跑的，也寫出原因。
- 流程何時收錄、何時更新，依 [verify skill 的收錄規則](../.claude/skills/verify/SKILL.md#已收錄流程)。PR 描述的驗證段落列出本票收錄或更新的流程。

## 做票驗收、PR 門檻與 nightly

**依後果決定要不要測**：會造成資料遺失或毀損、不可逆的操作、機密外洩的行為，測試追到邊界情況。最壞只是一次操作失敗、使用者重試即可的，不開票、不加測試。

**做票驗收**：在本機進行，嚴格並涵蓋邊界情況，只在那張票做一次。用功能地圖決定要跑哪些流程。邊界情況的測試留在所屬功能的測試目錄。

**PR 門檻**：一個 Mac job：`npm ci`、安裝釘住版本的 runtime、`npm run verify`（單元與整合測試，含真實 Meilisearch 的案例，以及 typecheck 與 build）。門檻要快、結果穩定，不設時間上限。Web E2E 不在 PR 執行，而在 nightly、發布前與手動觸發的 E2E workflow 執行。只改 Markdown 的修改不執行門檻，見 AGENTS.md。

**nightly 與發布前**：Mac 與 Windows 都跑完整測試、全部 E2E（Web 流程在 Mac，Desktop 流程在兩平台）、App 啟動檢查與打包。失敗自動開 issue，修正優先於新功能。

**改 A 壞 B**：模組切分清楚時，改一個功能不會弄壞另一個功能。發現改 A 壞 B 時當設計問題處理：修模組邊界；修不了的牽連記在對應的功能檔。

**平台**：要不要在某個平台跑，只看改動的平台相依程度。路徑、檔案權限與 rename、程序與 lock、隨附 runtime、Electron 與打包屬於平台相依，Mac 與 Windows 都驗；平台無關的在 Mac 驗。某個平台跑得慢不是不跑的理由，要查出慢的原因。

**畫面**：畫面的回歸檢查讀程式狀態，例如 verify 的 state、App API 與結構化的 DOM 屬性，不比對整句文案。畫面長相（焦點框、置中、換行、tooltip）只在牽涉畫面的那張票驗收。打包相關的檢查只在改到打包時跑。

### 自動測試的判準

每個測試檔與已收錄流程，開頭寫出它防什麼：壞掉時使用者、Agent 或開發者會遇到什麼；只防開發者的標明「Guards the developer, not the user」。說不出防什麼的不留；檢討測試或流程時，每一項判定為保留、合併、移到下層、刪除或補上缺的。能用單元或 HTTP 測試保護的行為放在下層；只有必須經畫面串起多個 module 才看得到的結果，才寫成流程。

**等待**：測試與流程等某個狀態出現，不等固定時間。測試裡可直接等的 promise 就等它，其餘經 `tests/support/wait.ts` 的共用 helper 輪詢，上限統一 10 秒；這是狀態一直沒出現時多久報錯，不是預期耗時，不逐處調長。Vitest 的 `testTimeout` 與 `hookTimeout` 統一 30 秒，`tests/tooling/test-waits.test.ts` 擋下直接輪詢、睡眠與個別上限。證明「某件事沒有發生」時，等產品排在那件事之後的步驟，再斷言；要證明某個狀態在一段時間內維持不變時，觀察窗寫成具名的取樣並註明為什麼需要。

**失敗**：沒有改程式卻失敗時，不以重跑、拉長 timeout 或改變分類讓失敗消失，CI 歷史裡的單次失敗也算。每次失敗歸為產品 bug、測試假設或環境並查到根因；當下修不了的開 issue 加入看板。環境造成的失敗寫明是哪個環境條件。

## 1. 先定驗收計畫

實作前在 issue 以 Markdown 記錄驗收計畫：每個 scenario 的 ID、驗證層級、對應的功能地圖檔案、平台需求與原因、操作步驟及預期結果。預期結果寫成可以比對的條件，例如數量、狀態序列、出現次數，流程才能寫成斷言。只需要自動檢查的票，列出作為行為不變依據的現有測試與新增的案例。

| 功能影響 | 驗收平台 |
| --- | --- |
| 平台無關的 UI 與業務邏輯 | Mac |
| Mac 專屬 | Mac |
| Windows 專屬 | Windows |
| 平台相依，兩平台都受影響 | Mac 與 Windows |

路徑、權限、程序、runtime、原生視窗／選單／Tray、平台樣式、安裝與更新的變更，評估受影響的平台，不直接套用開發機的平台。影響不確定時納入兩平台。純文件的修改驗證實際渲染的文件，不硬造產品操作案例。機器缺少必要平台時，該平台維持「待驗證」。

開發中需求或 scenario 有變動時，先更新 issue 的驗收計畫與預期並記錄原因，再驗證對應的版本。無法執行的 scenario 標為未驗證，不以 build 成功或舊截圖宣稱通過。

## 2. 執行

依 verify skill 啟動隔離的 instance、執行流程腳本並清理。port、資料目錄、受測版本、程序辨識與證據位置都由 skill 定義。

- 啟動成功只代表環境就緒，接著仍須實際操作 scenario、比對預期，並執行必要的 API 與資料斷言。
- `results.json` 記錄受測的 commit 與未提交內容的雜湊。交付給 PR 的結果對應 PR 的 HEAD；HEAD 更新後，針對新版本重跑受影響的 scenario。
- 看過每張截圖再判定結果，確認不是錯誤頁、過期畫面或空白。工具不根據 PNG 存在判定成功。
- 本機跑本票的新 scenario 與相關的已收錄流程；同時跑多支時用 `flows run --jobs <N>`。只改流程腳本時，只重跑改到的流程，不重跑 `npm run verify`。
- 執行 `npm run verify` 或流程的指令保留退出碼：不接 `| tee`，或先 `set -o pipefail`。

畫面多、流程長的票，Web 畫面 scenario 寫成一支 Playwright 腳本，依計畫順序操作、斷言並自動截圖，修改後可整條重跑。只對本票有意義的腳本放在票的 worktree 的 `.local/ticket-artifacts/<issue>/scripts/`，不加入 `npm run verify`。瀏覽器自動化拍不到的狀態，例如原生下拉選單，另以手動截圖補足。

**基準**：基準是主 checkout（`/Users/derektu/projects/km/xr-collector`，追蹤 main、不放未提交修改）：在票的 worktree 以 `--checkout <主 checkout>` 啟動 instance，跑同一支流程。票的 worktree 一開始改程式就不再等於 main，所以基準不在票的 worktree 跑，也不另建 worktree。基準用來證明本票新增的斷言在 main 上失敗。確認行為不變的回歸流程只在本票版本跑；結果與功能檔不一致而判斷不了是本票造成、還是功能檔本身有誤時，才對那一支跑基準比對，功能檔的問題記在 PR 的待決定問題。

**斷言要能失敗**：證明本票新行為的斷言，在基準上必須失敗；基準上也通過的斷言不證明本票的修改，要改寫到能區分兩者。修正完成後，保留測試與斷言、拿掉修正再跑一次（例如以 `git archive` 匯出基準的程式執行新測試），斷言必須跟著失敗；交付報告附上這次失敗的輸出，只列斷言與數量。單元測試與 Web 流程的斷言都適用。

**斷言放在哪一層**：畫面上的狀態讀 DOM 的屬性與 App API；資料面的狀態直接讀資料本身，例如 Vault 的檔案、profile 的紀錄與搜尋索引，不只經過本票修改的 API。截圖負責版面、視覺與斷言沒有涵蓋的部分；能寫成斷言的預期不只靠看截圖判斷，因為截圖無法重跑比對。

**真實資料**：合成資料只替代 yt-dlp 與網路上的 feed，看不到限流、實際的字幕軌道、頻道辨識的耗時與真實 feed 的格式差異。改到收集、字幕選軌、頻道或網址辨識、feed 讀取的票，交付前至少以 `--data real` 執行一次相關 scenario，或執行 verify skill 的真實資料 smoke。網路或限流使 scenario 無法完成時記為 blocked，不以合成結果代替。

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
- 改動平台相依時，在另一個平台跑的完整 `npm run verify`：OS、host 與 Node 的架構（ARM64 上模擬的 x64 Node 照實標示）、通過／失敗／略過數與耗時
- 每個 scenario 的層級、資料模式、結果（pass／fail／blocked）與實際觀察
- 精確的 HEAD，以及 CI 結果（含 skipped）
- 證據的本機路徑
- 未驗證的項目與待補的平台
- 第 2 節列為待使用者決定的問題

PR merge 後，先把票的 worktree 的 `.local/ticket-artifacts/<issue>/` 複製到主 checkout 的 `.local/ticket-artifacts/<issue>/`，再刪除 worktree。證據與票的 `.local` 腳本因此留在開發機上，issue 與 PR 寫的證據路徑以主 checkout 為準。複製時不覆寫主 checkout 已有的檔案。

## 5. 另一個平台

開發主力機器是 Mac；Windows 由另一台機器、另一位開發者或 VM 補驗。怎麼連到那台機器、怎麼把程式碼送過去、怎麼取回證據，由開發者自選工具。需要 Windows 驗收而那台機器無法使用時（例如 VM 沒有開），暫停並通知使用者，由使用者決定補驗，或只完成 Mac 驗收並將 Windows 標為待補。不自行啟動或關閉 VM。

### 另一個平台的完整驗證

開發機只跑自己的平台；路徑、權限與換行這類差異，只有在另一個平台跑完整測試才會發現。改動涉及以下平台差異時，交付前在另一個平台跑完整 `npm run verify`（Mac 開發者跑 Windows，Windows 開發者跑 Mac）；每個發布候選前兩平台都跑：

- 路徑：分隔符號、大小寫、Windows 的 8.3 短檔名
- 檔案權限、symlink 與 rename
- 程序與 lock
- 隨附 runtime、Electron、簽署、打包與更新
- 換行：Windows 的 Git 以 `core.autocrlf` 把文字檔 checkout 成 CRLF

另一個平台以 Git checkout 受驗的 commit，換行才會與該平台的 Git 設定一致，不用檔案同步代替，也不放未提交修改；`npm ci` 後執行 `npm run verify`。只在一個平台成立的行為依 [測試說明的平台邊界](../tests/README.md#真實搜尋與平台邊界) 以平台條件 skip，不用 mock 冒充另一個平台通過。

Windows 上的完整測試正常需要 80～110 秒，Mac 約 15 秒。原因包括 worker 數少、每個測試檔的固定啟動成本，以及防毒即時掃描測試寫出的檔案與啟動的程式。checkout 已排除時，再把 `TEMP` 放進 Defender 排除只快約 15～20%，所以驗證流程不假設有排除；公司管理的機器不能改 Defender。VM 剛開機或病毒碼更新後約半小時內會慢 2～4 倍，量測耗時要等 Defender 閒下來。逾時與 teardown error 照失敗處理：查出原因，不以重跑抵銷。

### Windows 的原生 Desktop 驗收

Windows 驗收用 verify skill 的原生 Desktop 模式，與 Mac 用同一支流程腳本與同一套證據格式。受測程式是開發版 Electron，或 `npm run package:win` 打包時留在 `release/win-unpacked/` 的 `XR Collector.exe`（`launchElectron({ app })`、`--app`）。Web 模式只在 Mac 執行；共用 UI 的 Web 畫面驗證在 Mac 完成。

在 Windows 上受測的 checkout 先執行 `npm ci`、`npm run download:runtime:win` 與 `npm run build`，打包版另執行 `npm run package:win`，再以 doctor 確認前置條件。doctor 的 `missing` 列出缺少的項目與修正方式，例如 `resources/bin/win`、Electron 執行檔、受測的 `.exe`：

```powershell
node .claude\skills\verify\scripts\verify.mjs doctor --app "release\win-unpacked\XR Collector.exe"
node .claude\skills\verify\scripts\smoke-desktop.mjs --evidence <證據目錄>
node .claude\skills\verify\scripts\smoke-desktop.mjs --app "release\win-unpacked\XR Collector.exe" --evidence <證據目錄>
```

票的流程腳本與 smoke 都是一個指令跑完、不需要互動，結果以 exit code 表示。`--evidence` 指定的目錄收下 `results.json`、截圖與 log，跑完整批取回開發機上票的 worktree 的 `.local/ticket-artifacts/<issue>/`。`results.json` 記錄受測的 commit、未提交內容的雜湊，以及執行的平台、OS 版本、Node 與機器的架構（`environment`）。兩個平台的結果以 summary 彙整：

```sh
node .claude/skills/verify/scripts/verify.mjs summary --commit <完整 SHA> --platform darwin --platform win32 <mac>/results.json <windows>/results.json
```

summary 只計入該 commit 的結果；checkout 有未提交修改的 run 是 provisional，不計入。每個 scenario 在每個需要的平台都有 pass、同一平台沒有 fail、計入的 run 本身沒有失敗（`results.json` 沒有 `error`），才算完整；`--scenario` 列出的 scenario 沒有結果時標為 pending，缺少的平台也標為 pending。不完整時 exit code 為 2。

從沒有桌面的入口執行也能完成開發版與打包版的驗證，例如 SSH 登入的 Windows session 0：背景模式不顯示視窗，Playwright 照常操作頁面與截圖；螢幕大小依該入口而定（Windows session 0 是 1024x768），截圖的視窗大小可能與開發機不同。需要使用者桌面的能力，例如視窗聚焦、系統匣、通知、原生對話框本身、整個螢幕的截圖，在這種入口無法驗證；這類 scenario 在驗收計畫標為實機目視，在登入的桌面上執行。

Windows ARM VM 以 x64 Node 模擬執行開發版與打包版時，doctor 的 `platform` 與 `results.json` 的 `environment`（`emulated`、`hostArch`）如實標示 ARM64 host 與 x64 process，不把結果描述成 Intel／AMD host 原生執行。機器停止、桌面鎖定或無法連線時，該平台標為 blocked，恢復後再驗證。

## 6. 平台打包

交付平台固定為 Mac arm64 與 Windows x64，各平台在自己的建置機建置；建置機的準備、打包的檢查與 Developer ID 的建置步驟見 [建置、測試與發布](building.md)。正式候選由兩台建置機從同一個乾淨 commit 建置並驗收。

**簽章與公證的使用時機**：每次 Developer ID 建置都要送 Apple 公證兩次並等待結果，成本高，只花在最終發布候選上。

- 開發與反覆驗收，包括功能、更新流程 A→B 與兩平台安裝 smoke，一律使用 Mac ad-hoc 包與 Windows 未簽署包，不使用 `--mac-signing-mode developer-id-notarized`。
- Developer ID 簽章與公證（App 與 DMG 各公證一次）只用於最終發布候選：其他驗收全部通過、使用者確認要建置發布候選之後才執行。
- 發布候選建置後需要修改程式時，修正先以 ad-hoc／未簽署包驗收，確認後再重建正式候選。
- 例外：修改簽章、公證或打包流程本身的票，以一次 Developer ID 實跑驗證該流程。

打包的自動檢查不取代 clean browser download、Finder 安裝及首次開啟的實機驗收。E2E workflow 手動觸發時可選擇建置 Mac 與 Windows 的未簽章測試包，以隔離的離線文件檢查打包 App、隨附 Meilisearch 與 yt-dlp／Deno；這些包不是安裝包來源。發布步驟見 [建置、測試與發布](building.md#發布) 與 [Release 發布手冊](release-runbook.md)。
