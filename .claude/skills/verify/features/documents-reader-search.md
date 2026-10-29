# 文件、閱讀與搜尋

文件頁列出 Vault 內的所有文件（YouTube 字幕與 RSS 文章），可依來源篩選、全文搜尋、分頁。點文件進閱讀頁看全文、開原始來源、刪除或重新收集；已刪除的文件開啟時顯示已刪除狀態。

## Sub-features

- `docs-list`：列表、摘要「共 n 份文件」、每頁 20 份的分頁。
- `docs-filter`：來源選單 `documents-source`（「全部（n）」、各頻道與 feed、已移除的訂閱）。
- `docs-search`：搜尋框，結果與「沒有符合「<搜尋詞>」的文件」。
- `docs-search-normalization`：query 與 title、publisher、body 共用完整 NFKC、ASCII 小寫、簡轉繁／繁體字形與 Unicode 空白正規化；地區用詞不互換。列表、摘要與閱讀頁顯示 Vault 原文，正文命中標記映回原始字元。
- `docs-search-fragments`：COCT 分詞後的每個中文詞或查詢片段，各自在單一欄位連續出現；多個群組採 AND，可分處不同位置或欄位。詞內任意連續片段可召回；引號要求整段正規化文字連同空白、標點連續出現。
- `docs-search-unavailable`：搜尋引擎不可用時的提示。
- `reader-view`：閱讀頁內文、發布者、原始來源連結。
- `reader-delete`：閱讀頁或列表更多動作的刪除確認；確認後回原列表，重新開啟已刪除 ID 才顯示刪除狀態。
- `reader-recollect`：能由 ID 還原來源網址的已刪除文件可重新收集，目前是 YouTube；RSS 不提供此按鈕。

## How to get to it (user POV)

- 側欄「文件」（`/documents`）。
- 列表點標題，或直接開 `/documents/<id>`（id 如 `youtube:vD000000001`）。
- 訂閱詳情的收集文件、記錄中的文件連結也進入閱讀頁；閱讀頁的發布者仍在訂閱時可開啟該訂閱詳情。

## Driving it with verify

Preconditions:

- 基準狀態加上文件：`subscribe(instance, 'https://www.youtube.com/@verify-a')`、`subscribe(instance, '<feedsOrigin>/feed.xml')`、`collect(instance, 'https://www.youtube.com/watch?v=vD000000001')`，再 `idle(instance)`。得到 A 的 5 支、RSS 4 篇、D 1 支，共 10 份。

- **列表。** `nav-documents`。`documents-summary` 為「共 10 份文件」，`document-list` 含各標題。
- **篩選。** `documents-source` 的選項以 `locator('option').allInnerTexts()` 讀出；`selectOption` 選頻道 A 後列表只剩 A 的 5 支。
- **分頁。** 另備至少 21 份同來源文件。`documents-pagination` 的下一頁顯示第 21 份起的文件；URL 保留頁碼、搜尋與來源。第二頁開啟閱讀後按「文件」返回，保留頁碼。改來源或搜尋回第一頁；刪除最後一頁的唯一文件後回退頁碼。
- **搜尋。** `documents-search` 填「頻道 A 第 3 集」，以 `waitFor` 等到搜尋摘要與相符列表，不固定睡一秒。填不存在的詞出現 `documents-no-results`，搜尋框的 × 按鈕（`aria-label`「清除搜尋」）回相同來源的瀏覽列表。同時以 `GET /api/search?q=…` 對照。
- **文字等價與原文。** 執行 `search-normalization`：查台積電／台积电／臺積電、ＡＩ／AI、CoWoS／cowos、００５０／0050，命中同組 ID；50 不等於 0050，服务器不替換為伺服器。純 Unicode 空白回到瀏覽。檢查簡體正文的原文 mark、ﬃ→ffi 的長度映射，並開 Reader 比對簡體、連字與 emoji。
- **詞界與連續片段。** 半導／導體找到半導體，股找到個股，金找到現金流量；觀光不能從直觀與賣光、觀 光、觀、光或分散於不同欄位的觀與光拼成。無空白的「離岸風電」依 COCT 得到多詞 AND，可命中「離岸設備帶動風電」；`"離岸風電"` 則要求字面連續。顯式「半 導」是兩個 AND 群組，與單一片段「半導」不同。`"半導體、個股"` 與 `"半導體 個股"` 的分隔字元須分別符合原文。
- **召回與條件。** 用 21 份同來源「晶片」文件查片段「晶」，UI 依來源篩選後兩頁為 20＋1，ID 不重複、total 為 21；另以 API 單獨驗日期排除。逐題從 run-private UI 取得 Agent 連線資料，對照授權 Agent 的完整回應，重啟後重新取得連線資料。
- **閱讀。** 點 A 第 1 集。`reader-body` 含「【合成字幕】」，`reader-publisher` 顯示頻道，`reader-source-link` 指向影片網址。
- **刪除。** `reader-delete` → `confirm-delete-document`，先取消確認仍可閱讀，再按「刪除」。畫面返回原入口，文件從列表與搜尋消失，`vault/settings/deleted-documents.json` 多一筆。重新開啟同一 ID 才顯示 `reader-deleted`。列表每列的 `document-more` →「刪除」也有相同確認。
- **重新收集。** 重新開啟已刪除的 YouTube ID，點 `reader-recollect`，完成後 `reader-body` 再次出現。已刪除 RSS ID 不提供此按鈕。
- **搜尋索引設定。** 設定頁 `settings-search-index` 的 `search-index-state` 顯示索引狀態；背景收集新增文件後，「已索引 N 份／知識庫 M 份」會隨既有收集狀態訊號重新讀取，不必離開頁面。
- **重建索引。** 設定頁按「重建索引」，等 `search-index-state` 回到「就緒」；與 `GET /api/search/status` 的 `status` 物件比對，索引筆數應等於 Vault 文件數，Vault 文件內容不變。索引與 Vault 篇數不同時，卡片提示可以重建。
- **搜尋不可用。** 搜尋 API 回 `search_unavailable` 時，`search-unavailable` 提示保留搜尋字串，下方退回相同來源的 Vault 瀏覽列表，仍可閱讀；「前往設定」開啟索引設定。路由 stub 可證明此 UI 分支，回報須明說未造成真實引擎故障。

