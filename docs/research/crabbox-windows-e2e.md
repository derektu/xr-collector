# Crabbox：Windows Desktop E2E 與截圖可行性

> 本文保留 Crabbox 研究與當時的試驗提案。現行決策使用 Mac 與 Parallels 原生工具，不以 Crabbox 為前置依賴；已實作的入口與後續 agent 操作以 [開發驗證流程](../development-validation.md) 為準。

查核日期：2026-09-20。本輪閱讀官方文件與公開原始碼，未安裝 Crabbox、建立雲端資源或執行 XR Collector Windows E2E。以下是候選驗證架構，不代表已採用或已驗收。

## 判斷

**可透過 Crabbox 取得 AWS／Azure 的原生 Windows VM，執行 Desktop 驗證並取回截圖；不需要把所有驗證綁在自己的 Mac。**官方明確提供 `--target windows --windows-mode normal --desktop` 路徑。WSL2 執行的是 Linux 工具鏈，不適合作為原生 Windows Desktop 驗證的替代。[Windows VNC and WSL2](https://crabbox.sh/features/vnc-windows.html)

Crabbox 是免費 MIT CLI／coordinator，雲端資源使用自己的 AWS／Azure 帳號。它目前不轉售算力，也沒有正式的 hosted coordinator 訂閱；`marketplace` 仍是預覽功能。實際機器與儲存費由雲端供應商收取。[Pricing](https://crabbox.sh/pricing.html)、[AWS](https://crabbox.sh/providers/aws.html)、[Azure](https://crabbox.sh/providers/azure.html)

## 已確認能力與邊界

| 項目 | 官方文件／原始碼證據 | 對驗證的含義 |
|---|---|---|
| 原生 Windows 桌面 | AWS／Azure bootstrap 建立登入中的使用者桌面與 TightVNC；Azure Desktop bootstrap 會重開機一次 | 能提供可見桌面，但 XR 流程仍需實測 |
| 截圖 | `crabbox screenshot --id <lease> --output windows.png`；文件說明截圖在互動 console session 執行 | 可以保存整個桌面的證據，不只網頁內容 |
| App 啟動 | `desktop launch` 將 App 啟動到可見 desktop session | 不可把一般 SSH／`run` 的程序啟動視為等同互動桌面啟動 |
| 圖像與輸入 | Windows 支援 click、record 與 doctor；`type`／`paste`／`key` 文件目前限定 Linux | 不能直接假設完整鍵盤自動化可用；Windows 測試驅動與斷言仍需另外整合 |
| 桌面證據 | 獨立的 `artifacts collect` 可收集 screenshot、metadata 與 desktop diagnostics | 可形成審查證據包；結果與 commit 的綁定仍需工作流程設計 |
| 任意測試檔案收集 | `run --artifact-glob`／`--require-artifact` 的收集器不支援 native Windows | 測試報告／trace 的取回需另設並實測；這不代表 Windows 截圖或 desktop artifact bundle 不支援 |

來源：[Windows desktop](https://crabbox.sh/features/vnc-windows.html)、[desktop commands](https://crabbox.sh/commands/desktop.html)、[screenshot](https://crabbox.sh/commands/screenshot.html)、[artifacts](https://crabbox.sh/features/artifacts.html)。表格是文件能力摘要，未以實機證實。

## Windows Server 與產品目標平台

查核原始碼固定版本 `5922c4cec7e9af36d3301c76b5d39ea5cb0e7590`：AWS 原生 Windows 自動選擇 `Windows_Server-2022-English-Full-Base-*`；Azure 預設為 Windows Server 2022 Datacenter image。因此，預設 VM 的測試結果不能直接視為 Windows 10／11 使用者桌面相容性驗收。[AWS image selection](https://github.com/openclaw/crabbox/blob/5922c4cec7e9af36d3301c76b5d39ea5cb0e7590/internal/cli/aws.go#L1119)、[Azure image default](https://github.com/openclaw/crabbox/blob/5922c4cec7e9af36d3301c76b5d39ea5cb0e7590/internal/cli/azure.go#L45)

若需求指定 Windows 10／11，可研究自訂合適 image，或使用已備妥的 Windows 主機走 Static SSH。自訂 image 的供應條件及授權本輪未核實；Static SSH 不會替使用者建立或刪除主機，桌面環境需由主機管理者準備。[Static SSH](https://crabbox.sh/providers/ssh.html)、[Static Windows requirements](https://crabbox.sh/features/vnc-windows.html#static-windows)

## 建議配置與待驗證實驗

以下為架構建議，尚未實作：

1. 一般 Web UI E2E 與網頁截圖放在 GitHub Linux CI。
2. Windows 程序、路徑等測試可先放 GitHub Windows CI；需實際桌面操作的安裝、Tray、登入啟動及更新流程，放原生 Windows desktop VM。
3. GitHub workflow 取得指定 commit，透過 Crabbox 啟動 VM，執行案例並取回報告、截圖，最後回收 VM。由雲端 CI 發動時，不依賴個人 Mac 持續在線。
4. 首次實驗只驗證同一 commit 的安裝、開啟主視窗、Tray 隱藏／還原、截圖取回及 VM 清理。確認可行後才接每次 merge。
5. 重開機／登出登入案例需要保留同一 VM、等待重新連線並恢復測試；bootstrap 支援重開機，不代表專案 E2E 自動續跑已具備。截圖要同時配合行為斷言，不能用「有 PNG」代表通過。

待實测項目包括：建立 VM 的時間與配額、desktop session 啟動、Node／Electron 相依下载、App 前景與 Tray 操作、失敗報告取回、重新開機後續跑，以及工作取消時的資源清理。測試中應記錄精確 OS／架構、commit、案例結果與截圖時間。

## 本機 Mac 與 Parallels Windows ARM 的試驗順序

使用者現有環境為開發用 Mac 與 Parallels Windows ARM VM。先完成 GitHub repo／tickets／Linux CI，再進行下列試驗；本輪未啟動 VM、安裝 Crabbox 或改動 VM 設定。

1. **Mac 獨立目錄**：建立獨立 checkout，固定已通過 CI 的 commit，重新安裝相依。Electron 另指定 `XR_COLLECTOR_PROFILE` 與 `XR_COLLECTOR_VAULT` 至驗證專用位置，隔離 Vault、搜尋索引、Agent 連線檔及裝置設定。獨立目錄提供工作資料隔離，不等同乾淨 OS／使用者環境。先直接啟動、執行一個案例並截圖，再判斷是否需要 Crabbox 包裝本機執行。
2. **Windows VM 能力盤點**：確認 Windows 版本、OS 與 Node／Electron／runtime 架構、Parallels Tools、`prlctl` 可用性及授權、VM 容量、登入桌面、PowerShell／OpenSSH 與套件下載。此步只讀盤點，不建立快照或 clone。
3. **Windows 原生程序試跑**：在 VM 自己的磁碟建立獨立 checkout／Vault，安裝相依、啟動 Collector，記錄執行的是 ARM64 binary 或 x64 模擬程序。先確認主視窗、基本操作與截圖，再接 Crabbox 的桌面啟動與證據回收。
4. **Crabbox 連線試驗**：Static SSH 可使用既有 host 與自訂 `static.workRoot`，但官方桌面矩陣不承諾 static macOS／Windows 的 `screenshot` 能力；必要時使用平台原生截圖工具。Parallels provider 可從來源 VM／snapshot 建立獨立 clone，並支援 workRoot、native Windows 與桌面能力。需先確認版本及 guest prerequisites，不能把既有日常 VM 當作可任意回收的 lease。
5. **自動化與證據**：固定 commit 與 scenario、保存操作前後截圖及行為斷言、取回結果，最後確認只清理驗證資源。手動流程通過後，再接 merge 後的排程；本機 Mac 關機或休眠時，本機／VM 驗證不能執行。

Crabbox 的 Parallels provider 透過 `prlctl`、Parallels Tools 與 guest SSH 工作；linked clone 要求明確的關機 snapshot，且來源模板不得忙碌。這不是直接把正在使用的 VM 當成可刪除副本。[Parallels provider](https://crabbox.sh/providers/parallels.html)、[Static SSH](https://crabbox.sh/providers/ssh.html)、[Static desktop screenshot boundary](https://crabbox.sh/features/interactive-desktop-vnc.html#capturing-without-taking-over)

Mac 的 profile／Vault 隔離入口可見 [`src/electron/main.ts`](../../src/electron/main.ts)。Windows ARM VM 驗證不取代原定 Windows x64 原生平台驗收；是否增列 Windows ARM 為正式交付平台另行決定。Windows 打包與內附 runtime 支援尚待 #34，不因移轉 repo 自動視為完成。

## 成本

Crabbox 軟體授權費為 US$0。預算應計入 VM 啟動、安裝相依、測試、截圖與取回的全部運行時間，再加磁碟、快照、IP、網路及證據儲存；若 GitHub job 等待 VM 完成，也要算該 job 的使用量。本輪未選 region／instance type，沒有可作承諾的每次價格。[Crabbox pricing boundaries](https://crabbox.sh/pricing.html)

AWS 文件預設 class 是 `beast`，不能直接把未指定規格的文件範例當低成本方案。實驗前應明確指定經核價的規格與回收策略。AWS direct CLI 的清理是 best-effort；coordinator 路徑提供到期清理與孤兒資源掃描。兩者都需驗證實際資源已刪除。[AWS classes and lifecycle](https://crabbox.sh/providers/aws.html)
