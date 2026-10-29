# 外觀主題

使用者在設定頁「外觀」選「跟隨系統」「深色」或「淺色」，整個 App 立即換成對應主題（深色是 duskblue、淺色是 silverblue）；選擇保存下來，重新整理或重新啟動後沿用。預設是跟隨系統。

## Sub-features

- `appearance-theme`：設定頁 `settings-appearance` 的「主題」單選群組：「跟隨系統」「深色」「淺色」三個 `role="radio"` 按鈕，選中的 `aria-checked="true"`；方向鍵、Home、End 在三者間切換並移動焦點，Tab 只停在選中的那一個。
- `appearance-persist`：選擇保存：Web 存在瀏覽器的 `localStorage`（`xr-collector.theme`），Desktop 經 preload bridge 存在裝置的 `userData/appearance.json`；重新整理或重啟後沿用，跟隨系統時隨作業系統外觀改變。

## How to get to it (user POV)

- 側欄「設定」（`/settings`）→「外觀」，在「關於 XR Collector」卡片之前。

## Driving it with verify

Preconditions:

- 基準狀態。`openPage` 預設以深色的 `colorScheme` 開頁，跟隨系統時顯示深色。

- **切換主題。** `getByTestId('settings-appearance').getByRole('radio', { name: '淺色' })` 點擊；該按鈕 `aria-checked` 為 `true`，App 根元素（`.shell`）的 `data-theme` 為 `silverblue`。選「深色」為 `duskblue`。
- **鍵盤。** 焦點在選中的按鈕上按 `ArrowRight`／`ArrowLeft`／`Home`／`End`，選中項目與焦點一起移動。
- **保存。** 選「淺色」後 `page.reload()`，仍是淺色、`data-theme` 為 `silverblue`；`localStorage.getItem('xr-collector.theme')` 為 `light`。
- **跟隨系統。** 選「跟隨系統」後以 `page.emulateMedia({ colorScheme: 'light' | 'dark' })` 改變瀏覽器外觀，`data-theme` 跟著變。

## Gotchas

- Web 與 Desktop 的保存位置不同：Web 的結果不代表 Desktop 的偏好檔已寫入，Desktop 持久性要用 Electron 背景模式驗。
- 截圖的深淺色由主題決定；`themed()` 切的是瀏覽器外觀，只在「跟隨系統」時影響 App。

## Regression flows

沒有已收錄的流程。

## Backlog

- `appearance-theme`：一個簡短的 Web 操作：切換深色／淺色並比對 `aria-checked` 與 `data-theme`，鍵盤操作一次。主題解析與鍵盤索引已有 `tests/web/app-shell.test.ts`。
- `appearance-persist`：Web 重新整理後保留；跟隨系統隨瀏覽器外觀改變；Desktop 偏好檔的保存歸平台專項，讀寫規則已有 `tests/electron/theme-preference.test.ts`。
