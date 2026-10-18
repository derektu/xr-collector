# Vault、資料交換與搜尋

Vault 是正式資料，Meilisearch 是可重建的搜尋投影。本文件描述現行資料責任及恢復邊界；操作步驟見 [README](../README.md)，Round 2 的選址、安全搬移與資料交換目標見 [開發計畫](round-2-plan.md)。

## 保存責任

| 資料 | 位置與交換方式 |
| --- | --- |
| Vault 標記檔 | Vault 根目錄的 `xr-collector-vault.json`；不納入 Vault 資料包 |
| YouTube Markdown | Vault 的 `documents/youtube/` |
| 訂閱、各訂閱的收集設定、收集進度與檢查時間 | Vault 的 `settings/youtube-channels.json` |
| 自動收集總開關 | Vault 的 `settings/youtube-schedule.json` |
| 刪除紀錄 | Vault 的 `settings/deleted-documents.json` |
| 使用者自己放在 Vault 資料夾的其他檔案 | 不屬於知識庫，程式不讀取，也不納入 Vault 資料包 |
| Meilisearch database | 裝置上的搜尋資料目錄；不納入 Vault 資料包 |
| profile、Agent 連線檔與 token | 裝置資料；不納入 Vault 資料包 |
| active Vault 選址 | profile 的 `vault-selection.json`；裝置資料 |
| 收集工作與活動記錄 | profile 的 `jobs/jobs.json` 與 `jobs/events/<UTC 日期>.jsonl`（較早版本的 `jobs/events.jsonl` 照常讀取）；活動記錄保留 30 天；裝置資料，不納入 Vault 資料包 |
| 合併 journal 與合併前備份 | Vault 旁的操作資料，供失敗恢復使用 |
| 上次匯出時間與還原 journal | profile 的 `vault-exports.json`（依 Vault 路徑記錄）與 `vault-restore-journal.json`（進行中還原的暫存資料夾、目標、是否已改名與標記檔雜湊）；裝置資料 |
| 搬移 journal 與歷史位置 | profile 的 `vault-move-journal.json`（進行中搬移的 Vault ID、原位置、目標、暫存資料夾、階段、標記檔雜湊與待刪名稱）與 `vault-locations.json`（每個 Vault ID 搬移前的位置，每份最多 20 筆）；裝置資料 |

現行資料使用 Markdown／JSON 與檔案系統，不以 Git 歷史或同步 server 協調 Vault 寫入。同一個 Vault 只由一個程式寫入，外部同步工具不提供多機並行寫入的一致性保證。

## Vault 目錄與選址

每個 Vault 是自成一體的目錄。根目錄的標記檔記錄 `format`（固定為 `xr-collector-vault`）、`formatVersion`、建立時間、建立程式與 `id`（UUID），不含路徑或其他裝置資訊，因此整個目錄複製到另一台電腦後仍是同一份有效 Vault。`id` 在建立與還原時寫入，搬移時保留；資料包不含標記檔，所以每次還原得到新的 `id`。程式只開啟現行格式的 Vault：標記檔有 `id`、`formatVersion` 不高於自身支援的版本，三個設定檔都是現行版本。標記檔沒有 `id`、設定檔是其他版本，或格式版本較新時，Vault 不開啟並說明原因，檔案保持原樣。

開啟前先檢查目錄：有效標記檔與現行版本的設定檔構成可開啟的 Vault；不存在（上層目錄存在）或只含 `.DS_Store`、`Thumbs.db` 等系統檔的目錄可以建立新 Vault；其他內容一律視為無法辨識。檢查不改動目錄，建立 Vault 只寫入標記檔。

收集工作與活動記錄屬於裝置資料，以 `(vaultId, vaultPath)` 綁定 Vault：工作只有在 ID 與路徑都相符時才列出與接續，所以同一路徑上換成另一份 Vault，或同一份 Vault 被複製到別處，都不會接續原工作；沒有 Vault ID 的工作不屬於任何 Vault。帶 ID 的事件依 ID 歸屬；沒有 ID 的事件依目前路徑與這份 Vault 搬移前的位置歸屬。

