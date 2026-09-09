# 收集能力研究

本目錄提供 XR Collector 的來源研究與技術可行性證據。XQ raw data 是內建 API 來源；外部收集聚焦 RSS、YouTube 字幕與 Facebook 粉專，X 不在本版範圍。

研究結論不等同於功能驗收。各報告區分原始碼已有路徑、官方聲明、設計推論與實測結果，具體來源需通過驗證後才能形成交付承諾。

## 文件

| 文件 | 用途 |
|---|---|
| [Research Station 來源盤點](knowledge-sources.md) | 已有程式、內容保存方式與本版研究範圍 |
| [Browser 收集可行性](browser-collection-feasibility.md) | 登入、DOM、Extension 與官方 API 限制 |
| [Agent-Reach](agent-reach.md) | 本機工具與第三方服務依賴，追查至上游 adapter |
| [summarize](summarize.md) | 正文、字幕、轉錄及 extract-only 的實際路徑 |
| [外部擷取服務](extraction-services.md) | Firecrawl、Jina Reader 與 ScrapeCreators 免費條件 |

## 2026-09-09 技術選項摘要

下表是跨報告綜合判斷，來源與固定版本證據見各報告。

| 需求 | 可優先研究的本機路徑 | 外部依賴與缺口 |
|---|---|---|
| RSS／Atom | 本機 feed parser，取得文章 URL 後補抓正文 | feed description 不一定是全文；特定網站可能需 Browser |
| 一般文章 | summarize 的直接 HTTP／HTML 正文抽取，以及 Browser 當前 DOM 擷取 | Firecrawl、Jina 可選備援，不屬本機擷取 |
| YouTube 字幕 | summarize 的直接字幕取得路徑；Agent-Reach 使用的 yt-dlp 字幕工具 | 無字幕、網站阻擋與語言／時間資訊需測試；音訊轉錄不是字幕原文 |
| Facebook 指定粉專全文 | 參考 OpenCLI 的 Browser 操作與 Research Station Clipper | Agent-Reach 接入的 feed 不是指定粉專完整貼文收集；summarize 無專屬粉專 collector，尚缺可直接採用且已驗證的方案 |

## 採用方向提案

1. 預設收集路徑不要求付費擷取 API 或摘要 LLM，先取得可追溯的原文／字幕。
2. 本機工具可由產品打包管理，不要求使用者自行安裝完整 Agent-Reach 或其所有工具。
3. Firecrawl 每月免費額度、Jina Reader 免 key 路徑可作選配備援；額度與外部資料傳輸需明確表達。
4. YouTube 字幕失敗與音訊轉錄分開處理。轉錄涉及音訊下載、模型與運算成本，不能靜默取代原字幕。
5. Facebook 先以指定台灣財經粉專驗證全文、permalink、發文時間及增量收集，不能以首頁動態摘要成功作為完成判準。

這些方向尚未轉成實作決策。本輪未安裝或執行兩個 GitHub 專案、未使用帳號 cookies，也未呼叫付費服務。
