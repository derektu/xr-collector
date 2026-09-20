# XR Collector UI Design Spec

本目錄的 HTML 是視覺 wireframe；Round 2 的產品行為、ticket 分工與開發前驗收規則以 [Round 2 Plan](round-2-plan.md) 為準。HTML 尚未反映完整 Round 2 流程；已知差異列於 Plan 第 2 節，畫面狀態依各功能票開發前的驗收計畫補齊。

XR Collector 是 local-first 的資料收集與搜尋桌面工具。第一版支援 YouTube 影片字幕與頻道訂閱，架構上預留其他來源（RSS、網頁）的擴充空間。

執行環境：Electron desktop app，開發時用瀏覽器連到 Vite dev server 測試。業務邏輯在後端，前端只做呈現與操作觸發。

互動式 wireframe 畫布：https://claude.ai/artifact/FrdytTHRRBWzCpaSPVKcM7
（每個 artboard 的 Tweaks 面板可切換 dark / light 模式）

## 色系

採用 XQLab design system（位於 `~/projects/xqlab/design_system/`）的兩個主題：

- **Dark**：duskblue 暮藍（`:root` 預設）
- **Light**：silverblue 銀藍（`[data-theme="silverblue"]`）

XR Collector 是文件處理工具，排版比看盤畫面寬鬆，著重閱讀舒適度。

### 語意 Token 對照

| Token | Dark (duskblue) | Light (silverblue) | 用途 |
|---|---|---|---|
| `bgBase` | `#141B2C` | `#E9EEF4` | 頁面底色 |
| `bgSidebar` | `#0F1422` | `#FFFFFF` | 側欄底色 |
| `bgFrame` | `#1C2438` | `#FFFFFF` | 卡片、面板底色 |
| `bgCard` | `#232E48` | `#F0F5FA` | 輸入框、標籤底色 |
| `textPrimary` | `#FFFFFF` | `#16273A` | 主要文字 |
| `textSecondary` | `#97A5BA` | `#56708A` | 次要文字、標籤 |
| `textTertiary` | `#788BA1` | `#8298AC` | 輔助文字、placeholder |
| `textBody` | `#D8E0EC` | `#2A3E52` | 文件正文（閱讀用，比 primary 柔和） |
| `borderFrame` | `#2A3550` | `#C4D4E2` | 卡片、面板邊框 |
| `accent` | `#6BA6DF` | `#1E78C2` | 強調色、active 狀態 |
| `onAccent` | `#0C1322` | `#FFFFFF` | accent 底上的文字 |
| `navActive` | `#1E3A6A` | `#CFE2F5` | 側欄 active 項目底色 |
| `statusGreen` | `#1FC885` | `#0FA04E` | 成功狀態 |
| `statusError` | `#FF4646` | `#E2202C` | 錯誤狀態 |
| `highlight` | `#FAC02D` | `#D98200` | 搜尋命中高亮 |

## 畫面清單

靜態 HTML wireframe 在 `screens/` 目錄，用瀏覽器直接開啟（dark 主題；prefers-color-scheme: light 切換頁面底色）。

| 檔案 | 畫面 | 說明 |
|---|---|---|
| `01-onboarding.html` | Onboarding | 首次啟動 vault 位置選擇 |
| `02-sources-youtube.html` | 收集來源 — YouTube | 來源管理：URL 輸入 + 頻道訂閱 + 排程 |
| `03-documents.html` | 文件與搜尋 | 文件列表 + 搜尋 + 來源篩選 |
| `04-reader.html` | 文件閱讀 | 完整文件閱讀介面 |
| `05-settings.html` | 設定 | Vault 管理、匯出匯入、索引、主題 |
| `06-activity.html` | 活動記錄 | Raw log viewer |

## App Shell 結構

```
┌──────────────────────────────────────────────────┐
│ ┌──────────┐ ┌─────────────────────────────────┐ │
│ │          │ │                                 │ │
│ │ Sidebar  │ │         Main Content            │ │
│ │  220px   │ │                                 │ │
│ │          │ │                                 │ │
│ │ ──────── │ │                                 │ │
│ │ 收集來源  │ │                                 │ │
│ │ 文件     │ │                                 │ │
│ │ 設定     │ │                                 │ │
│ │          │ │                                 │ │
│ │ ──────── │ │                                 │ │
│ │ 活動記錄  │ │                                 │ │
│ └──────────┘ └─────────────────────────────────┘ │
└──────────────────────────────────────────────────┘
```

- Sidebar 寬度 220px，固定在左側。Reader 模式收合為 64px（僅 icon）。
- 導覽項目 4 個：收集來源、文件、設定、活動記錄（底部分開）。
- 沒有獨立的搜尋頁——搜尋整合在文件列表上方。

## 設計決策

### Onboarding（01-onboarding）

首次啟動時提供「建立新知識庫」與「開啟既有知識庫」，可使用預設路徑或自訂目錄。路徑、權限與資料格式驗證成功後才進入主畫面；驗證失敗留在設定流程，不默默建立空庫。同步目錄由使用者的同步工具管理，不等同獨立備份，也不保證多機同時寫入。

