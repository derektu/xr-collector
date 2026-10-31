# Release 發布手冊

這份手冊是發布者的檢查清單：一個版本從定版到公開，要依序完成哪些事、各平台的檔案由誰上傳、出錯時怎麼處理。打包與上傳的指令、`release:upload` 的檢查項目、Windows VM 的建置方式與 Mac 憑證的需求，見 [建置、測試與發布的發布一節](building.md#發布)。

## 角色

- **發布者**：決定版本號與發布的 commit、寫版本說明、在兩個平台都上傳後公開 Release。
- **平台建置者**：在自己的建置機打包一個平台並上傳。Mac 建置者需要 Developer ID 憑證；Windows 建置者可以用 x64 Windows，或 ARM64 Windows 上模擬的 x64 Node。同一個人可以同時擔任兩個平台的建置者。

每位上傳者的 GitHub 帳號要能寫入發布的 repository，並在上傳的機器完成 `gh auth login`。

## 發布步驟

1. **定版**：在 main 上把 `package.json` 的 `version` 改成要發布的版本，以 PR merge。merge 後的 commit 就是這一版的 commit，記下它的完整 SHA。
2. **驗收候選**：兩個平台以這個 commit 的 ad-hoc／未簽署包完成安裝與更新驗收（[開發驗證流程](development-validation.md#6-平台打包)）。驗收中需要修改程式時回到第 1 步，以新的 commit 重來。
3. **各平台打包並上傳**：兩位建置者各自 checkout 這個 commit，打包正式版並執行 `npm run release:upload -- v<版本>`。先上傳的人會建立 tag 與 draft，後上傳的人加入同一個 draft。Mac 正式版以 Developer ID 簽章與公證。
4. **確認 draft**：`gh release view v<版本> --repo <repository> --json isDraft,assets` 列出兩份 release index（`release-darwin-arm64.json`、`release-win32-x64.json`）與兩個平台的安裝檔。
5. **公開**：寫好版本說明，以 `gh release edit v<版本> --repo <repository> --draft=false --latest --notes-file <版本說明.md>` 公開。
6. **公開後檢查**：在沒有登入 GitHub 的瀏覽器下載兩個平台的安裝檔並安裝；以前一版的 App 檢查更新，確認看到這一版、下載並完成安裝。公開後一分鐘內的檢查可能還是舊結果（GitHub 的快取），稍後再檢查。

draft 只對有 repository 寫入權限的人可見，App 與一般使用者看不到；公開之前，draft 裡的檔案可以補傳或移除。

## 出錯時

| 狀況 | 處理 |
| --- | --- |
| `release:upload` 說 checkout 有未 commit 的修改，或 HEAD 不是建置的 commit | checkout 發布的 commit，清掉修改與未追蹤的檔案，重新打包再上傳。 |
| GitHub 沒有這個 commit | 先把 commit push 到發布的 repository。 |
| tag 已存在但指向別的 commit | 確認發布的 commit。tag 指錯而 Release 還沒公開時，發布者以 `gh release delete v<版本> --repo <repository> --cleanup-tag` 刪除 draft 與 tag，再重新上傳。 |
| 檔案與 release index 不符 | `release/` 裡的檔案在打包後被改過或混入其他建置；重新打包。 |
| draft 已有同名但內容不同的檔案 | 另一次建置先上傳了。確認要保留哪一份；要換成這次的建置時，執行訊息中的 `gh release delete-asset`，再重跑上傳。兩個平台的 index 各自記錄自己的 commit，所以換檔時兩個平台都要來自同一個 commit。 |
| 同一個 tag 有兩個 draft | 兩台機器同時建立了 draft。在 GitHub 刪掉沒有檔案或較少檔案的那個，再重跑上傳。 |
| 上傳後下載核對不符 | 傳輸出錯。以 `gh release delete-asset` 移除那個檔案後重跑。 |
| Release 已公開才發現問題 | 已公開的 Release 不再改檔案。修正後發布下一個版本；必要時以 `gh release edit --prerelease` 先讓 App 不再把這一版當成最新的穩定版。 |

## 預演

正式發布前可以在測試 repository `derektu/xr-collector-test` 走一次完整流程。預演的安裝包要內建測試 repository 的更新來源，並使用與正式版不同的 App 身分，打包方式見 [更新來源](update-source.md) 的驗收身分。`release:upload` 依安裝包內建的 repository 上傳，所以預演包只會進到測試 repository。預演前把發布的 commit push 到測試 repository。
