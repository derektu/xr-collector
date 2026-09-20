# XR Collector Product Brief

> 第一版交付範圍與開發順序見 [YouTube-only MVP 計畫](mvp-plan.md) 與 [GitHub #1](https://github.com/derektu/xr-collector/issues/1)。本文保留產品背景或設計候選；超出該 MVP 的內容不是開工前置條件。

## 產品定位

XR Collector 是支援 macOS 與 Windows 的個人資料收集與存取 Desktop application，讓使用者擁有一個自動彙整資料、可瀏覽、可搜尋，也能交給 Agent 使用的工具。

使用者在不同平台有自己的訂閱、偏好與可存取內容。其中部分資訊需要登入個人帳號後才能取得，資料收集因此需要處理 client 端的個人使用情境。

XR Collector 將收集到的內容保存為一份份文件，讓使用者清理內容、編輯與整理資料，並開放資料供使用者選擇的 Agent 存取。使用者可以透過 Agent 萃取 Evidence、整理 Claims、交叉比對來源，或完成自己的應用任務。

桌面執行環境、Web UI、API 與資料管理的設計方向見[整體架構](architecture.md)。

## 核心使用流程

1. 使用者設定希望收集的資料來源，並在需要時登入對應平台的個人帳號。
2. XR Collector 依來源與使用者設定收集內容，保存為具有 metadata 的原始資料文件。
3. 使用者在 XR Collector 中檢視與編輯文件，清除擷取雜訊，並透過時間、資料源類型、tags 與文字搜尋整理及尋找資料。
4. 使用者透過 Agent 存取這些資料，進行分析、知識萃取或其他應用。

## 產品範圍

### 資料收集 Pipeline

XQ 平台透過 API 提供平台內所有新聞、研究報告等 raw data，作為 Collector 的內建資料來源。具體 API 契約另行定義。

外部收集聚焦台灣投資人關注的 RSS 文章、YouTube 字幕與 Facebook 粉專貼文，並提供 Web 內容匯入能力。各來源的取得方式與完整度需逐一驗證；X 不在本版範圍。

XR Collector 優先處理 client 端的個人資料收集，包括：

- 依使用者的訂閱、偏好或指定來源收集內容。例如不同使用者在 YouTube 上關注的內容不同。
- 整合需要登入才能取得內容的情境，讓收集流程能使用該使用者的存取身分。
- 自動彙整設定範圍內的資料，降低使用者逐一開啟平台、複製與整理內容的負擔。

### Browser 與內容匯入

XR Collector 提供內建 Browser，讓使用者登入資料來源，並由 Collector 管理 Browser Session，供後續以該使用者身分瀏覽與收集內容。

Browser Extension 提供從使用者日常使用的瀏覽器一鍵匯入內容的入口。手動建立文件的介面也是產品設計的候選能力，其交付範圍另行確認。

### 文件與內容整理

文件採 Markdown + YAML frontmatter，包含正文與用於識別、追溯及檢索的 metadata，例如來源、原始連結、標題、時間與 tags。Open Knowledge Format（OKF）是格式相容性的候選基礎，採用範圍與欄位另行定義。

使用者能編輯正文、移除擷取雜訊並整理 metadata。擷取原始內容與使用者編輯內容需要區分；保存、復原及重新收集時的處理方式另行設計。AI 摘要、Evidence、Claims 與其他衍生結果不覆寫擷取原始內容。

內容整理流程以 Research Station 的草稿區為參考：收集內容可先經使用者檢視與調整，再納入知識庫。草稿、入庫與各種內容入口的具體流程另行討論。

文件是使用者可直接取得與使用的資料資產，其使用不依賴 XR Collector 的畫面。

### 瀏覽與搜尋

XR Collector 對文件提供類似資料庫的基本管理與查詢體驗：

- 依時間、資料源類型與 tags 提供文件檢視與篩選。
- 開啟文件，閱讀與編輯內容並查看來源資訊。
- 以文字搜尋尋找相關文件與內容。

文字搜尋採用 Meilisearch，搜尋能力隨 Desktop application 交付，使用者不需另外安裝或管理搜尋引擎。引擎整合方式另行確認。

### Agent 存取

XR Collector 開放已收集的原始資料與 metadata，讓使用者能透過自己選擇的 Agent 尋找、讀取與使用內容。

XR Collector 提供 HTTP API 與配套 Skill，讓外部 Agent 存取資料。Agent 的典型用途包含跨文件整理、Evidence 與 Claims 萃取、多來源交叉比對，以及產生研究結果。API 契約、存取權限與草稿可見範圍另行設計。

## 範圍邊界

XR Collector 的交付重點是「收集與匯入 → 保存與整理文件 → 瀏覽與搜尋 → Agent 存取」。

內建的 Evidence／Claims 萃取、多來源交叉比對 pipeline，以及 CEO Daily 等專用應用畫面，屬於 XR 的範圍，不包含在 XR Collector 的交付範圍。使用者可自行透過 Agent 使用收集到的資料執行這些工作。

## 與 XR 的關係

XR 是完整的個人知識管理應用，以 Research Station 為應用參考，涵蓋三個層次：

| 層次 | 職責 |
|---|---|
| Raw | 透過資料收集 pipeline，取得並保存各種來源的原始內容與來源資訊。 |
| Derived | 從原始內容萃取 Evidence 與 Claims，進行多個來源的交叉比對與交互驗證，形成可追溯到來源的衍生知識。 |
| Applications | 運用 Raw 與 Derived 資料，提供 CEO Daily 等不同用途的應用畫面與研究工作流程。 |

XR Collector 是獨立開發、可獨立使用的專案，專案目錄為 `xr-collector`。它未來會成為 XR 的一部分。Desktop 內建 Web Server，以標準 Web 畫面與 HTTP API 支援未來 XR application 與 Server 共用前端程式碼；具體應用與完整 XR 整合另行規劃。

## XR Lab 的角色

XR Lab 是 XR 的研究與驗證場域，涵蓋 XQ 現有資料的收集 pipeline、Derived 層的萃取實驗，以及 CEO Daily 等應用驗證。

XR Collector 可採用 XR Lab 已驗證的資料收集成果，其交付聚焦於可獨立使用的資料收集與存取能力，不以完整 Derived 層或應用實驗完成為前提。

## 完成判準

使用者能在 macOS 或 Windows 上，將設定範圍內的個人來源內容收集或匯入為文件，在 XR Collector 中檢視、清理、編輯與搜尋資料，並透過自己的 Agent 使用同一批資料完成後續工作。