### 收集來源（02-sources-youtube）

來源管理頁面用 tab 結構：YouTube / RSS / 網頁。第一版只有 YouTube tab 有功能，其他 tab 顯示為 disabled 狀態，展示介面的擴充性。

**YouTube URL 輸入**放在 YouTube tab 底下。依 URL 格式辨識影片或頻道／@handle，顯示「收集影片」或「訂閱頻道」；純播放清單 URL 本輪不支援，帶播放清單參數的影片 URL 按單支處理。

**訂閱摘要與 Global 設定**：新增訂閱只顯示共用設定摘要；按下訂閱即首次收集並持續追蹤。Global 設定在設定頁修改，預設每 30 分鐘檢查；首次及恢復補收最近 1 個月內最新最多 10 則未收集內容。持續運作新增內容與已接受工作的接續不受首次上限截斷，細則見 Plan。

**頻道清單**：每列顯示 toggle（啟用/停用）、頻道名稱、@handle（未知時省略）、文件數量、個別抓取按鈕、更多選單（...）。

### 文件與搜尋（03-documents）

文件列表和搜尋合併在同一個畫面。頂部有搜尋欄和來源篩選下拉（「來源：全部 ▾」），不用 chip 排列——頻道多了不會撐爆。

每列文件顯示：標題、正文節錄（2 行 clamp，非 AI 摘要）、日期、來源標籤、刪除圖示（垃圾桶）。

**文件刪除**：確認後刪除文件，Vault 保存刪除／略過記錄；後續排程與手動頻道批次抓取均略過。使用者明確以單支 URL 重新收集且保存成功後，才解除略過狀態；刪除文件不移除訂閱。

### 文件閱讀（04-reader）

Sidebar 收合為 64px icon-only 模式，把最大空間留給閱讀區域。

閱讀排版參數：

- 內容寬度 720px，水平置中
- 正文字級 16px
- 行高 1.8
- 正文色 `textBody`（比 `textPrimary` 柔和，適合長文閱讀）

頂部有返回按鈕和刪除圖示。Metadata 顯示來源標籤、標題（28px）、日期、@handle、原始 YouTube URL。

### 設定（05-settings）

內容區域限制在 720px 寬，分成幾個卡片區塊：

- **知識庫 (Vault)**：顯示目前路徑、搬移按鈕
- **匯出與匯入**：匯出/匯入按鈕
- **搜尋索引**：狀態指示燈 + 文件數 + 重建按鈕
- **外觀**：深色/淺色主題切換
- **自動收集**：Global 檢查頻率與首次／恢復補收範圍
- **登入自動啟動**：裝置設定，預設關閉
- **關於與更新**：版本號、手動檢查與使用者觸發更新

### 活動記錄（06-activity）

上方顯示工作摘要與進度，下方為 Raw log viewer，等寬字體（`ui-monospace`），表格式三欄結構：

| 欄位 | 寬度 | 說明 |
|---|---|---|
| 時間 | 140px | `MM-DD HH:mm:ss` 格式 |
| 等級 | 60px | 色彩編碼的 level tag |
| 訊息 | flex | 操作描述 |

等級色彩：

- `INFO`：accent 藍（一般資訊）
- `OK`：statusGreen（成功新增）
- `DONE`：statusGreen（批次完成）
- `SKIP`：textTertiary 灰（已略過）
- `ERR`：statusError 紅（失敗）

提供時間、等級與工作篩選，以及載入更多；來源操作可直接跳到該工作的記錄。表頭 sticky，背景色與 log 區域一致。

後端寫 persistent log files，此畫面讀取並顯示。Agent API 也可以讀取 log 供使用者透過 Agent 查問題；Agent 可操作完整業務 API。活動記錄預設保留 30 天，工作接續資料另行保存。

### 桌面常駐與更新

關閉主視窗後隱藏至 Windows 系統匣／macOS 選單列，背景服務繼續收集；常駐入口顯示進度，提供開啟視窗、活動記錄及明確退出。登入自動啟動預設關閉，啟用後背景啟動、不開主視窗。

設定頁及常駐入口均提供手動檢查更新。自動檢查發現新版先通知；使用者明確觸發更新後才下載、安裝與重啟。

## 字體

```css
font-family: -apple-system, "Segoe UI", "PingFang TC", "Microsoft JhengHei", system-ui, sans-serif;
```

等寬字體（log viewer、vault 路徑）：

```css
font-family: ui-monospace, 'SF Mono', Menlo, monospace;
```

## 尺度

- 圓角：6px（輸入框、按鈕）、8px（卡片、面板）
- 間距：沿用 XQLab design system 的 `--p-*` 級距，但整體比看盤畫面寬鬆
- 頁面標題：22px, font-weight 600
- 卡片標題：14–16px, font-weight 500–600
- 正文：14px（列表）、16px（閱讀）
- 次要文字：12–13px
