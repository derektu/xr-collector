# 開發驗證流程

PR 的驗證平台由功能影響決定。開發者先用自己的開發機完成適用案例，需要另一個平台時，由另一台機器或另一位 agent 對相同 commit 補驗。GitHub Linux CI 執行 `npm ci` 與 `npm run verify`（只改 Markdown 的修改不執行，見 AGENTS.md）；畫面與原生行為由 agent 以 [verify skill](../.claude/skills/verify/SKILL.md) 實際操作 App 驗證，尚未設定為自動 Desktop runner 或 branch protection gate。

## 驗證層級

Electron 載入的是同一套 HTTP 畫面與 API，多數產品行為不依賴桌面殼層。驗證依 scenario 實際需要的層級進行，原生 Desktop 驗收只花在瀏覽器無法證明的部分：

| 層級 | 時機 | 內容 |
| --- | --- | --- |
| 自動檢查 | 每次修改 | `npm run verify`：單元、HTTP 與檔案系統整合測試、typecheck、build |
| Web 畫面 | 有畫面或 API 行為變更時，以及改到畫面依賴的狀態或資料流時 | verify skill 的 Web 模式：隔離的 instance 與 headless Playwright，依 scenario 操作、斷言並截圖 |
| 原生 Desktop | 票的結尾，只針對依賴 Electron 或平台能力的 scenario | Mac 用 verify skill 的 Electron 背景模式；Windows 依第 5 節 |

依賴 Electron 或平台能力的 scenario 包括：原生對話框、preload bridge、路徑與權限、程序生命週期、視窗行為、Tray／選單列、登入自啟、安裝與更新。其餘 scenario 以 Web 畫面截圖作為執行證據，截圖說明標示為 Web 模式。Web 畫面證據不替代原生 UI 證據。

驗收計畫為每個 scenario 標明驗證層級。狀態轉換、檔案內容、API 回應、去重、中斷與重啟等正確性，以 HTTP 與檔案系統整合測試驗證，測試隨票加入 `npm run verify`，之後每次修改都會重跑；截圖只用於使用者需要看到的畫面狀態。前後相接的 scenario 串成一條流程執行，前一個的結束狀態就是下一個的起點，不各自重建資料與環境。計畫聚焦在本票的風險：最後一列、空狀態、錯誤、操作後的刷新、重啟後的狀態這類邊界；合併重複的案例，`npm run verify` 已涵蓋且沒有畫面的低風險行為不另列 scenario。

**回歸**：票沒有改畫面，但改到畫面依賴的狀態或資料流，例如訂閱狀態、工作排隊與進度、知識庫的鎖與資料交換，仍在 Web 層執行 [功能地圖](../.claude/skills/verify/features/README.md) 中對應功能的流程，確認使用者看到的行為不變。這類行為由多個 module 拼成畫面，單元測試各自通過不代表畫面上的狀態正確。只有畫面完全讀不到的內部行為，才只靠自動檢查。

**基準**：回歸流程先跑基準，再跑本票版本。基準是主 checkout（`/Users/derektu/projects/km/xr-collector`，追蹤 main、不放未提交修改）：在票的 worktree 以 `--checkout <主 checkout>` 啟動 instance，跑同一支流程。票的 worktree 一開始改程式就不再等於 main，所以基準不在票的 worktree 跑，也不另建 worktree。兩次的證據分開存放，以結果比對：只在本票版本與功能檔或基準不一致的，是本票改變了行為；基準就與功能檔不一致的，是功能檔的問題，記在 PR 的待決定問題。

**真實資料**：合成資料只替代 yt-dlp 與網路上的 feed，看不到限流、實際的字幕軌道、頻道辨識的耗時與真實 feed 的格式差異。改到收集、字幕選軌、頻道或網址辨識、feed 讀取的票，交付前至少以 `--data real` 執行一次相關 scenario，或執行 verify skill 的真實資料 smoke。網路或限流使 scenario 無法完成時記為 blocked，不以合成結果代替。

畫面多、流程長的票，Web 畫面 scenario 寫成一支 Playwright 腳本，依計畫順序操作、斷言預期結果並自動截圖，修改後可整條重跑。啟動隔離的 instance、合成資料、等待與截圖由 verify skill 的 CLI 與函式庫提供；腳本放在票的 worktree 的 `.local/ticket-artifacts/<issue>/scripts/`，只寫該票特有的步驟。Playwright 是 devDependency，腳本不加入 `npm run verify`。原生下拉選單等瀏覽器自動化拍不到的狀態，另以手動截圖補足。

開發主力機器是 Mac；Windows 透過另一台電腦或 Parallels VM 執行。需要 Windows 驗收時，先確認 VM 正在執行且桌面可操作。VM 未啟動或無法操作時，暫停並通知使用者，由使用者決定啟動 VM 補驗，或只完成 Mac 驗收並將 Windows 標為待補。不自行啟動或關閉 VM。

