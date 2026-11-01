# Vault、資料交換與搜尋

Vault 是正式資料，Meilisearch 是可重建的搜尋投影。本文件描述現行資料責任及恢復邊界；操作步驟見 [README](../README.md)，Round 2 的選址與資料交換目標見 [開發計畫](round-2-plan.md)。

## 保存責任

| 資料 | 位置與交換方式 |
| --- | --- |
| Vault 標記檔 | Vault 根目錄的 `xr-collector-vault.json`；不納入匯出檔 |
| 文件 Markdown | Vault 的 `documents/<來源類型>/<來源 ID>.md`，YouTube 為 `documents/youtube/` |
| 訂閱、各訂閱的收集設定、收集進度與檢查時間、訂閱的移除紀錄 | 每個來源類型一個訂閱檔，位置由 plugin 宣告；YouTube 為 Vault 的 `settings/youtube-channels.json` |
| 自動檢查總開關 | Vault 的 `settings/youtube-schedule.json`，所有來源類型共用 |
| 刪除紀錄 | Vault 的 `settings/deleted-documents.json` |
| 使用者自己放在 Vault 資料夾的其他檔案 | 不屬於知識庫，程式不讀取，也不納入匯出檔 |
| Meilisearch database | 裝置上的搜尋資料目錄；不納入匯出檔 |
| profile、Agent 連線檔與 token | 裝置資料；不納入匯出檔 |
| active Vault 選址 | profile 的 `vault-selection.json`；裝置資料 |
| 收集工作與記錄 | profile 的 `jobs/jobs.json` 與 `jobs/events/<UTC 日期>.jsonl`（較早版本的 `jobs/events.jsonl` 照常讀取）；記錄保留 30 天；裝置資料，不納入匯出檔 |
| 匯入的工作資料夾 | Vault 內的 `.xr-collector-import-<UUID>/`，套用匯入期間存在，供中斷後完成套用 |
| 匯出檔 | 預設匯出目錄（`<文件>/XR Collector 匯出`，可由 `XR_COLLECTOR_EXPORT_DIR` 指定）或使用者選的位置；不屬於任何 Vault |
| 匯入前備份 | 備份目錄（`<文件>/XR Collector 備份`，可由 `XR_COLLECTOR_BACKUP_DIR` 指定）；不屬於任何 Vault |
| 從匯出檔建立知識庫的 journal | profile 的 `vault-import-journal.json`（進行中匯入的暫存資料夾、目標、是否已改名與標記檔雜湊）；裝置資料 |

現行資料使用 Markdown／JSON 與檔案系統，不以 Git 歷史或同步 server 協調 Vault 寫入。同一個 Vault 只由一個程式寫入，外部同步工具不提供多機並行寫入的一致性保證。

## Vault 目錄與選址

每個 Vault 是自成一體的目錄。根目錄的標記檔記錄 `format`（固定為 `xr-collector-vault`）、`formatVersion`、建立時間、建立程式與 `id`（UUID），不含路徑或其他裝置資訊，因此整個目錄複製到另一台電腦後仍是同一份有效 Vault。`id` 在建立與從匯出檔建立時寫入，在 App 外搬動資料夾時隨之保留；匯出檔不含標記檔，所以從匯出檔建立的 Vault 得到新的 `id`。程式只開啟現行格式的 Vault：標記檔有 `id`、`formatVersion` 不高於已登錄來源類型宣告的最高 `vaultFormatVersion`（至少 1），設定檔（各已登錄來源類型的訂閱檔、自動檢查總開關與刪除紀錄）都是現行版本。標記檔沒有 `id`、設定檔是其他版本，或格式版本較新時，Vault 不開啟並說明原因，檔案保持原樣。某個來源類型的文件或訂閱檔第一次寫入 Vault 前（包括匯入帶入這些檔案時），標記檔的 `formatVersion` 提高到該類型宣告的 `vaultFormatVersion`；已經同版或更高時標記檔不變，所以只有 YouTube 的 Vault 維持 1，標記檔逐位元不動。

