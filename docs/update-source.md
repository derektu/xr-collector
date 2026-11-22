# App 更新來源

更新服務（`src/domain/updates/`）讀取每個平台各自的 release index：`release-darwin-arm64.json` 或 `release-win32-x64.json`，由 `package:*` 與安裝檔一起產生、隨該平台上傳到 Release。服務只讀自己 `target` 的 index，版本高於目前版本時，以 index 記錄的檔名、大小與 SHA-256 下載更新檔並驗證。

檢查更新在啟動 30 秒後自動執行一次，之後最多每 24 小時一次（`src/desktop/electron/update-check-scheduler.ts`，只在有原生安裝器的平台啟用），使用者也可以在設定頁手動檢查；下載與套用只由使用者觸發。套用時先等待收集與知識庫寫入安全停止，最多兩分鐘，期間可以取消，取消或逾時後收集恢復；等待完成並保存安裝嘗試後，服務轉為關閉並交給原生安裝器，此後只會結束，不再恢復收集。新版本的 runtime、畫面與原生啟動都確認完成後才記為成功；無法確認時記為 `unknown`，不以程序退出推測成功。

套用前先讓知識庫靜止：先停止派出新的收集步驟，排隊的工作才不會在等待期間開始；再等待進行中的知識庫寫入與收集步驟完成。這段期間知識庫寫入與知識庫操作回 `update_busy`。使用者取消或超過兩分鐘時放棄這次安裝，收集與寫入恢復，App 照常使用。準備完成後交給關閉流程：停下的收集與寫入不再恢復，程式關閉資料服務後交給安裝器；關閉或交接失敗時也不恢復原本的服務。

## Release index

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

## 來源

正式預設來源透過 GitHub 公開 Releases JSON API 讀取最新的穩定 Release（不是 draft、不是 prerelease），在它的 asset 中尋找自己平台的 index，更新檔的網址取自同一個 Release 的 asset，版本說明取自 Release 的說明文字。Release 的 tag 必須是 `v<index 的版本>`。Release 沒有這個平台的 index 時視為沒有新版，所以兩個平台可以分批上傳，先上傳的平台不會讓另一個平台的 App 報錯。這個來源不解析 HTML、不使用 token。

開發與鏡像環境可設定 `XR_COLLECTOR_UPDATE_BASE_URL`，指向一個以 `/` 結尾的目錄網址：服務讀取其下的 `release-<target>.json`、index 指定的更新檔，以及選用的 `release-notes.md`（不存在時沒有版本說明）。URL 必須是 HTTPS，不能帶帳密、query 或 fragment；只有 `127.0.0.1` 或 `localhost` 允許 HTTP，供隔離驗收使用。

來源在 Electron 啟動入口組裝（`src/desktop/electron/desktop-environment.ts`），`XR_COLLECTOR_UPDATE_BASE_URL` 是啟動時的覆寫。Windows installer 透過登入桌面的 shell 重開 App，不保證承繼啟動時的環境變數，所以需要長期使用其他來源的發行版本，應在組裝入口改用該來源，而不是依賴環境變數。其他來源有兩種接法：

- 在 HTTPS 主機的一個目錄原樣提供各平台的 release index、更新檔與 `release-notes.md`，再把來源指向這個目錄。
- 實作 `UpdateSource`（`src/domain/updates/types.ts`），把對方 API 的結果轉成不可變的 `UpdateOffer`；下載、雜湊驗證、cache、UI／Agent API 與原生安裝器不受影響。

App 要先能找到下一份 index，才能透過更新改用新來源。因此搬移來源時，舊位置至少要在一個發布週期內繼續提供 index，或先發布同時認得新來源的過渡版，再關閉舊來源。

版本更新不送作業系統通知。可用版本、下載、等待與安裝結果只透過設定頁、側欄、原生選單、系統匣圖示、裝置更新 API 與持久事件呈現。

## 原生安裝與回復

下載與驗證屬於 `UpdateService`，原生安裝器只接手已驗證的檔案，不自己探索或下載。

### macOS

macOS 的安裝由 App 內附的 helper（`src/desktop/electron/mac-update-helper.swift`）執行，App 端在 `src/domain/updates/mac-installer.ts`。兩邊經由 App 旁邊的工作目錄 `.xr-update-<runId>` 溝通。這個目錄只有目前使用者可讀寫，裡面每個檔案都帶這次安裝的 nonce，App 只採信 owner、權限與 nonce 都相符的目錄。目錄同時是這次安裝的 journal：裡面還有尚未處理完的結果時，就不能刪。

