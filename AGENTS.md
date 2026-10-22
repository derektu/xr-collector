# Agent 工作入口

建立或更新 PR、操作 Mac／Windows Desktop 驗收、或建置安裝包時，先讀 [開發驗證流程](docs/development-validation.md)。該文件定義平台選擇、指定版本、隔離資料、原生截圖及證據交付。驗證平台由 PR 功能影響決定：共用功能可在 Mac 或 Windows 任一平台驗證，平台專屬功能須在對應平台驗證，兩平台皆受影響則分別驗證；開發機缺少的平台保持待補。

新讀者先從 [README 文件導航](README.md#從這裡開始閱讀) 了解現況。開發依據為 [Round 2 計畫](docs/round-2-plan.md)、[產品範圍](docs/product-brief.md)、當前 issue 及其引用的規格。`docs/history/mvp-plan.md` 是第一輪歷史，`docs/research/README.md` 只供後續選型查閱。驗收 scenario 在實作前記錄於 issue；依 scenario 實際操作與比對，不能用 build 成功取代行為驗收。驗證分層進行：每次修改執行 `npm run verify`，畫面變更以 Web 開發模式在瀏覽器操作與截圖；原生 Desktop 驗收只用於依賴 Electron 或平台能力的 scenario，並在票的結尾執行，層級規則見 [開發驗證流程](docs/development-validation.md#驗證層級)。

自動檢查使用 `npm run verify`。測試按功能分目錄，分類、真實引擎測試與平台 skip 邊界見 [測試說明](tests/README.md)。

PR merge 後，若該 PR 改變使用者看得到的畫面或操作流程，提醒使用者維護 verify skill 的功能地圖：列出 `.claude/skills/verify/` 最後一次 commit 之後 merge 的這類 PR，並建議執行 `/pstack:maintain-verification-skill`。是否執行由使用者決定，agent 不自行啟動。repo 沒有 `.claude/skills/verify/` 時略過這項提醒。