開啟前先檢查目錄：有效標記檔與現行版本的設定檔構成可開啟的 Vault；其他內容一律不是知識庫。檢查不改動目錄。

建立新 Vault 時，使用者或 Agent 給位置（已存在的資料夾）與名稱，由 App 在位置底下建立名為該名稱的新資料夾，只寫入標記檔。位置下已有同名的檔案或資料夾時不建立，空資料夾也一樣，所以一個位置底下可以放多個知識庫。名稱依 macOS 與 Windows 兩邊的規則檢查（不能為空、不能含 `\ / : * ? " < > |` 與控制字元、開頭和結尾不能是空白、不能以句點開頭或結尾、不能是 `CON`、`NUL`、`COM1` 這類 Windows 保留名稱、不超過 255 bytes），知識庫資料夾因此在兩個平台間複製時名稱不變。新資料夾不能在目前的知識庫或程式資料目錄裡。`POST /api/vault/new/check` 回傳將建立的完整路徑與不能建立的原因，UI 的預覽與 Agent 都用它；建立時 server 再檢查一次。

從 `XR_COLLECTOR_VAULT` 指定的位置啟動時，不存在或空的目錄會直接建立成 Vault，供開發與驗收使用。

收集工作與記錄屬於裝置資料，以 `(vaultId, vaultPath)` 綁定 Vault：工作只有在 ID 與路徑都相符時才列出與接續，所以同一路徑上換成另一份 Vault，或同一份 Vault 被複製到別處，都不會接續原工作；沒有 Vault ID 的工作不屬於任何 Vault。帶 ID 的事件依 ID 歸屬；沒有 ID 的事件依目前路徑歸屬。

裝置在 profile 記錄目前使用的 Vault 絕對路徑。啟動時若該路徑不存在、變成空目錄、無法讀取或格式無效，服務停在 Not Ready 並回報原路徑與原因，不建立替代的空 Vault，也不啟動排程。選址成功後才建立搜尋 process 與排程。同步資料夾視為一般本機目錄；檔案尚未下載而無法讀取時同樣回報原因。

## 刪除文件

刪除紀錄讓使用者刪除的項目不會被訂閱檢查抓回，跟著 Vault 匯出與匯入。

### 刪除紀錄的格式

`settings/deleted-documents.json` 是 `{ "version": 1, "deleted": [...] }`，每筆刪除紀錄有：

| 欄位 | 內容 |
| --- | --- |
| `sourceType`、`sourceId` | 穩定的來源識別，例如 `youtube` 與影片 ID；兩者組成文件 ID `<sourceType>:<sourceId>`，同一項目只有一筆刪除紀錄 |
| `sourceUrl`、`title`、`publisherId`、`publisherName` | 刪除時的來源網址、標題與發布者（`publisherId` 可為 null），供已刪除文件頁與查問題時辨認 |
| `deletedAt` | 刪除意圖成立的時間，與文件 frontmatter 的 `collected_at` 由同一個時鐘產生；匯入合併時是這份文件「已刪除」狀態的時間 |

沒有這個檔案表示沒有刪除紀錄。版本不認得、刪除紀錄格式錯誤或重複時，Vault 視為無法開啟並說明原因，不會忽略刪除紀錄而讓已刪除的文件被收集回來。

### 可見性與刪除流程

一份文件有刪除紀錄，且 `collected_at` 不晚於 `deletedAt`（相同時間算在刪除之前）時，列表、閱讀、來源統計、搜尋、匯出與 Agent API 都把它當作不存在。`collected_at` 缺少或無法解析時無法證明文件較新，同樣視為已刪除。

刪除依序寫入刪除紀錄、移除 Markdown 檔案、讓搜尋排除這份文件；刪除紀錄一寫入，刪除就生效，之後的步驟只是清理。索引項目在背景移除，刪除不等待索引重建；移除失敗時記 `document.index_remove_failed` 警告，搜尋仍排除這份文件。