裝置在 profile 記錄目前使用的 Vault 絕對路徑。啟動時若該路徑不存在、變成空目錄、無法讀取或格式無效，服務停在 Not Ready 並回報原路徑與原因，不建立替代的空 Vault，也不啟動排程。選址成功後才建立搜尋 process 與排程。同步資料夾視為一般本機目錄；檔案尚未下載而無法讀取時同樣回報原因。

## 刪除文件

刪除紀錄讓使用者刪除的項目不會被自動收集抓回，跟著 Vault 備份、還原與合併。

### 刪除紀錄的格式

`settings/deleted-documents.json` 是 `{ "version": 1, "deleted": [...] }`，每筆刪除紀錄有：

| 欄位 | 內容 |
| --- | --- |
| `sourceType`、`sourceId` | 穩定的來源識別，例如 `youtube` 與影片 ID；兩者組成文件 ID `<sourceType>:<sourceId>`，同一項目只有一筆刪除紀錄 |
| `sourceUrl`、`title`、`publisherId`、`publisherName` | 刪除時的來源網址、標題與發布者（`publisherId` 可為 null），供合併差異與已刪除文件頁顯示 |
| `deletedAt` | 刪除意圖成立的時間，與文件 frontmatter 的 `collected_at` 由同一個時鐘產生 |

沒有這個檔案表示沒有刪除紀錄。版本不認得、刪除紀錄格式錯誤或重複時，Vault 視為無法開啟並說明原因，不會忽略刪除紀錄而讓已刪除的文件被收集回來。

### 可見性與刪除流程

一份文件有刪除紀錄，且 `collected_at` 不晚於 `deletedAt`（相同時間算在刪除之前）時，列表、閱讀、來源統計、搜尋、匯出與 Agent API 都把它當作不存在。`collected_at` 缺少或無法解析時無法證明文件較新，同樣視為已刪除。

刪除依序寫入刪除紀錄、移除 Markdown 檔案、讓搜尋排除這份文件；刪除紀錄一寫入，刪除就生效，之後的步驟只是清理。索引項目在背景移除，刪除不等待索引重建；移除失敗時記 `document.index_remove_failed` 警告，搜尋仍排除這份文件。

同一項目的保存、索引更新與刪除依序執行，不會交錯：保存後、索引前被刪除的文件不會寫進索引。

開啟 Vault 時、在搜尋索引與 Vault 比對之前，系統處理停止時留下的狀態，並寫入活動記錄：

- 有刪除紀錄又有檔案、`collected_at` 不晚於刪除時間：移除檔案（`document.delete_resumed`）。
- 檔案較新：這是明確重新收集已保存的結果，清除刪除紀錄（`document.recollected`）。
- 檔案的 `collected_at` 缺少或無法解析：檔案與刪除紀錄都保留，文件維持隱藏，並記 `document.delete_unresolved` 警告。

### 收集與重新收集

頻道探索把有刪除紀錄的影片當作已收集：它仍是候選、佔數量上限的名額，但不會被收集，也不會由更早的影片遞補。排程、立即檢查、恢復後的檢查、頻道工作重試失敗影片，以及其他沒有明確使用者請求的收集，遇到刪除紀錄時都結束為 `skipped`，`skipReason` 為 `deleted`。影片工作在擷取字幕前就檢查刪除紀錄，被略過的影片不會向 YouTube 取字幕；保存時再檢查一次，涵蓋擷取期間發生的刪除。

只有使用者以單支網址明確提出、且晚於刪除時間的請求可以重新收集。請求時間取使用者最近一次單獨送出這支影片的時間：直接送出影片網址或重試單支影片的工作，以工作接受的時間為準；同一支影片的工作還在排隊或執行時再次單獨送出，或頻道已排入、使用者又單獨送出，以最後一次送出的時間為準。保存時文件的 `collected_at` 晚於 `deletedAt`，寫入檔案後才清除刪除紀錄；收集失敗時刪除紀錄保留。刪除之前接受的工作，即使在重啟後接續，也不會讓文件回來。

