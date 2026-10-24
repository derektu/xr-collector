# #139 第二階段：repo 內建中文精簡 Meilisearch 計畫

狀態：第二階段執行計畫。使用者已指示進入第二階段、維持搜尋設定，並以 repo 指令抓原始碼建置；建置指令已實作；本文件列出平台驗收計畫，不代表已通過三平台驗收。由開發子 agent 實作、獨立 reviewer 審查，最後由 parent 檢查並 commit。

## 本階段成果與邊界

- repo 提供 `npm run build:meilisearch`：抓取固定的 Meilisearch 原始碼，在目前 host toolchain 對應的目標編譯中文精簡 binary，驗證後放入 XR Collector 擁有的 runtime 位置。
- 同一指令供開發機、package script 與 CI 使用，不另外維護一套 CI build recipe。
- 支援三個目標（CI 以原生 runner 驗證）：`darwin-arm64`、`darwin-x64`、`win32-x64`。不以 cross compile 結果冒充該平台原生驗證。
- 安裝包已內含建好的 binary；終端使用者不需要 Rust、Cargo 或網路抓原始碼。需要 Rust 與平台原生 build prerequisites 的是開發／CI／打包機。
- yt-dlp 與 Deno 仍由現有流程下載固定版本與 checksum；本票只把 Meilisearch 從「下載官方 binary」改為「repo 指令從固定 source build」。沒有 public runtime repo、匿名下載 host 或 #35 的發布決策。
- 搜尋契約維持現況：`documents_v2`、三個 `searchableAttributes`、四個 `filterableAttributes`、`maxTotalHits: 10000`，不加入 `localizedAttributes`，query、filter、分頁、highlight/crop 參數也不改。
- 不做通用 Rust build framework、舊格式 migration／相容層、runtime updater 或額外搜尋功能。

Mac x64 在本票完成的是 Meilisearch 原生 x64 build 與 API 驗證。完整 Mac Intel App 仍受 #34 約束：必須另外取得並驗證 x64 Deno、確認 yt-dlp folder build 的 executable 與所有 native libraries 可在 Intel 執行，並加入 Electron x64 package target。#139 不沿用 arm64 Deno、不假設 yt-dlp 是 universal，也不因 Meilisearch x64 完成便宣稱 Mac x64 App 完成。

## repo 指令與可重現 build

### `npm run build:meilisearch`

package script 呼叫一支專用 Node script。預設從 `process.platform/process.arch` 選出目前 target；可提供明確 `--target darwin-arm64|darwin-x64|win32-x64`，但 target 必須與 Node OS/arch 與所選 Rust toolchain host 相符，不符立即失敗。Windows ARM 的 x64 Node＋x64 toolchain 可以模擬編譯，manifest 明列實際 host 與 emulated；CI 則另外斷言原生 runner，不把模擬結果算原生證據。這個 option 用來讓 package/CI 明確聲明目標，不開放任意 Rust target，也不做 cross compile。

指令固定並核對：

- 從 `https://github.com/meilisearch/meilisearch.git` 取得 Meilisearch `v1.53.2` 的完整 commit `ec006cecec6f684b1dcaee093a45ab4c05707127`，checkout 後以 `git rev-parse HEAD` 再確認，不跟隨 tag/branch。
- Rust `1.91.1`；透過 rustup 明確使用這個工具鏈，執行前解析該工具鏈的 `rustc -Vv` 與 `cargo -V`，版本不符就提供安裝提示並停止，不自行改動使用者的 global toolchain。
- 上游 `Cargo.lock` 隨固定 commit 取得；核對 SHA-256 `f884034e00ae026ecc9a3c15999b11857dff4a99ba8d7c0528626571627cefbf`。
- build 命令為 `cargo +1.91.1 build --release --locked -p meilisearch --no-default-features --features chinese --target <rust-target>`，其中 target 只映射到 `aarch64-apple-darwin`、`x86_64-apple-darwin`、`x86_64-pc-windows-msvc`。
- 不含 `mini-dashboard` 與其他預設斷詞；任何 source、lock、toolchain、recipe 或 target 改變，都產生不同 fingerprint。

