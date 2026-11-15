# 實作一張票的流程

這個專案由一個規劃 session 和若干個實作 session（worker）分工：規劃 session 決定做什麼、寫規格、開票、派工、驗收與回報；worker session 一次做一張票。

每張票從乾淨的 context 開始，所以流程不靠記憶，寫在這裡。worker 開工時讀 [AGENTS.md](../AGENTS.md) 與這份文件，再讀派工說明與票面。

## 開工前讀

- [AGENTS.md](../AGENTS.md)：適用每張票的專案規則
- [開發驗證流程](development-validation.md)：驗收計畫、回歸流程、審查與交付
- [專案驗證設定](project-validation.md)：本專案的指令、驗證層級、平台與門檻
- [verify skill](../.claude/skills/verify/SKILL.md)：啟動隔離的 instance、跑流程、留證據
- 票面與派工說明：票面是這張票要做到的事，派工說明是規劃 session 補充的判斷與界線

## 工作目錄與 branch

每個 worker 有一個固定的工作目錄，名字就是它自己：`.claude/worktrees/xr-work-01`（02、03 同理）。每張票都在同一個目錄裡做，`node_modules`、下載的 runtime 與 verify 的證據跨票留著，不必每張票重建一次。

待命狀態是 detached 在 `origin/main`：手上沒有票，也沒有自己的 branch。

ticket branch 由規劃 session 從 `origin/main` 開好並推上 origin，不論這張票有沒有規格改動——沒有改動時它就是一支空的 branch。detached HEAD 上的改動在 diff 窗格看不到，所以一律在 branch 上做。派工說明給 branch 名，開工第一件事是：

```sh
git fetch origin && git checkout <branch>
```

branch 上如果有 commit，那是這張票的規格或設計改動，動手前先看。

同一支 branch 只能 checkout 在一個 worktree。規劃 session 推完之後 detach 回 `origin/main` 把 branch 讓出來，worker 才 checkout 得到。

主 checkout 追蹤 main、不放未提交的修改，worker 不在主 checkout 改東西。

## 派工

派工說明給 branch 名、設計稿網址（有改畫面時）與這張票的界線。

訊息送到不等於開工：worker 可能在別的對話裡讀到它、回完就結束那一輪。派工之後確認他真的動了，必要時把話講白。

## 驗收計畫

驗收計畫由規劃 session 擬在票面、經使用者確認後才派工。worker 開工時發現計畫漏了風險或層級不對，先回報規劃 session，不自己改計畫。

## 實作

dev subagent 實作，review subagent 依 [開發驗證流程第 5 節](development-validation.md#5-審查與交付) 獨立審。review 只拿 diff、票面與 repo，不拿 dev 的說法。

動手前對 API 形狀、UI 結構或規格有疑問，先問規劃 session。這類決定會影響其他票，不在一張票裡自己定。

## 不 commit、不開 PR

做完把改動留在 worktree 裡，由使用者在 diff 窗格 review、規劃 session 驗收後決定何時 commit。新增的檔案以 `git add -N` 標記，diff 窗格才看得到；這不算 commit。

票面的 checkbox 由驗收者勾。沒做到的項目在回報裡說明，不要自己勾。

## 測試

`npm run verify` 與驗收計畫列出的 verify 流程都要自己跑過再回報。跑 verify 用隔離的 instance，不碰使用者正在用的 App。

會跳出視窗的驗證先經規劃 session 取得使用者同意，集中一次跑完。

## 回報

做完回報規劃 session，內容包含：

- 做了什麼，哪些判斷是自己下的
- 自己跑過哪些驗證與結果，以及 [開發驗證流程第 5 節](development-validation.md#5-審查與交付) 的交付內容
- 哪些行為沒有自動化涵蓋
- 還有哪些開放問題
- 給使用者操作的 build：在 worktree 打包並開啟這張票的 App，以 `ps` 確認只有一個 XR Collector 在跑，回報執行路徑、PID 與 build 時間

證據放在 worktree 的 `.local/ticket-artifacts/<issue>/`。

## 驗收之後

使用者 review diff、操作過 build 並說 commit 之後，規劃 session 一次做完：

1. rebase 到最新的 main，跑 `npm run verify` 與全部回歸流程（[專案驗證設定的 merge 門檻](project-validation.md#門檻)；只改 Markdown 時不跑）
2. commit、push、開 PR，等 CI 通過後 rebase merge
3. 關掉這張票的 App，把 worktree 的 `.local/ticket-artifacts/<issue>/` 複製到主 checkout 的同一路徑（不覆寫已有的檔案）
4. 刪除本機與遠端的 ticket branch，issue 寫上驗收結果，看板移到 Done

只有 CI 或回歸流程失敗、rebase 衝突解不掉時才停下來回報。merge 之後，規劃 session 請 worker 刪掉 ticket branch、detach 回 `origin/main` 待命。下一張票從這份文件重新開始。