## 匯出與還原

`.xr-vault` 是 zip 資料包：裡面的檔案與它在 Vault 內的相對路徑一一對應，以 deflate 壓縮，另附 `manifest.json`：

```json
{ "format": "xr-collector-package", "formatVersion": 1,
  "exportedAt": "<ISO 時間>", "createdBy": "<程式與版本>",
  "summary": { "documents": 0, "subscriptions": 0, "deletions": 0 },
  "files": [{ "path": "documents/youtube/<來源 ID>.md", "size": 0, "sha256": "<hex>" }] }
```

`exportedAt`、`createdBy` 與 `summary` 只供比對畫面顯示，合併前備份不帶這些欄位；讀取時忽略 manifest 中不認得的欄位。實作在 `src/vault/vault-package.ts`，以 `yazl`／`yauzl` 讀寫。

資料包只放 Vault 登記的檔案，內容由 Vault 的紀錄決定，不掃描資料夾：

- 文件：`MarkdownVault.list` 列得出、沒有被刪除紀錄隱藏的文件。只有檔名是 `documents/<來源類型>/<來源 ID>.md`（由 `src/vault/document-paths.ts` 依各來源的 ID 規則判斷）的檔案才是文件；這類檔案讀不出文件格式，或 frontmatter 的 ID 與檔名不符時，列表與匯出失敗並指出該檔案。
- 設定：`settings/youtube-channels.json`、`settings/youtube-schedule.json`、`settings/deleted-documents.json`，存在時才放入。刪除紀錄套用與列表相同的可見性規則：文件較新的刪除紀錄不匯出，所以資料包不會同時有一份文件與隱藏它的刪除紀錄。

Vault 資料夾中的其他檔案（使用者的筆記、`.obsidian/` 等）一律不讀取、不打包，也不會讓匯出失敗；匯出只列出檔名計算數量，結果的 `unregisteredFiles` 與完成畫面註明有多少這類檔案沒有包含。系統檔（`.DS_Store` 等）與標記檔不計入，符號連結不跟隨，無法讀取的資料夾略過。

匯出、還原與合併比對都以串流讀寫 zip：匯出逐一把檔案串流寫入 zip，同時計算 SHA-256，最後寫入 manifest；讀取時只讀中央目錄與 manifest，各檔案在需要時才解壓並核對。記憶體只保存 manifest 與正在處理的檔案，資料包總大小沒有上限。會整份讀入記憶體檢查的檔案（文件與設定檔）每個最多 64 MiB，manifest 最多 64 MiB。

還原與合併讀取資料包時拒絕下列情況，不寫入任何資料：不是 zip、manifest 缺少或格式識別、版本不符；zip 項目與 manifest 列出的檔案不完全一致；路徑不是文件或三個設定檔、不安全（絕對路徑、`..`、反斜線）、重複或只差大小寫；檔案大小或 SHA-256 與 manifest 不符（包含解壓後超過宣告大小的項目）；文件不是其路徑代表的文件、設定檔不是現行版本、訂閱 ID 重複、刪除紀錄格式錯誤，或同一份文件同時有內容與刪除紀錄。合併失敗時復原用的合併前資料包只核對檔案與 manifest，不檢查文件與刪除紀錄是否一致，復原一定能還原合併前的檔案。SHA-256 用於偵測損壞，不是來源簽章。設定檔與文件 frontmatter 中不認得的欄位在還原與合併後保留。

HTTP 以 `application/octet-stream` 送來的資料包先串流寫入 profile 的 `transfers/` 暫存檔，比對結束或還原結束後刪除；不帶 body 的匯出同樣先寫入這裡，回應送完後刪除。程式啟動時清空這個資料夾。

