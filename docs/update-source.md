# App 更新來源

App 更新整套交給 electron-updater：macOS 用 `MacUpdater`（由 Squirrel.Mac 驗證並替換 App），Windows 用 `NsisUpdater`（執行 NSIS 安裝檔）。更新服務（`src/domain/updates/`）只負責什麼時候檢查、使用者選了哪個版本、安裝前後的紀錄；它透過 `AppUpdater` 介面驅動 electron-updater（`src/desktop/electron/app-updater.ts`），所以服務本身不需要 Electron 也能測試。

檢查更新在啟動 30 秒後自動執行一次，之後最多每 24 小時一次（`src/desktop/electron/update-check-scheduler.ts`，只在打包的 Mac 與 Windows App 啟用），使用者也可以在設定頁手動檢查。下載與安裝只由使用者觸發：electron-updater 的 `autoDownload` 與 `autoInstallOnAppQuit` 都關閉，正常結束 App 不會安裝。

版本更新不送作業系統通知。可用版本、下載與安裝結果只透過設定頁、側欄、原生選單、系統匣圖示、裝置更新 API 與持久事件呈現。

## Feed

每個平台的 feed 是 electron-builder 打包時產生的 `latest-mac.yml` 或 `latest.yml`，記錄版本、更新檔名、大小與 sha512。打包時 `package:*` 檢查 feed 的版本與檔名對得上這次的產物，`release:upload` 把 feed 連同安裝檔、更新檔與 blockmap 上傳到 Release。Mac 的更新檔是 ZIP（DMG 給使用者下載安裝），Windows 的更新檔與安裝檔是同一個 NSIS 安裝檔。

正式來源是 GitHub Releases 的 `derektu/xr-collector`：electron-builder 依 `electron-builder.yml` 的 `publish` 把 provider 寫進 App 內的 `app-update.yml`，electron-updater 從 `github.com/<repository>/releases/latest` 找出最新的穩定 Release（不是 draft、不是 prerelease），再讀它本平台的 feed。App 只顯示新版的版本號，不顯示 Release 的版本說明。

讀不到本平台的 feed（HTTP 404）時，GitHub 與 generic 兩種來源的 electron-updater 都回 `ERR_UPDATER_CHANNEL_FILE_NOT_FOUND`，服務把它當成沒有新版。所以兩個平台可以分批上傳，最新的 Release 還沒有本平台的 feed 時，先上傳的平台不會讓另一個平台的 App 報錯；同樣地，generic feed 的網址打錯或檔案沒放好，也只會顯示「已是最新版」。

本機驗收或鏡像站可設定 `XR_COLLECTOR_UPDATE_BASE_URL`，指向放著 feed 與更新檔的目錄，App 以 electron-updater 的 generic provider 讀它。設定前先檢查網址：必須是 HTTPS，只有 `127.0.0.1` 或 `localhost` 允許 HTTP，不能帶帳密、query 或 fragment；不符合時 App 啟動失敗。Windows 安裝程式透過登入桌面的 shell 重開 App，不保證承繼啟動時的環境變數，所以這個覆寫只適合單次驗收；長期使用其他來源的發行版本，應把來源寫進打包設定。

App 要先能在舊來源找到下一版，才能透過更新改用新來源。搬移來源時，舊位置至少要在一個發布週期內繼續提供 feed，或先發布一個 `app-update.yml` 已指向新來源的版本，再關閉舊來源。

## 下載

使用者選定版本後，electron-updater 下載更新檔並以 feed 的 sha512 驗證，下載中回報進度，可以取消。下載完成才可以安裝。下載新版本時，electron-updater 會換掉已下載的檔案，所以之前可安裝的版本也跟著失效。

已下載的版本不跨重新啟動保留：App 重新啟動後，要重新檢查並下載才能安裝（electron-updater 會沿用快取中 sha512 相符的檔案，不一定重新傳輸）。

## 安裝

使用者按下安裝後：

1. 服務把要安裝的版本寫進 `<userData>/updates/state.json`。
2. App 走一般的結束流程：停止排程與系統匣、關閉視窗、關閉 Collector runtime（收集、知識庫寫入與搜尋引擎照一般結束的方式停下）。
3. runtime 關閉後才呼叫 `quitAndInstall`。Windows 的 NSIS 安裝程式一啟動就會結束安裝資料夾裡所有還在執行的程序，所以必須等 runtime 與搜尋引擎都關閉。macOS 由 Squirrel.Mac 驗證更新檔的簽章，ShipIt 替換 App 後啟動新版。
4. runtime 無法正常關閉，或安裝程式沒有接手（例如 Squirrel 拒絕簽章）時，原因寫進同一筆紀錄，App 重新啟動舊版。

