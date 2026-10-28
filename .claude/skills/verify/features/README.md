# XR Collector 功能地圖

驗證使用者看得到的行為時，以這個目錄為依據。先讀本頁，再照對應的功能檔操作。功能檔列出的每個入口都是驗證範圍；只走其中一個方便的入口，不算驗證了整個功能。

| 功能 | 檔案 | 主要層級 | 已收錄流程 |
| --- | --- | --- | --- |
| 收集單支影片 | [collect-video.md](collect-video.md) | Web；開啟原始影片需 Electron | `workspace-content` |
| 訂閱與檢查 | [subscriptions.md](subscriptions.md) | Web | `subscribe-a-b`、`offline-recover`、`subscription-failures`、`check-history-summary`、`youtube-cooldown`、`feature-navigation` |
| 記錄 | [activity.md](activity.md) | Web | `check-history-summary`、`feature-navigation` |
| 工作頁 | [jobs.md](jobs.md) | Web | `subscribe-a-b`、`youtube-cooldown`、`workspace-content` |
| 文件、閱讀與搜尋 | [documents-reader-search.md](documents-reader-search.md) | Web | `documents-reader-search`、`workspace-content`、`feature-navigation`、`search-normalization` |
| RSS | [rss.md](rss.md) | Web | `rss-rate-limit`、`workspace-content`、`feature-navigation` |
| Vault 匯出、匯入與搬移 | [vault-transfer.md](vault-transfer.md) | Web；原生對話框需 Electron | `vault-transfer`、`vault-actions`、`workspace-content` |
| 選單列／系統匣 | [tray.md](tray.md) | 原生 Desktop（視窗會顯示） | `tray`、`notification-clicks` |
| 訂閱自動暫停通知 | [notifications.md](notifications.md) | Web＋原生 Desktop | `notifications`、`notification-clicks` |
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

2026-10-26，以 main `aaf07ca4ab21c04be413bd56d24e5852fb72c5d6` 逐份核對 11 份功能檔，並由協調者實際操作。涵蓋 #85／#44 的連線導引、#34 建置資訊、#149 設定計數刷新與 #119 驗收工具變更。維護只修正本 skill 的文件與流程，未修改產品程式。

| 功能 | 本次執行與範圍 |
| --- | --- |
| 收集單支影片 | `workspace-content` 的空 Vault／一般新增入口、訂閱入口切換、字幕閱讀與失敗處理；未重驗原生開啟外部來源 |
| 訂閱與檢查 | 實際新增頻道 A、詳情及暫停恢復；`feature-navigation` 補空清單入口、名稱無結果、類型篩選與「立即檢查」文案；未重跑全部冷卻／離線分支 |
| 記錄 | 摘要、完整事件與 DEBUG／INFO 切換；`feature-navigation` 補工作限定網址、清除篩選與診斷複製 payload；未重跑完整群組分頁流程 |
| 工作頁 | `workspace-content` 的單篇失敗重試與移除；503 feed 檢查在「進行中」等待重試；原生選單可導覽工作頁 |
| 文件、閱讀與搜尋 | `workspace-content` 的 22 篇分頁、來源篩選、搜尋、閱讀返回、刪除與重新收集、搜尋不可用 UI fixture；另驗重建索引保持 Vault 文件不變 |
| RSS | `workspace-content` 的網頁辨識、文章閱讀與設定持久化；503 重試、恢復後完成；未重跑 429／自動暫停流程 |
| Vault 匯出匯入與搬移 | 設定頁背景計數 0 → 3 → 5；實際匯出及同包無變更匯入，ZIP 不含 Agent 設定、連線資料不變；未重跑整套搬移／合併／取代及原生對話框 |
| 選單列／系統匣 | Mac 原生開發版背景模式的選單模型、自動檢查切換、工作／記錄導覽、關窗後授權 Agent 可達、第二次啟動沿用 runtime 與正常退出；未驗實體圖示、視窗顯示／聚焦及 Windows |
| 建置資訊 | Onboarding／設定／授權 Agent 的同一 buildId；503 UI fixture 後點重試恢復；收錄 `build-info` W3。本次未重建或重驗安裝版身分 |
| 登入自啟 | Web `login-startup` 的真開發版拒絕與受控 fixture 分支；未操作 OS 登入項目，真實登入仍需 VM 與確認時段 |
| AI 助理連線 | Onboarding 完整面板、Settings 精簡卡、helper、真 ZIP、複製 payload、port pending 與金鑰重設。Web 複製使用 stub，不宣稱真 OS 剪貼簿或獨立 Agent 安裝已在本輪重驗 |

初輪兩個 scratch 檢查因誤讀 `paused` 欄位與搜尋回應外層而失敗，修正驗證腳本後分別補驗通過；目視另發現摘要截圖太早、仍在讀取，收錄流程改為等事件載入後再截。原始證據保留，不算產品修復。可重跑的補驗收錄為 `feature-navigation` 與 `build-info` W3。平台前景與登入項目案例的前置條件仍以各功能檔為準。

本機證據、來源核對筆記及實際受測版本位於 `.local/ticket-artifacts/verify-maintenance-85-44/`；以交付 PR 的結果與版本記錄為準。
