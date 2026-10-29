# Vault 匯出、匯入與搬移

設定頁的知識庫區塊顯示 Vault 位置與數量，提供匯出成 zip、從 zip 匯入（合併或完全取代）、把 Vault 搬到新資料夾，以及開啟其他知識庫。Desktop 用原生對話框選檔案與資料夾；Web 模式在對話框內輸入完整路徑。

## Sub-features

- `vault-info`：`settings-vault` 的 `vault-path` 與 `vault-counts`。
- `vault-actions`：一般寬度單排；左側「開啟其他知識庫…」及桌面版 Finder／檔案總管入口，右側「搬移…」「匯入…」「匯出…」。窄視窗可換行，鍵盤順序與畫面一致。
- `vault-native-dialogs`：Desktop 顯示資料夾、匯入開啟檔案與匯出儲存檔案的原生入口。
- `vault-export`：匯出 zip，檔案已存在時選擇取代或保留。
- `vault-import-merge`：預覽差異後以較新為準合併。
- `vault-import-replace`：完全取代，含二次確認。
- `vault-import-nothing`：沒有需要匯入的內容。
- `vault-move`：檢查目標、搬移、完成後的新路徑。
- `vault-open-other`：開啟另一個既有的知識庫。
- `vault-fixed`：`--vault fixed` 時搬移與開啟其他顯示無法使用。

## How to get to it (user POV)

- 側欄「設定」（`/settings`）→ 知識庫區塊：「開啟其他知識庫…」「搬移…」「匯入…」「匯出…」。
- Desktop：按鈕開啟原生儲存／開啟／選資料夾對話框。

## Driving it with verify

Preconditions:

- 基準狀態加上幾份文件（見 [documents-reader-search.md](documents-reader-search.md)）。
- 匯入合併需要另一個 Vault 的匯出檔：在同一流程再 `launchWeb({ issue })` 一個 instance（會拿另一個 slot），在那邊收不同的影片後匯出，把 zip 路徑交給第一個 instance。
- 所有路徑都放在 run 目錄內，例如 `path.join(instance.runDir, 'exports', 'a.zip')`、`path.join(instance.runDir, 'moved-vault')`。

- **資訊。** `nav-settings` → `settings-vault`。`vault-path` 是目前選用的 Vault，初始為 run 目錄內的 `vault`；`vault-counts` 與文件數一致。保持設定頁開啟，再以背景收集增加文件，知識庫數量與搜尋卡應跟著更新，不必離開頁面；`workspace-content` 的 COUNTS-1／2 比對 0 → 3 → 5。
- **匯出。** `vault-export` → `export-dialog`，`export-path` 預填 `<runDir>/documents/XR Collector 匯出/…zip`；改成 run 目錄內的路徑後點 `export-confirm`。出現 `export-result-path`，檔案存在且是 zip。同路徑再匯出一次出現 `export-exists`，`export-replace`／`export-keep` 各驗一次。
- **匯入合併。** `vault-import` → `import-path` 填另一個 instance 的 zip → `import-compare`。`import-preview` 與 `import-counts` 顯示新增／更新數；`import-mode-merge` → `import-confirm` → `import-done`。文件頁多出另一邊的文件；`<runDir>/documents/XR Collector 備份/` 多一份匯入前備份。
- **完全取代。** 同上選 `import-mode-replace`，再按 `import-next`。`import-replace-confirm` 顯示將移除的數量（`import-replace-counts`），按 `import-replace-confirm-button`。文件只剩匯入檔的內容。
- **沒有需要匯入。** 匯入自己剛匯出的 zip，出現 `import-nothing`。
- **搬移。** `vault-move` → `move-dialog`，`move-target` 填 `<runDir>/moved-vault`。等 `move-facts` 顯示檢查結果（`move-check-problem` 不出現）後點 `move-confirm`，完成出現 `move-result-path`。`vault-path` 變成新路徑；舊資料夾不再有文件；`GET /api/vault/status` 的 `vaultPath` 一致；文件頁與搜尋照常。
- **開啟其他。** `vault-open-other` → `open-vault-path` 填另一個既有 Vault 的路徑 → `open-vault-next` → `open-vault-confirm`，`open-vault-result-path` 出現，文件頁換成那個 Vault 的內容。
- **固定位置。** `launch --vault fixed`，設定頁出現 `vault-relocation-unavailable`，「搬移…」「開啟其他知識庫…」disabled。
- **等待與取消。** 以慢速收集製造進行中的工作，再開始匯入比對。等待時 `transfer-cancel` 可取消並立即釋放鎖，回到可重新比對的輸入階段；工作頁、原始活動與摘要 API 仍可讀。再比對並完成後，確認收集繼續。
- **Desktop 對話框。** Electron 中 `stubDialogs(instance.app, { save: <zip 路徑>, open: <zip 或資料夾> })` 後按同樣的按鈕；`globalThis.__dialogCalls` 記錄對話框參數，流程直接進入執行階段。

## Gotchas

- 預設的 `selected` Vault 才能搬移；`fixed` 是刻意的限制，不是 bug。
- 匯出、匯入比對／套用、搬移與切換都取得操作鎖並暫停派工；已開始的收集步驟先完成。比對完成會釋放鎖，收集可能改變基準；套用前若基準已改變，取消預覽並重新比對。
- 匯出只帶知識庫文件、訂閱、排程與刪除紀錄。登入自啟、Agent port 與金鑰屬於裝置 profile，不隨 zip 搬到另一台電腦；匯入、搬移及切換 Vault 也不替換此 profile 的 Agent 連線設定。
- 搬移目標必須不存在或是空資料夾；指向 run 目錄外會把資料留在受測範圍之外，`stop` 不會清掉。
- Web 模式沒有 `xrCollectorDesktop` bridge，「在 Finder 顯示」類按鈕（`export-reveal`、`vault-reveal`）只在 Desktop 驗證。
- 兩個 instance 同時跑會占兩個 slot；結束時兩個都要 stop。

## Regression flows

- `vault-actions`：斷言 `vault-actions`、`vault-native-dialogs`；Desktop 的單排及窄視窗幾何斷言、DOM 順序、Finder／檔案總管路徑與匯入／匯出原生對話框呼叫。shell 與對話框回應使用替身，不代表 OS 畫面已開啟。

- `vault-transfer`：`vault-info`、`vault-actions`、`vault-export`、`vault-import-merge`、`vault-import-replace`、`vault-import-nothing`、`vault-move`、`vault-open-other`、`vault-fixed`；串接匯出同名檔、雙庫合併與取代、搬移後搜尋、切換 Vault、收集中匯入比對、取消等待後再比對、等待時的工作頁及原始／摘要 API 可讀，以及固定位置限制。Web 模式，合成 YouTube；不涵蓋原生對話框。
- `workspace-content`：斷言 `vault-info`。COUNTS-1、COUNTS-2 留在設定頁進行兩次背景 RSS 收集，以文件 API、Vault 檔案、搜尋狀態 API 與實際索引獨立確認 0 → 3 → 5，並檢查知識庫及搜尋卡各自在對應 API 就緒後 6 秒內更新，離開再返回仍為 5。

## Backlog

- `vault-import-merge`：預覽的筆數與同 ID 更新後的確切文件內容，不只比對筆數。
- `vault-native-dialogs`：原生選檔／選資料夾的參數、取消沒有副作用與完成結果，以 Desktop 控制驗證；reveal 路徑與對話框種類已有斷言，不驗 Finder 與對話框外觀。
