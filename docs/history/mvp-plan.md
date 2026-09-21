# 第一輪 YouTube-only MVP 範圍紀錄

本文件保留第一輪的交付邊界與順序。當前開發依 [Round 2 計畫](../round-2-plan.md) 與 [#24](https://github.com/derektu/xr-collector/issues/24)；例如 Agent 完整操作、背景工作及桌面常駐屬於第二輪，不受下方第一輪只讀／執行期間排程的限制。

## 目標

XR Collector 是可安裝的 macOS／Windows 程式。第一版只處理 YouTube：使用者設定頻道清單，立即或定時收集字幕，在本機保存、瀏覽與搜尋，並讓 Agent 使用同一份資料。Vault 可完整打包、跨機還原及基本比對合併。

工作追蹤與順序以 [GitHub 總覽 #1](https://github.com/derektu/xr-collector/issues/1) 及其子 tickets 為準。

## 每一步可看到的成果

| 順序 | Ticket | 可操作的成果 |
|---|---|---|
| 1 | [#3](https://github.com/derektu/xr-collector/issues/3) | 安裝測試包，貼上影片網址，收集真實字幕並閱讀；重啟後資料仍在 |
| 2 | [#4](https://github.com/derektu/xr-collector/issues/4) | 搜尋字幕、查看結果片段並開啟文件 |
| 3 | [#5](https://github.com/derektu/xr-collector/issues/5) | 管理頻道清單，立即抓取一個頻道或整份清單 |
| 4 | [#6](https://github.com/derektu/xr-collector/issues/6) | 設定週期、暫停排程、查看抓取結果 |
| 5 | [#7](https://github.com/derektu/xr-collector/issues/7) | 外部 Agent 列出、搜尋及讀取已收集的文件 |
| 6 | [#8](https://github.com/derektu/xr-collector/issues/8) | 匯出完整資料包，在另一台電腦還原並 browse／search |
| 7 | [#9](https://github.com/derektu/xr-collector/issues/9) | 合併另一份 vault，相同略過、差異由使用者選擇 |
| 8 | [#10](https://github.com/derektu/xr-collector/issues/10) | macOS／Windows 安裝產物與整條流程驗證 |

## 開發方式

每張 ticket 從使用者操作貫穿 UI、API、保存與必要測試，交付可示範的結果及更新的測試安裝包。第一張即驗證真實字幕取得與安裝包內依賴，不用假資料取代完成條件。完整兩平台交付由最後一張驗收。

只設計當張 ticket 需要的欄位與介面，文件記錄實際行為及必要決策。既有文件格式、儲存及架構草案提供參考，不要求先完成全部規格。抽象化在具體功能產生重複需求時再處理。

沿用 Electron、本機 Web Server／HTTP API、Markdown vault 與 Meilisearch 的方向。UI 與 Agent 共用存取能力；正式內容不只存於搜尋索引。Database 與套件的具體選型隨第一條實際流程驗證，不另立分層設計前置票。

## 第一版界線

- YouTube 內容只收集既有字幕（人工或自動產生）與影片 metadata。這個版本不處理無字幕轉寫；無字幕／無法存取時明確顯示結果，不啟動語音轉文字。
- 頻道可單次抓取，也可按清單定時抓取；首次抓取有範圍限制，避免無意回溯完整頻道歷史。
- 排程在程式執行、電腦醒著時運作。完全退出或休眠不保證執行；恢復後檢查一次，不補跑每個漏過週期。
- Agent 先交付只讀 HTTP API＋Skill；MCP 可後續替代或擴充，不同時做兩套。
- 完整資料包包含必要管理資料及頻道設定，搜尋索引可重建。還原成新 vault 與合併現有 vault 分開操作。
- 合併以穩定身分與內容比對，相同跳過，新內容加入，差異由使用者選擇，異動時間供參考。來源包缺少文件不表示刪除本機文件。
- 不需要同步 server、雲端 revision、Git branch 或自動文字合併。
- 不包含 eval。必要的功能測試、真實來源與 Agent 整合驗證仍須完成。

XQ、RSS、一般網頁、Facebook、Browser／Extension、手動文件、正文編輯／草稿審核、Derived pipeline 與完整 XR 整合均不阻擋此 MVP。後續候選見總覽票，不在開發第一條流程前擴大設計。