同一項目的保存、索引更新與刪除依序執行，不會交錯：保存後、索引前被刪除的文件不會寫進索引。

開啟 Vault 時、在搜尋索引與 Vault 比對之前，系統處理停止時留下的狀態，並寫入記錄：

- 有刪除紀錄又有檔案、`collected_at` 不晚於刪除時間：移除檔案（`document.delete_resumed`）。
- 檔案較新：這是明確重新收集已保存的結果，清除刪除紀錄（`document.recollected`）。
- 檔案的 `collected_at` 缺少或無法解析：檔案與刪除紀錄都保留，文件維持隱藏，並記 `document.delete_unresolved` 警告。

### 收集與重新收集

頻道探索把有刪除紀錄的影片當作已收集：它仍是候選、佔數量上限的名額，但不會被收集，也不會由更早的影片遞補。排程、立即檢查、恢復後的檢查、頻道工作重試失敗影片，以及其他沒有明確使用者請求的收集，遇到刪除紀錄時都結束為 `skipped`，`skipReason` 為 `deleted`。影片工作在擷取字幕前就檢查刪除紀錄，被略過的影片不會向 YouTube 取字幕；保存時再檢查一次，涵蓋擷取期間發生的刪除。

只有使用者以單支網址明確提出、且晚於刪除時間的請求可以重新收集。請求時間取使用者最近一次單獨送出這支影片的時間：直接送出影片網址或重試單支影片的工作，以工作接受的時間為準；同一支影片的工作還在排隊或執行時再次單獨送出，或頻道已排入、使用者又單獨送出，以最後一次送出的時間為準。保存時文件的 `collected_at` 晚於 `deletedAt`，寫入檔案後才清除刪除紀錄；收集失敗時刪除紀錄保留。刪除之前接受的工作，即使在重啟後接續，也不會讓文件回來。

## 匯出與匯入

### 匯出檔

匯出檔是 `.zip`：裡面的檔案與它在 Vault 內的相對路徑一一對應，以 deflate 壓縮，另附 `manifest.json`：

```json
{ "format": "xr-collector-package", "formatVersion": 1,
  "exportedAt": "<ISO 時間>", "createdBy": "<程式與版本>",
  "source": { "vaultId": "<UUID>", "machine": "<機器名稱>" },
  "summary": { "documents": 0, "subscriptions": 0, "deletions": 0 },
  "files": [{ "path": "documents/youtube/<來源 ID>.md", "size": 0, "sha256": "<hex>" }] }
```

`formatVersion` 是匯出檔內有文件或訂閱檔的來源類型所宣告的 `packageFormatVersion` 中最高者，至少為 1；只有 YouTube 的匯出檔是 1。讀取時接受 1 到已登錄來源類型宣告的最高版本，較新的版本拒絕匯入。`source` 是匯出的知識庫 ID 與機器名稱，供查問題；匯入只比對檔案本身，文件、訂閱與紀錄各自帶有時間。機器名稱取 `XR_COLLECTOR_MACHINE_NAME`，未設定時取主機名稱（去掉 macOS 的 `.local`）。匯入畫面只顯示檔名與 `exportedAt`；機器名稱、`createdBy` 與 `summary` 留在匯出檔與 API 回應中供查問題，畫面不顯示；讀取時忽略 manifest 中不認得的欄位。實作在 `src/vault/vault-package.ts`，以 `yazl`／`yauzl` 讀寫。

匯出檔只放 Vault 登記的檔案，內容由 Vault 的紀錄決定，不掃描資料夾：

- 文件：`MarkdownVault.list` 列得出、沒有被刪除紀錄隱藏的文件。只有檔名是 `documents/<來源類型>/<來源 ID>.md`（由 `src/vault/document-paths.ts` 依各來源的 ID 規則判斷）的檔案才是文件；這類檔案讀不出文件格式，或 frontmatter 的 ID 與檔名不符時，列表與匯出失敗並指出該檔案。
- 設定：各已登錄來源類型的訂閱檔（YouTube 為 `settings/youtube-channels.json`）、`settings/youtube-schedule.json`、`settings/deleted-documents.json`，存在時才放入。刪除紀錄套用與列表相同的可見性規則：文件較新的刪除紀錄不匯出，所以匯出檔不會同時有一份文件與隱藏它的刪除紀錄。

