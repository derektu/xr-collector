# 現行 YouTube 文件格式

本文件描述 `src/vault/markdown-vault.ts` 寫出的格式，供第一輪資料相容及 Round 2 遷移使用。多來源契約的目標見 [Round 2 計畫](round-2-plan.md#51-文件與來源契約)；此格式不代表一般 OKF 文件均可匯入。

## 身分與保存

每份文件是 UTF-8 Markdown，前方為 YAML frontmatter。檔案位於 `<vault>/documents/youtube/<video-id>.md`，文件 ID 為 `youtube:<video-id>`。相同 video ID 的收集回傳既有文件，不覆寫內容。

| 欄位 | 寫入行為 |
| --- | --- |
| `type` | `Transcript` |
| `title`、`resource` | 影片標題與來源 URL |
| `tags` | 初始為空陣列 |
| `collector.id` | `youtube:<video-id>` |
| `collector.source`、`collector.source_id` | `youtube` 與 video ID |
| `collector.publisher` | 頻道名稱 |
| `collector.publisher_id` | 有取得頻道 ID 時保存 |
| `collector.published_at` | 有取得發布時間時保存，未知不以收集時間代替 |
| `collector.collected_at` | 收集時間，ISO 8601 |
| `collector.content_extent` | `full`，表示所保存的字幕內容；不表示影片有任何字幕以外的內容被收集 |
| `collector.subtitle.language_code` | 字幕語言 |
| `collector.subtitle.language_name` | 有取得時保存 |
| `collector.subtitle.kind` | `manual` 或 `automatic` |
| `collector.source_tags` | 初始為空陣列 |

正文是整理過空白與段落的字幕文字，保留原文，不做摘要或改寫，不含逐句 timestamp。來源 URL 放在 frontmatter。字幕是純文字，寫入時跳脫 Markdown 語法字元（例如 `28\*28`、行首的 `\#`），以 Markdown 呈現時仍顯示原字；列表節錄與搜尋片段會還原這些跳脫。

## 讀取與相容性

現行 reader 接受 `Transcript`／`youtube` 格式；它不是完整 schema 驗證器。資料包還原有額外語意驗證，不能因檔案可解析 YAML 就宣稱可安全還原。對外的文件是固定欄位投影：來源無關的 `id`、`sourceType`、`sourceId`、`sourceUrl`、`title`、`publisher`、`publishedAt`、`collectedAt`，以及 YouTube 專屬的 `youtube`（字幕語言與人工／自動）。未知 frontmatter 不透過 API 呈現；讀取不改寫檔案，未知欄位保留在 Vault。沒有 `publisher_id` 的文件以 `publisher.id: null` 呈現。

合併比對完整 frontmatter 與正文；收集／異動時間及序列化差異不單獨形成內容衝突。合併沒有提供一般正文編輯、草稿或垃圾桶生命週期。

Vault 也可攜帶 `attachments/`、`versions/` 與 `management/` 檔案；這不代表程式已實作附件編輯器、版本瀏覽器或 Derived pipeline。完整資料包責任見 [儲存與搜尋](storage-and-search.md)。

Round 2 改動文件欄位、來源身分或刪除紀錄時，須同步定義第一輪文件的讀取與遷移行為，並驗證資料包還原及合併；不得只更換新文件的 writer。