原始碼抓取到 gitignored 的 `.local/runtime-builds/meilisearch/<recipe>/<target>/` build cache，不加入產品 source tree。首次執行取得固定 commit；之後可以重用已驗證的 source checkout 與 Cargo cache，但每次仍核對 HEAD、Cargo.lock、tracked/untracked source checkout 是否乾淨與所選 toolchain；source checkout 不得容納其他使用者的修改，髒掉時拒絕並提示清除本指令的 cache。無法取得固定 source 且 cache 不完整時直接失敗，不 fallback 到官方 Meilisearch binary、不同 commit 或既有其他架構產物。

需在開發文件列出：Git、Node/npm、Rust 1.91.1、Xcode Command Line Tools（Mac）或 MSVC Build Tools（Windows）及網路首次抓 source/dependencies。package script 在 build 前呼叫此命令；安裝包執行時不呼叫。完整 Mac runtime 的既有 npm 準備入口明定 darwin-arm64，避免 Intel 主機把 x64 Meili 混入 arm64 Deno／Electron App；Mac Intel 引擎使用獨立 build:meilisearch 入口。

### build cache 與 runtime replacement

build fingerprint 至少包含完整 source SHA、Cargo.lock SHA-256、recipe revision、features、release profile、Rust/rustc host、Rust target。每個 target 有獨立 cache entry；manifest 記錄 fingerprint、build command、target、runner/host arch、binary version、bytes、output SHA-256 與完成時間。

cache hit 必須同時滿足 manifest 全欄位、來源 pin、output checksum、`--version` 與 architecture；任何一項不符即重建，不能靜默使用 stale binary、其他架構或舊官方版。編譯使用受控 Cargo 設定：清除外部 compiler／wrapper／rustflags／profile 環境覆寫，拒絕 verified source 外會被 Cargo 讀取的 config；source 內 config 必須為 pinned tracked file。不宣稱不同 runner／OS 的 bit-for-bit 重現。build 在 staging 目錄完成，先驗證 version、檔案格式／架構與 checksum，再將 binary 和 manifest 安裝至該 target 的 owned runtime 位置。驗證失敗時不得動現有 runtime；replace 使用同檔案系統的 sibling staging/backup，swap 失敗 rollback，成功才刪 backup。

runtime 準備流程明確分兩段：既有 downloader 只處理固定版本的 yt-dlp/Deno；`build:meilisearch` 處理 Meilisearch。Mac arm64 與 Windows x64 package script 依序準備兩者再 build App。Mac x64 package script 留給 #34 在其他 runtime 架構收斂後加入，避免本票做出混架構安裝包。

## 三平台 CI

新增 #139 專用 workflow，三個 job 都只呼叫 repo 的同一命令：

| 產品目標 | 原生 runner | 指令目標 | 產物 |
| --- | --- | --- | --- |
| Mac arm64 | `macos-15`（Apple Silicon） | `darwin-arm64` | `meilisearch` + manifest |
| Mac x64 | `macos-15-intel` | `darwin-x64` | `meilisearch` + manifest |
| Windows x64 | `windows-2022` | `win32-x64` | `meilisearch.exe` + manifest |

workflow 的 checkout、Rust setup actions 以完整 commit SHA 固定，Rust 明確為 1.91.1。每個 job 先確認實際 Rust host／runner host arch（不能只看 Node process.arch），再執行 `npm ci` 與 `npm run build:meilisearch -- --target <target>`，接著跑該 binary 的 native API smoke。CI 上傳三份具 build fingerprint 與 output SHA 的 artifacts，供驗收與 package machine 取回；artifacts 是 build evidence/交接物，不是 App runtime 的公開下載來源，也不改變產品端無 token 的要求。

workflow 必須先存在於 pushed commit 才能在 GitHub runner 執行。因此開發 agent 可在本機完成目前平台與自動測試，但 parent 第一次 commit／push 前不得宣稱三個 native CI job 已通過；CI 結果回到相同 commit 後，才能完成 P139-01/02。

## 引擎 fingerprint 與重建

索引 fingerprint 使用穩定的語意 profile（engine source/version、tokenization features、recipe/index schema revision），不把 runner 名稱、build 時間或簽章後 binary SHA 納入相容性判斷。build cache 的完整 provenance／output checksum 與索引相容性分開管理。每個 Vault 對應的 profile search DB 保存旁接 fingerprint record。啟動順序：