Vault 資料夾中的其他檔案（使用者的筆記、`.obsidian/` 等）一律不讀取、不打包，也不會讓匯出失敗；匯出只列出檔名計算數量，結果的 `unregisteredFiles` 與記錄註明有多少這類檔案沒有包含，完成畫面不顯示。系統檔（`.DS_Store` 等）、標記檔與匯入的工作資料夾不計入，符號連結不跟隨，無法讀取的資料夾略過。

匯出與匯入都以串流讀寫 zip：匯出逐一把檔案串流寫入 zip，同時計算 SHA-256，最後寫入 manifest；讀取時只讀中央目錄與 manifest，各檔案在需要時才解壓並核對。記憶體只保存 manifest 與正在處理的檔案，匯出檔總大小沒有上限。會整份讀入記憶體檢查的檔案（文件與設定檔）每個最多 64 MiB，manifest 最多 64 MiB。

匯出檔只以本機的完整路徑指定，副檔名必須是 `.zip`。匯出寫到使用者選的位置，或不指定時寫到預設匯出目錄的 `XR Collector 匯出 YYYY-MM-DD.zip`（目錄不存在時建立）；先寫到同一資料夾的暫存檔，完成後改名，所以指定的檔案不是完整的匯出就是保持原樣。匯出只讀取 Vault，不寫入任何檔案。同名檔案存在時回 `file_exists`，經使用者確認才取代。匯出位置不能在目前 Vault 或程式資料目錄內。

匯入讀取匯出檔時拒絕下列情況，不寫入任何資料：不是 `.zip` 或不是 zip、manifest 缺少或格式識別、版本不符；zip 項目與 manifest 列出的檔案不完全一致；路徑不是文件或上述設定檔、不安全（絕對路徑、`..`、反斜線）、重複或只差大小寫；檔案大小或 SHA-256 與 manifest 不符（包含解壓後超過宣告大小的項目）；文件不是其路徑代表的文件、設定檔不是現行版本、訂閱 ID 重複、刪除或移除紀錄格式錯誤，或同一份文件同時有內容與刪除紀錄、同一個訂閱同時存在與有移除紀錄。SHA-256 用於偵測損壞，不是來源簽章。設定檔與文件 frontmatter 中不認得的欄位在匯入後保留。

### 修改時間與刪除狀態

匯入以每個項目的時間決定以哪一邊為準，這些時間由程式記錄並寫進匯出檔，不看檔案系統的修改時間：

| 項目 | 存在時的時間 | 刪除時的狀態與時間 |
| --- | --- | --- |
| 文件 | frontmatter 的 `collector.updated_at`（程式修改文件內容時寫入），沒有時是 `collector.collected_at` | `deleted-documents.json` 的刪除紀錄，時間是 `deletedAt` |
| 訂閱 | `updatedAt`（變更名稱、網址、暫停狀態或收集設定時更新；收集進度與檢查時間不算），沒有時是 `addedAt` | 該來源類型訂閱檔的 `removed` 中的移除紀錄，時間是 `removedAt` |

刪除紀錄與移除紀錄永久保留，否則另一台還留著的文件或訂閱會在下次合併時回來。明確重新收集已刪除的影片時，文件的 `collected_at` 晚於 `deletedAt`，保存後解除刪除紀錄；同一個頻道再次訂閱時解除它的移除紀錄。這兩種情況的新狀態都比紀錄新，帶到另一台時也勝過那邊的紀錄。在程式以外修改文件不留下時間。

### 從匯出檔建立知識庫

