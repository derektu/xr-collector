# RSS

使用者訂閱 RSS 2.0／RDF／Atom feed，或貼一個網頁讓 App 找出頁面宣告的 feed。訂閱後收進最新的文章，文章以 Markdown 存進 Vault，與 YouTube 字幕一起出現在文件頁、閱讀頁與搜尋。

## Sub-features

- `rss-add-feed`：「新增訂閱」→「RSS」→ 貼 feed 網址 →「訂閱」。
- `rss-add-page`：貼網頁網址，辨識頁面 `<link rel="alternate">` 宣告的 feed。
- `rss-atom`：Atom feed。
- `rss-articles`：文章收進文件頁，閱讀頁顯示轉好的 Markdown（標題、段落、連結）。
- `rss-check`：feed 新增文章後，檢查只收新文章。
- `rss-failure`：讀取失敗的處理。5xx 與連線錯誤是網路錯誤，已開始的檢查留在工作頁「進行中」等待重試；404、410、429 與非 feed 內容讓這次檢查失敗、等到下次檢查再試，錯誤記在記錄頁，並計入該訂閱的連續失敗。429 只影響回 429 的那個訂閱，RSS 沒有共用冷卻。
- `rss-settings`：訂閱詳情頁的 RSS 收集設定。

## How to get to it (user POV)

- 訂閱頁「新增訂閱」→「RSS」。
- 文件頁「新增」→「網址」貼 feed 網址時，提示改為訂閱。

## Driving it with verify

Preconditions:

- 基準狀態。feed 網址取 `launch` 輸出的 `synthetic.feeds`，例如 `http://127.0.0.1:7253/feed.xml`（port 依 slot 而定，流程中用 `instance.feedsOrigin`）。

- **訂閱 feed。** `nav-sources` → `add-subscription` → `add-item-rss-feed`，`add-url` 填 `<feedsOrigin>/feed.xml`。等 `add-confirm` 為「訂閱」且 enabled 後點擊。訂閱頁出現「【合成】RSS 部落格」列，狀態最後為「下次 HH:MM」。
- **文章。** 文件頁出現「【合成】RSS 部落格 第 1–4 篇」。開第 1 篇：`reader-body` 含「【合成文章】」與「小節」標題。
- **從網頁辨識。** 新增 RSS 對話框填 `<feedsOrigin>/blog`，辨識結果指向 `/feed.xml`。
- **Atom。** 訂閱 `<feedsOrigin>/atom.xml`，收進 3 篇。
- **新文章。** `updateCatalog(c => { c.feeds['/feed.xml'].articles.unshift({ title: '【合成】RSS 部落格 新文章', guid: 'verify-new', link: 'https://example.com/new', publishedAt: new Date().toISOString(), content: '<p>新文章</p>' }); })`，再按 `check-all`。只多收這一篇。
- **網路錯誤。** `updateCatalog(c => { c.feeds['/feed.xml'].status = 503; })` 後 `check-all`。已開始的檢查在工作頁「進行中」等待重試，狀態為「錯誤・HH:MM 重試」，網路原因另列在狀態下方；訂閱列也顯示重試時間。把 `status` 拿掉後，到重試時間會完成。
- **找不到 feed。** `status: 404` 是 `feed_not_found`，這次檢查失敗且計入連續失敗，工作不留在排隊中或失敗區。訂閱列顯示紅色「錯誤（連續 n 次）・HH:MM 重試」，記錄文字含「發生錯誤：找不到這個 feed。」。
- **網站限制連線。** 訂閱 `/feed.xml` 與 `/atom.xml`，`updateCatalog(c => { c.feeds['/feed.xml'].status = 429; })` 後按 `/feed.xml` 列的立即檢查。檢查立刻失敗，列為紅色「錯誤（連續 1 次）・HH:MM 重試」；詳情頁紅條「最近一次檢查失敗（連續 1 次）：這個網站暫時限制連線。」，收集紀錄「發生錯誤：網站限制連線」。接著檢查 `/atom.xml` 照常完成，`GET /api/pacing` 的 `rss` 群組不會進入 `cooldown`。
- **設定。** RSS 詳情的 `detail-settings-intervalMinutes`、`detail-settings-backfillDays`、`detail-settings-backfillMaxItems` 編輯後，等待 `settings-saved` 且 API 讀回新值，再刷新確認三個值及 Vault 設定都保留。
- **副作用。** `vault/settings/rss-subscriptions.json` 有該訂閱；Vault 內每篇文章一份 `.md`。

## Gotchas

- RSS plugin 有自己的請求通道。10 分鐘的 feed 快取（`FEED_CACHE_MS`）只用在擷取單篇文章時，訂閱檢查每次都重新讀 feed，所以新文章在下一次檢查就會出現。
- 訂閱階段 feed 回 5xx 時，辨識結果是 `unavailable`，對話框沒有「訂閱」動作；要測讀取失敗，先完成訂閱再注入錯誤。
- 網路錯誤拿掉後，到重試時間才會完成，合成 feed 約需 30 秒；API 已經沒有工作時，訂閱列可能還短暫顯示「排隊中」，斷言畫面用 `waitFor`。
- 合成 feed 的 port 隨 slot 變動，不要把 7253 寫死在流程裡。
- RSS 擁有所有 http(s) 網址，無法辨識成其他類型的網址都會落到 RSS；貼一般網頁看到「找不到 feed」是正常結果。
- 真實 feed（`REAL.feed`）的文章數與內容會變，smoke 只斷言「至少收進一篇」。

## Regression flows

- `feature-navigation`：斷言 `rss-failure`。503 後已開始的檢查在工作頁「進行中」等待重試，恢復 feed 後完成。
- `rss-rate-limit`：斷言 `rss-add-feed`、`rss-atom`、`rss-check`、`rss-failure`。一個 feed 回 429：該列的連續失敗與紅色、檢查工作失敗、詳情頁紅條與收集紀錄、另一個 feed 的檢查照常完成並收進新文章、RSS 請求通道從未冷卻、記錄沒有 RSS 的限流事件；第 5 次失敗自動暫停；恢復後歸零並檢查一次。
- `workspace-content`：斷言 `rss-add-feed`、`rss-add-page`、`rss-articles`、`rss-settings`。從畫面辨識網頁宣告的 feed、訂閱與閱讀，修改收集設定後比對刷新及 Vault 資料。
