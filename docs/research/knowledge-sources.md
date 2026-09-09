# 第一版知識來源候選與 Research Station 盤點

查核日期：2026-09-09。本文供產品範圍討論，候選優先序尚未定案。

## 證據範圍

本輪閱讀 `/Users/derektu/projects/km/research-station` 的文件與程式碼，版本為 `e8338da`，查核時工作目錄乾淨。未執行其排程、AI 處理或資料庫寫入，也未使用登入帳號驗證付費網站。下表的「已有實作」只代表找到程式路徑，不代表跨平台或目標網站已通過執行測試。

公開網路查核包含官方文件、公司 IR 頁面與一次 RSS HTTP／XML 驗證。Browser 可行性與官方限制見[瀏覽器收集研究](browser-collection-feasibility.md)。

## 本版來源範圍

XQ 平台提供 API，讓 Collector 直接取得平台內所有新聞、研究報告等 raw data，作為產品內建來源。這是產品已確認的架構前提，API 的具體契約另行提供；Research Station 現有的 XQ 取得方式不沿用，也不作為本版可行性的限制。

本輪外部收集聚焦台灣投資人關注的社群與訂閱內容：

| 來源 | 目標內容 | 主要待驗證事項 |
|---|---|---|
| RSS | 使用者訂閱的財經文章、專欄及部落格內容 | feed 發現新文章、正文補抓、摘要與全文區分 |
| YouTube | 使用者關注頻道／影片的字幕原文 | 新片發現、字幕取得、語言與時間資訊、無字幕狀態 |
| Facebook 粉專 | 使用者關注的財經作者公開貼文 | 第三方服務的覆蓋、完整度、更新與分頁能力，以及是否需 Browser 輔助 |

X 排除於本版外部來源研究與實作範圍。Podcast 及其他來源保留既有盤點資料，不列為本輪重點。Browser Extension 與手動文件仍依整體架構討論，作為共用內容入口。

## Facebook 第三方服務

Research Station 使用的是 **ScrapeCreators 雲端 scraping API**。`scripts/daily-fb-fetch.cjs` 以 `x-api-key` 呼叫 `GET https://api.scrapecreators.com/v1/facebook/profile/posts`，傳入粉專 URL 或 pageId，並以 cursor 分頁；呼叫端未傳入使用者的 Facebook cookies，也沒有在此腳本啟動 Browser。

