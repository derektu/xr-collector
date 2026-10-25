# 兩平台本機交付計畫

交付平台為 macOS Apple Silicon（arm64）與 Windows x64。安裝包在使用者的 Mac 與本機 Windows VM 建置；版本發布由 Mac 執行。未簽署的安裝包可進入本輪驗收，正式程式碼簽署與 macOS 公證另行安排。

## 工作順序

| 階段 | 工作 | 完成條件 |
| --- | --- | --- |
| [#139](https://github.com/derektu/xr-collector/issues/139) | 固定 source 的 Chinese Meilisearch 與 official bundle 選項 | PR #151 review、合併；保留兩平台本機驗收與既有 CI 證據 |
| [#34](https://github.com/derektu/xr-collector/issues/34) | 本機打包、建置資訊、runtime 與安裝驗收 | 同一乾淨 commit／版本的兩平台、兩種引擎 bundle；驗收與產物清單完整 |
| [#35](https://github.com/derektu/xr-collector/issues/35) | 從 Mac 上傳並發布 GitHub Release、建立下載來源 | 使用 #34 已驗收的原產物及 checksum，不重新 build；確認下載與 metadata 一致 |

#34 的實作以 #139 合併後的 main 為基準。規劃工作可在承接 PR #151 的獨立 worktree 進行；#34 的 PR 只包含本票修改。開發子 agent 負責實作，另一子 agent review，parent 核對驗收結果後 commit。各票分開交付；merge 與正式 Release 依使用者的發布指示執行。

## 建置環境與產物

| 交付目標 | 建置位置 | 安裝產物 | 實際執行證據 |
| --- | --- | --- | --- |
| macOS arm64 | 使用者 Mac；UTM macOS arm64 VM 補安裝與隔離驗收 | DMG、ZIP、更新 metadata | ARM64 原生 |
| Windows x64 | 使用者 Mac 上的 Parallels Windows ARM VM，使用 x64 Node／Rust／MSVC | NSIS EXE、更新 metadata | x64-on-ARM64，明列 emulated |

兩種 Meilisearch bundle 均涵蓋上述平台：預設 Chinese 與明確選用的 official。它們是引擎 variant，不增加平台。各包只含一個引擎，輸出與 metadata 分開，不能互相覆蓋或混用。同一 GitHub Release 的附件 basename 必須全域唯一，安裝檔與 metadata 的名稱都須區分平台、架構與 variant，不能只用本機子目錄隔開。入口沿用 `package:mac`、`package:win` 及其 `:official` 版本。

平台 CI 矩陣依兩個交付目標收斂；GitHub CI 提供自動檢查及可用的原生 x64 引擎測試，Release 不取用 CI 建置的 App。Windows ARM 的模擬結果可證明該環境的功能，不能標為 Intel／AMD 原生 Desktop 或效能證據。遠端 x64 電腦不是本機建置前提；若補實機驗收，依可達環境另記結果。

## #34 實作範圍

- 封裝同一 commit／版本的 Electron App、yt-dlp、Deno、Meilisearch 與 Agent Skill，逐項核對目標架構、版本、checksum 及 App 內路徑。
- 產出建置資訊：版本、build 時間、commit／build identifier、平台及引擎 variant。App 的固定可見位置與唯讀業務 API 顯示相同資訊；開發版也有可辨識身分，不能偽裝成乾淨正式 build。API、Agent Skill 與 verify 功能地圖隨實作同步更新。
- 產物清單記錄完整 commit、版本、兩台建置環境、模擬狀態、實際工具版本、各附件 bytes／SHA-256／架構／簽署狀態，並關聯驗收 evidence。可追溯配方不等於跨機器 bit-for-bit 相同。
- 更新 metadata 只指向同版本、同架構、同 variant 的已驗證附件；安裝器與 #35／#36 的發布、更新責任分開。
- 預設未簽署，不自動選用公司的 Team 或憑證。Meilisearch 的 packaged bytes 必須符合 manifest；簽署流程若日後改變 bytes，該流程須另外建立並驗證最終 identity，不能放寬目前的完整性檢查。
- Windows Chinese 維持 static CRT；official 包須完成受支援的 VC++ v14 x64 runtime 前提處理及驗證。實作前查核 redistributable 的固定來源、完整性與安裝方式，並確認乾淨無 CRT 的驗收環境。現有 NSIS 為 per-user／allowElevation=false，不能假設需要系統管理權限的 redistributable 可直接安裝；不能以建置 VM 已裝 Visual Studio 作為乾淨客戶端證據。
- 不實作 Mac Intel、Windows ARM64 安裝包、Release 上傳、自動更新客戶端或 #150 的共用 HTTP shutdown 修正。

## #34 驗收計畫

所有資料與安裝位置使用隔離目錄，原有 Vault、profile、登入項目與其他 session 的 App 保留。需出現前景視窗或操作安裝器的時段在執行前協調。下表為驗收計畫。Windows 乾淨無 CRT 的環境另行補驗；本輪先完成開發及現有 VM 的 app-local DLL 載入／依賴驗證，不將它標為乾淨客戶端通過。

| ID | 層級／功能地圖／平台 | 操作與預期 |
| --- | --- | --- |
| B34-01 | 自動檢查、建置／兩平台 | 同一乾淨 commit／版本各產 Chinese、official 包；建置資訊、安裝檔與 metadata 版本相同，完整 runtime／Agent Skill 路徑與架構正確。產物 hash 對應實物；未簽署如實記錄。固定 pin 與被篡改／缺失 runtime 的負向斷言能在移除修正時失敗。 |
| B34-02 | 原生安裝器、實機目視／兩平台 | Mac 由 DMG 複製至隔離 Applications 位置；Windows 以 NSIS 安裝至本票位置。從安裝後 App 啟動而非 win-unpacked／開發 Electron，完成 onboarding，未要求 Node／Rust；記錄 OS 安全提示與使用者可完成的步驟。不能只用 package 成功代替。 |
| B34-03 | Web＋原生／建置資訊功能檔於實作時收錄／兩平台 | 固定位置顯示版本、時間、commit／build identifier；與唯讀 API、產物清單一致。兩個不同測試 build 可區分；開發版與安裝版都可辨識。純資訊 Web flow 可用合成資料重跑並收錄。 |
| B34-04 | 原生 Desktop／collect-video、rss、documents-reader-search／兩平台、兩 variant | 安裝版使用內附工具完成一個清單內 YouTube 與一個 RSS 的真實 smoke，核對新文件、讀取、搜尋與 highlight；隔離副本重啟後命中與刪除狀態一致。網路／限流失敗標 blocked，不以合成結果替代；已收集副本不重新抓取只為擴大 benchmark。 |
| B34-05 | 原生 Desktop、FS／documents-reader-search／兩平台 | 同一隔離 Vault／profile 在兩 variant 間切換，只重建搜尋 cache，原文與其他 Vault／profile hash 不變。相同 variant 重啟保留 cache；manifest／binary 錯配在刪除前拒絕。沿用 #139 的共同流程與原子替換，保留所有失敗。 |
| B34-06 | 原生與檔案整合／兩平台 | 實際包在不依賴開發工具 PATH 的條件可啟動；Windows Chinese imports 無額外 VC DLL；official 的 CRT 前提處理經安裝驗證。缺少無 CRT 的隔離環境時，此前提驗收保持 pending，不能用已有 VS 的成功替代。macOS 檢查全部內附工具可執行。 |
| B34-07 | metadata／HTTP、FS整合／任一平台 | metadata 所有附件存在，版本／架構／variant／大小／digest 與產物一致；缺檔、混版本或混 variant 拒絕交接。此步只產本機交接資料，不發布或啟動自動更新。 |
| B34-08 | Web 回歸／documents-reader-search、subscriptions、rss | 主 checkout 與候選跑 `workspace-content`、`subscribe-a-b`、`documents-reader-search` 的適用情境；因包裝與建置資訊不改收集設定，預期行為一致。新增 metadata UI 的已收錄 flow 另跑。完整 `npm run verify` 依 repo 規則執行。 |

登入自啟／Tray 的產品邏輯不在本票修改；安裝身分、路徑或版本資訊若改到它們的契約，實作計畫須補對應最小回歸後再驗。#150 若影響本票必要退出情境，保留失敗並標出相依，不將修正藏進打包票。

## #35 交接

Mac 收齊 Windows 產物、各 variant metadata、產物清單與驗收索引，重新核對 checksum 後，由本機發布指令建立 tag／draft Release、上傳附件、讀回清單，再執行經授權的正式發布。驗收後不重編同名產物。

發布來源為公開 repository 的 GitHub Releases，直接提供安裝檔及更新 metadata。#35 的公開發布前置條件是 repository 已設為 public；尚為 private 時不能宣稱免登入下載完成。以無 GitHub 登入／token 的客戶端驗證已發布附件與 metadata 的可達性及 checksum；draft Release 只供發布前核對，不作匿名下載完成證據。任何 token 只留發布端，不放 App／metadata。

## 驗收與憑證邊界

本輪允許 unsigned／ad-hoc App，OS 提示與安裝步驟須據實交付，不能宣稱已通過 Developer ID、notarization 或 SmartScreen 信任。使用者可在 Xcode 使用公司 Team，簽署權限及對外分發憑證的設定留給後續簽署工作，不列為 #34／#35 的阻擋條件。
