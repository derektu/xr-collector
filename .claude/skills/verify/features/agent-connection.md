# AI 助理連線

設定頁以精簡摘要提供本機 Agent listener 的狀態、active URL、Skill 下載、連線資料複製與進階設定。金鑰與連線埠屬於本機 profile，不進入 Vault 或知識庫匯出。

## Sub-features

- `agent-connection-summary`：設定頁在知識庫、搜尋及登入自啟之後顯示可連線狀態與 active URL，不擠掉知識庫位置與資料交換操作。
- `agent-connection-help`：標題旁說明可 hover、點擊固定及鍵盤操作，列出下載、安裝並開新 session、複製及要求 Agent 先檢查 health 的四步。
- `agent-connection-export`：下載包含通用 Skill 與 `connection.json`；複製輸出目前 active URL 與金鑰，listener 不可用時兩者停用。
- `agent-connection-settings`：自動／固定連線埠保存後於下次啟動套用；重設金鑰立即讓舊金鑰失效而不重啟 listener。

## How to get to it (user POV)

- 主視窗左側「設定」→「AI 助理連線」。
- 尚未建立知識庫時，在「選擇知識庫位置」畫面按「AI 助理連線」，展開同一個完整面板（`onboarding-agent-panel`），可下載、複製及設定連線。
- 一般使用者只需「下載 Skill」；分開安裝或更新連線時才使用「複製連線資料」。

## Driving it with verify

Preconditions:

- 使用隔離 Web instance，不讀取或覆寫使用者的 Agent 設定。
- 斷言設定卡片順序、active loopback URL，以及 helper 的 hover、click 與 Escape 行為。
- 透過瀏覽器實際下載 ZIP、解壓並比對 active 連線；收錄的 Web flow 替換 `navigator.clipboard.writeText`，只比對複製按鈕交付的文字與 explicit connection API。真實系統剪貼簿另以原生 Desktop 驗收。
- 將固定埠保存為目前埠，斷言畫面顯示下次重啟套用而 active URL 不變；重設金鑰後直接向 Agent listener 驗證舊金鑰 401、新金鑰 200。

## Gotchas

- Web flow 不重新啟動同一 instance，因此固定埠真正 bind 與失敗降級由服務測試及後續原生驗收覆蓋。
- URL 與金鑰屬於敏感連線資料；證據不可記錄 token，畫面也不直接顯示 token。
- 下載包已含連線資料，不要把每次 session 都重新貼上 token 寫成必要步驟。
- 固定 URL 且金鑰未變時可跨 App 重啟與 Agent session 沿用。port 變更生效、自動 port 漂移或重設金鑰後，更新已安裝 Skill 旁的 `connection.json`；重新下載時確認覆蓋的是 Agent 實際使用的目錄。

## Regression flows

- `agent-connection`：斷言 `agent-connection-summary`、`agent-connection-help`、`agent-connection-export`、`agent-connection-settings`。
