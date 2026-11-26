# 記錄

記錄頁預設把同一訂閱連續且結果相同的例行檢查合併，讓文件、需要處理的失敗與系統狀態維持醒目；使用者仍能查看群組中的每次檢查及完整原始事件。

## Sub-features

- `activity-summary`：預設「摘要」、「全部」、「INFO 以上」，同訂閱連續、結果相同且沒有新增／失敗／略過的定時無新內容或網路錯誤併成一組，顯示次數與起訖，其他檢查各自一列；因訂閱暫停或移除而略過的檢查不顯示，但會切斷前後群組；新增訂閱、開始收集、文件新增與完成結果使用面向使用者的生命週期。先限定訂閱與時間，再建立分組邊界，最後篩選紀錄類型與最低等級；切換條件不改呈現模式。有記錄未能寫入時，記錄卡片的列表上方顯示 `log-warning`（「有 n 筆記錄未能寫入而遺失。」）。
- `activity-detail`：摘要列的「查看細節」限定該組，逐次展開完整事件、載入更早檢查；最低等級只篩內部事件，不改成員、總次數或已載入的檢查數。細節頁的 `group-level` 與記錄頁共用最低等級，返回後保留類型、訂閱、時間、模式，以及細節頁最後選的等級。
- `activity-raw`：「完整事件」顯示每筆原始事件，等級只有 `DEBUG`／`INFO`／`WARN`／`ERROR`；新增文件、完成收集與略過原因放在事件文字。選 DEBUG 以上才顯示已持久化的內部診斷事件。摘要與完整事件的事件列有文件時連到閱讀器，否則有訂閱時連到訂閱詳情，兩種模式都在 App 內導覽、不重新載入整頁；兩種模式都以 `load-older` 載入更早的記錄。

## How to get to it (user POV)

- 側欄「記錄」（`/activity`）預設開啟摘要。
- 訂閱詳情「收集紀錄」的合併檢查列 →「查看細節」。
- 記錄摘要列 →「查看細節」；頁首「完整事件」切換原始記錄。
- 工作限定網址 `/activity?job=<jobId>` 顯示該工作原始事件、可清除的工作篩選與「複製診斷資訊」。

## Driving it with verify

Preconditions:

- 基準狀態；訂閱合成頻道 A，完成首次收集，再讓同一訂閱發生多次定時檢查。

- **摘要。** 開啟 `nav-activity`，`activity-summary` 為按下且與 `log-type`、`log-level` 垂直置中；預設為全部與 INFO 以上。`summary-check` 的無新內容與 `network_error` 各依連續結果顯示次數。
- **篩選。** 選 `log-type`、`log-level`、`log-source`、`log-range`；中間被篩掉的不同檢查結果仍切斷前後同結果群組。重新整理、進出細節與返回保留所有條件；新增文件＋ERROR 顯示空狀態且不改模式。
- **細節。** `summary-check` 的「查看細節」→ `activity-group-context`；`activity-group-check` 初始最多 10 次，頁首顯示已載入與總次數，每列可展開原始事件。按「載入更早的檢查」每次再載入最多 10 次，全部載入後列數才等於摘要次數。切換 `group-level` 保留已載入次數。按「返回」後訂閱與時間篩選仍在；等級是細節頁最後選的值，細節頁沒改等級時即為原本等級。
- **完整事件。** 按 `activity-raw`，預設 INFO 以上不顯示 DEBUG；切 DEBUG 以上可看到先前已記錄的內部事件。`log-row` 等級只出現 `DEBUG`／`INFO`／`WARN`／`ERROR`。
- **工作限定。** 開啟本 instance 已知工作 ID 的 `/activity?job=…`，`log-job-filter` 出現且使用完整事件模式；`copy-diagnostics` 複製工作與事件診斷，按「清除工作篩選」回一般記錄。Web 若攔截 `clipboard.writeText`，只證明交付文字，不能當作真 OS 剪貼簿通過。
- **訂閱詳情。** `/sources/<type>/<id>` 的 `collection-check-group` 顯示結果、次數與時間範圍；點「查看細節」進相同群組，返回訂閱詳情。

## Gotchas

- 摘要有變動就重讀第一頁；已載入的更早頁面中比新第一頁最後一列更早的列留著，「載入更早的記錄」沿用它們的游標。翻頁期間新的定時檢查併入某組時，那組可能少列或多列一次。細節的成員分頁固定在開啟時的群組。
- 細節連結以群組內的工作 ID 組成，服務重啟後照樣開得到；群組的檢查超過 30 天保留期後，細節明說已超過保留期限。
- 「新增文件」可在摘要或完整事件中使用，不會自動切換呈現模式。

## Regression flows

- `check-history-summary`：斷言 `activity-summary`、`activity-detail`、`activity-raw`。五次定時檢查（無新內容兩次、網路錯誤兩次、恢復一次）後，摘要 API 的分組與訂閱詳情、記錄頁摘要以結果與次數比對；群組細節只列這組的檢查、返回保留等級、完整事件預設 INFO 以上與 DEBUG、重新整理保留全部篩選；以網址開啟一個工作的記錄、複製診斷資訊並清除工作篩選（Web 攔截 clipboard payload，不驗真 OS 剪貼簿）。分組規則在 tests/domain/activity/activity-views.test.ts 與 tests/domain/jobs/job-manager.activity.test.ts，細節分頁的先後在 tests/transport/web/activity/activity-group-pages.test.ts。

## Backlog

- `activity-detail`：來源與時間條件有實際資料時的篩選、四個條件往返、逐次展開與收合。
- `activity-summary`：已載入更早頁面時刷新保留舊列、細節超過保留期的畫面；分組與保存規則已有 `tests/domain/activity/`，刷新合併在 tests/transport/web/activity/activity-presentation.test.ts。
