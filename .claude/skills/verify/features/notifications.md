# 訂閱自動暫停通知

訂閱因連續檢查失敗而自動暫停時，桌面 App 發一次系統通知；通知開關是裝置資料，不進 Vault 匯出；需處理清單由目前 Vault 中自動暫停的訂閱算出，App 不記錄通知是否送達。

## Sub-features

- `notification-settings`：設定頁不提供通知區塊或開關。內部 enabled 參數預設開啟，停用只抑制 OS 通知，不影響自動暫停、選單或圖示，重新開啟不補發。
- `notification-events`：自動暫停當下發一次通知，正常重啟不對已暫停的訂閱再發。
- `notification-actionable`：目前 Vault 的所有自動暫停訂閱都列為需處理，即使是匯入或開啟時已存在；恢復／移除後消失。
- `notification-click`：點通知顯示、還原、聚焦原視窗並導到同 Vault 詳情；其他 Vault 明示且不切換，移除則顯示不存在。
- `notification-native`：macOS／Windows 真通知、Windows 重啟後從通知中心點擊、深淺色、Windows DPI 與 OS 阻擋情形。

## How to get to it (user POV)

- 自動暫停後從系統通知、選單「需要處理的訂閱（N）」或 `!` 圖示得知。

## Driving it with verify

Preconditions:

- Web 可驗設定頁無通知區塊、內部參數 API、profile 與 active；系統通知／點擊必須用原生 Desktop。
- `GET/PUT /api/device/notifications` 讀寫偏好與需處理清單；`activateNotification(app, { vaultId, sourceType, subscriptionId })` 走與 OS 點擊相同的路由。
- `notifications(app)` 只證明 App 嘗試發送，不證明 OS 畫面實際顯示；真顯示需打包版／安裝版登入桌面目視。

## Gotchas

- `notifications(app)` 是交給 OS，不是已顯示或權限已允許。
- 完全退出後由通知啟動 App（冷啟動）不在 #136 驗收。
- macOS 上 Electron 的通知點擊只送到顯示它的那個程序；App 重啟後從通知中心點舊通知只會帶到前景，不導頁。Windows 的 toast 把導頁目標放在 launch 參數，重啟後點擊仍會導頁。
- 通知開關在 device profile，不應出現在 Vault 匯出檔。

## Regression flows

- `login-startup`：斷言 `notification-settings` 的設定頁沒有通知區塊。預設值與 UI／授權 Agent 讀同一份狀態在 tests/transport/server/routes/device.notifications.test.ts，關閉後重開 profile 仍關閉、重新開啟不補發在 tests/domain/notifications/notification-center.test.ts。
- `notification-clicks`：斷言 `notification-events`、`notification-actionable`、`notification-click`。自動暫停由流程直接寫進訂閱檔當前置，只斷言正常重啟不重發，自動暫停當下的那一次通知在 tests/domain/notifications/notification-center.test.ts；attention 圖示與兩筆選單、點通知顯示隱藏的視窗並導到詳情、第二筆從選單導頁、正常重啟不重發且點舊通知不啟動收集、同一詳情移除後重抓不存在、清空 attention，以及其他 Vault 同 ID 拒絕導頁與切換。Desktop 流程，視窗隱藏時以 App 的顯示紀錄判斷；聚焦與最小化還原需要畫面上的視窗（NCLICK-D1，--visible）。activation 不等同 OS toast 實際顯示。

## Backlog

- `notification-actionable`：恢復訂閱後從需處理清單消失（目前只斷言移除；active 排除已恢復訂閱的規則在 tests/domain/notifications/notification-center.test.ts）。
- `notification-click`：其他 Vault 的通知顯示的說明文字（目前只斷言不導頁、不切換）。
- `notification-native`：真通知、Windows 重啟後從通知中心點擊、深淺色、Windows DPI 與 OS 阻擋；OS 畫面屬明確略過的項目，只在打包版登入桌面目視。
