# 收集單支影片

使用者在文件頁貼上一支 YouTube 影片網址並按「加入」，對話框立即關閉，收集在背景進行；完成後影片成為一般文件，出現在文件列表，可開啟閱讀頁，Vault 內多一份 Markdown。

## Sub-features

- `collect-add`：文件頁「新增」→「網址」→ 貼影片網址 →「加入」。
- `collect-mismatch`：在訂閱對話框貼影片網址，提示「這是單支影片，要改為加入一次嗎？」，按「改為加入」切換。
- `collect-done`：完成後出現在文件列表，訂閱頁不出現「單篇收集」列。
- `collect-read`：閱讀頁顯示字幕，「開啟原始影片」連到原網址。
- `collect-fail`：影片無法收集時，工作頁「失敗」區出現該工作（見 [jobs.md](jobs.md)）。

## How to get to it (user POV)

- 文件頁右上「新增」→「網址」。
- 訂閱頁「新增訂閱」→「YouTube 頻道」，貼影片網址後按「改為加入」。

## Driving it with verify

Preconditions:

- 基準狀態。影片用頻道 D：`https://www.youtube.com/watch?v=vD000000001`。
- 可直接執行 [examples/collect-video.mjs](../examples/collect-video.mjs)，它涵蓋 `collect-add`、`collect-done`、`collect-read`。

- **開對話框。** `page.getByTestId('add-document').click()`，再 `getByTestId('add-item-url').click()`。`add-dialog` 出現，標題 `add-dialog-title` 為「加入網址」，焦點在 `add-url`。
- **貼網址。** `getByTestId('add-url').fill(<影片網址>)`。等 `add-confirm` 文字為「加入」且 enabled。
- **加入。** 點 `add-confirm`。`add-dialog` detached，仍在 `page-documents`，沒有 `notice` 提示，列表沒有進行中項目。
- **完成。** 等 `document-list` 出現影片標題（合成約 1 秒）。
- **閱讀。** 點列表中的標題。`reader-body` 含「【合成字幕】」；`reader-source-link` 的 href 含影片 ID。
- **副作用。** run 目錄 `vault/` 下有一份含影片 ID 的 `.md`；`GET /api/documents` 有這份文件。
- **改為加入。** 訂閱頁 `add-subscription` → `add-item-youtube-channel`，貼影片網址。`add-mismatch` 顯示「這是單支影片，要改為加入一次嗎？」，`add-confirm` disabled；點 `add-switch` 後標題變「加入網址」、網址保留、`add-confirm` 為「加入」。

## Gotchas

- 合成影片 ID 必須是 11 字元，否則網址辨識為不支援。新增影片時沿用 `channel()` 的格式。
- 同一支影片已收集時，再加入會去重；需要新文件就換影片 ID。
- 「開啟原始影片」在 Web 模式是一般連結；驗證它交給系統瀏覽器、App 視窗不跳走，需要 Electron 加 `recordOpenExternal(app)`。
- 真實影片（`--data real`）受 YouTube 限流影響，失敗會出現在工作頁，不是 harness 問題；`resources/bin/mac/yt-dlp/yt-dlp` 必須是資料夾版（`npm run download:runtime`）。

## Regression flows

沒有已收錄的流程。
