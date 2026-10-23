---
name: verify
description: 以使用者的方式操作 XR Collector（local-first 的 YouTube 字幕／RSS 收集桌面 App）並留下證據。Web 模式用 headless Playwright 操作隔離的 runtime 與合成資料，需要 Electron 或平台能力時用 Playwright _electron 背景模式，也能啟動 npm run package:mac 打包出的 .app。驗證票的 scenario、確認畫面或 API 行為、驗證打包版、截圖交付、重現使用者回報的問題時使用。目前只支援 Mac。
---

# verify：操作 XR Collector 並留證據

驗證層級與證據規則以 [開發驗證流程](../../../docs/development-validation.md#驗證層級) 為準。本 skill 提供兩件事：

- **CLI** `scripts/verify.mjs`：`doctor`、`launch`、`seed`、`snapshot`、`stop`、`sweep`，負責環境與 instance 的生命週期。
- **函式庫** `scripts/lib/index.mjs`：啟動／接手 instance、`waitFor`、合成資料、經 API 建立前置狀態、headless 頁面、scenario 紀錄與截圖、Electron 啟動與對話框替換。每張票的流程腳本 import 它，只寫該票特有的步驟。

一步一個 CLI 指令適合臨時看一眼；票的驗收寫成一支流程腳本，修改後整條重跑。

功能地圖在 [features/README.md](features/README.md)，每個功能列出入口、操作方式、證明它可用的最終狀態與陷阱。

## 隔離與共用規則

- **Port**：port registry 為本 skill 預留 4 個 slot（7250–7265），每個 slot 依序是 UI/API、Meilisearch、Agent API、合成 feed。`launch` 取第一個沒有存活 lock、四個 port 都空著的 slot；lock 在 `~/.xr-collector/verify-slots/<slot>.json`，跨 worktree 共用，以 PID 加程序啟動時間辨識持有者，PID 被重用不會讓 slot 卡住。4 個都忙時 `launch` 失敗，不擠進別人的 slot。
- **資料**：每次 `launch` 建立新的 `.local/verify-runs/<issue>[-<label>]-<本地時間>-<PID>/`（主 checkout 底下，`sweep` 因此看得到每個 worktree 的 run），內含 profile、Vault、這次的 Web UI、`catalog.json`、`server.log`、`run.json`。同一 issue 同時啟動也各有自己的目錄。匯出與備份的預設目錄（產品的「XR Collector 匯出／備份」）也在 run 目錄的 `documents/` 內，不碰 `~/Documents`。啟動的程序不繼承 shell 的 `XR_COLLECTOR_*` 設定。
- **程序**：run 的程序以執行檔加命令列辨識：帶有 `--xr-verify-run=<run 目錄>/` 標記、執行 `server.mts` 的 node 與 Electron，以及 `--db-path` 在 run 目錄 profile 內的 meilisearch。不依賴 `run.json` 記錄的 PID；其他執行檔即使命令列含有標記或目錄（`pgrep -f`、`tail` 它的 log、`verify.mjs stop --run`）也不算。`stop` 只在程序群組的 leader 本身就是 run 的程序時（detached 啟動的 Web server 與 Electron）才對整個群組送訊號；其餘 run 的程序（例如 leader 已死後剩下的 Meilisearch）逐一送訊號，所以不會波及使用者 terminal 的 job 或其他 shell。永遠不按程序名稱結束程序，不碰使用者正在用的 App（它用自己的 profile 與 7222／7175 等 port）。
- **證據**：預設是執行指令所在 worktree 的 `.local/ticket-artifacts/<issue>/`（gitignored，不 commit），與票的流程腳本放在一起；`--checkout` 只決定受測版本，不影響證據位置。加 label（CLI `--label baseline`、`launchWeb({ label })`；一個資料夾名，只含英數、`.`、`-`、`_`，不能是 `.` 或 `..`）時寫進 `<issue>/<label>/`，基準與本票版本分開存放；同一個 label 的資料夾已經存在時，改用下一個空的 `<label>-2/`、`<label>-3/`……，已存在的資料夾一律不覆寫。實際用的資料夾名記在 instance 的 `label`／`evidence`、`launch` 的輸出與 `results.json` 的 `label`（例如 `baseline-2`）；報告引用證據時寫這個實際的資料夾名。沒有 label 的 run 共用 `<issue>/`，重跑時覆寫同名截圖。在另一台機器跑完再整批取回時，以 `--evidence <dir>`（函式庫的 `evidence` 選項）指定證據目錄：`results.json`、截圖與 log 只寫進該目錄，預設位置不寫入；目錄必須不存在或是空的，已有檔案時拒絕啟動；run 在目錄裡放一個 `.claimed` 佔用，同時給同一個目錄的兩個 run 只有一個能啟動。`stop` 把 `server.log` 複製進去後才刪 scratch；清理永遠不刪證據。
- **受測版本**：預設是執行指令所在的 Git worktree，可用 `--checkout` 指定。`run.json` 記錄啟動時的 commit 與未提交內容的雜湊；Web UI 在 `launch` 時從受測 checkout build 進 run 目錄，伺服器用受測 checkout 自己的 `server.mts` 載入它的 `src/`。程式改了（commit 或未提交都算）就重新 `launch`，`doctor --run` 會指出。

## Launch

前置（每個 checkout 一次，每個 worktree 都要各做一次，`node_modules` 與 `resources/bin` 不共用）：`npm ci`；`npm run download:runtime`（Meilisearch；真實資料與 Electron 另需 yt-dlp 資料夾版與 Deno）；`npx playwright install chromium`（只在 doctor 說缺少時）。

```sh
node .claude/skills/verify/scripts/verify.mjs launch --issue 91
node .claude/skills/verify/scripts/verify.mjs launch --issue 91 --data real          # 真實 YouTube／feed
node .claude/skills/verify/scripts/verify.mjs launch --issue 91 --vault fixed        # XR_COLLECTOR_VAULT 固定位置
node .claude/skills/verify/scripts/verify.mjs launch --issue 91 --vault none         # 尚未選 Vault，從 Onboarding 開始
node .claude/skills/verify/scripts/verify.mjs launch --issue 91 --no-build           # 不 build，複製 checkout 現有的 dist/web
node .claude/skills/verify/scripts/verify.mjs launch --issue 91 --label baseline --checkout /Users/derektu/projects/km/xr-collector   # 基準
node .claude/skills/verify/scripts/verify.mjs launch --issue 91 --evidence /tmp/evidence/91       # 證據寫到指定目錄
```

`launch` build Web UI、以 `tsx scripts/server.mts` 背景啟動 runtime，等到 `/api/health` 成功且 `/api/search/status` 為 `ready`（`--vault none` 只等 health）才回傳。輸出的 JSON 是 `run.json`：`runDir`、`url`、`ports`、`pid`、`commit`、`sourceHash`、`evidence`，合成模式另有 `synthetic`（可用的頻道、影片、feed 網址）。之後的指令都用 `--run <runDir>`。

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
node .claude/skills/verify/scripts/verify.mjs doctor --app "release/mac-arm64/XR Collector.app"   # 加上受測的打包版
```

唯讀。檢查平台與 Node 架構（Mac arm64）、Node ≥ 22.12、`node_modules`（tsx、playwright）、Chromium、`resources/bin/<平台>` 的 Meilisearch／yt-dlp／Deno、開發版 Electron 的執行檔與 `dist/node`，以及每個 slot 是 free、in use 還是 stale lock。加 `--app` 再檢查受測的打包版：`.app` 與它的執行檔、`app.asar`、`.app` 內 `Resources/bin` 的 Meilisearch／yt-dlp／Deno、執行檔的架構與 Node 相同、Electron fuses 允許 Playwright 連線（`appFuses`，值是 fuse wire，例如 `101100011`）。加 `--run` 再檢查：PID 存活且命令列屬於這個 run、health、search 狀態、Vault 路徑在 run 目錄內、受測 checkout 的 commit 是否已與啟動時不同。

輸出的 `missing` 列出每個沒通過的項目、路徑與修正方式，`required: true` 的項目讓 `healthy` 為 false、exit code 為 2；開發版 Electron 的項目只有 Electron 流程需要，不影響 `healthy`。在另一台機器執行失敗時，先看 `missing`。任何結果看起來不對時，先跑 doctor。

## Drive

### 流程腳本（主要方式）

票的流程放在票的 worktree 的 `.local/ticket-artifacts/<issue>/scripts/flow.mjs`，從 [examples/collect-video.mjs](examples/collect-video.mjs) 複製起手：

```js
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const { values: o } = parseArgs({ options: { checkout: { type: 'string' }, label: { type: 'string' } } });
// 從受測 checkout 自己的 skill import，版本才會和它的 src/ 一致；--checkout 換成基準時一起換（見「基準」）。
const checkout = path.resolve(o.checkout ?? execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim());
const { launchWeb, openPage, recorder, apiState, subscribe, idle } = await import(
  pathToFileURL(path.join(checkout, '.claude/skills/verify/scripts/lib/index.mjs')).href);

const instance = await launchWeb({ issue: 91, label: o.label, checkout });   // 或 attach(runDir) 接手 CLI 啟動的 instance
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

在票的 worktree 執行：`node .local/ticket-artifacts/91/scripts/flow.mjs`。`launchWeb` 預設驗證工作目錄所在的 checkout，證據寫進同一個 worktree；`playwright` 從 import 的 skill 所在 checkout 的 `node_modules` 解析。

### 基準

回歸流程跑兩次，同一支流程：先基準，再本票版本。基準是主 checkout（`/Users/derektu/projects/km/xr-collector`，追蹤 main），從票的 worktree 以 `--checkout` 指定它：

```sh
cd <票的 worktree>
node .local/ticket-artifacts/91/scripts/flow.mjs --checkout /Users/derektu/projects/km/xr-collector --label baseline
node .local/ticket-artifacts/91/scripts/flow.mjs --label ticket
```

流程以 `--checkout` 決定從哪個 checkout import 函式庫：基準從主 checkout 的 skill import，本票版本從票的 worktree 的 skill import，函式庫才與它驅動的 `src/` 一致。靜態 `import` 的路徑是固定的，所以上面的流程用動態 import，並把 `checkout` 明確傳給 `launchWeb`（函式庫的預設是工作目錄所在的 checkout，基準時就會指向票的 worktree）。[examples/collect-video.mjs](examples/collect-video.mjs) 也是這個寫法。證據位置由工作目錄決定，兩次都寫進票的 worktree，分在 `91/baseline/` 與 `91/ticket/`；再跑一次基準落在 `91/baseline-2/`，前一次保留。主 checkout 要先 `git pull` 到最新的 main，並有自己的 `node_modules`。

### 重啟

當機後接續、重啟後狀態保留這類 scenario，用 `instance.restart()` 在同一個 run 上重啟 server：同一份 runtime 程式、profile、Vault、`catalog.json`、port 與 slot。

```js
await instance.restart({ page });                // 正常關閉（SIGTERM，runtime 走自己的關閉流程）後重啟
await instance.restart({ crash: true, page });   // 非正常結束：SIGKILL run 的程序（server 與 Meilisearch），不走關閉流程
const { jobs } = await instance.api('/api/jobs?state=all&limit=100');   // 例如 crash 後 recovery.lastStop 為 crash
```

`restart` 等到重啟的 server ready（health 成功、search 為 `ready`）才回傳，之後 `api`、`openPage`、`snapshot` 照常可用；傳入 `page` 時，重啟期間它停在 `about:blank`，完成後回到原本的路由，沒傳的頁面自己 `reload()`。Vault 只在 run 第一次啟動時建立，重啟時從 profile 的 `vault-selection.json` 開回同一個 Vault（流程中搬移或換過 Vault 時開的是換過的那個）。重啟期間 slot lock 由流程程序持有，其他 session 這時執行的 `sweep` 不會清掉這個 run；新的 server 起來後，`run.json` 與 slot lock 換成它的 PID。server 已經死掉、slot 被其他 run 取得時，`restart` 拒絕並報錯，改用新的 `launch`。server.log 是同一個檔案，往後附加，兩段之間以一行 `--- verify restart (graceful|crash) <時間> ---` 分隔。

函式庫：

| 函式 | 用途 |
| --- | --- |
| `launchWeb({ issue, label, evidence, checkout, data, vault, catalog, build })` | 同 CLI `launch`，回傳 instance |
| `attach(runDir)` | 接手已啟動的 instance |
| `instance.api(path, init)` | 呼叫 UI 用的同一組 HTTP API，錯誤狀態會 throw；只有帶 `body` 的請求才送 `content-type: application/json` |
| `instance.catalog()`／`instance.updateCatalog(fn)` | 讀／改合成資料 |
| `instance.restart({ crash, page })` | 在同一個 run 上重啟 server（見「重啟」） |
| `instance.stop({ keep })` | 同 CLI `stop` |
| `openPage(instance, { route, colorScheme, viewport })` | headless Chromium，zh-TW、Asia/Taipei，收集 console error |
| `recorder(instance, page)` | `scenario(id, title, body)`、`shot(name)`、`finish(extra)`；寫 `results.json`。`page` 可以是回傳目前頁面的函式（Electron `relaunch()` 後換了視窗） |
| `apiState(instance)` | Vault、訂閱、工作、文件、搜尋的 API 快照 |
| `collect(instance, url)`／`subscribe(instance, url)`／`idle(instance)` | 以辨識網址＋執行動作建立前置狀態；等工作清空 |
| `waitFor(check, label, { timeout })`、`sleep(ms)` | 輪詢等待 |
| `channel()`、`articles()`、`defaultCatalog()`、`REAL` | 合成資料與真實 smoke 來源 |
| `launchElectron({ issue, label, evidence, app, vault, hidden })`、`stubDialogs(app, { open, save })`、`recordOpenExternal(app)` | 原生 Desktop（見下節） |

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

`vault` 預設 `selected`：以 checkout 的 `dist/node` 建立 Vault 並寫進 profile，畫面直接進到 App。`vault: 'none'` 不建立 Vault，畫面從 Onboarding 開始，用 `stubDialogs` 回答選擇目錄的對話框，經畫面建立或開啟 Vault。

Electron 用產品自己的 plugin，所以 YouTube 是真的 yt-dlp；合成 YouTube 只在 Web 模式，需要合成 YouTube 的 scenario 改用 Web 模式，或在 Desktop 用真實資料。profile、Vault、Agent port、匯出與備份目錄都隔離在 `.local/verify-runs/<issue>-<本地時間>-<PID>-electron/`，`run.json` 記錄持有它的流程程序。Electron 只活在啟動它的流程程序裡，CLI 沒有 Electron 的 `launch`；流程還在跑時 `stop` 會拒絕、`sweep` 會略過。流程 crash 而 Electron 還活著時，`sweep` 也會略過（列在 `live`），`stop --run <run 目錄>` 會以 SIGTERM 關閉這個遺留的 Electron 與它的 Meilisearch，再清掉 run 目錄。Electron 自己 crash 而流程還在時，`close()`／`relaunch()` 會先收掉留下的 Meilisearch。主程序的輸出寫進 run 的 `server.log`，`close()` 時複製到證據目錄。驗證視窗顯示、聚焦、Dock、Tray 本身時改用 `hidden: false`，並在 issue 註明會跳出視窗。

### 打包版

`launchElectron({ app })` 啟動打包好的 App（Mac 是 `npm run package:mac` 產生的 `release/mac-arm64/XR Collector.app`），其餘與開發版相同：同一套隔離的 profile、Vault 與 port，同樣的背景模式、`stubDialogs` 與證據格式。經過連結的路徑（例如 `/tmp`，實際是 `/private/tmp`）會換成實際路徑，與 App 回報的路徑一致。下列行為只有打包版看得到，相關 scenario 用打包版驗證：

- `app.asar` 封裝：載入路徑、讀 asar 內的 Web UI 與 plugin；
- `Resources/bin` 的 Meilisearch、yt-dlp、Deno 路徑與執行權限；
- 簽署後的啟動（目前是 ad-hoc 簽署）；
- `electron-builder.yml` 的打包設定，例如帶進 `.app` 的檔案與 `extraResources`。

畫面、API 與資料流的行為在開發版與打包版相同，平常用 Web 模式或開發版驗證；打包版留給上列項目、發版前的 smoke 與安裝包相關的票。

打包版不需要 checkout 的 build：用 `vault: 'none'` 經 Onboarding 建立 Vault，就只需要 `.app` 與這個 skill 的 `node_modules`（Playwright）。`vault: 'selected'` 仍需要 checkout 的 `dist/node`。

Playwright 以 `_electron.launch` 啟動打包版，靠 Electron fuses 的 `EnableNodeCliInspectArguments` 連線；打包設定沒有關閉任何 fuse，所以驗證用的就是正式的打包產物，不為驗證另做一個放寬安全設定的版本。doctor 的 `appFuses` 讀 `.app` 的 fuse wire，這個 fuse 被關閉時列為缺項，verify 無法驅動那個版本。`results.json` 的 `target.connection` 記錄連線方式（`playwright-electron`）。

打包版與使用者安裝的 App 是同一個 bundle id（`com.moneydj.xrcollector`）。產品沒有自動更新、登入項目或網址協定的註冊，profile 與 Vault 之外的路徑都由環境變數導進 run 目錄；macOS 仍會在每次啟動時把 StoreKit 的時間戳 `SKPurchaseIntentUpdatesLastChecked` 寫進 `~/Library/Preferences/<bundle id>.plist`，安裝的 App 啟動時也一樣，這是唯一允許的變動。

**打包版 smoke**：一個指令跑完，不需要互動，全部通過 exit code 為 0，任一項失敗不為 0：

```sh
npm run package:mac
node .claude/skills/verify/scripts/smoke-desktop.mjs --app "release/mac-arm64/XR Collector.app" [--evidence <dir>] [--issue <N>] [--label <name>] [--video <url>]
node .claude/skills/verify/scripts/smoke-desktop.mjs            # 同一支 smoke 跑開發版 Electron
```

流程：啟動（確認 `isPackaged`、從 `app.asar` 載入、`Resources` 在受測的 `.app` 內、profile 在 run 目錄）→ Onboarding 選擇目錄並建立知識庫 → 經畫面收集一支真實 YouTube 影片（`REAL.video`），斷言閱讀頁有字幕、知識庫有對應的 Markdown 檔，以及 Meilisearch 與 yt-dlp 從受測程式自己的 bin 啟動（打包版是 `.app/Contents/Resources/bin`，開發版是 checkout 的 `resources/bin/mac`；以取樣 App 的程序樹取得執行檔路徑）→ 重啟後文件仍在，登入項目與更新來源不變 → 結束，斷言沒有命令列含有 run 目錄的程序、slot 已釋放、7222／7175 的 listener、使用者的 Agent 連線檔（`~/Library/Application Support/XR Collector/agent-connection.json`），以及 `~/Library` 中屬於這個 bundle id 的 Preferences（時間戳除外）、Caches、HTTPStorages、Saved Application State 與 Application Support 前後相同。同一個程式另有不是 verify 啟動的 instance 在跑（例如使用者安裝的 App）時，它自己會寫入這些 `~/Library` 狀態，分不出是誰寫的，所以這幾項不比對：輸出列出略過的項目，`results.json` 的 `userAppRunning` 為 true；port listener 與 Agent 連線檔照常比對。需要網路；YouTube 限流時收集的 scenario 失敗。證據預設在 `.local/ticket-artifacts/<issue>/<packaged|development>[-N]/`（issue 預設 `verify-smoke`），`--evidence` 指定時只寫該目錄。

**受測程式的紀錄**：Desktop run 的 `results.json` 以 `target` 記錄受測的程式，開發版與打包版欄位相同：`kind`（`packaged`／`development`）、`app`（打包版的 App 路徑，開發版為 null）、`executable`、`version` 與 `arch`（程式自己回報的 `app.getVersion()` 與 `process.arch`）、`platform`、`connection`。`commit`、`sourceHash` 記錄的是執行 skill 的 checkout，打包版的版本以 `target` 為準。

## Evidence

證明的標準：

- 走使用者的路：經畫面點選與輸入。`seed`／`collect`／`subscribe` 只建立前置狀態，不當作被測功能的證明；不用內部 setter 或測試專用路由。
- 截動作與結果，不只最後畫面：對話框、進行中狀態、完成狀態各一張。需要淺深色時用 `themed(name)`。
- 驗證副作用：Vault 內的 Markdown 檔、`settings/*.json`、匯出的 zip、刪除紀錄、API 回應（`apiState`）。`results.json` 的每個 check 寫出實際觀察值。
- 合成資料只替代 production 已經隔開的外部系統（yt-dlp、網路上的 feed）。截圖與結果標示資料模式（`results.json` 的 `data`）；需要真實 YouTube 的 scenario 用 `--data real`，合成結果不能代替。
- Web 模式截圖標示為 Web 模式，不代替原生 Desktop 證據。
- 看過每張 PNG 再交付：確認不是錯誤頁、過期畫面或空白。

輸出在 `.local/ticket-artifacts/<issue>[/<label>[-N]]/` 或 `--evidence` 指定的目錄：`<scenario>-<name>.png`、`results.json`（label、受測 checkout、commit、dirty、未提交內容的雜湊 `sourceHash`、資料模式、驗證層級、Desktop run 的 `target`、每個 scenario 的 checks 與 observations、console error、API 快照）、`<run>-server.log`（runtime 的輸出，另記每個 4xx／5xx 請求的 method、path、status、錯誤碼與訊息；重啟過的 run 依序包含每一段）、`snapshot` 的 `.png`＋`.state.json`。

## Cleanup

```sh
node .claude/skills/verify/scripts/verify.mjs stop --run <runDir>          # 停止、複製 server.log、釋放 slot、刪 scratch
node .claude/skills/verify/scripts/verify.mjs stop --run <runDir> --keep   # 同上但保留 profile 與 Vault 供檢查
node .claude/skills/verify/scripts/verify.mjs sweep                        # 清 stale lock 與沒有存活程序的 scratch 目錄
```

`stop` 對 run 的程序群組送 SIGTERM，讓 runtime 正常關閉（含 Meilisearch），等到群組內沒有程序；30 秒內沒結束才送 SIGKILL。`sweep` 輸出 `removed`（已刪）、`live`（還有程序，略過）、`unreadable`（`run.json` 無法解析，略過，需手動檢查）；`doctor` 的 slot 狀態與 `launch` 用同一個判斷，`ports busy` 表示沒有 lock 但 port 被占用。流程腳本中途 crash 時，server 仍在跑：用 `doctor` 看哪個 slot 被占、拿 `runDir` 跑 `stop`。`launch` 失敗時會結束自己的 server 並釋放 slot，run 目錄留著供診斷，之後由 `sweep` 清掉。每次失敗的嘗試之後都要 stop，避免留下程序與 port。清理不刪 `.local/ticket-artifacts/`。

## 自我測試

本 skill 的 CLI 與函式庫有兩層測試：

- **單元測試**：`tests/tooling/verify-skill/`，在 `npm run verify` 與 CI 中執行。涵蓋證據資料夾、label 與 `--evidence`、doctor 對缺少前置條件的 `missing` 與 exit code（Mac）、slot lock 的持有者判斷與 `sweep`、程序辨識（含打包版的執行檔；以真實程序驗證 `stop`／`sweep` 不結束命令列提到 run 的其他程序），以及 `restart` 期間 slot lock 不被其他 session 的 `sweep` 清掉。測試用暫存的 Git checkout 與暫存的 `HOME`，不碰真正的 `~/.xr-collector/verify-slots` 與 `.local/`。
- **整合 smoke**：`npm run test:verify-skill:mac`（`scripts/smoke.mjs [--issue <N>] [--checkout <dir>]`），只在 Mac 本機執行，需要 Playwright Chromium 與 `npm run download:runtime`。Web 模式合成資料：launch → 訂閱 → `restart()` → `restart({ crash: true })` → `stop({ keep: true })` → `sweep`，斷言狀態保留、中斷的工作完成且 `lastStop` 為 `crash`、`server.log` 的重啟分隔、結束後沒有命令列含有 run 目錄的程序且 slot 已釋放，以及用到的 port 都是 verify slot、7222／7175 的 listener 前後相同。證據在 `.local/ticket-artifacts/<issue>/smoke[-N]/`（預設 issue 為 `verify-smoke`）。改 `scripts/` 時在本機跑一次。
- **Desktop smoke**：`npm run test:verify-skill:desktop:mac -- [--app <path>]`（`scripts/smoke-desktop.mjs`，見「打包版」），只在 Mac 本機執行，需要網路。改 `lib/electron.mjs`、`lib/target.mjs` 或程序辨識時，開發版與打包版各跑一次。

## 平台

- **Mac arm64**：已支援並驗證。
- **Windows**：待補。尚未處理的部分：`resources/bin/win` 與 `.exe` 路徑、開發版 Electron 與打包版的執行檔路徑（`lib/target.mjs`）、以 PID 與命令列辨識程序（`ps` 在 Windows 不可用）、程序群組結束方式、`~/.xr-collector` 路徑。Windows 驗收暫依 [開發驗證流程](../../../docs/development-validation.md) 第 5 節。
