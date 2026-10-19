# 測試入口

`npm run verify` 執行全部 Vitest 案例、JUnit 輸出、產品程式 typecheck 與 Node／Web build。`npm test` 只跑測試，`npm run test:watch` 用於開發。測試檔由 `tests/**/*.test.ts` 收集。

## 按功能分類

| 目錄 | 責任 |
| --- | --- |
| `core` | 文件保存與索引、刪除紀錄與重新收集的互斥及競態、URL、語言、字幕整理 |
| `capture` | yt-dlp 輸出解析、字幕軌道選擇、來源 adapter，以及 YouTube 請求通道（單一連線、隨機等待、冷卻與狀態檔） |
| `sources` | 來源網址辨識 |
| `jobs` | 收集工作的接受、去重、有界派工、持久紀錄、重啟接續與自動重試，以及 YouTube 冷卻期間的等待與接續 |
| `activity` | 活動記錄的日檔與舊檔相容、30 天保留與跨時區日界、cursor 分頁、篩選、遮蔽、寫入失敗、手動重試、工作摘要，以及 Vault 鎖與 Not Ready 時的查詢 |
| `channels` | 訂閱、各訂閱的收集設定與設定檔版本檢查、時間邊界、每次檢查的收集規則（範圍內最新 N 則、不往前補足）、暫停／移除收斂、頻道工作提交與排程；以 `synthetic-youtube.ts` 的合成頻道與可控時鐘驗證 |
| `vault` | 文件格式與文件路徑、zip 匯出檔（manifest、路徑與內容檢查、只打包登記的檔案、刪除紀錄與未知欄位）、匯出到檔案與預設匯出目錄、同步點與三方比對（本機未變更、兩邊都變更、沒有共同同步點、沒有需要匯入、完全取代、同一支影片）、匯入前自動匯出、原地套用的中斷恢復（journal 寫入前、改名進行一半、同步點寫入前）、從匯出檔建立知識庫、資料交換期間的收集暫停、知識庫搬移（目標檢查、逐檔驗證、失敗注入、中斷恢復、清理失敗）、同庫識別與開啟其他知識庫 |
| `search` | 搜尋狀態、索引與真實引擎 |
| `server` | HTTP 契約與 Agent 授權 |
| `runtime` | 共用服務組裝、斷線後完成與生命週期清理 |
| `web` | 畫面使用的狀態／呈現邏輯 |
| `tooling` | 獨立驗證工作區、平台要求與證據彙整 |

分類不代表測試層級：同一功能可能包含單元、HTTP 與檔案系統整合。`web` 的函式測試不是完整畫面 E2E，yt-dlp 的 fixture 測試也不是 YouTube 真實連線驗收。Web 畫面與原生操作的驗證層級依 [開發驗證流程](../docs/development-validation.md#驗證層級)，只在有實際自動化案例時建立 E2E 測試目錄。

## 真實搜尋與平台邊界

`npm run test:meilisearch:mac` 下載 Mac runtime，再執行 search、Agent、匯出入、同步點匯入與搬移五個相關檔案，包含其中的非引擎案例。這些檔案的真實引擎案例目前使用 `resources/bin/mac/meilisearch`，缺少 binary 時會 skip。此命令供 Mac arm64 執行；Windows／Linux 的綠燈不能視為已通過這五項真實引擎驗收。

`tooling` 的工作區建立整合案例只在 Mac／Windows 執行，Linux 另 skip 一項。平台擴充時一起調整 binary 選擇與 skip 規則；先保留真實結果，不以 fixture 冒充另一平台通過。

## Round 2 修改原則

既有案例保護已交付行為。需求變更在對應 ticket 內更新斷言，例如 #22 的 Agent 寫入授權，以及 #18／#27／#28 的派工與恢復；分類整理不先解除這些限制。共用 fixture 只在確實重複時抽取，避免不同案例的前置條件被隱藏。
