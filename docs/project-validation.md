# 專案驗證設定

XR Collector 套用 [開發驗證流程](development-validation.md) 時的指令、層級、平台與門檻。實際操作 App 用 [verify skill](../.claude/skills/verify/SKILL.md)，功能與回歸流程的對應見 [功能地圖](../.claude/skills/verify/features/README.md)，測試目錄與平台 skip 邊界見 [測試說明](../tests/README.md)。

## 自動檢查

`npm run verify`：lint、單元、HTTP 與檔案系統整合測試（含真實 Meilisearch 的案例）、typecheck、build。改到 verify skill 的 `scripts/` 或 `tests/` 時另跑 `npm run test:verify-skill`。執行時不接 `| tee`，或先 `set -o pipefail`，保留 exit code。

只改 Markdown 的修改不跑 `npm run verify`，CI 也不執行，只確認連結有效與呈現正確。`skills/xr-collector-agent/SKILL.md` 例外：測試會讀它，改它時照常跑。同一次修改含有其他檔案時照常跑。

**測試的等待**：可直接等的 promise 就等它，其餘經 `tests/support/wait.ts` 的共用 helper 輪詢，上限統一 10 秒。Vitest 的 `testTimeout` 與 `hookTimeout` 統一 30 秒。由什麼強制見 [程式規範](code-guidelines.md#時間與非同步)。證明「某件事沒有發生」時，等產品排在那件事之後的步驟，再斷言；要證明某個狀態在一段時間內不變時，觀察窗寫成具名的取樣並註明為什麼需要。

## 驗證層級

Electron 載入的是同一套 HTTP 畫面與 API，多數產品行為不依賴桌面殼層，所以畫面驗證以 Web 模式為主，原生 Desktop 只花在瀏覽器無法證明的部分：

| 層級 | 內容 |
| --- | --- |
| 自動檢查 | `npm run verify` |
| Web 畫面 | verify skill 的 Web 模式（Mac）：隔離的 instance 與 headless Playwright |
| 原生 Desktop | verify skill 的 Electron 背景模式，Mac 與 Windows 用同一支流程腳本 |

依賴 Electron 或平台能力的 scenario 才用原生 Desktop：原生對話框、preload bridge、路徑與權限、程序生命週期、視窗行為、Tray／選單列、登入自啟、安裝與更新。其餘以 Web 畫面截圖作證據，截圖說明標示為 Web 模式；Web 畫面證據不替代原生 UI 證據。

**背景模式**：原生 Desktop 驗收預設設定 `XR_COLLECTOR_VALIDATION_HIDDEN=1`（`launchElectron` 的預設），視窗不顯示、不搶焦點，macOS 的 Dock 圖示從程式啟動就隱藏，Playwright 照常操作與截圖，開發者可以同時在同一台機器上工作。視窗大小由 `XR_COLLECTOR_VALIDATION_WINDOW_SIZE` 指定，格式為 `<寬>x<高>`（例如 `1440x900`），未設定或格式不符時為 1240×820；`launchElectron` 以 `size` 參數設定，預設 `1280x900`。會開原生對話框的 scenario 以 `stubDialogs` 替換回應；這證明 App 對對話框參數與結果的處理，不證明對話框本身。平台功能（Tray、登入自啟、更新等）經只在驗證模式開啟的控制通道查詢與觸發，以環境變數開關，正式使用時不開啟。

驗證視窗、聚焦、Dock、Tray／選單列本身、原生對話框本身或作業系統畫面時，關閉背景模式。這會跳出視窗，所以先取得使用者同意，並把這類 scenario 集中一次跑完；除錯先在背景模式或單元測試完成。只有正確與否取決於作業系統畫面的項目，才在驗收計畫標為實機目視，數量盡量少。

## 平台

| 功能影響 | 驗收平台 |
| --- | --- |
| 平台無關的 UI 與業務邏輯 | Mac |
| Mac 專屬 | Mac |
| Windows 專屬 | Windows |
| 平台相依，或影響不確定 | Mac 與 Windows |

路徑、檔案權限與 rename、程序與 lock、隨附 runtime、Electron、簽章、打包與更新屬於平台相依。某個平台跑得慢不是不跑的理由，要查出慢的原因。

開發主力是 Mac，Windows 由 VM 或另一台機器補驗。需要 Windows 而那台機器無法使用時（例如 VM 沒開），暫停並通知使用者，由使用者決定補驗，或只完成 Mac 並把 Windows 標為待補；不自行啟動或關閉 VM。

### 另一個平台的完整驗證

改動平台相依時，交付前在另一個平台跑完整 `npm run verify`；每個發布候選前兩平台都跑。另一個平台以 Git checkout 受驗的 commit，換行才會與該平台的 Git 設定一致，不用檔案同步代替，也不放未提交修改。準備步驟：`npm ci`，再安裝該平台釘住的 runtime（Mac 是 `npm run download:runtime`，Windows 是 `npm run download:runtime:win`；沒有 Visual C++ runtime 的機器再執行 `node scripts/prepare-windows-crt.mjs`）。只在一個平台成立的行為以平台條件 skip，不用 mock 冒充另一個平台通過。

Windows 上的完整測試正常需要 80～110 秒，Mac 約 15 秒；VM 剛開機或病毒碼更新後約半小時內會慢 2～4 倍。逾時與 teardown error 照失敗處理。

### Windows 的原生 Desktop 驗收

與 Mac 用同一支流程腳本與同一套證據格式；Web 模式只在 Mac 執行。受測程式是開發版 Electron，或 `npm run package:win` 留在 `release/win-unpacked/` 的 `XR Collector.exe`（`launchElectron({ app })`、`--app`）。受測的 checkout 先執行 `npm ci`、`npm run download:runtime:win` 與 `npm run build`：

```powershell
node .claude\skills\verify\scripts\startup.mjs --evidence <證據目錄>
node .claude\skills\verify\scripts\startup.mjs --app "release\win-unpacked\XR Collector.exe" --evidence <證據目錄>
```

流程腳本與 startup 都是一個指令跑完、不需要互動，結果以 exit code 表示。證據取回 Mac 後，以 `check` 確認兩個平台的結果完整且對應受驗的 commit：

```sh
node .claude/skills/verify/scripts/verify.mjs check --platform darwin --platform win32 <mac 證據目錄> <windows 證據目錄>
```

SSH 登入的 Windows session 0 可以完成開發版與打包版的背景模式驗證，螢幕是 1024x768；需要使用者桌面的能力（聚焦、系統匣、通知、原生對話框本身）在那裡無法驗證，改在登入的桌面執行。Windows ARM VM 以 x64 Node 模擬執行時，`results.json` 的 `environment` 如實標示 ARM64 host 與 x64 process。

## 真實資料

合成資料只替代 yt-dlp 與網路上的 feed，看不到限流、實際的字幕軌道、頻道辨識的耗時與真實 feed 的格式差異。改到收集、字幕選軌、頻道或網址辨識、feed 讀取的票，交付前至少以 `--data real` 執行一次相關 scenario，或執行 verify skill 的真實資料 smoke。網路或限流使 scenario 無法完成時記為 blocked。

## 門檻

**merge 門檻**分兩部分，都通過才 merge：

- **CI**：Mac 一個 job，`npm ci`、安裝釘住版本的 runtime、`npm run verify`，改到 verify skill 的 `scripts/` 或 `tests/` 時加跑 `npm run test:verify-skill`。
- **本機全部回歸流程**：rebase 到最新 main 之後、merge 之前，在受驗的 checkout 跑全部已收錄流程（Web 與 Desktop，Desktop 為背景模式，不跳視窗）。在 Mac 上約 2.5 分鐘。跨功能的版面互動（改 A 的版面蓋到 B 的按鈕）按功能挑流程時最容易漏，所以 merge 前不挑、全跑。

```sh
node .claude/skills/verify/scripts/verify.mjs flows run --jobs 3 --issue <issue> --label merge
```

開發中的快速回合依功能地圖挑相關的流程跑。只改 Markdown 的修改不跑這兩部分。

**nightly 與發布前**：`.github/workflows/nightly.yml` 每天台北時間 02:00 在 main 執行，main 前 26 小時沒有新 commit 時跳過；也可以在任何分支手動觸發，勾選 `report` 時才把結果寫進 issue。發布前在發布候選的 commit 手動觸發同一個 workflow。

| Job | 內容 |
| --- | --- |
| Verify | Mac 與 Windows：`npm run verify` 與 `npm run test:verify-skill` |
| Startup and Desktop flows | Mac 與 Windows：開發版的 startup 檢查與 `flows run --desktop` |
| Web flows | Mac：`flows run --web --jobs 3` |
| Package and startup | Mac 與 Windows：未簽章測試包，再以 `startup --app` 檢查打包版 |

CI、nightly 與 Meilisearch native 的 job 都經由 `.github/actions/pinned-runtimes` 準備 runtime。它先從 Actions cache 還原 runtime cache，cache key 包含平台、準備指令，以及兩個 pins 檔與 runtime cache 相關腳本的 hash。命中時不連 GitHub Releases；沒命中時照常下載，準備完成後立即存回 cache，後面的測試失敗也不影響這一份 cache。

Windows runner 在 job 開始時把 workspace 與 TEMP 加進 Defender 排除；開發者與公司的機器不改 Defender。每次 run 的 `results.json`、截圖與 server log 上傳成 artifact，保存 14 天。

失敗時，report job 在帶 `nightly` label 的 open issue 留言，沒有就開一張並加入看板 Todo（以 repo secret `NIGHTLY_PROJECT_TOKEN` 寫看板）。nightly issue 排在所有新功能之前；修正照一般的票交付，PR 寫 `Closes #<nightly issue>`，merge 後手動觸發 nightly 並勾選 `report` 確認通過。

## 打包與簽章

交付平台固定為 Mac arm64 與 Windows x64，各在自己的建置機建置；步驟見 [建置、測試與發布](building.md)。每次 Developer ID 建置都要送 Apple 公證兩次並等結果，成本高，所以：

- 開發與反覆驗收，包括功能、Windows 的更新流程 A→B 與兩平台安裝 smoke，一律用 Mac ad-hoc 包與 Windows 未簽署包。Squirrel.Mac 拒絕 ad-hoc 包的更新，所以 Mac 的更新流程 A→B 用驗收身分的 Developer ID 包（[更新來源](update-source.md#驗收身分)），只在改動更新流程本身的票與發布前執行。
- Developer ID 簽章與公證只用於最終發布候選：其他驗收全部通過、使用者確認要建置發布候選之後才執行。
- 發布候選建置後需要改程式時，修正先以 ad-hoc／未簽署包驗收，確認後再重建正式候選。
- 修改簽章、公證或打包流程本身的票，以一次 Developer ID 實跑驗證該流程。

打包的自動檢查不取代 clean browser download、Finder 安裝與首次開啟的實機驗收。發布步驟見 [Release 發布手冊](release-runbook.md)。
