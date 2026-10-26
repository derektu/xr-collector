# Release 發布手冊

正式 Release 只接收兩台指定本機從同一個乾淨 commit 建置並完成驗收的原產物。publisher 不建置 App、不修改 payload，也不從 CI 取用安裝包。首版使用版本 `0.1.0` 與 tag `v0.1.0`；tag 只在 #36 完成、最終候選凍結且使用者授權後建立。

## 首版工作順序

1. #35 先合併 publisher 工具、拒絕條件、fake transport 測試及本手冊。
2. #36 實作 App updater，並鎖定 client 實際讀取的 index／metadata 契約。二十二個 public asset stage 是供 #36 驗證的候選契約；首版正式契約以 #36 的 client 測試為準。
3. #36 整合完成後固定最終乾淨 commit C。Mac arm64 與 Windows x64 的 Chinese／official 四包全部從 C 在指定本機重新建置，不能把 #34 的歷史包當成首版候選。
4. 四包完成本機與安裝版驗收，再由 Mac plan／stage。所有 pending、blocked 與 clean Windows 的 deferred 狀態如實呈現。
5. 使用者另外確認公開動作後，才建立固定 tag／draft、上傳、公開 prerelease，完成匿名及瀏覽器下載驗收，最後再經授權轉 stable／Latest。

## 候選輸入

候選輸入目錄只放四份 #34 private artifact manifest，以及每份 manifest 同目錄所宣告的原產物：

```text
candidate-input/
  darwin-arm64-chinese/
    XR-Collector-0.1.0-chinese-darwin-arm64-artifacts.json
    XR-Collector-0.1.0-chinese-mac-arm64.dmg
    XR-Collector-0.1.0-chinese-mac-arm64.dmg.blockmap
    XR-Collector-0.1.0-chinese-mac-arm64.zip
    XR-Collector-0.1.0-chinese-mac-arm64.zip.blockmap
    XR-Collector-0.1.0-chinese-darwin-arm64-update.yml
  darwin-arm64-official/
    ...同平台 official 六個檔案...
  win32-x64-chinese/
    XR-Collector-0.1.0-chinese-win32-x64-artifacts.json
    XR-Collector-0.1.0-chinese-win-x64-setup.exe
    XR-Collector-0.1.0-chinese-win-x64-setup.exe.blockmap
    XR-Collector-0.1.0-chinese-win32-x64-update.yml
  win32-x64-official/
    ...同平台 official 四個檔案...
```

輸入目錄不能夾帶 README、驗收 log 或其他檔案。private manifest 與驗收證據留在本機，不上傳。驗收索引及 release notes 放在輸入目錄外。

驗收索引固定包含完整 commit、版本、四個 candidate 與 R35-01 至 R35-08 的目前狀態。每個 candidate 至少引用一份 `kind: "acceptance-summary"` 的結構化本機報告；publisher 會重算 evidence 的 SHA-256，再核對報告的完整 BuildInfo 與 private manifest。一般 log、截圖或任意已雜湊檔案可以當附加證據，但不能代替 acceptance summary。

```json
{
  "schemaVersion": 1,
  "version": "0.1.0",
  "commit": "40-character-full-commit",
  "candidates": [
    {
      "target": "darwin-arm64",
      "variant": "chinese",
      "status": "passed",
      "evidence": [
        { "kind": "acceptance-summary", "path": "evidence/mac-chinese-summary.json", "sha256": "64-character-sha256", "commit": "40-character-full-commit" }
      ]
    }
  ],
  "scenarios": {
    "R35-01": { "status": "passed", "reason": "local producer and payload checks passed" },
    "R35-02": { "status": "pending", "reason": "real GitHub draft not authorized yet" },
    "R35-03": { "status": "passed", "reason": "local metadata contract passed" },
    "R35-04": { "status": "pending", "reason": "requires a public prerelease" },
    "R35-05": { "status": "pending", "reason": "requires browser-downloaded public installers" },
    "R35-06": { "status": "passed", "reason": "installed candidate acceptance passed" },
    "R35-07": { "status": "pending", "reason": "clean Windows without VC runtime deferred by user" },
    "R35-08": { "status": "pending", "reason": "promotion has not been authorized" }
  }
}
```

