# XR Collector 功能地圖

驗證使用者看得到的行為時，以這個目錄為依據。先讀本頁，再照對應的功能檔操作。功能檔列出的每個入口都是驗證範圍；只走其中一個方便的入口，不算驗證了整個功能。

| 功能 | 檔案 | 主要層級 | 已收錄流程 |
| --- | --- | --- | --- |
| 收集單支影片 | [collect-video.md](collect-video.md) | Web；開啟原始影片需 Electron | `workspace-content` |
| 訂閱與檢查 | [subscriptions.md](subscriptions.md) | Web | `subscribe-a-b`、`offline-recover`、`subscription-failures`、`check-history-summary`、`youtube-cooldown` |
| 記錄 | [activity.md](activity.md) | Web | `check-history-summary` |
| 工作頁 | [jobs.md](jobs.md) | Web | `subscribe-a-b`、`youtube-cooldown`、`workspace-content` |
| 文件、閱讀與搜尋 | [documents-reader-search.md](documents-reader-search.md) | Web | `workspace-content` |
| RSS | [rss.md](rss.md) | Web | `rss-rate-limit`、`workspace-content` |
| Vault 匯出、匯入與搬移 | [vault-transfer.md](vault-transfer.md) | Web；原生對話框需 Electron | `vault-transfer` |
| 選單列／系統匣 | [tray.md](tray.md) | 原生 Desktop（視窗會顯示） | `tray` |
| 建置資訊 | [build-info.md](build-info.md) | Web；安裝身分需 packaged Desktop | `build-info` |
| 登入電腦時自動啟動 | [login-startup.md](login-startup.md) | Web 負向；打包安裝版 VM | `login-startup` |
| AI 助理連線 | [agent-connection.md](agent-connection.md) | Web；固定埠原生啟動另驗 | `agent-connection` |

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

## 最近一次維護覆核

2026-10-25，以 main `6e068506a4ea9e02c63f1201b8d0b23544536959`（已含 #33／PR #146、#96／PR #147）逐份核對九份功能檔，並重新操作。表中只列本次實際範圍，未沿用合併前的執行結果。

| 功能 | 本次執行與範圍 |
| --- | --- |
| 收集單支影片 | `workspace-content` 的兩個加入入口、閱讀、失敗；原生開發版另驗空文件入口與原始來源交接 |
| 訂閱與檢查 | `subscribe-a-b`、`check-history-summary`；狀態序列、文件數、連續空檢查／網路錯誤與恢復 |
| 記錄 | `check-history-summary`；摘要、INFO／DEBUG、篩選與模式保留、群組細節與分頁 |
| 工作頁 | `subscribe-a-b`、`workspace-content`；分區、徽章、單篇重試與移除 |
| 文件、閱讀與搜尋 | `workspace-content`；22 篇跨頁、來源篩選、搜尋、刪除與返回、重新收集、搜尋不可用 UI fixture |
| RSS | `rss-rate-limit`、`workspace-content`；網頁辨識、文章閱讀、設定持久化、429 隔離、暫停與恢復 |
| Vault 匯出匯入與搬移 | `vault-transfer`；匯出、合併、取代、搬移、切換、取消等待與固定位置；Web 模式 |
| 選單列／系統匣 | Mac 原生開發版 `tray` D1～D8；手動再次啟動的 runtime instanceId 不變。Windows 本次未重跑 |
| 登入自啟 | Web `login-startup` 的不可設定及受控平台分支、Mac 原生開發版兩個 listener 拒絕。已安裝 App 的真實 OS 註冊／登入需 VM 與確認時段，本次未驗 |

本機完整證據、各次失敗與修正後重跑放在 `.local/ticket-artifacts/verify-maintenance-96-33/`；以交付 PR 的結果與版本記錄為準。
