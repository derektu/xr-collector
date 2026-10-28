# 驗證流程分層與覆蓋範圍計畫

狀態：待實作方案。本文記錄驗證範圍、盤點依據與實作順序；不表示所列待補案例已實作或執行通過。

後續實作：[issue #168](https://github.com/derektu/xr-collector/issues/168)。

## 目的與範圍

日常回歸以常用操作及資料安全的代表情境為主。邊界、故障、長時間等待與平台案例依變更範圍選跑。功能地圖保存完整的功能說明，執行集合按使用頻率、失敗影響與成本決定。

本計畫涵蓋既有流程的保留、合併、分層與缺口，包含已存在的驗證，不以「增加測試數量」作為完成條件。單元與 HTTP／檔案系統整合測試負責規則及組合；E2E 負責使用者操作、畫面與服務的串接。已有適當下層測試的規則，無須逐一複製為 E2E。

交付範圍為 repository 內的功能地圖、驗收腳本、測試選取／報告與相關 CI 設定。產品功能、搜尋排序、資料格式及全域 pstack plugin 的修改各自需要獨立需求。

## 盤點依據

- 盤點日期：2026-10-28；採唯讀方式核對原始碼、實際操作步驟與斷言，沒有在這次盤點重新執行 App／測試。
- 產品基準：已合併的 [PR #166](https://github.com/derektu/xr-collector/pull/166)，commit `1f659793d8d8897ba1194a1737a00ffbe22982b7`。
- 驗收盤點快照：`a1e12ab7b0289b581efec2349e4f292305d0690d`，包含尚未合併的 [PR #167](https://github.com/derektu/xr-collector/pull/167)。該 PR 的 NORM-5～7 視為已有實作，後續先確認合併狀態，避免重做。
- 快照有 11 份功能檔、66 個子功能 ID、15 支收錄流程：14 支 Web、1 支 Desktop。另有獨立 smoke 與單元／整合測試，均納入盤點。
- 「已有」代表可執行程式與斷言存在，不代表本輪執行通過，也不代表該子功能全部入口與組合均已覆蓋。`covers` 只是一項覆蓋宣告。

依據：[功能地圖](../.claude/skills/verify/features/README.md)、[驗收工具](../.claude/skills/verify/SKILL.md)、[開發驗證流程](development-validation.md)、[測試說明](../tests/README.md)。

## 執行集合與成本

常用／邊界是情境分類；Web／Desktop 是執行層級；合成／真實來源是資料模式。三者分別記錄。

| 執行集合 | 範圍 | 預設執行時機 |
| --- | --- | --- |
| 自動檢查 | 現有單元、HTTP／檔案系統整合、typecheck、build | 維持 `npm run verify` 入口與適用規則 |
| 核心 Web 回歸 | 少量資料串接新增、訂閱、查詢、閱讀、暫停／恢復及一個刪除確認；涵蓋實際畫面與必要資料斷言 | 本機開發及快速回饋；PR 另執行完整 Web 集合 |
| 依功能選取的邊界回歸 | 斷網、限流、重試、分頁、設定錯誤、快照、競態、特殊詞彙、匯入／取代等 | 本機依相關變更選跑；已收錄的 Web 案例納入 PR 完整集合 |
| 平台與資源 smoke | Electron bridge、程序生命週期、外置詞庫、已有打包產物的身分與資源 | 平台／runtime／封裝變更，或適用的發版前驗證 |
| 真實來源 smoke | 現有 YouTube／RSS 真連線收集流程 | 收集來源變更及適用的發版前驗證；網路阻擋如實記錄 |

核心、相關邊界與全量入口供本機選跑及成本盤點使用。PR 的完整 Web E2E 包含當時所有已收錄、適用的 Web 回歸流程；此處的分層不自動縮減 PR 的完整集合。Desktop、資源與真實來源 smoke 依各自的前置與變更範圍執行，與完整 Web E2E 分開記錄。引擎變更需驗搜尋／資源案例，即使沒有 UI diff。

`npm run verify` 保持自動檢查入口，Web／Desktop 不預設全部塞入其中。功能地圖與選取規則的一致性測試可隨 `npm run verify` 執行。

### CI 執行時機與結果沿用

| 時機 | 自動檢查 | Web E2E |
| --- | --- | --- |
| PR 準備合併的版本 | `npm run verify` | 完整 Web E2E 執行一次，通過後才合併 |
| PR 後續修改程式或測試輸入 | 對更新版本執行 `npm run verify` | 對更新版本重新執行完整 Web E2E；舊版本的成功不代表新版本通過 |
| 合併到 main，內容與已驗證版本一致 | 保留 `npm run verify` | 沿用 PR 的成功結果，不重跑完整 Web E2E |
| 合併結果的內容與已驗證版本不同 | 執行 `npm run verify` | 對變動後的內容重新執行完整 Web E2E |

「一次」以準備合併的受測版本計算，不是整張 PR 永遠只執行一次。取消過時版本的執行不算最新版本已通過。

結果沿用需記錄受測的實際內容與測試輸入，包括產品程式、驗收程式、依賴與相關測試設定。判斷依據是內容一致性，不只比較 commit SHA；squash／rebase 造成 SHA 不同，本身不構成重跑理由。

解決衝突、更新合併基底或其他變動若影響實際合併內容，需重新驗證該內容。準備合併時應核對成功結果是否仍適用；沒有成功結果或無法證明一致時，先補驗，不把未驗證內容當作已通過。

這是待實作的 CI 安排；本次文件更新不修改 workflow、觸發條件或現有執行程式。

### 時間量測與取捨

先量測既有流程，再決定拆分程度。每支流程分別記錄環境準備、啟動、操作／斷言及清理耗時，另列 scenario／check 數、資料量、引擎 variant、平台與資料模式。依賴下載或引擎編譯另列，總 wall time 仍保留。

初始核心 Web 目標為同一環境、runtime 已備妥時五分鐘內；這是本機快速回饋的規劃目標，不是既有量測結果，也不是 PR 完整 Web E2E 的耗時保證。核心與完整集合分別量測。實作以同一台機器／相同前置比較分層前後。目標不符時，優先合併重複工作、縮小資料及切開慢速情境，並交付實測與取捨。

取捨順序：

1. 保留常用路徑與資料安全的代表斷言。
2. 同一串操作共用前置資料，避免多支流程重複建立相同狀態；獨立測試仍保持隔離。
3. 完整規則矩陣留在單元／整合層，E2E 選代表情境。
4. 慢速及低頻情境進專項集合，保留可重跑入口與觸發條件。
5. 分類依使用頻率、影響與成本決定，通過／失敗狀態另外報告。

## 既有 15 支流程的處理清單

下表是分層決策，不表示刪除其既有斷言。混合常用與邊界的流程，先量測；需要時以少量函式抽取或拆分，沿用既有 runner。

| 流程 | 目標定位與處理 |
| --- | --- |
| `workspace-content` | 核心旅程的主要素材。常用新增／閱讀／基本工作操作保留；設定、最後頁、搜尋不可用等情境放相應專項。與文件流程共用的操作只保留必要代表。 |
| `subscribe-a-b` | A／B 同時收集、狀態序列與 Jobs 分區屬訂閱／工作專項；核心只需要一個正常訂閱與完成結果。保留原有進度與資料一致性斷言。 |
| `feature-navigation` | 常用入口、暫停／恢復可供核心旅程使用；503、診斷、索引重建歸專項。覆蓋宣告按實際操作修正。 |
| `documents-reader-search` | 核心保留代表性的瀏覽／篩選／搜尋／閱讀與刪除確認；跨頁、最後頁刪除及重新收集進文件專項。避免與 `workspace-content` 重複整條旅程。 |
| `search-normalization` | 搜尋專項。核心保留少量繁簡等價與連續片段代表；完整 NFKC／AND／引號／Latin／日期／分頁／重建矩陣沿用 PR #167。 |
| `agent-connection` | 下載與基本可達性用一個代表情境；詳細說明互動、進階設定、錯誤、重設金鑰進 Agent 專項。 |
| `build-info` | 低成本身分查詢可保留；Onboarding、錯誤重試與多外觀截圖視量測歸專項。打包身分另走現有產物 smoke。 |
| `check-history-summary` | 記錄專項，保留歷史群組／分頁／篩選與快照；核心只需能看到本次操作的代表記錄。 |
| `offline-recover` | 連線與派工專項；網路／訂閱／工作狀態流異動時執行。 |
| `youtube-cooldown` | YouTube／pacing 專項；保留真冷卻流程，日常核心不等待冷卻。 |
| `subscription-failures` | 訂閱錯誤、重試、自動暫停專項。保留時間與次數規則的下層測試，不重做完整矩陣。 |
| `rss-rate-limit` | RSS 故障與各 feed 隔離專項。helper 建立前置資料不等於已測對話框新增入口。 |
| `vault-transfer` | 資料交換專項；Vault 及相關鎖／資料流異動、適用發版前執行。保留 UI＋檔案／索引驗證。 |
| `login-startup` | 保留 Web 不可設定與可控 fixture；實際 OS 登入／開機案例明確略過。 |
| `tray` | Desktop 專項；保留真正程序與視窗生命週期驗證，依平台變更／發版需求執行。 |

## 功能盤點與補齊決策

「本票優先」是核心回歸與分層所需的工作。「按功能觸及補」為已清點的邊界 backlog；不要求在本票一次全部新增。

| 功能 | 已有程式與斷言 | 本票優先 | 按功能觸及補／保留專項 |
| --- | --- | --- | --- |
| 訂閱控制 | 新增、A/B 收集序列、詳情暫停／恢復、失敗恢復；Tray 已測自動檢查切換 | 補列表暫停／恢復與正確覆蓋標記、Web 自動檢查開關、成功的全部檢查。用一個啟用及一個暫停訂閱核對操作與派工。 | 完整名稱／類型組合、pending 列、頁尾檢查時間可併既有案例補斷言；冷卻／離線／自動暫停保留專項。 |
| 移除訂閱 | 核心／HTTP 已測保留／刪除、擷取中競態、索引與事件 | 透過畫面驗取消、預設保留、確認後列消失且文件可讀。移除並刪除選項保留一個資料安全 E2E，歸訂閱專項。 | 空訂閱確認形狀、保留文件後來源標示與篩選可併同一流程。擷取中移除／部分失敗沿用整合測試。 |
| 訂閱設定 | RSS 合法設定有畫面／reload／API／檔案斷言；輸入驗證與套用全部有下層測試 | 既有合法設定流程保留，補正覆蓋描述。 | 非法值、未儲存、`aria-invalid`、新增時禁止送出、套用全部確認與 paused 訂閱結果，集中設定專項；不列日常核心的完整組合。 |
| 新增影片 | 一般新增、閱讀、失敗重試與移除已有 Web；獨立 smoke 有真實影片 | 核心選一個實際新增入口，核對文件／Reader及沒有多建訂閱。 | 空知識庫完整送出、文件頁頻道網址切至訂閱、對話框焦點／文案列入口專項；原始來源連結用 Desktop recorder 驗網址。 |
| RSS 入口與內容 | 網頁辨識及設定有 Web；RSS／Atom 有實際收集；格式解析與 HTML 轉換有下層測試 | 以直接 feed 對話框完成一次訂閱與文章閱讀，核對代表內容和實際文件。 | 網頁 canonical feed、Atom／RDF、文件頁切換訂閱、Markdown heading／link 等用少量代表資料；完整解析矩陣留在下層。 |
| RSS 錯誤 | 429、其他 feed 照常、自動暫停／恢復已有 E2E；503 部分已驗 | 保留已有故障專項，修正「已恢復完成」等超過現有斷言的描述。 | 503 加同一工作完成與列回復斷言；404／410／非 feed 以表列案例選代表畫面，分類與重試矩陣沿用 plugin／HTTP 測試。 |
| 工作頁 | 正常收集、完成空狀態、failed-only 無徽章、重試／移除已有 | 核心補非零徽章／點進工作頁、代表工作完成，以及重試或移除後 DOM 列確實離開。 | 可控 queued→running、區數／順序／單訂閱單列、離線仍可移除失敗工作歸 Jobs 專項；純呈現分類沿用單元測試。 |
| 活動記錄 | 摘要／完整事件、等級、群組 10＋2 分頁、診斷與部分篩選已有 | 核心只看代表操作記錄；保留既有專項。 | 來源／時間有效資料、四條件往返、展開／收合、摘要快照刷新／固定、過期／重啟提示依記錄功能變更補。UI fixture 與真正重啟／retention 證據分開。 |
| 文件與 Reader | 分頁、閱讀返回、取消／刪除、tombstone、重收、RSS 無重收已有 | 核心重複的瀏覽／閱讀／搜尋與刪除確認合併；移除訂閱但保留文件的閱讀接在移除流程。 | 訂閱／Activity 連到 Reader、發布者實際點回來源、索引 N≠M 提示可補入口／UI 分支；最後頁與重收保留文件專項。 |
| 搜尋 | PR #167 已含七情境：文字等價、詞界、片段、AND／quote、Latin、原文、條件／分頁、Agent、重建／重啟 | 沿用已有實作，挑少量常用代表放核心；引擎或搜尋程式變更選完整搜尋專項。 | 外置詞庫載入／替換／壞資源已有 #162 一次性驗收；整理為參數化共用 smoke，使用資源副本，無須放進一般文件 UI 流程。 |
| 知識庫 | 匯出、merge／replace／nothing、搬移、切庫、fixed、等待取消及背景計數有 UI＋檔案／索引斷言 | 保留資料交換專項；補 preview 數與同 ID 更新後的精確文件內容，避免只看筆數。 | 原生選檔／選目錄的參數、取消無副作用、完成結果、reveal IPC 用 Desktop 控制驗證；不驗 Finder／對話框外觀。 |
| Agent 連線 | Settings ZIP／複製 payload／設定／重設已有 Web；port bind、重啟生效與 profile 隔離有真 TCP／runtime 測試 | 核心保留一個基本下載／可達性代表；修正未證明的標記。 | Onboarding 三按鈕實際操作、unavailable 顯示／停用、卡片順序、重設 identity 屬 Agent 專項；不重造 port／移轉矩陣。 |
| Tray | D1～D8 已有 Desktop：隱藏、Agent 同 instance、背景收集、開關、頁面不 reload、提示、第二啟動、退出與接續 | 保留 Desktop 專項，不建立另一套相同流程。 | 若聚焦列為必要結果，將現有 note 補為斷言；offline／retry／queue 等純選單狀態留在模型單元測試。 |
| 建置資訊 | Web 設定／Onboarding、UI／Agent 身分及 503 重試已有；打包 smoke 讀取實際產物 API | 保留廉價身分檢查，沿用已有 smoke。 | 在已有打包產物補 API／DOM與 asar／artifact identity 的共用核對入口；缺匹配產物明確列未驗，不用 Web 代替。 |
| 登入自啟 | Web 拒絕、fixture 成功／失敗／approval／外部停用／GET-PUT 競態已有 | 保留 Web 負向與已有 fixture。 | 真 OS 註冊、外部設定及登入後生效略過；普通手動第二實例仍由 Tray 驗證。 |
| 外觀主題 | `Settings.tsx` 有深／淺／系統與鍵盤操作；`app-shell`、`theme-preference` 有規則與儲存單元測試，尚無獨立功能檔／操作流程 | 地圖納入外觀；以一個簡短 Web 操作驗深／淺切換與刷新保留。 | 跟隨系統用瀏覽器可控外觀、鍵盤操作、Desktop 持久性歸外觀／平台專項；不新增低風險寫檔失敗的產品 UI。 |

### 不重複建立的下層驗證

- 訂閱排程、暫停／恢復的 queued／running 競態、執行中移除與晚到寫入：沿用 `tests/subscriptions/`、`tests/sources/` 與 HTTP 案例。
- RSS／Atom／RDF 解析、HTML 轉換及錯誤分類：沿用 `tests/plugins/rss/`。
- 工作排序、進度文字、Activity grouping／snapshot／retention：沿用相關核心／HTTP／呈現測試；畫面僅驗代表串接。
- 搜尋詞庫格式／hash／正規化與 runtime identity：沿用 `tests/search/`；實際換資源生命週期屬資源 smoke。
- Agent 固定 port／避讓／bind 失敗、Vault 交換不攜帶裝置設定：沿用 `tests/server/agent-access.test.ts` 與 `tests/runtime/collector-runtime.test.ts`。
- Tray 選單模型、主題 preference、建置資訊錯誤格式與產物身分：沿用 `tests/electron/`、`tests/web/` 與 `tests/runtime/` 的相應案例。

## 明確略過的項目

以下不作本票完成條件，報告中顯示「略過＋原因」，不列為通過：

- 真正登出／登入或重開機後自動啟動，以及 OS 登入項目外部停用的實機生效。
- OS 通知是否真的出現、Tray 圖示與原生選單的實際外觀。
- 原生檔案對話框、外部瀏覽器或 Finder 的視覺與外部程式行為。
- 憑證、簽章／公證、商店／外部 Agent 安裝等外部交付流程。

可控制的 App 行為保留驗證：dialog 回傳／取消、正確 URL／路徑的 IPC、視窗顯示／隱藏、程序與資料持久性。略過 OS 視覺驗收不代表這些 Desktop 行為也全部略過。

## 實作順序

### 1. 建立成本基準與分類

記錄 15 支既有流程與獨立 smoke 的層級、功能、資料模式、實際耗時、前置與重複操作。分類直接附於既有地圖／流程的適當位置，保有單一來源，避免另維護會漂移的第二份測試清單。

交付：可比較的成本報告、核心／相關邊界／平台資源的初始選取表，以及明確略過理由。已有測試的通過／失敗與「程式存在」分開記錄。

### 2. 精簡核心入口並調整選取與 CI

從現有流程抽出短的核心旅程，合併重複收集／列表／閱讀／搜尋，保留資料安全代表。選取先以 flow 為粒度；只有混合流程妨礙成本目標時才拆分。沿用現有 runner、隔離與證據格式。

提供核心、依功能選取與全量入口供本機與手動執行。CI 依「CI 執行時機與結果沿用」實作：PR 對準備合併版本跑一次完整 Web E2E；main 保留 `npm run verify`，只有合併內容有變才重跑 Web E2E。核心／邊界分組不自動替代 PR 完整驗證。失敗不得因重分類或縮短 timeout 而消失；分類前後的來源與執行集合可追溯。

交付：可實際執行的核心集合、選取測試、受測內容沿用判定與 CI 設定；同環境的前後耗時比較。引擎、後端與共用狀態流的異動也有對應選取。先消除 PR／main 的重複完整執行，再量測核心分層與案例精簡的收益。

### 3. 補常用操作與資料安全代表

優先順序為：

1. 訂閱列表暫停／恢復、Web 自動檢查、成功的全部檢查與正確標記。
2. 移除訂閱的取消／預設保留／確認，以及保留文件後可讀；刪除文件的代表另列相關專項。
3. 直接 RSS 入口／文章閱讀，以及已有影片新增旅程的精簡。
4. 工作頁非零徽章與代表狀態接線、重試／移除後 DOM 結果。
5. 外觀功能檔及短的切換／刷新案例。

先完成這些使用者常用操作，不以一次補齊全部邊界為前提。測資盡量少，斷言同時確認畫面與適當的 API／檔案結果。

### 4. 保留並整理邊界與平台專項

既有離線、冷卻、連續失敗、歷史分頁、資料交換、完整搜尋及 Tray 流程均保留可重跑入口。按功能觸及補的項目記為明確 backlog，單元／HTTP 層已足夠的組合不新增 E2E。

Desktop bridge 與詞庫資源 smoke 使用獨立資料／資源副本，不修改使用者環境或共用詞庫。需要既有安裝包／匹配產物的驗證，先核對身分與平台；未具前置時列未驗。單純沒有前置資源，不宣稱該功能在技術上無法自動化。

### 5. 完成對照檢查與交付報告

功能地圖中每個子功能指出適當層級的程式／斷言、待補 backlog 或略過理由。名稱一致性檢查可防止漏標；實際是否有對應操作與斷言，仍逐項核對程式。

這一步不要求每個子功能都有獨立 E2E。常用入口與高風險代表由 E2E 驗證，規則可由單元／HTTP 支持。檢查不得把「有 covers」直接當作完整覆蓋。

## 後續 ticket 的驗收條件

- 有現有流程的耗時與覆蓋盤點，日常核心、相關邊界、平台資源及略過項目清楚可見。
- 核心集合與相關選取入口實際可跑；CI 的選取有自動測試，能區分未選、略過、通過、失敗及前置不足。
- CI 判定測試涵蓋：PR 的受測版本執行完整 Web E2E；同內容合併到 main 僅執行 `npm run verify`；僅 SHA 不同且內容相同可沿用；PR 修改、衝突解決或基底更新造成合併內容改變時，對變動後的版本重跑完整 Web E2E。
- 上述第 3 階段的常用操作與資料安全代表有可執行斷言，並沿用適當下層測試，沒有為細節矩陣複製大量 E2E。
- 相同前置環境下交付核心與原全量 Web 的耗時／成本比較；五分鐘目標如未達成，列出剩餘成本與具體取捨，不以無證據的「更快」結案。
- 既有有價值的邊界與平台測試仍可選跑；未實作的新邊界案例保留 backlog，不冒充已覆蓋，也不阻塞本票僅因清單尚未全數實作。
- 平台／資源流程只對適用且具前置的 Mac／Windows 執行，原生與 Web 證據分開；所有明確排除項目如實列出。
- `npm run verify` 及本票實際改動的核心／專項流程完成適用檢查。文件、程式、選取與報告互相對得上。

## 相依與工作邊界

- PR #167 的搜尋驗收以實際合併狀態為準；本計畫沿用其成果，分層不改產品的文字正規化／詞界／片段規則。
- #167 已記錄完整重建後同級片段結果可能互換；排序需求由產品另定，不在測試重整中調整搜尋引擎來迎合斷言。
- 已知產品問題，例如 [#150](https://github.com/derektu/xr-collector/issues/150) 程序退出與 [#165](https://github.com/derektu/xr-collector/issues/165) Windows 引擎崩潰，與驗收工具問題分別記錄；不透過測試分層將失敗標成通過。
- 未來新增功能的使用頻率、風險及成本依相同原則分類。執行一次維護 skill 本身不代表所有子功能均完整自動化。

## 功能地圖 ID 清點

以下 66 個 ID 為盤點快照的索引，不是 66 個待新增的 E2E，也不要求每個 ID 每次執行。實際層級與工作處置見上表；外觀需另納入地圖。

| 功能檔 | 子功能 ID |
| --- | --- |
| `collect-video.md` | `collect-add`、`collect-mismatch`、`collect-done`、`collect-read`、`collect-fail` |
| `subscriptions.md` | `sub-add`、`sub-status`、`sub-check`、`sub-pause`、`sub-auto`、`sub-remove`、`sub-detail`、`sub-failure`、`sub-offline` |
| `activity.md` | `activity-summary`、`activity-detail`、`activity-raw` |
| `jobs.md` | `jobs-empty`、`jobs-sections`、`jobs-retry`、`jobs-dismiss`、`jobs-badge`、`jobs-row-text` |
| `documents-reader-search.md` | `docs-list`、`docs-filter`、`docs-search`、`docs-search-normalization`、`docs-search-fragments`、`docs-search-unavailable`、`reader-view`、`reader-delete`、`reader-recollect` |
| `rss.md` | `rss-add-feed`、`rss-add-page`、`rss-atom`、`rss-articles`、`rss-check`、`rss-failure`、`rss-settings` |
| `vault-transfer.md` | `vault-info`、`vault-export`、`vault-import-merge`、`vault-import-replace`、`vault-import-nothing`、`vault-move`、`vault-open-other`、`vault-fixed` |
| `tray.md` | `tray-menu`、`tray-hide`、`tray-actions`、`tray-open`、`tray-hint`、`tray-second-launch`、`tray-quit` |
| `build-info.md` | `build-info-settings`、`build-info-onboarding`、`build-info-api` |
| `login-startup.md` | `login-startup-setting`、`login-startup-unavailable`、`login-startup-background`、`login-startup-single-instance`、`login-startup-os-state` |
| `agent-connection.md` | `agent-connection-summary`、`agent-connection-help`、`agent-connection-export`、`agent-connection-settings` |

## 程式核對入口

- [收錄流程](../.claude/skills/verify/flows/)與[選取／執行器](../.claude/skills/verify/scripts/lib/flows.mjs)。
- [地圖與流程一致性測試](../tests/tooling/verify-skill/flows.test.ts)：已有名稱一致性檢查，沒有完整覆蓋的自動證明。
- [單元與整合測試分類](../tests/README.md)：確認已有下層保障，避免建立重複 E2E。
- [真實來源 smoke](../.claude/skills/verify/examples/smoke-real.mjs)、[Desktop smoke](../.claude/skills/verify/scripts/smoke-desktop.mjs)、[打包離線 smoke](../.claude/skills/verify/scripts/smoke-packaged-offline.mjs)：已有可執行程式，無須以新增相同 smoke 作為覆蓋成果。
- [外觀控制](../src/web/Settings.tsx)、[主題狀態與持久性](../src/web/App.tsx)、[主題邏輯測試](../tests/web/app-shell.test.ts)、[Desktop preference 測試](../tests/electron/theme-preference.test.ts)。
