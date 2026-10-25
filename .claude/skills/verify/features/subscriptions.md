# 訂閱與檢查

使用者在訂閱頁訂閱 YouTube 頻道，訂閱立即列出並依序經過「排隊中」「檢查中」「下載中 k/n」，完成後顯示「下次 HH:MM」；檢查開始後不再回到排隊中。可手動檢查全部、暫停、關閉自動檢查、移除（保留或一併刪除文件），並在訂閱詳情頁看設定與收集紀錄。

## Sub-features

- `sub-add`：「新增訂閱」→「YouTube 頻道」→ 貼頻道網址 →「訂閱」。
- `sub-status`：狀態欄的排隊中、檢查中、下載中 k/n、錯誤・HH:MM 重試、下次 HH:MM、錯誤（連續 n 次）・HH:MM 重試、已暫停、已暫停・連續失敗 n 次、自動檢查已關閉，以及文件欄的份數。
- `sub-check`：「檢查全部」立即送出檢查。
- `sub-pause`：列上的暫停按鈕。
- `sub-auto`：自動檢查開關。
- `sub-remove`：列的「更多動作」→「移除」，預設保留文件，可選一併刪除。
- `sub-detail`：點訂閱名稱進詳情頁，顯示新增時間、下次檢查、收集設定與紀錄。
- `sub-failure`：列出影片失敗的檢查：檢查內重試時列為「錯誤・HH:MM 重試」，失敗後列為紅色「錯誤（連續 n 次）・HH:MM 重試」，詳情頁紅條「最近一次檢查失敗（連續 n 次）：<原因>」；失敗的檢查不進工作頁失敗區。連續失敗 5 次且第一次失敗滿 24 小時自動暫停：列為紅色「已暫停・連續失敗 5 次」，詳情頁紅條「連續失敗 5 次，<時間> 自動暫停：<原因>」；按「恢復」歸零並立即檢查。
- `sub-offline`：沒有網路時頁面上方的「目前沒有網路，恢復後自動檢查。（HH:MM 確認）」，「新增訂閱」、文件頁「新增」、工作頁「重試」停用，「立即檢查」保持可按並在仍沒有網路時顯示「目前沒有網路，恢復後再試。」；恢復後訊息消失、到期訂閱檢查一次。

## How to get to it (user POV)

- 側欄「訂閱」（`/`）→ 右上「新增訂閱」。
- 文件頁「新增」→「網址」貼頻道網址，按「改為訂閱」。
- 訂閱頁每列：名稱連到 `/sources/youtube/<id>`，右側暫停按鈕與「更多動作」選單。

## Driving it with verify

Preconditions:

- 基準狀態。頻道 A：`https://www.youtube.com/@verify-a`；B：`@verify-b`。

- **訂閱。** `getByTestId('nav-sources')` → `add-subscription` → `add-item-youtube-channel`，`add-url` 填頻道網址，等 `add-confirm` 為「訂閱」且 enabled 後點擊。對話框關閉，留在 `page-sources`。
- **狀態變化。** 記錄 `source-row-<channelId>` 內 `subscription-status` 每個不同的值（頁內 MutationObserver，見 `flows/lib/watch.mjs`）。預期依序為「排隊中 → 檢查中 → 下載中 0/5 … 4/5 → 下次 HH:MM」，可省略排隊中與檢查中（檢查中只持續約 200 ms，取樣不一定拍到）；開始後不再回到排隊中，k 只增不減。完成後列的文件欄為 5。
- **兩個訂閱同時收集。** A 下載中時訂閱 B：B 開始前顯示「排隊中」，開始後為「檢查中」「下載中 k/3」，兩者輪流擷取時都維持下載中，不回到排隊中。
- **冷卻。** `instance.updateCatalog(c => { c.youtube.rateLimitNext = true; })`，等 `GET /api/pacing` 的 `youtube` 群組 `state === 'cooldown'`；下載中的訂閱轉為「錯誤・HH:MM 重試」（時間是冷卻結束），還沒開始的檢查維持「排隊中」；冷卻 30 秒後自動繼續並完成。
- **暫停。** `getByRole('button', { name: '暫停 <頻道標題>' })`，狀態變「已暫停」。
- **自動檢查。** `getByTestId('auto-collection-switch').click({ force: true })`；未暫停的列顯示「自動檢查已關閉」，已暫停的維持「已暫停」。再點一次恢復「下次 HH:MM」。
- **移除並保留。** `getByRole('button', { name: '<頻道標題> 的更多動作' })` → `getByRole('menuitem', { name: '移除' })`。`confirm-remove` 中 `remove-keep` 預設勾選；點 `confirm-remove-button`。列消失，`GET /api/documents` 仍有該頻道的文件；文件頁 `documents-source` 選項顯示「<標題>・已移除（n）」。
- **移除並刪除。** 同上但勾 `remove-delete`。文件從列表與搜尋消失，記錄頁 `activity-log` 有「已移除「<標題>」，並刪除 n 份文件。」，`vault/settings/deleted-documents.json` 有 n 筆該頻道的紀錄。
- **詳情。** `getByRole('link', { name: /<標題>/ })` → `source-detail`。內容含「新增時間」「下次檢查」（`detail-next-check`）。`detail-settings` 內檢查頻率是下拉 `detail-settings-intervalMinutes`，選了立即儲存；時間範圍與數量上限是數字輸入框 `detail-settings-backfillDays`、`detail-settings-backfillMaxItems`，停止輸入約 0.6 秒後儲存。儲存後出現 `settings-saved`。不合法的值（超出 1–60 天、1–100 則或不是整數）在欄位下方顯示 `detail-settings-<key>-error`，輸入框 `aria-invalid`，不儲存，`apply-settings`（「套用到所有」）停用。新增訂閱卡片的欄位相同，前綴是 `add-settings-`，不合法時 `add-confirm` 停用。
- **收集紀錄。** 詳情中的單次檢查是 `collection-check`；連續定時無新內容或網路錯誤達兩次時是 `collection-check-group`，顯示結果、次數與起訖。例如「完成檢查：沒有新影片・12 次」「發生錯誤：網路錯誤・2 次」。恢復後的一次檢查獨立列出，不加「1 次」。合併列「查看細節」進入 [記錄的群組細節](activity.md)，「返回」回到同一訂閱。現有的 `detail-status`／`detail-problem` 仍獨立反映目前狀態。
- **檢查時間。** 訂閱清單頁尾 `check-times` 顯示上次與下次檢查及所屬訂閱；完成後比對上次檢查對應的訂閱名稱與 `lastCheckedAt`，不要把最靠近的文件新增時間當成檢查完成時間。
- **斷網與恢復。** `updateCatalog(c => { c.network = 'offline'; })` 讓合成 YouTube、feed 與 runtime 的網路確認都連不上。下一個連網的收集請求失敗後，`offline-banner` 出現，`GET /api/health` 的 `connectivity.state` 為 `offline`；`add-subscription`、`add-document`、`job-retry` disabled，title 為「沒有網路時無法使用」，`check-all` 仍可按，按下後 `notice` 為「目前沒有網路，恢復後再試。」。改回 `c.network = 'online'` 後 2 秒內確認成功，訊息消失，記錄有一筆 `collection.resumed`（`pauseReason: offline`），到期的訂閱各檢查一次。
- **列出失敗。** `updateCatalog(c => { c.youtube.failListing = '<channelId>'; })` 後從該列「更多動作」→「立即檢查」。列出以 `network_error` 失敗，檢查內重試 3 次（間隔 30 秒、2 分鐘），約 2.5 分鐘後檢查失敗：列為「錯誤（連續 1 次）・HH:MM 重試」，`GET /api/subscriptions` 該筆 `checkFailures.count` 為 1，`lastCheckedAt` 等於失敗工作的 `finishedAt`；工作頁失敗區沒有它。
- **自動暫停。** 不必等 24 小時：改 Vault 的 `settings/youtube-channels.json` 中該頻道的 `checkFailures`（`count: 4`、`since` 為 25 小時前），再讓一次檢查失敗，列變為「已暫停・連續失敗 5 次」，記錄有 `subscription.auto_paused`。詳情頁 `detail-toggle`（恢復）清除 `checkFailures` 與 `autoPausedAt` 並立即檢查。

