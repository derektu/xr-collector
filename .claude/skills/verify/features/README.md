# XR Collector 功能地圖

驗證使用者看得到的行為時，以這個目錄為依據。先讀本頁，再照對應的功能檔操作。功能檔列出的每個入口都是驗證範圍；只走其中一個方便的入口，不算驗證了整個功能。

| 功能 | 檔案 | 主要層級 | 已收錄流程 |
| --- | --- | --- | --- |
| 收集單支影片 | [collect-video.md](collect-video.md) | Web；開啟原始影片需 Electron | — |
| 訂閱與檢查 | [subscriptions.md](subscriptions.md) | Web | `subscribe-a-b`、`offline-recover`、`subscription-failures`、`check-history-summary` |
| 記錄 | [activity.md](activity.md) | Web | `check-history-summary` |
| 工作頁 | [jobs.md](jobs.md) | Web | `subscribe-a-b` |
| 文件、閱讀與搜尋 | [documents-reader-search.md](documents-reader-search.md) | Web | — |
| RSS | [rss.md](rss.md) | Web | — |
| Vault 匯出、匯入與搬移 | [vault-transfer.md](vault-transfer.md) | Web；原生對話框需 Electron | `vault-transfer` |
| 選單列／系統匣 | [tray.md](tray.md) | 原生 Desktop（視窗會顯示） | `tray` |
| 登入電腦時自動啟動 | [login-startup.md](login-startup.md) | Web 負向；打包安裝版 VM | `login-startup` |

已收錄流程在 [`../flows/`](../flows/)，以 `verify.mjs flows run` 執行，見 [SKILL.md](../SKILL.md#已收錄流程)。

## 基準前置狀態

- 以 `verify.mjs launch --issue <N>` 啟動新的 instance：合成資料、`selected` Vault、空的 profile。
- `doctor --run <runDir>` 回報 `healthy: true`，Vault 路徑在 run 目錄內。
- 合成資料：頻道 A（5 支）、B（3 支）、D（3 支，單支加入用）；feed `/feed.xml`、`/atom.xml`、`/blog`。網址見 `launch` 輸出的 `synthetic`。
- 不操作不是本次啟動的 instance。

## 操作慣例

- 每個功能從基準狀態開始，除非功能檔的 Preconditions 另有要求。
- 前後相接的 scenario 串成一條流程，前一個的結束狀態是下一個的起點。
- 前置狀態可用 `subscribe`／`collect`／`idle` 經 API 建立；被測的動作一律經畫面操作。
- 優先用 `data-testid`、role＋名稱。原生 `<select>` 展開的選單截不到，用 `allInnerTexts()` 讀出選項寫進 observations。

## 證明與略過的回報

- 截動作與結果；每張截圖檔名以 scenario ID 開頭。
- 寫入類動作另以第二個觀點確認：Vault 檔案、API、重新整理後的畫面。
- 走不到的入口回報為 fail 或 blocked，附上嘗試的步驟與缺少的前置條件，不以其他入口代替。

## 功能檔格式

每個檔案以 H1 標題與一段使用者看得到的行為描述開頭，接著依序五個 H2：`Sub-features`、`How to get to it (user POV)`、`Driving it with verify`（以 `Preconditions:` 開頭，每個步驟配對使用者動作、確切操作與可觀察結果）、`Gotchas`、`Regression flows`。`Regression flows` 每支流程一行，以流程名開頭，列出它斷言的子功能 ID 與範圍；沒有流程時寫「沒有已收錄的流程。」

## 執行紀錄

| 功能 | 由本 skill 實際執行 |
| --- | --- |
| 收集單支影片 | 2026-10-22，Mac，`examples/collect-video.mjs`，COLLECT-01／02 通過 |
| Electron 啟動（`launchElectron`） | 2026-10-22，Mac：背景模式不顯示、不取得焦點、沒有 Dock 圖示；Vault 在 run 目錄內；`relaunch()`、`close()` 正常，沒有留下程序。尚未用來驗證任何功能 |
| 工作頁、RSS | 2026-10-22，Mac，依功能檔實際操作：工作頁 5 步、RSS 的訂閱、閱讀、新文章、503 與 404 都與檔案相符 |
| 訂閱與檢查 | 2026-10-23，Mac，`flows/subscribe-a-b.mjs`：訂閱、狀態序列、兩個訂閱同時收集與完成後的文件數，四個 scenario 通過 |
| 選單列／系統匣 | 2026-10-24，`flows/tray.mjs`：Mac 與 Windows（互動桌面，x64-on-ARM64）TRAY-D1～D8 通過 |
| 文件／閱讀／搜尋、Vault 匯出匯入與搬移 | 尚未以本 skill 執行；把手取自原始碼與 #75／#82 的 Web 驗收流程。第一次執行時修正本檔與功能檔 |