Onboarding 的「從匯出檔建立」與 `POST /api/vault/setup` 的 `import` 以同樣的位置與名稱規則建立新的 Vault，名稱預設為匯出檔記錄的來源知識庫資料夾名稱（manifest 的 `source.folderName`）：先確認磁碟放得下匯出檔的檔案（加上原大小 5%、至少 16 MiB 的餘量，不足時回 `insufficient_space`），再解開到同層的 `<目標>.importing-<唯一值>` 暫存資料夾，寫入新的標記檔，profile 的 `vault-import-journal.json` 記下暫存資料夾與目標；改名為目標之前，journal 先記下「已改名」與新標記檔的 SHA-256。之後啟動知識庫、寫入選址，選址寫入後才刪除 journal；搜尋服務無法啟動、選址寫入失敗，或程式在兩者之間停止時，journal 仍在，當下或下次啟動會收回這個資料夾。新 Vault 有自己的知識庫 ID，內容與匯出檔相同；訂閱、收集進度、各訂閱的收集設定與自動檢查開關都照匯出檔帶入；匯出的那台開著自動檢查時，兩台會各自收集同樣的訂閱。完成後直接進入 App。

失敗時目標回到原狀。中途停止時，下次啟動依 journal 收回：刪除名稱符合 `.importing-<唯一值>` 的暫存資料夾；已改名而選址與正在開啟的 Vault 都不是目標時，只有標記檔雜湊相同的目標資料夾會改回暫存名稱並刪除，原本是空資料夾的目標恢復為空資料夾。

## 開啟其他知識庫

開啟其他知識庫的切換以裝置選址 `vault-selection.json`（暫存檔加改名）為唯一提交點。選址寫入前，目前的 Vault 保持使用且不被改動；寫入後切換不回退。切換時停止原 Vault 的排程，把它未完成的工作記為中斷（原因為切換），關閉它的搜尋，再接續新 Vault 未完成的工作並啟動排程。收尾步驟各自失敗只記在程式記錄，切換仍算完成。

開啟其他知識庫只接受既有的 Vault，目前的 Vault、它裡面的資料夾、程式資料目錄內的資料夾、名稱符合 `.importing-<UUID>` 的匯入暫存資料夾、空資料夾與無法辨識的資料夾都拒絕。原 Vault 留在原處，它的工作在下次開啟它時接續。以 `XR_COLLECTOR_VAULT` 啟動時，下次啟動仍開啟那個位置，所以建立或開啟其他知識庫都回 409 `vault_location_fixed`。

要把知識庫放到別的位置，可以匯出後在新位置建立知識庫並以「完全取代」匯入，或在 Finder／檔案總管搬動資料夾後開啟新位置。工作以 `(vaultId, vaultPath)` 綁定，路徑不同時原工作不會接續。

建立與開啟的記錄：`vault.created`、`vault.opened`，以及工作的 `job.interrupted`（`info`）與 `job.resumed`。

## 匯入的比對與套用

匯入只接受本機的 `.zip` 匯出檔，先比對，再由使用者選擇方式套用到目前的 Vault。匯出檔留在原處。

比對逐項進行，項目以 `document:<文件 ID>` 與 `subscription:<來源類型>:<訂閱 ID>` 為鍵，每個項目在一邊是存在、已刪除或沒有。兩邊都存在時比較內容：文件比較 metadata 與正文，忽略 `collector.collected_at` 與 `collector.updated_at`，所以兩台各自收到同一支影片時內容相同；訂閱比較名稱、網址、暫停狀態與收集設定。合併的規則是較新的狀態為準：

| 本機 | 匯出檔 | 合併的結果 |
| --- | --- | --- |
| 沒有 | 存在 | 新增 |
| 沒有 | 已刪除 | 記下刪除紀錄，不計入數量 |
| 任何狀態 | 沒有 | 保留本機 |
| 存在 | 存在且內容相同 | 不處理，時間不同也一樣 |
| 存在或已刪除 | 狀態不同且時間較新 | 採用匯出檔：更新、刪除或恢復 |
| 已刪除 | 已刪除且時間較新 | 改用匯出檔的紀錄，不計入數量 |
| 存在或已刪除 | 時間較舊或相同 | 保留本機 |