下次啟動時，服務比對執行中的版本（`app.getVersion()`）與紀錄中的版本：相同記為「已安裝」，不同記為「未完成」並附上紀錄的原因，各記一筆持久事件，然後清除紀錄。結果顯示在設定頁與裝置更新 API 的 `lastAttempt`，只保留到 App 結束。

## 限制

- 只有 Developer ID 簽章並公證的 Mac 包能做 App 內更新。Squirrel.Mac 以執行中 App 的簽章要求驗證新版，ad-hoc 簽章的包會被拒絕；按下安裝後 App 重開，設定頁顯示 Squirrel 的原因。這類包要手動下載安裝。
- 新版啟動失敗時不會自動退回舊版。ShipIt 替換完成就算成功，使用者需要重新下載安裝。
- macOS 上，Squirrel 需要寫入 App 所在的目錄：非 admin 帳號、`/Applications` 不能寫入，或從 DMG、下載資料夾直接執行（App Translocation）時更新失敗，App 重開後顯示原因，使用者手動安裝。
- Windows 包沒有 Authenticode 簽章，`app-update.yml` 也就沒有 `publisherName`，NsisUpdater 只以 feed 的 sha512 驗證安裝檔。feed 與安裝檔來自同一個 Release，所以這只能偵測傳輸損毀，不能偵測來源被換掉。

## 驗收身分

同一個 commit 要建立隔離的 A／B 安裝包時，封裝指令接受驗收身分，不修改 `package.json`：

```sh
XR_COLLECTOR_VALIDATION_BUILD=1 npm run package:mac -- \
  --validation-version 0.1.1 \
  --validation-app-id com.xrcollector.verify.public \
  --validation-product-name "XR Update Verify Public" \
  --validation-update-repository derektu/xr-collector-test
```

版本、appId 與產品名稱三個參數必須一起提供，且只有設定 `XR_COLLECTOR_VALIDATION_BUILD=1` 才接受；appId 必須以 `com.xrcollector.verify` 開頭，產品名稱必須以 `XR Update Verify ` 開頭。repository 選用，未提供時是正式的 `derektu/xr-collector`。

封裝指令把這些參數轉成 electron-builder 的設定覆寫：`appId`、`productName`、套件中繼資料的 `version` 與 `productName`、`publish` 的 owner 與 repo。所以驗收包有自己的 bundle identifier、自己的資料目錄（Electron 依產品名稱決定 userData），`app-update.yml` 指向驗收的 repository。appId 另外寫進套件中繼資料的 `xrCollectorAppId`，App 由它設定 Windows 的 AppUserModelId 與登入自啟的 Run 項目名稱；正式包沒有這個欄位，App 使用 `com.moneydj.xrcollector`。這些值都在安裝包裡，Windows shell 或 ShipIt 重開 App、沒有原本的環境變數時，仍是同一個身分。正式封裝不帶這些參數，也不能含有 `xrCollectorAppId`。electron-updater 的下載快取目錄（macOS 的 `~/Library/Caches`、Windows 的 `%LOCALAPPDATA%` 下的 `xr-collector-updater`）由 `package.json` 的 `name` 決定，驗收包與正式包共用；快取中的檔案仍要通過 feed 的 sha512 才會被使用。

公開更新驗收使用 `XR Update Verify Public`／`com.xrcollector.verify.public` 這組身分，repository 為 `derektu/xr-collector-test`；驗收 App 不發到正式 repository。

驗收可以使用 loopback 的 generic feed，但必須使用真實封裝產物與真實的 electron-updater 安裝路徑；Mac 必須是 Developer ID 包。ShipIt 與 NSIS（`--force-run`）啟動 B 時不帶 A 的環境變數，所以 A、B 都用產品名稱決定的預設資料目錄，不設 `XR_COLLECTOR_PROFILE`；驗收身分的產品名稱已讓這個目錄與正式資料分開。A、B 使用同一個 Vault 與 Agent port，不指向正式資料，並由同一個登入使用者安裝與更新。
