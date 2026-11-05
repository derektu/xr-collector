# 建置、測試與發布

XR Collector 是 Node.js／TypeScript 專案：Fastify 提供 API 與 Web UI，Electron 包成 Mac 與 Windows 桌面 App。App 隨附三個外部執行檔：搜尋引擎 Meilisearch、字幕擷取的 yt-dlp，以及 yt-dlp 需要的 Deno，三者都使用上游釘住版本的官方 release。這份文件說明開發機與建置機要先安裝什麼、怎麼開發與測試，以及怎麼建置安裝包與發布。

指令範例中，Mac 使用 Terminal（zsh），Windows 使用命令提示字元（cmd）。

## 先安裝

| 項目 | Mac（Apple Silicon） | Windows x64 |
| --- | --- | --- |
| Git | Xcode Command Line Tools 內附（`xcode-select --install`） | [Git for Windows](https://git-scm.com) |
| Node.js 22.22.3 | [nvm](https://github.com/nvm-sh/nvm)：`nvm install` 讀取 repo 的 `.nvmrc` | [nvm-windows](https://github.com/coreybutler/nvm-windows)：`nvm install 22.22.3 64`，再以系統管理員執行 `nvm use 22.22.3` |
| GitHub CLI（只有發布需要） | `brew install gh` | [GitHub CLI](https://cli.github.com) 的 Windows 安裝檔，或 `winget install GitHub.cli` |

Mac 的 Xcode Command Line Tools 同時提供 `swiftc`，用來編譯 App 內附的 macOS 更新 helper。Windows 不需要 Visual Studio 或其他 C++ 工具。

`swiftc` 使用 `xcrun --show-sdk-path` 選出的 SDK，也就是 `/Library/Developer/CommandLineTools/SDKs/` 裡版本最新的一份。這個目錄留有比編譯器新的 SDK（例如裝過 beta 版工具留下的 `MacOSX27.0.sdk`）時，打包停在「macOS update helper」，錯誤是 `this SDK is not supported by the compiler`。刪除那份 SDK 與指向它的 symlink，或重新安裝 Command Line Tools，讓 `xcrun --show-sdk-path` 指向和 `swiftc --version` 相符的版本。

Mac 的 Node 是原生 arm64（不經 Rosetta），Windows 的 Node 是 x64。`node -p process.arch` 應印出 `arm64`（Mac）或 `x64`（Windows）。Windows 可以是 x64 硬體，也可以是 ARM64 硬體上以 x64 模擬執行的 Node，兩者建置的安裝包都可以發布；artifact manifest 記錄建置機的 host 與 process 架構。

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

`npm ci` 結尾列出的 deprecated 與 vulnerabilities 警告不影響建置。不要在建置機執行 `npm audit fix`：它會改寫 `package.json` 與 `package-lock.json`，套件版本不再是 lock 檔驗證過的版本，checkout 也不再乾淨，`package:*` 會拒絕打包。已經改了時，以 `git checkout -- package.json package-lock.json` 還原後重跑 `npm ci`。相依套件的升級在 repo 裡以一般修改進行。

### `npm run doctor:build`

逐項檢查這台機器建置本平台安裝包的條件，每項標示 `ok`、`missing` 或 `note`，`missing` 與 `note` 附上下一步的指令。任一項 `missing` 時以非零結束。它只檢查、不安裝；上面「先安裝」的項目要先自己裝好。

| 項目 | Mac | Windows |
| --- | --- | --- |
| Host | Apple Silicon 上的 arm64 Node | x64 Node；ARM64 硬體上的 x64 模擬是 `ok` 並註明 emulated |
| Node／npm／Git | Node 主版本符合 `.nvmrc`（patch 不同標為 `note`），Git 可用 | 同左 |
| npm 套件 | 已執行 `npm ci` | 同左 |
| Xcode Command Line Tools | `swiftc` 可用 | 不適用 |
| Runtime cache | 只報告狀態：未準備時列出 `prepare:runtime` 指令 | 同左 |
| Developer ID 簽章 | 有 `keys/mac/.env` 時檢查設定與檔案權限，並把 p12 匯入用完即刪的暫時 keychain，確認該 Team 恰有一個有效的 Developer ID Application 身分；不改動使用者的 keychain 與搜尋清單。沒有 `.env` 時只能建 ad-hoc 包 | 不適用 |

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

第一次開啟時在開始使用畫面建立或開啟知識庫（Vault）。Web 開發模式的裝置資料放在 checkout 的 `.data/`；`XR_COLLECTOR_VAULT` 直接指定 Vault 並略過 Onboarding，`XR_COLLECTOR_PROFILE` 指定裝置資料目錄。

### 測試

| 指令 | 內容 |
| --- | --- |
| `npm test` | 全部 Vitest 測試 |
| `npm run test:watch` | Vitest watch 模式 |
| `npm run typecheck` | 產品程式 typecheck；`build` 先跑它 |
| `npm run typecheck:tests` | 測試（`tests/`）typecheck；不在 `build` 裡，測試還沒跟上產品簽章時仍能 build 與啟動 |
| `npm run verify` | Vitest、測試 typecheck、產品程式 typecheck 與 Node／Web build；PR 前必跑，CI 執行同一個指令 |

**Vitest 測試**在 `tests/`，依功能分目錄：`core`、`plugins`、`sources`、`jobs`、`activity`、`subscriptions`、`vault`、`search`、`server`、`runtime`、`electron`、`updates`、`web`、`tooling` 等。每個目錄涵蓋單元、HTTP 與檔案系統整合，不連 YouTube。使用真實 Meilisearch 的測試在 `resources/bin` 沒有本平台 binary 時跳過，所以 `prepare:runtime` 之後才完整。各目錄的責任與平台 skip 見 [測試說明](../tests/README.md)。

**E2E 流程**由 verify skill（`.claude/skills/verify/`）執行：它在隔離的 profile、Vault 與 port 啟動 App，以 Playwright 依使用者的方式操作並留下截圖與 `results.json`。已收錄的回歸流程放在 `.claude/skills/verify/flows/`。

```sh
npx playwright install chromium
node .claude/skills/verify/scripts/verify.mjs flows list
node .claude/skills/verify/scripts/verify.mjs flows run --web --jobs 3 --issue 123
node .claude/skills/verify/scripts/verify.mjs flows run --feature subscriptions --web --issue 123
```

Web 模式的流程在 Mac 執行，Windows 執行 Electron 桌面流程。證據寫進 `.local/ticket-artifacts/<issue>/`。流程清單、功能地圖與操作方式見 [verify skill](../.claude/skills/verify/SKILL.md) 與 [功能地圖](../.claude/skills/verify/features/README.md)；驗證層級與交付規則見 [開發驗證流程](development-validation.md)。

### CI

GitHub Actions（`.github/workflows/`）的工作：

| 工作 | 觸發 | 環境 | 內容 |
| --- | --- | --- | --- |
| Verify (Mac) | pull request 與 main push；只改 Markdown 時不執行 | macOS 15 | `npm ci`、安裝釘住版本的 runtime、`npm run verify`（含真實 Meilisearch 的案例） |
| Nightly | 每天 02:00（台北）在 main，前 26 小時沒有新 commit 時跳過；也可在任何分支手動觸發 | macOS 15 與 Windows Server 2022 | 兩平台的 `npm run verify`（含真實 Meilisearch）與 verify skill 自測、開發版 startup 與 Desktop 流程、未簽章測試包與打包版 startup；Mac 的全部 Web 流程；保存每支流程的 `results.json` 與失敗證據；失敗時開 nightly issue 並加入看板 |
| Meilisearch native runtimes | 改到 Meilisearch 準備或 pin 的 pull request 與 main push | Mac arm64、Windows x64 | 下載釘住的 release 並跑 API smoke |

CI 不建置正式安裝包。各層驗證在哪裡執行見 [開發驗證流程](development-validation.md#做票驗收pr-門檻與-nightly)。

## 建置安裝包

每個平台在自己的機器建置，不跨平台編譯：Mac 安裝包在 Apple Silicon Mac 建置，Windows 安裝包在 Windows 建置。

| 指令 | 產物 |
| --- | --- |
| `npm run package:mac` | DMG 與 ZIP，在 `release/` |
| `npm run package:win` | NSIS 安裝檔，在 `release/` |

打包前先執行 `prepare:runtime`；打包只從 runtime cache 安裝，不下載，缺少時指出要執行的指令。打包要求乾淨的 checkout（沒有未 commit 的修改），執行期間持有整個 checkout 的獨占鎖，所有入口都使用 `--publish never`。完成後從實際的 `app.asar` 與 resources 讀回並核對版本、commit、runtime 與 SHA-256，任一不一致都不交付。每次建置另在 `release/` 寫出兩份檔案：

- 該平台的 release index：`release-darwin-arm64.json` 或 `release-win32-x64.json`，記錄版本、完整 commit、BuildInfo，以及安裝檔與更新檔的檔名、大小與 SHA-256。它和安裝檔一起上傳，App 靠它找到自己平台的更新檔。
- artifact manifest：`XR-Collector-<版本>-<target>-artifacts.json`，記錄這次建置的所有產物、runtime、簽章、工具版本與建置機架構，留在建置機，不上傳。

Windows 的 Meilisearch 依賴 Microsoft Visual C++ runtime 的 `vcruntime140.dll`。repo 在 `resources/windows/` 放一份釘住版本的 DLL，`package:win` 核對它的 SHA-256、檔案版本與 Microsoft 簽章後放在 Meilisearch 旁邊，因此安裝到沒有 Visual C++ Redistributable 的 Windows 也能啟動搜尋。

### 簽章

- **Mac**：預設是 ad-hoc 簽章，可在本機與開發機安裝，但沒有 Gatekeeper 信任；打包的檢查以 `codesign --verify --deep --strict` 驗證 bundle 與 sealed resources。從瀏覽器下載的 ad-hoc 包帶有隔離屬性，macOS 會拒絕開啟；測試時以 `xattr -dr com.apple.quarantine "/Applications/<App 名稱>.app"` 移除，或在「系統設定 → 隱私權與安全性」選「強制打開」。Developer ID 簽章與公證需要 `keys/mac/` 下的憑證與 App Store Connect API key（檔案與設定方式見 [簽署設定](../config/README.md)），步驟見下一節。
- **Windows**：未簽章。預期的簽署設定格式見 [簽署設定](../config/README.md#windows)。

開發與反覆驗收一律使用 ad-hoc 與未簽章包；Developer ID 只用於使用者確認後的最終發布候選，使用時機見 [開發驗證流程的平台打包](development-validation.md#6-平台打包)。

### Mac 的 Developer ID 建置

以 `--mac-signing-mode developer-id-notarized --mac-signing-env <absolute-env> --mac-signing-root <absolute-root>` 明確啟用 Developer ID 模式：

```bash
npm run package:mac -- --mac-signing-mode developer-id-notarized --mac-signing-env /absolute/signing/root/.env --mac-signing-root /absolute/signing/root
```

env 只接受 `CSC_LINK`、`CSC_KEY_PASSWORD`、`APPLE_API_KEY`、`APPLE_API_KEY_ID`、`APPLE_API_ISSUER`、`APPLE_TEAM_ID`；兩個檔案路徑都相對 signing root，env、p12、p8 必須只允許 owner 讀取。流程以專用 temporary keychain 找到該 p12 唯一且 Team 相符的 identity。因 macOS `codesign --keychain` 仍要求 identity 所在 keychain 可被搜尋，流程在保留既有順序下把自己建立的 keychain 暫時 append 到目前 user search list；正常清理由 `delete-keychain` 移除自己的 keychain，若該命令失敗，fallback 只從當下清單刪除自己的 entry，保留其他 session 同時加入的項目，並讓整次建置以包含主錯與清理錯的診斷失敗，不用舊 snapshot 覆蓋新變更。builder child 不取得 App Store Connect key。Mac Developer ID 產物依下列順序建置與檢查，每份產物只做一次完整檢查：

1. electron-builder `--dir` 產 App；afterPack 簽署 staged runtime，再以 Developer ID 簽署 App。
2. 公證前對 App 跑完整 Developer ID gate：Team、hardened runtime、entitlements、sealed resources 與 signed runtime inventory。
3. App 只送公證一次：以 `ditto` 壓成上傳用 ZIP，`notarytool submit` 後立即用 upload SHA、Team 與用途保存 submission ID，再等待結果並取回 log；中斷後只續查同一 submission，不能盲目重送。`Accepted`、零 issues 才 `stapler staple` 並 `stapler validate` App。
4. 對已 staple 的 App 跑完整 Developer ID gate、`syspolicy_check distribution` 與 `spctl --assess --type execute`；這份 App 的 identity 記為 App 收據的 `stapled`。
5. electron-builder 以 `--prepackaged` 由已 staple 的 App 一次產出 DMG 與 ZIP。
6. DMG 只送公證一次：直接上傳 DMG 本身，與 App 共用同一套 submission 保存、續查與收據規則；`Accepted`、零 issues 才 `stapler staple` 並 `stapler validate` DMG。DMG 收據的 `stapled` 是最終 DMG 的 bytes。
7. DMG gate：`codesign --verify --strict` 與 Team，並以 `spctl --assess --type open --context context:primary-signature -vv` 評估；該命令 exit code 非零，或 `source=` 不是 `Notarized Developer ID`，即失敗。`source=` 行印在 log。
8. 唯讀掛載 DMG，其中唯一的 App bytes 必須等於 `stapled`，並對它跑 `stapler validate`、`syspolicy_check distribution` 與 `spctl --assess --type execute` 各一次。
9. 以 `ditto` 解開 ZIP，其中唯一的 App 做與第 8 步相同的比對與檢查。
10. 讀回 `release/mac-arm64` 的 App：bytes 必須等於 `stapled`，再核對 BuildInfo、runtime 與 resources；步驟 2、4 已驗過相同 bytes，不重跑 Developer ID gate。

這些自動 gate 不取代 clean browser download、Finder 安裝及首次開啟的實機驗收。

Developer ID 會改變部分 runtime bytes。簽署 hook 只處理 staging copy，raw source pin 不變；runtime Mach-O 葉節點檔案最多 8 個同時簽署，Python.framework 等 bundle 在其內容全部簽完後才簽，維持由內而外；簽署前會把 SHA-256 pin 驗證過的 yt-dlp／Deno archives 另行解壓到隔離目錄，以該獨立重建結果比對 raw source 與 staging tree，不能用可和檔案一起改寫的 manifest 自證。`runtime-signing.json` 同時保存 raw producer identity、final 完整 inventory、Meilisearch raw／final identity及實際 signature。啟動端只接受 raw hash，或接受被有效外層 App seal 保護、final hash 相符且 Meilisearch 與外層 App Team 相同的 Developer ID identity；不能只信任可被單獨覆寫的 sidecar final SHA。Deno 保留固定 upstream 簽章。

## 發布

一個版本是一個 GitHub Release，tag 是 `v` 加上 `package.json` 的版本（例如 `v0.1.0`）。Mac 與 Windows 各在自己的建置機，從同一個乾淨 commit 打包，再以 `npm run release:upload` 上傳到這個 tag 的 draft Release。兩個平台可以由不同的人、在不同時間、以任意順序上傳；兩個平台都到齊後，以 `gh release edit` 公開。CI 不提供安裝包。

每個平台上傳三類檔案：

| 平台 | 安裝檔 | App 內更新檔 | release index |
| --- | --- | --- | --- |
| Mac | `XR-Collector-<版本>-mac-arm64.dmg` | `XR-Collector-<版本>-mac-arm64.zip` | `release-darwin-arm64.json` |
| Windows | `XR-Collector-<版本>-win-x64-setup.exe`（同時是更新檔） | 同左 | `release-win32-x64.json` |

App 從 GitHub 最新的穩定 Release（不是 draft、不是 prerelease）讀取自己平台的 release index，再下載 index 指定的更新檔並核對大小與 SHA-256。Release 沒有某個平台的 index 時，那個平台的 App 回報已是最新版。index 的格式見 [更新來源](update-source.md)。blockmap 與 artifact manifest 不上傳。

### 第一次：登入 GitHub CLI

每台要上傳的機器（含 Windows VM 裡執行上傳的帳號）各登入一次，帳號要能寫入發布的 repository：

```sh
gh auth login
gh auth status
```

`gh auth login` 選 GitHub.com 與 HTTPS，依畫面以瀏覽器授權；在沒有桌面的 SSH 連線中，它印出一次性代碼與網址，在任一台電腦的瀏覽器輸入即可。

### 上傳一個平台

1. 要發布的版本寫在 `package.json` 的 `version`，該 commit 已 push 到 GitHub。
2. 在建置機 checkout 這個 commit，不留任何修改或未追蹤的檔案，然後打包並上傳：

   ```sh
   npm ci
   npm run prepare:runtime -- mac
   npm run package:mac -- --mac-signing-mode developer-id-notarized --mac-signing-env "$PWD/keys/mac/.env" --mac-signing-root "$PWD/keys/mac"
   npm run release:upload -- v0.1.0
   ```

   Windows（cmd）：

   ```bat
   npm ci
   npm run prepare:runtime -- win
   npm run package:win
   npm run release:upload -- v0.1.0
   ```

`release:upload` 只上傳這台機器 `release/` 裡本平台的檔案，目標 repository 是安裝包內建的更新 repository（正式包是 `derektu/xr-collector`）。它依序確認：

- checkout 沒有未 commit 的修改，HEAD 是 release index 記錄的建置 commit；
- 本機若有同名 tag，它指向 HEAD；
- 安裝檔與更新檔的大小與 SHA-256 等於 release index；
- GitHub 上的 tag 指向 HEAD。tag 不存在時，以 HEAD 在 GitHub 建立；GitHub 沒有這個 commit 時停止，要先 push；
- 這個 tag 只有一個 Release，而且是 draft。Release 不存在時建立 draft；已公開時停止。

接著上傳 draft 裡還沒有的檔案。draft 已有同名且 SHA-256 相同的檔案時略過，所以重跑不會重複上傳；同名但內容不同時停止，並印出移除那個檔案的 `gh release delete-asset` 指令，由發布者確認後自行執行。上傳後把每個檔案從 draft 下載回來核對 SHA-256，最後列出 draft 目前收齊的平台。任一項不符都會停止並說明原因，不修改已上傳的檔案。

### 在 Parallels 的 Windows VM 建置與上傳

Mac 開發者可以在 Parallels 的 Windows 11（ARM64）VM 建置 Windows 版：VM 裡安裝 x64 Node，建置跑在 x64 模擬下，產出的安裝包可以發布。VM 需要開啟 OpenSSH Server、裝好 Git、x64 Node 與 GitHub CLI，並以 SSH 帳號完成一次 `gh auth login`。

[crabbox](https://github.com/openclaw/crabbox)（`brew install openclaw/tap/crabbox`）把 Mac 上的 repository 同步到 VM 並執行指令。發布用的建置要從乾淨的 checkout 開始，所以先在 Mac commit 並 push，再以 `--full-resync` 讓 VM 重建整個 checkout（它也清掉 VM 裡的 `node_modules` 與建置產物，因此會重新安裝；runtime cache 在 checkout 外，不受影響）：

```sh
crabbox run --provider ssh --target windows --windows-mode normal \
  --static-host <VM 的 IP> --static-user <SSH 帳號> --static-port 22 \
  --static-work-root 'C:\projects\crabbox-work' \
  --git-seed-source local --full-resync \
  -- cmd /c "git status --porcelain && npm ci && npm run prepare:runtime -- win && npm run package:win && npm run release:upload -- v0.1.0"
```

- `--git-seed-source local` 從 Mac 帶過去 Git 歷史，VM 的 checkout 因此有真正的 HEAD，`package:win` 與 `release:upload` 才能核對 commit。
- 指令以 `cmd /c` 執行，不經 PowerShell；`--script` 會在 checkout 留下 `.crabbox/scripts/`，使 checkout 不乾淨，所以用 inline 指令。
- VM 的 IP 可用 `prlctl list -i "Windows 11"` 查詢。執行失敗時 crabbox 會在 Mac 的 repository 留下 `.crabbox/`，下一次執行前刪除。

### 公開

兩個平台都上傳後，先確認 draft 收齊兩份 release index：

```sh
gh release view v0.1.0 --repo derektu/xr-collector --json isDraft,assets --jq '.isDraft, [.assets[].name]'
```

寫好版本說明（Markdown，App 內「版本說明」顯示的就是這段文字），再公開並設為 Latest：

```sh
gh release edit v0.1.0 --repo derektu/xr-collector --draft=false --latest --notes-file release-notes.md
```

公開後，已安裝的 App 在下一次檢查更新時看到這一版。GitHub 對 Latest Release 的回應最多快取 60 秒，App 也沿用這個快取，所以公開後一分鐘內的檢查可能仍回報已是最新版。`release:upload` 不會公開 Release，也不會上傳到已公開的 Release；公開之後若要換掉某個平台的檔案，就發布下一個版本。

### Mac 版的 Developer ID 憑證

Mac 正式版以 Developer ID 簽章並送 Apple 公證，建置機需要這三個檔案，放在 checkout 的 `keys/mac/`（已列在 `.gitignore`），每個檔案的權限只允許擁有者讀取（`chmod 600`）：

| 檔案 | 內容 |
| --- | --- |
| `Developer ID Application` 憑證的 `.p12` | 簽章用的憑證與私鑰，匯出時設定的密碼 |
| App Store Connect API key 的 `.p8` | 公證用的金鑰 |
| `.env` | `CSC_LINK`（p12 相對 `keys/mac` 的路徑）、`CSC_KEY_PASSWORD`、`APPLE_API_KEY`（p8 的相對路徑）、`APPLE_API_KEY_ID`、`APPLE_API_ISSUER`、`APPLE_TEAM_ID`；由 [`config/mac-signing.env.example`](../config/mac-signing.env.example) 複製後填入 |

目錄結構、權限與各欄位的說明見 [簽署設定](../config/README.md)。

建置機還要有 Apple 的 Developer ID G2 中繼憑證（Developer ID Certification Authority），p12 裡的憑證才接得上 Apple 根憑證。裝過 Xcode 的 Mac 通常已有；只裝 Command Line Tools 的新機器沒有，這時 p12 能匯入，但簽章身分被判為無效。下載並匯入 login keychain：

```sh
curl -fsSLo ~/Downloads/DeveloperIDG2CA.cer https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer && security import ~/Downloads/DeveloperIDG2CA.cer -k ~/Library/Keychains/login.keychain-db
```

交接給新的 Mac 建置者時，由持有 Apple Developer 帳號的人提供 p12 與其密碼、p8 與它的 Key ID 和 Issuer ID，以及 Team ID；這些檔案與密碼以不經過 Git、聊天紀錄的方式傳遞。放好後執行 `npm run doctor:build`，`Mac Developer ID signing` 一項為 `ok` 並顯示 Team 時即可建置；缺中繼憑證、密碼錯或 Team 不符時，這一項為 `missing` 並附修正指令。沒有這些檔案時，`package:mac` 只能產生 ad-hoc 簽章的包，適合開發與驗收，不適合發布。Windows 版不簽章，不需要憑證。

完整的發布前檢查與出錯時的處理見 [Release 發布手冊](release-runbook.md)。
