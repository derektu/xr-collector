# 可攜的 PR 原生驗證

PR 的驗證平台由功能影響決定。開發者先用自己的開發機完成適用案例，需要另一個平台時，由另一台機器或另一位 agent 對相同 commit 補驗。GitHub Linux CI 仍執行 `npm ci` 與 `npm run verify`；原生操作與截圖依本流程執行，尚未設定為自動 Desktop runner 或 branch protection gate。

## 驗證層級

Electron 載入的是同一套 HTTP 畫面與 API，多數產品行為不依賴桌面殼層。驗證依 scenario 實際需要的層級進行，原生 Desktop 驗收只花在瀏覽器無法證明的部分：

| 層級 | 時機 | 內容 |
| --- | --- | --- |
| 自動檢查 | 每次修改 | `npm run verify`：單元、HTTP 與檔案系統整合測試、typecheck、build |
| Web 畫面 | 有畫面或 API 行為變更時 | 以隔離的 `XR_COLLECTOR_PROFILE` 執行 `npm run dev`，在瀏覽器依 scenario 操作、比對並截圖 |
| 原生 Desktop | 票的結尾，只針對依賴 Electron 或平台能力的 scenario | 依本文件第 2–4 節，在指定版本的 Desktop 實際操作與原生截圖 |

依賴 Electron 或平台能力的 scenario 包括：原生對話框、preload bridge、路徑與權限、程序生命週期、視窗行為、Tray／選單列、登入自啟、安裝與更新。其餘 scenario 以 Web 畫面截圖作為執行證據，截圖說明標示為 Web 開發模式。Web 畫面證據不替代原生 UI 證據。

驗收計畫為每個 scenario 標明驗證層級。狀態轉換、檔案內容、API 回應、去重、中斷與重啟等正確性，以 HTTP 與檔案系統整合測試驗證，測試隨票加入 `npm run verify`，之後每次修改都會重跑；截圖只用於使用者需要看到的畫面狀態。前後相接的 scenario 串成一條流程執行，前一個的結束狀態就是下一個的起點，不各自重建資料與環境。計畫聚焦在本票的風險：合併重複的案例，`npm run verify` 已涵蓋且沒有畫面的低風險行為不另列 scenario。

畫面多、流程長的票，Web 畫面 scenario 寫成一支 Playwright 腳本，依計畫順序操作、斷言預期結果並自動截圖，修改後可整條重跑。啟動隔離的 instance、合成資料、等待與截圖由 [verify skill](../.claude/skills/verify/SKILL.md) 的 CLI 與函式庫提供；腳本放在 `.local/ticket-artifacts/<issue>/scripts/`，只寫該票特有的步驟。Playwright 是 devDependency，腳本不加入 `npm run verify`。原生下拉選單等瀏覽器自動化拍不到的狀態，另以手動截圖補足。

開發主力機器是 Mac；Windows 透過另一台電腦或 Parallels VM 執行。需要 Windows 驗收時，先確認 VM 正在執行且桌面可操作。VM 未啟動或無法操作時，暫停並通知使用者，由使用者決定啟動 VM 補驗，或只完成 Mac 驗收並將 Windows 標為待補。不自行啟動或關閉 VM。

## 1. 先定驗收計畫

實作前在 issue 記錄 scenario ID、平台需求與原因、操作步驟及預期結果。可複製 [計畫範例](validation-plan.example.json) 作為本次 plan；範例不代表每個 PR 都要 Windows。兩台電腦使用同一份計畫，工具以內容雜湊辨識，`version` 供人閱讀。

| 功能影響 | scenario 的 `platforms` | 通過條件 |
| --- | --- | --- |
| 共用 UI／業務邏輯，沒有平台差異 | `["any"]` | Mac 或 Windows 任一平台完成 |
| Mac 專屬 | `["macos"]` | Mac 完成 |
| Windows 專屬 | `["windows"]` | Windows 完成 |
| 兩平台都受影響 | `["macos", "windows"]` | 兩平台各自完成 |

路徑、權限、程序、runtime、原生視窗／選單／Tray、平台樣式、安裝／更新等變更須評估受影響的平台，不直接套用開發機的平台。影響不確定時納入兩平台。純文件 PR 驗證實際渲染文件，不硬造產品操作案例；下列 Desktop 啟動工具專門處理應用程式案例，文件 review 可直接交付原生檢視器截圖與版本說明。