## 1. 先定驗收計畫

實作前在 issue 以 Markdown 記錄驗收計畫：每個 scenario 的 ID、驗證層級、對應的功能地圖檔案、平台需求與原因、操作步驟及預期結果。只需要自動檢查的票，列出作為行為不變依據的現有測試與新增的案例。

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
- Windows 依第 5 節以原生工具擷取應用程式視窗，需要可見視窗。

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

PR merge 後刪除票的 worktree，證據隨之刪除。

## 5. Windows

verify skill 目前只支援 Mac，Windows 驗收使用 repo 的 `npm run validation` 工作區工具。工作區建立指定 commit 的獨立 worktree、隔離 profile／Vault，並記錄 OS、架構、commit 與來源雜湊：

```powershell
npm run validation -- doctor
npm run validation -- prepare --commit <完整 SHA> --plan <plan.json>
npm run validation -- start --workspace <workspace>
npm run validation -- capture --workspace <workspace> --scenario <ID>
npm run validation -- record --workspace <workspace> --scenario <ID> --result pass --note "實際觀察" --screenshot <capture 回傳的檔名>
npm run validation -- stop --workspace <workspace>
```

`prepare` 需要 JSON 格式的計畫，依 [計畫範例](validation-plan.example.json) 由 issue 的驗收計畫轉寫，只列 Windows 的 scenario；可加 `--pr <編號>` 核對 PR HEAD。每個工作區同時只交給一個 agent，重驗時用新的 `--run` 保留舊成果。`--allow-dirty` 的結果標為 provisional，不能滿足正式驗收。`record` 的 pass 須有已檢視的本 scenario 截圖與觀察說明。

從 SSH、Parallels exec 等入口執行時，不保證具有可截圖的使用者桌面。此時使用 repo 提供的輔助入口，在已登入的使用者桌面排程：

```powershell
.\scripts\validation\windows-session.ps1 -Action start -Workspace <workspace>
.\scripts\validation\windows-session.ps1 -Action status -Workspace <workspace>
.\scripts\validation\windows-session.ps1 -Action capture -Workspace <workspace> -Scenario <ID>
.\scripts\validation\windows-session.ps1 -Action stop -Workspace <workspace>
```

Node 預設從 PATH 找到，也可傳 `-NodePath <node.exe>`。排程成功不等於命令成功：檢查 `state/launcher-logs`、status 和預期截圖；stop 成功會移除本工作區的臨時排程。若啟動失敗，依輸出的精確 task name 核對與清理，保留診斷檔案。直接在互動桌面執行時不用建立排程。

使用 Parallels 的人可從 Mac 用 `prlctl exec <VM名稱> --current-user powershell.exe ... -File <repo內windows-session.ps1> ...` 呼叫同一入口。VM 名稱、repo、workspace 及 Node 路徑都是該機配置；Parallels 不屬於共同前置條件。也可使用 `prlctl capture` 後以 capture 的 `--file` 匯入。

Windows 驗證機只保留兩個目錄：`C:\projects\xr-collector` 是追蹤 `origin/main` 的 repo，不放未提交修改；`C:\projects\xr-collector-verify` 是從它建立的唯一 detached worktree，供每次驗證切換版本。驗證時在 verify worktree fetch 並切到受驗的分支或 PR HEAD，執行 `npm ci`、`npm run download:runtime:win` 與 build；`resources/bin/win` 與 node_modules 在不同版本間重用。profile、Vault 與 fixture 放在 `C:\projects\xr-collector-verify-data`，每次驗證前清空；截圖與結果存回 Mac 上票的 worktree 的 `.local/ticket-artifacts/<issue>/`。尚未 push 的版本可從 Mac 共享磁碟上的 repo（例如 `Y:\projects\km\xr-collector`）fetch，不經 GitHub。用 `prepare` 建立的工作區在驗收結束、證據存回 Mac 後移除，不在驗證機累積。

Windows ARM／x64 模擬執行須如實標示，不代替 Intel／AMD 原生驗收。桌面鎖定、Mac 休眠或 VM 停止時，標為 blocked，恢復可用桌面後再驗證。避免透過 Mac 掛載磁碟同步 node_modules；若傳未提交檔案產生 AppleDouble `._*`，僅清除此批傳輸產生的檔案再驗證。

## 6. 平台打包

Mac 執行 `npm run package:mac`，Windows 執行 `npm run package:win`；兩者產物都在 `release/`，使用 `--publish never`。目前是 Mac arm64 DMG／ZIP 與 Windows x64 NSIS，Windows ARM 可用 x64 Node 建置。

發版時，各機器從相同乾淨 commit／版本建置，完成適用的安裝與操作驗收，記錄產物 SHA256、架構與簽章，再上傳同一個 GitHub draft Release，核對完整附件後發布。未提交預演產物不視為正式版本。簽署／公證、Mac Intel 與 updater metadata 由 #34，發布與下載來源由 #35 負責。