還原在使用者指定的資料夾（不存在或為空，不在目前 Vault 或 profile 內）建立獨立 Vault：先確認目標磁碟放得下資料包的檔案（與搬移相同，加上原大小 5%、至少 16 MiB 的餘量，不足時回 `insufficient_space`），再解開到同層的 `<目標>.restoring-<唯一值>` 暫存資料夾並寫入新的標記檔，profile 的還原 journal 記下暫存資料夾與目標；改名為目標之前，journal 先記下「已改名」與新標記檔的 SHA-256。之後建立搜尋索引、寫入選址，選址寫入後刪除 journal，再切換 active Vault。切換前失敗時目標回到原狀、原 Vault 與選址不變。中途停止時，下次開啟 Vault 前依 journal 收回：刪除名稱符合 `.restoring-<唯一值>` 的暫存資料夾；已改名而選址與正在開啟的 Vault 都不是目標時，只有標記檔雜湊相同的目標資料夾會改回暫存名稱並刪除，原本是空資料夾的目標恢復為空資料夾。選址寫入後，切換的收尾（啟動新 Vault 的排程、關閉原 Vault 的排程、工作與搜尋）各自失敗只記錄在程式記錄，還原仍算完成；原 Vault 未完成的收集工作一律記為中斷，原因是切換到還原的知識庫，之後開啟原 Vault 時接續。新 Vault 沒有收集工作。還原保存訂閱、收集進度與各訂閱的收集設定，但自動收集暫停；再次開啟由使用者操作。

匯出、比對、合併、還原、搬移與開啟其他知識庫期間，程式阻止衝突寫入：開始時先停止派出新的收集步驟，等待執行中的步驟與排程檢查完成。等待期間狀態為 `waiting`，可以取消：不寫入任何資料，狀態回到 `idle`。等待超過 2 分鐘時放棄該操作並回報 `vault_busy`，收集照常繼續；匯出與比對直接以 409 回應，還原與套用合併已先回 202，失敗記在狀態的 `errorCode`。排隊工作在操作期間不開始，結束後接續。

## 搬移與切換知識庫

搬移、開啟其他知識庫與還原的收尾共用同一個切換流程：裝置選址 `vault-selection.json`（暫存檔加改名）是唯一提交點。選址寫入前，目前的 Vault 保持使用且不被改動；寫入後切換不回退。切換時停止原 Vault 的排程，把它未完成的工作記為中斷（原因為搬移或切換），關閉它的搜尋，再接續新 Vault 未完成的工作並啟動排程。收尾步驟各自失敗只記在程式記錄，切換仍算完成。

搬移目標在取得操作鎖之前檢查，被拒絕時收集不中斷。目標須為絕對路徑，不存在（上層存在且可寫入）或為空資料夾（忽略 `.DS_Store` 等系統檔）。以 realpath 解開上層後比對：與原 Vault 相同、位於原 Vault 內、包含原 Vault、位於程式資料目錄內，或寫出的路徑或解開後的路徑有任一上層是 Vault，都拒絕；名稱符合 `.moving-<UUID>`、`.moved-<UUID>`、`.restoring-<UUID>` 的暫存資料夾也拒絕（還原目標相同）；不分大小寫的磁碟上只差大小寫視為同一位置。目標本身是符號連結時拒絕，上層經過符號連結可以接受。原 Vault 內有符號連結或特殊檔案時拒絕並列出相對路徑：複製連結會帶入 Vault 外的資料或遺漏它指向的內容。檢查遇到權限等檔案系統錯誤時回 400 `invalid_request`；搬移或其他知識庫操作進行中時回 409 `vault_busy`。對話框連續輸入時，Vault 大小沿用 60 秒內的掃描結果，搬移開始時再重新掃描。可用空間以 `statfs` 讀取最近的現存上層，須不少於原 Vault 大小加安全餘量；餘量是原大小的 5%，至少 16 MiB，不足時回 507 `insufficient_space`。以 `XR_COLLECTOR_VAULT` 啟動時，下次啟動仍開啟那個位置，所以搬移與開啟其他知識庫都回 409 `vault_location_fixed`。

搬移一律複製：

