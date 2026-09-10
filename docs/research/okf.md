# OKF：文件格式、版本與去重邊界

研究日期：2026-09-09。官方 OKF **v0.2**，固定 repository commit：`8cf3abaf1ee3d53a12f981cc0ed83d6ffec775e1`。本文是 #2 的研究筆記與討論提案，不是已確認的 Collector 格式規格。

## 官方格式

OKF 使用 UTF-8 Markdown + YAML frontmatter；它統一基本結構與 metadata 語意，正文仍然自由。主要規則如下。[SPEC §4](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/8cf3abaf1ee3d53a12f981cc0ed83d6ffec775e1/okf/SPEC.md#4-concept-documents)

| 項目 | 官方規則 |
|---|---|
| 必填 | 一般 concept 只有 `type` 永遠必填；部分選用結構另有條件必填欄位 |
| 建議 metadata | `title`、`description`、`resource`、`tags` |
| 正文 | 沒有必填章節；建議用標題、清單、表格等結構 |
| Extensions | 可加自訂欄位；consumer 不可因未知欄位拒收，往返讀寫應保留未知欄位 |
| Tags | 短字串清單；沒有來源／使用者歸屬結構 |

Concept ID 是 bundle 內檔案路徑去掉 `.md`；`resource` 識別文件描述的底層資源，兩者不同。`sources` 記錄取材，entry 必填 `resource`，選用 `id` 可作正文引用鍵。[SPEC §2](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/8cf3abaf1ee3d53a12f981cc0ed83d6ffec775e1/okf/SPEC.md#2-terminology)、[§5.1](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/8cf3abaf1ee3d53a12f981cc0ed83d6ffec775e1/okf/SPEC.md#51-provenance-sources)

`status` 是 `draft`／`stable`／`deprecated`，省略視為 `stable`。`deprecated` 表示保留但已非現行內容，**不是垃圾桶**。`verified` 表示對照來源確認內容，**不是入庫核准**。[SPEC §5](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/8cf3abaf1ee3d53a12f981cc0ed83d6ffec775e1/okf/SPEC.md#5-provenance-trust-and-lifecycle)

`log.md` 是日期分組的文字變更紀錄；它沒有要求保存正文快照，因此不能單靠 log 復原。規範推薦 Git 提供歷史與差異；沒有定義新聞跨來源去重演算法。[SPEC §3](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/8cf3abaf1ee3d53a12f981cc0ed83d6ffec775e1/okf/SPEC.md#3-bundle-structure)、[§9](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/8cf3abaf1ee3d53a12f981cc0ed83d6ffec775e1/okf/SPEC.md#9-log-files)

## 官方實作的驗證範圍

官方 Python `OKFDocument.parse()` 解析 YAML mapping 與正文；`validate()` 僅檢查 `type` 是否有值，沒有完整檢查欄位型別、status 列舉或正文結構。因此不能把這個 validator 視為 Collector 所需的完整 schema 驗證。此次未全面審查 repository 其他工具，亦不主張全庫沒有 schema。[document.py](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/8cf3abaf1ee3d53a12f981cc0ed83d6ffec775e1/okf/src/reference_agent/bundle/document.py)

## Collector 討論提案

以下是產品推論，不是 OKF 要求：

- 可借用 OKF 的 metadata＋正文分工，另外定義 Collector 必填資訊、型別、日期格式與驗證規則。UI／Agent 讀結構化 metadata，不依賴正文標題擷取系統欄位；Markdown 的彈性不必延伸成 metadata 無契約。
- 若文件搬移仍需維持識別，Collector 要有自己的穩定 ID；不能直接把 OKF 路徑當成這項保證。來源 ID、來源 URL 與 Collector ID 分開。
- XQ 結構化標記保留來源 ID／類型，使用者 tags 另有歸屬；不為符合字串 tags 而丟棄來源資訊。
- 使用者已確認可以修改正文並保留擷取版本供復原。擷取內容與目前編輯內容需能分別定位；版本相同時可共用儲存。復原政策、歷史保留量與實體儲存方式仍待設計。
- 入庫、垃圾桶、刪除後避免自動匯回是 Collector 工作流程，不能直接套成 `verified`／`deprecated`。

去重建議先分清三種判斷：

| 情境 | 可承諾的起點 |
|---|---|
| 同來源 ID／可靠文章 URL 再次加入 | 回到既有文件；內容改變則辨識為來源新版，保留使用者修改 |
| 不同入口取得相同正文 | 正文指紋提供重複候選；仍保留各來源與取得紀錄，避免摘要被當全文合併 |
| 同事件、轉載改寫、近似內容 | 提示可能相關或重複，由使用者判斷；不自動刪除或宣稱全面識別 |

指紋應根據擷取版本，避免使用者編輯破壞後續比對。URL 正規化與文字正規化皆需明定邊界；「同一事件」不等於「同一文件」。第一版能否自動合併跨来源同文，仍是待確認決策。
