# App 更新來源

XR Collector 的更新服務只認一種可攜式契約：#35 `release-index.json` schema 1 所列的固定 manifest 與安裝檔。服務先依目前 `target`、引擎 `variant` 及版本選出候選，再驗證 manifest 和 payload 的大小、SHA-256 與內含 BuildInfo；候選的 payload 必須以同一份描述出現在已驗證 manifest 的產物清單，檔名也必須符合該版本、平台與引擎。檢查、下載及套用是三個分開且由使用者觸發的動作。套用前會保存安裝嘗試，只有新版本的 runtime、畫面與原生啟動確認完成後才記為成功；無法確認時保留 unknown，不用程序退出推測成功。

版本更新不送作業系統通知。可用版本、下載、等待與安裝結果只透過設定頁、側欄、原生選單、裝置更新 API 及持久事件呈現；Windows 第一次關閉視窗的系統匣提示是獨立的關窗行為。

正式預設來源透過 GitHub 公開 Releases JSON API 讀取最新穩定 release，並只從該 release 尋找 `release-index.json` asset。它不解析 HTML、不使用 token，也不直接信任 latest download URL。開發與公司的鏡像環境可設定 `XR_COLLECTOR_UPDATE_INDEX_URL`，直接提供同一份 schema 1 index；URL 必須是 HTTPS，只有隔離驗收允許 `127.0.0.1` 或 `localhost` 的 HTTP。

公司日後若改用自己的檢查 API，有兩條相容路徑：

1. 最小遷移：在公司的 HTTPS 主機原樣提供 `release-index.json`、manifest 與安裝檔，再把環境設定指向 index。
2. 自訂發現：實作 `UpdateSource`，把公司 API 的結果轉成不可變的 `UpdateOffer`。下載、雜湊驗證、持久 cache、UI／Agent API 與原生安裝器不需要改動。

來源在 Electron 啟動入口組裝，`XR_COLLECTOR_UPDATE_INDEX_URL` 是啟動時覆寫。Windows installer 透過登入桌面的 shell 重開 App，不保證承繼啟動腳本的環境變數；公司的發行版本應在組裝入口選用公司的預設 adapter，或由部署環境持續提供來源設定。

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

公開更新驗收固定使用兩個彼此隔離、A／B 版本內一致的身分：中文版為 `XR Update Verify Chinese`／`com.xrcollector.verify.public.chinese`，官方 engine 版為 `XR Update Verify Official`／`com.xrcollector.verify.public.official`；兩者的 repository 都是 `derektu/xr-collector-test`。發布候選會從實際 ASAR 讀回這三項身分，並和四份 private handoff、GitHub Release URL 與 publisher 的 `--repo` 交叉核對，不接受把驗收 App 發到正式 repository，或把不同 variant 的 package 混在一起。

驗收 A、B 使用同一個隔離 profile、Vault 與 Agent port，不能指向正式資料。原生重啟驗收優先使用唯一驗收產品的預設 profile，將固定 Agent port 與 Vault 選址寫入該 profile，並由同一個登入使用者安裝與更新。使用 `XR_COLLECTOR_PROFILE` 覆寫時，須實測該平台交接確實保留環境；不能假定 Windows shell 會保留。中斷 helper 後先等待並盤點作業系統已排隊的啟動，再決定是否手動啟動。
