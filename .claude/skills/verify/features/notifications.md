# 訂閱自動暫停通知

訂閱因連續檢查失敗而自動暫停時，桌面 App 發一次系統通知；通知設定、需處理清單與持久事件是裝置資料，不進 Vault 匯出。

## Sub-features

- `notification-settings`：設定頁不提供通知區塊或開關。內部 enabled 參數預設開啟，停用只抑制 OS 通知，不影響自動暫停、選單或圖示，重新開啟不補發。
- `notification-events`：同一自動暫停事件正常重啟去重；事件含 Vault、來源類型、訂閱、次數、原因與 delivery 結果，`attempted` 不宣稱 OS 一定顯示。
- `notification-actionable`：目前 Vault 的所有自動暫停訂閱都列為需處理，即使是匯入或開啟時已存在；恢復／移除後消失。
- `notification-click`：點通知顯示、還原、聚焦原視窗並導到同 Vault 詳情；其他 Vault 明示且不切換，移除則顯示不存在。
- `notification-native`：macOS／Windows 真通知、通知中心重啟後點擊、深淺色、Windows DPI 與 OS 阻擋情形。

## How to get to it (user POV)

- 自動暫停後從系統通知、選單「需要處理的訂閱（N）」或 `!` 圖示得知。

## Driving it with verify

Preconditions:

- Web 可驗設定頁無通知區塊、內部參數 API、profile 與 active；系統通知／點擊必須用原生 Desktop。
- `GET/PUT /api/device/notifications` 讀寫偏好與事件；`activateNotification(app,id)` 走與 OS 點擊相同的路由。
- `notifications(app)` 只證明 App 嘗試發送，不證明 OS 畫面實際顯示；真顯示需打包版／安裝版登入桌面目視。

## Gotchas

- `attempted` 是交給 OS，不是已顯示或權限已允許。
- 完全退出後由通知啟動 App（冷啟動）與 crash 寫入邊界不在 #136 驗收。
- 通知事件在 device profile，不應出現在 Vault 匯出檔。

## Regression flows

- `notifications`：斷言 `notification-settings`、`notification-actionable` 的無通知區塊與無規格補充文字、預設值、UI／Agent 契約、內部參數持久、既有自動暫停 active 與不補發。
- `notification-clicks`：斷言 `notification-events`、`notification-actionable`、`notification-click` 的 attention 圖示與兩筆選單、隱藏／最小化視窗還原聚焦、無 ledger 列導頁、正常重啟去重且不啟動收集、同一詳情移除後重抓不存在、清空 attention，以及其他 Vault 同 ID 拒絕導頁與切換。Desktop 流程，視窗會顯示；activation 不等同 OS toast 實際顯示。