機器缺少必要平台時，該平台維持「待驗證」。Windows 開發者可先完成共用與 Windows 案例，再找 Mac 補 Mac 案例；反向亦同。

## 2. 在任意 checkout 建立獨立工作區

前置條件：Git、符合 `.nvmrc` 的 Node/npm，以及可登入的原生桌面。原生 runtime 目前支援 Mac arm64、Windows x64 Node；Windows ARM 可用 x64 模擬執行。Mac Intel 尚待 #34。另一台機器需自行具備相同工具，無須複製某位開發者的 Node 目錄或安裝 Parallels。

在 repo checkout 執行：

```sh
npm run validation -- doctor
npm run validation -- prepare --pr 42 --commit <完整40字元PR-HEAD> --plan <plan.json>
```

`doctor` 檢查本機平台、Node 與 Git。桌面是否解鎖、操作／截圖權限仍在實際啟動與擷取時確認，doctor 成功不等於原生驗收通過。

`prepare` fetch 該 PR，核對 HEAD 與指定 commit，建立 detached worktree、執行 `npm ci` 並確認 Electron 執行檔已下載。可省略 `--pr`，直接驗證指定 commit；用 `--remote` 指定非預設 remote。預設優先使用 origin，沒有 origin 時使用現有第一個 remote。開發 checkout 的修改保留，預設驗證的是指定 commit，不會帶入未提交內容。

預設根目錄是當前使用者的 `~/.xr-collector/validation`。可用 `--root <目錄>` 或 `XR_COLLECTOR_VALIDATION_ROOT` 指定另一個位置；根目錄必須在開發 checkout 之外。Windows 若遇到工具路徑長度限制，可選較短的根目錄。

```text
<validation-root>/repo-<repository hash>/
  pr-42/<完整 commit>/<macos 或 windows>/<run>/
    checkout/          指定版本的獨立 worktree
    plan.json          此 run 的固定計畫
    workspace.json    repository、commit、計畫及來源身分
    state/            profile、Vault、程序資訊與啟動器紀錄
    evidence/         各次啟動結果、選定截圖與 scenario 結果
```

沒有 PR 編號時以 `commit/` 代替 `pr-42/`。`prepare` 回傳 workspace 絕對位置、本機適用案例與尚需其他平台的需求。後續命令接受這個位置，不依賴 repo 所在磁碟或個人目錄名稱。每台機器建立自己的工作區；只交換計畫與匯出的證據，不搬動含 PID／裝置資料的工作區。

每個工作區同時只交給一個 agent。重複建立同一路徑會拒絕；選新 `--run` 即可保留舊成果。`--allow-dirty` 只供目前 HEAD 的開發預演：會複製未提交差異及未忽略的新檔、驗證來源身分，並將結果標成 provisional，不能用來滿足正式 PR 的驗收要求。`--skip-install` 僅供準備流程診斷；這類工作區不能直接 start。

可用 `--runtime-cache <resources/bin目錄>` 複用本機已有 runtime；啟動仍執行專案的下載／版本與完整性檢查。預設沒有這項本機配置也能下載所需檔案。

## 3. 啟動、操作與截圖

以下 `<workspace>` 使用 prepare 的輸出；Mac Terminal 與 Windows PowerShell 使用相同 npm 指令：

```sh
npm run validation -- start --workspace <workspace>
npm run validation -- status --workspace <workspace>
```

入口核對來源與計畫，重新 build，隔離 profile／Vault，等待 health ok 與真實搜尋引擎 ready。每次啟動的 manifest 記錄 OS、host／Node 架構、commit、來源雜湊與時間。啟動成功只代表環境就緒，接著仍須實際操作 scenario、比對預期及執行必要的 API／資料斷言。合成資料須標示，不能替代要求真實 YouTube 來源的案例。

Windows 可直接在登入的互動桌面擷取應用程式視窗：

```sh
npm run validation -- capture --workspace <workspace> --scenario COMMON-01
```

