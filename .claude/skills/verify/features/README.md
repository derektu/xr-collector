# XR Collector 功能地圖

驗證使用者看得到的行為時，以這個目錄為依據。先讀本頁，再照對應的功能檔操作。功能檔列出的每個入口都是驗證範圍；只走其中一個方便的入口，不算驗證了整個功能。

| 功能 | 檔案 | 主要層級 |
| --- | --- | --- |
| 收集單支影片 | [collect-video.md](collect-video.md) | Web；開啟原始影片需 Electron |
| 訂閱與檢查 | [subscriptions.md](subscriptions.md) | Web |
| 工作頁 | [jobs.md](jobs.md) | Web |
| 文件、閱讀與搜尋 | [documents-reader-search.md](documents-reader-search.md) | Web |
| RSS | [rss.md](rss.md) | Web |
| Vault 匯出、匯入與搬移 | [vault-transfer.md](vault-transfer.md) | Web；原生對話框需 Electron |

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

每個檔案以 H1 標題與一段使用者看得到的行為描述開頭，接著依序四個 H2：`Sub-features`、`How to get to it (user POV)`、`Driving it with verify`（以 `Preconditions:` 開頭，每個步驟配對使用者動作、確切操作與可觀察結果）、`Gotchas`。

## 執行紀錄

| 功能 | 由本 skill 實際執行 |
| --- | --- |
| 收集單支影片 | 2026-10-22，Mac，`examples/collect-video.mjs`，COLLECT-01／02 通過 |
| Electron 啟動（`launchElectron`） | 2026-10-22，Mac：背景模式不顯示、不取得焦點、沒有 Dock 圖示；Vault 在 run 目錄內；`relaunch()`、`close()` 正常，沒有留下程序。尚未用來驗證任何功能 |
| 其他五項 | 尚未以本 skill 執行；把手取自原始碼與 #75／#82 的 Web 驗收流程。第一次執行時修正本檔與功能檔 |
