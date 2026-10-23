# Vault 匯出、匯入與搬移

設定頁的知識庫區塊顯示 Vault 位置與數量，提供匯出成 zip、從 zip 匯入（合併或完全取代）、把 Vault 搬到新資料夾，以及開啟其他知識庫。Desktop 用原生對話框選檔案與資料夾；Web 模式在對話框內輸入完整路徑。

## Sub-features

- `vault-info`：`settings-vault` 的 `vault-path` 與 `vault-counts`。
- `vault-export`：匯出 zip，檔案已存在時選擇取代或保留。
- `vault-import-merge`：預覽差異後以較新為準合併。
- `vault-import-replace`：完全取代，含二次確認。
- `vault-import-nothing`：沒有需要匯入的內容。
- `vault-move`：檢查目標、搬移、完成後的新路徑。
- `vault-open-other`：開啟另一個既有的知識庫。
- `vault-fixed`：`--vault fixed` 時搬移與開啟其他顯示無法使用。

## How to get to it (user POV)

- 側欄「設定」（`/settings`）→ 知識庫區塊：「搬移…」「開啟其他…」「匯出…」「匯入…」。
- Desktop：按鈕開啟原生儲存／開啟／選資料夾對話框。

## Driving it with verify

Preconditions:

- 基準狀態加上幾份文件（見 [documents-reader-search.md](documents-reader-search.md)）。
- 匯入合併需要另一個 Vault 的匯出檔：在同一流程再 `launchWeb({ issue })` 一個 instance（會拿另一個 slot），在那邊收不同的影片後匯出，把 zip 路徑交給第一個 instance。
- 所有路徑都放在 run 目錄內，例如 `path.join(instance.runDir, 'exports', 'a.zip')`、`path.join(instance.runDir, 'moved-vault')`。

- **資訊。** `nav-settings` → `settings-vault`。`vault-path` 是 run 目錄內的 `vault`，`vault-counts` 與文件數一致。
- **匯出。** `vault-export` → `export-dialog`，`export-path` 預填 `<runDir>/documents/XR Collector 匯出/…zip`；改成 run 目錄內的路徑後點 `export-confirm`。出現 `export-result-path`，檔案存在且是 zip。同路徑再匯出一次出現 `export-exists`，`export-replace`／`export-keep` 各驗一次。
- **匯入合併。** `vault-import` → `import-path` 填另一個 instance 的 zip → `import-next`。`import-preview` 與 `import-counts` 顯示新增／更新數；`import-mode-merge` → `import-confirm` → `import-done`。文件頁多出另一邊的文件；`<runDir>/documents/XR Collector 備份/` 多一份匯入前備份。
- **完全取代。** 同上選 `import-mode-replace`，`import-replace-confirm` 顯示將移除的數量（`import-replace-counts`），按 `import-replace-confirm-button`。文件只剩匯入檔的內容。
- **沒有需要匯入。** 匯入自己剛匯出的 zip，出現 `import-nothing`。
- **搬移。** `vault-move` → `move-dialog`，`move-target` 填 `<runDir>/moved-vault`。等 `move-facts` 顯示檢查結果（`move-check-problem` 不出現）後點 `move-confirm`，完成出現 `move-result-path`。`vault-path` 變成新路徑；舊資料夾不再有文件；`GET /api/vault/status` 的 `vaultPath` 一致；文件頁與搜尋照常。
- **開啟其他。** `vault-open-other` → `open-vault-path` 填另一個既有 Vault 的路徑 → `open-vault-next` → `open-vault-confirm`，`open-vault-result-path` 出現，文件頁換成那個 Vault 的內容。
- **固定位置。** `launch --vault fixed`，設定頁出現 `vault-relocation-unavailable`，「搬移…」「開啟其他…」disabled。
- **Desktop 對話框。** Electron 中 `stubDialogs(desktop.app, { save: <zip 路徑>, open: <zip 或資料夾> })` 後按同樣的按鈕；`globalThis.__dialogCalls` 記錄對話框參數，流程直接進入執行階段。

## Gotchas

- 預設的 `selected` Vault 才能搬移；`fixed` 是刻意的限制，不是 bug。
- 搬移或匯入進行中，收集暫停；同時跑訂閱檢查的 scenario 會看到暫停狀態。
- 搬移目標必須不存在或是空資料夾；指向 run 目錄外會把資料留在受測範圍之外，`stop` 不會清掉。
- Web 模式沒有 `xrCollectorDesktop` bridge，「在 Finder 顯示」類按鈕（`export-reveal`、`vault-reveal`）只在 Desktop 驗證。
- 兩個 instance 同時跑會占兩個 slot；結束時兩個都要 stop。

## Regression flows

沒有已收錄的流程。