1. 準備：App 把更新檔解開到工作目錄、寫入 `request.json`，啟動 helper。helper 回報 `prepared` 才算準備完成；使用者取消時 App 寫入 `abort.json`。
2. 交接：App 寫入 `handoff.json`，helper 回報 `waiting_for_exit` 後舊版 A 結束。helper 等 A 結束後交換 bundle，啟動新版 B。
3. 啟動確認：B 啟動時寫入 `ack.json`。runtime 就緒後，B 讀取 helper 的最終結果（`succeeded`、`rolled_back`、`failed` 或 `recovery_required`），先存進安裝紀錄，存檔成功且結果不是 `recovery_required` 時，才請 helper 清除工作目錄。存檔失敗或結果是 `recovery_required` 時保留工作目錄，下次啟動再處理。B 確認就緒前，App 不把更新記為已安裝。
4. 清除：以 `--cleanup` 請 helper 刪除工作目錄，短暫重試同一個指令。剛結束的 helper 可能在釋放鎖之前才寫下最終結果；每次失敗都保留 journal。

同一次安裝同時只有一個 helper 能處理 journal，由 journal 的鎖保證。B 啟動時若 helper 還沒寫出最終結果，B 先等一下再看，仍沒有結果才以 `--recover` 啟動 helper 補完。拿不到鎖、helper 提早結束，都不代表安裝成功。

B 在確認就緒前啟動失敗時，由 B 自己發起回復：先寫入 `shutdown-safe.json`，表示這個 B 程序已乾淨關閉更新服務與 Collector runtime；再以 `--rollback` 啟動 helper，helper 回報 `rollback_prepared` 後 B 才結束。helper 等這個 B 程序結束，確認回條是它寫的，才把 bundle 換回 A。沒有回條時，helper 回報 `recovery_required`，不強制結束 B、也不還原 A，因為同一個 profile 同時只能有一個 Collector 在執行。`recovery_required` 保留備份，由使用者處理。

### Windows

Windows 由 electron-updater 的 `NsisUpdater` 執行 NSIS 安裝檔（`src/domain/updates/windows-installer.ts`）。服務把已驗證的安裝檔交給 updater 的下載快取，不設定它的 provider。簽章檢查沿用 `NsisUpdater` 的規則，NSIS 開始執行後的安裝結果沒有回呼，由下次啟動核對。

## 驗收身分

同一個 commit 要建立隔離的 A／B 安裝包時，封裝指令接受驗收身分，不修改 `package.json`：

```sh
XR_COLLECTOR_VALIDATION_BUILD=1 npm run package:mac -- \
  --validation-version 0.1.1 \
  --validation-app-id com.xrcollector.verify36 \
  --validation-product-name "XR Update Verify 36" \
  --validation-update-repository derektu/xr-collector-test
```

版本、appId 與產品名稱三個參數必須一起提供，且只有設定 `XR_COLLECTOR_VALIDATION_BUILD=1` 才接受；appId 必須以 `com.xrcollector.verify` 開頭，產品名稱必須以 `XR Update Verify ` 開頭。repository 選用，未提供時是正式的 `derektu/xr-collector`。驗收身分與 repository 寫入 ASAR，所以 Windows shell 或 macOS helper 重開 App、沒有原本的環境變數時，仍使用隔離的資料目錄、App 身分與 repository。正式封裝不帶這些參數，也不能含有這些欄位。

公開更新驗收使用 `XR Update Verify Public`／`com.xrcollector.verify.public` 這組身分，repository 為 `derektu/xr-collector-test`；驗收 App 不發到正式 repository。

驗收可以使用 loopback 來源，但必須使用正式 schema、真實封裝產物及真實原生安裝路徑；模擬的「安裝成功」不算平台驗收。A、B 使用同一個隔離 profile、Vault 與 Agent port，不指向正式資料。原生重啟驗收優先使用驗收產品的預設 profile，把固定 Agent port 與 Vault 選址寫入該 profile，並由同一個登入使用者安裝與更新。以 `XR_COLLECTOR_PROFILE` 覆寫 profile 時，須實測該平台的交接確實保留環境變數；Windows shell 不保留。中斷 helper 後，先等待並盤點作業系統已排隊的啟動，再決定是否手動啟動。