缺少或無法解析的時間視為最舊。預覽回傳 `merge` 與 `replace`：合併與完全取代各自會做的變更，分文件與訂閱，各有新增、更新、刪除的數量；以及 `localNewer`：兩邊不同而合併保留本機的項目數，包含只有本機有的項目，不含兩邊都不存在、只有紀錄不同的項目；以及 `mergeRecords`：合併仍有不計入數量的刪除紀錄要寫入。畫面以「新增 5 份文件、1 個訂閱；更新 2 份文件；刪除 1 份文件」的形式顯示合併的數量，選取「完全取代」時在選項下列出會移除的數量；合併沒有變更時顯示「沒有需要匯入的內容」，`localNewer` 大於 0 時列出「本機有 N 項較新的修改或刪除」並提供「完全取代…」；`mergeRecords` 為 true 時，按「完成」會套用合併寫入這些刪除紀錄，畫面不變，避免那些影片之後再被收集、在下次匯入時回到另一台。匯出檔的機器名稱只出現在 API 回應與記錄。

套用有兩種方式：

- 合併（`merge`）：依上表逐項處理。沒有變更時不能合併。
- 完全取代（`replace`）：文件、訂閱、刪除紀錄與移除紀錄都與匯出檔一致，本機有、匯出檔沒有的文件與訂閱移除，不另外留下紀錄。用來回到某份匯出檔的內容，例如匯入前備份。與匯出檔完全相同時不能取代。

文件採用匯出檔時寫入文件並解除本機的刪除紀錄，或改為匯出檔的刪除紀錄並移除文件，或兩者都移除；訂閱採用匯出檔時套用名稱、網址、暫停狀態與收集設定並解除本機的移除紀錄，或改為匯出檔的移除紀錄並移除訂閱。既有訂閱保留本機的收集進度（加入時間、上次檢查時間、`outOfRange`、`failures`），下一次檢查從匯入後起算；本機沒有的訂閱連同匯出檔的收集進度加入。自動檢查總開關屬於目前的 Vault，合併與取代都不改變。設定檔中不認得的頂層欄位保留。來源 ID 只差大小寫的文件無法在不分大小寫的磁碟上並存，出現時拒絕匯入。

套用前重新比對：本機項目或匯出檔與比對時不同時，要求重新選擇匯出檔。訂閱的收集進度與檢查時間不是項目，比對後排程照常檢查不會讓比對失效。

套用計畫同時列出會被覆蓋或移除的本機文件（`displaced`，附原因：被較新的版本取代或被刪除）；把檔案放到位是唯一讓這些版本離開 Vault 的步驟。

### 匯入前備份

套用寫入任何檔案前，先把目前的 Vault 匯出到備份目錄的 `匯入前備份 YYYY-MM-DD HHmmss.zip`（同名時加上編號，目錄不存在時建立）。備份目錄與匯出目錄分開，匯出時選檔的位置不會混入備份。備份的位置記在記錄與 `result.backupPath`，完成畫面不顯示。寫不出來時匯入中止，Vault 不變。匯入選錯檔案時，匯入這份備份：本機的內容都比它新，合併沒有需要匯入的內容，選擇「完全取代…」即回到匯入前的內容。

### 原地套用與中斷恢復

匯入在 Vault 內的工作資料夾 `.xr-collector-import-<UUID>/` 進行：確認磁碟放得下要寫入的檔案後，先把所有新檔案（文件與改寫的設定檔）放進 `files/`，再寫入 `journal.json`，列出每個路徑要放入的檔案或要移除；寫入 journal 是提交點。之後依序以同一磁碟內的改名把檔案放到位，完成後刪除工作資料夾。每個路徑在任一時刻都是舊檔或新檔。

