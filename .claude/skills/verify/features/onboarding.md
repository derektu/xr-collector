# 開始使用

還沒有使用中的知識庫，或先前使用的知識庫無法開啟時，App 顯示開始使用畫面：建立新的知識庫、開啟既有知識庫、從匯出檔建立。建立與從匯出檔建立共用名稱＋位置表單，由 App 在位置底下建立名為該名稱的新資料夾。

## Sub-features

- `onboarding-home`：卡片列出三個入口與「AI 助理連線」；視窗比內容高時背景延伸到底部。
- `onboarding-create`：名稱預設 `XR Collector`、位置預設「文件」；預覽「知識庫位置：`<位置>/<名稱>`」，同名項目、空名稱、不能當資料夾名稱的字元時說明原因並停用「建立」；建立後進入 App。
- `onboarding-open`：選到知識庫直接開啟；選到一般資料夾回到首頁，在卡片下方顯示「『<資料夾名稱>』不是 XR Collector 知識庫。」；取消不顯示錯誤。
- `onboarding-missing`：先前使用的知識庫改名或刪除後重開，卡片上方顯示「原知識庫無法開啟」、原因與原路徑。
- `onboarding-from-export`：選擇匯出檔後顯示匯出日期、文件數與訂閱數，名稱預設為匯出時的資料夾名稱；「建立並匯入」後內容與匯出前一致。
- `onboarding-native-pickers`：Desktop 的「選擇位置」「開啟」「選擇檔案」各自開原生選擇器，標題與確認按鈕分別是「選擇位置／選擇位置」「選擇知識庫資料夾／開啟」「選擇匯出檔／選擇」，macOS 顯示 `message`；位置選擇器從目前的位置開始，開啟既有從「文件」開始。

## How to get to it (user POV)

- 第一次開啟 App，或先前使用的知識庫無法開啟時，App 直接顯示這個畫面。
- 「建立」進入建立表單；「開啟」直接開原生資料夾選擇器；「選擇檔案」開原生檔案選擇器，選好後進入從匯出檔建立的表單。

## Driving it with verify

Preconditions: `launchWeb({ vault: 'none' })`。新知識庫的預設位置是 run 目錄的 `documents/`。

- **首頁。** `onboarding-home`、`onboarding-entries`；`onboarding-original-failure` 只在原知識庫無法開啟時出現。
- **建立。** `onboarding-create` → `onboarding-create-form`；`new-vault-name`、`new-vault-location-input`（Web）或 `new-vault-location`＋`new-vault-choose-location`（Desktop）；`new-vault-preview` 顯示將建立的知識庫位置或原因；`onboarding-create-confirm`；`onboarding-back` 回首頁。
- **開啟既有。** Web 模式按 `onboarding-open` 後在 `onboarding-open-path` 輸入完整路徑、按 `onboarding-open-confirm`；錯誤在 `onboarding-error`。
- **原知識庫不見。** 進入 App 後把知識庫資料夾改名，`instance.restart({ page })`。
- **從匯出檔建立。** 先在 App 內匯出（`POST /api/vault/export`）；刪除 profile 的 `vault-selection.json` 後重啟回到開始使用。`onboarding-from-export` → `onboarding-import-form`，`onboarding-package-input` 輸入 zip 路徑、按 `onboarding-package-read`，`onboarding-package-summary` 在檔名下方顯示摘要，`onboarding-import-confirm` 建立並匯入。
- **Desktop 選擇器。** Electron 中以 `stubDialogs(instance.app, { open })` 替換對話框，`globalThis.__dialogCalls` 的 `options` 有 `title`、`buttonLabel`、`message`、`defaultPath`。驗證對話框本身的外觀時不替換，以原生截圖為證據，執行時會跳出視窗。

## Gotchas

- 名稱規則同時套用 macOS 與 Windows 兩邊（不能有 `\ / : * ? " < > |`、Windows 保留名稱等），所以在 Mac 上也不接受 `a:b`。
- 位置下已有同名的空資料夾也算衝突；新知識庫一律是新建立的資料夾。
- 新知識庫不能建在目前的知識庫或程式資料目錄（profile）裡。

## Regression flows

- `onboarding`：斷言 `onboarding-home`、`onboarding-create`、`onboarding-open`、`onboarding-missing`、`onboarding-from-export`（另斷言 vault-transfer 的建立新的知識庫）；首頁三入口、首頁／建立／從匯出檔建立的深淺色背景延伸、三種不能建立的原因、用預設值建立的路徑與既有資料夾不變、改名後重開的提示、開啟一般資料夾的錯誤與開啟改名後的知識庫、從匯出檔建立的摘要、預設名稱、文件與訂閱數一致及搜尋。Web 模式，合成 YouTube；開啟既有以輸入路徑代替原生選擇器，取消選擇只在 Desktop 發生。

## Backlog

- `onboarding-native-pickers`：沒有錄製的 flow（Desktop flow 以 `vault: 'selected'` 啟動，到不了開始使用畫面）；以 `launchElectron({ vault: 'none' })` 搭配 `stubDialogs` 記錄的參數驗證標題、確認按鈕、`message` 與起始位置，選擇器本身的外觀需原生截圖。
