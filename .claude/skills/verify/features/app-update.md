# App 更新

設定頁、側欄、原生選單、系統匣圖示與授權 Agent 共用同一份裝置更新狀態。側欄平常只顯示版本；有新版本、下載中、可安裝與安裝中才顯示對應的短動作。三處對同一階段都用「有新版本」「下載中 n%」「可安裝」「安裝中」，選單與系統匣前面加「App 更新：」。檢查讀 electron-updater 的 `latest-mac.yml`／`latest.yml` feed；下載固定使用者選定的版本，由 electron-updater 以 feed 的 sha512 驗證，下載完成後才可明確重新啟動安裝。關窗不安裝，未建立 Vault 也能檢查與下載。檢查失敗時設定頁的狀態行（`update-message`）以錯誤色顯示「無法檢查更新，請稍後再試。」，下載失敗顯示「下載失敗，請重新下載。」；electron-updater 的原文在 API 的 `detail` 與記錄。上次安裝未完成時，原因只以 `update-attempt-problem` 顯示一次。完整安裝紀錄由 Agent API 與活動紀錄提供。

版本可用、下載完成及安裝中都不發作業系統通知；狀態只出現在設定頁、側欄、選單、系統匣圖示及授權 Agent API。Windows 第一次關閉視窗的「仍在系統匣執行」提示屬於關窗行為，不是版本更新通知。

## Sub-features

- `update-discovery`：檢查最新穩定版的本平台 feed，區分有新版本、已是最新版與錯誤；本平台沒有 feed 時視為已是最新版。只顯示版本號，不自動下載。
- `update-auto-check`：打包的 Mac／Windows App 啟動 30 秒後自動檢查一次，之後最多每 24 小時一次，喚醒時到期也會檢查（`src/desktop/electron/update-check-scheduler.ts`）。
- `update-download`：下載時顯示進度及取消；sha512 吻合才發布 ready，失敗進 `error`（`update_download_failed`），畫面顯示短訊息、原文在 `detail`，同一版本可直接重新下載。
- `update-install`：ready 由使用者再次確認後進 installing，走一般的結束流程再交給安裝程式；installing 不提供任何更新操作，下次啟動依執行中的版本記為 `installed` 或 `incomplete`。
- `update-agent`：授權 Agent 與 UI 使用同一組查詢、檢查、下載、套用及取消 API，selection 只接受 `{version}`。
- `update-no-vault`：更新是裝置資料，Onboarding／Vault 不可用時仍可從 App 設定與 Agent 操作。
- `update-navigation`：側欄版本狀態與原生選單入口開啟設定後，等待更新面板掛載並將它帶入可視範圍。

## How to get to it (user POV)

- 已進入主畫面：側欄版本狀態或「設定」→「關於 XR Collector」→ App 更新。
- 尚未建立 Vault：直接開啟 App 設定頁的「App 更新」。
- macOS 選單列／Windows 系統匣：「檢查 App 更新」或目前更新階段（下載中附百分比）；點擊時若階段是閒置、已是最新或錯誤，先送出一次檢查，再開啟同一個設定位置。
- 授權 Agent：`GET /api/device/updates`，再依使用者明確要求使用 check、download、apply 或 cancel。

## Driving it with verify

Preconditions: 共用狀態用 Web 合成 instance、`vault: 'none'`；verification server 提供 electron-builder 格式的合成 `latest-mac.yml` 與 payload，real `UpdateService` 驅動只存在 verification server 的 fixture updater，它照 electron-updater 的方式讀 feed 並驗 sha512。原生安裝及 A→B 重新啟動另用兩平台隔離安裝版。