套用中途失敗時立即依 journal 完成剩下的步驟，完成後全量重建搜尋索引並回報匯入完成；程式中途停止時，下次開啟 Vault（啟動時開啟或「開啟其他知識庫」）前完成：有 journal 的工作資料夾逐項完成並重建搜尋索引，沒有 journal 的工作資料夾直接刪除，Vault 保持匯入前的內容。因此 Vault 只會是匯入前或匯入後的完整內容。若完成剩下的步驟也失敗，寫入與排程保持停止，狀態回 `vault_busy`，重新啟動時完成匯入。套用期間文件與搜尋 API 回 409 `vault_busy`，狀態、工作與記錄仍可查詢。

### 操作期間的收集

匯出、匯入比對、匯入套用、建立新的知識庫與開啟其他知識庫期間，程式阻止衝突寫入：開始時先停止派出新的收集步驟，等待執行中的步驟與排程檢查完成。等待期間狀態為 `waiting`，可以取消：不寫入任何資料，狀態回到 `idle`。等待超過 2 分鐘時放棄該操作並回報 `vault_busy`，收集照常繼續；匯出與比對直接以 409 回應，匯入套用已先回 202，失敗記在狀態的 `errorCode`。排隊工作在操作期間不開始，結束後接續；匯入完成後重新載入訂閱，被匯入移除的訂閱，其排隊中的檢查不再執行。

### 訂閱設定檔

每個有訂閱的來源類型在 plugin 的 `storage` 宣告訂閱檔位置、版本與清單欄位名稱；檔案格式都是 `{ "version": <版本>, "<清單欄位>": [...], "removed": [...] }`。`removed` 是移除紀錄 `{ "id", "title", "url", "removedAt" }`，沒有移除紀錄時省略。每個訂閱帶 `settings`（該來源類型的收集設定）、`lastCheckedAt`、`outOfRange`（可省略，超出收集範圍的項目與當時的範圍起點）、`failures`（可省略，檢查中收集失敗的項目：鍵、標題、已試次數、錯誤碼、最後失敗時間與是否已略過；失敗滿 3 次或屬不重試的錯誤時略過，之後的檢查不再收集，成功收集或離開範圍後移除）、`nextCheckAt` 與 `lastDispatchedAt`。訂閱與檔案中不認得的欄位照原樣讀取與保存。其他版本的檔案不讀取：開啟 Vault 與讀取匯出檔時都拒絕並說明原因。

YouTube 與 RSS 的 `settings` 都是 `intervalMinutes`（檢查頻率的分鐘數）、`backfillDays`（每次檢查往前涵蓋的天數，1–60 的整數）、`backfillMaxItems`（每次檢查的數量上限，1–100 的整數）；任一筆訂閱的設定不符合時，整個檔案不讀取。

YouTube 的訂閱檔是 `youtube-channels.json`，版本 3，清單欄位是 `channels`；`outOfRange` 的項目以 `videoId` 記錄，已不使用的 `cursor` 照原樣保存。RSS 的訂閱檔是 `rss-subscriptions.json`，版本 2，清單欄位是 `subscriptions`，`outOfRange` 與 `failures` 的項目以 `articleKey` 記錄。`youtube-schedule.json` 是 `{ "version": 2, "enabled": <boolean> }`，涵蓋所有來源類型的訂閱。

## 搜尋投影

收集先保存 Markdown，再更新索引。索引失敗不刪除已保存文件；列表與全文可從 Vault 讀取，搜尋依索引狀態回報結果或錯誤。合併匯入只對寫入或移除的文件更新索引；完全取代與中斷後完成的匯入從 Vault 全量重建。匯入的檔案都已到位後，更新索引或重新載入訂閱失敗時改為全量重建；重建也失敗時匯入仍算完成，狀態為 `completed`、`result.searchRebuildNeeded` 為 true，狀態訊息為「匯入已完成，搜尋索引需要重建」，完成畫面提示到設定按「重建索引」；重新啟動程式時搜尋服務也會發現索引與 Vault 不符而重建。從匯出檔建立的 Vault 開啟時建立自己的索引。

