# Agent 工作入口

寫驗收計畫、建立或更新 PR、操作 App 驗收、或建置安裝包時，先讀 [開發驗證流程](docs/development-validation.md)。該文件定義驗證層級、平台選擇、回歸與真實資料的要求、不符合預期的觀察怎麼處理，以及證據交付。實際操作 App 用 [verify skill](.claude/skills/verify/SKILL.md)。

新讀者先從 [README 文件導航](README.md#從這裡開始閱讀) 了解現況。開發依據為 [Round 2 計畫](docs/round-2-plan.md)、[產品範圍](docs/product-brief.md)、當前 issue 及其引用的規格。`docs/history/mvp-plan.md` 是第一輪歷史。驗收 scenario 在實作前記錄於 issue；依 scenario 實際操作與比對，不能用 build 成功取代行為驗收。

issue 只寫本票特有的內容：問題、預期行為、本票的驗收計畫與相依關係。適用每張票的規則寫在本檔與 [開發驗證流程](docs/development-validation.md)，不複製進 issue 或派工說明；規則改變時只改這兩處。

建立 issue 的完成條件：每張新票（包含工作途中拆出的 bug／後續工作）都要加入本 repo 對應的 Project 看板、設定為 `Todo`，再重新讀取確認看板名稱與狀態。回報時提供票號、連結及已確認的看板狀態；任一步驟失敗時回報「issue 已建立，看板設定尚未完成」及原因。查補既有票時，已有的其他狀態保留。

所有新增或修改的業務 API 同時供 UI 與已授權 Agent 使用；Agent Skill、錯誤、工作狀態與必要的持久事件隨該票同步更新。

App 尚未 release，本機存的資料（例如 `jobs.json`、設定）不保證跨版本相容。改資料格式或欄位名時，程式只讀寫目前的格式，不寫舊格式的轉換或相容層，也不留指稱舊格式的命名與註解；格式不相容的本機資料直接刪除。寫 issue 的預期行為與驗收計畫時，同樣不列升級相容或舊紀錄接續。

開發與反覆驗收一律使用 Mac ad-hoc 包與 Windows 未簽署包；Developer ID 簽章與公證只用於使用者確認後的最終發布候選，規則見 [開發驗證流程第 6 節的簽章與公證使用時機](docs/development-validation.md#6-平台打包)。

自動檢查使用 `npm run verify`。只改 Markdown 的修改不跑 `npm run verify`，CI 也不執行，改為確認連結有效與 Markdown 呈現正確；`skills/xr-collector-agent/SKILL.md` 例外，測試會讀它，改它時照常跑。同一次修改含有任何其他檔案時，照常跑完整的 `npm run verify`。測試按功能分目錄，分類、真實引擎測試與平台 skip 邊界見 [測試說明](tests/README.md)。

程式碼審查：開 PR 前，由沒有參與實作的 reviewer 審查本票相對 main 的全部改動，包含未提交的修改。reviewer 只拿到 diff、issue 與 repo，不拿實作 session 的結論。審查分兩個面向，分開回報：

- 正確性與風險：從每個改動追到受影響的 module，檢查是否弄壞既有功能、有無安全問題、是否改變開發者建置或執行的方式、只該在特定條件開啟的功能是否外漏。在本 repo，後者指驗證專用的控制通道不能在一般執行時開啟，新增的 API 要套用正確的 Agent 授權。
- 需求與規範：對照 issue 原文，以及本檔與 [開發驗證流程](docs/development-validation.md)。

只回報追到底、確定成立的問題；不修的問題與理由列進 PR 的待決定問題。

PR merge 後，若該 PR 改變使用者看得到的畫面或操作流程，提醒使用者維護 verify skill 的功能地圖：列出 `.claude/skills/verify/` 最後一次 commit 之後 merge 的這類 PR，並建議執行 `/pstack:maintain-verification-skill`。是否執行由使用者決定，agent 不自行啟動。repo 沒有 `.claude/skills/verify/` 時略過這項提醒。
