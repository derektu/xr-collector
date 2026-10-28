# 台灣／繁體中文詞庫的近期來源（2026-10-27 查核）

## 結論與候選順序

有持續維護、可以下載的台灣詞庫，不必逐字替「觀光」補字典。這批資料不是可原樣替換 jieba 主詞庫的標準成品，主要差異是詞頻語義、授權、斷詞粒度及接入位置。

最值得進入受控實驗的台灣來源：

1. **McBopomofo：可實驗，優先。** 約 16.2 萬筆 occurrence 詞條，2026-10 有實質科技新詞、2026-08 有財經新詞；既有生成程式有處理零次數。詞庫新不等於語料統計新，occ 也不能未經處理當 jieba frequency。
2. **國教院 COCT 通用詞頻表：技術上可實驗，資料產品再散布授權待確認。** 官方 2025-12-08 定稿檔，16.37 萬詞，分書面、口語、新聞的實際詞頻。相較輸入法權重，它更接近要找的 corpus frequency，但仍要確認語料統計期間及詞界標準。
3. **vChewing 自行維護的繁體詞池：可作新詞補充實驗；完整合併詞庫待確認。** 2026-10 真正增刪詞，自有詞池只有約 6,600 行，不能單獨冒充完整通用主庫；完整庫混入 MOE CC BY-ND 等來源，不可僅用根目錄 MulanPSL-2.0 授權概括。

另外以 **RIME essay** 作仍持續修訂的繁體通用對照（非台灣專屬）；以 **libchewing-data** 作授權標示清楚但新詞覆蓋較弱的台灣基線。舊 jieba big／jieba-tw 的調查另見 `/tmp/xr162-traditional-lexicons.md`。

本報告只調查資料；未修改產品、引擎或既有研究文件。

## 固定版本與本機資料

GitHub 來源均記錄固定 commit，不能拿 repo 今日活動代替詞檔更新。下表的最後變動均檢查實際 patch，不只是格式／排序。

| 來源 | 固定快照 | 實質詞檔更新證據 | 本機檔、規模 |
| --- | --- | --- | --- |
| McBopomofo | `18e2060dd5d0b511753ad79a8fe0d112e944f1af` | 2026-10-11 `ccd2cd7892c93301b23e5f5ffe8945f0a3765088`，CS/電信/數學詞，phrase.occ +63/-1；2026-08-28 `a35e38c6230ccfdf40a2d46873d796b062eda2ec`，財經詞 +57/-0 | `/tmp/xr162-modern-lexicons/mcbopomofo/Source__Data__phrase.occ`：161,868 行、1,768,999 bytes；BPMFMappings：145,665 行、5,021,685 bytes |
| COCT | 官方無 git 版；檔名 `通用詞頻表 - 定稿1141208.xlsx`，HTTP Last-Modified `Mon, 08 Dec 2025 00:24:59 GMT` | 這是檔案版本／發布時間；**未確認語料蒐集與統計截止日期**，無歷史 diff 可證詞條增刪 | `/tmp/xr162-modern-lexicons/naer-common-frequency-1141208.xlsx`：17,303,267 bytes；單工作表 163,702 列（1 標頭 + 163,701 詞）、12 欄 |
| vChewing VanguardLexicon | `cfc4e3496aeac8c49ac04f05706a25cd02c82156` | 自有詞池 2026-10-21 `2882bcf7fcda3d880cca739cfebe82d951ff11bb` 真正加入「麻枝准」「錄入」；2026-10-22 `1da8f73c07b8bc23c1828a397e37ba58c0604e6e` 刪錯詞「醃肚鮮」 | `/tmp/xr162-modern-lexicons/vanguard/`；cht 自有檔 6,595 行／267,830 bytes，tabe 檔 62,389 行／2,143,818 bytes，moe 檔 160,282 行／6,003,459 bytes |
| RIME essay | `054920de4f54c9e5994276a96a4fc2a35cb51aa3` | 2026-09-23 刪誤詞「牛驥同皂」，另有數次 OpenCC 詞形校正；2026-01-05 `816b9eeab0f012e896d6c8d4f9b19f1524574378` 加「復盤」537、把「覆盤」537 降為 0 | `/tmp/xr162-modern-lexicons/rime/essay.txt`：442,688 行／5,887,319 bytes |
| libchewing-data | `c44e81aef24b06f1509f19e1be54c99812d0c43f` | tsi.csv 最後實質改動 2025-11-17 `341c60d575382dbadc5ce958d1a3dd0f32820f43` 刪錯詞「沈重」；2025-08-31 `ca101e800442c2b49788cdb0e8fc34831acff4d3` 加外送／外送員／截圖等 | `/tmp/xr162-modern-lexicons/chewing/dict__chewing__tsi.csv`：160,462 行／5,244,487 bytes |

