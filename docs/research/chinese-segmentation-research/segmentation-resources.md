# 現代中文分詞工具的詞彙資源核查

調查日：2026-10-27。只讀官方 repo、官方文件與 model card；以下載實物檢查資料格式及筆數，沒有執行模型、沒有改 Collector 或安裝依賴。

## 結論

**新模型不等於新詞表。** 本次核查到的現代分詞器主要採序列標記模型，加上使用者字典作干預；實際可下載、能轉給 Rust/Jieba 或 Meili 的通用詞表，反而常是 2019–2022 年的資料。沒有找到「2025/2026 持續更新、繁體台灣、含可靠詞頻、授權清楚」而且可直接替換現有 Jieba 主詞庫的現成資源。

值得保留的候選：

1. **HanLP 1.x CoreNatureDictionary 明文詞性詞頻表**：可作候選詞對照，來源格式好讀；但不是新詞表、以簡體語料為主。
2. **JioNLP word_distribution**：真正的語料詞頻，不是模型 tokenizer vocab；可研究候選詞與頻率，但資料 2021 年即固定，不能當新領域詞庫。
3. **CKIP Transformers 繁體模型**：適合當離線標註／評測對照器，**不是可塞進 Meili 的詞庫**。
4. **自有語料＋審核的領域字典**：現代工具普遍支援使用者字典，這比把另一套老字典全量合併更有針對性。模型用於找候選，最終可攜資料另存 term／source／reviewed／日期，不把模型詞表當權威詞庫。

## 區分資料類型

| 類型 | 真正包含什麼 | 對 Collector 意義 |
|---|---|---|
| 詞典 | 一詞一列，可能有 POS／別名 | 能轉為 Meili `dictionary` 的字串；不自動有可靠詞頻 |
| 詞頻詞典 | 詞＋語料出現次數或 POS 次數 | 可試 Jieba 主詞典／add_word；不同語料次數不能直接相加 |
| 模型 input vocab | 字、子詞、`##`、special tokens → ID | 服務模型編碼；不是中文詞彙單位，不可直接當分詞詞庫 |
| 分詞模型 | 由上下文預測字邊界的參數 | 可處理未登錄詞，但要執行模型，不能抽出 vocab 當等價替代 |
| 領域詞庫 | 自己維護的公司／產品／術語 | 有近期更新與審核來源最重要；斷詞詞與同義詞需分別維護 |

## A. 可以下載成資料的候選

### A1. HanLP 1.x（詞表，而非 2.x 模型）

固定 branch snapshot：`dadd5c76a53eb05cc84720628b89e4a334d5d753`。