1. 由 workspace 既有 `searchPath` 算出 owned DB；不接受任意路徑作為清理目標。
2. 先驗證所用 runtime 的 build manifest 與語意 profile 存在／合法；缺 build manifest 直接失敗，不清 DB。接著安全停止已確認 ownership 的該 DB leftover process，並等待證明退出；binary 路徑曾改變或命令列不明時不得假設已結束。無法證明 DB 未受占用時報錯，不刪資料。
3. fingerprint 相同則保留 DB；不同、缺少或不可讀時，在 Meilisearch 啟動前只刪除該 DB、search state、PID record 與 fingerprint record。
4. 啟動空 DB，以既有 `ManagedTranscriptSearch` 從 Vault 全量重建；Vault 文件、subscriptions、jobs、其他 profile 檔與其他 Vault DB 都不碰。
5. initialize、canonical settings 與文件重建全成功後才原子寫入新 fingerprint；中途失敗不留成功 marker，下次啟動重試。

不做舊 index 就地 migration。刪除／重建失敗要讓搜尋呈現 unavailable 並保留診斷，不能擴大清除範圍。既有 content hash 繼續處理一般 Vault 內容變動；fingerprint 只判斷引擎／schema 相容性。

## 最小實作面

1. build：新增專用 build script、pins/recipe manifest 與三目標 workflow；調整 `package.json`。不新增通用 build framework。
2. runtime preparation：將 `scripts/download-runtime.mjs` 的 Meilisearch 責任移除，保留 yt-dlp/Deno；既有 `download:runtime`／`:win` 的 npm 入口也串接 `build:meilisearch`，維持 verify skill 使用這兩個入口即可備妥全部 runtime；`electron-builder.yml` 明確將 build manifest 一起包入 bin。`electron-builder.yml` 只在現有 Mac arm64/Windows x64 路徑需要時調整，不在本票偷開 Mac x64 package。
3. search runtime：在 `src/search/runtime.ts`／`src/search/meilisearch-process.ts` 附近實作 fingerprint、安全 leftover 停止及受限清除，沿用 workspace `searchPath` ownership。
4. tests/docs：補 build cache/replacement、fingerprint、真實引擎與 runner smoke；更新 build prerequisites 及 `tests/README.md` 的 binary/skip 規則。UI 與業務 API 不變；verify skill 依收錄規則新增可重跑的 documents-reader-search flow 與功能地圖 Regression flows 映射，不改 verify lib/CLI 或業務 Agent Skill。

## 實作前寫入 #139 的驗收 scenario

| ID | 層級／平台 | 操作與可比對預期 |
| --- | --- | --- |
| P139-01 | CI build／三個原生 runner | 三 job 對同一 pushed commit 呼叫 repo 指令；source/toolchain/lock/recipe 完全固定，manifest 與 binary 的 target、version、bytes、SHA 一致。任一平台缺漏即不算三目標完成。parent 首次 commit/push 前保持 pending。 |
| P139-02 | native engine API／三個原生 runner | 以剛 build 的 binary 啟動隔離 DB，套 canonical settings，索引固定中英文件，斷言 query、filter、分頁、highlight/crop；關閉後用同 DB 重啟，結果與文件數一致。核對程序架構及 binary SHA；這不等於 Desktop package 驗收。 |
| P139-03 | build command／各可用原生平台 | 首次抓固定 source 並 build；第二次命中同 target cache。修改假的 source/lock/recipe/toolchain/target/output SHA 任一值會拒絕 cache。離線且沒有完整 cache、target/host 不符、版本或架構驗證失敗都 non-zero，且既有 runtime bytes 不變；不得 fallback 官方版。 |
| P139-04 | runtime/filesystem integration／任一平台 | 相同 fingerprint 不刪 DB；不同／缺少／損壞 fingerprint 在 launch 前只清 owned DB/state/PID/fingerprint，從 fixture Vault 重建後寫新 marker。相鄰 sentinel、另一 Vault DB 與 Vault 原文 hash 前後相同；重建失敗不寫 marker且下次可重試。新斷言在基準版本應失敗。 |
| P139-05 | contract regression／自動檢查 | request-level 斷言 settings/search request 等於現況且沒有 `localizedAttributes`；既有 search tests、`npm run test:meilisearch:mac` 與 `npm run verify` 通過。 |
| P139-06 | packaged Desktop／Mac arm64 | 同一乾淨 commit 準備固定 yt-dlp/Deno 並本機 build slim Meili，再產 DMG/ZIP。記錄下載／建置原檔與 App 內 Meili 各自的 SHA、arm64、版本與 manifest；若打包簽章改變 bytes，另記簽章與轉換關係，不能直接要求 pre-sign hash 等於 post-sign hash，記 `.app`/package bytes，Meili 相對官方版仍至少減半。verify skill 以隔離 profile 驗舊 fingerprint 重建及搜尋→filter→分頁→閱讀→刪除→重啟。 |
| P139-07 | packaged Desktop／Windows x64 | 同一 commit 在 x64 build environment 準備其他 runtime 並 build slim Meili，產 NSIS/win-unpacked；核對 SHA、PE x64、版本、manifest，跑同一 Desktop flow。若 Windows 11 ARM64 VM 用 x64 模擬，證據標 `emulated`，不宣稱 Intel/AMD 原生 Desktop 通過。 |
| P139-08 | Mac x64 邊界／Intel runner + 待補 Desktop | P139-01/02 在 Intel runner 通過。本票不產混架構 App；待 #34 提供/驗證 x64 Deno、yt-dlp executable/native libraries、Electron x64 package target 後才驗完整 package。沒有 Intel Desktop 時標 pending，不以 Rosetta 代替。 |
| P139-09 | Web 回歸／Mac | baseline 與本票各跑本票收錄的 `documents-reader-search` 合成流程，以及既有 `subscribe-a-b`，UI/query 行為一致。本票不改收集來源，不重新抓字幕/RSS，也不重跑第一階段 relevance benchmark 來代替回歸。 |

