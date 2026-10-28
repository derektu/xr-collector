# 選單列／系統匣

macOS 選單列與 Windows 系統匣的 XR Collector 圖示，以及主視窗的關閉與結束。關閉視窗只隱藏，收集與 Agent API 照常；選單上方依連線與工作狀態顯示灰字，項目有開啟、立即檢查所有訂閱、自動檢查、工作、記錄與結束。Windows 第一次關閉視窗時跳一次「仍在系統匣執行」的提示。

## Sub-features

- `tray-menu`：選單的狀態行（沒有網路／正在檢查或收集／等待重試／排隊中／沒有進行中的工作／下次檢查／自動檢查已關閉）、需處理訂閱子選單、項目順序、「工作」的失敗數、自動檢查的勾選，以及圖示狀態（需處理 `!` 優先於版本更新提示，再優先於閒置／收集中／自動檢查關閉）。未選 Vault 時只有開啟與結束。
- `tray-hide`：關閉視窗只隱藏，程序、收集與 Agent API 照常，runtime 不重啟。
- `tray-actions`：從選單立即檢查所有訂閱、切換自動檢查。
- `tray-open`：從選單開啟主視窗、工作頁與記錄頁；Windows 左鍵點圖示開啟視窗；頁面不重新載入。
- `tray-hint`：Windows 第一次關閉視窗的提示，每台裝置只出現一次；macOS 不提示。
- `tray-second-launch`：視窗隱藏時手動再啟動一次，叫出原本視窗，runtime instanceId 不變；OS 登入自啟形式的第二次啟動保持隱藏，見 [登入自啟](login-startup.md)。
- `tray-quit`：從選單結束，程序與 Meilisearch 都結束，未完成的工作下次啟動接續。

## How to get to it (user POV)

- macOS：選單列的 XR Collector 圖示，點一下打開選單。⌘Q 也會結束。
- Windows：工作列系統匣（可能收在 ^ 裡）的圖示，右鍵打開選單，左鍵開啟視窗。
- 主視窗的關閉鈕（macOS 另有 ⌘W）。

## Driving it with verify

Preconditions:

- 原生 Desktop（`launchElectron`），驗證通道由 `launchElectron` 自動開啟（`XR_COLLECTOR_VALIDATION_CONTROL=1`）。
- 需要工作時，用本機的 RSS feed：Electron 用真的 plugin，可以讀任何本機 HTTP 伺服器的 feed（`flows/tray.mjs` 自己在 run 的 feeds port 提供）。

- **讀選單。** `trayMenu(app)` 回傳 `{ icon, updateBadge?, tooltip, items }`；`items` 包含狀態、動作、分隔線，以及 `{ kind: 'submenu', label, items: [{ action, label }] }`。它先重新讀一次 API 再回傳。
- **點選單。** `clickTray(app, action)` 支援既有 action、版本更新動作，以及需處理列的 `subscription:<notification-id>`。
- **視窗。** `closeWindow(app)` 等於按關閉鈕；`windowState(app)` 回傳 `{ exists, visible, focused, url }`。
- **提示。** `notifications(app)` 回傳這次啟動發出的提示 `[{ id?, title, content }]`；`activateNotification(app, id)` 走與 OS 點擊相同的導頁。版本更新不發送 OS notification。

- **第二次啟動。** `instance.launchAgain()` 以同一 profile 模擬手動再次開啟，回傳第二個程序的 exit code；視窗顯示且前後 `/api/health` 的 runtime instanceId 相同。此 helper 不模擬 OS 登入啟動。
- **結束。** `clickTray(app, 'quit')` 後 `await instance.exited()`；之後 `instance.relaunch()` 用同一個 profile 再啟動。

## Gotchas

- 背景模式（`hidden: true`）下「顯示視窗」只切換頁面，不真的顯示，`windowState().visible` 一直是 false。驗證視窗顯示要用 `hidden: false`，會在桌面上跳出視窗；跑之前先提醒使用者，並集中一次跑。
- 選單本身是作業系統畫的，Playwright 截不到；選單內容以 `trayMenu` 斷言，圖示與選單外觀由實機目視確認。
- Windows 的系統匣與提示需要登入的桌面；SSH 的 session 0 沒有系統匣。
- `notifications(app)` 只證明 App 發出了 Windows 關窗提示，不證明畫面上出現。版本更新在所有平台都不送 OS notification。Windows 只為 App 身分與開始選單捷徑相符的程式顯示關窗提示，開發版的 electron.exe 沒有這個捷徑，所以提示是否出現只能用安裝版（`npm run package:win` 的安裝檔）實機目視。
- 選單每 2 秒（有工作時 1.5 秒）讀一次 API，原生選單在畫面上的更新最多慢這麼久；`trayMenu` 會先讀一次，不受影響。

## Regression flows

- `tray`：斷言 `tray-menu`、`tray-hide`、`tray-actions`、`tray-open`、`tray-hint`、`tray-second-launch`、`tray-quit`。閒置選單的狀態行與項目、關閉後隱藏且 Agent API 的 instanceId 不變、隱藏時立即檢查的狀態序列與文件數、自動檢查的切換、工作／記錄／開啟的頁面且沒有重新載入、提示只出現一次（重新啟動後也不再出現）、第二次啟動叫出原視窗、檢查中結束後 Meilisearch 也結束且重啟後接續完成。Desktop 流程，視窗會顯示。
- `notification-clicks`：斷言 `tray-menu`、`tray-open` 的 attention 優先圖示、需處理子選單、從隱藏／最小化還原聚焦及訂閱入口；移除最後一筆後清除。Desktop 流程，視窗會顯示。

更新提示以向上箭頭疊在原有閒置／收集中／自動檢查關閉圖示上，保留原狀態；Mac 使用單色 Template 與 2x 素材，Windows 使用有輪廓的箭頭與 2x 素材。開啟選單或設定不清除更新標記，執行新版後才消失。訂閱需要處理的 attention 圖示優先於版本更新標記，版本選單仍保留完整狀態。