acceptance summary 的 `buildInfo` 必須與該安裝包內的 BuildInfo 完全相同，包含 `buildId`。`status` 必須是 `passed`，`checks` 至少一筆且每筆明確為 `passed`；`screenshots` 可列出本機截圖路徑，但不影響成功判定。

```json
{
  "schemaVersion": 1,
  "kind": "xr-collector-release-acceptance",
  "status": "passed",
  "buildInfo": {
    "schemaVersion": 1,
    "kind": "packaged",
    "version": "0.1.0",
    "builtAt": "2026-10-26T00:00:00.000Z",
    "commit": "40-character-full-commit",
    "buildId": "build-uuid",
    "target": "darwin-arm64",
    "variant": "chinese",
    "sourceDirty": false
  },
  "checks": [
    { "id": "installed-app-smoke", "status": "passed" }
  ],
  "screenshots": ["screenshots/mac-chinese-running.png"]
}
```

`candidates` 必須有 `darwin-arm64`／`win32-x64` 與 `chinese`／`official` 的四種組合。scenario 狀態只能是 `passed`、`pending` 或 `blocked`；pending 不會被 publisher 改寫成通過。

## 本機 plan 與 stage

下列兩個階段不連 GitHub，也不修改外部狀態。`source-base-url` 必須是 HTTPS 且固定到版本 tag，不得包含帳號、密碼、query 或 fragment；不可使用 `releases/latest/download/` 作為 payload URL。`github.com` URL 在發布前還必須與 `--repo` 指定的 owner／repository 相同；符合相同 immutable URL 契約的自訂 mirror 可以使用其他 hostname。

```bash
npm run release -- plan \
  --input .local/ticket-artifacts/35/candidate-input \
  --acceptance .local/ticket-artifacts/35/acceptance.json \
  --notes .local/ticket-artifacts/35/release-notes.md \
  --version 0.1.0 \
  --tag v0.1.0 \
  --source-base-url https://github.com/derektu/xr-collector/releases/download/v0.1.0/

npm run release -- stage \
  --input .local/ticket-artifacts/35/candidate-input \
  --acceptance .local/ticket-artifacts/35/acceptance.json \
  --notes .local/ticket-artifacts/35/release-notes.md \
  --version 0.1.0 \
  --tag v0.1.0 \
  --source-base-url https://github.com/derektu/xr-collector/releases/download/v0.1.0/ \
  --output .local/ticket-artifacts/35/stage-v0.1.0
```

preflight 重算每個 artifact 的 bytes、SHA-256 及 update YAML 的 SHA-512，並從 Mac ZIP 或 Windows NSIS 實際抽出 `app.asar`、BuildInfo 及 runtime inventory。完整 commit、版本、`sourceDirty=false`、target、variant、buildId、Meilisearch producer、yt-dlp／Deno pin、主要 runtime bytes、結構化驗收結果，以及 official Windows 的 app-local CRT 必須一致。少一個組合、混用版本或 variant、額外 basename、被修改的檔案及缺少合格驗收報告都會在上傳前失敗。

stage 目錄包含原封不動的十六個 installer／ZIP／blockmap／versioned update metadata、四份 sanitized public manifest、`release-index.json` 與 `SHA256SUMS`。`.release-state.json` 是本機控制檔，不是 Release asset。publisher 每次讀取 stage 都會交叉核對控制檔、public index、四份 manifest、二十二個 asset 與 checksum inventory；控制檔不能單獨改變 commit、版本、tag、來源 URL 或 release notes。

public manifest 的 runtime identity 使用欄位白名單，只保留 Meilisearch 與 yt-dlp／Deno 的 producer identity、相對 runtime inventory，以及 app-local CRT 的檔名、版本、bytes 與 SHA-256。原始 private manifest、驗收路徑、載入中的 Windows process／module 路徑及原始簽署診斷不會進入 stage。