Mac 用原生工具找到實際應用程式視窗 ID 後，傳入 `--window <ID>`。也可用 `--file <原生PNG>` 匯入 agent 已透過原生工具取得的本次畫面；匯入不會自動證明圖片內容與版本，agent 必須核對當前視窗、版本及畫面。檢視每張 PNG，確認不是過期、遮擋或其他程式的截圖。

擷取會回傳 evidence 下的相對檔名，核對後記錄結果：

```sh
npm run validation -- record --workspace <workspace> --scenario COMMON-01 --result pass --note "實際觀察與預期一致的說明" --screenshot screenshots/COMMON-01-<時間>.png
```

結果可為 `pass`、`fail`、`blocked`；pass 須有已檢視的本 scenario 截圖與觀察說明。工具不根據 PNG 存在自動判定案例成功。每個 run 的同一 scenario 只記錄一次；修正或重驗時建立新 run，保留原始失敗紀錄。本機不適用的 scenario 不能在該平台記錄為通過。

```sh
npm run validation -- stop --workspace <workspace>
```

stop 正常關閉此次應用程式，保留資料與證據。同一工作區再 start 可驗證重啟。來源、計畫或 commit 改變時建立新 run，避免混合不同版本。無法正常退出時核對指定 PID／視窗，不按 image name 強制結束所有 Electron。

### 背景驗收模式

以 Playwright `_electron.launch` 操作的原生 Desktop 驗收，預設設定環境變數 `XR_COLLECTOR_VALIDATION_HIDDEN=1`。此模式下主視窗建立後不顯示、不取得焦點，macOS 在程式啟動時即隱藏 Dock 圖示，`second-instance` 等事件也不把視窗帶到前景；視窗關閉 `backgroundThrottling`，隱藏時照常繪製與執行計時器。Playwright 透過 DevTools 協定操作網頁內容與截圖，不依賴視窗顯示，因此截圖是即時的完整畫面，開發者可以同時在同一台機器上工作，不會被跳出的視窗打斷或誤觸受測程式。`XR_COLLECTOR_VALIDATION_HIDDEN` 與 `XR_COLLECTOR_VALIDATION_WINDOW_SIZE` 同屬驗收專用設定，不出現在使用者介面；未設定時 App 照一般方式顯示視窗。

會開啟原生對話框的 scenario（例如選擇資料夾、選擇備份檔），在主程序以 `electronApp.evaluate` 替換 `dialog.showOpenDialog`、`dialog.showSaveDialog` 的回應，回傳 run 目錄內的路徑並記錄呼叫參數，不開啟真的對話框：

```js
await electronApp.evaluate(({ dialog }, folder) => {
  globalThis.__dialogCalls = [];
  dialog.showOpenDialog = async (...args) => {
    globalThis.__dialogCalls.push(args.at(-1));
    return { canceled: false, filePaths: [folder] };
  };
}, folderInRunDirectory);
```

以下情況關閉背景模式，並在 issue 的驗收計畫註明執行時會跳出視窗：

- scenario 驗證的是視窗顯示、聚焦、Dock、Tray／選單列本身。
- 使用前述 `npm run validation -- start` 與 `capture --window`。這條流程以原生工具擷取應用程式視窗，需要可見視窗。

## 4. 跨機彙整與 PR 交付

```sh
npm run validation -- export --workspace <workspace> --output <新的匯出目錄>
npm run validation -- summarize --plan <plan.json> --commit <完整SHA> --bundle <電腦A的匯出目錄> --bundle <電腦B的匯出目錄>
```

export 只包含可攜的 report、plan 及已記錄的截圖；profile、Vault、Agent token、connection file 與原始 log 不匯出。截圖本身仍須檢查私人資料。匯出目錄可複製到另一台機器，不要求原始路徑相同。

summarize 核對 repository、commit、計畫身分與截圖雜湊。共用案例任一平台通過即可；平台專屬或兩平台案例須分別達成，provisional 不計入。缺少／blocked 顯示 pending；同時提供互相矛盾的 fail／pass 時保留 fail，不偷偷採用成功結果。修正後使用新的 commit，或明確選擇已完成 review 的重驗證據集合，保留原始結果供追溯。

完整通過退出碼 0，尚缺或失敗為 2，輸入錯誤為 1。這是證據完整性彙整，不是對 agent 人工判斷的自動認證，也尚未連接 branch protection。

