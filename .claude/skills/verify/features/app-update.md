# App 更新

設定頁、側欄、原生選單與授權 Agent 共用同一份裝置更新狀態。側欄平常只顯示版本；有 offer、下載、驗證、ready、等待與安裝時才顯示對應的短動作。檢查只讀穩定版索引；下載固定使用者選定的版本與雜湊，驗證完成後才可明確重新啟動安裝。關窗不安裝，未建立 Vault 也能檢查與下載。設定頁不重複顯示最近一次安裝紀錄；完整紀錄仍由 Agent API 與活動紀錄提供，失敗或結果不明則直接顯示錯誤。

版本可用、下載完成及安裝等待都不發作業系統通知；狀態只出現在設定頁、側欄、選單及授權 Agent API。Windows 第一次關閉視窗的「仍在系統匣執行」提示屬於關窗行為，不是版本更新通知。

## Sub-features

- `update-discovery`：檢查固定 release index，區分最新版、未發布與錯誤，顯示版本說明但不自動下載。
- `update-download`：下載時顯示進度及取消；大小、SHA-256、target 與 manifest 全部吻合才發布 ready。
- `update-apply-wait`：ready 由使用者再次確認後等待工作與寫入安全停止；等待可取消，installing 不提供重複動作。
- `update-agent`：授權 Agent 與 UI 使用同一組查詢、檢查、下載、套用及取消 API，selection 必須綁定版本與雜湊。
- `update-no-vault`：更新是裝置資料，Onboarding／Vault 不可用時仍可從 App 設定與 Agent 操作。
- `update-navigation`：側欄版本狀態與原生選單入口開啟設定後，等待更新面板掛載並將它帶入可視範圍。

## How to get to it (user POV)

- 已進入主畫面：側欄版本狀態或「設定」→「關於 XR Collector」→ App 更新。
- 尚未建立 Vault：直接開啟 App 設定頁的「App 更新」。
- macOS 選單列／Windows 系統匣：「檢查 App 更新」或目前更新階段；點擊只開啟同一個設定位置。
- 授權 Agent：`GET /api/device/updates`，再依使用者明確要求使用 check、download、apply 或 cancel。

## Driving it with verify

Preconditions: 共用狀態用 Web 合成 instance、`vault: 'none'`；合成私人 feed 提供真實 generic index／manifest／payload HTTP 協定，real `UpdateService` 使用只存在 verification server 的 fake `NativeInstaller` 驗證語意 ZIP。原生安裝及 A→B 重新啟動另用兩平台隔離安裝版。

1. 直接開 `/settings`，確認沒有 Vault 時仍看到目前版本與「檢查更新」；由這個 run 的 Agent connection 以 Bearer token 檢查，再比對 UI／Agent 都為 `available`、版本 `0.1.1`、來源與版本說明。
2. 將 payload 分兩段送出，點「下載更新」；62% 時只顯示「取消下載」，Agent 同時要求 apply 回 `update_busy`。取消後回到同一 offer，沒有 ready。
3. feed 改送同大小但錯誤雜湊的 payload；下載後顯示 integrity error、ready 為 null，但固定 offer 仍可直接重新下載。恢復原 bytes 並重新下載後才顯示「重新啟動以安裝」與「稍後」。
4. 點「稍後」後同頁仍顯示「重新啟動以安裝」。feed 改為 `0.1.2` 並檢查，確認 ready `0.1.1` 與新版下載按鈕並存；開始新版下載時也不提前取代 ready，取消後仍可套用 `0.1.1`。點套用後停在 `waiting`，只顯示「取消等待」；取消後回 ready。Web 流程不呼叫 installing 或宣稱安裝成功。
   側欄在 available／downloading／ready／waiting 分別顯示「有新版本／下載中／可安裝／等待安裝」；錯誤狀態只顯示版本。verifying／installing 的純狀態對照由 presentation 單元測試覆蓋。
5. 以已開啟 Vault 的 instance 從文件頁點側欄版本狀態，再送出原生 `update` 導覽訊號；兩者都等「關於」內的更新面板掛載後才捲入可視範圍，普通「設定」入口仍停在頁首。
6. 打包驗收以私有固定 feed、獨立 appId／profile／Vault／port 驗 `0.1.0 → 0.1.1`：Mac ARM64 與 Windows x64 各驗中文精簡與官方引擎、A 工作安全停止、B 回報版本/buildId、原 profile/Vault 保留。這是原生證據，不能由 Web fixture 取代。

## Gotchas

- Web 流程證明共用 source、service、HTTP API 與 UI 狀態機；fake installer 不會取代 App，也不是原生安裝證據。
- 「稍後」只標示已保留，不能移除同頁的安裝按鈕，也不刪 verified cache；正常關窗不套用。`waiting` 可取消，`installing` 已交接時沒有取消動作。
- `lastAttempt` 保留在裝置 API 與活動紀錄；成功與 pending 不在設定頁重複佔一行，failed 與 unknown 仍直接顯示錯誤。
- 版本更新任何 phase 都不送 OS notification；用設定頁、側欄或原生選單確認狀態。
- ready 綁定已下載 offer；後來檢查到更新版本不能默默改掉使用者準備安裝的版本。
- 官方 GitHub adapter 只讀公開 latest stable release 中本平台的 `release-<target>.json`；Release 沒有本平台 index 時是「已是最新版」。私人或公司服務以同一個 base URL 提供 index、更新檔與選用的 `release-notes.md`，不抓 HTML。
- 未簽章 Mac 更新需走產品內附 helper 的驗證、備份、ack 與 rollback；Windows 走 electron-updater 的標準 NSIS 路徑。兩者失敗都不能報成功。

## Regression flows

- `app-update`：斷言 `update-discovery`、`update-download`、`update-apply-wait`、`update-agent`、`update-no-vault`；使用 no-Vault Web instance、真實 generic HTTP metadata／stream 與 real UpdateService，涵蓋 Agent 檢查、UI 進度／取消、busy、integrity error、ready、稍後及 waiting 取消。明確不宣稱 Web 已安裝原生更新。
- `app-update-navigation`：斷言 `update-navigation`；使用 selected Vault，側欄各更新階段的文字，以及從非設定頁的側欄點擊與原生導覽訊號都在非同步 BuildInfo 掛載後定位到更新面板。

## Backlog

- `update-navigation`：錯誤狀態的側欄只顯示版本、不顯示更新階段。
