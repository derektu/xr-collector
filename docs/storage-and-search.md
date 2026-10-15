# Vault、資料交換與搜尋

Vault 是正式資料，Meilisearch 是可重建的搜尋投影。本文件描述現行資料責任及恢復邊界；操作步驟見 [README](../README.md)，Round 2 的選址、安全搬移與資料交換目標見 [開發計畫](round-2-plan.md)。

## 保存責任

| 資料 | 位置與交換方式 |
| --- | --- |
| Vault 標記檔 | Vault 根目錄的 `xr-collector-vault.json`；不納入 Vault 資料包 |
| YouTube Markdown | Vault 的 `documents/youtube/` |
| 訂閱、各訂閱的收集設定、發現進度與檢查時間 | Vault 的 `settings/youtube-channels.json` |
| 自動收集總開關 | Vault 的 `settings/youtube-schedule.json` |
| 附件、保留版本、管理檔案 | Vault 的 `attachments/`、`versions/`、`management/`；隨完整資料包交換 |
| Meilisearch database | 裝置上的搜尋資料目錄；不納入 Vault 資料包 |
| profile、Agent 連線檔與 token | 裝置資料；不納入 Vault 資料包 |
| active Vault 選址 | profile 的 `vault-selection.json`；裝置資料 |
| 收集工作與活動記錄 | profile 的 `jobs/jobs.json` 與 `jobs/events/<UTC 日期>.jsonl`（較早版本的 `jobs/events.jsonl` 照常讀取）；活動記錄保留 30 天；裝置資料，不納入 Vault 資料包 |
| 合併 journal 與合併前備份 | Vault 旁的操作資料，供失敗恢復使用 |

現行資料使用 Markdown／JSON 與檔案系統，不以 Git 歷史或同步 server 協調 Vault 寫入。同一個 Vault 只由一個程式寫入，外部同步工具不提供多機並行寫入的一致性保證。

## Vault 目錄與選址

每個 Vault 是自成一體的目錄。根目錄的標記檔記錄 `format`（固定為 `xr-collector-vault`）、`formatVersion`、建立時間與建立程式，不含 ID、路徑或其他裝置資訊，因此整個目錄複製到另一台電腦後仍是同一份有效 Vault。程式只開啟 `formatVersion` 不高於自身支援版本的 Vault，較新的格式明確拒絕，避免舊版誤讀。

開啟前先檢查目錄：有效標記檔與可解析的設定檔構成可開啟的 Vault；不存在（上層目錄存在）或只含 `.DS_Store`、`Thumbs.db` 等系統檔的目錄可以建立新 Vault；其他內容一律視為無法辨識。檢查不改動目錄，建立 Vault 只寫入標記檔。

裝置在 profile 記錄目前使用的 Vault 絕對路徑。啟動時若該路徑不存在、變成空目錄、無法讀取或格式無效，服務停在 Not Ready 並回報原路徑與原因，不建立替代的空 Vault，也不啟動排程。選址成功後才建立搜尋 process 與排程。同步資料夾視為一般本機目錄；檔案尚未下載而無法讀取時同樣回報原因。

## 匯出與還原

`.xr-vault` 是 version 2 JSON 資料包：檔案使用 Base64，檔案內容與清單以 SHA-256 檢查完整性。還原與合併也讀 version 1 資料包。限制為 128 MiB 包大小、80 MiB 解碼內容、10000 個檔案。系統驗證路徑、衝突、checksum、版本及支援的資料格式；checksum 不等於來源簽章。

還原在目前 Vault 旁的 `<vault>.restored/` 下建立獨立 Vault 並寫入新的標記檔，驗證資料及搜尋索引後才切換 active Vault，原 Vault 保留。還原保存訂閱、發現進度與各訂閱的收集設定，但自動收集暫停；再次開啟由使用者操作。切換前失敗保留原資料與選址。Vault 匯出／還原期間，程式阻止衝突寫入。

## 合併與恢復

先預覽，再由使用者逐項決定差異。相同項目跳過、新項目加入、來源缺少的本機項目保留；時間戳不自動決定覆寫。頻道以 ID 比對，名稱、網址、暫停狀態或收集設定不同即列為該訂閱的衝突；發現進度與檢查時間不算差異，採用匯入的訂閱時從合併後起算下一次檢查。自動收集總開關屬於被合併的 Vault，不列入比對。附件與管理檔案以路徑及內容比對。套用前核對預覽是否過期。

### 訂閱設定的格式版本

`youtube-channels.json` version 2 是 `{ "version": 2, "channels": [...] }`，每個訂閱帶 `settings`（`intervalMinutes`、`backfillWindow`、`backfillMaxItems`）、`nextCheckAt` 與 `lastDispatchedAt`；`youtube-schedule.json` version 2 有 `enabled`，轉換過的 Vault 另有 `legacySettings`：轉換時給每個訂閱的共用設定，只供轉換前接受、尚未建立訂閱的新增訂閱工作使用，讓它與同一 Vault 的其他訂閱一致；沒有這個欄位時，這類工作從接受時的首次收集範圍推回補收設定，頻率用預設值。Version 1 的頻道檔是陣列，所有訂閱共用 version 1 排程檔的頻率與補收設定。

Vault 開啟時與資料包解開後，version 1 的頻道檔轉成 version 2：共用設定與檢查時間複製到每個訂閱，共用設定另存為排程檔的 `legacySettings`。是否轉換只看頻道檔版本；頻道檔先寫，排程檔後寫，兩次寫入之間中斷時不會重轉，殘留的 version 1 排程檔只讀總開關。舊版程式讀到 version 2 的頻道檔或資料包時明確拒絕，不會改用共用設定。

有實際異動時，先建立合併前資料包與 journal。套用失敗會復原檔案及搜尋；復原失敗則保留恢復資料、停止寫入與排程，重啟先處理 journal。合併期間文件／搜尋 API 暫時拒絕存取，狀態 API 仍可查詢。備份及 journal 在恢復完成前必須保留。

## 搜尋投影

收集先保存 Markdown，再更新索引。索引失敗不刪除已保存文件；列表與全文可從 Vault 讀取，搜尋依索引狀態回報結果或錯誤。成功合併只對新增／替換文件更新索引；還原使用獨立索引。

索引名稱帶 schema 版本（`documents_v2`）；schema 改變時使用新名稱並從 Vault 全量重建，舊版本的索引在啟動時刪除。每筆索引文件的 key 是完整文件 ID 的 base64url 編碼，不同來源類型即使來源內 ID 相同也不會互相覆寫。來源篩選使用 `sourceType` 與 `publisherId`；頻道名稱只供顯示與搜尋，不作篩選條件。

每筆索引文件帶有其 metadata 與正文的內容雜湊。啟動時逐筆比對索引與 Vault 的文件 ID 及雜湊，集合或任一雜湊不同就從 Vault 全量重建，因此篇數相同但內容或身分不同時也會重建；完全一致時沿用持久化索引。全量重建完成的時間記錄在裝置的搜尋資料旁（`<搜尋資料目錄>-state.json`），供設定頁與 `GET /api/search/status` 顯示。這項比對只在啟動時進行；執行期間的收集逐筆更新索引，刪除文件與待處理異動的一致性由刪除功能另行負責。

Meilisearch 的 dump／snapshot 是引擎運維產物，不是 `.xr-vault`，不作為 Collector 跨機資料交換格式。
