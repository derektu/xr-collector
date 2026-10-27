# App 更新來源

XR Collector 的更新服務只認一種可攜式契約：#35 `release-index.json` schema 1 所列的固定 manifest 與安裝檔。服務先依目前 `target`、引擎 `variant` 及版本選出候選，再驗證 manifest 和 payload 的大小、SHA-256 與內含 BuildInfo；候選的 payload 必須以同一份描述出現在已驗證 manifest 的產物清單，檔名也必須符合該版本、平台與引擎。檢查、下載及套用是三個分開且由使用者觸發的動作。套用前會保存安裝嘗試，只有新版本的 runtime、畫面與原生啟動確認完成後才記為成功；無法確認時保留 unknown，不用程序退出推測成功。

正式預設來源透過 GitHub 公開 Releases JSON API 讀取最新穩定 release，並只從該 release 尋找 `release-index.json` asset。它不解析 HTML、不使用 token，也不直接信任 latest download URL。開發與公司的鏡像環境可設定 `XR_COLLECTOR_UPDATE_INDEX_URL`，直接提供同一份 schema 1 index；URL 必須是 HTTPS，只有隔離驗收允許 `127.0.0.1` 或 `localhost` 的 HTTP。

公司日後若改用自己的檢查 API，有兩條相容路徑：

1. 最小遷移：在公司的 HTTPS 主機原樣提供 `release-index.json`、manifest 與安裝檔，再把環境設定指向 index。
2. 自訂發現：實作 `UpdateSource`，把公司 API 的結果轉成不可變的 `UpdateOffer`。下載、雜湊驗證、持久 cache、UI／Agent API 與原生安裝器不需要改動。

啟動依賴要特別處理：App 必須先能找到下一份 index，才能透過更新改用新來源。因此來源搬移至少要讓舊 URL 在一個發布週期內仍提供 index，或先發布同時認得新來源的過渡版，再關閉舊來源。不要只在新來源發布一個舊 App 不知道的位置。

驗收可以使用 loopback generic source，但必須使用正式 schema、真實封裝產物及真實原生安裝路徑；不能把模擬的「安裝成功」當成平台驗收。

同一個乾淨 commit 要建立隔離的 A／B 安裝包時，封裝指令接受受限的驗收身分，不必修改正式 `package.json`：

```sh
XR_COLLECTOR_VALIDATION_BUILD=1 npm run package:mac -- \
  --validation-version 0.1.1 \
  --validation-app-id com.xrcollector.verify36 \
  --validation-product-name "XR Update Verify 36"
```

三個 `--validation-*` 參數必須一起提供，且只有明確設定 `XR_COLLECTOR_VALIDATION_BUILD=1` 才接受。正式封裝不帶這些參數，仍固定使用 repo 的版本、appId 與產品名稱。每次啟動驗收 App 另使用專屬 `XR_COLLECTOR_PROFILE`、Vault、Agent port 及 `XR_COLLECTOR_UPDATE_INDEX_URL`，不能指向正式資料。