## Gotchas

- 剛送出的訂閱先以 `pending-row-<jobId>` 出現，解析完頻道才變成 `source-row-<channelId>`；選取時兩者都要涵蓋。
- 合成頻道每次列出等 200 ms、每支影片收集等 `captureDelayMs`（預設 600 ms），想拍到「下載中」就調大 `captureDelayMs`（`subscribe-a-b` 用 1500 ms）。
- 冷卻期間互動式請求（訂閱預覽）立即失敗，新增訂閱的對話框會顯示錯誤；這是產品行為。
- `auto-collection-switch` 是視覺上覆蓋的 checkbox，點擊要 `force: true`。
- 新增 toast（`notice`）會擋住下一個動作，等 `notice` 數量為 0 再繼續。
- 斷網只在收集請求連不上時才被發現：沒有工作在跑時設 `network: 'offline'` 不會出現訊息，要有工作連網（或按「立即檢查」）才會確認。合成模式離線時每 2 秒確認一次，正式版是 30 秒。
- 讓訂閱在流程中到期：改 Vault 的 `settings/youtube-channels.json` 中該頻道的 `nextCheckAt`，服務每次讀檔，不必重啟。

## Regression flows

- `check-history-summary`：斷言 `sub-detail`、`sub-failure`。同一訂閱的定時無新內容、網路錯誤與恢復分組，詳情顯示次數與細節入口，現有錯誤狀態不被摘要取代。
- `offline-recover`：斷言 `sub-status`、`sub-check`、`sub-offline`。A 下載中、B 在斷網期間到期：訊息與停用的按鈕、立即檢查被拒絕、斷網期間沒有派工、失敗與重試、列上從未出現「錯誤」；恢復後訊息消失、定時派工一次、B 一個檢查、A 文件數正確。
- `subscription-failures`：斷言 `sub-status`、`sub-failure`。A 的列出失敗：重試期間與失敗後的列文字與顏色、API 的連續失敗次數、詳情頁紅條、「上次檢查」與收集紀錄最新一筆檢查一致、失敗的檢查不在工作頁失敗區；第 5 次失敗自動暫停（列、Vault 檔、API、事件、詳情頁）；恢復後歸零並檢查一次。
- `youtube-cooldown`：斷言 `sub-status`。A 下載中時 YouTube 限流：通道冷卻、A 的列與 API 為等冷卻結束的重試、影片帶冷卻的等待且嘗試次數未用掉、冷卻期間送出的單支影片排隊等待；冷卻結束後自動完成，限流、延後與冷卻結束的事件各一次，沒有重試與失敗。
- `subscribe-a-b`：斷言 `sub-add`、`sub-status`。經畫面訂閱 A，A 下載中時訂閱 B；A、B 的狀態序列、完成後的文件數，以及 Vault、API 與索引的文件一一對應。不斷言 pending-row、頁尾的上次檢查與失敗的檢查。