索引名稱帶 schema 版本（`documents_v3`）；schema 改變時使用新名稱並從 Vault 全量重建。每筆索引文件的 key 是完整文件 ID 的 base64url 編碼，不同來源類型即使來源內 ID 相同也不會互相覆寫。來源篩選使用 `sourceType` 與 `publisherId`；頻道名稱只供顯示與搜尋，不作篩選條件。

搜尋索引另存 title、publisher name 與 body 的正規化投影；Vault 與回傳的 metadata、Reader 內文、摘要文字都保留原文。文件與 query 共用固定順序：完整 Unicode NFKC、ASCII A–Z 小寫、OpenCC `s2t`、OpenCC `t2tw`、`臺` 轉 `台`，最後把 Unicode `White_Space` 連續區段收成一個 ASCII 空格並去掉頭尾空白。OpenCC 使用固定的純 JavaScript `opencc-js` 1.4.2 及其內嵌字典，不需要平台 binary 或執行時下載；不使用 `s2twp`，因此不做「服务器／伺服器」這類地區用詞替換。filter ID、日期、URL 與文件 ID 不經正規化。命中位置以正規化文字的 UTF-8 byte offset 映回原文後才產生 `<mark>` 摘要。

中文引擎從 App 的獨立 COCT 主詞庫資源建立 Jieba 第一輪詞界，不把詞庫編入 Meilisearch binary，也不作搜尋用的二次拆詞。啟動先核對 provenance manifest、檔案 SHA-256、UTF-8 與正整數詞頻格式，再讓引擎實際初始化中文 tokenizer；資源不完整時搜尋維持不可用。詞庫身分與查詢策略都在搜尋 profile，換檔後從 Vault 重建投影，不需要重建相同的通用引擎 binary。

查詢以相同 COCT 詞頻執行 Jieba 加權路徑；COCT 辨識的多詞維持 AND，相鄰未知單字組成的短片段即使跨 COCT 詞界也維持逐字連續，引號內文字整段連續。每個中文片段必須在同一個正規化欄位逐字相鄰，可位於較長詞內，但不能跨空白、標點或欄位。Meilisearch 的合格 primary 排序優先，片段補回結果按 Vault 順序穩定接續；純 Latin 沿用引擎查詢，中英混合由引擎處理 Latin typo／prefix，再驗中文連續性。衍生的 normalized fields 與 unique-character postings 只存在 Node 記憶體，從 Vault 重建並在增刪成功後同步；任何同步或重建失敗都不提供 stale-ready 搜尋。

來源專屬的欄位放在以來源類型為名的區塊，由 plugin 的 frontmatter codec 讀出，例如 YouTube 文件的 `youtube` 區塊含字幕語言與種類。每筆索引文件帶有其 metadata、來源專屬區塊與正文的內容雜湊，欄位順序固定，雜湊只隨內容改變；`tests/search/indexed-document.test.ts` 固定了一份 YouTube 文件的雜湊值。啟動時逐筆比對索引與 Vault 的文件 ID 及雜湊，集合或任一雜湊不同就從 Vault 全量重建，因此篇數相同但內容或身分不同時也會重建；完全一致時沿用持久化索引。全量重建完成的時間記錄在裝置的搜尋資料旁（`<搜尋資料目錄>-state.json`），供設定頁與 `GET /api/search/status` 顯示。這項比對只在啟動時進行；執行期間的收集逐筆更新索引。

刪除文件時，文件 ID 先加入待移除清單，再在背景從索引刪除。搜尋時清單內的 ID 以引擎篩選條件排除，結果與總數都不含已刪除文件。索引刪除失敗時 ID 留在清單，下一次索引異動時再刪除；清單超過 100 筆時改為從 Vault 全量重建，篩選條件因此維持在固定長度內。清單只存在於執行中的程序；重新啟動後，啟動時的比對會發現索引多出已刪除的文件並全量重建，重建完成前搜尋不提供結果。

Meilisearch 的 dump／snapshot 是引擎運維產物，不是匯出檔，不作為 Collector 跨機資料交換格式。
