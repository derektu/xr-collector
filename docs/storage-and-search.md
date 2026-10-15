# Vault、資料交換與搜尋

Vault 是正式資料，Meilisearch 是可重建的搜尋投影。本文件描述現行資料責任及恢復邊界；操作步驟見 [README](../README.md)，Round 2 的選址、安全搬移與資料交換目標見 [開發計畫](round-2-plan.md)。

## 保存責任

| 資料 | 位置與交換方式 |
| --- | --- |
| Vault 標記檔 | Vault 根目錄的 `xr-collector-vault.json`；不納入 Vault 資料包 |
| YouTube Markdown | Vault 的 `documents/youtube/` |
| 頻道、排程設定 | Vault 的 `settings/youtube-channels.json`、`settings/youtube-schedule.json` |
| 附件、保留版本、管理檔案 | Vault 的 `attachments/`、`versions/`、`management/`；隨完整資料包交換 |
| Meilisearch database | 裝置上的搜尋資料目錄；不納入 Vault 資料包 |
| profile、Agent 連線檔與 token | 裝置資料；不納入 Vault 資料包 |
| active Vault 選址 | profile 的 `vault-selection.json`；裝置資料 |
| 合併 journal 與合併前備份 | Vault 旁的操作資料，供失敗恢復使用 |

現行資料使用 Markdown／JSON 與檔案系統，不以 Git 歷史或同步 server 協調 Vault 寫入。同一個 Vault 只由一個程式寫入，外部同步工具不提供多機並行寫入的一致性保證。

## Vault 目錄與選址

每個 Vault 是自成一體的目錄。根目錄的標記檔記錄 `format`（固定為 `xr-collector-vault`）、`formatVersion`、建立時間與建立程式，不含 ID、路徑或其他裝置資訊，因此整個目錄複製到另一台電腦後仍是同一份有效 Vault。程式只開啟 `formatVersion` 不高於自身支援版本的 Vault，較新的格式明確拒絕，避免舊版誤讀。

開啟前先檢查目錄：有效標記檔與可解析的設定檔構成可開啟的 Vault；不存在（上層目錄存在）或只含 `.DS_Store`、`Thumbs.db` 等系統檔的目錄可以建立新 Vault；其他內容一律視為無法辨識。檢查不改動目錄，建立 Vault 只寫入標記檔。

裝置在 profile 記錄目前使用的 Vault 絕對路徑。啟動時若該路徑不存在、變成空目錄、無法讀取或格式無效，服務停在 Not Ready 並回報原路徑與原因，不建立替代的空 Vault，也不啟動排程。選址成功後才建立搜尋 process 與排程。同步資料夾視為一般本機目錄；檔案尚未下載而無法讀取時同樣回報原因。

## 匯出與還原

`.xr-vault` 是 version 1 JSON 資料包：檔案使用 Base64，檔案內容與清單以 SHA-256 檢查完整性。限制為 128 MiB 包大小、80 MiB 解碼內容、10000 個檔案。系統驗證路徑、衝突、checksum、版本及支援的資料格式；checksum 不等於來源簽章。

還原在目前 Vault 旁的 `<vault>.restored/` 下建立獨立 Vault 並寫入新的標記檔，驗證資料及搜尋索引後才切換 active Vault，原 Vault 保留。還原設定保存頻道及週期，但排程暫停；再次啟用由使用者操作。切換前失敗保留原資料與選址。Vault 匯出／還原期間，程式阻止衝突寫入。

## 合併與恢復

先預覽，再由使用者逐項決定差異。相同項目跳過、新項目加入、來源缺少的本機項目保留；時間戳不自動決定覆寫。頻道以 ID 比對，附件與管理檔案以路徑及內容比對。套用前核對預覽是否過期。

有實際異動時，先建立合併前資料包與 journal。套用失敗會復原檔案及搜尋；復原失敗則保留恢復資料、停止寫入與排程，重啟先處理 journal。合併期間文件／搜尋 API 暫時拒絕存取，狀態 API 仍可查詢。備份及 journal 在恢復完成前必須保留。

## 搜尋投影

收集先保存 Markdown，再更新索引。索引失敗不刪除已保存文件；列表與全文可從 Vault 讀取，搜尋依索引狀態回報結果或錯誤。成功合併只對新增／替換文件更新索引；還原使用獨立索引。

目前啟動檢查會以文件數判斷是否重建，不能偵測所有數量相同的內容異動。Round 2 的文件刪除與搜尋一致性須涵蓋索引新鮮度及失敗恢復，不能把現行啟動檢查當作完整同步保證。

Meilisearch 的 dump／snapshot 是引擎運維產物，不是 `.xr-vault`，不作為 Collector 跨機資料交換格式。
