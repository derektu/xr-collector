# summarize：本機內容擷取與依賴盤點

研究日期：2026-09-09。原始碼版本：`41375359bd55da4bdc2e3a861dfd0a0695c1c6af`，core package 版本 `0.21.13`。本輪以公開 repository 原始碼與第一方文件交叉確認；未安裝套件、執行擷取、存取 cookies 或測試登入網站。以下是程式能力的證據，不是台灣來源的成功率承諾。

## 結論

summarize 適合作為 **網頁正文、YouTube 既有字幕與 Browser 當前內容擷取的參考／library 候選**。它有獨立的 `@steipete/summarize-core`，不必為擷取引入摘要模型。它不是現成的 RSS 訂閱管理或 Facebook 粉專爬蟲。內容擷取、語音辨識與付費服務要分開設定，不能把 `--extract` 等同「一定不呼叫雲端」。[core 介面](https://github.com/steipete/summarize/blob/41375359bd55da4bdc2e3a861dfd0a0695c1c6af/packages/core/package.json#L13-L45)、[extract 說明](https://github.com/steipete/summarize/blob/41375359bd55da4bdc2e3a861dfd0a0695c1c6af/docs/extract-only.md#L11-L35)

| 能力 | 可不使用付費擷取服務 | 實際做法與邊界 |
|---|---|---|
| 公開網頁正文 | 可以 | 直接 HTTP fetch HTML，再以 Readability 擷取文章；無法假設會執行頁面 JavaScript 或使用已登入瀏覽器身分 |
| Browser 當前內容 | 可以 | content script 讀當前 DOM，Readability 失敗則退到 body.innerText；只代表當前已載入內容 |
| YouTube 既有字幕 | 可以 | 直接解析 YouTube 網頁資訊，呼叫 youtubei／captionTracks；不需要使用者的付費字幕 API key |
| YouTube 無字幕影片 | 有本機路徑 | 取得音訊後以本機語音模型辨識；不是取得原有字幕，需要模型與執行資源 |
| RSS | 部分相關元件 | 有 XML/feed 處理，主要用於 Podcast transcript/enclosure；未確認完整新聞訂閱、排程、去重系統 |
| Facebook 粉專 | 未找到專屬實作 | 通用 DOM 擷取可作試驗基礎；沒有證據證明能完整取得粉專歷史、分頁、全文或留言 |

網頁依據：[fetch](https://github.com/steipete/summarize/blob/41375359bd55da4bdc2e3a861dfd0a0695c1c6af/packages/core/src/content/link-preview/content/fetcher.ts#L232-L270)、[Readability](https://github.com/steipete/summarize/blob/41375359bd55da4bdc2e3a861dfd0a0695c1c6af/packages/core/src/content/link-preview/content/index.ts#L416-L453)。Browser、YouTube、RSS 的實作證據見下文。

## YouTube：字幕與重新轉錄是兩種資料

`auto` 的實際程式順序如下，任何成功分支即返回：

1. `youtubei` 既有轉錄稿。
2. `captionTracks` 既有字幕軌。
3. 若有 yt-dlp 與可用轉錄器，下載音訊並轉錄。
4. 若有轉錄器，嘗試直接解析 YouTube 音訊網址，再轉錄（`youtube-media`）。
5. 若有 Apify token，最後才嘗試 Apify。

`web` 僅走前兩種，`yt-dlp` 明確要求 binary 與轉錄能力；`no-auto` 優先只取創作者字幕，之後仍可能重新轉錄；`apify` 強制外部服務。[主流程](https://github.com/steipete/summarize/blob/41375359bd55da4bdc2e3a861dfd0a0695c1c6af/packages/core/src/content/transcript/providers/youtube.ts#L102-L146)、[字幕內部順序與截斷檢查](https://github.com/steipete/summarize/blob/41375359bd55da4bdc2e3a861dfd0a0695c1c6af/packages/core/src/content/transcript/providers/youtube/provider-flow.ts#L209-L264)、[Apify token 條件](https://github.com/steipete/summarize/blob/41375359bd55da4bdc2e3a861dfd0a0695c1c6af/packages/core/src/content/transcript/providers/youtube/provider-flow.ts#L158-L171)

`docs/youtube.md` 的簡略順序省略第 4 層，本報告以目前 code 為準。`native-media` 名稱指不經 yt-dlp 解析音訊並送到轉錄器，**不代表內建免費語音辨識，也不是平台字幕**。Web 字幕則使用網頁解析出的設定呼叫 `youtubei/v1/get_transcript`，不能當作 YouTube 官方 Data API 的穩定合約。[native-media](https://github.com/steipete/summarize/blob/41375359bd55da4bdc2e3a861dfd0a0695c1c6af/packages/core/src/content/transcript/providers/youtube/native-media.ts#L7-L59)、[youtubei request](https://github.com/steipete/summarize/blob/41375359bd55da4bdc2e3a861dfd0a0695c1c6af/packages/core/src/content/transcript/providers/youtube/api.ts#L150-L188)

轉錄預設會先使用已設定的 Groq，其次本機 ONNX、本機 whisper.cpp，最後才是已設定的 AssemblyAI、Gemini、OpenAI、FAL、Deepgram。因此安裝本機 Whisper 並不代表預設一定先用本機。[轉錄主流程](https://github.com/steipete/summarize/blob/41375359bd55da4bdc2e3a861dfd0a0695c1c6af/packages/core/src/transcription/whisper/core.ts#L117-L144)、[其他 cloud 順序](https://github.com/steipete/summarize/blob/41375359bd55da4bdc2e3a861dfd0a0695c1c6af/packages/core/src/transcription/whisper/cloud-providers.ts#L79-L86)

Collector 應保留 `transcriptSource`／轉錄方式與可取得的時間區段，讓「平台字幕」與「本機辨識」在來源追溯上可辨識。字幕內容有截斷 heuristic，但仍需測試中文完整性、影片長度、人工／自動字幕與最近上架影片。

## 不依賴付費服務的擷取組合

以下是依程式分支推導的驗證起點，**尚未執行**；不是要求產品使用者安裝 CLI。

```bash
# 公開文字文章：只取正文，停用 Firecrawl 與媒體轉錄路徑
summarize 'https://example.com/article' --extract --format text --plain --firecrawl off --embedded-video off --video-mode auto --preprocess off

# YouTube：僅取既有字幕，不進入音訊轉錄或 Apify
summarize 'https://www.youtube.com/watch?v=VIDEO_ID' --extract --format text --plain --youtube web --firecrawl off --timestamps
```

第一組限定一般文字文章；遇到被識別為獨立影音的輸入仍需由 Collector 的 provider allowlist 限制。最清楚的產品策略是只向 core 注入允許的 provider 與設定，避免繼承使用者環境中已有的服務 keys。YouTube `web` 的模式分支本身就排除音訊與 Apify fallback。[模式程式](https://github.com/steipete/summarize/blob/41375359bd55da4bdc2e3a861dfd0a0695c1c6af/packages/core/src/content/transcript/providers/youtube.ts#L109-L143)、[網頁選項](https://github.com/steipete/summarize/blob/41375359bd55da4bdc2e3a861dfd0a0695c1c6af/docs/website.md#L43-L62)

若要無付費的無字幕轉錄，則使用 `auto` 搭配已準備好的本機轉錄器，**不提供 Groq、其他 cloud 轉錄 keys 或 Apify token**；選擇 yt-dlp 路徑還要準備對應 binary。這些條件排除付費 API，仍會下載網站內容／可能下載模型，也有 CPU、記憶體與磁碟成本。[安裝與依賴](https://github.com/steipete/summarize/blob/41375359bd55da4bdc2e3a861dfd0a0695c1c6af/docs/install.md#L53-L94)

`--extract` 不呼叫摘要 LLM，預設不套內容字數上限；可輸出全文與 timestamps。但清理過的正文／字幕不是網頁 HTML 的逐位元原始保存。[extract](https://github.com/steipete/summarize/blob/41375359bd55da4bdc2e3a861dfd0a0695c1c6af/docs/extract-only.md#L11-L24)

Markdown 必須另外辨識：`--markdown-mode llm` 仍可使用 LLM；此版本 extract 分支的非 LLM HTML→Markdown 路徑會使用 `uvx markitdown`，未設定 converter 時有錯誤／diagnostic，不能只看到 `--format md` 就承諾已產出完整 Markdown 結構。Collector 可借用 Readability 取得 article HTML，再由自身確定性的 Markdown converter 處理。[轉換分支](https://github.com/steipete/summarize/blob/41375359bd55da4bdc2e3a861dfd0a0695c1c6af/src/run/flows/url/markdown.ts#L221-L258)、[core converter handling](https://github.com/steipete/summarize/blob/41375359bd55da4bdc2e3a861dfd0a0695c1c6af/packages/core/src/content/link-preview/content/html.ts#L136-L179)

Firecrawl 預設 `auto` 可在正文受阻／過薄時使用；文件並說明 `--extract --format md` 且已設定 Firecrawl key 時會預設優先 Firecrawl。欲避免該依賴應明確指定 `--firecrawl off`。免費額度與是否採用另見 [擷取服務研究](extraction-services.md)。[Firecrawl 模式](https://github.com/steipete/summarize/blob/41375359bd55da4bdc2e3a861dfd0a0695c1c6af/docs/firecrawl.md#L11-L26)

## Browser 與 Facebook

Extension 的擷取函式直接 `document.cloneNode(true)`，經 Readability 後取 text，否則取 body.innerText，並依 maxChars 截斷。因此已登入分頁的可見內容有機會直接取到，無需先匯出 cookies；但這是 DOM 取材，不等於後端 fetch 自動共享登入狀態，也不等於網站全文／全部貼文都已載入。[extract content script](https://github.com/steipete/summarize/blob/41375359bd55da4bdc2e3a861dfd0a0695c1c6af/apps/chrome-extension/src/entrypoints/extract.content.ts#L171-L218)

Facebook、Instagram 被列入 **always-on 自動注入排除名單**；不宜直接推論完全不支援手動操作，因為 background 在找不到 receiver／逾時後會按需注入 extract script。這一版仍未找到 Facebook 專屬貼文辨識、粉專分頁、排程收集的實作。對 XR 的可行結論是「可以借鏡通用 Browser clipper 架構，Facebook 單篇全文需另做實測」，而不是「已找到免費 Facebook 粉專爬蟲」。[排除名單](https://github.com/steipete/summarize/blob/41375359bd55da4bdc2e3a861dfd0a0695c1c6af/apps/chrome-extension/src/lib/content-script-matches.ts#L1-L15)、[套用位置](https://github.com/steipete/summarize/blob/41375359bd55da4bdc2e3a861dfd0a0695c1c6af/apps/chrome-extension/src/entrypoints/extract.content.ts#L388-L391)、[按需注入](https://github.com/steipete/summarize/blob/41375359bd55da4bdc2e3a861dfd0a0695c1c6af/apps/chrome-extension/src/entrypoints/background/content-script-bridge.ts#L68-L93)、[重試條件](https://github.com/steipete/summarize/blob/41375359bd55da4bdc2e3a861dfd0a0695c1c6af/apps/chrome-extension/src/entrypoints/background/content-script-bridge.ts#L103-L125)

目前 Extension 的 daemon 整合採 **Chrome Native Messaging**，不是直接讓 Extension 走 localhost daemon HTTP；直接搬整個 extension 並不符合 XR 已確認的 HTTP API 設計。可參考 extraction 模組，重新接 Collector 的匯入 API。[extension transport 文件](https://github.com/steipete/summarize/blob/41375359bd55da4bdc2e3a861dfd0a0695c1c6af/docs/chrome-extension.md#L24-L29)

## RSS 與跨平台範圍

程式接受 RSS／Atom XML，Podcast parser 從 feed 尋找 enclosure 音訊、集數與逐字稿。這不能證明它提供投資新聞的完整訂閱管理。XR 可自行維護 RSS 清單、增量掃描、去重，再將文章 URL 送入正文擷取器。[content types](https://github.com/steipete/summarize/blob/41375359bd55da4bdc2e3a861dfd0a0695c1c6af/packages/core/src/content/link-preview/content/fetcher.ts#L110-L119)、[feed enclosure](https://github.com/steipete/summarize/blob/41375359bd55da4bdc2e3a861dfd0a0695c1c6af/packages/core/src/content/transcript/providers/podcast/rss-feed.ts#L1-L48)

官方標示 npm CLI 支援 Mac、Linux、Windows，Node >=24；core 也是 Node >=24 ESM，主要 dependencies 為 Readability、linkedom、sanitize-html、undici。這對 Electron 的本機 Web Server 是可研究的接合點，但仍需測試採用的 Electron Node runtime 相容性。[install](https://github.com/steipete/summarize/blob/41375359bd55da4bdc2e3a861dfd0a0695c1c6af/docs/install.md#L11-L15)、[core package](https://github.com/steipete/summarize/blob/41375359bd55da4bdc2e3a861dfd0a0695c1c6af/packages/core/package.json#L77-L91)

完整影音能力的額外 binary、model、ONNX runtime 並不因為 import core 就全部附帶。專案有 FFmpeg WASM fallback；Chrome Browser media 模式另有按需下載 Whisper Tiny、WebGPU／WASM CPU 路徑，文件說尚未提供離線 model bundling。Windows daemon 透過 Scheduled Task，extension 文件也記錄 Windows native-host packaging 尚有缺口。這些皆需與「XR 安裝完即可使用」的包裝要求分開驗證。[媒體依賴](https://github.com/steipete/summarize/blob/41375359bd55da4bdc2e3a861dfd0a0695c1c6af/docs/install.md#L53-L94)、[Windows與Browser模型限制](https://github.com/steipete/summarize/blob/41375359bd55da4bdc2e3a861dfd0a0695c1c6af/docs/chrome-extension.md#L58-L74)

License identifier：MIT；本輪僅記錄，不作授權解釋。[LICENSE](https://github.com/steipete/summarize/blob/41375359bd55da4bdc2e3a861dfd0a0695c1c6af/LICENSE#L1-L10)

## 建議驗證順序

1. 台灣財經 YouTube：人工字幕、自動中文字幕、無字幕、長片各取樣，先測 `web`，檢查全文、時間段、繁簡與截斷。
2. RSS 發現文章後直接擷取，與使用者 Browser clipper 結果比較正文完整度。
3. Facebook 單篇已展開貼文的 Browser DOM 擷取；確認原作者、時間、permalink、正文邊界與長文展開，再評估粉專自動追蹤。
4. 只有字幕缺失才比較本機語音模型；不要把重新轉錄列為第一版字幕擷取的必要付費依賴。

上述建議尚未修改 Collector 的已確認產品範圍。
