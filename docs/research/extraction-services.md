# 外部擷取服務與免費條件

查核日期：2026-09-09。範圍為 RSS 文章補抓、YouTube 字幕及 Facebook 公開粉專的候選依賴。XQ raw data 視為內建 API；X 不在範圍。本文是研究紀錄，尚未選定服務。

## 分類原則

- **本機直接擷取**：程式從使用者電腦連線到來源網站並解析，不必付第三方擷取 API 費用；仍可能需要本機工具或使用者登入。
- **外部免費服務**：由第三方伺服器取得內容，有速率或週期額度限制。免費不代表沒有外部依賴。
- **試用額度**：用完需要購買，不能當成持續免費的產品基礎。
- **付費服務**：只作使用者選配候選，不能隱含在預設免費路徑中。

「抓到原文」與「呼叫模型摘要」分開評估；純擷取應可在不設定付費 LLM key 的情況下完成。

## Firecrawl

[官方價格頁](https://www.firecrawl.dev/pricing)於本輪列出 Free Plan：每月 1,000 credits、每月重置、不需信用卡，頁面標示 2026-09-04 生效。這是每月額度，不是每日額度。另列 Agent Preview 每日五次免費執行，不能與一般 scrape 額度混用。

一般 scrape 每頁一 credit；進階格式可能額外計費。免費方案有併發及速率限制，API key／帳戶接入與額度用盡的行為需在整合時確認。未建立帳號或呼叫 API，本輪只確認公開價格，並以直接 HTTP GET 再次確認價格頁包含每月額度與生效日期。

**候選定位：**可列入有週期免費額度的外部備援。適合公開文章補抓；本輪沒有證據保證 Facebook 粉專全文或 YouTube 字幕可由通用 scrape 完整取得。

Firecrawl 也能 self-host，但[官方部署說明](https://github.com/firecrawl/firecrawl/blob/main/SELF_HOST.md)列出 API／workers、Playwright、Redis、RabbitMQ、PostgreSQL 等服務。推論：整套部署不適合直接當成輕量桌面內嵌套件，需獨立評估維護與打包成本。

## Jina Reader

[官方 Reader 頁面](https://jina.ai/reader/)列出 `r.jina.ai` 基本使用免 key、20 requests/min；加 key 的路徑按內容 token 計費，免費 key 附贈 token 不等同持續免費額度。`s.jina.ai` 搜尋是另一端點，本輪不把它當成文章擷取的必要依賴。

**候選定位：**免 key 的公開網頁文字化備援。它由 Jina 伺服器擷取，無法視為 Collector 本機擷取，也不能預設使用使用者的本機 Browser Session。共享 IP 的速率限制與來源網站阻擋需處理。

## Groq 音訊轉寫

Agent-Reach 的無字幕 fallback 會使用 Groq／OpenAI 雲端轉寫。[Groq 官方 rate limits](https://console.groq.com/docs/rate-limits)列有 Whisper Free Plan 的每日與每小時限額，符合持續免費額度候選；數值及原始碼見 [Agent-Reach 報告](agent-reach.md#youtube字幕與轉寫要分開)。

它需要 API key 並將音訊上傳，取得的是模型轉寫文字，不是 YouTube 原字幕。可作後續選配候選，本輪不擴大影音轉寫的交付範圍。

## ScrapeCreators

[Facebook API 官方說明](https://scrapecreators.com/facebook-api)提供公開粉專貼文端點；[官網](https://scrapecreators.com/)宣傳初始免費 credits。這些資料不足以證明有固定重置的免費額度，因此本輪仍將其視為有試用額度的外部付費候選。Research Station 的實作見[來源盤點](knowledge-sources.md#facebook-第三方服務)。

## 整合方向提案

以本機直接擷取作預設，外部免費服務作可選備援。付費 API key 與模型 key 的存在，不應自動構成允許消耗費用的設定。

每次收集需能辨識實際採用的方法、取得的是全文／字幕／摘要或部分內容，以及是否使用外部服務。外部額度用盡後可等待重試或改由 Browser 主動匯入，不自動轉成付費方案。

上述是設計提案；本輪不安裝工具、不設定 key、不購買服務，也未完成目標網站端到端測試。價格與服務政策可能調整，採用時需再查核。
