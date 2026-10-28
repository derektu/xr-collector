# 中文社群詞庫研究：Rime 萬象、霧凇、CC-CEDICT、Wiktionary / Kaikki

研究日期：2026-10-27。目的不是選「最近有 commit」的 repo，而是判斷哪些資料真的持續增修詞條、對繁體受眾有用、資料權利可追溯，並能安全轉成 Meilisearch custom dictionary 或 Jieba 詞頻庫。

## 結論先行

1. **Rime 萬象是最強的近期新詞候選來源，但不宜直接把整包與 weight 原封不動送進產品。**它有原生發布的 `dicts_hant/`、規模大、幾乎每日產生實質詞庫 diff；然而抽查顯示繁體檔與簡體檔的詞與權重成對鏡像，仍帶有中國大陸用詞排序。其 README 說明資料來自 48 GB 多領域語料、AI 輔助篩選與人工校對，詞頻經對數正規化且結合拼音統計；這是輸入法排序權重，不是可直接當 Jieba corpus count 的原始頻率。資料來源種類有說明，但沒有可逐項稽核的 corpus 清單與 AI 篩選重現方法。
2. **霧凇拼音也確實持續增詞與校正，適合做新詞差集和 A/B 候選，但整包採用的上游權利風險更高。**它明示為簡體中文設計，最近詞庫 commit 確有新增詞，不只是排序；不過詞庫合併華宇野風、THUOCL、現代漢語常用詞表、騰訊詞向量，並參考多部商業辭典。repo 的 GPL-3.0 聲明本身不能證明每個上游詞表可按同一條款重分發。
3. **CC-CEDICT 與 Wiktionary / Kaikki 的資料授權鏈最清楚，適合成為可審的新詞差集與繁簡 lemma 來源，但都不是詞頻來源。**CC-CEDICT 每筆直接帶繁體、簡體、拼音和釋義；Kaikki 的 Wiktextract JSON 可抽 `word`、`forms`、詞性、地區與同義關係，尤其能辨識 `資安` 是台灣用語。兩者若分發衍生資料，需讓法務確認 attribution/share-alike 的實際履行方式；本文不作法律定論。
4. **對繁體受眾，應優先使用原生台灣繁體頻率基線，再用這四類來源補詞。**萬象繁體不是可靠的台灣詞頻：例如 `軟件 147574` 對 `軟體 615`、`信息安全 2298` 對 `資訊安全 639`、`鼠標 26357` 對 `滑鼠 169`、`網絡 79002` 對 `網路 801`。簡轉繁可解字形，不能取代台灣用詞與頻率。

## 實測快照

