# App 更新來源

XR Collector 的更新服務讀取每個平台各自的 release index：`release-darwin-arm64.json` 或 `release-win32-x64.json`，由 `package:*` 與安裝檔一起產生、隨該平台上傳到 Release。服務只讀自己 `target` 的 index，版本高於目前版本時，以 index 記錄的檔名、大小與 SHA-256 下載更新檔並驗證。檢查、下載及套用是三個分開且由使用者觸發的動作。套用前會保存安裝嘗試，只有新版本的 runtime、畫面與原生啟動確認完成後才記為成功；無法確認時保留 unknown，不用程序退出推測成功。

release index 的內容：

```json
{
  "schemaVersion": 1,
  "version": "0.1.0",
  "commit": "40 個字元的完整 commit",
  "target": "win32-x64",
  "buildInfo": { "kind": "packaged", "version": "0.1.0", "commit": "…", "buildId": "…", "target": "win32-x64", "…": "…" },
  "installer": { "name": "XR-Collector-0.1.0-win-x64-setup.exe", "bytes": 123456789, "sha256": "64 個字元" },
  "update": { "name": "XR-Collector-0.1.0-win-x64-setup.exe", "bytes": 123456789, "sha256": "64 個字元" }
}
```

`installer` 是給使用者下載安裝的檔案，`update` 是 App 內更新下載的檔案：Mac 分別是 DMG 與 ZIP，Windows 都是同一個 NSIS 安裝檔。index 只記錄檔名，不記錄網址，網址由來源依 index 所在的位置決定，所以同一份 index 放在 GitHub Release 或鏡像站都成立。服務要求 index 的 `target` 等於自己的平台、更新檔名符合該版本與平台，且 `buildInfo` 是同一版本與 commit 的 packaged BuildInfo。

正式預設來源透過 GitHub 公開 Releases JSON API 讀取最新的穩定 Release，在它的 asset 中尋找自己平台的 index，更新檔的網址取自同一個 Release 的 asset，版本說明取自 Release 的說明文字。index 的版本必須等於 Release 的 tag。Release 沒有這個平台的 index 時視為沒有新版，所以兩個平台可以分批上傳，先上傳的平台不會讓另一個平台的 App 報錯。這個來源不解析 HTML、不使用 token。

開發與公司的鏡像環境可設定 `XR_COLLECTOR_UPDATE_BASE_URL`，指向一個以 `/` 結尾的目錄網址：服務讀取其下的 `release-<target>.json`、index 指定的更新檔，以及選用的 `release-notes.md`（不存在時沒有版本說明）。URL 必須是 HTTPS，只有隔離驗收允許 `127.0.0.1` 或 `localhost` 的 HTTP。

版本更新不送作業系統通知。可用版本、下載、等待與安裝結果只透過設定頁、側欄、原生選單、裝置更新 API 及持久事件呈現；Windows 第一次關閉視窗的系統匣提示是獨立的關窗行為。

公司日後若改用自己的檢查 API，有兩條相容路徑：

1. 最小遷移：在公司的 HTTPS 主機的一個目錄原樣提供各平台的 release index、更新檔與 `release-notes.md`，再把環境設定指向這個目錄。
2. 自訂發現：實作 `UpdateSource`，把公司 API 的結果轉成不可變的 `UpdateOffer`。下載、雜湊驗證、持久 cache、UI／Agent API 與原生安裝器不需要改動。

來源在 Electron 啟動入口組裝，`XR_COLLECTOR_UPDATE_BASE_URL` 是啟動時覆寫。Windows installer 透過登入桌面的 shell 重開 App，不保證承繼啟動腳本的環境變數；公司的發行版本應在組裝入口選用公司的預設 adapter，或由部署環境持續提供來源設定。

啟動依賴要特別處理：App 必須先能找到下一份 index，才能透過更新改用新來源。因此來源搬移至少要讓舊 URL 在一個發布週期內仍提供 index，或先發布同時認得新來源的過渡版，再關閉舊來源。不要只在新來源發布一個舊 App 不知道的位置。

驗收可以使用 loopback generic source，但必須使用正式 schema、真實封裝產物及真實原生安裝路徑；不能把模擬的「安裝成功」當成平台驗收。

同一個乾淨 commit 要建立隔離的 A／B 安裝包時，封裝指令接受受限的驗收身分，不必修改正式 `package.json`：

```sh
XR_COLLECTOR_VALIDATION_BUILD=1 npm run package:mac -- \
  --validation-version 0.1.1 \
  --validation-app-id com.xrcollector.verify36 \
  --validation-product-name "XR Update Verify 36" \
  --validation-update-repository derektu/xr-collector-test
```

版本、appId 與產品名稱三個 `--validation-*` 參數必須一起提供，且只有明確設定 `XR_COLLECTOR_VALIDATION_BUILD=1` 才接受。repository 是第四個選用參數，未提供時維持正式來源 `derektu/xr-collector`，供既有 loopback 驗收使用；提供時會和 appId、產品名稱一起寫入 ASAR，讓 Windows shell 或 macOS helper 重啟 App、沒有原啟動環境變數時，仍使用隔離的資料目錄、App 身分與 GitHub repository。正式封裝不帶這些參數，仍固定使用 repo 的版本、appId、產品名稱與正式 repository。

公開更新驗收使用 `XR Update Verify Public`／`com.xrcollector.verify.public` 這組隔離身分，repository 為 `derektu/xr-collector-test`；驗收 App 不發到正式 repository。

驗收 A、B 使用同一個隔離 profile、Vault 與 Agent port，不能指向正式資料。原生重啟驗收優先使用唯一驗收產品的預設 profile，將固定 Agent port 與 Vault 選址寫入該 profile，並由同一個登入使用者安裝與更新。使用 `XR_COLLECTOR_PROFILE` 覆寫時，須實測該平台交接確實保留環境；不能假定 Windows shell 會保留。中斷 helper 後先等待並盤點作業系統已排隊的啟動，再決定是否手動啟動。
