---
name: verify
description: 以使用者的方式操作 XR Collector（local-first 的 YouTube 字幕／RSS 收集桌面 App）並留下證據。Web 模式用 headless Playwright 操作隔離的 runtime 與合成資料，需要 Electron 或平台能力時用 Playwright _electron 背景模式。驗證票的 scenario、確認畫面或 API 行為、截圖交付、重現使用者回報的問題時使用。目前只支援 Mac。
---

# verify：操作 XR Collector 並留證據

驗證層級與證據規則以 [開發驗證流程](../../../docs/development-validation.md#驗證層級) 為準。本 skill 提供兩件事：

- **CLI** `scripts/verify.mjs`：`doctor`、`launch`、`seed`、`snapshot`、`stop`、`sweep`，負責環境與 instance 的生命週期。
- **函式庫** `scripts/lib/index.mjs`：啟動／接手 instance、`waitFor`、合成資料、經 API 建立前置狀態、headless 頁面、scenario 紀錄與截圖、Electron 啟動與對話框替換。每張票的流程腳本 import 它，只寫該票特有的步驟。

一步一個 CLI 指令適合臨時看一眼；票的驗收寫成一支流程腳本，修改後整條重跑。

功能地圖在 [features/README.md](features/README.md)，每個功能列出入口、操作方式、證明它可用的最終狀態與陷阱。

## 隔離與共用規則

- **Port**：port registry 為本 skill 預留 4 個 slot（7250–7265），每個 slot 依序是 UI/API、Meilisearch、Agent API、合成 feed。`launch` 取第一個沒有存活 lock、四個 port 都空著的 slot；lock 在 `~/.xr-collector/verify-slots/<slot>.json`，跨 worktree 共用，以 PID 加程序啟動時間辨識持有者，PID 被重用不會讓 slot 卡住。4 個都忙時 `launch` 失敗，不擠進別人的 slot。
- **資料**：每次 `launch` 建立新的 `.local/verify-runs/<issue>-<本地時間>-<PID>/`（主 checkout 底下），內含 profile、Vault、這次的 Web UI、`catalog.json`、`server.log`、`run.json`。同一 issue 同時啟動也各有自己的目錄。匯出與備份的預設目錄（產品的「XR Collector 匯出／備份」）也在 run 目錄的 `documents/` 內，不碰 `~/Documents`。啟動的程序不繼承 shell 的 `XR_COLLECTOR_*` 設定。
- **程序**：server 在自己的程序群組（tsx、node、Meilisearch）。`stop` 只對 `run.json` 記錄的群組送訊號，而且群組內要有程序的命令列帶有這個 run 目錄；沒有就視為不是這個 run 的程序，不送訊號。永遠不按程序名稱結束程序，不碰使用者正在用的 App（它用自己的 profile 與 7222／7175 等 port）。
- **證據**：`.local/ticket-artifacts/<issue>/`（主 checkout 底下，gitignored，不 commit）。`stop` 把 `server.log` 複製進去後才刪 scratch；清理永遠不刪證據。同一票重跑時覆寫同名截圖，只留最新。
- **受測版本**：預設是執行指令所在的 Git worktree，可用 `--checkout` 指定。`run.json` 記錄啟動時的 commit 與未提交內容的雜湊；Web UI 在 `launch` 時從受測 checkout build 進 run 目錄，伺服器用受測 checkout 自己的 `server.mts` 載入它的 `src/`。程式改了（commit 或未提交都算）就重新 `launch`，`doctor --run` 會指出。

## Launch

前置（每個 checkout 一次，每個 worktree 都要各做一次，`node_modules` 與 `resources/bin` 不共用）：`npm ci`；`npm run download:runtime`（Meilisearch；真實資料與 Electron 另需 yt-dlp 資料夾版與 Deno）；`npx playwright install chromium`（只在 doctor 說缺少時）。

```sh
node .claude/skills/verify/scripts/verify.mjs launch --issue 91
node .claude/skills/verify/scripts/verify.mjs launch --issue 91 --data real          # 真實 YouTube／feed
node .claude/skills/verify/scripts/verify.mjs launch --issue 91 --vault fixed        # XR_COLLECTOR_VAULT 固定位置
node .claude/skills/verify/scripts/verify.mjs launch --issue 91 --vault none         # 尚未選 Vault，從 Onboarding 開始
node .claude/skills/verify/scripts/verify.mjs launch --issue 91 --no-build           # 不 build，複製 checkout 現有的 dist/web
```

`launch` build Web UI、以 `tsx scripts/server.mts` 背景啟動 runtime，等到 `/api/health` 成功且 `/api/search/status` 為 `ready`（`--vault none` 只等 health）才回傳。輸出的 JSON 是 `run.json`：`runDir`、`url`、`ports`、`pid`、`commit`、`evidence`，合成模式另有 `synthetic`（可用的頻道、影片、feed 網址）。之後的指令都用 `--run <runDir>`。

**資料模式**：

| `--data` | YouTube | RSS |
| --- | --- | --- |
| `synthetic`（預設） | 合成頻道，讀 `catalog.json`，不連網 | 真的 RSS plugin，讀這個 instance 在 feeds port 提供的合成 feed |
| `real` | yt-dlp＋Deno，連 YouTube | 真的 plugin 讀網路上的 feed |

**Vault 模式**：`selected`（預設）建立 Vault 並寫進 profile 的 `vault-selection.json`，與使用者選過 Vault 的狀態相同，搬移與開啟其他知識庫可用。`fixed` 走 `XR_COLLECTOR_VAULT`，搬移與開啟其他知識庫顯示「這次啟動指定了固定的知識庫位置」。`none` 不建立 Vault，畫面從 Onboarding 開始。

**合成資料**（`scripts/lib/synthetic.mjs` 的 `defaultCatalog()`，標題都有【合成】）：

- 頻道 A（`@verify-a`，5 支）、B（`@verify-b`，3 支）：訂閱用。
- 頻道 D（`@verify-d`，3 支，影片 `vD000000001`…）：單支加入用。
- feed：`<feedsOrigin>/feed.xml`（RSS 2.0，4 篇）、`/atom.xml`（Atom，3 篇）、`/blog`（以 `<link rel="alternate">` 宣告 `/feed.xml` 的網頁）。
- 失敗注入：在流程中以 `instance.updateCatalog(c => { c.youtube.failVideo = '<id>'; })` 改 `catalog.json`，server 每次請求重讀。欄位：`youtube.failListing`（頻道 ID，列出影片失敗）、`youtube.failVideo`（影片 ID，收集失敗）、`youtube.rateLimitNext`（下一次收集回 `rate_limited`，YouTube 通道冷卻 30 秒）、`youtube.captureDelayMs`、`feeds["/path"].status`／`delayMs`。新增影片或文章同樣改 catalog。

**真實資料 smoke**：`node .claude/skills/verify/examples/smoke-real.mjs [--issue smoke]` 收一支真實影片（`REAL.video`）並訂閱一個真實 feed（`REAL.feed`，GitHub Blog），經畫面操作。需要網路；YouTube 限流會顯示為失敗的工作。

## Doctor

```sh
node .claude/skills/verify/scripts/verify.mjs doctor                 # 環境與 slot
node .claude/skills/verify/scripts/verify.mjs doctor --run <runDir>  # 加上這個 instance
```

唯讀。檢查平台（Mac arm64）、Node ≥ 22.12、`node_modules`（tsx、playwright）、Chromium、`resources/bin/mac` 的 Meilisearch／yt-dlp、Electron 用的 `dist/node`，以及每個 slot 是 free、in use 還是 stale lock。加 `--run` 再檢查：PID 存活且命令列屬於這個 run、health、search 狀態、Vault 路徑在 run 目錄內、受測 checkout 的 commit 是否已與啟動時不同。`healthy: false` 時 exit code 2。任何結果看起來不對時，先跑 doctor。

## Drive

### 流程腳本（主要方式）

票的流程放 `.local/ticket-artifacts/<issue>/scripts/flow.mjs`，從 [examples/collect-video.mjs](examples/collect-video.mjs) 複製起手：

```js
// 從受測 checkout 自己的 skill import，版本才會和它的 src/ 一致。
import { launchWeb, openPage, recorder, apiState, waitFor, subscribe, idle } from '/<受測 checkout 的絕對路徑>/.claude/skills/verify/scripts/lib/index.mjs';

const instance = await launchWeb({ issue: 91 });            // 或 attach(runDir) 接手 CLI 啟動的 instance
const { page, consoleErrors, close } = await openPage(instance, { route: '/' });
const record = recorder(instance, page);
try {
  await subscribe(instance, 'https://www.youtube.com/@verify-a');   // 前置狀態，非證明
  await idle(instance);
  await record.scenario('N91-W1', '標題', async ({ expect, shot, themed, note }) => {
    await page.getByTestId('nav-jobs').click();
    expect(await page.getByTestId('jobs-empty').count() === 1, '沒有進行中的工作');
    await shot('empty');                                   // N91-W1-empty.png
  });
} finally {
  await record.finish({ consoleErrors, state: await apiState(instance) });
  await close();
  await instance.stop();                                   // 開發中想留著看就跳過，之後用 CLI stop
}
```

流程檔放在主 checkout 的 `.local/`，worktree 裡沒有這個路徑。以受測 checkout 為工作目錄、用絕對路徑執行：`cd <受測 checkout> && node <主 checkout>/.local/ticket-artifacts/91/scripts/flow.mjs`。`launchWeb` 預設驗證工作目錄所在的 checkout；`playwright` 從 import 的 skill 所在 checkout 的 `node_modules` 解析。

函式庫：

| 函式 | 用途 |
| --- | --- |
| `launchWeb({ issue, checkout, data, vault, catalog, build })` | 同 CLI `launch`，回傳 instance |
| `attach(runDir)` | 接手已啟動的 instance |
| `instance.api(path, init)` | 呼叫 UI 用的同一組 HTTP API，錯誤狀態會 throw |
| `instance.catalog()`／`instance.updateCatalog(fn)` | 讀／改合成資料 |
| `instance.stop({ keep })` | 同 CLI `stop` |
| `openPage(instance, { route, colorScheme, viewport })` | headless Chromium，zh-TW、Asia/Taipei，收集 console error |
| `recorder(instance, page)` | `scenario(id, title, body)`、`shot(name)`、`finish(extra)`；寫 `results.json` |
| `apiState(instance)` | Vault、訂閱、工作、文件、搜尋的 API 快照 |
| `collect(instance, url)`／`subscribe(instance, url)`／`idle(instance)` | 以辨識網址＋執行動作建立前置狀態；等工作清空 |
| `waitFor(check, label, { timeout })`、`sleep(ms)` | 輪詢等待 |
| `channel()`、`articles()`、`defaultCatalog()`、`REAL` | 合成資料與真實 smoke 來源 |
| `launchElectron({ issue, hidden })`、`stubDialogs(app, { open, save })`、`recordOpenExternal(app)` | 原生 Desktop（見下節） |

### CLI 單步操作

```sh
V=.claude/skills/verify/scripts/verify.mjs
node $V seed --run <runDir> --subscribe 'https://www.youtube.com/@verify-a' --collect 'https://www.youtube.com/watch?v=vD000000001' --wait
node $V snapshot --run <runDir> --name N91-overview --route /documents [--theme light]
```

網址含 `?`，在 zsh 必須加引號。`seed` 走 `POST /api/url-recognitions` 再執行辨識結果提供的 `subscribe`／`collect` 動作，與新增對話框送出的請求相同。`snapshot` 存 `<name>.png` 與 `<name>.state.json`（`apiState`）。

### 畫面上的穩定把手

- 頁面根元素 `page-sources`／`page-documents`／`page-jobs`／`page-activity`／`page-settings`／`page-reader`／`page-source-detail`；側欄 `nav-sources`、`nav-documents`、`nav-jobs`、`nav-activity`、`nav-settings`。路由 `/`、`/documents`、`/documents/<id>`、`/jobs`、`/activity`、`/settings`、`/sources/<type>/<id>`。
- 新增：訂閱頁 `add-subscription` → `add-item-youtube-channel`／`add-item-rss-feed`；文件頁 `add-document` → `add-item-url`。對話框 `add-dialog`、`add-url`、`add-confirm`（文字「加入」或「訂閱」且 enabled 才可按）、`add-mismatch`、`add-switch`、`add-unsupported`。
- 其餘見各功能檔。優先用 `data-testid` 與 role＋名稱，不用座標。

### 原生 Desktop（Electron）

只用於依賴 Electron 或平台能力的 scenario（原生對話框、preload bridge、視窗、`shell.openExternal`、同 profile 重啟），並在票的結尾執行。受測 checkout 先 `npm run build`（node 與 web 都要；Electron 讀 checkout 的 `dist/web`，只 build node 會看到舊畫面）與 `npm run download:runtime`；`node_modules/electron/dist` 不存在時跑 `node node_modules/electron/install.js`。doctor 的 `electron`、`electronBuild`、`electronWebCurrent` 三項都要是 ok。

```js
import { launchElectron, stubDialogs } from '/<受測 checkout 的絕對路徑>/.claude/skills/verify/scripts/lib/index.mjs';
const desktop = await launchElectron({ issue: 91 });       // XR_COLLECTOR_VALIDATION_HIDDEN=1
await stubDialogs(desktop.app, { open: '/…/run 目錄內的資料夾' });
await desktop.window.getByTestId('nav-settings').click();
await desktop.window.screenshot({ path: `${desktop.evidence}/N91-D1.png` });
await desktop.relaunch();                                  // 同一 profile 重啟
await desktop.close();
```

Electron 用產品自己的 plugin，所以 YouTube 是真的 yt-dlp；合成 YouTube 只在 Web 模式。profile、Vault、Agent port、匯出與備份目錄都隔離在 `.local/verify-runs/<issue>-<本地時間>-<PID>-electron/`，`run.json` 記錄持有它的流程程序。Electron 只活在啟動它的流程程序裡，CLI 沒有 Electron 的 `launch`；流程還在跑時 `stop` 會拒絕、`sweep` 會略過，流程結束後兩者都能清掉它。驗證視窗顯示、聚焦、Dock、Tray 本身時改用 `hidden: false`，並在 issue 註明會跳出視窗。

## Evidence

證明的標準：

- 走使用者的路：經畫面點選與輸入。`seed`／`collect`／`subscribe` 只建立前置狀態，不當作被測功能的證明；不用內部 setter 或測試專用路由。
- 截動作與結果，不只最後畫面：對話框、進行中狀態、完成狀態各一張。需要淺深色時用 `themed(name)`。
- 驗證副作用：Vault 內的 Markdown 檔、`settings/*.json`、匯出的 zip、刪除紀錄、API 回應（`apiState`）。`results.json` 的每個 check 寫出實際觀察值。
- 合成資料只替代 production 已經隔開的外部系統（yt-dlp、網路上的 feed）。截圖與結果標示資料模式（`results.json` 的 `data`）；需要真實 YouTube 的 scenario 用 `--data real`，合成結果不能代替。
- Web 模式截圖標示為 Web 模式，不代替原生 Desktop 證據。
- 看過每張 PNG 再交付：確認不是錯誤頁、過期畫面或空白。

輸出在 `.local/ticket-artifacts/<issue>/`：`<scenario>-<name>.png`、`results.json`（commit、dirty、資料模式、每個 scenario 的 checks 與 observations、console error、API 快照）、`<run>-server.log`、`snapshot` 的 `.png`＋`.state.json`。

## Cleanup

```sh
node .claude/skills/verify/scripts/verify.mjs stop --run <runDir>          # 停止、複製 server.log、釋放 slot、刪 scratch
node .claude/skills/verify/scripts/verify.mjs stop --run <runDir> --keep   # 同上但保留 profile 與 Vault 供檢查
node .claude/skills/verify/scripts/verify.mjs sweep                        # 刪除 server 已不在的 scratch 目錄
```

`stop` 對 server 的程序群組送 SIGTERM，讓 runtime 正常關閉（含 Meilisearch），等到群組內沒有程序；30 秒內沒結束才送 SIGKILL。流程腳本中途 crash 時，server 仍在跑：用 `doctor` 看哪個 slot 被占、拿 `runDir` 跑 `stop`。`launch` 失敗時會結束自己的 server 並釋放 slot，run 目錄留著供診斷，之後由 `sweep` 清掉。每次失敗的嘗試之後都要 stop，避免留下程序與 port。清理不刪 `.local/ticket-artifacts/`。

## 平台

- **Mac arm64**：已支援並驗證。
- **Windows**：待補。尚未處理的部分：`resources/bin/win` 與 `.exe` 路徑、Electron 執行檔路徑、以 PID 與命令列辨識程序（`ps` 在 Windows 不可用）、程序群組結束方式、`~/.xr-collector` 路徑。Windows 驗收暫依 [開發驗證流程](../../../docs/development-validation.md) 第 5 節。
