# XR Collector

程式與 tickets：[GitHub repository](https://github.com/derektu/xr-collector)。執行規劃見 [Round 2 總覽 #24](https://github.com/derektu/xr-collector/issues/24)。

XR Collector 是 local-first 的 YouTube 字幕收集與搜尋工具。使用者可以貼上單支影片網址，或保存一份 YouTube 頻道清單並立即或定時抓取。系統取得影片既有的人工或自動字幕，將 metadata 與整理過的字幕正文保存成 Markdown，並提供瀏覽、全文搜尋與閱讀介面。

本 repository 的可執行交付範圍涵蓋單支影片收集、文件保存與搜尋、非同步收集工作與進度、頻道訂閱與共用的自動收集設定、Agent 完整業務操作，以及完整資料包匯出、還原與比對合併。已收集內容管理由其他 tickets 交付。

## 從這裡開始閱讀

目前可執行的是第一輪 YouTube 收集／搜尋／資料交換功能，加上 #25 的 CI 與原生驗證工具。Round 2 正在將其擴充成完整產品流程；設計圖與計畫中的能力不等同已交付功能。

| 想了解什麼 | 文件 |
| --- | --- |
| 現在做到哪裡、接下來做什麼 | [Round 2 開發計畫與進度](docs/round-2-plan.md) |
| 產品目標、本輪包含與排除的範圍 | [產品範圍](docs/product-brief.md) |
| 目前程式如何組成 | [架構](docs/architecture.md) |
| 文件格式、Vault 與搜尋資料責任 | [文件格式](docs/document-format.md)、[儲存與搜尋](docs/storage-and-search.md) |
| 如何開發、測試與交付 PR 證據 | 本頁下方操作、[開發驗證流程](docs/development-validation.md)、[測試說明](tests/README.md) |
| 畫面設計參考 | [UI Design Spec](docs/ui-design/README.md)，wireframe 的行為差異依 Round 2 計畫 |
| App Shell 的路由、來源與外觀擴充位置 | [App Shell extension points](docs/app-shell-extension.md) |

以下操作說明描述目前程式；即時 ticket 狀態與驗收證據由 [GitHub #24](https://github.com/derektu/xr-collector/issues/24) 追蹤。

## 執行模式

開發與主要測試使用獨立 Web 模式：一般瀏覽器連到 Web 開發伺服器，前端透過相對路徑 `/api` 呼叫本機 API。這個模式不需要啟動 Electron。

安裝版由 Electron 啟動同一個 Web Server，並在應用程式視窗中載入同一份 Web UI。Electron 內部使用動態 port；該 port 不構成對一般瀏覽器公開的產品介面。業務畫面不使用 Electron IPC。

## 本機開發

需求：

- Node.js 22.12 或更新版本
- npm
- 下列 Web 開發範例以 macOS arm64 為準；原生驗證／打包支援 Mac arm64 與 Windows x64 Node（含 Windows ARM 上的 x64 模擬執行）

安裝套件：

```bash
npm ci
# Mac
npm run download:runtime
# Windows 改用 npm run download:runtime:win
```

啟動 Web UI 與 API：

```bash
npm run dev
```

瀏覽器開啟 `http://127.0.0.1:7176/`。API 使用 `127.0.0.1:7175`，開發用 Meilisearch 只監聽 `127.0.0.1:7177`。第一次開啟時在 Onboarding 輸入知識庫目錄的絕對路徑；選擇記錄在 `.data/vault-selection.json`，可重建的搜尋資料保存在 `.data/dev-search-*`。

已完成 production build 時，也可以只啟動單一 Web Server：

```bash
npm run build
npm start
```

此模式由 `http://127.0.0.1:7175/` 同時提供 UI 與 API。

## 測試與建置

GitHub Actions 在 main push、pull request 與手動觸發時，使用 Ubuntu 24.04、`.nvmrc` 指定的 Node 版本執行共用驗證入口：

```bash
npm ci
npm run verify
```

`verify` 執行 Vitest（含 JUnit 報告）、typecheck 與 Node／Web build。CI 以 commit SHA 標示報告與 build artifacts，保留 7 天。缺少 macOS bundled Meilisearch binary 的平台會跳過對應的整合測試；JUnit 的 skipped 數量是驗證邊界，不能視為跨平台 runtime 已通過。CI 不包含 Desktop E2E、畫面截圖或 Release 打包。

測試分類與條件式 skip 見 [測試說明](tests/README.md)。各檢查亦可單獨執行：

```bash
npm test
npm run typecheck
npm run build
```

單元與 HTTP 整合測試不存取 YouTube。Meilisearch 整合測試使用下載後的本機 binary，驗證索引持久化與重建。真實字幕驗收需連線至 YouTube，並以 Web UI 貼入影片網址或加入頻道操作。

原生 PR 驗證依功能影響選擇平台，共用功能可在開發者的 Mac 或 Windows 完成；缺少的必要平台由其他機器補驗。`npm run validation -- doctor` 檢查本機能力，`prepare` 自動建立指定版本的獨立 worktree。跨機證據彙整與完整命令見 [開發驗證流程](docs/development-validation.md)。

macOS arm64／Windows x64 安裝產物包含固定版本且通過 SHA-256 驗證的 `yt-dlp`、Deno 與 Meilisearch：

```bash
npm run package:mac  # 在 Mac 執行
npm run package:win  # 在 Windows 執行
```

產物輸出至 `release/`，不自動發布。MVP 安裝包未簽章，並使用預設 Electron 圖示。兩平台從同一個版本 commit 建置，驗收後再上傳至同一個 GitHub Release；詳細責任分工見開發驗證流程。

## 資料保存

每支影片使用 YouTube video ID 作為穩定識別，保存在：

```text
<vault>/documents/youtube/<video-id>.md
```

文件包含可追溯來源的 YAML frontmatter，以及可直接閱讀及交給其他工具使用的字幕正文。影片 URL 只保存在 frontmatter；正文不包含逐句 timestamp 或重複的來源連結。已存在相同 video ID 時，系統回傳既有文件，不覆寫檔案。

Vault 位置由使用者在第一次啟動的 Onboarding 選擇，建議位置是「文件」下的 `XR Collector`。每個 Vault 根目錄有 `xr-collector-vault.json` 標記檔；這台電腦使用哪個 Vault 記錄在 profile 的 `vault-selection.json`（Web 開發為 `.data/`，Electron 為 application data 目錄）。

開發或測試可以用 `XR_COLLECTOR_VAULT` 直接指定 Vault，略過 Onboarding；目錄為空或不存在時會自動建立。

## 資料匯出與還原

畫面上方「資料匯出、還原與合併」提供完整 `.xr-vault` 資料包下載及檔案上傳。還原會建立獨立 vault，完成檢查與搜尋索引重建後自動切換畫面；原 vault 保留，不覆寫或合併。程式重新啟動後繼續使用還原的 vault。

資料包包含 `documents/youtube/*.md`、`attachments/`、保留的 `versions/`、`management/`，以及 `settings/youtube-channels.json`、`settings/youtube-schedule.json`。訂閱、暫停狀態、發現進度與自動收集設定都保留；還原後自動收集先暫停，須由使用者開啟。Meilisearch 資料庫、Agent token、帳號憑證及裝置設定不納入資料包。

匯出與還原需等待收集工作及設定操作完成，執行期間禁止新的寫入並暫停排程觸發。這個一致性保證涵蓋目前程式管理的操作；請勿讓另一個程式同時寫入同一 vault，或在搬移期間手動修改檔案。

資料包是 version 1 JSON，檔案以 Base64 保存，檔案內容與清單各自以 SHA-256 檢查完整性。校驗碼用於偵測損壞，不是來源簽章。上限為 128 MiB 資料包、80 MiB 解碼內容及 10000 個檔案。系統拒絕不安全路徑、重複與大小寫衝突路徑、不支援的版本、損壞內容及格式錯誤；匯出時拒絕資料目錄中的符號連結。

還原先寫入 `<預設 vault>.restored/vault-<唯一值>`，顯示檔案進度，再建立獨立搜尋索引。資料或索引準備失敗時不切換 vault；原 vault、原索引與使用設定保留。成功後以 vault 之外的 `<預設 vault>.active.json` 記錄目前選擇。畫面顯示實際使用中的 vault 路徑。

### 匯出／還原的合成資料

先依 [開發驗證流程](docs/development-validation.md) 建立 A、B 兩個不同 run，使用相同 commit 和已批准的計畫。各自在本機工作區啟動程式，資料與日常 profile 隔離。

```sh
npm run prepare:transfer-demo -- --output <新的資料目錄>
```

命令產生 `machine-a.xr-vault`、`machine-b.xr-vault` 及用於產生資料包的 Vault 目錄。A 有兩份合成字幕、一個頻道及二進位附件；B 有一份自己的文件。輸出目錄必須不存在；省略 `--output` 時使用新的 `.data/transfer-demo/<時間>`。命令不啟動程式、不存取 YouTube。

1. 在 A 工作區還原 `machine-a.xr-vault` 作為前置資料，再從 UI 匯出資料包。
2. 在 B 工作區還原 `machine-b.xr-vault` 作為前置資料，再還原 A 從 UI 匯出的包。
3. 確認 B 顯示 A 的兩份文件，可搜尋「森林觀測」及 `orchid`；頻道保留、排程暫停，B 原文件留在原 Vault。
4. 正常關閉並重啟 B，檢查 active Vault 與搜尋結果，再依 scenario 收集證據。

所有還原都會暫停排程，包含前置資料準備。同機 A／B 驗證是隔離環境模擬，不能替代契約要求的另一種 OS 或實體機器驗收。Development 與 Verifier 各自準備 run 及資料。

## 合併另一份 vault

選擇 `.xr-vault` 後按「比對並合併到目前 vault」，展開差異項目查看逐行增刪，為每項差異選擇「保留本機」或「採用匯入」，再按「確認合併」。預覽階段可取消，不寫入資料；套用階段需等待完成或自動復原。成功後按「重新載入文件與頻道」查看結果。

- 文件以穩定 YouTube ID 比對全部 frontmatter 與正文。YAML 鍵順序、正文前後空白與收集／異動時間不影響相同判定；標題、tags、來源資訊、字幕語言及正文異動均視為差異。畫面時間取自 `collector.updated_at`（若有）或 `collector.collected_at`，不以時間自動覆蓋。
- 頻道以 ID 逐筆比對名稱、網址及啟用狀態；加入時間僅供參考，陣列順序不影響判定。重複頻道 ID 拒絕合併。
- 自動收集設定比對開關、檢查頻率與補收範圍。採用匯入設定時套用頻率與補收範圍並暫停自動收集，保留本機執行紀錄；再次匯入開啟中的來源設定仍會顯示開關差異。訂閱只比對訂閱本身，發現進度與檢查時間不列為差異。
- 附件、保留版本及管理檔案以相對路徑和完整位元組比較。二進位差異顯示大小及 SHA-256；文字預覽最多顯示每側 100000 字元，判定使用完整內容。跨 vault 的大小寫、檔案／目錄路徑衝突會拒絕合併。
- 新增項目加入、相同項目跳過，來源缺少的本機項目保留。同一包重複匯入不增加副本。每個衝突獨立決定，附件選擇需與引用它的文件一起確認。

預覽後本機資料若有變動，套用時要求重新比對。合併期間排程及其他寫入暫停，文件與搜尋 API 暫時回傳 409，狀態 API 持續可讀。成功合併只對新增與替換的文件增量更新搜尋。

每次有實際寫入的合併，先在目前 vault 旁保存 `<vault>.before-merge-<唯一值>.xr-vault`，完成訊息顯示備份路徑。可透過「還原成新 vault 並切換」開啟這份備份；還原後排程暫停。失敗時復原文件與搜尋；若復原也失敗，停止寫入與排程並保留 `<vault>.merge-journal.json`，重啟後先復原再開放操作。復原紀錄存在時請保留其指向的備份。與匯出／還原相同，同一 vault 僅供一個程式寫入。

### 合併的合成資料

```sh
npm run prepare:merge-demo -- --output <新的資料目錄>
```

輸出 `local-before.xr-vault`、`incoming.xr-vault` 及來源 Vault 目錄。省略 `--output` 時使用新的 `.data/merge-demo/<時間>`，既有目錄會拒絕寫入。

在自己的 validation 工作區，先還原 `local-before.xr-vault`，再選 `incoming.xr-vault` 比對。預期新增 2、相同 1、差異 4（文件、頻道、排程、二進位附件）。文件差異包含「森林觀測」與「海洋調查」。

採用匯入文件後，搜尋「海洋調查」命中、「森林觀測」不再命中；新增的「沙漠研究」可搜尋，本機「山岳考察」保留。採用匯入設定後為每 3 小時且暫停。重複匯入不增加副本，未採用項目保留差異；以正常關閉、重啟確認持久結果。重做案例時依契約重設資料或建立新 run。

這些資料供 UI 操作驗收使用；自動化的資料完整性、失敗恢復與搜尋測試仍須執行，見 [測試說明](tests/README.md)。

## 收集工作

來源頁的 YouTube 區塊只有一個網址輸入框，依格式決定動作：影片網址顯示「收集影片」，頻道網址或 `@handle` 顯示「訂閱頻道」。帶播放清單參數的影片網址只收集該支影片；純播放清單網址不支援，輸入框下方顯示原因且不能送出。格式辨識只看網址本身。訂閱前的頻道預覽是一次同步查詢（見「頻道訂閱」）；收集本身都在背景工作中進行。

送出影片或確認訂閱後，服務先把工作寫入裝置資料，再回傳 202 與工作 ID，畫面立即可以繼續操作。下方「收集工作」列出目前 Vault 的工作：種類、目標、狀態（排隊中、執行中、完成、失敗、已中斷）、執行中的階段，以及頻道工作的已處理數量與每支影片結果。工作狀態由服務保存，切換頁面或重新整理後再回到來源頁，仍看到同一份進度。

- **影片工作**：先檢查 Vault 是否已有該影片，沒有才擷取字幕，接著保存文件、更新搜尋索引。結果分開表示保存與索引；索引失敗時顯示「文件已保存，搜尋更新失敗」，文件可直接閱讀，重建索引即可補上，不需重新下載。
- **訂閱頻道工作**：解析頻道並加入訂閱，再派出一個首次收集的頻道工作；頻道已在訂閱清單時只回報已存在。
- **頻道收集工作**：依接受時固定的範圍（補收或增量，見「頻道訂閱」）探索影片，為每支影片派出影片工作，等全部結束後彙整為新增、已存在、略過、部分失敗、全部失敗或沒有新影片。工作清單以「首次收集」「恢復補收」「定時檢查」「立即檢查」「接續收集」標示它為何執行。

同一 Vault 中，同一支影片或同一個頻道已有排隊或執行中的工作時，新的提交回傳既有工作，不重複擷取。頻道工作探索到的影片若已在其他工作中處理，直接連到那個工作。不同頻道各自有工作與結果。

工作分兩條有上限的佇列執行：頻道解析與探索同時 1 個，影片擷取同時 2 個，排隊中的工作合計最多 500 個，超過時回 503 `queue_full`。影片擷取在提交它的工作之間輪替取用，大頻道的影片不會占住所有名額，手動新增的影片與其他頻道能在大頻道收完前開始。

每個工作綁定提交時的 Vault，只寫入該 Vault。有排隊或執行中的工作時，Vault 匯出、還原與合併回 409 `vault_busy`。服務關閉時等待執行中的步驟完成，尚未開始的工作記為「已中斷」；程式異常結束留下的排隊或執行中工作，在下次啟動時同樣記為已中斷。已中斷的工作保留範圍、已完成項目與已保存文件，可重新提交同一網址繼續收集，已存在的影片直接回報已存在。

工作狀態與事件屬於裝置資料，不放在 Vault，也不納入資料包：

```text
<profile>/jobs/jobs.json      目前與最近的工作快照，原子寫入；完成的工作最多保留 1000 筆
<profile>/jobs/events.jsonl   最小時序事件：接受、開始、保存、索引失敗、完成、失敗、中斷
```

profile 是 Web 開發的 `.data/`（或 `XR_COLLECTOR_PROFILE`），安裝版為應用程式資料目錄。HTTP 介面為 `POST /api/youtube/submissions`、`GET /api/jobs`、`GET /api/jobs/:id`，UI 與 Agent 共用；欄位與錯誤碼見 [Agent Skill](skills/xr-collector-agent/SKILL.md)。

## 頻道訂閱

貼上頻道網址或 `@handle` 並按「訂閱頻道」，輸入框下方顯示確認卡：先以 `POST /api/youtube/channel-previews` 同步解析頻道（逾時 60 秒），再顯示頻道名稱與依目前自動收集設定寫成的摘要，例如「訂閱後，先收集最近 1 個月內最新的最多 10 支未收集影片，之後每 30 分鐘自動檢查新內容」。確認後才建立訂閱並開始首次收集。已訂閱的頻道顯示「已訂閱」，暫停中的頻道提供「恢復訂閱」。

訂閱保存在 `<vault>/settings/youtube-channels.json`，含暫停狀態與發現進度（游標、上次檢查時間），隨資料包搬移。來源頁的訂閱清單列出每個頻道的狀態（追蹤中、收集中 N／M、已暫停）、文件數與最近新增時間，清單標題列顯示上次與下次檢查時間及「立即檢查」。

- **補收**：首次訂閱、恢復訂閱、服務啟動後的第一次檢查，以及距上次成功檢查超過 24 小時（或 3 個檢查週期，取較長者）時，只收補收範圍內、Vault 還沒有的最新影片，最多設定的則數。範圍起點以這台電腦的時區計算，月份為日曆月，該月沒有的日期取月底；只有日期的發布時間視為該日 UTC 00:00。頻道清單只提供概略發布時間，擷取時再以影片的精確時間檢查，超出範圍的在下載字幕前略過。之後的追蹤從頻道最新一支影片開始。
- **增量**：持續運作中的檢查收游標之後的所有新影片，不套補收範圍與則數。一次工作最多 50 支，從最舊的開始；還有剩餘時，這個工作結束後立刻接續下一批。游標只在影片成為工作後才前進，所以服務中斷或與進行中的工作合併時，新影片會在下一次檢查找到。連續 500 支都沒找到游標時改用補收規則。
- **暫停與移除**：排隊中的頻道工作與尚未開始的影片結束為「略過」，正在擷取的影片完成並保存。移除保留已收集的文件。恢復從補收開始。暫停與移除保存在 Vault，重新啟動後維持原狀。
- **範圍快照**：每個頻道工作在接受時記下補收起點、則數與游標；之後修改設定不影響已接受的工作。

較舊的影片可以用單支影片網址收集，不受補收範圍限制。無字幕影片以可辨認的失敗項目呈現，不啟動語音轉寫。

## 自動收集設定

所有訂閱共用一組設定，保存在 `<vault>/settings/youtube-schedule.json`，在設定頁的「自動收集」卡修改，變更立即儲存：

| 設定 | 選項 | 預設 |
| --- | --- | --- |
| 自動收集 | 開啟／暫停 | 開啟 |
| 檢查頻率 | 15 分、30 分、1 小時、3 小時、6 小時、12 小時、每天 | 30 分 |
| 補收範圍 | 最近 1 週、2 週、1 個月、3 個月、6 個月內最新的最多 5、10、20、50 則 | 1 個月、10 則 |

API 只接受這些選項。第一輪留下的設定檔沒有補收欄位時採用預設值，不在選項內的頻率取不短於原值的最近選項（超過一天取每天）；沒有設定檔的 Vault 套用上表預設。修改頻率時，下次檢查從上次派工時間重新計算，已過就立即檢查；修改補收範圍不派任何工作，只在下一次補收生效。

自動收集只在 XR Collector 執行且電腦醒著時檢查，不建立背景系統服務。到期時為每個啟用中的訂閱提交頻道工作後立即返回，不等待收集完成；漏過的多個週期只派工一次，是否以補收規則檢查依上述時間判定。`lastAttemptAt` 是派工時間，這批工作全部結束後才更新 `lastCompletedAt` 與結果。暫停自動收集只停止定時檢查；新訂閱的首次收集與「立即檢查」照常執行。

## 搜尋與索引

Markdown vault 是正式資料，Meilisearch 是每台裝置上可重建的搜尋投影。收集流程先保存 vault，再更新該份文件的索引。索引更新失敗不會刪除或回滾已保存的 Markdown；畫面會顯示錯誤並提供重建操作。

「文件」頁把列表與搜尋放在同一個畫面。沒有查詢字串時，列表直接讀 Vault，依收集時間新到舊、每頁 20 份，來源選單（全部來源、YouTube 全部、各頻道及篇數）以穩定的來源與頻道 ID 篩選；不在訂閱清單的頻道標示「未訂閱」。輸入關鍵字約 300ms 後開始搜尋，結果依 Meilisearch 關聯性排序並以頁碼分頁，顯示命中片段與「找到 N 份」。搜尋索引包含標題、頻道名稱與字幕正文。點選文件進入 `/documents/:id` 的 Reader，以 Markdown 排版全文；返回時恢復查詢、來源、頁碼與捲動位置。

Desktop 啟動時自動啟動只監聽 loopback 的 Meilisearch process，並追蹤「啟動中、更新中、重建中、已就緒、錯誤」狀態。啟動時逐筆比對索引與 vault 的文件 ID 及內容雜湊，有任何差異就全量重建，一致時沿用持久化索引。搜尋無法使用時，文件頁顯示警示並改列 vault 文件，Reader 照常可讀；設定頁的「搜尋索引」卡顯示狀態、已索引與知識庫篇數、上次重建時間、錯誤原因及「重建索引」按鈕。繁簡轉換與進階中文調校不屬於 Issue #4 搜尋契約。

## Agent 存取

應用程式由共用 Collector runtime 建立單一 VaultWorkspace、scheduler 與搜尋 process，再提供 UI 與 Agent 兩個 loopback HTTP listener。Agent listener 需要 Bearer token，並提供與 UI 相同的既有業務 API：收集、頻道、排程、文件、搜尋重建及 Vault 匯出／還原／合併。兩個入口使用同一個 active Vault 與操作鎖；用戶端斷線不取消已接受的操作，runtime 停止時會等待操作完成再關閉搜尋 process。

尚未設定 Vault 或已記錄的 Vault 不存在時，health 顯示 runtime `not_ready` 與原因；業務 API 回傳 503 `vault_not_ready`，且不自動建立替代 Vault。使用者需透過 #20 的 Onboarding 設定 Vault。Agent token 驗證在 Not Ready 狀態仍然生效。

每次啟動重新產生 Agent runtime instance、port 與 token，連線檔原子更新。macOS／其他 POSIX 環境將檔案 mode 設為 0600；Windows 不把 POSIX mode 視為權限保證，連線檔放在目前使用者的 LocalAppData 並使用該目錄繼承的 ACL，仍需 Windows 原生驗證。連線檔位於裝置資料、vault 之外，不應分享或納入資料搬移；程式關閉後保留最後的連線資訊，Agent 會以 health 回應核對 instance，連線失敗時重新讀取一次並區分未啟動、過期、損壞及權限問題。

- Web 開發／standalone：`.data/agent-connection.json`；Skill 位於 repository 的 `skills/xr-collector-agent`。
- 未打包 Electron 且未指定 profile：Electron userData 下的 `agent-connection.development.json`。
- macOS 安裝版：`~/Library/Application Support/XR Collector/agent-connection.json`。
- Windows 安裝版：`%LOCALAPPDATA%\XR Collector\agent-connection.json`。
- 明確指定 `XR_COLLECTOR_PROFILE` 的開發／驗收執行：該 profile 下的 `agent-connection.json`，不更新正式安裝版入口。

正式安裝版位置只跟目前作業系統使用者有關，不跟程式安裝位置或 Vault 位置連動。未打包 Electron 與 standalone server 也保持 profile-local，避免開發服務覆蓋正式入口。Skill 隨安裝包放在應用程式 resources 的 `skills/xr-collector-agent`。

Skill 以標準 HTTP/JSON 定義操作，不包含可執行腳本，也不要求用戶端安裝 Python、Node.js 或其他 runtime。Agent 使用自身已有的工具讀取本機連線檔、解析 JSON，並向 loopback HTTP 發送帶 Authorization header 的請求。只有雲端瀏覽能力、無法存取本機檔案或 localhost 的 Agent 不適用。

可以直接請本機 Agent 讀取 Skill 目錄中的 `SKILL.md`；也可以把整個 `xr-collector-agent` 目錄複製到該 Agent 的 Skill 安裝目錄。一般使用不必提供 port、Vault 或連線檔路徑；測試 profile 才明確提供其連線檔。操作與 HTTP 契約見 [Agent Skill](skills/xr-collector-agent/SKILL.md)。macOS／Windows 使用同一份 Skill 與 API 契約；路徑規則的自動化測試不代表兩平台安裝版都已完成原生驗證。

Skill 已安裝到 Agent 時可直接交付以下要求；從 repository 試用時，將 `<Skill 目錄>` 換成此 checkout 的 `skills/xr-collector-agent`：

```text
請使用 <Skill 目錄>/SKILL.md，自動尋找這台電腦上的 XR Collector。
先列出已保存文件，再搜尋 math，讀取一份命中文件並附上來源。
```

列表預設每頁 50 份，回傳下一頁 offset；收集期間列表可能移動，跨頁使用穩定文件 ID 去重。列表與搜尋以 `sourceType`／`publisherId` 篩選，`GET /api/documents/sources` 回傳各來源與頻道的篇數。搜尋與 UI 使用相同關聯性排序及篩選，支援 offset/limit，回傳精確命中總數（最多計到 10000）。索引未就緒時搜尋回報 503，列表與全文仍直接讀取 vault。第一版不提供 MCP；完整操作契約見 Agent Skill。

## 收集規則

- 接受 `youtube.com/watch`、`youtu.be`、`youtube.com/shorts` 與 `youtube.com/embed` 的單支影片網址。
- 語言依序偏好繁體中文、簡體中文、英文，再選其他可用語言。
- 同一語言優先使用人工字幕；自動字幕只採用影片原始語言，不採用 YouTube 自動翻譯軌。
- 正規化字幕中的多餘空白，並將來源的零碎字幕片段合併成段落；不摘要或改寫內容，原本重複的文字仍會保留。
- Timestamp 只用於擷取過程，不寫入正式文件。產品不提供 Player UI 或逐句時間跳轉。
- 不下載影片或音訊，也不執行語音轉文字。
- 無字幕、影片無法存取、網路問題與一般擷取失敗以不同錯誤回報。

目前範圍見 [產品範圍](docs/product-brief.md)，本輪交付依 [Round 2 計畫](docs/round-2-plan.md)。技術現況見 [架構](docs/architecture.md)、[文件格式](docs/document-format.md) 與 [儲存／搜尋](docs/storage-and-search.md)。
