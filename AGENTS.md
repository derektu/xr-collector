# Agent 工作入口

建立或更新 PR、操作 Mac／Windows Desktop 驗收、或建置安裝包時，先讀 [開發驗證流程](docs/development-validation.md)。該文件定義平台選擇、指定版本、隔離資料、原生截圖及證據交付。驗證平台由 PR 功能影響決定：共用功能可在 Mac 或 Windows 任一平台驗證，平台專屬功能須在對應平台驗證，兩平台皆受影響則分別驗證；開發機缺少的平台保持待補。

產品範圍先讀 [MVP 計畫](docs/mvp-plan.md)、當前 issue 及其引用的規格。驗收 scenario 在實作前記錄於 issue；依 scenario 實際操作與比對，不能用 build 成功取代行為驗收。