- [CoreNatureDictionary.txt](https://github.com/hankcs/HanLP/blob/dadd5c76a53eb05cc84720628b89e4a334d5d753/data/dictionary/CoreNatureDictionary.txt)／[直接下載](https://raw.githubusercontent.com/hankcs/HanLP/dadd5c76a53eb05cc84720628b89e4a334d5d753/data/dictionary/CoreNatureDictionary.txt)：2,162,581 bytes、實讀 **153,087 行**；格式 `詞\t詞性\t次數`，一詞也可能有多組詞性/次數。例如檔中有 `台积电 nz 6`、`英伟达 nz 3`，說明它既不是純台灣詞表，也不是當代熱門詞頻。
- 該核心詞檔最後修改：[2022-02-21 commit 2f796df](https://github.com/hankcs/HanLP/commit/2f796dfd355824ab274cd22629bb7f6c7c4d488d)。[README 交代核心來自人民日報 2014 語料](https://github.com/hankcs/HanLP/blob/dadd5c76a53eb05cc84720628b89e4a334d5d753/README.md#L721)。repository 今天是否仍維護不能代表此詞表更新到今天。
- 另有 [現代漢語補充詞庫](https://github.com/hankcs/HanLP/blob/dadd5c76a53eb05cc84720628b89e4a334d5d753/data/dictionary/custom/%E7%8E%B0%E4%BB%A3%E6%B1%89%E8%AF%AD%E8%A1%A5%E5%85%85%E8%AF%8D%E5%BA%93.txt)：3,369,939 bytes、實讀 **207,907 行**；「現代」是檔名，不是更新保證。最後該檔 commit [2019-11-23 ab0cf20](https://github.com/hankcs/HanLP/commit/ab0cf201070c16cc6d26d7c869b53a3cb84d61bd)。
- 1.x [README 的詞表格式](https://github.com/hankcs/HanLP/blob/dadd5c76a53eb05cc84720628b89e4a334d5d753/README.md#L686)明確可讀，且 [1.x 授權章](https://github.com/hankcs/HanLP/blob/dadd5c76a53eb05cc84720628b89e4a334d5d753/README.md#L747)標示 Apache-2.0、要求附連結與授權。採用時保存該版 LICENSE／來源；**不可用這份 1.x 授權推論 2.x 模型亦可商用**。
- Rust 可實作簡單 TSV parser，POS 次數取和形成候選頻率；Meili dictionary 只能取詞，不能表達這些次數。簡轉繁後會有碰撞和台陸用詞差異，要保留來源及碰撞報告。
- 定位：**值得做詞彙覆蓋差集實驗，不值得直接整包取代現有詞庫**。樣本中找不到精確條目 ChatGPT、CoWoS、大模型、元宇宙；這只證明這些 probe 的缺口，不宣稱完整新詞召回率。

### A2. JioNLP word_distribution（有詞頻，可直接讀 JSONL）

固定 snapshot：`ab876fd9181d47c1b76531d320eb9019754fd8cd`。

- [word_distribution.zip 下載](https://raw.githubusercontent.com/dongrixinyu/JioNLP/ab876fd9181d47c1b76531d320eb9019754fd8cd/jionlp/dictionary/word_distribution.zip)：1,304,909 bytes；內含 `word_distribution.json`，雖副檔名 json，實際是一行一個 `[word,count]`，實讀 **196,936 行**。有標點、空白和控制字元，不能不過濾即載入字典。
- [官方 loader L546 後](https://github.com/dongrixinyu/JioNLP/blob/ab876fd9181d47c1b76531d320eb9019754fd8cd/jionlp/dictionary/dictionary_loader.py#L546)說明是分詞後詞彙的出現次數，並計算概率／對數等派生量。這是語料統計，不是 jieba 同義詞表，也不是 Transformer token ID 表。
- 該 zip 最後更動是 [2021-02-10 7edc465](https://github.com/dongrixinyu/JioNLP/commit/7edc4656070b3028d340297ce82ac1d9a97bb30f)，JioNLP repo 2026 年有活動不代表此檔是 2026 詞彙。
- 實際有「人工智能 477509」「晶圆 4558」「晶圆厂 2079」，此次精確 probe 未見 ChatGPT／大模型／台积电／英伟达／元宇宙。簡體取向明確，台灣繁體適用性需另測。
- [LICENSE](https://github.com/dongrixinyu/JioNLP/blob/ab876fd9181d47c1b76531d320eb9019754fd8cd/LICENSE) 是 Apache-2.0；repo 將資料打包發佈，但沒有在 loader 中給這份詞頻語料完整取得時間、來源授權清單，故應區分「repo 發佈授權」和「語料來源可追溯程度」。
- 可由 Rust 離線解 zip + JSONL，產 Jieba 候選或 Meili 字串列表；不需要把 Python／JioNLP runtime 打進 App。不要把原次數直接疊加既有 Jieba 詞頻，因為 token 定義、語料、基數不同。
- 同 repo 的 [chinese_word_dictionary.zip](https://raw.githubusercontent.com/dongrixinyu/JioNLP/ab876fd9181d47c1b76531d320eb9019754fd8cd/jionlp/dictionary/chinese_word_dictionary.zip)實讀 33,988 個「詞＋釋義」；[loader](https://github.com/dongrixinyu/JioNLP/blob/ab876fd9181d47c1b76531d320eb9019754fd8cd/jionlp/dictionary/dictionary_loader.py#L350)自己說舊詞被淘汰、新詞未加入。**不是較新斷詞詞庫首選**。釋義資料另涉原典來源，無需為分詞帶入。
- [idf.zip](https://raw.githubusercontent.com/dongrixinyu/JioNLP/ab876fd9181d47c1b76531d320eb9019754fd8cd/jionlp/dictionary/idf.zip)實讀 270,132 行，值是 IDF，不是詞出現次數；最後檔案 commit [2020-10-19](https://github.com/dongrixinyu/JioNLP/commit/6fac3ce920f6f205fda0de89070f99bfc29b2c65)。不應誤作 Jieba freq。

### A3. pkuseg（可以抽詞，但老且噪音多，排低優先）

固定 snapshot：`071d57c7df9ac0680edda7034b47787d7c6f9184`。

- [default.pkl](https://github.com/lancopku/pkuseg-python/blob/071d57c7df9ac0680edda7034b47787d7c6f9184/pkuseg/dicts/default.pkl) 4,525,959 bytes。此次用 `pickletools` **僅解析 opcode、不執行 pickle**，確認只有 PROTO/BINUNICODE/BINPUT/STOP，實質是 newline 分隔的單一字串，**389,925 行，無詞頻**。
- 該檔最後更新 [2019-02-22 9151ddf](https://github.com/lancopku/pkuseg-python/commit/9151ddf5807cd27faabe262cca78fef61faf347a)。含「台积电」「台股」「金融」，也包含網址、數字、人名、亂碼／標點等，不是可放心直接合併的乾淨詞庫。
- [官方 README](https://github.com/lancopku/pkuseg-python/blob/071d57c7df9ac0680edda7034b47787d7c6f9184/README.md#L154)區分 default/news/web/medicine/tourism **模型**和 user_dict；領域模型不是對應可下載詞頻表。
- [MIT LICENSE](https://github.com/lancopku/pkuseg-python/blob/071d57c7df9ac0680edda7034b47787d7c6f9184/LICENSE)，[README](https://github.com/lancopku/pkuseg-python/blob/071d57c7df9ac0680edda7034b47787d7c6f9184/README.md#L238)表述「本代碼」MIT；詞表沒有獨立來源/授權說明，來源可追溯程度弱於自行整理的領域表。
- 可以離線抽字串轉 Rust text list，但**不提供統計頻率優勢，也不解決詞表新鮮度**。

### A4. jiojio（補充發現：真的有詞/POS/頻次表，但 GPL）

JioNLP 同作者的 CRF 分詞器。固定 snapshot `2007dd6956a842a04732fb1599ad955f6462a359`。

- [dictionary/n.txt](https://github.com/dongrixinyu/jiojio/blob/2007dd6956a842a04732fb1599ad955f6462a359/jiojio/dictionary/n.txt)實讀 49,387 行，例如 `公司\t1.0000\t2941114`；其他 POS 各有檔案。第二欄與第三欄不可混當 Jieba freq，要先讀 [read_default_dict.py](https://github.com/dongrixinyu/jiojio/blob/2007dd6956a842a04732fb1599ad955f6462a359/jiojio/pos/read_default_dict.py) 的使用意義。
- 該 n.txt 最後更動 [2022-08-04](https://github.com/dongrixinyu/jiojio/commit/5d13d7d63d9429286ae86ba4431ddf2eaae07e6a)；[LICENSE](https://github.com/dongrixinyu/jiojio/blob/2007dd6956a842a04732fb1599ad955f6462a359/LICENSE) 為 GPL-3.0，**不可因同作者 JioNLP 是 Apache 就套錯授權**。
- [官方 README](https://github.com/dongrixinyu/jiojio/blob/2007dd6956a842a04732fb1599ad955f6462a359/README.md)的實務方法是 CPU CRF＋規則＋自訂字典，顯示不一定要大型 Transformer；但不是此次分發詞表首選。

## B. 值得借鑑方法，卻不是現成詞庫

### HanLP 2.x：上下文分詞＋高/低優先字典

- [官方 Transformer tokenizer API](https://hanlp.hankcs.com/docs/api/hanlp/components/tokenizers/transformer.html)區分 `dict_force`（輸入最長匹配優先模型）和 `dict_combine`（在模型輸出上合併）；[固定 source](https://github.com/hankcs/HanLP/blob/281e8ef1821bd49d0c4bd38a2111729863e924d0/hanlp/components/tokenizers/transformer.py)。這能解釋為何「增加專名」與「全面強制最大匹配」應分開實驗，強制字典過大可能破壞歧義句。
- 這些 API 接受**使用者提供詞**，不代表有最新公開 domain lexicon。
- [官方當前中文 README 授權章](https://github.com/hankcs/HanLP/blob/281e8ef1821bd49d0c4bd38a2111729863e924d0/README.md#L322)：程式 Apache-2.0，多語模型除特別說明為 CC BY-NC-SA 4.0，中文模型僅研究教學。不能把程式 Apache 當模型打包許可。

### CKIP Transformers：最適合繁體對照模型，但 vocab.txt 不是詞庫

- 固定 [CKIP code README](https://github.com/ckiplab/ckip-transformers/blob/0ac59256949ac3baa853dc9056c070d5e93fe878/README.rst#L206)說明：語言模型用 ZhWiki 20200801＋CNA，WS/POS 用 ASBC；不是 2026 年領域詞彙統計。
- 以官方 [bert-base-chinese-ws](https://huggingface.co/ckiplab/bert-base-chinese-ws/tree/60c22ced1c0ec221242906e8f9fbdf90fb560b77) 和 [albert-tiny-chinese-ws](https://huggingface.co/ckiplab/albert-tiny-chinese-ws/tree/097a391d7cb4bc1784e7268b866fb79629804378) 為例，HF metadata 的最後修改時間是 **2022-05-10**。
- 實下載兩者 `vocab.txt`，各 **21,130 entries**，**9,614 entries 以 `##` 開頭**，包含 `[UNK]`、`[CLS]` 等。這是字／WordPiece input vocabulary。把它當中文詞庫匯入 Meili，會將模型編碼片段誤當詞，不等價於模型斷詞。
- 模型 card 標示 GPL-3.0；[code LICENSE](https://github.com/ckiplab/ckip-transformers/blob/0ac59256949ac3baa853dc9056c070d5e93fe878/LICENSE) 也是 GPL-3.0。可先作獨立離線研究對照；若要隨 App 分發，需評估實際組合與遵循條件。
- Rust 本機執行需要模型 inference runtime、tokenizer 和邊界解碼；Meili settings 沒有「載入 BERT WS 模型」介面。不要為換詞庫而引入這套成本。

### LAC、LTP、THULAC：不是更好的公開新詞頻資源

- [Baidu LAC README](https://github.com/baidu/lac/blob/3e10dbed9bfd87bea927c84a6627a167c17b5617/README.md)：深度模型＋自訂長片段干預字典，字典由使用者自己提供，未找到可直接抽作新版繁體通用詞頻表的資源。snapshot 2021-05-25；repo [LICENSE Apache-2.0](https://github.com/baidu/lac/blob/3e10dbed9bfd87bea927c84a6627a167c17b5617/LICENSE)。它解決模型切分，不提供近期台灣詞表。
- [LTP README](https://github.com/HIT-SCIR/ltp/blob/1f042d48b0a785ff7875b2e63c1439ef8c78995c/README.md#L124)確實有 Rust `CWSModel`，但這是感知機分詞模型，不是新詞庫；[Rust LICENSE](https://github.com/HIT-SCIR/ltp/blob/1f042d48b0a785ff7875b2e63c1439ef8c78995c/rust/ltp/LICENSE)明示企事業與商業使用需付費。Rust 原生不代表自由分發。
- [THULAC README](https://github.com/thunlp/THULAC/blob/a4bb40755dc03664dfba8852c1acefed15f7372b/README.md)說更完整 Model_3 和分詞詞表需申請，常規是模型＋一行一詞的 user dictionary；無直接可取的近期繁體詞頻檔。repo [LICENSE 是 MIT](https://github.com/thunlp/THULAC/blob/a4bb40755dc03664dfba8852c1acefed15f7372b/LICENSE)，但 README 又列商業需洽授權；模型/詞表下載另需申請，因此不把 GitHub MIT badge 當申請資源的發佈授權。

## 建議給 Collector 的最小實驗

1. **資源覆蓋率先做差集**：固定 200–500 個近期語料專名（台灣公司、產品、半導體、金融、中英數混合）；比較現有 Jieba、HanLP core、JioNLP distribution 的 exact coverage。分 raw、繁簡正規化後兩欄；輸出每詞來源與碰撞，不拿大詞數當品質。
2. **詞表與引擎分開測**：先維持相同 Meili/runtime/query 設定，只增人工審核的 dictionary 子集；再另試 Rust Jieba 斷詞。Meili 原生 dictionary 和 Jieba freq 有不同語義，不能以同名詞條假設效果一致。
3. **模型只當比較器**：以 CKIP tiny WS 對自己繁體字幕抽樣產邊界候選，人工評 100–200 句，檢查 CoWoS／先進封裝／ETF 代碼等；同時量搜尋 recall/nDCG，因為語言學分詞 F1 不代表搜尋品質。
4. **領域表獨立更新**：接受詞須有來源、加入日期、原形/標準形、歧義負例；synonyms 另表。可由近期自有 corpus 的高頻未知片段提名，模型提名不自動上線。
5. **對照必須能分辨效果**：包含「研究生命起源」這類跨詞邊界歧義、公司名與普通名詞重疊、產品代碼前導零、英文全形等；記錄新增詞讓哪題改善、哪題退步。通過才進產品，不先整包合併再猜原因。

所有日期均區分 repo snapshot、特定資料檔最後 commit、模型 metadata；下載實物檢查只證明格式、筆數與抽樣內容，沒有驗證實際搜尋品質改善。