包裝驗收記錄 commit、OS、host/process arch、是否模擬、App 與內含 binary SHA、大小、scenario 結果與證據路徑。build 成功、CI artifact 或 API smoke 都不替代 Desktop 操作；缺平台時保持 pending/blocked。

## 自動檢查與獨立 review

- 非 Markdown 實作完成後跑 `npm run verify`。build/fingerprint 新測試先在基準證明失敗，再在本票通過；三 runner 不把 skip 算 pass。
- replacement 測試注入 fetch/checkout、source/lock、toolchain、Cargo build、version、architecture、checksum 與 rename 失敗，逐項證明舊 runtime 保留。
- 受限清除測試包含相鄰目錄、另一 Vault、symlink/不受管理路徑拒絕；reviewer 核對所有 `rm` target 只由 owned search path 導出。
- reviewer 對 parent 指定 revision 唯讀檢查：repo/CI 是否真用同一命令；exact pins、`--locked`、三個原生 target 與 cache key 是否完整；無官方/stale/cross-arch fallback；終端 App 不需要 Rust；canonical settings/query 不變；fingerprint 在 launch 前處理且成功後才寫 marker；Mac x64 與 Windows emulation 沒有過度宣稱。
- blocking finding 修正後重跑受影響 scenario 再 review。最後由 parent 核對 diff、issue 驗收計畫與已可執行的本機證據後 commit；CI 依推送授權與環境後補，不自行 push；本計畫本身不授權外部發布。

## 環境與驗證相依

1. private repo 是否可用 `macos-15`、`macos-15-intel`、`windows-2022` runner；不可用時指定同架構 self-hosted runner，不改用 cross compile 冒充。
2. source cache 固定在本 repo 的 ignored `.local/runtime-builds/meilisearch/`；清理只限此指令建立的 cache；source URL、commit 與 Cargo.lock SHA 已固定，不把上游 source 提交進 repo。
3. 本機兩 VM 已完成唯讀 preflight 與本票 owned Rust 1.91.1 工具鏈準備，無 global/default toolchain 修改：UTM macOS arm64 與 Parallels Windows ARM64（x64 Node/MSVC Rust 模擬）。parent commit 後以 crabbox 同步至各自本票獨立 workroot，clean commit 建置／取回 evidence；Windows 原生 x64 仍由 CI 證明。
4. #34 的 Mac Intel Deno 來源、yt-dlp Intel 相容證據、Electron x64 target 與 Intel Desktop 來源。這些不阻擋本票的 Mac x64 Meili CI，會阻擋完整 Mac x64 App 驗收。

## 交付與授權範圍

使用者授權 parent 在開發與 review 後 commit。本輪不預設 push、merge 或發佈 App；三平台 GitHub CI 需分支可供 runner checkout 後才能實跑，未執行的項目保留 pending，不用本機成功代替。使用者已指定以 crabbox 使用兩台 VM；VM 工作目錄與工具鏈均與其他 Claude sessions 隔離。Windows ARM 的 x64 建置／Desktop 結果明列 emulated，不替代原生 x64。