| 來源 | 本次實測版本 / 真正更新證據 | 下載與規模 | 五詞 exact coverage（觀光、資安、拆股、半導體、台積電） | 頻率語義 | 資料權利 |
|---|---|---|---|---|---|
| [萬象資料中心](https://github.com/amzxyz/rime-wanxiang-data) | 資料快照 `cda61dcd`，2026-10-26；其 diff 實際新增 `你卡`、`晒肉`、`活動支出`、`活動指出`，並刪詞／調權。主方案 repo 的 `dicts/` 近 90 天有 171 個 touching commits；同日彙整 commit `d8fffe13` 另可見 `糧米`、`孬蛋`、`西窗燭` 等新增及大量拼音修正 | `dicts_hant/*.yaml` 76.0 MB、2,289,293 筆 tab records；其中 `jichu` 1,493,869 筆。簡體約 79.6 MB / 2,292,838 筆。record 包含同詞異音、錯音提示、縮寫和長詞，不能當 unique lemma 數 | 繁體檔有 觀光、拆股、半導體、台積電；本次 exact scan 無 資安 | README 明說由「詞組 + 拼音」雙鍵統計、單字按拼音拆分，巨量 count 再做對數正規化；是 Rime ranking weight，不是 raw corpus frequency | repo 的 [LICENSE-SCOPE](https://github.com/amzxyz/rime-wanxiang-data/blob/wanxiang/LICENSE-SCOPE.md) 將自行維護的詞庫列為 CC BY 4.0；[README](https://github.com/amzxyz/rime-wanxiang-data#%E6%95%B0%E6%8D%AE%E6%9D%A5%E6%BA%90%E4%B8%8E%E7%94%9F%E6%88%90%E6%96%87%E4%BB%B6) 也說根 license 不自動覆蓋第三方元件。但 corpus 上游權利與 AI 篩選逐項 provenance 未公開到可完整稽核 |
| [霧凇拼音](https://github.com/iDvel/rime-ice) | 最新 touching `cn_dicts` 的 commit `da1fbe60`，2026-10-05；近 90 天 10 次。該 commit 的 `base` +454/-231、`ext` +65/-53、`tencent` +471/-180；實看有新增 `包漿`、`剝線`、`補測`、`重用機制` 等，也有刪錯與調頻 | `cn_dicts/*.yaml` 44.2 MB、1,919,256 筆 records；base 543,118、ext 339,186、tencent 981,543 | 簡體檔有 观光、拆股、半导体、台积电；本次 exact scan 無 资安。這只描述五詞抽查，不代表所有繁體詞都缺 | base 的數字用於輸入候選調頻；tencent 大量項目甚至固定 `100`。沒有一致的 corpus-count 定義，不能直接視為 Jieba frequency | 根 license 為 GPL-3.0-only，但 [base header](https://github.com/iDvel/rime-ice/blob/main/cn_dicts/base.dict.yaml) 列出華宇野風、THUOCL、現代漢語常用詞表、騰訊詞向量及多部辭典；[tencent header](https://github.com/iDvel/rime-ice/blob/main/cn_dicts/tencent.dict.yaml) 另標騰訊詞向量。需分別審上游資料條款，不能只依 repo license 推定 |
| [CC-CEDICT](https://cc-cedict.org/editor/editor.php?handler=Download) | 官方 MDBG verified release：2026-10-26 02:33 GMT，125,320 entries；[change log](https://cc-cedict.org/editor/editor.php?handler=ListChanges) 顯示編輯者持續逐筆 review。另下載 2026-10-27 non-verified editor export實測 125,355 lines | non-verified ZIP 3.8 MB，解壓 9,868,684 bytes | 有 觀光、資安、半導體、台積電；無 拆股。`資安` 明標 `(Tw)`；每筆原生並列 trad / simp，不需猜轉換 | 無 frequency；釋義或 entry count 不能拿來當詞頻 | 官方明示 CC BY-SA 4.0，可商用但要求 attribution 與 share-alike；正式整合前確認衍生詞表的合規邊界 |
| [Kaikki：English Wiktionary 的 Chinese](https://kaikki.org/dictionary/Chinese/) | 2026-10-25 extraction，來源 enwiktionary 2026-10-01 dump；頁面列 308,751 distinct word forms | postprocessed JSONL 1.1 GB | 網頁資料可確認 觀光、資安、拆股、半導體；本次未找到 台積電頁。`資安` 帶 Taiwan + abbreviation；`拆股` 的義項是 withdraw shares，不應自動等同 stock split | 無 corpus frequency；sense、forms、redirect 數不能冒充詞頻 | [Wiktionary Copyrights](https://en.wiktionary.org/wiki/Wiktionary:Copyrights) 說文字採 CC BY-SA 4.0 / GFDL；個別外部內容可能另有條款，抽欄位時保留來源與 attribution metadata |
| [Kaikki：中文維基詞典](https://kaikki.org/zhwiktionary/) | 2026-10-24 extraction，來源 zhwiktionary 2026-10-01 dump；標示 regularly updated，raw extraction 通常至少每週更新 | 漢語 postprocessed 759.4 MB、275,643 distinct forms / 311,519 senses；[raw 全站](https://kaikki.org/zhwiktionary/rawdata.html) 1.9 GB，gzip 223.6 MB | 可與 English edition union 再去重；繁體 `word` 常為 lemma、簡體在 `forms` 或 redirect，但要依 tags 驗證，不可只跑 OpenCC | 無 frequency | 同上；Kaikki 是 extractor，不是另行把 Wiktionary 資料改授權 |

### 萬象的「繁體」是什麼

萬象確實公開 `dicts_hant/`，不是只在 UI 動態轉換；但五詞中有四詞的繁簡行權重完全一致，例如：

```text
观光 / 觀光       1642
拆股 / 拆股        790
半导体 / 半導體   6424
台积电 / 台積電   2543
```

再加上前述中國用詞顯著高於台灣用詞，合理判斷它是**簡體語料與輸入排序的繁體投影**，不是台灣繁體 corpus。這仍可用於「繁體字形詞是否存在」與新詞候選，不能直接代表繁體受眾的詞彙偏好。

### 多義字與地區詞的處理

- 字形轉換只應生成候選，不應自動建立同義詞。例如 `信息安全 → 信息安全` 不會自然變成台灣常用的 `資訊安全`；`軟件 → 軟件` 也不等於 `軟體`。
- 一簡多繁或依語境選字的詞，應以來源原生 lemma / forms 為準。CC-CEDICT、Kaikki 能直接提供繁簡 pair，比把單獨簡體詞逐字 OpenCC 更可審。
- `拆股` 特別危險：Rime 收詞不附義，CC-CEDICT 未收；Kaikki 的現有英文義項不是美股常說的 stock split。若產品想改善股票分割檢索，應由公司資料 API / 同義詞票處理，不能因字面出現在大詞庫就當語義 alias。

## 轉成 Meilisearch dictionary

Meilisearch 的 [`dictionary` setting](https://specs.meilisearch.dev/specifications/text/0123-user-dictionary-settings-api.html) 是 **JSON string array**，用途是覆寫 query 與 document segmentation；它不接收詞頻或 POS，而且變更會 reindex 全部文件。

建議 ETL：

1. 只取明確的 `text` / `word` / tagged form，移除 Rime YAML header、comment、拼音、輔助碼、weight；Kaikki 排除 soft redirects、非中文 language、純字元和無義雜項。
2. 先跑 #162 同一個 normalization，再 exact dedupe；另保留 `source`、來源版本、原始形、license、地區 tag 到 build manifest，不要把 provenance 丟掉。
3. 以 2–8 漢字為首輪候選；公司名可先排除，因公司 alias 已切到資料 API。去除句子、詩句、錯音提示、Rime 自動衍生長詞、單字、純數字、污染詞。
4. 繁簡 pair 可共同加入 segmentation dictionary，但**不能**據此建立 synonym；地區詞要經台灣語料或人工審核。
5. 用候選差集做小批次 A/B，不要塞 150–230 萬筆。每批 dictionary 版本需納入 search profile，量 reindex 時間、DB size、RSS、search p50/p95。

## 轉成 Jieba 詞頻庫

[Jieba 官方格式](https://github.com/fxsjy/jieba#%E8%BD%BD%E5%85%A5%E8%AF%8D%E5%85%B8) 是 `word frequency POS`，frequency / POS 可省略；省略時 Jieba 會計算能確保切出該詞的值。Jieba 的 DAG + dynamic programming 使用詞頻找最大機率路徑，因此錯把 Rime ranking weight 當 corpus count 會改變整體切詞。

- **CC-CEDICT / Kaikki：**沒有 frequency，先抽詞頭，再明確選擇頻率推導或台灣 corpus 校準；POS 只在來源 mapping 明確時保留。注意目前產品用的 [jieba-rs 0.10.3](https://github.com/messense/jieba-rs/blob/c62e0df1f9dcc2cc1e014711c5aa4561ae260538/src/lib.rs) 中，`add_word(word, None, ...)` 才呼叫 `suggest_freq`；`load_dict` 讀入省略frequency的行會用0，不能把Python Jieba的使用者字典說明直接套用成Rust讀檔行為。若用自動推導，載入順序與基準詞庫也必須固定。
- **萬象：**weight 已做 log normalization、拼音條件統計與輸入排序調校。可作「相對排序特徵」研究，但不能直接填 Jieba frequency。若要利用，先用台灣 corpus 對共同詞做 monotonic calibration，再以 held-out segmentation 選參數。
- **霧凇：**base/ext/tencent 的 weight 定義不一致，tencent 又有大量固定 100；只能抽詞，不能合併成單一可信頻率庫。

## 建議的驗證實驗

### A. 候選來源離線篩選

建立固定 manifest 與差集：

- baseline：目前 Meili / Jieba dictionary；
- candidate A：台灣原生頻率基線；
- candidate B：A + CC-CEDICT / Kaikki 新詞差集；
- candidate C：B + 萬象繁體與霧凇的人工審核差集。

每筆候選記錄來源版本、license、繁簡欄位、地區、是否有 definition、是否有可信 frequency。禁止僅因 repo 最近更新就收詞。

### B. 目標詞與負面語義

至少測：

- 正例：`觀光`、`資安`、`資訊安全`、`半導體`、`台積電`、`股票分割`；
- 必須區分：`拆股`（退股 / stock split）、`信息安全` vs `資訊安全`；
- 地區偏好：`軟件/軟體`、`鼠標/滑鼠`、`內存/記憶體`、`網絡/網路`、`打印機/印表機`；
- 既有 #162 hard negatives：確保不因大詞庫重新引入公司 alias、概念 alias 或地區用詞替換。

對每題記錄 tokenizer tokens、returned IDs、ranking、snippet 和 gold relevance；不只看 recall。

### C. 真實 corpus 回歸

沿用 34 documents / 60 queries frozen corpus，額外加入台灣財經、科技、生活三類各至少 100 query：

- recall@20、precision@20、MRR、gold regression、forbidden hits；
- segmentation exact match / boundary F1（人工標註至少 500 句）；
- Meili dictionary 變更前後 index build time、DB size、RSS、p50/p95；
- 按來源做 ablation，確認增加的命中確實來自新詞邊界，而非長文中分散單字的假陽性。

### D. 更新供應鏈

- 每月或每季抓固定 SHA / dump date，而非追 `latest`；輸出 checksum、筆數、增刪詞、license snapshot。
- 自動產生 review report：新詞、刪詞、權重變動分開；純拼音/排序/格式變更不算「新增詞」。
- 對 AI/LLM 生成詞僅當候選；除非來源公布生成 prompt/model、輸入資料權利、去重與人工驗證結果，否則不得自動進 production dictionary。

## 採用建議

- **正式基線：**優先採台灣原生詞頻 / 斷詞資料；本報告四來源都不應單獨替代它。
- **第一層可審新詞：**CC-CEDICT + Kaikki，抽繁體 lemma、簡體 tagged form、地區與 definition；以 attribution / share-alike review 為 gate。
- **第二層社群雷達：**萬象繁體 + 霧凇，只取相對 baseline 的差集，人工審詞與資料權利後才加入；weight 不直接使用。
- **不建議：**整包百萬詞直接塞 Meili、把 Rime weight 當 Jieba frequency、對簡體詞整批 OpenCC 後宣稱是台灣詞庫、或把 definition / alias 自動轉成搜尋 synonym。

## 本次本機實查方式

- 萬象：shallow/filter clone 固定 `cda61dcd` 與 `d8fffe13`，以 tab record 計數、`git log -- dicts`、`git show --numstat` 與實際 unified diff 區分增詞和格式變動。
- 霧凇：固定 `da1fbe60`，下載 main archive，並以 filtered Git history 驗最近 90 天 `cn_dicts` commits 和最新 diff。
- CC-CEDICT：從官方 editor download 下載 2026-10-27 non-verified ZIP 到 `/tmp`，解壓後 exact scan 五詞；verified 數字引用官方 MDBG 頁。
- Kaikki：使用官方 extraction / download pages與 individual word JSON pages；未為了五詞掃描而下載 1.1 GB 全檔。