[服務商官方說明](https://scrapecreators.com/facebook-api)將此端點定義為擷取公開 profile 貼文，限定無痕瀏覽可看到的內容，一次回傳三篇。這是服務商聲稱的介面能力，本輪未呼叫其付費 API 驗證台灣粉專覆蓋率。

Research Station 證明的是第三方 API 整合，並非 Meta 官方任意粉專讀取介面。服務端究竟使用 Browser、網頁請求或其他內部方法，無法從呼叫端程式與已查閱的官方說明確認；不據此推定可移植成 Collector 本機爬蟲。

候選驗證先使用指定的公開財經粉專，比對 API 結果與公開頁面：全文、作者、發文時間、永久連結、最新貼文、分頁重複與缺漏。登入限定內容、社團及個人動態牆不由這個端點的能力外推。

## Research Station 實際收集能力

以下路徑均相對於 Research Station repo。

| 能力 | 程式證據與實際行為 | 對 Collector 的意義 |
|---|---|---|
| RSS | `src/app/api/research/rss/fetch/route.ts`：讀 RSS item，短內容補抓文章，補抓不足可能跳過，以來源 ID 與內容 hash 去重 | 可參考訂閱與補抓流程；不能保證所有 RSS 都有全文，Atom 支援需另外檢查 |
| 一般網址 | `src/app/api/research/raw/url-import/route.ts`、`src/lib/research/extract-article.ts`：server fetch HTML 後抽取正文 | 適用能直接取得的 HTML；不是完整 Browser renderer，也未沿用使用者登入 |
| 已登入頁面剪輯 | `wiki-content/wiki/clipper/extension/popup.js`：擷取 rendered HTML，亦有同源 `fetch(..., credentials: "include")`；`src/app/api/research/raw/clip/route.ts` 接收 HTML 並解析 | 與本機 Web Server 架構相符，可作單頁匯入參考；DigiTimes 另有特定選擇器與表單邏輯，不能泛化為所有付費網站 |
| XQ 新聞 | `src/app/api/research/xq/fetch-news/route.ts`：呼叫 XQ 後端讀列表與內容；程式含特定環境／XQ 啟動條件提示 | 舊實作盤點；Collector 改用平台提供的內建 raw data API，不沿用此環境前提 |
| XQ 研報 | `src/app/api/research/xq/push-reports/route.ts`：接收上游推送研報並入庫 | 舊實作盤點；Collector 改用平台提供的內建 raw data API |
| 研究報告上傳 | `src/app/api/research/reports/upload/route.ts`：PDF 文字抽取、DOCX／文字處理，並串接 AI 分析 | 文字 PDF 是候選起點；掃描 PDF、表格閱讀順序與原附件保存需驗證。程式將 `.doc` 交給 DOCX 工具，不代表舊 Word 格式已可靠支援 |
| Facebook KOL | `scripts/daily-fb-fetch.cjs`、`src/app/api/research/raw/fb-kols/run/route.ts`：呼叫 ScrapeCreators API 取得公開貼文文字，需 API key，略過過短或無文字項目 | 不是個人 Browser Session 收集；第三方依賴、登入社團與完整圖片／留言均不能視為已解決 |
| YouTube | `src/lib/research/process-raw-item.ts:24`：抓 watch HTML、解析 `ytInitialPlayerResponse` 與字幕 URL；`src/app/api/research/media-crawler/crawl/route.ts`：頻道 RSS 發現新片，有足夠字幕才繼續，將摘要寫入 content | 有非正式網頁解析路徑，需驗證當前可用性；字幕原文並未在此流程作為正文保存，不能直接移植成 Raw 保存流程 |
| Podcast | `src/app/api/research/media-crawler/crawl/route.ts`：解析 RSS description，截短後產生摘要 | 沒有在該路徑下載音訊並轉寫，不能稱完整 Podcast 知識收集 |
| X | `src/app/api/research/x-crawler/run/route.ts`：讀取 DB 的 `x_posts` 並同步至 Raw；註解說外部 API 應先填入資料 | 該入口不是已完成的外部 X 爬取實作；X 不在本版範圍 |
| 美股年報 | `src/app/api/research/annual-reports/fetch/route.ts`：SEC 10-K HTML → 節錄 → AI 摘要入庫 | 有美股年報路徑；不是台灣年報／法說自動收集，也不是完整原文保存 |
| 手動與圖片 | `src/app/api/research/raw/route.ts` 的 POST、`src/app/api/research/raw/extract-image/route.ts`：手動內容入庫與圖片交給 AI 視覺模型辨識 | 手動文字可參考；圖片辨識涉及模型成本與文字／數字品質，與單純附件保存分開 |

Research Station 亦有知識卡、Wiki、供應鏈及各種 AI 日報等應用，見 `docs/完整功能說明.md`。這些屬整理與衍生應用，不因來源盤點而納入 Collector 第一版。

其 Raw 流程也不全是人工確認：`src/lib/research/auto-process.ts` 對 Facebook 與 DigiTimes 設有自動 AI 解析；`src/lib/research/process-raw-item.ts` 可把 AI 產物寫回 content。Collector 的原始內容／編輯版本及入庫規則需要獨立設計。

## 本輪公開來源驗證

[中央社官方 RSS 說明](https://www.cna.com.tw/about/rss.aspx)列出產經證券 feed：`https://feeds.feedburner.com/rsscna/finance`。

2026-09-09 以 Python 標準庫執行一次公開 HTTP GET 與 XML 解析：HTTP 200、RSS 格式、20 個 item、20 個有 link。前五筆 description 長度為 105、96、107、101、100 字元。本輪未補抓這些文章全文；結果只證明 feed 可讀與摘要有限，不證明全文抽取成功或長期穩定性。

## Browser 驗證應回答的問題

| 場景 | 必要驗證 | 判定範圍 |
|---|---|---|
| 公開新聞 | 正文、來源、發布時間與文章完整度，避免側欄混入 | 成功只涵蓋測過的網站與頁型 |
| 會員文章，例如 DigiTimes | 使用者正常登入後讀取當前頁；重新啟動後 Session 是否有效；登入過期是否要求人工處理 | 分開驗證 Extension 與 Electron，不能把 Chrome 成功當成 Electron 成功 |
| Facebook 單篇貼文 | 展開全文、正確作者／時間／permalink、避免其他貼文與留言混入 | 先驗證 user-triggered clip；背景追蹤、社團與多頁載入另行測試 |
| YouTube | 有字幕與無字幕案例、繁中／自動字幕、完整文字與時間資訊 | 無字幕應明確回報，不能用描述或 AI 猜測取代逐字稿 |
| 文件匯入 | 文字 PDF 與掃描 PDF、表格、頁序、原附件與擷取文字的對應 | 保存檔案成功與內容可搜尋是兩個完成條件 |

Browser 操作尚未實測。本輪沒有對帳號、cookies 或私人內容進行存取。實作前需選定具體樣本與可使用帳號，進行小範圍可行性驗證。

## 接下來的驗證重點

以 RSS 全文取得、YouTube 字幕原文、Facebook 公開粉專貼文為三條收集路徑，分別驗證。XQ 視為內建資料來源，不投入既有 Research Station XQ 路徑的移植研究。

Facebook 優先研究可在本機執行的 Browser 收集方式；ScrapeCreators 保留為選配比較項，不作為要求使用者付費的預設依賴。指定粉專的新貼文、全文與來源追溯資訊需實際驗證。

本機工具與有免費額度之外部 API 的比較見[收集能力研究索引](README.md)，包含 Agent-Reach、summarize、Firecrawl 與 Jina Reader。
