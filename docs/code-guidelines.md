# 程式規範

repo 裡的程式碼就是下一個 agent 的範本：留下的權宜寫法會被當成慣例照抄。所以規則盡量放進讓錯誤寫不出來的檢查，文字規範是最後的選擇。

## 規則放在哪一層

由可靠到不可靠：

1. **API 與架構**：只開放正確的介面、用型別排除不合法的狀態。
2. **靜態檢查**：型別、lint、結構測試，`npm run verify` 與 CI 擋下。
3. **執行期驗證**：測試與 verify 流程。
4. **文字規則**：本檔、`AGENTS.md`、skill。
5. **人工 review**。

一類錯誤先找能整類消掉它的那一層。lint 與結構測試的錯誤訊息寫出該怎麼改，並指向本檔的段落，因為那是犯錯當下一定會讀到的文字。下面每條規則標出由什麼強制；標「尚未強制」的由 review 把關。

lint 規則在 `eslint.config.ts`，執行的指令見 [建置與發布](building.md#測試)。程式碼裡的 `eslint-disable` 這類 inline 指令不生效（`noInlineConfig`），本身也報錯；規則的例外只寫在 `eslint.config.ts`，集中在一處 review。

## 模組與依賴

層級、模組入口與同層允許的 import 見 [架構](architecture.md#執行與業務邊界)，由 `tests/tooling/import-layers.test.ts` 強制。

| 規則 | 強制 |
| --- | --- |
| 同一個功能的程式碼放在同一個目錄。一層檔案多到看不出哪些屬於同一個功能時，依功能分子目錄，例如 `src/transport/web/sources/`、`scripts/package/`；子目錄之間直接 import 檔案，不為子目錄加 `index.ts` 轉出 | review |

## 時間與非同步

| 規則 | 強制 |
|---|---|
| 不直接用 `setTimeout`、`setInterval`（含經 `globalThis`、`window`、`global`、`self`）、`timers` 模組或 Playwright 的 `waitForTimeout`。範圍是 `src`、`tests`、`scripts` 與 `.claude/skills/verify` | lint（`xr-collector/no-timers`） |
| 產品程式需要時間時（排程、節流、重試間隔、心跳），由呼叫端傳入 `src/shared/lib/time.ts` 的 `Timers`（`after`、`every`），預設 `systemTimers`；不該讓 Node 程序撐著的計時用 `backgroundTimers`。測試傳入自己控制的計時器（`tests/support/timers.ts`） | lint |
| 外部操作的期限用同檔的 `deadline(ms, reason?)`，它回傳到期中止的 signal；`AbortSignal.timeout` 也是計時器，同樣禁用 | lint |
| 輪詢外部狀態（程序起來或結束、Meilisearch task、檔案鎖放開）用同檔的 `waitUntil(check, { interval, timeout, label })`，到上限以帶 label 的錯誤結束。`retryOn` 指定哪些錯誤算「還沒好」，到上限時丟出最後一個這類錯誤。時間模組不提供 sleep | lint |
| 畫面等使用者的計時（停止打字後再查、通知自動消失、hover 延遲關閉）用 `src/transport/web/infra/timing.ts` 的 `useDebouncedValue`、`useTimeout` | lint 擋下直接計時 |
| 測試的等待方式見 [專案驗證設定](project-validation.md#自動檢查) | lint 擋下睡眠；`tests/tooling/test-waits.test.ts` 擋下直接輪詢與個別上限 |
| `scripts/` 經 `scripts/lib/wait.mjs` 的 `waitFor`、`deadline`、`raceWithTimeout` 等待；verify skill 的腳本經 `.claude/skills/verify/scripts/lib/wait.mjs`，證明一段時間內某件事沒有發生的觀察窗用其中具名的 `observeFor(ms)`。兩份 `wait.mjs` 各自獨立，不互相 import | lint |

`eslint.config.ts` 為下列路徑保留直接計時的例外：`src/shared/lib/time.ts`、`src/transport/web/infra/`、`tests/support/`（測試替身模擬耗時）、`scripts/lib/wait.mjs` 與 verify 的 `scripts/lib/wait.mjs`。

用延遲閃過的時序問題是 bug：查出根因再修，不用延遲、重跑或拉長上限讓它消失。共享的狀態只有一個擁有者；時序問題要修成能保證正確，不靠計數或等待。

## React

| 規則 | 強制 |
|---|---|
| 不用 `useEffect`、`useLayoutEffect`（從 `react` named import，或 `React.useEffect` 這類屬性存取）。只有 `src/transport/web/infra/` 可以用，並受 `eslint-plugin-react-hooks` 的 `rules-of-hooks` 與 `exhaustive-deps` 檢查 | lint（`xr-collector/no-effect-hooks`） |
| 使用者觸發的事在 event handler 裡處理；畫面顯示的值在 render 時算出 | review |
| 跟外部狀態同步用 `useSyncExternalStore`；媒體查詢與網址用 `infra/browser-state.ts` 的 `useMediaQuery`、`useLocation`，改網址經同檔的 `writeHistory` | review |
| 跟著輸入或網址變的草稿，在 render 時比對上一次的輸入，不同就重設 state（記下上一次的值，不用 `key` 重掛元件）；從讀取結果算得出的值在 render 時算 | review |
| 對話框以 `infra/dialog.ts` 的 `showModalOnMount` 當 ref，在掛上 DOM 時 `showModal()`；開啟時焦點落在標了 `data-initial-focus` 的元素，沒有標的落在第一個可聚焦的元素。受控的對話框只在開啟時 render | review |

畫面需要跟外部同步時，用 `src/transport/web/infra/` 提供的 hook：

| hook | 用途 |
|---|---|
| `useLiveRead`、`useChangeRead`、`useChanges`、`useChangeStream`（`use-changes.ts`） | 讀取會隨 `/api/events` 變動而過時的資料 |
| `useRead`（`use-read.ts`） | 依參數讀一次；參數改變或卸載時中止，過期的回應丟棄；回傳 `value`、`error`、`pending` |
| `useDebouncedValue`、`useTimeout`（`timing.ts`） | 停止輸入後才用的值；延遲執行，`ms` 為 `null` 時不計時，`restartKey` 改變時重新計時 |
| `useDismiss`（`dismiss.ts`） | 開啟中的選單或說明卡在外面按下指標或按 Esc 時關閉 |
| `useFloatingPosition`、`menuPlace`（`floating-position.ts`） | 以視窗座標放置浮動元素，捲動或縮放視窗時跟著錨點移動 |
| `useWindowEvent`、`useDesktopNavigation`、`useUnmountSignal`、`useFocusAfterChange`（`lifecycle.ts`） | 視窗事件、桌面端導覽通知、卸載時中止 event handler 啟動的工作、換頁後移動焦點 |

## Comment

| 規則 | 強制 |
|---|---|
| 自己的程式碼不寫 comment。需要解釋時改名、拆函式、加型別或寫測試；設計理由寫進 `docs/` | lint |
| `//` 只寫別的系統（依賴、平台、協定）的事實，以 `// External:` 開頭，可附證據連結。相鄰各行的 `//` 是同一則，只有第一行需要前綴。事實之外我們自己的推論不放進 comment | lint；是否真的是外部事實由 review 把關 |
| `/** */` 只放在公開檔案的 export 宣告上，或這些宣告的公開成員上（interface 與 type 的欄位、非 `private`／`protected`／`#` 的 class 成員、enum 成員、export 的 const 物件的欄位）；不放在未 export 的宣告與函式內 | lint |
| 公開檔案是 `src/shared` 的檔案、模組入口（`src/<層>/<模組>/` 下的入口檔，定義在 `tooling/source-structure.ts`，見 [架構](architecture.md#執行與業務邊界)），以及入口以 `export … from` 轉出的檔案（轉出的檔案再轉出的也算） | lint |
| 程式碼之前的 `SPDX-License-Identifier:` 授權聲明、`/// <reference`、`prettier-ignore` 不受限制 | lint |

測試檔（`tests/`）同樣適用，另有兩處不同：

| 規則 | 強制 |
|---|---|
| 程式碼之前可以有一則 `//` 檔頭，寫出測試壞掉時使用者（或開發者）會遇到什麼，見 [開發驗證流程](development-validation.md#3-回歸流程)。案例的理由寫進 `it` 名稱，setup 以 helper 名稱說明 | lint |
| `tests/support/` 是測試共用的檔案，視同公開檔案：export 宣告可以有 `/** */` | lint |

`tests/` 的既有違規記在基準線（見〈既有違規的基準線〉）。

`IMPORTANT`、`do not remove`、很長的辯解，都表示那段程式碼該改。

強制：lint（`xr-collector/comment-policy`，在 `tooling/eslint/comment-policy.ts`）。

## 型別

| 規則 | 強制 |
|---|---|
| `strict` 開啟 | tsconfig |
| 不用 `any`；用 `unknown` 加型別判斷，或寫出實際型別。範圍是所有 lint 的檔案 | lint |
| 不用 `@ts-ignore`、`@ts-expect-error`、`@ts-nocheck` | lint |

## 既有違規的基準線

除了 `tests/` 的 comment 規則，lint 規則都不帶基準線，lint 報出的每一處都要改。只有導入新規則、既有違規一時改不完時，才以 ESLint bulk suppressions 把它們記成基準線（`eslint-suppressions.json`）：

- 按檔案與規則記數量，只能減少。每條規則有自己的名稱，所以一個檔案不能拿掉一種違規換成另一種。
- 檔案的違規多於記錄的數量時，lint 列出該檔案這條規則的全部違規並失敗。
- 違規少於記錄的數量時，lint 也失敗，提示以 `npx eslint --prune-suppressions .` 把記錄降到目前的數量；全部清掉後，prune 留下的空記錄連同檔案一起刪除。

新增的違規不加進基準線；規則真的需要例外時，寫進 `eslint.config.ts`。

## 權宜寫法

不在 repo 裡留權宜寫法。當下修不了的，開票記下來，程式碼裡不留標記或 comment。