原始來源：[McBopomofo 固定資料目錄](https://github.com/openvanilla/McBopomofo/tree/18e2060dd5d0b511753ad79a8fe0d112e944f1af/Source/Data)、[科技詞 commit](https://github.com/openvanilla/McBopomofo/commit/ccd2cd7892c93301b23e5f5ffe8945f0a3765088)、[財經詞 commit](https://github.com/openvanilla/McBopomofo/commit/a35e38c6230ccfdf40a2d46873d796b062eda2ec)、[國教院官方下載入口](https://coct.naer.edu.tw/page.jsp?ID=41)、[Vanguard 固定來源](https://github.com/vChewing/vChewing-VanguardLexicon/tree/cfc4e3496aeac8c49ac04f05706a25cd02c82156)、[RIME 固定詞表](https://github.com/rime/rime-essay/blob/054920de4f54c9e5994276a96a4fc2a35cb51aa3/essay.txt)、[libchewing 固定資料](https://github.com/chewing/libchewing-data/blob/c44e81aef24b06f1509f19e1be54c99812d0c43f/dict/chewing/tsi.csv)。

## 實際詞頭覆蓋

只檢查完整詞頭，不把子字串命中當收詞；數值是各來源原有數值，**不同來源不可直接相比**。空白表示沒有該精確詞頭，不代表文本不能合理切為數詞。

| 精確詞頭 | McBopomofo occ | COCT 書面/口語/新聞 raw count | RIME essay weight | libchewing priority |
| --- | ---: | --- | ---: | ---: |
| 觀光 | 3693 | 4449 / 1057 / 64748 | 1476 | 5454 |
| 資安 | 24 | 28 / 1 / 2177 | 無 | 無 |
| 拆股 | 無 | 無 | 33 | 無 |
| 半導體 | 297 | 2276 / 56 / 6733 | 3131 | 6960 |
| 台積電 | 102 | 149 / 41 / 2190 | 無；有「臺積電」859 | 無 |
| 伺服器 | 174 | 531 / 19 / 1076 | 643 | 100 |
| 軟體 | 2126 | 7753 / 320 / 12741 | 870 | 108454 |
| 生成式 | 無 | 無 | 136 | 無 |
| 人工智慧 | 20 | 無 | 408 | 1132 |
| 觀光產業 | 無 | 無 | 未另查 | 未另查 |

McBopomofo 原檔實際行：L130112 `觀光 3693`、L135041 `資安 24`、L26427 `半導體 297`、L29960 `台積電 102`、L12782 `伺服器 174`、L138005 `軟體 2126`。對應讀音在 BPMFMappings.txt 也存在；詞頻不等於無讀音的殘留詞。

COCT 工作表對應行：觀光 994、資安 18859、半導體 6423、台積電 16180、伺服器 22020、軟體 3092。12 欄為綜合序位、詞、書面語詞頻/PMW/序位、口語詞頻/PMW/序位、新聞詞頻/PMW/序位、平均 PMW。它有真正分語域 count，不能把綜合序位誤當詞頻。

Vanguard 不是單一資料集；五詞分散在不同來源：`phrases-tabe-cht.txt` L10561 台積電10831、L49318 資安2331；`phrases-moe-cht.txt` L21006 半導體26655、L52725 拆股8、L159798 觀光272528。不能將這些覆蓋歸給只有 6,595 行的自有詞池。

## McBopomofo 的頻率與零值：已有生成規則，但不是 corpus frequency 成品

[資料 README](https://github.com/openvanilla/McBopomofo/blob/18e2060dd5d0b511753ad79a8fe0d112e944f1af/Source/Data/README.md) 記錄 BPMFMappings 多字詞最初來自 libtabe `tsi.src`（BSD），之後自行修訂。phrase.occ 是 occurrence 資料，但目前 54,488 行為 0；2026 新增科技／財經詞多以 0 加入。因此「最新詞庫」與「最新語料詞頻」須分開。

[frequency_builder.py](https://github.com/openvanilla/McBopomofo/blob/18e2060dd5d0b511753ad79a8fe0d112e944f1af/Source/Data/curation/builders/frequency_builder.py) 有既定程序：

1. 讀 phrase.occ 和 exclusion.txt。
2. 將 exclusion 指定的長詞出現數，自相關短詞數值扣除。
3. 用 `2.7 ** (詞長 - 1)` 增加長詞權重，計算 norm。
4. 輸出 `log10(2.7 ** (詞長 - 1) * effective_count / norm)`；count < 1 時 effective_count 明確採 **0.5**。

因此不必自行臆造「新詞 freq=1」；可把上游已定義的 score 作候選。不過負的 log10 輸入法 score 不能直接餵 jieba 的非負整數 frequency；若轉回權重或整數化，轉換尺度、零值、詞長獎勵要固定並以切詞測試驗證。也不宜同時給 score 長詞獎勵和其他長詞優先規則而未測過分合詞。

`textpool.rc` 的現行 corpus_path 是 `~/textpool.11262021`，不能聲稱 2026 新字已得到 2026 語料重計頻率。固定 tree 沒有正式生成的 production `data.txt`，只有 template；PhraseFreq.txt 是 builder 產物。自有 curation 可以沿用，但不要把字典新 commit 等同新語料模型。

## 授權：按資料本身判斷

| 資料 | 一手授權證據與限制 | 判定 |
| --- | --- | --- |
| McBopomofo | 根目錄 [MIT LICENSE](https://github.com/openvanilla/McBopomofo/blob/18e2060dd5d0b511753ad79a8fe0d112e944f1af/LICENSE.txt)；Data README 明確交代 mappings 來自 BSD libtabe。phrase.occ 沒另列資料授權例外，隨專案發佈；但 raw corpus 路徑不是其外部語料全部權利已清查的證明。 | 可實驗；打包衍生詞檔時保留 MIT 與 libtabe BSD notice，記錄來源。不能宣稱 MIT 自動涵蓋外部原始語料。 |
| libchewing-data | **tsi.csv 檔頭自己**宣告 `dc:rights Copyright (c) 2025 libchewing Core Team`、`dc:license LGPL-2.1-or-later`、`dc:identifier 2025.11.17`。這是資料授權，非只借程式庫 license。 | 可實驗；產品交付需照資料 LGPL 條件保留來源／提供相關衍生資料。 |
| RIME essay | 獨立資料 repo，README 為預設詞彙表與語言模型，[LICENSE LGPL-3.0](https://github.com/rime/rime-essay/blob/054920de4f54c9e5994276a96a4fc2a35cb51aa3/LICENSE)。不是聲稱引用 rime 引擎 code license。 | 可實驗；須遵循資料 LGPL 條件。 |
| Vanguard | [固定 README](https://github.com/vChewing/vChewing-VanguardLexicon/blob/cfc4e3496aeac8c49ac04f05706a25cd02c82156/README.MD) 與 [LICENSE](https://github.com/vChewing/vChewing-VanguardLexicon/blob/cfc4e3496aeac8c49ac04f05706a25cd02c82156/LICENSE.txt)：自維護 MulanPSL-2.0；來源包括 MOE重編2015 CC BY-ND3.0、CNS政府開放資料條款、libtabe BSD、Singapore資料。數值來自國教院後轉換／手調；README 明說不是沿用 libtabe 的中研院頻率。 | 自有詞池可候選；完整混合庫重製／轉換／再散布授權待確認。不要誤用搜尋引擎快取舊 BSD README 代替固定版。 |
| COCT | 官方下載頁與 xlsx 可公開取得；頁尾 all rights reserved，查核未找到**這份詞頻表**明確標示開放資料授權／產品再散布條款。沒有因為政府網站就自行認定 OGD。 | 技術候選，授權待確認。官方入口頁有聯繫我們與意見回饋，可向國教院詢問詞表轉換／隨產品散布的授權及語料年份。 |

本節是可用性查核，不替使用者作法律結論。缺授權證據與資料品質不足是不同限制。

## 跟 jieba／Meilisearch 的接法差異

- **替換主詞庫**：把完整詞表轉為 jieba `word integer_frequency [pos]`。jieba-rs `with_dict` 可從空庫載入，`load_dict` 是合併／覆寫，不等於替換。McBopomofo score 需明確轉換；COCT 可從指定語域 count 或固定混合方案取頻率；RIME／chewing 的 weight/priority 不是已驗證的 corpus count。注音欄僅保留為來源證據，不是 jieba 詞性欄。
- **Meili dictionary API**：輸入是詞字串集合，沒有 frequency／注音／POS。可抽取詞形，但這在 Charabia 是自訂片段詞典，不是替換靜態 `Jieba::new()` 的主庫；整包灌入數十萬詞是另一個行為與效能實驗。
- **引擎接入**：目前需受控 prototype／Charabia build seam 才能真正比較主庫替換；不要因 jieba-rs 能讀就說 Meili 有運行時換庫 API。
- **長詞仍可能被拆**：host 已查固定 Charabia 版本，在 Jieba 後對長詞還有二／三字重切。評估必須分開看 jieba 原輸出、Charabia 最終 token、索引／查詢行為；來源詞頭有「半導體」「台積電」不能證明最終完整 token 一定保留。
- **詞形一致**：所有候選先用 #162 相同 NFKC、簡轉繁（不做地區用詞替換）與已核定異體處理。合併後的同詞碰撞／頻率加總或取值需明訂；不能只看原表是否台／臺字一致。

## 建議實驗（研究階段）

1. 保留固定檔、SHA256、來源授權、詞頭數、零值數及轉換 script。A=current、B=McBopomofo（照上游平滑）、C=COCT（授權釐清前不打包），RIME essay 作繁體對照；Vanguard 自有池只作增量候選。
2. 用相同文本分三層記錄 Jieba→Charabia→Meili 命中：包含上述常用／科技／財經詞，另加有歧義句與正負文件。測「觀光」不得命中只有分散「觀」「光」的文件；「觀光產業」可為「觀光／產業」，不預設必須整句一詞。
3. 不能只量 exact term 覆蓋。另人工標記固定台灣一般／科技／財經語句的切詞 boundary；看錯切、錯合、precision/recall、文件誤命中、延遲、索引時間／大小。以真實財經字幕加入縮寫、新公司、新產品，驗證頻率方案是否因 IME 長詞偏好過度黏合。
4. 若只差新詞，測主庫+少量通用新詞增量與完整換庫；不要把公司別名／wiki專詞需求重新混進 #162 正規化 scope。

## 下載完整性

- McBopomofo phrase.occ SHA256 `f3b52d572233ea2c0f2eac1872adfa2fbe2491d8ad051f875863217707561a0e`
- libchewing tsi.csv SHA256 `c889a1ac3ae1901b3f8f62748bc41b958f010bf995f7f88dbaf9e3494f341428`
- RIME essay.txt SHA256 `3e8512ebaa6657e35961b1f5762060717c647e3bf471d5e3b86e783b4e934ffb`
- COCT xlsx SHA256 `bfd3b73938e115ae39a44c5e11c97135c09939cf598157cb2fe0b33c4302de75`。
- COCT 固定下載：[官方 xlsx](https://coct.naer.edu.tw/file/files/%E9%80%9A%E7%94%A8%E8%A9%9E%E9%A0%BB%E8%A1%A8%20-%20%E5%AE%9A%E7%A8%BF1141208.xlsx)。它不是 git pin；保留本機檔與 checksum 才能重現。
