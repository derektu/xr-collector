# 簽署設定

本目錄放簽署設定的範例，說明 `keys/` 該放哪些檔案、怎麼填。實際的憑證、私鑰與密碼放在 Git 忽略的 `keys/`，平台各自一個目錄：

```text
keys/
  mac/
    .env                         ← 由 mac-signing.env.example 複製
    DeveloperIDApplication.p12
    AuthKey_<KeyID>.p8
  windows/
    .env                         ← 由 windows-signing.env.example 複製
    company-code-signing.pfx
```

目錄設為 `700`、秘密檔案設為 `600`；Mac 打包會拒絕其他人可讀的 `.env`、`.p12`、`.p8`。憑證、私鑰與密碼的備份交由公司秘密儲存庫管理；複製、同步或提供專案給別人時排除 `keys/`。

## Mac

範例：[mac-signing.env.example](mac-signing.env.example)。

- `CSC_LINK` 指向含私鑰的 **Developer ID Application** 憑證；Apple Development／Apple Distribution 憑證不能用於對外發佈的 DMG／ZIP。
- `APPLE_API_KEY` 是 App Store Connect API 的 `.p8` 私鑰，用於公證。
- 檔案路徑相對於 `keys/mac/`。Key ID、Issuer ID、Team ID 不是秘密，可以留在範例；密碼只放 `keys/mac/.env`。`.env` 是資料檔，不當 shell 腳本執行。

`npm run doctor:build` 會檢查 `keys/mac/.env` 的欄位與檔案權限；沒有這個檔案時只能建 ad-hoc 包。準備好之後的打包與上傳指令見 [建置說明的發布](../docs/building.md#上傳一個平台)。

## Windows

範例：[windows-signing.env.example](windows-signing.env.example)。`WIN_CSC_LINK` 與 `WIN_CSC_KEY_PASSWORD` 對應可匯出的 PFX／P12；使用 USB Token、HSM 或代簽服務時這兩欄留空。

Windows 打包目前不讀這份設定，產出未簽章的安裝檔。
