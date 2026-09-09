# Agent-Reach 的本機收集能力研究

查核日期：2026-09-09。本文是來源與技術研究，不代表產品功能已定案。

## 證據範圍

本輪唯讀下載並閱讀 Agent-Reach 與其 Facebook／YouTube Browser 後端 OpenCLI 的公開原始碼，沒有安裝套件、執行收集工具、登入網站或存取 cookies。所有「可行候選」都是程式路徑分析，未實測台灣財經來源與 Mac／Windows 封裝。

- Agent-Reach：[`da5044d26fc6adddb6554d5679c94ac22e76e428`](https://github.com/Panniantong/Agent-Reach/tree/da5044d26fc6adddb6554d5679c94ac22e76e428)。
- OpenCLI：[`8271afc67e8504bda94c147f446ee29775d08274`](https://github.com/jackwener/opencli/tree/8271afc67e8504bda94c147f446ee29775d08274)。這是另行查核的當前版本，不能假定 Agent-Reach 所有既有安裝都使用同版。

本文「本機直接擷取」指程式在使用者電腦直接向目標平台取得內容，不經第三方代抓 SaaS；仍需網路，亦可能需登入。將 CLI 安裝在本機，不代表它的資料處理也在本機。

## 結論與適用範圍

| 能力 | 實際資料路徑 | 第三方雲端依賴 | Collector 判斷 |
|---|---|---|---|
| RSS／Atom | 本機 Python `feedparser` 直接讀 feed | 基本路徑無代抓 SaaS | 可作本機訂閱參考；不等於已取得 feed 外的文章全文 |
| YouTube 字幕 | `yt-dlp` 直接向 YouTube 取得字幕檔 | 字幕路徑不需代抓 API key | 優先驗證；需外部工具與 JS runtime，失敗不能誤判無字幕 |
| YouTube Browser 字幕 | OpenCLI 經本機 Chrome 讀播放器、字幕請求與文字 | 這條路徑不需代抓 SaaS | 可參考 Browser fallback；不是已證實可直接嵌入 Electron |
| 無字幕影音轉寫 | 本機下載／轉檔，再上傳 Groq 或 OpenAI | **需要雲端 API 與 key** | 是額外轉寫服務，不是本機字幕擷取 |
| 一般網頁 | 將 URL 送到 `r.jina.ai` 取得文字 | **Jina Reader 雲端** | 不能把 Agent-Reach 網頁閱讀算成本機原生擷取 |
| Facebook | OpenCLI 操作已登入 Chrome，讀取 DOM | 查到的 feed／profile／search 路徑無代抓 SaaS | 有真實實作，但未滿足指定粉專完整貼文收集 |

RSS 證據見 [`rss.py`](https://github.com/Panniantong/Agent-Reach/blob/da5044d26fc6adddb6554d5679c94ac22e76e428/agent_reach/channels/rss.py#L7-L27) 與 [feedparser 呼叫範例](https://github.com/Panniantong/Agent-Reach/blob/da5044d26fc6adddb6554d5679c94ac22e76e428/agent_reach/skill/references/web.md#L32-L42)；YouTube 見[字幕與 fallback 指引](https://github.com/Panniantong/Agent-Reach/blob/da5044d26fc6adddb6554d5679c94ac22e76e428/agent_reach/skill/references/video.md#L13-L69)；轉寫雲端端點見 [`transcribe.py`](https://github.com/Panniantong/Agent-Reach/blob/da5044d26fc6adddb6554d5679c94ac22e76e428/agent_reach/transcribe.py#L46-L57)；Jina 的實際 HTTP 呼叫見 [`web.py`](https://github.com/Panniantong/Agent-Reach/blob/da5044d26fc6adddb6554d5679c94ac22e76e428/agent_reach/channels/web.py#L48-L67)。Facebook 的具體限制如下。

## Facebook：有本機實作，但不是粉專全文收集器

Agent-Reach 的 [`FacebookChannel`](https://github.com/Panniantong/Agent-Reach/blob/da5044d26fc6adddb6554d5679c94ac22e76e428/agent_reach/channels/facebook.py#L1-L13) 確實指向 OpenCLI；其 [操作指引](https://github.com/Panniantong/Agent-Reach/blob/da5044d26fc6adddb6554d5679c94ac22e76e428/agent_reach/skill/references/social.md#L260-L278) 要求 Chrome、Extension 與 Facebook 登入狀態。因此 Facebook 並非只出現在 README 贊助商清單。

但追到 OpenCLI 程式後，需區分：

- `facebook profile <username>` 開啟指定個人／粉專，回傳名稱、username、朋友／追蹤者與 URL。沒有擷取該粉專的貼文列表。[profile 原始碼](https://github.com/jackwener/opencli/blob/8271afc67e8504bda94c147f446ee29775d08274/clis/facebook/profile.js#L1-L67)
- `facebook feed` 開啟 `https://www.facebook.com/`，讀取當前帳號的首頁動態；參數只有 `limit`，不是指定粉專 URL。這不等於某粉專按發文順序的完整時間線。[首頁 URL](https://github.com/jackwener/opencli/blob/8271afc67e8504bda94c147f446ee29775d08274/clis/facebook/feed.js#L4-L12)、[導覽與命令參數](https://github.com/jackwener/opencli/blob/8271afc67e8504bda94c147f446ee29775d08274/clis/facebook/feed.js#L344-L407)
- feed 會捨棄超過 600 字元的候選文字區塊，最終 `content` 更截為 120 字元；回傳欄位沒有發布時間、post ID 或永久連結，即使內部曾尋找 post URL。不能將此輸出當作 raw data 全文。[文字區塊篩選](https://github.com/jackwener/opencli/blob/8271afc67e8504bda94c147f446ee29775d08274/clis/facebook/feed.js#L115-L123)、[貼文輸出](https://github.com/jackwener/opencli/blob/8271afc67e8504bda94c147f446ee29775d08274/clis/facebook/feed.js#L159-L187)
- `facebook search` 的結果也截短標題與文字，適合發現候選，不是全文保存。[search 原始碼](https://github.com/jackwener/opencli/blob/8271afc67e8504bda94c147f446ee29775d08274/clis/facebook/search.js#L105-L127)

這些 DOM 解析規則包含英語／簡體中文字串與頁面結構假設；例如按鈕、廣告、時間文字的辨識，不能推定涵蓋繁體中文介面。[feed 辨識規則](https://github.com/jackwener/opencli/blob/8271afc67e8504bda94c147f446ee29775d08274/clis/facebook/feed.js#L57-L110)

**建議：**將 OpenCLI 視為「可在本機登入 Browser 中擷取內容」的程式參考，不直接承諾指定粉專自動追蹤。需另驗證：指定粉專導覽、全文展開、完整正文、發布時間與 permalink、最新貼文／歷史載入、去重與中斷續抓，以及繁中頁面。先做使用者指定單篇匯入也仍需實測。

## YouTube：字幕與轉寫要分開

Agent-Reach 的主要字幕操作是呼叫 `yt-dlp --write-sub --write-auto-sub --skip-download`，讀取 VTT。其範例語言是 `zh-Hans,zh,en`，Collector 不宜直接照抄成台灣字幕策略，需明確驗證 `zh-Hant` 等實際 track 與 fallback，保留來源語言、人工／自動字幕及時間資訊。[字幕操作](https://github.com/Panniantong/Agent-Reach/blob/da5044d26fc6adddb6554d5679c94ac22e76e428/agent_reach/skill/references/video.md#L13-L40)

`doctor` 僅檢查工具與 JS runtime，不會請求指定影片；它成功不代表該影片有可取得的字幕。文件提出 yt-dlp 失敗後改用 OpenCLI，再改用音訊轉寫；這是重試指引，不是所有影片已通過驗證的證據。[狀態與重試邊界](https://github.com/Panniantong/Agent-Reach/blob/da5044d26fc6adddb6554d5679c94ac22e76e428/agent_reach/skill/references/video.md#L42-L69)

OpenCLI 的字幕實作會利用播放器產生的 timedtext 請求，支援 raw 模式；JSON3 解析能產生 `start`、`end`、`text`。這比只返回摘要更符合 raw data 需求，但依賴 YouTube 網頁／播放器內部行為。[transcript 原始碼](https://github.com/jackwener/opencli/blob/8271afc67e8504bda94c147f446ee29775d08274/clis/youtube/transcript.js#L1-L61)

無字幕 fallback 的實作將音訊送至 Groq／OpenAI Whisper API，不是本機 Whisper inference。Groq 官方目前確有 Free Plan，`whisper-large-v3` 與 turbo 的公開表列為每分鐘 20 次、每日 2,000 次、每小時 7,200 音訊秒與每日 28,800 音訊秒；各限制共同生效，確切值以帳號 Limits 為準。這種有持續免費額度的服務可列為選用候選，仍需 key、網路與音訊上傳，不能把字幕取得與雲端轉寫混成一項保證。[Groq 官方 rate limits](https://console.groq.com/docs/rate-limits)

## 封裝依賴與移植判斷

Agent-Reach 本身是 Python >=3.10 工具，dependencies 包含 feedparser 與 yt-dlp；這不是可直接引入 Electron 前端的單一 JS library。它的 RSS channel 主要做可用性檢查，再由 Skill 指引 Agent 呼叫底層工具。[pyproject](https://github.com/Panniantong/Agent-Reach/blob/da5044d26fc6adddb6554d5679c94ac22e76e428/pyproject.toml#L1-L42)、[RSS channel](https://github.com/Panniantong/Agent-Reach/blob/da5044d26fc6adddb6554d5679c94ac22e76e428/agent_reach/channels/rss.py#L7-L27)

- yt-dlp 完整 YouTube 支援涉及 `yt-dlp-ejs` 與受支援 JS runtime；音訊轉寫流程還依賴 ffmpeg／ffprobe。可以研究隨 Collector 打包，但需驗證各 OS／CPU 架構與更新機制，不應要求一般使用者自行維護 Python 工具鏈。[yt-dlp 官方 dependencies](https://github.com/yt-dlp/yt-dlp#dependencies)、[Agent-Reach runtime 檢查](https://github.com/Panniantong/Agent-Reach/blob/da5044d26fc6adddb6554d5679c94ac22e76e428/agent_reach/channels/youtube.py#L68-L117)
- OpenCLI npm 版本要求 Node >=20.18.1，Browser 路徑使用 Chrome／Chromium Extension 與本機 daemon。官方另提供 Mac／Windows App，但那是另一個應用；不能據此認定直接嵌入 Collector 已完成。要沿用 Electron 自有 Browser Session，須獨立驗證與調整 Browser transport。[OpenCLI package](https://github.com/jackwener/opencli/blob/8271afc67e8504bda94c147f446ee29775d08274/package.json#L1-L10)、[官方桌面與 Bridge 說明](https://github.com/jackwener/opencli/blob/8271afc67e8504bda94c147f446ee29775d08274/README.md#L24-L51)
- 授權識別：Agent-Reach 為 MIT；OpenCLI 為 Apache-2.0。下游工具及各 binary build 仍各自有授權資訊，本輪只記錄識別，不作法律解釋。[Agent-Reach LICENSE](https://github.com/Panniantong/Agent-Reach/blob/da5044d26fc6adddb6554d5679c94ac22e76e428/LICENSE)、[OpenCLI LICENSE](https://github.com/jackwener/opencli/blob/8271afc67e8504bda94c147f446ee29775d08274/LICENSE)

對 Collector 較適合的方向是選用底層工具與擷取方法，透過 Collector 本機後端封裝成一致 API。Agent-Reach 的安裝／診斷／Skill 組合可作參考；本輪沒有證據要求整套納入產品。
