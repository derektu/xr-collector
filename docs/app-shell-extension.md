# App Shell 擴充點

App Shell 負責側欄的頂層頁面（訂閱、文件、工作、記錄，設定獨立放在側欄底部）、側欄上的工作數量徽章與共用的畫面元件；收集、文件、Vault、工作、搜尋與記錄的行為不屬於 Shell。新增頁面、新增選單項目或來源類型時，接到下面的擴充點，不改導覽結構。

## 來源類型

來源類型的加入方式見 [架構](architecture.md#來源類型與-plugin)：宣告在 `src/app/plugins/declarations.ts`，server 項目在 `src/app/plugins/index.ts`，圖示在 `src/transport/web/plugins.tsx` 的 `SOURCE_ICONS`，徽章顏色在 `src/transport/web/plugins.css`。畫面上與類型有關的文字、類型標籤、辨識卡片標題與新增訂閱選單都由宣告產生，新類型不需要改 Shell。

網址辨識由 `src/domain/sources/source-types.ts` 依 plugin 的 `owns` 與 `classify` 產生，回傳的 `UrlRecognition` 在 `actions` 中帶著要送出的 HTTP 請求；新增對話框與 Agent 照原樣送出這個請求，所以新類型的網址種類不需要畫面分支。宣告 `requiresLogin: true` 的類型在辨識前就回 `status: 'login_required'`。`GET /api/source-types` 對 UI 與 Agent 提供各類型的 `id`、`label`、`icon`、`kinds`、`requiresLogin` 與 `settings`。

## 新增選單

`src/transport/web/add-menu.ts` 定義兩個選單：

- 文件頁的 `DOCUMENT_ADD_ITEMS`（網址、檔案、寫筆記）：每一項加入一份之後不會更新的文件。
- 訂閱頁的 `subscriptionAddItems(declarations)`：先列出已登錄類型的各訂閱種類（YouTube 頻道、RSS），再列出 `PLANNED_SUBSCRIPTION_TYPES`（X 帳號、Facebook 粉專）。登錄了相同 ID 的類型時，它的訂閱種類取代該項的位置。

每一項有 `label`、開啟的對話框標題 `dialogTitle` 與 `mode`。`mode` 是 `url` 或 `<類型>-<種類>`，由 `src/transport/web/AddContent.tsx` 顯示成對應的對話框，標題取自 `addDialogTitles(declarations)`。`mode` 為 null 的項目標為「尚未支援」，點選後開啟只有「目前還不支援＿＿。」的小對話框。

`src/transport/web/AddMenu.tsx` 顯示按鈕與選單（`role=menu`，在按鈕正下方，不分組）。在按鈕上按 ↓ 開啟選單並停在第一項；方向鍵在項目間移動並循環，Home、End 跳到頭尾；Escape、Tab、在選單外面按下指標或選了項目都會關閉選單；以鍵盤關閉時焦點回到按鈕。「尚未支援」的對話框以按鈕或 Escape 關閉後，焦點同樣回到選單按鈕。各頁空狀態的按鈕也是同一個 `AddMenu`。開啟的選單以 `src/transport/web/infra/floating-position.ts` 固定在視窗座標、貼著按鈕，外層可捲動或會裁切的容器不會切掉它；任何容器捲動或視窗縮放時選單跟著按鈕移動。`addMismatch(declarations, mode, recognition)` 依辨識結果的 `kind` 判斷貼上的網址是否屬於另一個對話框，所以來源冷卻使頻道預覽 `unavailable` 時仍提供切換；`unsupported` 的辨識結果（類型認得網址，但找不到該種類的對象，例如不存在的頻道、沒有 feed 的網頁）不提供切換。

## 頁面

`src/transport/web/app-shell.ts` 定義每個 `ShellPage` 的路徑、側欄的 `navigation` 與獨立的 `settingsNavigation`；`src/transport/web/App.tsx` 把每個頁面對應到元件。新增頂層頁面時兩處一起改。明細頁（`/sources/<類型>/<ID>`、`/documents/<ID>`）在導覽上屬於各自的列表頁。換頁後頁面標題取得焦點，讓鍵盤操作有固定的起點。開啟 Reader 時 Shell 收合側欄，Reader 佔滿內容區。

返回鍵經 app 自己推入的 history 項目回到開啟它的頁面，直接開啟的頁面回到該頁的預設上一層；動作完成後頁面已不存在時，返回以 replace 離開，不留下指向它的項目。列表的篩選或位置改變時取代目前的 history 項目，所以從 Reader 返回會回到最新的列表位置。新增對話框的動作被接受後，對話框關閉、留在原頁，不另外顯示通知。

系統匣或通知要求打開設定頁的軟體更新區塊時，這個要求只在這次進入設定頁有效：離開設定頁後再進來，畫面停在頁首。同一次進入期間，區塊重新掛載（例如 Vault 設定完成後整頁重畫）時再捲到它一次。

側欄的工作數量與排程狀態讀取失敗時保留上次讀到的值；讀取錯誤由各頁自己顯示。

## 主題

主題設定在設定頁的「外觀」：單選群組「主題」，選項為跟隨系統、深色、淺色，儲存值為 `system`、`dark` 或 `light`。`system` 經 `prefers-color-scheme` 跟隨作業系統，系統外觀一變就切換；Electron 的 `prefers-color-scheme` 透過 `nativeTheme` 跟隨系統，所以 Browser 與 Electron 共用同一條 renderer 路徑，Electron main 不設定 `nativeTheme.themeSource`。畫面經 `src/transport/web/app-shell.ts` 的 `ThemeStore` 介面讀寫偏好，不依賴儲存位置：

- Browser 模式用目前 origin 的 `localStorage`，key 為 `xr-collector.theme`。
- Electron 模式的 preload 以 `xrCollectorTheme` 只提供 `read()` 與 `write('system' | 'dark' | 'light')`。Electron main 把 `{ "theme": ... }` 存在裝置 profile 的 `appearance.json`，寫入一次一個；檔案不含 Vault 路徑、文件資料、Agent 金鑰或憑證。

畫面等讀到 Electron 存的值才顯示 App，所以第一次繪製不會以預設值覆蓋已存的值；只有使用者選取時才寫入。值缺少或無效時跟隨系統。寫入失敗只記錄錯誤，所選主題在這次執行期間照樣套用。

單選群組依 WAI-ARIA radio 模式：選中的選項是群組唯一的 Tab 停駐點，方向鍵移到前後選項並循環，Home、End 跳到頭尾，焦點與選取一起移動。寫入進行中選項保持可用，鍵盤焦點留在選中的選項上。

## 畫面與變動串流

視窗以一條 `/api/events` 事件連線接收變動。每個畫面以 `src/transport/web/infra/use-changes.ts` 的 `useChanges` 宣告哪些變動會讓它的資料過時；過時後的重讀距離上一次至少 `READ_GAP_MS`，期間來的變動合併成一次重讀。讀取進行中來的變動不取消它，等它回來後再讀一次（`change-read.ts`），所以變動來得比讀取快時，畫面仍能顯示一次完整的結果；畫面要的資料改變（例如換頁或換篩選）時才取消進行中的讀取。

事件連線斷了再接上（伺服器重啟、睡眠喚醒、網路中斷），或瀏覽器回報網路恢復時，開著的畫面全部重新讀取資料，不補收期間的個別變動；重新讀取經各畫面自己的讀取，不重新載入頁面，所以輸入到一半的內容保留。斷線期間失敗的讀取由這次重新讀取補上，讀取失敗本身不會觸發重試。

日期相對的標籤（今天、明天）在畫面與系統匣選單重畫時依當下時間計算；午夜後沒有變動時，標籤維持到下一次重畫。
