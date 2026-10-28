# 繁體中文斷詞：預設詞庫、Charabia 管線與現成詞庫

日期：2026-10-27。研究範圍為 #162 發現的「觀光」被拆成字、命中「直觀／賣光」的原因，以及現成繁體詞庫。研究不修改產品設定、runtime、索引或已確認的正規化規則。

後續調查：[繁體優先的現代中文詞庫與分詞比較](modern-traditional-chinese-lexicons.md)。本頁的舊big／jieba-tw保留作根因與基準實驗，候選選型改以後續查到的台灣、官方及持續更新的社群資料為範圍。

## 結論

基本詞彙不應由使用者逐詞維護。這次的根因是目前上游預設 jieba 主詞庫對繁體詞形覆蓋不足，加上 Charabia 關閉 HMM 未知詞辨識；缺少「觀光」時，第一輪斷詞直接回傳「觀」「光」。後續繁簡字元正規化不會重新把兩個 token 組成詞。

現成候選包括官方 jieba `dict.txt.big` 與台灣 `jieba-tw` 詞庫。前者可直接修復本次「觀光」，但沒有「資安／拆股」；後者覆蓋三詞，卻有詞庫資料來源的授權限制，不能只依 repo MIT 標籤直接隨產品散布。

另外，Charabia 對三字以上的 jieba 詞會再細分，所以只換詞庫不足以承諾所有詞都保持完整。需要把「基礎繁體詞庫」與「搜尋用的二次切分策略」一起實驗，而不把所有基本詞都推給 #164 的 Wiki 詞彙維護。

## 固定版本與程式鏈

