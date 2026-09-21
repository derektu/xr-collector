# XR Collector 產品範圍

XR Collector 是 macOS／Windows 的本機資料收集與存取工具。使用者擁有可攜的 Markdown Vault，透過 Desktop 與 Agent 使用同一份資料。產品的第一個來源是 YouTube 既有字幕；內容保存不依賴搜尋索引或雲端同步服務。

## 本輪目標

使用者能選擇自己的 Vault、設定來源並持續收集、搜尋與閱讀文件、移除不要的內容、查明失敗原因，以及備份或搬移資料。UI 與 Agent 共用完整服務能力，桌面整合支援常駐、登入自啟、安裝交付與使用者觸發更新。

這些是 Round 2 目標；已實作能力、未完成項目與執行順序集中於 [開發計畫與進度](round-2-plan.md)，本文件不另外維護一份完成度清單。[README](../README.md) 提供目前版本的操作入口。

## 本輪邊界

來源、文件、工作與搜尋採可擴充的責任分工，但本輪只承諾 YouTube 來源。只取得人工或自動字幕與 metadata，沒有字幕時回報結果，不啟動影音下載或語音轉寫。

RSS／一般網頁、XQ、Browser／Extension、Facebook、手動 Markdown 及無字幕轉寫由 [後續票 #11–#16](research/README.md) 追蹤。正文編輯、草稿審核、垃圾桶、Derived／Evidence／Claims 生成與完整 XR 整合不屬於本輪交付。

架構見 [architecture.md](architecture.md)，現行儲存格式見 [document-format.md](document-format.md)。第一輪範圍紀錄見 [mvp-plan.md](history/mvp-plan.md)。