`release-index.json` 包含 version、tag、完整 commit、已清理的 release notes，並以 target 與 variant 映射 installer、update payload、versioned metadata 及 public manifest；#36 因而不必為了顯示版本說明再呼叫 GitHub API。#36 若日後需要 stock updater channel alias，alias 必須另行定義及測試，而且其中 payload URL 仍固定到版本 tag；#35 不預先產生 alias。

## GitHub draft 與公開狀態

所有 GitHub 修改指令只准在授權的 Mac 執行，使用該 Mac 現有的 `gh auth`。token 不寫入參數檔、stage、App 或 Windows。每次修改都要提供一份只對該 frozen candidate 生效的 authorization JSON：

```json
{
  "schemaVersion": 1,
  "version": "0.1.0",
  "tag": "v0.1.0",
  "commit": "40-character-full-commit",
  "confirmedAt": "2026-10-26T00:00:00.000Z",
  "actions": ["create-tag", "create-draft", "draft-upload"],
  "scenarios": {},
  "deferredScenarios": []
}
```

`actions` 只列本次核准的動作。publisher 不會因 plan、stage 或 verify 自動建立 tag 或 Release。

```bash
# 修改 GitHub：必要時建立固定 tag、建立 draft、可接續上傳並讀回完整比對
npm run release -- draft-upload \
  --stage .local/ticket-artifacts/35/stage-v0.1.0 \
  --repo derektu/xr-collector \
  --authorization .local/ticket-artifacts/35/authorize-draft.json

# 唯讀：以 gh auth 下載 draft 的每個 asset 並重算 hash
npm run release -- remote-verify \
  --stage .local/ticket-artifacts/35/stage-v0.1.0 \
  --repo derektu/xr-collector
```

既有 tag 必須指向同一 commit。draft 中同名且同 hash 的 asset 可接續使用；同名不同 bytes 直接拒絕，不刪除、不覆寫。遠端 inventory 不完整時不能公開。已存在的公開 Release 不由 publisher 覆寫或刪除。

prerelease authorization 的 `actions` 包含 `publish-prerelease`，且 `scenarios` 明列 R35-01、02、03、06 已通過。R35-04、05 必須在 prerelease 公開後才執行，所以不是 prerelease 的循環前置條件。R35-07 若仍 pending，authorization 必須同時明列該狀態與 `deferredScenarios: ["R35-07"]`；這是本次正式決策，不會把案例標為通過。

```bash
npm run release -- publish-prerelease \
  --stage .local/ticket-artifacts/35/stage-v0.1.0 \
  --repo derektu/xr-collector \
  --authorization .local/ticket-artifacts/35/authorize-prerelease.json

# prerelease 公開後，無 gh auth、token 或 cookie 的唯讀下載驗證
npm run release -- anonymous-verify \
  --stage .local/ticket-artifacts/35/stage-v0.1.0
```

stable promotion authorization 的 `actions` 包含 `promote-stable`；R35-04 與 R35-05 必須已通過，包含真實匿名下載、瀏覽器下載、OS 來源標記及安裝版驗收。publisher 會在狀態修改前再次核對遠端完整 inventory、下載 hash 及匿名下載，然後只修改同一 Release 的 prerelease／Latest 狀態，附件 bytes、tag 與 commit 不變。R35-08 是這個動作本身，不會循環要求尚未發生的 R35-08 結果。

```bash
npm run release -- promote-stable \
  --stage .local/ticket-artifacts/35/stage-v0.1.0 \
  --repo derektu/xr-collector \
  --authorization .local/ticket-artifacts/35/authorize-stable.json
```

mock transport 測試只證明狀態機及錯誤處理，不是 R35-02、R35-04 或 R35-05 的真實 GitHub／瀏覽器證據。R35-07 在乾淨 Windows 驗收完成或使用者於正式 authorization 明確接受 deferred 狀態前維持 pending。任何公開動作都要先由使用者另外確認；本手冊與指令本身不構成發布授權。