## Gotchas

- 搜尋走 Meilisearch，寫入後有短暫的索引延遲；斷言用 `waitFor` 而不是固定等待。
- 中文精簡引擎需外置 `resources/search/coct-main.txt` 與其 manifest。詞庫、引擎及 query 策略列入投影身分；詞庫異動後重啟需重建，缺檔／壞 hash／格式不得宣稱 ready。UI 流程不修改共用詞庫；資源替換與啟動失敗使用獨立 profile／資源副本驗證。
- 正文摘要才有 mark；只命中標題或發布者時，可顯示未標記的正文摘要。完整詞優先的固定案例不能當成所有查詢的相關性保證：合格的 Meili 結果在前，片段補回結果依當次投影順序接續。完整重建後同級片段的相對順序可能改變；記錄重建前後順序，另驗重啟沿用投影的順序。Latin typo／prefix 沿用 Meili，中文不加名稱錯字或公司別名擴張。
- `page-documents` 出現只代表已切回頁面；截取刪除後的列表前，等摘要與來源選單的文件數完成更新，避免把載入中的畫面當成完成證據。
- `documents-source` 是原生 `<select>`，展開的選單截不到；把選項文字寫進 observations，必要時在頁面加一個標示「驗收註記」的浮層再截圖，截完移除。
- 刪除紀錄會讓後續訂閱檢查略過該影片；之後的 scenario 依賴同一支影片時改用別支。
- `--vault none` 是尚未選 Vault 的 onboarding；已就緒但零文件的 Vault 才顯示 `documents-empty-vault`，內有 `add-document-empty` 新增入口。
- 磁碟刪除紀錄以 `sourceType` 與 `sourceId` 辨識文件，不直接儲存 UI 的完整文件 ID。

## Regression flows

- `core-journey`：斷言 `docs-list`、`docs-filter`、`docs-search`、`reader-view`、`reader-delete`。6 份文件的列表、頻道 A 篩選、搜尋無結果與命中（畫面、API、標示），從結果閱讀（內文、發布者連結、原始來源），閱讀頁刪除先取消再確認，API、Vault、索引只少這一份且刪除紀錄有它。
- `subscription-remove`：斷言 `docs-filter`、`reader-view`。移除訂閱並保留文件後，來源選單為「<標題>・已移除（n）」，篩選列出全部文件，閱讀頁可讀且發布者不再是連結。
- `feature-navigation`：斷言 `docs-search` 的設定入口，從畫面重建索引後回到就緒，Vault 文件內容不變。
- `documents-reader-search`：斷言 `docs-list`、`docs-filter`、`docs-search`、`reader-delete`、`reader-recollect`。以 22 份合成文件驗列表與第二頁、來源篩選；從搜尋結果刪除後回文件頁並保留搜尋詞，直接開已刪文件網址顯示已刪除狀態，核對 Vault、API、索引與刪除紀錄，從畫面重新收集並在重啟後再次搜尋。
- `workspace-content`：斷言 `docs-list`、`docs-filter`、`docs-search`、`docs-search-unavailable`、`reader-view`、`reader-delete`、`reader-recollect`。22 篇來源跨頁、搜尋命中／清除／空結果、閱讀返回保留分頁、已刪除 RSS 不提供重新收集、最後一頁刪除回退，以及明示為 UI fixture 的搜尋不可用分支；COUNTS-1、COUNTS-2 另比對搜尋狀態 API、實際索引與設定頁搜尋卡在背景收集後的 3／3、5／5。
- `search-normalization`：斷言 `docs-search-normalization`、`docs-search-fragments`、`docs-list`、`docs-filter`、`docs-search`、`reader-view`。NORM-1～4 用五份 RSS 文件驗等價文字、純空白 browse、地區詞、原文摘要、片段與重啟；NORM-5～7 擴充至 34 份，驗散字／空白／標點／跨欄位負例、COCT 多詞 AND 與引號、Latin typo／prefix、固定完整詞優先案例、Reader 原文、來源／日期／20＋1 分頁、授權 Agent 完整回應，以及畫面重建與重啟後 Vault／結果不變。均為 Mac Web 合成資料；不代表兩平台封裝資源、換詞庫或壞資源啟動驗收。

## Backlog

- `reader-view`：從訂閱詳情與記錄進入閱讀頁的入口，以及發布者連結實際點回訂閱詳情。
- `docs-search`：搜尋索引筆數與知識庫不一致（已索引 N 份／知識庫 M 份）時的提示。
- `docs-search-normalization`：外置詞庫的載入、替換與壞資源，整理成使用資源副本的參數化 smoke；詞庫格式、hash 與正規化已有 `tests/search/`，不放進一般文件流程。
