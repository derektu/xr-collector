# 建置資訊

設定頁與 Onboarding 底部顯示目前程式的版本、建置時間、commit、建置編號、平台與搜尋引擎 variant。開發來源有未提交修改或身分未知時明確標示；安裝版讀取內附的固定資訊。

## Sub-features

- `build-info-settings`：設定頁固定位置顯示可辨識的 build，重新整理不改變身分。
- `build-info-onboarding`：尚未選擇 Vault 時也能看到同一套建置資訊。
- `build-info-api`：UI 與已授權 Agent 讀取同一份唯讀身分，Vault 未就緒或鎖定時仍可讀。

## How to get to it (user POV)

- 已進入主畫面：側欄「設定」→ 底部「關於 XR Collector」。
- 尚未設定 Vault：Onboarding 下方的建置資訊。

## Driving it with verify

Preconditions: Web 合成 instance；Onboarding 另用 `launchWeb({ vault: 'none' })`，兩個 instance 都使用同一受測 checkout。

1. 點「設定」，讀取 `build-info` 區塊；`build-info-version`、`build-info-time`、`build-info-commit`、`build-info-id`、`build-info-target`、`build-info-kind`、`build-info-variant` 與 `GET /api/device/build-info` 相同。版本及 commit 再和受測 checkout 比對。
2. 由這個 run 的 UI `GET /api/device/agent/connection` 取得目前連線資料，再以 Bearer token 讀 Agent listener 同一路徑，回應與 UI API 相同；無 token 回 401。重新整理設定頁，畫面 buildId 與原本相同。
3. 在 `vault: 'none'` instance 開啟 Onboarding，先確認 Vault API 為 `not_ready`，再比對建置資訊 DOM 與裝置 API，截深／淺色畫面。
4. API 讀取失敗時，卡片顯示「無法讀取建置資訊」與「重試」。可用瀏覽器路由暫回 503 並重新整理；恢復真實 API 後點「重試」，確認原 buildId 再次出現。此注入只證明 UI 錯誤與恢復分支。
5. 打包版需有匹配 commit 的實際安裝產物與 manifest；從隔離 profile 啟動，將 API／DOM 與 `app.asar` 內的 `dist/node/build-info.json`、產物清單比對，記錄 buildId、完整 commit、架構與 variant。沒有安裝產物時回報待驗，Web 不替代安裝驗收。

## Gotchas

- `sourceDirty: null` 是未知，不是乾淨版本；`variant: null` 是開發來源未準備引擎身分。
- development 由執行中的來源建立身分；packaged 必須帶固定的合法資訊，缺檔或 target 不符不能假裝成開發版。
- 此功能不提供更新檢查、下載或安裝操作。

## Regression flows

- `build-info`：斷言 `build-info-settings`、`build-info-onboarding`、`build-info-api`；設定／重新整理、兩 listener、token、Not Ready Onboarding，以及 UI 讀取失敗後點重試恢復。503 是路由注入，不宣稱真實服務故障。