1. 停止派工並等待執行中的步驟（與其他資料交換相同，最多 2 分鐘、可取消）；排隊工作保留。
2. 在 profile 寫入搬移 journal，複製到目標旁的 `<目標>.moving-<UUID>`，保留檔案權限與修改時間。
3. 逐項比對路徑、大小與 SHA-256；不一致時放棄搬移。
4. 再檢查目標，在 journal 記下 `placed` 與標記檔雜湊，在同一磁碟區內把暫存資料夾改名為目標。跨磁碟區與同磁碟區走同一流程。
5. 在新位置建立獨立搜尋索引並讀取訂閱與排程設定。
6. 寫入選址（提交點），journal 記下 `switched`；工作改綁新路徑，在新執行世代以同一個 job ID 接續。
7. 清理原位置：先整個改名為 `<原路徑>.moved-<UUID>` 並記入 journal，再遞迴刪除。原位置因此要嘛是完整的 Vault，要嘛已不存在，刪到一半的內容只留在待刪名稱下。全部完成後刪除 journal。

提交前失敗時原 Vault 與選址不變：暫存資料夾與已放置的目標收回（原為空資料夾的目標恢復為空資料夾，包括已刪除空資料夾但尚未改名的情況），新搜尋資料庫刪除，收集恢復，狀態為 `error`，活動記錄 `vault.move_failed`。提交後清理失敗時新 Vault 照常使用、不回退，結果帶 `leftoverPath`，活動記錄 warning `vault.move_cleanup_failed`。

程式在開啟 Vault 前依 journal 與選址恢復中斷的搬移。選址仍是原位置時視為未提交：刪除名稱符合 `.moving-<UUID>` 的暫存資料夾，已放置的目標只有在標記檔雜湊相符時才收回，刪除新搜尋資料庫，開啟原 Vault 並接續中斷工作。選址已是新位置或 journal 已到 `switched` 時視為已提交：補做工作改綁、記錄歷史位置、沿用匯出時間並刪除原位置的搜尋資料庫（與搬移完成時同一段收尾），再重試刪除待刪資料夾；journal 記了待刪名稱但改名沒有發生時，原位置仍帶相同 ID 就重做改名與刪除，失敗則回報殘留路徑。原位置或待刪資料夾正是選址或要開啟的 Vault 時，只刪除 journal，不改綁工作也不刪任何資料夾；原位置已換成其他 Vault 時同樣不動它。以 `XR_COLLECTOR_VAULT` 固定位置啟動時無法判斷哪一邊在使用中，搬移 journal 原樣保留並記錄 warning `vault.move_pending`，留待下次一般啟動處理。journal 指向不符命名規則或標記檔的資料夾時，程式只刪除 journal。

開啟其他知識庫只接受既有的 Vault，目前的 Vault、它裡面的資料夾、程式資料目錄內的資料夾、搬移與還原的暫存資料夾、空資料夾與無法辨識的資料夾都拒絕。開啟或還原切換到的 Vault 是未完成搬移的原位置時（例如清理失敗後留下的原 Vault），搬移 journal 隨即刪除，之後不會再清除那個位置。原 Vault 不搬動，它的工作在下次開啟它時接續。在 Finder 或檔案總管手動搬移 Vault 後再開啟新位置，路徑不同，原工作不會接續。

搬移、開啟與還原的活動記錄：`vault.move_started`、`vault.moved`、`vault.move_failed`、`vault.move_cleanup_failed`、`vault.opened`、`vault.restored`，以及工作的 `job.interrupted`（`info`）與 `job.resumed`。

## 合併與恢復

先預覽，再由使用者逐項決定差異。相同項目跳過、新項目加入、來源缺少的本機項目保留；時間戳不自動決定覆寫。匯入包缺少某份文件不表示刪除。

