# 文件、閱讀與搜尋

文件頁列出 Vault 內的所有文件（YouTube 字幕與 RSS 文章），可依來源篩選、全文搜尋、分頁。點文件進閱讀頁看全文、開原始來源、刪除或重新收集；已刪除的文件開啟時顯示已刪除狀態。

## Sub-features

- `docs-list`：列表、摘要「共 n 份文件」、分頁。
- `docs-filter`：來源選單 `documents-source`（「全部（n）」、各頻道與 feed、已移除的訂閱）。
- `docs-search`：搜尋框，結果與「沒有符合的文件」。
- `docs-search-unavailable`：搜尋引擎不可用時的提示。
- `reader-view`：閱讀頁內文、發布者、原始來源連結。
- `reader-delete`：刪除確認與刪除後的閱讀頁。
- `reader-recollect`：已刪除文件的重新收集。

## How to get to it (user POV)

- 側欄「文件」（`/documents`）。
- 列表點標題，或直接開 `/documents/<id>`（id 如 `youtube:vD000000001`）。

## Driving it with verify

Preconditions:

- 基準狀態加上文件：`subscribe(instance, 'https://www.youtube.com/@verify-a')`、`subscribe(instance, '<feedsOrigin>/feed.xml')`、`collect(instance, 'https://www.youtube.com/watch?v=vD000000001')`，再 `idle(instance)`。得到 A 的 5 支、RSS 4 篇、D 1 支，共 10 份。

- **列表。** `nav-documents`。`documents-summary` 為「共 10 份文件」，`document-list` 含各標題。
- **篩選。** `documents-source` 的選項以 `locator('option').allInnerTexts()` 讀出；`selectOption` 選頻道 A 後列表只剩 A 的 5 支。
- **搜尋。** `documents-search` 填「頻道 A 第 3 集」，等 1 秒以上。列表只含相符文件；填不存在的詞出現 `documents-no-results`。同時以 `GET /api/search?q=…` 對照。
- **閱讀。** 點 A 第 1 集。`reader-body` 含「【合成字幕】」，`reader-publisher` 顯示頻道，`reader-source-link` 指向影片網址。
- **刪除。** `reader-delete` → `confirm-delete-document` 中按「刪除」。閱讀頁顯示 `reader-deleted`；文件從列表與搜尋消失；`vault/settings/deleted-documents.json` 多一筆。
- **重新收集。** 在已刪除的閱讀頁點 `reader-recollect`，完成後 `reader-body` 再次出現。
- **搜尋索引設定。** 設定頁 `settings-search-index` 的 `search-index-state` 顯示索引狀態。

## Gotchas

- 搜尋走 Meilisearch，寫入後有短暫的索引延遲；斷言用 `waitFor` 而不是固定等待。
- `documents-source` 是原生 `<select>`，展開的選單截不到；把選項文字寫進 observations，必要時在頁面加一個標示「驗收註記」的浮層再截圖，截完移除。
- 刪除紀錄會讓後續訂閱檢查略過該影片；之後的 scenario 依賴同一支影片時改用別支。
- `--vault none` 時文件頁顯示 `documents-empty-vault`，不是錯誤。

## Regression flows

沒有已收錄的流程。
