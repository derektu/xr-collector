# 工作頁

工作頁列出收集與訂閱檢查的工作，分「進行中」「排隊中」「失敗」三區；沒有工作時顯示「沒有進行中的工作」。失敗的工作可重試或移除，側欄的工作徽章顯示待處理數。

## Sub-features

- `jobs-empty`：沒有工作時的空狀態。
- `jobs-sections`：進行中、排隊中（有順序）、失敗三區與各區數量。
- `jobs-retry`：失敗工作的重試。
- `jobs-dismiss`：移除失敗工作。
- `jobs-badge`：側欄徽章。
- `jobs-row-text`：每列的標題、副標與等待文字。

## How to get to it (user POV)

- 側欄「工作」（`/jobs`）。
- 側欄徽章出現時，點「工作」進入。

## Driving it with verify

Preconditions:

- 基準狀態。製造失敗：`instance.updateCatalog(c => { c.youtube.failVideo = 'vD000000003'; })`。
- 拍「進行中／排隊中」需要慢一點的收集：`updateCatalog(c => { c.youtube.captureDelayMs = 4000; })`。

- **空狀態。** `getByTestId('nav-jobs').click()`。`page-jobs` 內有 `jobs-empty`，文字「沒有進行中的工作」。
- **進行中與排隊中。** 經畫面訂閱頻道 A（見 [subscriptions.md](subscriptions.md)），立刻切到工作頁。`jobs-running` 有一列，`jobs-queued` 的列依序編號；每列為 `job-<jobId>`。截圖。
- **失敗。** 經文件頁加入 `https://www.youtube.com/watch?v=vD000000003`。工作頁 `jobs-failed` 出現該工作，側欄 `jobs-badge` 出現。
- **重試。** 先把 `failVideo` 改回 `null`，再點該列的 `job-retry`。工作離開失敗區，文件頁出現 D 第 3 集。
- **移除。** 再造一個失敗後點 `job-dismiss`。列消失，`GET /api/jobs/overview` 的 `failed` 不含它，徽章更新。

## Gotchas

- 三區只在有內容時渲染（`jobs-<id>` 不存在不代表錯誤）；斷言前先等工作狀態，或以 `GET /api/jobs/overview` 對照。
- 合成收集很快，不調慢 `captureDelayMs` 很難拍到進行中。
- 重試前沒把注入的失敗拿掉，重試會再次失敗；這是驗證步驟的錯誤，不是產品問題。
- 失敗原因的用字由 plugin 分類決定（`tests/plugins/youtube/failures.test.ts`），截圖只核對畫面呈現。
