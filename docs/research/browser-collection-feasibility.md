# Browser 收集能力：官方文件查核

查核日期：2026-09-09。本文是技術研究筆記，不是本版功能承諾。本輪只閱讀官方文件，未登入任何網站、操作使用者 Browser、擷取私人資料或進行實機驗證。

## 主要判斷

**使用者主動匯入當前內容，與無人值守持續收集，是兩種不同的能力。** Chrome Extension 可以在使用者點擊後取得 `activeTab` 的暫時權限，再用 content script 讀取當前頁面的 DOM；這提供了網頁剪藏的技術基礎，但不保證取得未載入內容或網站完整歷史資料。[activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab)、[Content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)

Electron 的持久 Session 可保存網站狀態，`webContents` 可控制頁面及執行 JavaScript。但這些是 Browser 能力，並不是目標網站登入、自動擷取與內容完整性的保證。每個來源仍需驗證。[Session](https://www.electronjs.org/docs/latest/api/session)、[webContents](https://www.electronjs.org/docs/latest/api/web-contents)

## 各類來源的可行性邊界

| 來源 | 使用者主動匯入 | 自動持續收集 | 已知限制／待驗證 |
|---|---|---|---|
| 一般財經新聞、專欄 | 可將目前已載入的正文或選取內容轉成草稿，屬架構推論 | 若有正式 API／feed 可另行評估；Browser 路徑要逐站驗證 | DOM 擷取能力不等於正文辨識準確；表格、圖片、分頁與延遲載入需檢查 |
| 登入或付費新聞 | 在使用者已能閱讀的頁面上剪藏，是候選方案 | 未確認，不能由「有 cookie」推定成功 | 登入方式、到期、完整正文載入與帳號驗證，都要依站台實測 |
| YouTube 財經節目 | 有字幕的影片提供「顯示轉錄稿」；可研究由使用者開啟後匯入 | 任意第三方影片字幕不能直接依賴官方 captions download API | 該 API 要求呼叫者有影片編輯權限；頁面轉錄稿擷取仍待實测，不能承諾所有影片可用 |
| YouTube 訂閱頻道 | 官方 API 可讀取經授權使用者訂閱的頻道清單 | 可作為來源發現的一部分，尚需影片與內容取得流程 | 頻道訂閱清單不等於逐字稿；本輪未確認付費會員專屬內容的通用匯入路徑 |
| Facebook 財經貼文 | 已顯示貼文／使用者選取文字可作為剪藏候選，屬 DOM 能力推論 | 未確認；不可承諾追蹤任意個人、社團或動態牆 | 需驗證貼文邊界、展開全文、來源連結、圖片與留言處理；本輪 Meta API 文件回傳 429，無法確認其 API 範圍 |

表中 Browser 剪藏推論依據為 Chrome 的 [DOM 存取能力](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)。YouTube 的確定事實依據：[轉錄稿功能](https://support.google.com/youtube/answer/15930243?hl=en)、[Captions: download](https://developers.google.com/youtube/v3/docs/captions/download)、[Subscriptions: list](https://developers.google.com/youtube/v3/docs/subscriptions/list)。Meta 未成功讀取的官方入口：[Permissions](https://developers.facebook.com/docs/permissions/)、[Pages posts](https://developers.facebook.com/docs/pages-api/posts/)、[Graph API v19 changelog](https://developers.facebook.com/docs/graph-api/changelog/version19.0/)，不以這些連結作為已確認內容的證據。

## 內建 Browser 與外部 Browser 的角色

Google OAuth 政策禁止將授權請求導向開發者可控制的 embedded user-agent，列出的控制能力包括注入腳本或存取 session cookies。因此，**不能把「所有來源都能在 Electron 裡完成 Google 登入」作為架構前提**。這是 Google OAuth 的明確限制，不代表所有網站帳密登入都不可行。[Google OAuth 2.0 Policies](https://developers.google.com/identity/protocols/oauth2/policies)

建議保留兩條入口：內建 Browser 管理經驗證可用的來源 Session；外部 Browser Extension 匯入使用者當前正在閱讀的內容。這是設計建議，並不假設兩者共用 cookies。外部 Browser 完成某個 API 的 OAuth 授權，也不能直接當成 Electron 已取得網站瀏覽登入狀態。

Session 管理的範圍應涵蓋網站儲存與登入失效，而非只匯出 cookies。Electron 文件將 cookies、Local Storage、IndexedDB 等列為不同的儲存類型；只複製 cookies 是否足夠，必須由個別來源證明。[Session storage](https://www.electronjs.org/docs/latest/api/session#sesclearstoragedataoptions)

外部網站應在關閉 Node integration、啟用 context isolation 與 sandbox 的隔離環境中執行。Browser 控制可留在桌面 Adapter，產品 Web UI 仍使用本機 Web Server 的 HTTP API。[Electron Security](https://www.electronjs.org/docs/latest/tutorial/security)

## Extension 到本機 Web Server

Chrome 的 extension service worker 可在具備 host permissions 時發出跨來源請求；content script 自己發出請求則仍受網頁來源限制。官方文件亦支援 localhost／127.0.0.1 的 host pattern。[Cross-origin network requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)、[Match patterns](https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns)

因此候選流程是：使用者按下匯入 → content script 取得指定內容 → extension service worker 呼叫 Collector 匯入 API → 產生可整理的草稿。Extension 內部訊息傳遞屬 Browser Extension 的實作，不要求產品畫面改用 Electron IPC。配對、API 驗證、Collector 未啟動的提示與 Browser 版本差異，仍需原型驗證。

## 候選驗證

1. **一般文章剪藏**：各挑一篇公開新聞與長篇專欄，比對標題、作者、日期、正文、圖片、表格、原始 URL，確認雜訊與缺漏可辨認。
2. **登入新聞**：使用使用者指定且有權閱讀的單一站台，驗證直接登入與第三方登入差異、重啟後 Session、登入失效、剪藏與背景收集的內容一致性。
3. **YouTube**：各選一支人工字幕、自動字幕與無字幕的公開影片，確認可取得內容、語言、時間戳與失敗提示；會員內容另作獨立案例，不外推。
4. **Facebook**：先驗證單一貼文的主動剪藏與全文展開，再決定是否研究持續收集；不可由成功剪藏一篇推定動態牆可穩定同步。
5. **Mac／Windows**：確認 Extension 呼叫本機 API、安裝後啟動、重新配對及 Collector 未啟動時的行為。

上述均為尚未執行的候選驗證；結果應逐來源記錄「已通過、部分支援、需使用者介入、不可用」，再供本版範圍決策。