刪除紀錄以文件 ID 比對，列為 `deletion` 類項目：一方有記錄、另一方有同一份文件時是衝突，只列這一項，不另列文件項目；採用匯入的記錄會移除本機文件與索引項目並加入記錄，採用匯入的文件會寫入文件、清除本機記錄並建立索引。只有匯入包有記錄、本機沒有這份文件時，記錄直接加入；兩邊都有記錄時相同。合併移除的文件在套用失敗時與其他檔案一起從合併前資料包復原。頻道以 ID 比對，名稱、網址、暫停狀態或收集設定不同即列為該訂閱的衝突；收集進度與檢查時間不算差異。採用匯入的訂閱時套用這些欄位，收集進度（加入時間、上次檢查時間、`outOfRange`）保留本機，下一次檢查從合併後起算；本機沒有的訂閱連同匯入的收集進度加入。自動收集總開關屬於被合併的 Vault，不列入比對。預覽只對需要選擇的項目附上兩邊的內容（`localText`、`incomingText`），新增與相同的項目只列狀態。比對逐份讀取兩邊的文件，不把任一邊整份放進記憶體。來源 ID 只差大小寫的文件無法在不分大小寫的磁碟上並存，兩邊出現這種情況時拒絕合併。套用前重新比對本機與匯入包，核對每個項目的狀態與本機內容（文件的位元組、刪除紀錄、訂閱的名稱、網址、暫停狀態與收集設定）是否與預覽相同，也核對資料包的 manifest 沒有改變；不同時要求重新預覽。訂閱的收集進度與檢查時間不在核對之列，預覽後排程照常檢查不會讓預覽失效。

### 訂閱設定檔

`youtube-channels.json` 是 `{ "version": 2, "channels": [...] }`，每個訂閱帶 `settings`（`intervalMinutes`、`backfillWindow`、`backfillMaxItems`）、`lastCheckedAt`、`outOfRange`（可省略，超出收集範圍的影片與當時的範圍起點）、`nextCheckAt` 與 `lastDispatchedAt`；`youtube-schedule.json` 是 `{ "version": 2, "enabled": <boolean> }`。訂閱與檔案中不認得的欄位（例如已不使用的 `cursor`）照原樣讀取與保存。其他版本的檔案不讀取：開啟 Vault 與讀取資料包時都拒絕並說明原因。

有實際異動時，先建立合併前資料包（`<vault>.before-merge-<唯一值>.xr-vault`，格式與匯出相同）與 journal。套用失敗會復原檔案及搜尋；復原失敗則保留恢復資料、停止寫入與排程，重啟先處理 journal。合併期間文件／搜尋 API 暫時拒絕存取，狀態 API 仍可查詢。備份及 journal 在恢復完成前必須保留。

## 搜尋投影

收集先保存 Markdown，再更新索引。索引失敗不刪除已保存文件；列表與全文可從 Vault 讀取，搜尋依索引狀態回報結果或錯誤。成功合併只對新增／替換文件更新索引；還原使用獨立索引。

索引名稱帶 schema 版本（`documents_v2`）；schema 改變時使用新名稱並從 Vault 全量重建，舊版本的索引在啟動時刪除。每筆索引文件的 key 是完整文件 ID 的 base64url 編碼，不同來源類型即使來源內 ID 相同也不會互相覆寫。來源篩選使用 `sourceType` 與 `publisherId`；頻道名稱只供顯示與搜尋，不作篩選條件。

每筆索引文件帶有其 metadata 與正文的內容雜湊。啟動時逐筆比對索引與 Vault 的文件 ID 及雜湊，集合或任一雜湊不同就從 Vault 全量重建，因此篇數相同但內容或身分不同時也會重建；完全一致時沿用持久化索引。全量重建完成的時間記錄在裝置的搜尋資料旁（`<搜尋資料目錄>-state.json`），供設定頁與 `GET /api/search/status` 顯示。這項比對只在啟動時進行；執行期間的收集逐筆更新索引。

刪除文件時，文件 ID 先加入待移除清單，再在背景從索引刪除。搜尋時清單內的 ID 以引擎篩選條件排除，結果與總數都不含已刪除文件。索引刪除失敗時 ID 留在清單，下一次索引異動時再刪除；清單超過 100 筆時改為從 Vault 全量重建，篩選條件因此維持在固定長度內。清單只存在於執行中的程序；重新啟動後，啟動時的比對會發現索引多出已刪除的文件並全量重建，重建完成前搜尋不提供結果。

Meilisearch 的 dump／snapshot 是引擎運維產物，不是 `.xr-vault`，不作為 Collector 跨機資料交換格式。
