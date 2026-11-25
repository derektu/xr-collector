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

## 時間與非同步

| 規則 | 強制 |
|---|---|
| 不直接用 `setTimeout`、`setInterval`（含經 `globalThis`、`window`、`global`、`self`）、`timers` 模組或 Playwright 的 `waitForTimeout`。範圍是 `src`、`tests`、`scripts` 與 `.claude/skills/verify` | lint（`xr-collector/no-timers`） |
| 產品程式需要時間時，由呼叫端傳入計時器，例如 `activity-log.ts`、`pacing-gate.ts`、`job-manager.ts` 的 `setTimer` 選項，測試傳入自己控制的計時器 | lint 擋下直接計時；共用的時間模組尚未提供 |
| `AbortSignal.timeout` 也是計時器，同樣禁用；外部操作的期限由呼叫端持有並傳入的 `AbortController` 中止，測試自己 abort | lint |
| 畫面等使用者的計時（停止打字後再查、通知自動消失、hover 延遲關閉） | lint 擋下直接計時；`src/transport/web/infra/` 的共用 hook 尚未提供 |
| 測試的等待方式見 [專案驗證設定](project-validation.md#自動檢查) | lint 擋下睡眠；`tests/tooling/test-waits.test.ts` 擋下直接輪詢與個別上限 |
| verify skill 的腳本經 `.claude/skills/verify/scripts/lib/wait.mjs` 等待 | lint |

`eslint.config.ts` 為下列路徑保留直接計時的例外：`src/shared/lib/time.ts`、`src/transport/web/infra/`、`tests/support/`（測試替身模擬耗時）與 verify 的 `scripts/lib/wait.mjs`。

用延遲閃過的時序問題是 bug：查出根因再修，不用延遲、重跑或拉長上限讓它消失。

## React

| 規則 | 強制 |
|---|---|
| 不用 `useEffect`、`useLayoutEffect`（從 `react` named import，或 `React.useEffect` 這類屬性存取）。只有 `src/transport/web/infra/` 可以用，並受 `eslint-plugin-react-hooks` 的 `rules-of-hooks` 與 `exhaustive-deps` 檢查 | lint（`xr-collector/no-effect-hooks`） |
| 使用者觸發的事在 event handler 裡處理；畫面顯示的值在 render 時算出 | review |
| 跟外部狀態同步用 `useSyncExternalStore` | review；infra 的共用 hook 尚未提供 |

## Comment

| 規則 | 強制 |
|---|---|
| 自己的程式碼不寫 comment。需要解釋時改名、拆函式、加型別或寫測試；設計理由寫進 `docs/` | lint |
| `//` 只寫別的系統（依賴、平台、協定）的事實，以 `// External:` 開頭，可附證據連結。相鄰各行的 `//` 是同一則，只有第一行需要前綴。事實之外我們自己的推論不放進 comment | lint；是否真的是外部事實由 review 把關 |
| `/** */` 只放在公開檔案的 export 宣告上，或這些宣告的公開成員上（interface 與 type 的欄位、非 `private`／`protected`／`#` 的 class 成員、enum 成員、export 的 const 物件的欄位）；不放在未 export 的宣告與函式內 | lint |
| 公開檔案是 `src/shared` 的檔案、模組入口（`src/<層>/<模組>/` 下的入口檔，定義在 `tooling/source-structure.ts`，見 [架構](architecture.md#執行與業務邊界)），以及入口以 `export … from` 轉出的檔案（轉出的檔案再轉出的也算） | lint |
| 程式碼之前的 `SPDX-License-Identifier:` 授權聲明、`/// <reference`、`prettier-ignore` 不受限制 | lint |

範圍是 `src/`；`tests/` 在 #338 完成後納入。`IMPORTANT`、`do not remove`、很長的辯解，都表示那段程式碼該改。

強制：lint（`xr-collector/comment-policy`，在 `tooling/eslint/comment-policy.ts`）。

## 型別

| 規則 | 強制 |
|---|---|
| `strict` 開啟 | tsconfig |
| 不用 `any`；用 `unknown` 加型別判斷，或寫出實際型別。範圍是所有 lint 的檔案 | lint |
| 不用 `@ts-ignore`、`@ts-expect-error`、`@ts-nocheck` | `src/` 由 lint；`tests/` 尚未強制（測試 import 沒有型別宣告的 `.mjs` 時標 `@ts-expect-error`，見 [測試入口](../tests/README.md)） |

## 既有違規的基準線

計時（`xr-collector/no-timers`）與 `useEffect`（`xr-collector/no-effect-hooks`）的既有違規記在 `eslint-suppressions.json`（ESLint bulk suppressions，按檔案與規則記數量），只能減少。兩類各有自己的規則名稱，所以一個檔案不能拿掉一處 `useEffect` 換成一處計時：

- 檔案的違規多於記錄的數量時，lint 列出該檔案這條規則的全部違規並失敗。
- 違規少於記錄的數量時，lint 也失敗，提示以 `npx eslint --prune-suppressions .` 把記錄降到目前的數量。

comment 與 `any` 沒有基準線。新增違規不加進基準線；規則真的需要例外時，寫進 `eslint.config.ts`。

## 權宜寫法

不在 repo 裡留權宜寫法。當下修不了的，開票記下來，程式碼裡不留標記或 comment。
