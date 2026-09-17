# XR Collector 整體架構

> 第一版交付範圍與開發順序見 [YouTube-only MVP 計畫](mvp-plan.md) 與 [GitLab #1](https://gitscr1.moneydj.com/km/xr-collector/-/issues/1)。本文保留產品背景或設計候選；超出該 MVP 的內容不是開工前置條件。

## 文件定位

本文件記錄 XR Collector 已確認的架構方向與待設計事項。產品定位與交付範圍見 [Product Brief](product-brief.md)。具體框架、API schema、文件欄位與互動流程在對應設計階段確認。

資料保存、完整備份、跨機還原、vault 合併與搜尋索引的概念草案見 [資料儲存、備份、合併與搜尋](storage-and-search.md)。

## Desktop 與 Web Server

XR Collector 採 Electron 支援 macOS 與 Windows。Desktop application 內建標準 Web Server，同時提供 Web 畫面、前端資源與 HTTP API。Electron 視窗載入本機 Web Server 提供的頁面。

```text
Desktop Application
├─ Electron：桌面視窗、內建 Browser、程式生命週期
└─ 本機 Web Server
   ├─ Web 畫面與前端資源
   └─ HTTP API
      └─ 來源設定、收集、文件管理、瀏覽與搜尋
```

來源設定、文件編輯、瀏覽與搜尋等業務功能，均由 Web Server 提供畫面與 HTTP API，不使用 Electron IPC。Electron 專屬能力集中於桌面整合程式，避免前端畫面依賴 Electron。

## 與 Server 共用應用畫面

XR 的應用前端以標準 Web 技術實作。同一份前端程式碼可以部署在 Server 的 Web Server，也可以直接部署到 Desktop 內建的 Web Server。

兩個環境對共用畫面提供一致的 API 契約，前端不綁定特定主機位址或 Electron 執行環境。只要環境提供畫面需要的 API 與資料，前端程式碼即可直接共用。

| 環境 | 畫面載入位置 | 資料與能力 |
|---|---|---|
| Desktop | Electron 載入本機 Web Server | 個人收集的文件、本機整理與搜尋、內建 Browser |
| Server | 一般瀏覽器載入 Server Web Server | XQ 平台內建知識及 Server 提供的應用能力 |

API 契約一致不要求兩個環境採用相同的資料來源。Server 可服務不自行收集資料的客戶；Desktop 支援個人資料收集與使用。環境特有能力的呈現方式另行設計。

## 資料收集與 Browser

XQ 平台提供 API，供 Collector 直接取得平台內所有新聞、研究報告等 raw data，作為內建來源。具體契約另行提供，不沿用 Research Station 既有的 XQ 擷取方式。外部來源研究聚焦 RSS、YouTube 字幕與 Facebook 粉專貼文，X 不在本版範圍。

各資料來源依其特性取得內容，例如直接存取 RSS，或使用登入後的 Browser 瀏覽網頁。來源取得方式與共用的文件管理能力分開，讓各種來源取得的內容都能接受一致的整理與存取。

內建 Browser 供使用者登入來源平台。Collector 管理持續使用的 Browser Session，包含 cookies 等登入相關狀態，供後續以使用者身分瀏覽與收集內容。實際網站的登入維持與自動操作能力需逐一驗證，不能只以取得 cookies 作為可持續收集的判準。

Browser Extension 提供日常瀏覽時一鍵匯入內容的入口，與 Collector 內建 Browser 的自動收集用途互補。Extension 的內容擷取方式、匯入通道、授權及支援瀏覽器另行設計。

手動建立文件與撰寫內容是候選入口，需進一步確認產品範圍。各入口應共用文件管理與編輯能力。

## 文件與整理流程

資料以 Markdown + YAML frontmatter 保存，供使用者、應用與外部 Agent 直接使用。Metadata 支援來源追溯、時間、資料源類型與 tags 等組織方式。Open Knowledge Format（OKF）作為候選格式基礎，其相容範圍與 Collector 專用欄位尚待確認。

文件支援正文編輯與擷取雜訊清理。設計上需要區分擷取原始內容與使用者編輯內容，並處理重新收集與人工編輯的關係；具體保存結構、版本與復原政策尚未定案。

Research Station 的草稿區提供流程參考：內容先經使用者檢視、清理與調整，再納入知識庫。Collector 的草稿狀態、入庫操作、各入口是否採用相同流程，以及搜尋與 Agent 對草稿的可見範圍，均需另行討論。

## 搜尋與引擎交付

Meilisearch 提供文字搜尋。文件介面支援依時間、資料源類型與 tags 揭示及篩選資料；時間欄位與索引契約另行定義。

搜尋引擎隨 Desktop application 交付，使用者不需另外安裝、設定或管理 Meilisearch。

引擎整合有兩個待評估方向：

- 安裝包內附完整 Meilisearch，由 Desktop 自動管理內部 process。
- 直接整合底層 engine library，將搜尋能力嵌入程式。

兩者都能滿足不另外安裝的要求，但是否允許獨立 process 尚待確認。Meilisearch 的底層 `milli` 管理單一 index，完整 Meilisearch 的上層能力並非直接嵌入 `milli` 即可取得；採用 library 的成本需另行驗證。

第一版以 vault 保存文件及正式管理資料，支援完整備份、跨機還原與 vault 合併，不依賴同步或版本協調 server。各裝置的 Meilisearch 索引跟隨 vault 增量更新，並可重建。管理資料格式、本機 database、Git 是否作為版本管理實作及具體 process 配置尚未選定，範圍與待收斂事項見 [概念草案](storage-and-search.md)。

## 外部 Agent 存取

XR Collector 提供 HTTP API，並提供 Skill 說明如何存取與使用文件。Web UI 與外部 Agent 使用共用的文件管理及查詢能力。

API 的驗證方式、讀寫權限、是否允許觸發收集，以及草稿與正式知識的可見範圍，另行定義。Skill 的內容隨 API 契約設計。

## 待討論事項

- Web Server 與前端框架、Core 的執行配置，以及關閉視窗後的收集行為。
- Meilisearch 採完整引擎隨附或 library 內嵌。
- 文件 metadata、OKF 相容範圍、附件與原始內容保存方式。
- 草稿、人工編輯、正式入庫及重新收集的流程。
- Browser Session 的帳號管理、登入失效與來源驗證。
- Browser Extension 的擷取與匯入方式，以及手動建立文件的交付範圍。
- API 契約、驗證、權限與 Agent Skill。

## 技術參考

- [Meilisearch](https://github.com/meilisearch/meilisearch)
- [Meilisearch 底層引擎 milli](https://github.com/meilisearch/meilisearch/tree/main/crates/milli)
- [Open Knowledge Format 規格](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)
- [Electron Session](https://www.electronjs.org/docs/latest/api/session)
- [Electron WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view)
