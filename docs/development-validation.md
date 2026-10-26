# 開發驗證流程

PR 的驗證平台由功能影響決定。開發者先用自己的開發機完成適用案例，需要另一個平台時，由另一台機器或另一位 agent 對相同 commit 補驗。GitHub Linux CI 執行 `npm ci` 與 `npm run verify`（只改 Markdown 的修改不執行，見 AGENTS.md）；Mac ARM64 CI 另以 verify skill 的 Web 模式執行所有已收錄的非 Desktop 回歸流程。原生操作仍由 agent 實際驗收；GitHub 的 Mac ARM64／Windows x64 打包 smoke 是手動觸發的離線補充檢查，不是正式安裝包來源，也不取代作業系統畫面的驗收。

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

**基準**：回歸流程先跑基準，再跑本票版本。基準是主 checkout（`/Users/derektu/projects/km/xr-collector`，追蹤 main、不放未提交修改）：在票的 worktree 以 `--checkout <主 checkout>` 啟動 instance，跑同一支流程。票的 worktree 一開始改程式就不再等於 main，所以基準不在票的 worktree 跑，也不另建 worktree。兩次的證據分開存放，以結果比對：只在本票版本與功能檔或基準不一致的，是本票改變了行為；基準就與功能檔不一致的，是功能檔的問題，記在 PR 的待決定問題。

**斷言要能失敗**：證明本票新行為的斷言，在基準上必須失敗；基準上也通過的斷言不證明本票的修改，要改寫到能區分兩者。修正完成後，保留測試與斷言、拿掉修正再跑一次，例如以 `git archive` 匯出基準的程式執行新測試，斷言必須跟著失敗；交付報告附上這次失敗的輸出，只列斷言與數量。單元測試與 Web 流程的斷言都適用。確認行為不變的回歸斷言則在基準與本票版本都通過。

**斷言放在哪一層**：畫面上的狀態讀 DOM 的文字與屬性；資料面的狀態直接讀資料本身，例如 Vault 的檔案、profile 的紀錄與搜尋索引，不只經過本票修改的 API；截圖負責版面、視覺與斷言沒有涵蓋的部分。能寫成斷言的預期不只靠看截圖判斷，因為截圖無法重跑比對。

**真實資料**：合成資料只替代 yt-dlp 與網路上的 feed，看不到限流、實際的字幕軌道、頻道辨識的耗時與真實 feed 的格式差異。改到收集、字幕選軌、頻道或網址辨識、feed 讀取的票，交付前至少以 `--data real` 執行一次相關 scenario，或執行 verify skill 的真實資料 smoke。網路或限流使 scenario 無法完成時記為 blocked，不以合成結果代替。

畫面多、流程長的票，Web 畫面 scenario 寫成一支 Playwright 腳本，依計畫順序操作、斷言預期結果並自動截圖，修改後可整條重跑。啟動隔離的 instance、合成資料、等待與截圖由 verify skill 的 CLI 與函式庫提供；涵蓋功能地圖子功能、可重跑的流程收進 verify skill 的 `flows/`；只對本票有意義的腳本放在票的 worktree 的 `.local/ticket-artifacts/<issue>/scripts/`。Playwright 是 devDependency，腳本不加入 `npm run verify`。原生下拉選單等瀏覽器自動化拍不到的狀態，另以手動截圖補足。

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

Windows x64 安裝包在指定的 Parallels Windows ARM VM 以 x64 Node／toolchain 模擬建置及驗收。doctor 的 `platform` 與 `results.json` 的 `environment`（`emulated`、`hostArch`）如實標示 ARM64 host 與 x64 process，不把結果描述成 Intel／AMD host 原生執行。機器停止、桌面鎖定或無法連線時，該平台標為 blocked，恢復後再驗證。

## 6. 平台打包

交付平台固定為 Mac arm64 與 Windows x64。Mac 在使用者的 Apple Silicon Mac 執行 `npm run package:mac`；Windows 在指定的 Parallels Windows ARM VM 以 x64 Node／toolchain 執行 `npm run package:win`。預設中文精簡引擎產物在 `release/`。明確需要官方完整 Meilisearch 時使用 `npm run package:mac:official` 或 `npm run package:win:official`，產物分開放在 `release/official/`；每個 App 只包含一種引擎。所有入口都使用 `--publish never`。

正式候選產物由上述兩個指定本機環境從相同乾淨 commit／版本建置。package 入口持有整個 checkout 的獨占鎖，拒絕 dirty checkout，並在完成後從實際 `app.asar`、resources、updater metadata 與 artifact manifest 讀回版本、BuildInfo、runtime inventory、Agent Skill、完整 commit、target、variant、bytes 與 SHA-256；任一不一致都不交付。#34 同時記錄實際 host／process 架構、工具版本及安裝與操作驗收；未提交預演產物不視為正式版本。未簽章產物可以通過 #34，簽署、公證與憑證整合留待後續工作，驗收不讀取或修改使用者的簽署憑證。

GitHub Actions 的打包 smoke 只在手動觸發時建置未簽章的中文測試包，使用隔離的離線文件檢查實際打包 App、隨附 Meilisearch 搜尋與 yt-dlp／Deno 可執行。它不連真實 YouTube、不保存安裝包，失敗時只保留 `results.json`、截圖與 log 七天。

#35 提供在使用者 Mac 執行的發布工具與附件來源契約；#36 完成 updater 後才固定首版 commit，並從該 commit 建置、驗收及發布四個正式候選。GitHub Actions 與原生 CI 只提供補充檢查，不建置或供應正式 Release 安裝包。公開 repository 的 GitHub Releases 提供免登入下載與更新 metadata；#35 在正式發布前確認 repository 已公開，並以無 GitHub 登入／token 的客戶端驗證。具體順序與契約見 [本機安裝包計畫](local-packaging-plan.md)。
