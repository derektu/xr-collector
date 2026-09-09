# XR Collector Product Brief

## 產品定位

XR Collector 是支援 macOS 與 Windows 的個人資料收集與存取 Desktop application，讓使用者擁有一個自動彙整資料、可瀏覽、可搜尋，也能交給 Agent 使用的工具。

使用者在不同平台有自己的訂閱、偏好與可存取內容。其中部分資訊需要登入個人帳號後才能取得，資料收集因此需要處理 client 端的個人使用情境。

XR Collector 將收集到的內容保存為一份份原始資料文件，提供基本管理介面，並開放資料供使用者選擇的 Agent 存取。使用者可以先透過 Agent 萃取 Evidence、整理 Claims、交叉比對來源，或完成自己的應用任務。

## 核心使用流程

1. 使用者設定希望收集的資料來源，並在需要時登入對應平台的個人帳號。
2. XR Collector 依來源與使用者設定收集內容，保存為具有 metadata 的原始資料文件。
3. 使用者在 XR Collector 中瀏覽、閱讀與搜尋已收集的資料。
4. 使用者透過 Agent 存取這些資料，進行分析、知識萃取或其他應用。

## 產品範圍

### 資料收集 Pipeline

資料來源涵蓋 YouTube、Facebook、RSS、Web，以及 XQ 平台提供的新聞、研報等內容。各來源的支援順序與實際收集項目需逐一確認。

XR Collector 優先處理 client 端的個人資料收集，包括：

- 依使用者的訂閱、偏好或指定來源收集內容。例如不同使用者在 YouTube 上關注的內容不同。
- 整合需要登入才能取得內容的情境，讓收集流程能使用該使用者的存取身分。
- 自動彙整設定範圍內的資料，降低使用者逐一開啟平台、複製與整理內容的負擔。

### 原始資料文件

每筆收集到的內容保存為一份獨立文件，包含結構化 metadata 與原始內容。文件採接近 Obsidian 的 frontmatter 文件形式，便於應用程式與 Agent 讀取；具體序列化格式另行定義。

Metadata 用於識別、追溯與檢索內容，例如來源、原始連結、標題與時間資訊。正文保存取得的原始內容，AI 摘要、Evidence、Claims 與其他衍生結果不覆寫原文。

Raw 文件是使用者可直接取得與使用的資料資產，其使用不依賴 XR Collector 的畫面。

### 瀏覽與搜尋

XR Collector 對原始資料文件提供類似資料庫的基本管理與查詢體驗：

- 瀏覽收集到的文件，並依來源、時間等 metadata 篩選。
- 開啟文件，閱讀原始內容並查看來源資訊。
- 以文字搜尋尋找相關文件與內容。

文件保存方式與搜尋索引的技術選擇另行設計。

### Agent 存取

XR Collector 開放已收集的原始資料與 metadata，讓使用者能透過自己選擇的 Agent 尋找、讀取與使用內容。

Agent 的典型用途包含跨文件整理、Evidence 與 Claims 萃取、多來源交叉比對，以及產生研究結果。具體存取方式另行設計。

## 範圍邊界

XR Collector 的交付重點是「收集 → 保存 Raw 文件 → 瀏覽與搜尋 → Agent 存取」。

內建的 Evidence／Claims 萃取、多來源交叉比對 pipeline，以及 CEO Daily 等專用應用畫面，屬於 XR 的範圍，不包含在 XR Collector 的交付範圍。使用者可自行透過 Agent 使用收集到的資料執行這些工作。

## 與 XR 的關係

XR 是完整的個人知識管理應用，以 Research Station 為應用參考，涵蓋三個層次：

| 層次 | 職責 |
|---|---|
| Raw | 透過資料收集 pipeline，取得並保存各種來源的原始內容與來源資訊。 |
| Derived | 從原始內容萃取 Evidence 與 Claims，進行多個來源的交叉比對與交互驗證，形成可追溯到來源的衍生知識。 |
| Applications | 運用 Raw 與 Derived 資料，提供 CEO Daily 等不同用途的應用畫面與研究工作流程。 |

XR Collector 是獨立開發、可獨立使用的專案，專案目錄為 `xr-collector`。它未來會成為 XR 的一部分；整合方式屬於後續議題，不在本專案目前的設計與交付範圍內。

## XR Lab 的角色

XR Lab 是 XR 的研究與驗證場域，涵蓋 XQ 現有資料的收集 pipeline、Derived 層的萃取實驗，以及 CEO Daily 等應用驗證。

XR Collector 可採用 XR Lab 已驗證的資料收集成果，其交付聚焦於可獨立使用的資料收集與存取能力，不以完整 Derived 層或應用實驗完成為前提。

## 完成判準

使用者能在 macOS 或 Windows 上，將設定範圍內的個人來源內容收集為原始資料文件，在 XR Collector 中找到並閱讀這些資料，並透過自己的 Agent 使用同一批資料完成後續工作。
