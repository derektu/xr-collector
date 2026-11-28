# 文件格式

本文件描述 `src/domain/vault/markdown-vault.ts` 寫出與讀取的文件檔。共用欄位由它寫入，來源專屬的欄位由各來源類型的 frontmatter codec（plugin 定義的 `frontmatter.write`／`read`）寫入與讀出。

## 身分與保存

每份文件是 UTF-8 Markdown，前方為 YAML frontmatter。檔案位於 `<vault>/documents/<來源類型>/<來源 ID>.md`，文件 ID 為 `<來源類型>:<來源 ID>`。來源 ID 必須符合該類型的格式（`src/domain/vault/document-paths.ts`），不符的檔案不是文件：

| 來源類型 | `type` | 來源 ID |
| --- | --- | --- |
| `youtube` | `Transcript` | 影片 ID（11 個 `[A-Za-z0-9_-]` 字元） |
| `rss` | `Article` | 訂閱 ID 與文章在 feed 中的識別合併後取 SHA-256 的前 16 個十六進位字元；訂閱 ID 是 feed 網址的同一種雜湊 |

收集到已有文件的項目時回傳既有文件，不覆寫內容。被刪除紀錄隱藏的檔案是已刪除的文件，新收集的文件取代它。

| 欄位 | 寫入行為 |
| --- | --- |
| `type` | 該來源類型的文件類型，見上表 |
| `title`、`resource` | 標題與來源 URL。RSS 沒有標題時寫「無標題」；文章沒有連結時 `resource` 是 feed 網址 |
| `tags` | 初始為空陣列 |
| `status` | 文件狀態：`draft`（草稿）或 `published`（正式）。訂閱檢查收集的文件寫該訂閱設定的 `documentStatus`，單篇收集寫請求選的狀態，沒有選時寫 `published`；文件已存在時不改它。沒有這個欄位或值不是這兩者的文件是正式 |
| `collector.id` | 文件 ID |
| `collector.source`、`collector.source_id` | 來源類型與來源 ID |
| `collector.publisher` | 發布者名稱：YouTube 是頻道名稱，RSS 是 feed 標題 |
| `collector.publisher_id` | 有取得時保存：YouTube 是頻道 ID，RSS 是訂閱 ID |
| `collector.published_at` | 有取得發布時間時保存，未知不以收集時間代替 |
| `collector.collected_at` | 收集時間，ISO 8601 |
| `collector.updated_at` | 程式修改文件的時間，例如變更 `status`，ISO 8601；收集時不寫入，沒有這個欄位表示文件自收集後沒有被程式修改 |
| `collector.content_extent` | 保存的內容範圍：`full`，或 `summary`（feed 只提供摘要，畫面顯示「只有摘要」）。YouTube 一律是 `full`，表示保存了完整字幕，不表示收集了字幕以外的內容 |
| `collector.subtitle` | 只有 YouTube：`language_code`、`language_name`（有取得時）與 `kind`（`manual` 或 `automatic`） |
| `collector.source_tags` | 初始為空陣列 |

YouTube 的正文是整理過空白與段落的字幕文字，保留原文，不做摘要或改寫，不含逐句 timestamp。字幕是純文字，寫入時跳脫 Markdown 語法字元（例如 `28\*28`、行首的 `\#`），以 Markdown 呈現時仍顯示原字；列表節錄與搜尋片段會還原這些跳脫。RSS 的正文是文章 HTML 轉成的 Markdown。

## 讀取

reader 接受 `collector.source` 是已登錄的來源類型、且 `type` 等於該類型文件類型的檔案；它不是完整的 schema 驗證器。匯出檔還原另有語意驗證，見 [儲存與搜尋](storage-and-search.md#匯出檔)。

對外的文件是固定欄位投影：`id`、`type`、`sourceType`、`sourceId`、`sourceUrl`、`title`、`publisher`、`publishedAt`、`collectedAt`、`status`，單份讀取另有 `contentExtent` 與正文；codec 讀出的來源專屬資訊放在以來源類型為名的欄位，目前只有 YouTube 的 `youtube`（字幕語言與人工／自動）。沒有 `publisher_id` 的文件以 `publisher.id: null` 呈現。未知的 frontmatter 不透過 API 呈現；讀取不改寫檔案，未知欄位保留在 Vault。

只有檔名是 `documents/<來源類型>/<來源 ID>.md` 的檔案是文件；Vault 資料夾中的其他檔案不屬於知識庫，程式不讀取，也不放進匯出檔。文件檔讀不出這個格式，或 frontmatter 的 ID 與檔名不符時，列表與匯出失敗並指出該檔案。

列表依 `collected_at` 由新到舊排列，同時最多讀取 16 個文件檔，讀檔佔用的記憶體不隨 Vault 大小增加。來源統計依來源類型與 `publisher_id` 計算篇數；發布者名稱取訂閱的名稱，訂閱已移除時取移除紀錄的名稱，都沒有時取該發布者最近收集的文件的 `collector.publisher`；沒有 `publisher_id` 的文件歸為未知發布者。

## 修改

變更狀態只改寫 `status` 與 `collector.updated_at` 兩個值，frontmatter 其他欄位、註解、格式與正文逐位元組保留；欄位不存在時，`status` 加在 `collector` 前一行，`updated_at` 加在 `collected_at` 下一行。其他工具把 frontmatter 寫成 flow 樣式（`{...}`）時，整段 frontmatter 重新序列化，欄位值不變。狀態已相同時不寫檔。

文件的修改時間是 `collector.updated_at`，沒有時是 `collector.collected_at`；匯入合併以它和另一台的修改時間或刪除時間比較，較新的為準。比較內容時忽略這兩個時間與序列化差異，所以兩台各自收集的同一個項目內容相同。在程式以外修改文件不更新這個時間。

文件欄位、來源身分或刪除紀錄的定義與 reader、writer、匯出檔還原及合併一起修改並驗證。