PR 附需求平台／本機可用平台、每個 scenario 的結果、精確 HEAD、CI 結果（含 skipped）與可持久檢視的截圖／report 連結。缺少平台維持待補；HEAD 更新後針對該版本重跑。只有本機絕對路徑時，遠端 PR 的證據交付仍未完成。

截圖保存在本機 `.local/ticket-artifacts/<issue>/`，結果檔逐個 scenario 列出結果、觀察與要公開的截圖及圖說。公開的截圖以 GitHub 附件上傳到 PR 的一則留言，按 scenario ID 排列；issue 的驗收結果記錄文字並連到該留言。截圖與 report 不提交到 repo，也不放在證據分支或 tag。PR merge 後刪除本機截圖。

## 5. Windows 的非互動命令與選用 Parallels

一般 Windows 開發者可直接使用前面的命令。從 SSH、Parallels exec 等入口執行時，不保證具有可截圖的使用者桌面。此時可使用 repo 提供的輔助入口，在已登入的使用者桌面排程：

```powershell
.\scripts\validation\windows-session.ps1 -Action start -Workspace <workspace>
.\scripts\validation\windows-session.ps1 -Action status -Workspace <workspace>
.\scripts\validation\windows-session.ps1 -Action capture -Workspace <workspace> -Scenario COMMON-01
.\scripts\validation\windows-session.ps1 -Action stop -Workspace <workspace>
```

Node 預設從 PATH 找到，也可傳 `-NodePath <node.exe>`。排程成功不等於命令成功：檢查 `state/launcher-logs`、status 和預期截圖；stop 成功會移除本工作區的臨時排程。若啟動失敗，依輸出的精確 task name 核對與清理，保留診斷檔案。直接互動桌面執行不用建立排程。

使用 Parallels 的人可從 Mac 用 `prlctl exec <VM名稱> --current-user powershell.exe ... -File <repo內windows-session.ps1> ...` 呼叫同一入口。VM 名稱、repo、workspace 及 Node 路徑都是該機配置；Parallels 不屬於共同前置條件。也可使用 `prlctl capture` 後以 capture 的 `--file` 匯入。

Windows 驗證機只保留兩個目錄：`C:\projects\xr-collector` 是追蹤 `origin/main` 的 repo，不放未提交修改；`C:\projects\xr-collector-verify` 是從它建立的唯一 detached worktree，供每次驗證切換版本。驗證時在 verify worktree fetch 並切到受驗的分支或 PR HEAD，執行 `npm ci`、`npm run download:runtime:win` 與 build；`resources/bin/win` 與 node_modules 在不同版本間重用。profile、Vault 與 fixture 放在 `C:\projects\xr-collector-verify-data`，每次驗證前清空；截圖與結果存回 Mac 開發 checkout 的 `.local/ticket-artifacts/<issue>/`。尚未 push 的版本可從 Mac 共享磁碟上的 repo（例如 `Y:\projects\km\xr-collector`）fetch，不經 GitHub。需要 `prepare` 工作區的正式證據流程，在 `export` 後移除該工作區，不在驗證機累積。

Windows ARM／x64 模擬執行須如實標示，不代替 Intel／AMD 原生驗收。桌面鎖定、Mac 休眠或 VM 停止時，標為 blocked，恢復可用桌面後再驗證。避免透過 Mac 掛載磁碟同步 node_modules；若傳未提交檔案產生 AppleDouble `._*`，僅清除此批傳輸產生的檔案再驗證。

## 6. 平台打包

Mac 執行 `npm run package:mac`，Windows 執行 `npm run package:win`；兩者產物都在 `release/`，使用 `--publish never`。目前是 Mac arm64 DMG／ZIP 與 Windows x64 NSIS，Windows ARM 可用 x64 Node 建置。

發版時，各機器從相同乾淨 commit／版本建置，完成適用的安裝與操作驗收，記錄產物 SHA256、架構與簽章，再上傳同一個 GitHub draft Release，核對完整附件後發布。未提交預演產物不視為正式版本。簽署／公證、Mac Intel 與 updater metadata 由 #34，發布與下載來源由 #35 負責。
