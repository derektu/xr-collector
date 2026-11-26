# Agent 工作入口

開工前讀：

- [做一張票](docs/worker-workflow.md)：一個 session 從談設計到 merge 走完一張票的步驟
- [開發驗證流程](docs/development-validation.md)：驗收計畫、回歸流程、門檻、審查與交付
- [專案驗證設定](docs/project-validation.md)：本專案的指令、驗證層級、平台、真實資料、nightly 與打包簽章
- [verify skill](.claude/skills/verify/SKILL.md)：實際操作 App 並留下證據
- [程式規範](docs/code-guidelines.md)：lint 與結構測試強制的寫法，以及尚未強制的規則

新讀者先從 [README 文件導航](README.md#從這裡開始閱讀) 了解現況。開發依據為當前 issue，以及 issue 引用的 `docs/` 規格與 [Agent Skill](skills/xr-collector-agent/SKILL.md)。

issue 只寫本票特有的內容：問題、預期行為、本票的驗收計畫與相依關係。預期行為與驗收計畫寫成條列或表格，不用 checkbox。適用每張票的規則寫在本檔與上面三份流程文件，不複製進 issue；規則改變時只改這幾處。

建立 issue 的完成條件：每張新票（包含工作途中拆出的 bug／後續工作）都要加入本 repo 對應的 Project 看板、設定為 `Todo`，再重新讀取確認看板名稱與狀態。回報時提供票號、連結及已確認的看板狀態；任一步驟失敗時回報「issue 已建立，看板設定尚未完成」及原因。查補既有票時，已有的其他狀態保留。

所有新增或修改的業務 API 同時供 UI 與已授權 Agent 使用；Agent Skill、錯誤、工作狀態與必要的持久事件隨該票同步更新。審查「只該在特定條件開啟的功能是否外漏」時，在本 repo 指驗證專用的控制通道不能在一般執行時開啟，以及新增的 API 套用正確的 Agent 授權。

畫面上的每一句話都是使用者會讀到的字，只寫使用者當下做決定或知道結果所需的最少字。檔案包含什麼、系統怎麼運作、接下來可以做什麼、狀態背後的理由，屬於文件與 Agent Skill，不放進畫面；空狀態只放標題與按鈕。新畫面先出設計稿，以目前 App 的實際畫面為底，經使用者確認後才實作。

App 目前沒有外部使用者，本機存的資料（例如 `jobs.json`、設定）不保證跨版本相容。改資料格式或欄位名時，程式只讀寫目前的格式，不寫舊格式的轉換或相容層，也不留指稱舊格式的命名與註解；格式不相容的本機資料直接刪除。寫 issue 的預期行為與驗收計畫時，同樣不列升級相容或舊紀錄接續。

PR merge 後，若該 PR 改變使用者看得到的畫面或操作流程，提醒使用者維護 verify skill 的功能地圖：列出 `.claude/skills/verify/` 最後一次 commit 之後 merge 的這類 PR，並建議執行 `/pstack:maintain-verification-skill`。是否執行由使用者決定，agent 不自行啟動。