1. 直接開 `/settings`，確認沒有 Vault 時仍看到目前版本與「檢查更新」；由這個 run 的 Agent connection 以 Bearer token 檢查，再比對 UI／Agent 都為 `available`、版本 `0.1.1`。
2. 將 payload 停在 62%，點「下載更新」；下載中只顯示「取消下載」，Agent 同時要求 apply 回 409 `update_not_ready`。取消後回到 `available`，沒有 ready。
3. feed 改送 sha512 不符的 payload；下載後進 `error`（`update_download_failed`）、ready 為 null、沒有 `update-apply`，`update-message` 等於 API 的 `message`（「下載失敗，請重新下載。」），原文只在 `detail`；同一版本可直接重新下載。恢復原 bytes 並重新下載後才顯示「重新啟動以安裝」。
4. feed 改為 `0.1.2` 並檢查，確認 ready `0.1.1` 與「下載 0.1.2」並存。
5. 以已開啟 Vault 的 instance 從文件頁點側欄版本狀態，再送出原生 `update` 導覽訊號；兩者都等「關於」內的更新面板掛載後才捲入可視範圍，普通「設定」入口仍停在頁首。
6. 側欄 `data-phase` 依序為 downloading、ready、installing（「下載中 n%／可安裝／安裝中」，available 為「有新版本」）；錯誤狀態只顯示版本。點套用後進 installing，畫面沒有任何更新按鈕；再以 `0.1.2` 重新啟動，`lastAttempt` 記為 `installed`。
7. 打包驗收以私有固定 feed、獨立 appId／profile／Vault／port 驗 `0.1.0 → 0.1.1`：Mac ARM64 與 Windows x64 各驗中文精簡與官方引擎、A 工作安全停止、B 回報版本/buildId、原 profile/Vault 保留。這是原生證據，不能由 Web fixture 取代。系統匣角標與選單文字見 [tray.md](tray.md) 的 `tray-menu`；自動檢查排程由 update-check-scheduler 單元測試保護，打包時確認。打包方式見 [docs/update-source.md](../../../../docs/update-source.md) 的「驗收身分」。

## Gotchas

- Web 流程證明共用 source、service、HTTP API 與 UI 狀態機；fixture updater 不會取代 App，apply 只記錄安裝中的版本，流程以新的 currentVersion 重啟模擬安裝結果，不是原生安裝證據。
- 正常關窗不套用已下載的更新。cancel 只中止進行中的下載，installing 沒有取消動作。
- `lastAttempt` 的 outcome 只有 `installed` 與 `incomplete`，保留在裝置 API 與活動紀錄；設定頁只在 `incomplete` 時顯示 `update-attempt-problem`，內容是 `message` 的短句，安裝程式的原文只在 `lastAttempt.detail` 與活動紀錄。
- 版本更新任何 phase 都不送 OS notification；用設定頁、側欄、原生選單或系統匣圖示確認狀態。
- 只檢查不會改掉已下載的 ready；但一開始下載較新的版本，ready 就清成 null，先前可安裝的版本跟著失效，取消下載後回到 `available`，要重新下載才能安裝。
- 官方來源是 GitHub Releases：electron-updater 讀最新穩定 Release 中本平台的 `latest-mac.yml`／`latest.yml`，沒有本平台 feed（`ERR_UPDATER_CHANNEL_FILE_NOT_FOUND`）時是「已是最新版」。`XR_COLLECTOR_UPDATE_BASE_URL` 可指向 generic feed，必須是 HTTPS 或 loopback HTTP。App 只取新版的版本號，不顯示版本說明。
- Mac 由 Squirrel.Mac／ShipIt 安裝，只有 Developer ID 簽章並公證的包能更新；ad-hoc 包被拒絕時 App 重開舊版並在設定頁顯示原因。Windows 走 electron-updater 的 NSIS 路徑。新版啟動失敗不會自動退回，兩者失敗都不能報成功。

## Regression flows

- `app-update`：斷言 `update-discovery`、`update-download`、`update-install`、`update-agent`、`update-no-vault`、`update-navigation`；從 no-Vault Web instance 開始，使用合成 latest-mac.yml feed 與 real UpdateService，涵蓋 Agent 檢查、UI 進度／取消、下載中 apply 回 update_not_ready、sha512 不符時 update_download_failed 且畫面只顯示短訊息、ready、ready 與較新 offer 並列；之後建立 Vault，從非設定頁的側欄點擊與原生導覽訊號都定位到更新面板，側欄 data-phase 依序為 downloading、ready、installing，安裝中沒有更新操作，以 0.1.2 重啟後 lastAttempt 記為 installed。原生安裝由打包驗收證明。

## Backlog

- `update-navigation`：錯誤狀態的側欄只顯示版本、不顯示更新階段。
- `update-auto-check`：啟動 30 秒後與每 24 小時的自動檢查；排程邏輯由 update-check-scheduler 單元測試保護，Web 流程跑不到，打包驗收時確認。
- `update-download`：已有 ready 時開始下載較新版本再取消，ready 變成 null、phase 為 `available`、畫面沒有 `update-apply`。
