# XR Collector

程式與 tickets：[GitHub repository](https://github.com/derektu/xr-collector)。執行規劃見 [Round 2 總覽 #24](https://github.com/derektu/xr-collector/issues/24)。

XR Collector 是 local-first 的 YouTube 字幕收集與搜尋工具。使用者可以貼上單支影片網址，或保存一份 YouTube 頻道清單並立即或定時抓取。系統取得影片既有的人工或自動字幕，將 metadata 與整理過的字幕正文保存成 Markdown，並提供瀏覽、全文搜尋與閱讀介面。

本 repository 的可執行交付範圍涵蓋單支影片收集、文件保存與搜尋、頻道清單與立即抓取、應用程式執行期間的週期排程、Agent 完整業務操作，以及完整資料包匯出、還原與比對合併。已收集內容管理由其他 tickets 交付。

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

瀏覽器開啟 `http://127.0.0.1:7176/`。API 使用 `127.0.0.1:7175`，開發用 Meilisearch 只監聽 `127.0.0.1:7177`。正式文件保存在 `.data/dev-vault`，可重建的搜尋資料保存在 `.data/dev-search`。

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

不同執行模式的預設 vault：

- Web 開發／standalone server：`.data/dev-vault`
- Electron 安裝版：Electron application data 目錄下的 `vault`

開發或測試可以用 `XR_COLLECTOR_VAULT` 指定其他位置。

## 資料匯出與還原

畫面上方「資料匯出、還原與合併」提供完整 `.xr-vault` 資料包下載及檔案上傳。還原會建立獨立 vault，完成檢查與搜尋索引重建後自動切換畫面；原 vault 保留，不覆寫或合併。程式重新啟動後繼續使用還原的 vault。

資料包包含 `documents/youtube/*.md`、`attachments/`、保留的 `versions/`、`management/`，以及 `settings/youtube-channels.json`、`settings/youtube-schedule.json`。頻道清單與啟用狀態保留，還原的排程先暫停，須由使用者啟用。Meilisearch 資料庫、Agent token、帳號憑證及裝置設定不納入資料包。

匯出與還原需等待收集及設定操作完成，執行期間禁止新的寫入並暫停排程觸發。這個一致性保證涵蓋目前程式管理的操作；請勿讓另一個程式同時寫入同一 vault，或在搬移期間手動修改檔案。

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
- 排程比對啟用狀態與週期。採用匯入排程時套用週期並暫停排程，保留本機執行紀錄；再次匯入啟用中的來源排程仍會顯示啟用狀態差異。
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

採用匯入文件後，搜尋「海洋調查」命中、「森林觀測」不再命中；新增的「沙漠研究」可搜尋，本機「山岳考察」保留。採用匯入排程後為每 2 小時且暫停。重複匯入不增加副本，未採用項目保留差異；以正常關閉、重啟確認持久結果。重做案例時依契約重設資料或建立新 run。

這些資料供 UI 操作驗收使用；自動化的資料完整性、失敗恢復與搜尋測試仍須執行，見 [測試說明](tests/README.md)。

## 頻道清單與立即抓取

頻道可以用 YouTube 頻道網址或 `@handle` 加入。設定保存在 `<vault>/settings/youtube-channels.json`；重新啟動後會保留清單與啟用狀態。移除頻道只刪除追蹤設定，不刪除已保存的字幕文件。

「抓取已啟用頻道」處理清單中所有已啟用頻道；每個頻道也可以不受啟用狀態限制而手動執行。每次執行探索該頻道最近 10 支影片，不預設回溯完整歷史。影片依序沿用單支影片的收集、vault 保存與搜尋索引流程，因此相同 video ID 經不同入口或重複執行都會略過既有文件。

畫面顯示目前頻道、已發現及已處理數量，以及每支影片的新增、略過或失敗結果。單支影片或單一頻道探索失敗不會中止其餘清單。無字幕影片以可辨認的失敗項目呈現，不啟動語音轉寫；再次執行該頻道會略過成功項目並重試失敗項目。

## 頻道排程

使用者可以在頻道區設定 1 分鐘至每天的抓取週期，並啟用或暫停自動抓取。畫面顯示目前排程狀態、上次開始與完成時間、下次執行時間，以及上次新增／略過／失敗數量。設定與必要進度保存在 `<vault>/settings/youtube-schedule.json`，重新啟動應用程式後會繼續使用。

排程只在 XR Collector 執行且電腦醒著時檢查，不建立背景系統服務。若程式關閉、重新啟動或電腦休眠期間漏過多個週期，恢復後只執行一次到期檢查，不逐次補跑。下一次時間從該次實際完成時間計算，因此畫面顯示的是目前真正等待的執行時間。

手動與定時抓取共用同一個頻道收集 run；已有 run 執行時，新的要求會等待或取得該次 run，不會同時探索和寫入同一批影片。網路或字幕取得失敗會保留在上次結果中，已保存文件不會遺失，下一個週期會再次探索並重試尚未成功的影片。暫停排程只阻止後續自動觸發，不中止已經開始的收集。

## 搜尋與索引

Markdown vault 是正式資料，Meilisearch 是每台裝置上可重建的搜尋投影。收集流程先保存 vault，再更新該份文件的索引。索引更新失敗不會刪除或回滾已保存的 Markdown；畫面會顯示錯誤並提供重建操作。

搜尋索引包含影片標題、頻道名稱與字幕正文。結果依 Meilisearch 關聯性排序，顯示命中位置附近的字幕片段，可以再以頻道和影片發布日期篩選。點選結果後，畫面以文件 ID 透過 `GET /api/documents/:id` 讀取完整文件。

Desktop 啟動時自動啟動只監聽 loopback 的 Meilisearch process，並追蹤「啟動中、更新中、重建中、已就緒、錯誤」狀態。搜尋資料目錄不存在時，Collector 從 vault 重建全部索引；目錄存在且文件數一致時，重啟直接沿用持久化索引。繁簡轉換與進階中文調校不屬於 Issue #4 搜尋契約。

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

列表預設每頁 50 份，回傳下一頁 offset；收集期間列表可能移動，跨頁使用穩定文件 ID 去重。搜尋與 UI 使用相同關聯性排序及篩選，支援 offset/limit；搜尋命中數是估計值，Meilisearch 預設可翻閱前 1000 個命中。索引未就緒時搜尋回報 503，列表與全文仍直接讀取 vault。第一版不提供 MCP；完整操作契約見 Agent Skill。

## 收集規則

- 接受 `youtube.com/watch`、`youtu.be`、`youtube.com/shorts` 與 `youtube.com/embed` 的單支影片網址。
- 語言依序偏好繁體中文、簡體中文、英文，再選其他可用語言。
- 同一語言優先使用人工字幕；自動字幕只採用影片原始語言，不採用 YouTube 自動翻譯軌。
- 正規化字幕中的多餘空白，並將來源的零碎字幕片段合併成段落；不摘要或改寫內容，原本重複的文字仍會保留。
- Timestamp 只用於擷取過程，不寫入正式文件。產品不提供 Player UI 或逐句時間跳轉。
- 不下載影片或音訊，也不執行語音轉文字。
- 無字幕、影片無法存取、網路問題與一般擷取失敗以不同錯誤回報。

目前範圍見 [產品範圍](docs/product-brief.md)，本輪交付依 [Round 2 計畫](docs/round-2-plan.md)。技術現況見 [架構](docs/architecture.md)、[文件格式](docs/document-format.md) 與 [儲存／搜尋](docs/storage-and-search.md)。
