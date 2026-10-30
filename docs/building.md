# 建置、測試與發布

XR Collector 是 Node.js／TypeScript 專案：Fastify 提供 API 與 Web UI，Electron 包成 Mac 與 Windows 桌面 App。App 隨附三個外部執行檔：搜尋引擎 Meilisearch、字幕擷取的 yt-dlp，以及 yt-dlp 需要的 Deno，三者都使用上游釘住版本的官方 release。這份文件說明開發機與建置機要先安裝什麼、怎麼開發與測試，以及怎麼建置安裝包與發布。

指令範例中，Mac 使用 Terminal（zsh），Windows 使用命令提示字元（cmd）。

## 先安裝

| 項目 | Mac（Apple Silicon） | Windows x64 |
| --- | --- | --- |
| Git | Xcode Command Line Tools 內附（`xcode-select --install`） | [Git for Windows](https://git-scm.com) |
| Node.js 22.22.3 | [nvm](https://github.com/nvm-sh/nvm)：`nvm install` 讀取 repo 的 `.nvmrc` | [nvm-windows](https://github.com/coreybutler/nvm-windows)：`nvm install 22.22.3 64`，再以系統管理員執行 `nvm use 22.22.3` |

Mac 的 Xcode Command Line Tools 同時提供 `swiftc`，用來編譯 App 內附的 macOS 更新 helper。Windows 不需要 Visual Studio 或其他 C++ 工具。

Node 必須是原生架構：Mac 是 arm64（不經 Rosetta），Windows 是 x64。`node -p process.arch` 應印出 `arm64`（Mac）或 `x64`（Windows）。ARM64 Windows 上安裝 x64 Node 時，建置跑在 x64 模擬下，`doctor:build` 與 artifact manifest 都標為 emulated。

**nvm-windows 與 PowerShell**：PowerShell 預設的執行原則不允許 `npm.ps1`，打 `npm` 會失敗。使用 cmd，或在 PowerShell 打 `npm.cmd`。

## 第一次 clone 之後

```sh
git clone https://github.com/derektu/xr-collector.git
cd xr-collector
npm ci
npm run doctor:build
npm run prepare:runtime -- mac
```

Windows 的最後一行是 `npm run prepare:runtime -- win`。

### `npm run doctor:build`

逐項檢查這台機器建置本平台安裝包的條件，每項標示 `ok`、`missing` 或 `note`，`missing` 與 `note` 附上下一步的指令。任一項 `missing` 時以非零結束。它只檢查、不安裝；上面「先安裝」的項目要先自己裝好。

| 項目 | Mac | Windows |
| --- | --- | --- |
| Host | Apple Silicon 上的 arm64 Node | x64 Node；ARM64 硬體上的 x64 模擬標為 `note` |
| Node／npm／Git | Node 主版本符合 `.nvmrc`（patch 不同標為 `note`），Git 可用 | 同左 |
| npm 套件 | 已執行 `npm ci` | 同左 |
| Xcode Command Line Tools | `swiftc` 可用 | 不適用 |
| Runtime cache | 只報告狀態：未準備時列出 `prepare:runtime` 指令 | 同左 |
| Developer ID 簽章 | 只報告狀態：有 `keys/mac/.env` 時檢查設定與檔案權限，沒有時只能建 ad-hoc 包 | 不適用 |

`prepare:runtime` 與 `package:*` 開工前執行同一套檢查（不含 runtime cache 與簽章狀態），缺少時立即停止並列出修正方式。

### `npm run prepare:runtime`

下載釘住版本的 yt-dlp、Deno 與 Meilisearch，核對 SHA-256 後放進使用者層級的 runtime cache，再安裝到這個 checkout 的 `resources/bin`。版本與 SHA-256 釘在 `scripts/runtime-dependency-pins.json` 與 `src/search/meilisearch-runtime-pins.json`。

- 第一次要連網下載，Meilisearch 約 340 MB；之後從 cache 安裝。
- cache 位置：Mac 是 `~/.cache/xr-collector/runtime`，Windows 是 `%LOCALAPPDATA%\xr-collector\runtime`；可用絕對路徑的 `XR_COLLECTOR_RUNTIME_CACHE` 改位置。同一台機器的所有 checkout 與 worktree 共用，第二個 checkout 只需從 cache 安裝。
- App 執行時只讀 `resources/bin`，不讀 cache。

## 功能開發

### 執行

| 指令 | 用途 |
| --- | --- |
| `npm run dev` | Web 開發模式：API 在 `127.0.0.1:7175`，Vite 在 `http://127.0.0.1:7176/`，修改後自動重載 |
| `npm run electron` | build 後以 Electron 開啟桌面版 |
| `npm run build` 後 `npm start` | 單一 Web Server 在 `http://127.0.0.1:7175/` 同時提供 UI 與 API |

第一次開啟時在 Onboarding 選擇知識庫（Vault）目錄。Web 開發模式的裝置資料放在 checkout 的 `.data/`；`XR_COLLECTOR_VAULT` 直接指定 Vault 並略過 Onboarding，`XR_COLLECTOR_PROFILE` 指定裝置資料目錄。

### 測試

| 指令 | 內容 |
| --- | --- |
| `npm test` | 全部 Vitest 測試 |
| `npm run test:watch` | Vitest watch 模式 |
| `npm run typecheck` | 產品程式 typecheck |
| `npm run verify` | Vitest（含 JUnit 報告）、typecheck 與 Node／Web build；PR 前必跑，CI 執行同一個指令 |

**Vitest 測試**在 `tests/`，依功能分目錄：`core`、`plugins`、`sources`、`jobs`、`activity`、`subscriptions`、`vault`、`search`、`server`、`runtime`、`electron`、`updates`、`web`、`tooling` 等。每個目錄涵蓋單元、HTTP 與檔案系統整合，不連 YouTube。使用真實 Meilisearch 的測試在 `resources/bin` 沒有本平台 binary 時跳過，所以 `prepare:runtime` 之後才完整。各目錄的責任與平台 skip 見 [測試說明](../tests/README.md)。

**E2E 流程**由 verify skill（`.claude/skills/verify/`）執行：它在隔離的 profile、Vault 與 port 啟動 App，以 Playwright 依使用者的方式操作並留下截圖與 `results.json`。已收錄的回歸流程放在 `.claude/skills/verify/flows/`，每支標記一個層級：

| 層級 | 內容 | 什麼時候跑 |
| --- | --- | --- |
| `core` | 常用路徑與資料安全 | 本機快速回饋，幾分鐘內完成 |
| `feature` | 一個功能的專項與邊界 | 改到該功能時 |
| `platform` | Electron 桌面與打包版，視窗會顯示 | 改到平台層、發版前 |
| `real` | 真實 YouTube 與 feed，需要網路 | 改到收集、選軌、辨識或 feed 讀取時 |

```sh
npx playwright install chromium
node .claude/skills/verify/scripts/verify.mjs doctor
node .claude/skills/verify/scripts/verify.mjs flows list
node .claude/skills/verify/scripts/verify.mjs flows run --tier core --issue 123
node .claude/skills/verify/scripts/verify.mjs flows run --feature subscriptions --web --issue 123
```

Web 模式的流程在 Mac 執行，Windows 執行 Electron 桌面流程。證據寫進 `.local/ticket-artifacts/<issue>/`。流程清單、功能地圖與操作方式見 [verify skill](../.claude/skills/verify/SKILL.md) 與 [功能地圖](../.claude/skills/verify/features/README.md)；驗證層級與交付規則見 [開發驗證流程](development-validation.md)。

### CI

GitHub Actions（`.github/workflows/`）在 pull request 與 main push 時執行：

| 工作 | 環境 | 內容 |
| --- | --- | --- |
| Verify | Ubuntu 24.04 | `npm ci` 與 `npm run verify`，保存 JUnit 報告與 build |
| Web regression | macOS 15 | 執行全部已收錄的 Web 流程，保存每支流程的 `results.json` |
| Meilisearch native runtimes | Mac arm64、Windows x64 | 改到 Meilisearch 準備或 pin 時，下載釘住的 release 並跑 API smoke |
| Packaged smoke | Mac、Windows | 手動觸發時建置未簽章的測試包並檢查打包 App |

CI 不建置正式安裝包，也不跑 Electron 桌面流程。

## 建置安裝包

每個平台在自己的機器建置，不跨平台編譯：Mac 安裝包在 Apple Silicon Mac 建置，Windows 安裝包在 Windows 建置。

| 指令 | 產物 |
| --- | --- |
| `npm run package:mac` | DMG 與 ZIP，在 `release/` |
| `npm run package:win` | NSIS 安裝檔，在 `release/` |

打包前先執行 `prepare:runtime`；打包只從 runtime cache 安裝，不下載，缺少時指出要執行的指令。打包要求乾淨的 checkout（沒有未 commit 的修改），完成後從實際的 `app.asar` 與 resources 讀回並核對版本、commit、runtime 與 SHA-256。每次建置另產生 updater metadata 與 artifact manifest。

Windows 的 Meilisearch 依賴 Microsoft Visual C++ runtime 的 `vcruntime140.dll`。repo 在 `resources/windows/` 放一份釘住版本的 DLL，`package:win` 核對它的 SHA-256、檔案版本與 Microsoft 簽章後放在 Meilisearch 旁邊，因此安裝到沒有 Visual C++ Redistributable 的 Windows 也能啟動搜尋。

### 簽章

- **Mac**：預設是 ad-hoc 簽章，可在本機與開發機安裝，但沒有 Gatekeeper 信任。Developer ID 簽章與公證需要 `keys/mac/` 下的憑證與 App Store Connect API key，以 `--mac-signing-mode developer-id-notarized` 啟用，每次送 Apple 公證兩次（App 與 DMG）。
- **Windows**：未簽章。

開發與反覆驗收一律使用 ad-hoc 與未簽章包；Developer ID 只用於使用者確認後的最終發布候選。使用時機與 Developer ID 的建置步驟見 [開發驗證流程的平台打包](development-validation.md#6-平台打包)。

## 發布

正式 Release 只接收兩台建置機從同一個乾淨 commit 建置、並完成驗收的產物；CI 不提供安裝包。一次發布有兩個候選：Mac arm64 與 Windows x64 各一份。App 從公開 repository 的 GitHub Releases 讀取更新，更新索引的契約見 [更新來源](update-source.md)。

repo 還沒有把候選上傳到 GitHub Releases 的發布指令；各平台上傳與各平台更新索引由 [#195](https://github.com/derektu/xr-collector/issues/195) 定義。