- Meilisearch 1.53.2，source `ec006cecec6f684b1dcaee093a45ab4c05707127`：[Cargo.lock](https://github.com/meilisearch/meilisearch/blob/ec006cecec6f684b1dcaee093a45ab4c05707127/Cargo.lock)。本機 repo 的 `scripts/meilisearch-build-recipe.json` 與此對齊。
- Charabia 0.10.0，crate source git `bc63b9860434f06cf78b51bb0eab00aaefb69f15`。
- jieba-rs 0.10.3，crate source git `c62e0df1f9dcc2cc1e014711c5aa4561ae260538`。

上述版本從產品 source 的 Cargo.lock 與已下載 crate 的 `.cargo_vcs_info.json` 讀回，沒有用最新 README 推論固定版行為。

### 1. 預設詞庫有「观光」，沒有「觀光」

jieba-rs 的 `Jieba::new()` 載入編入 binary 的 `src/data/dict.txt`。實查該固定版詞檔有 `观光 584 n`，沒有繁體「觀光」，也沒有「資安」「拆股」「半導體」「台積電」。

來源：[固定版 jieba-rs lib.rs](https://github.com/messense/jieba-rs/blob/c62e0df1f9dcc2cc1e014711c5aa4561ae260538/jieba/src/lib.rs#L338)、[固定版詞檔](https://github.com/messense/jieba-rs/blob/c62e0df1f9dcc2cc1e014711c5aa4561ae260538/jieba/src/data/dict.txt)。

### 2. Charabia 關閉 HMM，未知詞不作統計辨識

ChineseSegmenter 的全域 `JIEBA` 由 `Jieba::new()` 建構；`segment_str` 呼叫 `JIEBA.cut(to_segment, false)`，false 明確停用 HMM。實測啟用 HMM 的 standalone jieba-rs 可以把「觀光」猜成一詞，但這不是產品當前路徑；也不代表把 HMM 打開即可解決所有搜尋品質問題。

來源：[固定版 ChineseSegmenter](https://github.com/meilisearch/charabia/blob/bc63b9860434f06cf78b51bb0eab00aaefb69f15/charabia/src/segmenter/chinese.rs#L56)。

### 3. 先斷詞，再正規化

`Tokenize::tokenize()` 與 Tokenizer 都先 segment，再 normalize。原始「观光」可先辨認為完整 token，之後 lemma 變成「觀光」；原始「觀光」先被拆為兩個 token，之後正規化依然是兩個 token。

這說明 #162 的搜尋投影統一成繁體時，必須一併確認繁體斷詞能力：字形統一正確，不代表詞邊界正確。這也不是中文精簡 build 自行刪除了繁體詞庫；產品使用上游同一個 ChineseSegmenter 與預設詞庫。

來源：[固定版 tokenizer.rs](https://github.com/meilisearch/charabia/blob/bc63b9860434f06cf78b51bb0eab00aaefb69f15/charabia/src/tokenizer.rs#L88)。

### 4. 長詞還有第二輪搜尋細分

ChineseSegmenter 在 jieba.cut 後另呼叫自身的 `cut_for_search`：兩字以內保持；較長的非純ASCII詞從頭貪婪選字典中的二字詞，再選三字詞，否則選單字。因此「詞庫有完整詞」不代表最後 Charabia token 保留該詞。

來源：[同檔 cut_for_search](https://github.com/meilisearch/charabia/blob/bc63b9860434f06cf78b51bb0eab00aaefb69f15/charabia/src/segmenter/chinese.rs#L20)。

## 實驗：直接印出固定依賴的 token

證據在 `.local/ticket-artifacts/162/tokenizer-root-cause/`，包含 Rust probe、Cargo.lock、build logs 與輸出。預設實驗使用未修改的 crate；候選實驗在 ignored 目錄複製一份相同 Charabia，只替換全域 JIEBA 建構為 `Jieba::with_dict`，其餘 segmentation／normalization 程式不動。沒有替換 App 的 Meilisearch binary，也沒有修改使用者索引。

| 輸入 | 原始 jieba.cut(false) | 原始 Charabia 最終詞 token |
| --- | --- | --- |
| 觀光 | 觀／光 | 觀／光 |
| 观光 | 观光 | 觀光 |
| 資安 | 資／安 | 資／安 |
| 拆股 | 拆／股 | 拆／股 |
| 半導體 | 半／導／體 | 半／導／體 |
| 台積電 | 台／積／電 | 台／積／電 |

完整輸出：`default-output.txt`。同檔另列 HMM=true 對照，但不據此改產品。

## 實驗：現成詞庫經過完整 Charabia 管線

| 輸入 | jieba 官方 big → Charabia | jieba-tw → Charabia |
| --- | --- | --- |
| 觀光 | 觀光 | 觀光 |
| 資安 | 資／安 | 資安 |
| 拆股 | 拆／股 | 拆股 |
| 半導體 | 半導／體 | 半導體 |
| 台積電 | 台／積／電 | 台積／電 |
| 觀光產業 | 觀光／產業 | 觀光／產業 |

完整輸出：`charabia-big-output.txt`、`charabia-tw-output.txt`。兩檔中 DEFAULT/CUT 欄仍是獨立未換詞庫的 Jieba 對照，`charabia_segments`／`charabia_lemmas` 才是候選詞庫進入 Charabia 後的結果。

這是 library 層實驗，尚未完成換詞庫後的整個 Meilisearch 真引擎 A/B、索引成本或兩平台 build 驗證。官方 big 的「半導體」在 jieba 層是一詞，因其詞庫也有「半導」，第二輪變成半導／體；台灣詞庫的「台積電」同理被台積／電細分。

## 接入選項與建議的下一步

1. **主詞庫替換實驗**：固定官方 big 版本／checksum，保留頻率，以 `Jieba::with_dict` 初始化 Charabia；同時比較保留與調整長詞二次細分的行為。產品當前沒有載入外部 jieba 主詞庫的設定，這條路需受控 source/build 修改，不是放一個檔案即可生效。
2. **批次 Meilisearch dictionary 實驗**：從現成詞庫抽詞頭，用 API 載入字串清單；不逐詞手補。但此 API 會先於語言斷詞處理指定詞，沒有 jieba 頻率，並不等同替換主詞庫。需獨立測大詞表下的切詞、誤匹配、記憶體與索引成本。
3. 兩條路都使用固定繁簡混合 corpus、基本詞、長詞、中英數、同字異詞負例，重跑 N8 的四組錯誤匹配。不要只因「觀光」改善就判斷完成。比較查詢與文件 tokens，並從真正搜尋結果驗召回、排名、錯誤命中、分頁與原文高亮。
4. 基礎繁體詞庫與之後由 #158／#164 維護的財經新詞分開負責；公司別名仍由 #163 的資料 API 提供。研究階段不先改 #162 已確認的簡轉繁方向。

自訂詞 API 的程式依據：[Charabia words_dict](https://github.com/meilisearch/charabia/blob/bc63b9860434f06cf78b51bb0eab00aaefb69f15/charabia/src/tokenizer.rs#L264)、[Meilisearch dictionary API](https://www.meilisearch.com/docs/reference/api/settings/update-dictionary)。

## 詞庫來源、格式與授權詳查

## 可直接用來比較的現成詞檔

| 詞庫 | 實際下載與格式 | 觀光／資安／拆股 | 授權與維護 |
| --- | --- | --- | --- |
| jieba 官方 `extra_dict/dict.txt.big` | 584,429 行，8,583,143 bytes；每行 `word frequency POS`，含繁簡詞形 | `觀光 584 n`（L463786）、`观光 584 n`（L464168）；資安／拆股未找到 | 官方 repo 以 MIT 發布，README 明確稱 big 有較佳繁體支援；詞檔最後 commit 2013-06-26，資料較老 |
| APCLab/jieba-tw `jieba/dict.txt` | 308,431 行，4,154,480 bytes；`word frequency POS`，台灣繁體特化 | `觀光 6627 Nv`（L240406）、`資安 213 N`（L250502）、`拆股 3 N`（L107081），三詞均有 | repo LICENSE 是繼承 MIT，但上游明示中研院服務衍生資料條款，**不能只據 MIT 當成可隨商業產品再散布**；詞檔最後修改2016-07-14，APCLab HEAD2017-11-03 |
| MDBG CC-CEDICT | 125,320 entries，下載解壓125,350行／9,868,269 bytes；`Traditional Simplified [pinyin] /definitions/`，沒有詞頻 | 有觀光、資安；本次未找到以拆股為詞頭的entry | 官方頁面與下載header均為 CC BY-SA 4.0；本次下載發布時間2026-10-26 02:33:39 GMT。需抽詞、去重，若轉成jieba主詞庫仍缺實際詞頻 |

最適合先做「主詞庫替換」對照的是官方 big，因為是原有 jieba 生態提供、含頻率的繁體候選，無須自己逐詞補入。它不是完整的當代台灣財經詞庫；資安／拆股缺詞即為本次實查限制。

jieba-tw 在技術上更貼近台灣，三個反例詞皆有，但其資料授權限制是實際發現，採用前需獨立取得可用授權；不能以 repo 上的 MIT 標籤忽略上游條款。

## 固定來源與版本

### jieba 官方

- [README：Other Dictionaries／繁體 big 說明](https://github.com/fxsjy/jieba/blob/67fa2e36e72f69d9134b8a1037b83fbb070b9775/README.md)
- [固定詞檔](https://github.com/fxsjy/jieba/blob/67fa2e36e72f69d9134b8a1037b83fbb070b9775/extra_dict/dict.txt.big)
- [MIT LICENSE](https://github.com/fxsjy/jieba/blob/67fa2e36e72f69d9134b8a1037b83fbb070b9775/LICENSE)
- repo HEAD `67fa2e36e72f69d9134b8a1037b83fbb070b9775`，2020-02-15；big 最後修改 `237dc6625e5c65d7a2714ffdfa5238dba5cae7d4`，2013-06-26。repo pushed_at 2024 不等於字典2024更新。
- 本機 `/tmp/xr162-lexicons/jieba-dict-big.txt`，SHA-256 `b16011275c42955ccd81fc1adecc93a59dbb7926af69d93fc95d4943d40f6aad`。
- 對照預設官方 dict：349,046行／5,071,852bytes，只有 `观光 584 n`（L286692），沒有 `觀光`；SHA-256 `7197c3211ddd98962b036cdf40324d1ea2bfaa12bd028e68faa70111a88e12a8`。

### 台灣 jieba-tw 與資料授權

- [APCLab 固定 README](https://github.com/APCLab/jieba-tw/blob/2bd4c0913cdadc865879b21a00c78e28ef1ba2c5/README.md)：明述以替換詞庫及 HMM 機率表特化台灣繁體，並連到 ldkrsi 上游的其餘注意事項。
- [APCLab 固定詞檔](https://github.com/APCLab/jieba-tw/blob/2bd4c0913cdadc865879b21a00c78e28ef1ba2c5/jieba/dict.txt)
- [APCLab MIT LICENSE](https://github.com/APCLab/jieba-tw/blob/2bd4c0913cdadc865879b21a00c78e28ef1ba2c5/LICENSE)
- 詞檔最後修改 `145ffe28192455563d2d2367697b579819ade4d8`，2016-07-14。
- [ldkrsi 上游 README 注意事項](https://github.com/ldkrsi/jieba-zh_TW#注意事項)：使用需遵守中研院斷詞服務的衍生資料條款。
- [中研院舊服務條款原頁](https://ckipsvr.iis.sinica.edu.tw/terms.htm)：本次 curl 可讀取，web reader 無法取得。條1限學術／非營利，條2服務產出與直接衍生資料不得包含／引用於商業產品，條3不得移轉產出給第三人。原HTML保存在 `/tmp/xr162-lexicons/ckip-terms.html`。這是授權文本觀察，不把繼承MIT推論為已解除該限制。
- 本機 `/tmp/xr162-lexicons/jieba-tw-dict.txt`，SHA-256 `72250ef62afd80f56044befbcaaa39a8450c4efbf61ca1f70f45cc92fb654ac5`。

### CC-CEDICT

- [官方下載頁、授權、發布日期與entry數](https://www.mdbg.net/chinese/dictionary?page=cc-cedict)
- [官方 gzip 下載](https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz)
- 本次header `#! date=2026-10-26T02:33:39Z`；授權 `https://creativecommons.org/licenses/by-sa/4.0/`。
- 實際詞條：`觀光 观光 [guan1 guang1] /to tour/sightseeing/tourism/`；`資安 资安 [zi1 an1] /(Tw) information security .../`。沒有jieba詞頻，不能視為可直接替換的統計斷詞主詞庫。
- 本機 `/tmp/xr162-lexicons/cedict.txt`；SHA-256 `3d8967fe566bc23a74f8ba008d38ac83269a8c7550bd7dc48218fc9bdf284885`。

## jieba-rs 是否能載入／替換

已讀目前本機固定依賴的 jieba-rs 0.10.3 source（Host 確認為產品鏈）：

- `Jieba::new()`：從 empty 開始，再載入編入binary的 default dictionary（src/lib.rs L338–341）。
- `Jieba::with_dict(&mut reader)`：從 empty 開始，再 `load_dict`，適合完全替換主詞庫（L345–349）。
- `load_dict(&mut reader)`：逐行 split_whitespace，詞、整數頻率、詞性；更新或插入現有字典詞，最後依 records 重新計算 total（L503–555）。因此向 `new()` load_dict 是合併／覆寫，不能當作「只用新主詞庫」。
- [官方 API docs](https://docs.rs/jieba-rs/0.10.3/jieba_rs/struct.Jieba.html)
- [官方 crate source](https://docs.rs/jieba-rs/0.10.3/src/jieba_rs/lib.rs.html)

官方 big 與 jieba-tw 詞檔都有相容的詞頻欄，可用 `with_dict` 直接餵入實驗。是否導入產品，仍需修改 Charabia 當前 static JIEBA 的建構方式或編入詞檔並重建。Meilisearch 的現成API沒有「指定 jieba-rs 主詞庫檔案路徑」這個設定。

## Meilisearch dictionary API 與主詞庫替換是兩件事

[官方 dictionary API](https://www.meilisearch.com/docs/reference/api/settings/update-dictionary) 接受字串陣列，不接受 jieba 的 frequency/POS。可以把現成詞庫抽第一欄後載入，避免逐詞手補，但這並不是完整帶入原詞庫的統計斷詞模型；會失去頻率，並走 Charabia 自訂詞字典的匹配路徑。固定版 words_dict 先於 JIEBA 的處理順序已由上方程式與實驗確認。

因此至少應分組：

1. 目前預設 jieba 主詞庫。
2. 替換成官方 big 主詞庫（保留頻率，with_dict，修改build）。
3. 替換台灣候選主詞庫，僅做技術研究，授權未解決前不隨產品交付。
4. 抽取官方 big 的詞頭走 Meilisearch dictionary API（無頻率），單獨量測與2的差異。

不能只看到「觀光」在詞檔就宣稱搜尋全部改善。要同時量測觀光／資安／拆股、同字異詞負例、長複合詞（Charabia另有長詞細分）、召回與誤命中、索引大小、build binary大小與查詢延遲。

## 教育部／中研院資源邊界

- [g0v/moedict-data](https://github.com/g0v/moedict-data) 是教育部辭典資料的機器可讀JSON；[README](https://github.com/g0v/moedict-data/blob/master/README.md) 明定教育部原始內容 CC BY-ND 3.0 Taiwan，格式整理者額外編輯權 CC0不改變原內容授權。它提供正式詞目與解釋，沒有jieba統計詞頻。資料抽取／正規化與再散布須依原始條款確認，不能把CC0當所有資料可任意改寫的授權。這次未把它列為ready-to-use斷詞主詞庫。
- CKIP官方有斷詞工具／模型／語料資源，但本次沒有確認一份可以無條件隨商業產品散布、帶頻率、可直接餵jieba-rs的最新CKIP通用詞庫；不能把線上服務或模型當成可下載詞表。
- 這些通用詞庫與 #158 Wiki／財經詞彙維護責任不同。基礎繁體斷詞可先採已有通用詞庫作候選，之後財經新詞與品牌別名再由權威資料補充。
