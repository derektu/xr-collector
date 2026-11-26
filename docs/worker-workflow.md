# 做一張票

一個 session 一次做一張票，從談設計到進 main 自己走完。決定做什麼、排順序、做設計決定、驗收的是使用者。每張票從乾淨的 context 開始，所以流程寫在這裡，不靠記憶。

## 開工前讀

- [AGENTS.md](../AGENTS.md)：適用每張票的專案規則
- [開發驗證流程](development-validation.md)：驗收計畫、回歸流程、審查與交付
- [專案驗證設定](project-validation.md)：本專案的指令、驗證層級、平台與門檻
- [verify skill](../.claude/skills/verify/SKILL.md)：啟動隔離的 instance、跑流程、留證據
- 票面：這張票要做到的事
- 有改畫面時，票面附的設計稿：開工前跟使用者確認方向用；開始實作後以 App 的畫面為準，不回頭更新設計稿

## 一、談設計

動手之前，先跟使用者把這張票要做成什麼樣子談清楚。

票面寫的是方向與驗收計畫的草稿。看完票面和現有的程式之後，把要定的事問出來：API 的形狀、畫面怎麼排、module 的邊界放在哪裡、驗收計畫漏了哪些風險。一次問幾個關鍵的就好，不要把所有可能性都列出來請使用者挑。自己有看法就直接講，連同理由，讓使用者否決得掉；只丟選項，等於把判斷推回給使用者。

