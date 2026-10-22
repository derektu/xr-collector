# Agent 工作入口

寫驗收計畫、建立或更新 PR、操作 App 驗收、或建置安裝包時，先讀 [開發驗證流程](docs/development-validation.md)。該文件定義驗證層級、平台選擇、回歸與真實資料的要求、不符合預期的觀察怎麼處理，以及證據交付。實際操作 App 用 [verify skill](.claude/skills/verify/SKILL.md)。

新讀者先從 [README 文件導航](README.md#從這裡開始閱讀) 了解現況。開發依據為 [Round 2 計畫](docs/round-2-plan.md)、[產品範圍](docs/product-brief.md)、當前 issue 及其引用的規格。`docs/history/mvp-plan.md` 是第一輪歷史，`docs/research/README.md` 只供後續選型查閱。驗收 scenario 在實作前記錄於 issue；依 scenario 實際操作與比對，不能用 build 成功取代行為驗收。

自動檢查使用 `npm run verify`。測試按功能分目錄，分類、真實引擎測試與平台 skip 邊界見 [測試說明](tests/README.md)。

PR merge 後，若該 PR 改變使用者看得到的畫面或操作流程，提醒使用者維護 verify skill 的功能地圖：列出 `.claude/skills/verify/` 最後一次 commit 之後 merge 的這類 PR，並建議執行 `/pstack:maintain-verification-skill`。是否執行由使用者決定，agent 不自行啟動。repo 沒有 `.claude/skills/verify/` 時略過這項提醒。
