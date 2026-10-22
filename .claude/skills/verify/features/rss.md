# RSS

使用者訂閱 RSS 2.0／RDF／Atom feed，或貼一個網頁讓 App 找出頁面宣告的 feed。訂閱後收進最新的文章，文章以 Markdown 存進 Vault，與 YouTube 字幕一起出現在文件頁、閱讀頁與搜尋。

## Sub-features

- `rss-add-feed`：「新增訂閱」→「RSS」→ 貼 feed 網址 →「訂閱」。
- `rss-add-page`：貼網頁網址，辨識頁面 `<link rel="alternate">` 宣告的 feed。
- `rss-atom`：Atom feed。
- `rss-articles`：文章收進文件頁，閱讀頁顯示轉好的 Markdown（標題、段落、連結）。
- `rss-check`：feed 新增文章後，檢查只收新文章。
- `rss-failure`：404、5xx、逾時與非 feed 內容的錯誤與工作頁失敗。
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
- **失敗。** `updateCatalog(c => { c.feeds['/feed.xml'].status = 503; })` 後 `check-all`；工作頁或訂閱狀態顯示失敗，`activity-log` 有對應紀錄。`status: 404` 對應找不到 feed。
- **副作用。** `vault/settings/rss-subscriptions.json` 有該訂閱；Vault 內每篇文章一份 `.md`。

## Gotchas

- RSS plugin 有自己的請求通道與 10 分鐘 feed 快取；同一 feed 在快取期內再檢查不會重新抓。驗證「新文章」時若沒有變化，先確認是否被快取擋住。
- 合成 feed 的 port 隨 slot 變動，不要把 7253 寫死在流程裡。
- RSS 擁有所有 http(s) 網址，無法辨識成其他類型的網址都會落到 RSS；貼一般網頁看到「找不到 feed」是正常結果。
- 真實 feed（`REAL.feed`）的文章數與內容會變，smoke 只斷言「至少收進一篇」。