module 的方向見 [開發驗證流程第 5 節](development-validation.md#5-審查與交付) 的「module 的深度」。真的需要新的 module 時，先說它的介面、藏住什麼、誰依賴它。

新增檔案時說明放在哪個目錄；不符合[程式規範的目錄規則](code-guidelines.md#模組與依賴)時，先向使用者提出重新分組，再動手。

驗收計畫經使用者確認後寫回票面。

## 二、工作目錄與 branch

每個 session 的工作目錄由使用者開 session 時決定，可能是 worktree，也可能是主 checkout。做票就在這個目錄開 ticket branch，不另建 worktree、不換目錄（diff 窗格只看得到這裡）。同一個 session 的每張票都在同一個目錄做，`node_modules`、下載的 runtime 與 verify 的證據會跨票留著。沒有 `node_modules` 或票改了 `package-lock.json` 時跑 `npm ci`，第一次跑 verify 前跑 `npm run download:runtime`。這個目錄不要改名、不要搬。

沒有票的時候，worktree detached 在 `origin/main`，主 checkout 停在 `main`；工具剛建好的 worktree 可能停在工具開的 branch 上，不在上面做事。開工時自己開 branch：

```sh
git fetch origin && git checkout -b ticket/<票號>-<短名> origin/main
```

改動一律在 branch 上做。detached HEAD 上的改動在 diff 窗格看不到，使用者就看不到這張票做了什麼。

## 三、實作

dev subagent 實作，review subagent 依 [開發驗證流程第 5 節](development-validation.md#5-審查與交付) 獨立審。

review 讀程式，不重跑 `npm run verify` 和回歸流程：dev 交回前已經跑過，同一份程式重跑結果相同。讀到可疑的地方要實際確認時，只跑能證明那一點的測試。review 要求修改時，修完照第四節再跑一次，才去找使用者。

實作途中冒出來的設計問題，問完就在同一個 branch 上補完，不要留成下一張票。問題會影響其他票（共用的 API、規格、verify skill）時，先講再動。討論或審查中冒出的問題，預設在本票處理；要另開票或另外動手之前，先問使用者。

subagent 或 skill 交回的改動，自己對過 diff 再往下走。

## 四、測試

開發中每改完一處，只跑跟這次改動有關的測試與流程。

找使用者之前和 commit 之前，跑 `npm run verify` 與驗收計畫列出的全部 verify 流程。交回或找使用者之前，確認這次啟動的程序都已結束、沒有殘留。

## 五、停下來交給使用者

做完把改動留在 branch 上，先不 commit。新增的檔案以 `git add -N` 標記，diff 窗格才看得到；這不算 commit。

有改畫面或操作流程時，在 worktree 起這張票的 dev instance，只給網址，不開瀏覽器，也不開任何視窗：

```sh
node scripts/dev.mjs start    # build、從 dev slot 池取 port、在背景啟動，印出網址與 PID
node scripts/dev.mjs status   # 網址、PID、是否還在跑
node scripts/dev.mjs stop
```

- port 與 slot 的規則見 [建置說明](building.md#執行)。改完程式再 `start` 一次就是重新 build、重啟。
- Vault 是使用者實際在用的 `~/Downloads/XRData`，每張票都接同一個；profile 用 worktree 的 `.data`。
- 這張票改了 Vault 的格式時，先告訴使用者改了什麼，再給網址。
- 只有網頁證明不了的行為才開 App（`npm run electron`，使用者平常的資料）。開 App 會跳出視窗，先取得使用者同意。

然後連同網址與 PID 回報：

- 照票面的項目逐項講：這一項做了、做成什麼樣，或是沒做、為什麼。
- 哪些是自己下的判斷，理由是什麼，讓使用者否決得掉
- 自己跑過哪些驗證與結果，以及 [開發驗證流程第 5 節](development-validation.md#5-審查與交付) 的交付內容。這時還沒 commit，交付內容列的是受測的未提交內容；CI 結果在第七節補上。
- **動了哪些共用的檔案**：`docs/` 的規格、`AGENTS.md`、verify skill、`skills/xr-collector-agent/`、前後端共用的 API 型別，讓使用者看出會不會跟其他票衝突。
- **這次留下的 seam**：哪些介面是刻意留著、之後可以從這裡替換或延伸的；每個 seam 背後藏住什麼、目前有誰依賴它。新開或加寬了 module 的介面時，說明為什麼不放進既有的 module。
- 哪些行為沒有自動化涵蓋
- 還有哪些開放問題

## 六、驗收時的修改

使用者在畫面上看到要改的地方，由這個 session 直接改，不經過 dev 與 review subagent。驗收的修改通常很小，轉手的成本比修改本身大。

- 改完只跑受影響的測試與流程。
- 再找使用者之前，照第四節跑一次，重拍截圖，再 `node scripts/dev.mjs start` 一次。
- 修改碰到 API 契約、資料格式、共用規格或 module 的介面時，改完當下送 review subagent 審這次的改動。
- 回報只講改了什麼、跑了哪些驗證、哪些是自己下的判斷，不必照第五節的完整格式。

修改大到像新的實作（新的畫面、新的 API）時，回到第三節。

## 七、使用者說沒問題之後

使用者測過說沒問題，或說 commit，這個 session 就一次做完，不另外詢問：

1. rebase 到最新的 main，跑 `npm run verify` 與全部回歸流程（[專案驗證設定的 merge 門檻](project-validation.md#門檻)；只改 Markdown 時不跑）。
2. 驗收期間直接改、還沒經過 review 的改動，送 review subagent 審一次，審完、修完才 commit。進 main 的程式都經過 review。
3. commit、push、開 PR（帶 `Closes #<票號>`），等 CI 通過後 rebase merge。commit 訊息和 PR 描述寫系統現在的樣子。
4. 用 `node scripts/dev.mjs stop` 停掉這張票的 dev instance（開過 App 就關掉 App），把 worktree 的 `.local/ticket-artifacts/<issue>/` 複製到主 checkout 的同一路徑（不覆寫已有的檔案）。主 checkout 是 `git worktree list` 的第一行。
5. 回到最新的 main：worktree 用 `git fetch origin && git checkout --detach origin/main`，主 checkout 用 `git checkout main && git pull --ff-only`。再刪除本機與遠端的 ticket branch（checkout 中的 branch 刪不掉，所以先離開它）。
6. 在 issue 寫上驗收結果，看板移到 Done。

只有 CI 或回歸流程失敗、rebase 衝突解不掉時，才停下來回報。下一張票從這份文件重新開始。
