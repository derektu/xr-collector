# 登入電腦時自動啟動

設定頁的裝置開關。只有安裝後的 macOS／Windows App 可以改；開啟後，登入電腦會啟動同一套 runtime、排程、系統匣與 Agent API，但不自動顯示主視窗。手動開啟仍顯示視窗，重複啟動不建立第二個 runtime。

## Sub-features

- `login-startup-setting`：安裝版讀取、開啟與關閉作業系統登入項目，切換中不先假裝成功，回到設定頁或視窗重新取得焦點時重讀。
- `login-startup-unavailable`：Web／開發版開關停用並說明只能用安裝版；UI 與 Agent API 都拒絕修改。
- `login-startup-background`：由登入項目啟動時 runtime、排程、系統匣與 Agent API 可用，主視窗不顯示。
- `login-startup-single-instance`：已有 instance 時，登入自啟形式的第二次啟動不顯示視窗；手動第二次啟動顯示現有視窗，instanceId 不變。
- `login-startup-os-state`：作業系統外部停用優先；macOS 需要允許時明確顯示；Windows App 搬移只修復仍可證明為啟用的 XR Collector 項目。

## How to get to it (user POV)

- 主視窗左側「設定」→「啟動與背景執行」→「登入電腦時自動啟動」。
- macOS 另可在「系統設定 → 一般 → 登入項目與延伸功能」查看或停用。
- Windows 另可在「設定 → 應用程式 → 啟動」查看或停用。

## Driving it with verify

Preconditions:

- 開發版負向案例用 Web 合成資料或 macOS／Windows 原生開發 Electron，驗證設定頁與 Agent 都拒絕註冊，不修改作業系統登入項目。
- 真實 OS 註冊、外部停用及登入案例必須在兩台 VM 使用相同受測 commit 的安裝版；受控啟動辨識只能補驗分支，不能取代真實登入。
- 程式以 `app.isPackaged` 判定是否能操作 OS；未安裝的 `.app` 與 `win-unpacked` 也具備此能力。隔離 profile 不會隔離作業系統登入項目，本機打包 smoke 不點這個開關；正向案例仍使用 VM 的安裝版。
- 真登入案例沿用上述 VM 安裝版，會真的登出再登入，只在使用者確認時段後執行。

- **Web 不可設定。** 進入設定頁，`settings-login-startup` 內的 `login-startup-switch` 內的 `input` 必須 disabled，`login-startup-status` 簡短顯示「僅限安裝版 App。」。向 UI 與 Agent listener `PUT /api/device/login-startup {"enabled":true}` 都是 409 `login_startup_unavailable`。
- **切換與 read-back。** 安裝版切換後，以兩個 listener 的 GET 比對 OS 實際狀態；製造 adapter 失敗時，開關維持 read-back 值並在卡片顯示錯誤。
- **背景啟動。** 登入 VM 後不操作，確認視窗不可見、tray 存在、Agent `/api/health` 可達；再手動啟動，現有視窗顯示且 `runtime.instanceId` 不變。
- **外部停用。** 在 OS 設定關閉後再進設定頁，開關必須顯示關閉，App 不得自行重開。

## Gotchas

- 開發版 Electron 與瀏覽器不是安裝版，不能用它們證明 OS 登入項目真的生效。
- macOS 未簽章的 44.4.1 App 可能回 `requires-approval` 或設定後 read-back 仍為關閉；這是要呈現的 OS 狀態，不可當作成功。
- 真登入案例會登出 VM，會中斷該 VM 的其他驗收；先與使用者確認時段。
- 只看到 build 成功、registry/plist 存在或 process 出現，都不能取代「登入後背景服務可用且視窗未顯示」的行為驗收。

## Regression flows

- `login-startup`：斷言 `login-startup-setting`、`login-startup-unavailable`、`login-startup-os-state`。先驗 Web 設定頁停用與兩個 listener 拒絕；再以清楚標示的 run-local 平台 fixture 實際點擊開啟、模擬寫入失敗後 read-back、需要核准、OS 外部停用後 focus 刷新，以及慢速舊 GET 不得蓋掉新 PUT 的競態。fixture 不代表真實 OS 已註冊。

設定頁不常駐背景執行與打包限制的長說明。正常狀態由開關表達；錯誤、系統核准與 App 位置變更的操作指引仍顯示。

## Backlog

- `login-startup-background`：由登入項目啟動時 runtime、排程、系統匣與 Agent API 可用且主視窗不顯示；需要打包安裝版，真正登出／登入的生效屬明確略過的項目。
- `login-startup-single-instance`：登入自啟形式的第二次啟動不顯示視窗；手動第二次啟動見 [tray.md](tray.md)。
