# 訂閱與檢查

使用者在訂閱頁訂閱 YouTube 頻道，訂閱立即列出並依序經過「排隊中」「更新中 n/N」，完成後顯示「下次 HH:MM」。可手動檢查全部、暫停、關閉自動檢查、移除（保留或一併刪除文件），並在訂閱詳情頁看設定與收集紀錄。

## Sub-features

- `sub-add`：「新增訂閱」→「YouTube 頻道」→ 貼頻道網址 →「訂閱」。
- `sub-status`：狀態欄的排隊中、更新中 n/N、下次 HH:MM、已暫停、自動檢查已關閉、冷卻中的排隊。
- `sub-check`：「檢查全部」立即送出檢查。
- `sub-pause`：列上的暫停按鈕。
- `sub-auto`：自動檢查開關。
- `sub-remove`：列的「更多動作」→「移除」，預設保留文件，可選一併刪除。
- `sub-detail`：點訂閱名稱進詳情頁，顯示新增時間、下次檢查、收集設定與紀錄。
- `sub-failure`：列出影片失敗時的狀態與工作頁失敗項目。

## How to get to it (user POV)

- 側欄「訂閱」（`/`）→ 右上「新增訂閱」。
- 文件頁「新增」→「網址」貼頻道網址，按「改為訂閱」。
- 訂閱頁每列：名稱連到 `/sources/youtube/<id>`，右側暫停按鈕與「更多動作」選單。

## Driving it with verify

Preconditions:

- 基準狀態。頻道 A：`https://www.youtube.com/@verify-a`；B：`@verify-b`。

- **訂閱。** `getByTestId('nav-sources')` → `add-subscription` → `add-item-youtube-channel`，`add-url` 填頻道網址，等 `add-confirm` 為「訂閱」且 enabled 後點擊。對話框關閉，留在 `page-sources`。
- **狀態變化。** 輪詢 `[data-testid^="pending-row-"], [data-testid="source-row-<channelId>"]` 內的 `subscription-status`，記錄每個不同的值。預期經過「排隊中」或「更新中 k/5」，最後符合 `^下次 \d\d:\d\d$`。側欄底部 `background-status` 在更新中出現，完成後消失。
- **排在別的訂閱後。** A 更新中時訂閱 B，B 顯示「排隊中」。
- **冷卻。** `instance.updateCatalog(c => { c.youtube.rateLimitNext = true; })`，等 `GET /api/pacing` 的 `youtube` 群組 `state === 'cooldown'`；更新中的訂閱轉為「排隊中」，冷卻 30 秒後完成。
- **暫停。** `getByRole('button', { name: '暫停 <頻道標題>' })`，狀態變「已暫停」。
- **自動檢查。** `getByTestId('auto-collection-switch').click({ force: true })`；未暫停的列顯示「自動檢查已關閉」，已暫停的維持「已暫停」。再點一次恢復「下次 HH:MM」。
- **移除並保留。** `getByRole('button', { name: '<頻道標題> 的更多動作' })` → `getByRole('menuitem', { name: '移除' })`。`confirm-remove` 中 `remove-keep` 預設勾選；點 `confirm-remove-button`。列消失，`GET /api/documents` 仍有該頻道的文件；文件頁 `documents-source` 選項顯示「<標題>・已移除（n）」。
- **移除並刪除。** 同上但勾 `remove-delete`。文件從列表與搜尋消失，記錄頁 `activity-log` 有「已移除「<標題>」，並刪除 n 份文件。」，`vault/settings/deleted-documents.json` 有 n 筆該頻道的紀錄。
- **詳情。** `getByRole('link', { name: /<標題>/ })` → `source-detail`。內容含「新增時間」「下次檢查」（`detail-next-check`）；`detail-settings` 改設定後 `apply-settings`，出現 `settings-saved`。
- **列出失敗。** `updateCatalog(c => { c.youtube.failListing = '<channelId>'; })` 後按 `check-all`，工作頁「失敗」區出現該檢查。

## Gotchas

- 剛送出的訂閱先以 `pending-row-<jobId>` 出現，解析完頻道才變成 `source-row-<channelId>`；選取時兩者都要涵蓋。
- 合成頻道每次列出等 200 ms、每支影片收集等 `captureDelayMs`（預設 600 ms），想拍到「更新中」就調大 `captureDelayMs`。
- 冷卻期間互動式請求（訂閱預覽）立即失敗，新增訂閱的對話框會顯示錯誤；這是產品行為。
- `auto-collection-switch` 是視覺上覆蓋的 checkbox，點擊要 `force: true`。
- 新增 toast（`notice`）會擋住下一個動作，等 `notice` 數量為 0 再繼續。
