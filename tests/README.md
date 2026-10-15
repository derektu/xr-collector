# 測試入口

`npm run verify` 執行全部 Vitest 案例、JUnit 輸出、產品程式 typecheck 與 Node／Web build。`npm test` 只跑測試，`npm run test:watch` 用於開發。測試檔由 `tests/**/*.test.ts` 收集。

## 按功能分類

| 目錄 | 責任 |
| --- | --- |
| `core` | 文件保存與索引、URL、語言、字幕整理 |
| `capture` | yt-dlp 輸出解析與來源 adapter |
| `sources` | 來源網址辨識 |
| `jobs` | 收集工作的接受、去重、有界派工、持久紀錄與中斷 |
| `channels` | 頻道、設定保存、頻道工作提交與排程 |
| `vault` | 文件格式、資料包、還原與合併恢復 |
| `search` | 搜尋狀態、索引與真實引擎 |
| `server` | HTTP 契約與 Agent 授權 |
| `runtime` | 共用服務組裝、斷線後完成與生命週期清理 |
| `web` | 畫面使用的狀態／呈現邏輯 |
| `tooling` | 獨立驗證工作區、平台要求與證據彙整 |

分類不代表測試層級：同一功能可能包含單元、HTTP 與檔案系統整合。`web` 的函式測試不是完整畫面 E2E，yt-dlp 的 fixture 測試也不是 YouTube 真實連線驗收。Web 畫面與原生操作的驗證層級依 [開發驗證流程](../docs/development-validation.md#驗證層級)，只在有實際自動化案例時建立 E2E 測試目錄。

## 真實搜尋與平台邊界

`npm run test:meilisearch:mac` 下載 Mac runtime，再執行 search、Agent、還原與合併四個相關檔案，包含其中的非引擎案例。這些檔案的真實引擎案例目前使用 `resources/bin/mac/meilisearch`，缺少 binary 時會 skip。此命令供 Mac arm64 執行；Windows／Linux 的綠燈不能視為已通過這四項真實引擎驗收。

`tooling` 的工作區建立整合案例只在 Mac／Windows 執行，Linux 另 skip 一項。平台擴充時一起調整 binary 選擇與 skip 規則；先保留真實結果，不以 fixture 冒充另一平台通過。

## Round 2 修改原則

既有案例保護已交付行為。需求變更在對應 ticket 內更新斷言，例如 #22 的 Agent 寫入授權，以及 #18／#27／#28 的派工與恢復；分類整理不先解除這些限制。正式格式遷移須保留第一輪 Vault 的相容案例。共用 fixture 只在確實重複時抽取，避免不同案例的前置條件被隱藏。
