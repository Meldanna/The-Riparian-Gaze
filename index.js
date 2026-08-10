/* 河岸凝视 v1 */
(function () {
    "use strict";
    window.onerror = function(msg, src, line, col, err) {
        console.error("[河岸凝视] 语法/运行时错误 → " + msg + " | 文件:" + src + " | 行:" + line + " 列:" + col);
    };

    var EXT_NAME = "RiparianGaze";
    var METADATA_KEY = "tlg_data";

    /* ============================================================
     * 模块 0 — 常量
     * ============================================================ */
    var C = {
        NODE_RADIUS: 22,
        NODE_HIT_MARGIN: 4,
        CAUSAL_H_GAP: 180,
        CAUSAL_V_GAP: 120,
        GEO_X_GAP: 180,
        GEO_Y_GAP: 70,
        CANVAS_MIN_ZOOM: 0.2,
        CANVAS_MAX_ZOOM: 5,
        DRAG_THRESHOLD: 4,
        MAX_RETRIES: 3,
        RETRY_BASE_DELAY: 3000,
        TOAST_DURATION: 2800
    };

    /* ============================================================
     * 模块 1 — 核心状态 & 全部默认提示词
     * ============================================================ */
        var state = {
        nodes: [],
        currentNodeId: null,
        selectedNodeId: null,
        summaries: [],
        memories: [],
        turnsSinceAnchor: 0,
        _lastChatLen: 0,
        lastAutoSummaryRange: null,
        _jumpedToIdx: null,
        _chatLenAtJump: null
    };
    
    var _digestTimer = null;
    var _digestCountdown = 0;
    var _lastDigestMemoryId = null;
    var globalApi = {
        apiUrl: "", apiKey: "", model: "", modelList: [],
        vectorUrl: "", vectorKey: "", vectorModel: "", vectorModelList: [],
        rerankUrl: "", rerankKey: "", rerankModel: "", rerankModelList: [],
        vectorTopK: 8, rerankTopN: 3, vectorThreshold: 0, rerankThreshold: 0,
        vectorQueryWindow: 5, vectorChunkLen: 600, vectorInjectDepth: 0, vectorMaxChars: 4000,
        digestUrl: "", digestKey: "", digestModel: "", digestModelList: [],
        queryRefinePrompt: "你是\"向量索引构造仪\",任务是从当前对话语境中提取所有具有检索价值的信息,供向量数据库检索历史事实单元使用。你不做判断、不做评分、不做解释,只做提炼。\n\n【提炼规则——每一类都穷尽提取,不限数量,有多少提多少】\n\n1. 时间信息:当前语境中所有时间相关表述。没有则该行不输出。\n\n2. 地理坐标:当前所处的具体位置,以及对话中提及的所有其他地点。每个地点用\"/\"分隔层级。没有则该行不输出。\n\n3. 物品全称:当前对话中被提及、被使用、被观察、被寻找、被讨论的所有物品。必须用其在文中出现的全称。没有则该行不输出。\n\n4. 角色姓名:当前正在互动的、被提及的、被讨论的所有角色。只写姓名本体。没有则该行不输出。\n\n5. 状态关键词:当前语境中涉及的所有角色状态、物品状态、关系状态。没有则该行不输出。\n\n6. 事件关键词:当前情节中正在发生、刚刚发生、或被回忆讨论的事件核心词。没有则该行不输出。\n\n【质量规则】\n- 每个关键词必须是名词或名词短语,禁止动词短语、禁止完整句子。\n- 禁止输出同义重复项——只保留信息量更大的那个。\n- 禁止输出通用词(\"房间\"\"东西\"\"有人\"\"事情\"这类无检索价值的词)。\n- 禁止编造原文中不存在的词。\n\n【输出格式(唯一允许的格式,空类不输出该行)】\n[TIME]: <逗号分隔>\n[PLACE]: <逗号分隔>\n[ITEM]: <逗号分隔>\n[CHAR]: <逗号分隔>\n[STATE]: <逗号分隔>\n[EVENT]: <逗号分隔>\n\n现在基于以下最新对话内容提取:\n{{context}}",
        digestPrompt: "你是因果观测仪。你的任务是阅读这一轮对话,把发生的事情整理成一份 JSON 档案,直接输出 JSON 对象,不要任何额外文字,不要输出 markdown。\n\n【输出格式】\n{\n  \"narrative\": \"(必填)本轮发生事件的完整自然语言叙述。\",\n  \"turn_time\": \"本轮剧情内时间,原文无则 null\",\n  \"location\": {\n    \"path\": [\"一级地名\", \"二级地名\", \"三级地名\", \"四级地名\"],\n    \"desc\": \"简介,只在新地点或有新信息时写,否则 null\",\n    \"is_current\": true,\n    \"moved_from\": null\n  },\n  \"characters\": [\n    { \"name\": \"该角色目前已知的最完整专有名字\", \"aliases\": [\"本轮出现的其他称呼\"], \"role\": \"身份\", \"state_delta\": \"变化\", \"present\": true, \"certain\": true, \"age\": \"年龄(首次明确或变化才填)\" }\n  ],\n  \"items\": [\n    { \"name\": \"物品标准名\", \"aliases\": [\"本轮出现的其他说法\"], \"change\": \"变动类型\", \"owner\": \"持有者\", \"state\": \"状态\", \"certain\": true }\n  ],\n  \"key_events\": [\"关键词1\", \"关键词2\"],\n  \"unresolved\": [\"悬置线索1\"],\n  \"importance\": 7\n}\n\n--------------------------------\n【narrative 字段写作规则——这是唯一会被向量化的字段,决定检索质量】\n\n1. 不限字数。信息量大就写多,日常寒暄可以短。穷尽记录,不省略。\n2. 每个事件必须写成完整的\"时间+地点+人物+动作+结果\"绑定句,禁止让任何要素脱节。\n   正确:\"入夜后,林夜在朝露客栈二楼天字房被持刀男子拦截索要青铜怀表,拒绝后右臂被刺伤。\"\n   错误:\"有人索要怀表。林夜受伤了。在客栈里。入夜后。\"\n3. 角色首次出现时必须带身份标注(如\"苏晚(术士)\"),后续同一段内可只用名字。\n4. 因果关系用\"因此/导致/随后\"等连接词显式串联。\n5. 关系变化和情绪转折要写明触发原因。\n6. 地点移动要写\"从A前往B\"。\n7. 物品状态变化要写\"某物从A状态变为B状态\"。\n8. 保留重要对话的核心语义。\n9. 禁止在 narrative 里使用依赖叙述时点的浮动时间词(\"今天\"\"昨天\"\"明天\"\"当晚\"\"次日\"\"第二天\"等)。如果原文用了这些词,必须根据上下文提供的故事内时间换算成固定时间后再写入。例如:\"她说明天再来\"→写成\"她约定于[具体时间]再来\"。若时间锚点不足以换算,只保留先后关系并注明\"具体时间未确定\",不要猜造日期。\n\n--------------------------------\n【地点规则——手把手教你怎么对照地图,像在翻地图册一样一页一页翻】\n\n【第 0 步:先判断这一轮要不要输出 location,再决定怎么写】\n\n在开始下面的地点匹配步骤之前,先回答这一个问题:\"这一轮原文里,有没有提到任何新的位置信息,或者发生了场景切换?\"\n\n- 没有新信息、场景延续自上一轮 → 整个 location 字段直接输出 null,不要重复填写上一轮的地点,也不要编。跳过下面所有步骤。\n- 这个场景本来就不依附于具体空间(内心独白、电话通话、梦境、纯对话不涉及移动等)→ 同样输出 null。\n- 有新的场景信息,但原文给出的信息不足以判断具体是哪里 → 不要编造一个具体地名,也不要用\"未知\"\"某处\"\"不明地点\"这类词填进 path。如果原文确实存在一个笼统但真实的描述(比如\"树林\"本身),可以把这个描述当作最后一层地名;如果连这种描述都没有,整个 location 输出 null。\n- 有新的场景信息,且能判断出具体地点 → 才开始执行下面的第一步、第二步......\n\n绝对不允许用\"未知\"\"未知所在\"\"某地\"\"不明位置\"这类空洞占位词填进 path 里的任何一段——这些词一旦被当成地名写入,会被系统当成一个真实地点建档。\n\n注意:narrative 里事件要素要写全(包括提到地点),这是叙事句子内部的要求,跟 location 字段本身是否要填是两件事——narrative 提到的地点即使是延续自上一轮、没有变化,location 字段依然应该输出 null。\n\n上下文会给你一份\"已记录地点\",它是一棵树形 JSON,例如:\n\n{\n  \"甲国\": {\n    \"desc\": \"大陆东部王国\",\n    \"children\": {\n      \"乙省\": {\n        \"children\": {\n          \"云城\": { \"children\": { \"首都路\": {} } },\n          \"雾城\": { \"children\": { \"首都路\": {} } }\n        }\n      },\n      \"丁省\": {\n        \"children\": {\n          \"山城\": { \"children\": { \"首都路\": {} } }\n        }\n      }\n    }\n  },\n  \"乙国\": {\n    \"children\": {\n      \"乙省\": { \"children\": {} }\n    }\n  }\n}\n\n注意这棵树里有两个\"乙省\"——一个在\"甲国\"下,一个在\"乙国\"下。它们是完全不同的地方,因为它们各自的上级(父节点)不同。同样,\"乙省/云城\"下的\"首都路\"和\"乙省/雾城\"下的\"首都路\"也是两条完全不同的街道,它们只是碰巧同名,绝对不是同一条路。这就像甲国有11个省,每个省都有一座\"首都\"——它们不是同一座城市,只是每个省各自的省会恰好都叫首都而已。\n\n请按下面的步骤操作,每一步都要做,一步都不能跳过,也不能倒序:\n\n第一步:确定当前地点在树里的「起点」——从树的最外层(第一层)开始找。\n  - 翻开树的最外层,把所有顶级地名列出来,比如上面例子里是「甲国」和「乙国」。\n  - 把本轮对话里提到的最宏观地名(比如国家、大区、星球)和这个列表一一对照。\n  - 如果找到了匹配,就进入那个节点的 children,进行第二步。\n  - 如果最外层里完全没有能匹配的,说明这是一个新的顶级地点,直接新建,写你在原文里读到的名字。不要把它硬塞到某个已有的国家/大区下面——没有上级就没有上级,顶级节点允许新建。\n\n第二步:在刚才进入的 children 里,找下一级地名。\n  - 只在这一层的兄弟节点里找,不要跨层、不要跨分支。\n  - 「兄弟节点」的意思是:同一个父节点 children 下的所有直接子节点,别的分支下的节点不算兄弟,哪怕名字一样。\n  - 如果这一层找到了匹配,进入它的 children,继续下一步;如果找不到,新建,写原文名字。\n\n第三步、第四步......以此类推,一层层往下,直到把本轮地点的所有层级都处理完。\n\n关于层级深度:地点的层级要尽可能写全,不要偷懒只写最后一层。一个完整的地址可能有五六层,比如「甲国 / 乙省 / 云城 / 北区 / 朝露街 / 3号客栈」,每一层都要写进 path 数组,不要省略中间的层级。如果本轮只能确定到某一层(比如只知道在\"乙省\",不知道具体哪个城市),那就写到那一层,不要捏造更细的层级。\n\n关于「找到了」的判断标准:两个地名只要满足以下任意一条,就认为是同一个地方:\n  - 完全一样(去掉空格后)\n  - 一个是另一个去掉常见地理后缀(城/镇/村/国/区/路/楼/山/岛等)后的结果,而且去掉后的核心词长度不少于原来的一半(防止太短的词乱匹配)\n  - 注意:只在当前这一层的兄弟节点里用这个标准判断,找到了才算找到,其他分支里的同名节点不算。\n\n关于更新描述:如果某地点的 desc 需要更新(发生了实质变化,或在此地发生了值得记入档案的关键事件),更新时必须写出累积后的完整描述——保留原有要点,再把新信息并入。例如:某地原描述是\"男女主初遇的地方\",后来又在此分手,更新时要写\"男女主初遇、也是后来分手的地方\",而不是只写\"分手的地方\"(这样会丢失初遇的信息)。\n\n────────────────────────────────\n【人物规则——先认人,再认称呼,最后才判断这条信息该挂在谁头上】\n\n上下文会给你两样东西:\n  A. \"已建档角色\"列表:这个世界里目前已经有档案的角色,格式是「名字(身份)」,比如「陈明(高中语文教师)、林小满(学生)」。\n  B. \"本轮可能在场角色\"列表:根据最近几回合出现过的角色筛选出来的名单,同样是「名字(身份)」格式。这只是参考范围,不是保证名单里的人这轮一定出现。\n\n第一步:先建立「本轮角色底稿」。\n读完整段对话,把你能确认专有名字的角色列出来,每人一条。判断方法:\n  - 原文直接叫了这个名字(比如\"陈明说......\")→ 直接用,certain=true。\n  - 原文只用了称呼/身份(比如\"老师说......\")→ 暂时不填 name,先记下这个称呼和对应的上下文,等第二步处理。\n\n第二步:处理称呼消歧。\n对于第一步里每一个「只知道称呼、不知道名字」的角色,按下面的决策树操作:\n\n  情况 A:「老师」这个称呼——去 B 名单里找身份包含「教师/老师」的人。\n    - B 名单里只有陈明(高中语文教师)符合 → name=陈明,certain=true。\n    - B 名单里同时有陈明(高中语文教师)和王芳(体育教师)符合,而这段原文没有更多信息分清是谁 → name 填你觉得更可能的那个,certain=false,state_delta=null。宁可记成「不确定」,也不要把事情安在错的人头上——记错了以后没法自动改。\n    - B 名单里完全没有符合的 → 这可能是新角色,但目前只知道称呼不知道名字,跳过这条,不要把「老师」当名字建档。\n\n  情况 B:「哥哥」这个称呼——同样查 B 名单里是否有角色的身份/关系标注里有「兄/哥哥」字样。\n    - 如果陈明的档案里有「林小满的哥哥」这类信息,且 B 名单里没有其他可能的哥哥 → name=陈明,certain=true。\n    - 找不到 → certain=false,或者跳过。\n\n  情况 C:同一段里「A」「A老师」「哥哥」都出现了,而且根据上下文(比如林小满叫了一声「哥哥」然后陈明回头了),可以确认这三个称呼指的是同一个人 → 这三个称呼只建一条记录,name 用「陈明」,aliases 填 [\"A老师\", \"哥哥\"]。\n\n  情况 D:「B老师」出现了,而 B 名单里只有陈明是老师,没有姓 B 的老师 → 这是新角色,name 先写「B老师」(因为目前只知道这个称呼),certain=true(称呼本身是确定的,不确定的是背后有没有完整名字)。等后续原文揭露了全名,再合并。\n\n第三步:与「已建档角色」对照,决定是新建还是更新。\n  - 如果 name 在已建档列表里能精确匹配到 → 更新这个人的档案,写 state_delta。\n  - 如果 name 在已建档列表里找不到 → 新建档案。\n  - 不做模糊合并:「陈明」和「陈老师」不会被代码自动合并,你在 aliases 里把它们都列出来,由人工合并工具处理,比代码猜错更安全。\n\n关于年龄字段(age):\n  - 只在原文**首次明确提到**某角色年龄,或明确说明年龄发生了变化(过生日、时间跨越、魔法变老/变年轻)时填写。\n  - 写原文的原话值(如\"25\"\"二十出头\"\"看上去四十多岁\"),不要自己按时间流逝换算——系统会记录此刻的故事时间作锚点,以后随剧情时间自动推算。\n  - 首次填写年龄时,如果原文提到了该角色的经历(如\"在这行干了十年\"\"五年前从老家来\"),务必在 state_delta 里一并记录这些经历,因为这是首次建档、可能是唯一机会记录背景。年龄更新时(如过了生日、时间跨越后再次明确年龄),也要在 state_delta 里记录促成变化的原因(如\"度过了25岁生日\"\"在时间法阵里度过三年\")。\n  - 已建档且有年龄的角色,如果本轮没有明确提到年龄变化,不要重复填写 age。\n\n────────────────────────────────\n【物品规则——同一件东西可能有很多种说法,要认出来是同一件】\n\n上下文会给你一份「已记录物品」列表。\n\n处理方法和人物类似:先用标准名(已记录列表里的名字)作为 name,再把本轮原文里对这件东西的其他描述性说法填进 aliases。\n\n举例:已记录物品列表里有「封印之盒」。本轮原文里,有人叫它「那个黑盒子」,有人叫它「有浮雕的盒子」,有人叫它「封印着什么东西的容器」。你应该:\n  - name = 「封印之盒」(用已记录的标准名)\n  - aliases = [\"那个黑盒子\", \"有浮雕的盒子\", \"封印着什么东西的容器\"]\n\n如果已记录列表里完全没有这件东西,说明它第一次出现,用原文里最完整、最有辨识度的那个说法作为 name(不要用「那个盒子」这种太泛的描述),aliases 填其他说法。\n\n如果一件东西 certain=false(比如只说「有人拿走了一件东西」,不知道具体是什么),change 留 null,进待审队列,不直接归档。\n\n关于同名不同物:如果两件东西同名但明显是不同的物品(比如两把都叫「青锋剑」的剑,分属不同角色,来源不同),处理方式和地理树里同名不同地点一样——只要不能确定是同一件,就当作不同物品分别记录,不要因为同名就合并成一件。\n\n────────────────────────────────\n【certain 字段说明】\n\ncharacters 和 items 里每一条都要加 certain 布尔值:\n  - true:原文里明确、清楚地说了这件事,你对这条信息有把握。\n  - false:你是根据上下文推测出来的,不完全确定,或者这条信息有歧义没有解决。\n\ncertain=false 的条目不会直接写进正式档案,会进入待审队列等待人工确认,所以请如实填写,不要为了省事全部写 true。\n\n注意:state_delta 为 null 或不填,意思是\"本轮该角色没有新变化\",这不等于不确定——确定没有变化,certain 仍然填 true,不进待审队列。只有你对\"这条信息是否属实\"本身有疑问时,才填 certain=false。\n\n────────────────────────────────\n【其他字段规则】\n\n- turn_time:本轮剧情内时间(如\"入夜后\"\"第三天清晨\")。原文完全无时间信息则 null。\n- location.is_current:主角当前是否在此处。\n- location.moved_from:本轮发生了位置移动则填出发地 path 数组,否则 null。\n- characters:只列本轮有实质互动或状态变化的角色。role 填身份标签。state_delta 用叙事句描述该角色本轮关键经历,格式\"在[地点][做了什么],[结果/状态变化]\"。禁止只写数值变动,必须写成叙事。\n- items:只列本轮有状态变动的物品。无变动则空数组。\n- key_events:3-8个关键词/短语,必须是名词或名词短语。\n- unresolved:本轮出现但未解决的伏笔/悬念。无则空数组。\n- importance:1-10分。日常寒暄1-3,一般推进4-6,关键转折/战斗/揭秘/关系巨变7-10。\n- 无相关内容的字段输出 null 或空数组。\n\n{{turn_time_hint}}\n\n对话内容:\n{{context}}",        
        digestAutoMode: true, digestGraceSeconds: 15, digestBatchSize: 1, factUnitsMaxCount: 500,
        rerankUseLLM: false,
        rerankLLMPrompt: "你是\"因果一致性终审官\",负责对向量检索召回的历史事实单元进行相关性终审评分,筛出真正有用的记忆,过滤噪音。你不生成叙事文本,不改写片段内容,只打分排序。\n\n【输入】\n- 当前语境摘要:{{current_context_summary}}\n- 当前语境时间信息:{{current_time}}(可能为空)\n- 当前语境地点信息:{{current_place}}(可能为空)\n- 待评分事实单元列表(含ID、回合号):{{candidate_fragments}}\n\n【前置规则:同实体/同物品状态去重(在打分之前执行,优先级最高)】\n1. 将候选片段按其[E]或[I]中出现的实体/物品全称分组。\n2. 组内若存在多条记录同一实体/物品但状态互斥,只保留回合号最新的一条参与后续打分;其余较旧记录标记!HISTORICAL。\n3. 若当前语境包含回忆性触发词(\"想起\"\"曾经\"\"对比之前\"\"记得那时\"\"回忆\"等),则!HISTORICAL记录可重新参评,但ID后保留!HISTORICAL标记。\n4. !HISTORICAL与!CONFLICT是两套独立标记,互不覆盖。\n\n【评分权重准则(总分10分,仅对通过前置规则的片段执行)】\n1. 实体一致性(权重50%,最多5分):片段中的[I]物品或[E]实体,是否与当前语境完全匹配且状态相关。完全匹配且状态相关:5分。部分匹配:2-3分。无匹配:0分。\n2. 动作连续性(权重30%,最多3分):该片段的[A]动作或[C]因果,是否构成当前语境中正在发生动作的起因/前序/直接后果。是:2-3分。间接关联:1分。无关:0分。\n3. 环境逻辑(权重20%,最多2分):片段的[T]时间和[L]地点与当前语境是否兼容。一致或当前信息为空:2分。不确定但不矛盾:1分。明显矛盾:0分,并标记!CONFLICT。\n\n【特殊规则】\n- !CONFLICT片段无论总分多少,强制排在最前。\n- 严禁对片段内容做任何改写、总结或解释。\n- 严禁输出评分依据或分析过程。\n\n【输出格式(唯一允许的格式)】\n按分数从高到低排列的片段ID列表,逗号分隔,标记紧跟ID。\n示例:frag_014!CONFLICT,frag_007,frag_022!HISTORICAL,frag_003\n\n现在开始评分。",
        vectorPrompt: "以下为因果档案库中与当前观测焦点相关的历史切片:\n\n{{context}}\n\n处理规则:\n- 这些是已铭刻的因果事实,不可篡改\n- 当前叙事必须与这些记录在逻辑上连续\n- 若当前事件是某条历史线的后果,自然呈现因果关系\n- 不要直接引用或复述这些档案内容",
        summaryPrompt: "你是因果记录仪。对以下对话内容执行全量信息提取,输出一份完整的因果档案,字数在300-500。\n\n【提取要求——不缩写、不省略、不合并】\n\n这份档案将直接注入AI上下文供叙事引擎参考,也供人类玩家回顾。任何遗漏都会导致后续剧情失忆或穿帮。你的职责是\"穷尽记录\"而不是\"精简字数\"。\n\n按以下分类逐一提取,有内容就写,没有就跳过该类(不写\"无\"或\"暂无\"):\n\n【因果事件链】\n本段中发生的所有事件,按时间顺序逐条列出。每条写清楚:谁、在哪、对谁、做了什么、直接结果是什么。事件之间如果存在因果关系(A导致B导致C),用\"→\"标明因果方向。不存在因果关系的并行事件各自独立成条。\n- 不合并:两个独立事件不要压进一句话。\n- 不省略:哪怕是\"小事\"(如某人说了一句关键台词、某人递出一个物品),只要它对理解剧情有价值,就单独列出。\n\n【角色状态变动】\n所有在本段中出现的角色(包括主角),每人单独列出这段时间内的状态变化过程:\n- 不要只写\"结束时\"的状态快照\n- 要写\"从什么变成了什么\"的变化轨迹\n- 如果某项在这段时间内没有变化,写\"未变\"并注明维持的状态是什么\n- 如果某项经历了多次变化,按顺序全部写出\n\n格式(每人一段):\n角色名(身份)\n- 生理变化:从xxx到xxx(原因:xxx)。若未变:维持xxx状态。\n- 心理变化:从xxx到xxx(触发事件:xxx)。若未变:维持xxx倾向。\n- 关系变化:与[角色名]从xxx变为xxx(触发事件:xxx)。若无变化可不写此项。\n- 位置变化:从xxx移动到xxx。若未移动:始终在xxx。\n- 物品变化:获得/失去/使用了xxx。若无变动可不写此项。\n\n【物品变动明细】\n所有在本段中发生状态变化的物品,逐个列出:\n- 物品全称\n- 变动类型(获得/失去/使用/损毁/移交/发现/状态改变)\n- 变动前状态 → 变动后状态\n- 当前持有者\n没有物品变动则跳过此类。\n\n【地理信息】\n本段中出现的所有地点,包括:\n- 当前所在地(写完整层级,如\"青州/云隐镇/朝露客栈/二楼\")\n- 新发现的地点(写完整层级 + 关键特征描述)\n- 地点间的移动轨迹(从哪到哪,经过了哪里)\n没有地理信息则跳过此类。\n\n【新揭示信息】\n本段中首次揭露的、此前未知的信息(身世、秘密、规则、历史、真相等),逐条列出。每条写清楚\"揭示了什么\"以及\"由谁/通过什么方式揭示\"。\n没有则跳过。\n\n【悬置因果线】\n本段中出现但尚未解决/尚未产生后果的事项:\n- 未完成的选择\n- 被打断的事件\n- 未触发的后果\n- 埋下的伏笔\n- 引发的疑问\n逐条列出,每条写清楚\"什么事悬着\"以及\"为什么还没解决\"。\n没有则跳过。\n\n【格式规则】\n- 纯文本输出,禁止使用任何markdown标记(禁止*、**、#、-等符号)\n- 类别标题用【】包裹\n- 直接输出内容,不要开场白、不要结尾总结\n- 信息量大就输出多,这是正确行为,提取角色的重要对话语句(非全部对话),不要自行精简\n\n对话内容:\n{{context}}",
        compressPrompt: "以下是若干条历史因果档案,请将其浓缩合并为一条,保留所有关键事件、状态变化和悬置因果线,删除重复和次要细节。输出格式:纯文本,禁止markdown标记,直接输出内容。\n\n{{context}}",
        pathSummaryPrompt: "以下是一条命运路径上的节点描述和相关因果档案。请为这条路径生成一段完整的剧情摘要,概括主要事件走向、关键转折和当前状态。长度200~400字,确保信息充分。输出格式:纯文本,禁止markdown标记,直接输出内容。\n\n{{context}}",
        summaryFilterMode: true,
        autoMode: false, autoInterval: 10, lastNMessages: 5,
        jumpSummary: true,
        summaryMaxCount: 100,
        autoCompress: false,
        compressBatchSize: 10,
        manualCount: 20
    };

    var worlds = {};
    var currentWorldId = null;
    var canvas = null, ctx = null;
    var camX = 0, camY = 0, camZoom = 1;
    var isPanning = false, panStartX = 0, panStartY = 0;

    function getST() {
        return (window.SillyTavern && window.SillyTavern.getContext)
            ? window.SillyTavern.getContext() : null;
    }
    function generateId() {
        return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    }
    function toast(msg, duration) {
        duration = duration || C.TOAST_DURATION;
        var el = document.createElement("div");
        el.textContent = msg;
        el.style.cssText = "position:fixed;left:50%;top:16px;transform:translateX(-50%);max-width:80vw;padding:12px 18px;background:#050508;border:1px solid #3a3a4a;border-radius:4px;color:#ffffff;font-size:13px;z-index:2147483647;text-align:center;pointer-events:none;opacity:1;transition:opacity 0.4s;box-shadow:0 4px 20px rgba(0,0,0,0.8);";
        document.body.appendChild(el);
        setTimeout(function () { el.style.opacity = "0"; setTimeout(function () { el.remove(); }, 400); }, duration);
    }
    function flashBtn(btn) {
        if (!btn) return;
        var orig = btn.style.borderColor || "";
        btn.style.borderColor = "#ffffff";
        btn.style.boxShadow = "0 0 10px rgba(255,255,255,0.3)";
        setTimeout(function () { btn.style.borderColor = orig; btn.style.boxShadow = ""; }, 300);
    }
    function escHtml(str) {
        return String(str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }
    function setupDragAutoScroll(scrollContainer) {
        var EDGE = 40, SPEED = 6, _raf = null;
        function tick(clientY) {
            if (!scrollContainer) return;
            var rect = scrollContainer.getBoundingClientRect();
            var distTop = clientY - rect.top;
            var distBot = rect.bottom - clientY;
            if (distTop < EDGE && scrollContainer.scrollTop > 0) {
                scrollContainer.scrollTop -= SPEED;
            } else if (distBot < EDGE && scrollContainer.scrollTop < scrollContainer.scrollHeight - scrollContainer.clientHeight) {
                scrollContainer.scrollTop += SPEED;
            }
        }
        scrollContainer.addEventListener("dragover", function(e) {
            tick(e.clientY);
        });
    }
    // ══════════════════════════════════════
    // 存储层
    // ══════════════════════════════════════
    function getExtSettings() {
        var st = getST();
        var es = (st && st.extensionSettings) || window.extension_settings || {};
        if (!es[EXT_NAME]) es[EXT_NAME] = { enabled: true, api: {}, worlds: {} };
        return es[EXT_NAME];
    }
    function saveExtSettings() {
        var st = getST();
        if (st && typeof st.saveSettingsDebounced === "function") st.saveSettingsDebounced();
        else if (typeof window.saveSettingsDebounced === "function") window.saveSettingsDebounced();
    }
    function isEnabled() { try { return getExtSettings().enabled !== false; } catch (e) { return true; } }
    function setEnabled(on) {
        try {
            getExtSettings().enabled = !!on; saveExtSettings();
            if (!on) closePanel(); injectMenuButton();
            var toggle = document.getElementById("tlg_enable_toggle");
            if (toggle) toggle.classList.toggle("on", !!on);
        } catch (e) {}
    }
        function loadGlobalApi() {
        var es = getExtSettings();
        if (es.api) {
            var keys = Object.keys(globalApi);
            for (var i = 0; i < keys.length; i++) {
                var k = keys[i];
                if (es.api[k] === undefined) continue;
                if (es.api[k] === "" && typeof globalApi[k] === "string" && globalApi[k].length > 0) continue;
                globalApi[k] = es.api[k];
            }
        }
    }
    function saveGlobalApi() { var es = getExtSettings(); es.api = JSON.parse(JSON.stringify(globalApi)); saveExtSettings(); }
    function loadWorlds() { var es = getExtSettings(); if (es.worlds) worlds = JSON.parse(JSON.stringify(es.worlds)); }
    function saveWorlds() { var es = getExtSettings(); es.worlds = JSON.parse(JSON.stringify(worlds)); saveExtSettings(); }

    function loadTurnsCounter() {
        var es = getExtSettings();
        if (typeof es.turnsSinceAnchor === "number") state.turnsSinceAnchor = es.turnsSinceAnchor;
    }
    function saveTurnsCounter() {
        var es = getExtSettings();
        es.turnsSinceAnchor = state.turnsSinceAnchor;
        saveExtSettings();
    }

    function getCurrentChatId() {
        var st = getST(); if (!st) return "";
        return st.chatId || (st.getCurrentChatId && st.getCurrentChatId()) || "";
    }
    function getLinkedWorldId() {
        var st = getST(); if (!st || !st.chat_metadata) return null;
        return st.chat_metadata.tlg_worldId || null;
    }
    function setLinkedWorldId(worldId) {
        var st = getST(); if (!st) return;
        if (!st.chat_metadata) st.chat_metadata = {};
        st.chat_metadata.tlg_worldId = worldId;
        if (typeof st.saveMetadata === "function") st.saveMetadata();
        else if (typeof window.saveMetadataDebounced === "function") window.saveMetadataDebounced();
        setTimeout(function () {
            var verify = getST();
            if (verify && verify.chat_metadata && verify.chat_metadata.tlg_worldId !== worldId) {
                if (verify.chat_metadata) verify.chat_metadata.tlg_worldId = worldId;
                if (typeof verify.saveMetadata === "function") verify.saveMetadata();
            }
        }, 800);
    }
    function loadCurrentWorld() {
        loadGlobalApi(); loadWorlds(); loadTurnsCounter();
        var worldId = getLinkedWorldId();
        if (!worldId) {
            var chatId = getCurrentChatId();
            if (chatId) {
                var ids = Object.keys(worlds);
                for (var i = 0; i < ids.length; i++) { if (worlds[ids[i]].chatId === chatId) { worldId = ids[i]; break; } }
                if (worldId) setLinkedWorldId(worldId);
            }
        }
        if (worldId && worlds[worldId]) {
            currentWorldId = worldId; var w = worlds[worldId];
            state.nodes = w.nodes || []; state.summaries = w.summaries || [];
            if (!state.nodes.length || !state.nodes.find(function(n) { return !n.parentId; })) {
                var rootId = generateId();
                state.nodes.unshift({ id: rootId, name: "起源点", brief: "时间线起源。", parentId: null, msgIdx: 0, statData: null, timestamp: Date.now(), children: [] });
                if (!state.nodes.find(function(n) { return n.id === w.currentNodeId; })) w.currentNodeId = rootId;
            }
                        state.currentNodeId = w.currentNodeId || (state.nodes.length ? state.nodes[0].id : null);
            state.selectedNodeId = null;
            var stMeta = getST();
            if (stMeta && stMeta.chat_metadata && typeof stMeta.chat_metadata._tlg_jumpedToIdx === "number") {
                state._jumpedToIdx = stMeta.chat_metadata._tlg_jumpedToIdx;
                state._chatLenAtJump = stMeta.chat_metadata._tlg_chatLenAtJump || 0;
            } else {
                state._jumpedToIdx = null;
                state._chatLenAtJump = null;
            }
            state.memories = w.memories || [];
        } else {
            currentWorldId = null; resetState();
        }
        updateInjectionWithVector();
    }
    function saveCurrentWorld() {
        if (!currentWorldId || !worlds[currentWorldId]) return;
        worlds[currentWorldId].nodes = JSON.parse(JSON.stringify(state.nodes));
        worlds[currentWorldId].summaries = JSON.parse(JSON.stringify(state.summaries));
        worlds[currentWorldId].memories = state.memories ? JSON.parse(JSON.stringify(state.memories)) : [];     
        worlds[currentWorldId].currentNodeId = state.currentNodeId;
        worlds[currentWorldId].updatedAt = Date.now();
        saveWorlds(); updateInjectionWithVector();
    }
    function ensureWorldExists() {
        if (currentWorldId && worlds[currentWorldId]) return currentWorldId;
        var chatId = getCurrentChatId();
        var name = chatId || ("世界 " + (Object.keys(worlds).length + 1));
        var wid = generateId();
        worlds[wid] = {
            id: wid, name: name, chatId: chatId, nodes: JSON.parse(JSON.stringify(state.nodes)),
            summaries: JSON.parse(JSON.stringify(state.summaries)), currentNodeId: state.currentNodeId,
            pinnedPaths: [],
            createdAt: Date.now(), updatedAt: Date.now()
        };
        currentWorldId = wid; setLinkedWorldId(wid); saveWorlds(); return wid;
    }
    function migrateOldData() {
        var st = getST(); if (!st || !st.chat_metadata) return;
        var old = st.chat_metadata[METADATA_KEY];
        if (!old || !old.nodes || !old.nodes.length) return;
        if (getLinkedWorldId()) return;
        var chatId = getCurrentChatId(); var wid = generateId();
        worlds[wid] = {
            id: wid, name: chatId || "迁移世界", chatId: chatId, nodes: old.nodes, summaries: old.summaries || [],
            currentNodeId: old.currentNodeId || old.nodes[0].id, pinnedPaths: [],
            createdAt: Date.now(), updatedAt: Date.now()
        };
        currentWorldId = wid; setLinkedWorldId(wid);
        if (old.settings) {
            var keys = Object.keys(globalApi);
            for (var i = 0; i < keys.length; i++) {
                if (old.settings[keys[i]] !== undefined && !globalApi[keys[i]]) globalApi[keys[i]] = old.settings[keys[i]];
            }
            saveGlobalApi();
        }
        state.nodes = worlds[wid].nodes; state.summaries = worlds[wid].summaries; state.currentNodeId = worlds[wid].currentNodeId;
        saveWorlds(); toast("已从旧版数据迁移");
    }
    function resetState() {
        var rootId = generateId();
        state.nodes = [{ id: rootId, name: "起源点", brief: "时间线起源。", parentId: null, msgIdx: 0, statData: null, timestamp: Date.now(), children: [] }];
        state.currentNodeId = rootId; state.selectedNodeId = null; state.summaries = []; state.memories = []; state.turnsSinceAnchor = 0; state._lastChatLen = 0;
    }
    function findNode(id) { return state.nodes.find(function (n) { return n.id === id; }) || null; }
    function getPathToRoot(nodeId) {
        var path = [], visited = {}, cur = findNode(nodeId);
        while (cur && !visited[cur.id]) {
            visited[cur.id] = true;
            path.unshift(cur.id);
            cur = findNode(cur.parentId);
        }
        return path;
    }

    // ══════════════════════════════════════
    // MVU 变量读写
    // ══════════════════════════════════════
    function getMVUStatData() {
        try {
            if (window.__tlg_mvu_snapshot && Object.keys(window.__tlg_mvu_snapshot).length > 0) {
                return JSON.parse(JSON.stringify(window.__tlg_mvu_snapshot));
            }
            if (typeof window.Mvu !== "undefined" && typeof window.Mvu.getMvuVariable === "function") {
                var v = window.Mvu.getMvuVariable("stat_data");
                if (v != null) return JSON.parse(JSON.stringify(v));
            }
            var st = getST(); if (!st || !st.chat_metadata) return null;
            var cm = st.chat_metadata;
            if (cm.variables && cm.variables.stat_data != null) return JSON.parse(JSON.stringify(cm.variables.stat_data));
            if (cm.script_variables && cm.script_variables.stat_data != null) return JSON.parse(JSON.stringify(cm.script_variables.stat_data));
            if (cm.stat_data != null) return JSON.parse(JSON.stringify(cm.stat_data));
        } catch (e) {}
        return null;
    }
    function setMVUStatData(data) {
        if (data == null) return;
        try {
            window.__tlg_mvu_snapshot = JSON.parse(JSON.stringify(data));
            var iframes = document.querySelectorAll("iframe");
            for (var i = 0; i < iframes.length; i++) {
                try {
                    var win = iframes[i].contentWindow;
                    if (win && typeof win.Mvu !== "undefined" && typeof win.Mvu.replaceCurrentMvuData === "function") {
                        win.Mvu.replaceCurrentMvuData({ stat_data: JSON.parse(JSON.stringify(data)) });
                        return;
                    }
                } catch (e) {}
            }
        } catch (e) {}
    }

    function applyJumpVisibility(targetNodeId) {
        var st = getST(); if (!st || !st.chat) return;
        var target = findNode(targetNodeId); if (!target) return;
        var lastN = Math.max(1, globalApi.lastNMessages || 5);
        var endIdx = target.msgIdx;
        var visStart = Math.max(0, endIdx - lastN + 1);

        for (var i = 0; i < st.chat.length; i++) {
            if (i >= visStart && i <= endIdx) {
                delete st.chat[i].is_system;
                delete st.chat[i]._tlg_hidden;
            } else {
                st.chat[i].is_system = true;
                st.chat[i]._tlg_hidden = true;
            }
        }

        state._jumpedToIdx = endIdx;
        state._chatLenAtJump = st.chat.length;

        if (st.chat_metadata) {
            st.chat_metadata._tlg_jumpedToIdx = endIdx;
            st.chat_metadata._tlg_chatLenAtJump = st.chat.length;
        }

        if (typeof st.saveChat === "function") st.saveChat();
        if (typeof st.saveMetadata === "function") st.saveMetadata();
        else if (typeof window.saveMetadataDebounced === "function") window.saveMetadataDebounced();
    }
    
    function applyRecentVisibility() {
        var st = getST(); if (!st || !st.chat || !st.chat.length) return;
        var lastN = Math.max(1, globalApi.lastNMessages || 5);
        var total = st.chat.length;

        if (typeof state._jumpedToIdx === "number" && state._jumpedToIdx >= 0) {
            var visStart = Math.max(0, state._jumpedToIdx - lastN + 1);
            var visEnd = state._jumpedToIdx;
            var newStart = (typeof state._chatLenAtJump === "number") ? state._chatLenAtJump : total;
            for (var i = 0; i < total; i++) {
                if ((i >= visStart && i <= visEnd) || i >= newStart) {
                    delete st.chat[i].is_system;
                    delete st.chat[i]._tlg_hidden;
                } else {
                    st.chat[i].is_system = true;
                    st.chat[i]._tlg_hidden = true;
                }
            }
            return;
        }

        for (var j = 0; j < total; j++) {
            if (j >= total - lastN) {
                delete st.chat[j].is_system;
                delete st.chat[j]._tlg_hidden;
            } else {
                st.chat[j].is_system = true;
                st.chat[j]._tlg_hidden = true;
            }
        }
    }

    function createAnchor(name, brief) {
        var st = getST(); if (!st) return; ensureWorldExists();
        var msgIdx = st.chat ? Math.max(0, st.chat.length - 1) : 0;
        var parentId = state.currentNodeId; var newId = generateId();
        var newNode = { id: newId, name: name || ("节点 " + state.nodes.length), brief: brief || "", parentId: parentId, msgIdx: msgIdx, statData: getMVUStatData(), timestamp: Date.now(), children: [] };
        var parent = findNode(parentId);
        if (parent && parent.children.indexOf(newId) === -1) parent.children.push(newId);
        state.nodes.push(newNode); state.currentNodeId = newId; state.selectedNodeId = newId; state.turnsSinceAnchor = 0;
        state._jumpedToIdx = null; state._chatLenAtJump = null;
        var __st = getST();
        if (__st && __st.chat_metadata) {
            delete __st.chat_metadata._tlg_jumpedToIdx;
            delete __st.chat_metadata._tlg_chatLenAtJump;
            if (typeof __st.saveMetadata === "function") __st.saveMetadata();
        }
        saveTurnsCounter();
        saveCurrentWorld(); toast("⚓ 已锚定: " + newNode.name); renderCanvas(); refreshArchive(); return newId;
    }
    function createAnchorAtFloor(name, brief, floorIdx) {
        var st = getST(); if (!st) return; ensureWorldExists();
        var msgIdx = Math.max(0, Math.min(floorIdx, (st.chat ? st.chat.length - 1 : 0)));
        var bestParent = null;
        var bestDist = Infinity;
        for (var i = 0; i < state.nodes.length; i++) {
            var n = state.nodes[i];
            if (n.msgIdx <= msgIdx) {
                var dist = msgIdx - n.msgIdx;
                if (dist < bestDist) { bestDist = dist; bestParent = n; }
            }
        }
        if (!bestParent) bestParent = state.nodes.find(function(n) { return !n.parentId; });
        var parentId = bestParent ? bestParent.id : state.currentNodeId;
        var newId = generateId();
        var newNode = { id: newId, name: name || ("节点@#" + msgIdx), brief: brief || "", parentId: parentId, msgIdx: msgIdx, statData: getMVUStatData(), timestamp: Date.now(), children: [] };
        var parent = findNode(parentId);
        if (parent && parent.children.indexOf(newId) === -1) parent.children.push(newId);
        state.nodes.push(newNode); state.currentNodeId = newId; state.selectedNodeId = newId;
        state._jumpedToIdx = null; state._chatLenAtJump = null;
        saveCurrentWorld(); toast("⚓ 已锚定于 #" + msgIdx + ": " + newNode.name); renderCanvas(); refreshArchive(); return newId;
    }


    function jumpToNode(nodeId) {
        var node = findNode(nodeId); if (!node) { toast("节点不存在"); return; }
        var st = getST();

        var apiUrl = (globalApi.apiUrl || "").trim();
        if (apiUrl && globalApi.jumpSummary && st && st.chat) {
            var coveredUpTo = _getCoveredUpTo();
            var uncovered = [];
            for (var mi = 1; mi < st.chat.length; mi++) {
                if (mi <= coveredUpTo) continue;
                uncovered.push(st.chat[mi]);
            }
            if (uncovered.length > 0) {
                var batchSize = globalApi.autoInterval || 10;
                var jumpBatches = [];
                for (var jb = 0; jb < uncovered.length; jb += batchSize) {
                    jumpBatches.push(uncovered.slice(jb, jb + batchSize));
                }
                var jbIdx = 0;
                function nextJumpBatch() {
                    if (jbIdx >= jumpBatches.length) return;
                    var batch = jumpBatches[jbIdx]; jbIdx++;
                    _doSummaryRequest(batch, true, "跳转前 " + jbIdx + "/" + jumpBatches.length, nextJumpBatch);
                }
                nextJumpBatch();
            }
        }

        if (node.statData != null) setMVUStatData(node.statData);

        applyJumpVisibility(nodeId);

        state.currentNodeId = nodeId; state.turnsSinceAnchor = 0;
        saveTurnsCounter();
        saveCurrentWorld(); toast("↩ 已跳转至: " + node.name); renderCanvas(); refreshArchive(); closeBriefPanel();
    }

    function showAnchorModal(prefillName) {
        if (!isEnabled()) { toast("河岸凝视已关闭"); return; }
        var existing = document.getElementById("tlg-anchor-modal"); if (existing) existing.remove();
        var backdrop = document.createElement("div"); backdrop.id = "tlg-anchor-modal";
        backdrop.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100dvh;background:rgba(0,0,0,0.85);z-index:2147483647;display:flex;align-items:flex-start;justify-content:center;padding:16px;padding-top:12vh;box-sizing:border-box;overflow-y:auto;";
        var st = getST(); var maxFloor = st && st.chat ? st.chat.length - 1 : 0;
        backdrop.innerHTML = '<div class="tlg-modal"><div class="tlg-modal-title">⚓ 锚定因果刻度</div><div style="margin-bottom:12px"><label class="tlg-label">节点名称</label><input class="tlg-input" id="tlg-anc-name" placeholder="例:抉择之前..." value="' + escHtml(prefillName || "") + '" /></div><div style="margin-bottom:12px"><label class="tlg-label">简要描述</label><textarea class="tlg-textarea" id="tlg-anc-brief" placeholder="此时此刻的情况概述..."></textarea></div><div style="margin-bottom:12px"><label class="tlg-label">锚定楼层(留空=当前最新 #' + maxFloor + ')</label><input class="tlg-input" id="tlg-anc-floor" type="number" min="0" max="' + maxFloor + '" placeholder="' + maxFloor + '" /></div><div class="tlg-modal-actions"><button type="button" class="tlg-btn" id="tlg-anc-cancel">取消</button><button type="button" class="tlg-btn tlg-btn-primary" id="tlg-anc-ok">确认锚定</button></div></div>';
        document.body.appendChild(backdrop);
        var nameInput = backdrop.querySelector("#tlg-anc-name");
        backdrop.querySelector("#tlg-anc-cancel").onclick = function () { backdrop.remove(); };
        backdrop.querySelector("#tlg-anc-ok").onclick = function () {
            var ancName = nameInput.value.trim() || ("节点 " + state.nodes.length);
            var ancBrief = backdrop.querySelector("#tlg-anc-brief").value.trim();
            var floorInput = backdrop.querySelector("#tlg-anc-floor");
            var floorVal = floorInput ? floorInput.value.trim() : "";
            if (floorVal !== "") { createAnchorAtFloor(ancName, ancBrief, parseInt(floorVal, 10) || 0); }
            else { createAnchor(ancName, ancBrief); }
            backdrop.remove();
        };
        backdrop.addEventListener("click", function (e) { if (e.target === backdrop) backdrop.remove(); });
        setTimeout(function () { nameInput.focus(); }, 80);
    }

    // ── 画布 ──
    var ripple = null;
    var virtualMarkerPos = null;
    function triggerRipple(worldX, worldY) { ripple = { x: worldX, y: worldY, startTime: Date.now() }; }

    function layoutTree() {
        var positions = {}, H_GAP = 180, V_GAP = 120;
        function subtreeWidth(nodeId) {
            var node = findNode(nodeId); if (!node || !node.children.length) return 1;
            return node.children.reduce(function (s, cid) { return s + subtreeWidth(cid); }, 0);
        }
        function assign(nodeId, depth, slotStart) {
            var node = findNode(nodeId); if (!node) return;
            var w = subtreeWidth(nodeId); positions[nodeId] = { x: (slotStart + w / 2) * H_GAP, y: depth * V_GAP + 60 };
            var childSlot = slotStart;
            for (var i = 0; i < node.children.length; i++) {
                var cid = node.children[i], cw = subtreeWidth(cid);
                assign(cid, depth + 1, childSlot); childSlot += cw;
            }
        }
        var root = state.nodes.find(function (n) { return n.parentId === null; });
        if (root) assign(root.id, 0, 0); return positions;
    }

    function renderCanvas() {
        if (!canvas || !ctx) return;
        var dpr = window.devicePixelRatio || 1;
        var rect = canvas.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        canvas.width = rect.width * dpr; canvas.height = rect.height * dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = "#000000"; ctx.fillRect(0, 0, rect.width, rect.height);
        ctx.save(); ctx.translate(rect.width / 2 + camX, rect.height / 2 + camY); ctx.scale(camZoom, camZoom);
        var positions = layoutTree(), NODE_R = 22, path = getPathToRoot(state.currentNodeId);
        var i, node, from, to, pos, isCurrent, isSelected, onPath, cy, label;
        var pulse = (Math.sin(Date.now() / 800) + 1) / 2;

        for (i = 0; i < state.nodes.length; i++) {
            node = state.nodes[i]; if (!node.parentId) continue;
            from = positions[node.parentId]; to = positions[node.id]; if (!from || !to) continue;
            var isActive = path.indexOf(node.id) !== -1 && path.indexOf(node.parentId) !== -1;
            ctx.beginPath(); ctx.moveTo(from.x, from.y + NODE_R);
            cy = (from.y + to.y) / 2;
            ctx.bezierCurveTo(from.x, cy, to.x, cy, to.x, to.y - NODE_R);
            if (isActive) {
                ctx.strokeStyle = "rgba(255,255,255," + (0.85 + pulse * 0.15) + ")";
                ctx.lineWidth = 3.5;
                ctx.shadowColor = "rgba(255,255,255," + (0.4 + pulse * 0.2) + ")";
                ctx.shadowBlur = 8 + pulse * 6;
            } else { ctx.strokeStyle = "rgba(140,140,160,0.4)"; ctx.lineWidth = 2; ctx.shadowBlur = 0; }
            ctx.stroke(); ctx.shadowBlur = 0;
        }

        for (i = 0; i < state.nodes.length; i++) {
            node = state.nodes[i]; pos = positions[node.id]; if (!pos) continue;
            isCurrent = node.id === state.currentNodeId; isSelected = node.id === state.selectedNodeId;
            onPath = path.indexOf(node.id) !== -1;

            if (isCurrent) {
                var glowR = NODE_R + 18 + pulse * 10;
                ctx.beginPath(); ctx.arc(pos.x, pos.y, glowR, 0, Math.PI * 2);
                var grd = ctx.createRadialGradient(pos.x, pos.y, NODE_R * 0.6, pos.x, pos.y, glowR);
                grd.addColorStop(0, "rgba(255,255,255," + (0.35 + pulse * 0.15) + ")");
                grd.addColorStop(1, "rgba(255,255,255,0)");
                ctx.fillStyle = grd; ctx.fill();
            } else if (isSelected) {
                var glowR2 = NODE_R + 12 + pulse * 4;
                ctx.beginPath(); ctx.arc(pos.x, pos.y, glowR2, 0, Math.PI * 2);
                var grd2 = ctx.createRadialGradient(pos.x, pos.y, NODE_R * 0.6, pos.x, pos.y, glowR2);
                grd2.addColorStop(0, "rgba(255,255,255,0.2)"); grd2.addColorStop(1, "rgba(255,255,255,0)");
                ctx.fillStyle = grd2; ctx.fill();
            } else if (onPath) {
                var glowR3 = NODE_R + 6;
                ctx.beginPath(); ctx.arc(pos.x, pos.y, glowR3, 0, Math.PI * 2);
                var grd3 = ctx.createRadialGradient(pos.x, pos.y, NODE_R * 0.6, pos.x, pos.y, glowR3);
                grd3.addColorStop(0, "rgba(255,255,255,0.1)"); grd3.addColorStop(1, "rgba(255,255,255,0)");
                ctx.fillStyle = grd3; ctx.fill();
            } else {
                var glowR4 = NODE_R + 3;
                ctx.beginPath(); ctx.arc(pos.x, pos.y, glowR4, 0, Math.PI * 2);
                var grd4 = ctx.createRadialGradient(pos.x, pos.y, NODE_R * 0.8, pos.x, pos.y, glowR4);
                grd4.addColorStop(0, "rgba(255,255,255,0.04)"); grd4.addColorStop(1, "rgba(255,255,255,0)");
                ctx.fillStyle = grd4; ctx.fill();
            }

            ctx.beginPath(); ctx.arc(pos.x, pos.y, NODE_R, 0, Math.PI * 2);
            ctx.fillStyle = "#ffffff"; ctx.fill(); ctx.shadowBlur = 0;

            ctx.fillStyle = isCurrent ? "#ffffff" : onPath ? "rgba(230,230,240,0.9)" : "rgba(160,160,175,0.7)";
            ctx.font = isCurrent ? "bold 11px sans-serif" : "11px sans-serif";
            ctx.textAlign = "center"; ctx.textBaseline = "top";
            label = node.name.length > 12 ? node.name.slice(0, 11) + "..." : node.name;
            ctx.fillText(label, pos.x, pos.y + NODE_R + 7);
        }
        virtualMarkerPos = null;
        var curNode = findNode(state.currentNodeId);
        var stCtx = getST();
        var latestFloor = stCtx && stCtx.chat ? stCtx.chat.length - 1 : 0;
        if (curNode && latestFloor > curNode.msgIdx) {
            var curPos = positions[curNode.id];
            if (curPos) {
                var vx = curPos.x, vy = curPos.y + 110;
                virtualMarkerPos = { x: vx, y: vy };

                ctx.save();
                ctx.strokeStyle = "rgba(255,255,255,0.3)";
                ctx.lineWidth = 2;
                ctx.setLineDash([5, 5]);
                ctx.beginPath();
                ctx.moveTo(curPos.x, curPos.y + NODE_R);
                ctx.lineTo(vx, vy - NODE_R * 0.65);
                ctx.stroke();
                ctx.setLineDash([]);
                ctx.restore();

                ctx.beginPath(); ctx.arc(vx, vy, NODE_R * 0.65, 0, Math.PI * 2);
                ctx.fillStyle = "rgba(255,255,255,0.06)"; ctx.fill();
                ctx.strokeStyle = "rgba(255,255,255,0.35)"; ctx.lineWidth = 1.5; ctx.stroke();

                ctx.fillStyle = "rgba(220,220,230,0.7)";
                ctx.font = "11px sans-serif";
                ctx.textAlign = "center"; ctx.textBaseline = "top";
                ctx.fillText("目光停驻之地", vx, vy + NODE_R * 0.65 + 7);
            }
        }

        if (ripple) {
            var elapsed = (Date.now() - ripple.startTime) / 1000, maxDur = 0.6;
            if (elapsed < maxDur) {
                var progress = elapsed / maxDur, rRadius = progress * 60, rAlpha = 1 - progress;
                ctx.beginPath(); ctx.arc(ripple.x, ripple.y, rRadius, 0, Math.PI * 2);
                ctx.strokeStyle = "rgba(255,255,255," + (rAlpha * 0.6) + ")";
                ctx.lineWidth = 2 * (1 - progress); ctx.stroke();
            } else { ripple = null; }
        }
        ctx.restore();
    }

    function centerOnCurrentNode() {
        var positions = layoutTree();
        var pos = positions[state.currentNodeId];
        if (!pos) return;
        camX = -pos.x * camZoom;
        camY = -pos.y * camZoom;
    }

    function canvasHitTest(clientX, clientY) {
        if (!canvas) return null;
        var rect = canvas.getBoundingClientRect();
        var wx = (clientX - rect.left - rect.width / 2 - camX) / camZoom;
        var wy = (clientY - rect.top - rect.height / 2 - camY) / camZoom;
        var positions = layoutTree(), NODE_R = 22, ids = Object.keys(positions);
        for (var i = 0; i < ids.length; i++) {
            var pos = positions[ids[i]], dx = wx - pos.x, dy = wy - pos.y;
            if (dx * dx + dy * dy <= (NODE_R + 4) * (NODE_R + 4)) return ids[i];
        }
        if (virtualMarkerPos) {
            var vdx = wx - virtualMarkerPos.x, vdy = wy - virtualMarkerPos.y;
            if (vdx * vdx + vdy * vdy <= (NODE_R * 0.65 + 4) * (NODE_R * 0.65 + 4)) return "__virtual__";
        }
        return null;
    }

    function openBriefPanel(nodeId) {
        var node = findNode(nodeId); if (!node) return; state.selectedNodeId = nodeId;
        var panel = document.getElementById("tlg-brief-panel"); if (!panel) return;
        panel.classList.add("open"); panel.querySelector(".tlg-brief-header span").textContent = node.name;
        var body = panel.querySelector(".tlg-brief-body");
        body.innerHTML = '<div style="margin-bottom:8px;font-size:11px;color:#7a7a8a">' + new Date(node.timestamp).toLocaleString() + "</div>" +
            '<div style="margin-bottom:8px;font-size:11px;color:#7a7a8a">消息索引: ' + node.msgIdx + " | " + (node.statData ? "MVU快照 ✓" : "无MVU快照") + "</div>" +
            '<div style="white-space:pre-wrap;word-break:break-word">' + (node.brief ? escHtml(node.brief) : "<em style='color:#7a7a8a'>暂无描述</em>") + "</div>" +
            '<div style="margin-top:12px"><label class="tlg-label">编辑描述</label><textarea class="tlg-textarea" id="tlg-brief-edit" style="min-height:80px">' + escHtml(node.brief || "") + "</textarea>" +
            '<button type="button" class="tlg-btn tlg-btn-primary" id="tlg-brief-save" style="margin-top:6px;width:100%!important">保存描述</button></div>';
        body.querySelector("#tlg-brief-save").onclick = function () {
            flashBtn(this); node.brief = body.querySelector("#tlg-brief-edit").value; saveCurrentWorld(); toast("描述已保存"); refreshArchive();
        };
        panel.querySelector(".tlg-brief-footer").innerHTML =
            '<button type="button" class="tlg-btn" id="tlg-brief-rename" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;margin-bottom:6px;width:100%!important;">✎ 重命名</button>' +
            '<button type="button" class="tlg-btn" id="tlg-brief-pin" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;margin-bottom:6px;width:100%!important;">⚙ 设为常用路径</button>' +
            '<button type="button" class="tlg-btn tlg-btn-jump" id="tlg-brief-jump">↩ 确认跳转至此因果</button>';
        panel.querySelector("#tlg-brief-jump").onclick = function () { jumpToNode(nodeId); };
        panel.querySelector("#tlg-brief-rename").onclick = function () {
            tlgPrompt("重命名节点", "", node.name, function(newName) {
                node.name = newName; saveCurrentWorld(); renderCanvas(); updateBriefPanel();
            });
        };
        panel.querySelector("#tlg-brief-pin").onclick = function () { showPinPathModal(nodeId); };
    }
    function closeBriefPanel() { var panel = document.getElementById("tlg-brief-panel"); if (panel) panel.classList.remove("open"); state.selectedNodeId = null; }

    // ══════════════════════════════════════
    // 常用路径
    // ══════════════════════════════════════
    function getPinnedPaths() {
        if (!currentWorldId || !worlds[currentWorldId]) return [];
        if (!worlds[currentWorldId].pinnedPaths) worlds[currentWorldId].pinnedPaths = [];
        return worlds[currentWorldId].pinnedPaths;
    }

    function showPinPathModal(nodeId) {
        var node = findNode(nodeId); if (!node) return;
        var existing = document.getElementById("tlg-pin-modal"); if (existing) existing.remove();
        var backdrop = document.createElement("div"); backdrop.id = "tlg-pin-modal";
        backdrop.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100dvh;background:rgba(0,0,0,0.85);z-index:2147483647;display:flex;align-items:flex-start;justify-content:center;padding:16px;padding-top:12vh;box-sizing:border-box;overflow-y:auto;";
        backdrop.innerHTML = '<div class="tlg-modal"><div class="tlg-modal-title">⚙ 设为常用路径</div>' +
            '<div style="font-size:12px;color:#7a7a8a;margin-bottom:12px;">终点节点:' + escHtml(node.name) + '(可在观测坐标里调整终点)</div>' +
            '<label class="tlg-label">路径名称</label><input class="tlg-input" id="tlg-pin-name" value="' + escHtml(node.name + " 路径") + '" style="margin-bottom:10px" />' +
            '<label class="tlg-label">路径描述</label><textarea class="tlg-textarea" id="tlg-pin-desc" placeholder="手写描述,或点击AI生成..." style="min-height:80px;margin-bottom:10px"></textarea>' +
            '<div class="tlg-modal-actions">' +
            '<button type="button" class="tlg-btn" id="tlg-pin-cancel">取消</button>' +
            '<button type="button" class="tlg-btn" id="tlg-pin-ai" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">AI生成描述</button>' +
            '<button type="button" class="tlg-btn tlg-btn-primary" id="tlg-pin-ok">保存路径</button>' +
            '</div></div>';
        document.body.appendChild(backdrop);
        backdrop.querySelector("#tlg-pin-cancel").onclick = function () { backdrop.remove(); };
        backdrop.querySelector("#tlg-pin-ok").onclick = function () {
            var name = backdrop.querySelector("#tlg-pin-name").value.trim() || (node.name + " 路径");
            var desc = backdrop.querySelector("#tlg-pin-desc").value.trim();
            var paths = getPinnedPaths();
            paths.push({ id: generateId(), name: name, nodeId: nodeId, autoDesc: "", userDesc: desc, createdAt: Date.now() });
            saveWorlds(); backdrop.remove(); toast("常用路径已保存:" + name);
            refreshArchive();
        };
        backdrop.querySelector("#tlg-pin-ai").onclick = function () {
            var self = this; self.disabled = true; self.textContent = "生成中...";
            generatePathDesc(nodeId, function(desc) {
                backdrop.querySelector("#tlg-pin-desc").value = desc;
                self.disabled = false; self.textContent = "AI生成描述";
            });
        };
        backdrop.addEventListener("click", function (e) { if (e.target === backdrop) backdrop.remove(); });
    }

    function generatePathDesc(nodeId, callback) {
        var apiUrl = (globalApi.apiUrl || "").trim(), apiKey = (globalApi.apiKey || "").trim(), model = (globalApi.model || "").trim();
        if (!apiUrl) { toast("请先配置API地址"); callback(""); return; }
        var pathIds = getPathToRoot(nodeId);
        var pathNodes = pathIds.map(findNode).filter(Boolean);
        var contextParts = [];
        pathNodes.forEach(function(n) {
            var info = "节点【" + n.name + "】(#" + n.msgIdx + ")";
            if (n.brief) info += ":" + n.brief;
            contextParts.push(info);
        });
        var relSummaries = state.summaries.filter(function(s) { return !s.nodeId || pathIds.indexOf(s.nodeId) !== -1; }).slice(-10);
        if (relSummaries.length) {
            contextParts.push("路径相关因果档案:\n" + relSummaries.map(function(s){ return s.text; }).join("\n---\n"));
        }
        if (contextParts.join("").length < 100) {
            var st = getST();
            if (st && st.chat) {
                var targetNode = findNode(nodeId);
                var endIdx = targetNode ? targetNode.msgIdx : st.chat.length - 1;
                var startIdx = Math.max(0, endIdx - 10);
                var chatSlice = st.chat.slice(startIdx, endIdx + 1).filter(function(m) { return m.mes; });
                if (chatSlice.length) {
                    contextParts.push("该节点附近的对话:\n" + chatSlice.map(function(m) { return (m.name || m.role || "?") + ": " + (m.mes || "").slice(0, 150); }).join("\n"));
                }
            }
        }
        var context = contextParts.join("\n\n");
        if (!context.trim()) { toast("路径上下文为空,无法生成"); callback(""); return; }
        var prompt = (globalApi.pathSummaryPrompt || "").replace("{{context}}", context);
        fetch(buildEndpoint(apiUrl, "/chat/completions"), {
            method: "POST", headers: Object.assign({ "Content-Type": "application/json" }, apiKey ? { Authorization: "Bearer " + apiKey } : {}),
            body: JSON.stringify({ model: model || undefined, messages: [{ role: "user", content: prompt }], max_tokens: 1024 })
        }).then(function(r) {
            if (!r.ok) throw new Error("HTTP " + r.status);
            return r.json();
        }).then(function(data){
            var text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
            text = text.trim();
            if (text.length < 20) {
                toast("⚠ AI 生成内容过短(" + text.length + "字),可能上下文不足");
            }
            callback(text);
        }).catch(function(e){ toast("生成失败:" + e.message); callback(""); });
    }

    function refreshPinnedPaths() {
        var container = document.getElementById("tlg-pinned-paths"); if (!container) return;
        var paths = getPinnedPaths();
        if (!paths.length) { container.innerHTML = '<div style="color:#5a5a6a;font-size:12px;padding:8px 0;">暂无常用路径,点击节点可设置</div>'; return; }
        var nodeOpts = state.nodes.map(function(n){ return '<option value="' + escHtml(n.id) + '">' + escHtml(n.name) + '</option>'; }).join("");
        container.innerHTML = paths.map(function(p) {
            var endNode = findNode(p.nodeId);
            var desc = p.userDesc || p.autoDesc || "";
            return '<div style="background:#050508;border:1px solid #2a2a3a;border-radius:4px;padding:10px;margin-bottom:8px;">' +
                '<div style="font-size:13px;font-weight:600;color:#e8e8f0;margin-bottom:4px;">' + escHtml(p.name) + '</div>' +
                '<div style="font-size:11px;color:#7a7a8a;margin-bottom:6px;">终点:' + escHtml(endNode ? endNode.name : "未知") + '</div>' +
                (desc ? '<div style="font-size:12px;color:#9a9aaa;margin-bottom:8px;white-space:pre-wrap">' + escHtml(desc.slice(0, 80)) + (desc.length > 80 ? "..." : "") + '</div>' : '') +
                '<div style="display:flex;gap:6px;flex-wrap:wrap;">' +
                '<button type="button" class="tlg-btn tlg-pin-jump" data-pid="' + p.id + '" style="font-size:11px;writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">↩ 跳转</button>' +
                '<button type="button" class="tlg-btn tlg-pin-edit" data-pid="' + p.id + '" style="font-size:11px;writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">✎ 编辑</button>' +
                '<button type="button" class="tlg-btn tlg-btn-danger tlg-pin-del" data-pid="' + p.id + '" style="font-size:11px;margin-left:auto;writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">✕</button>' +
                '</div></div>';
        }).join("");
        container.querySelectorAll(".tlg-pin-jump").forEach(function(btn){
            btn.onclick = function() { var p = getPinnedPaths().find(function(x){ return x.id === btn.dataset.pid; }); if (p) jumpToNode(p.nodeId); };
        });
        container.querySelectorAll(".tlg-pin-edit").forEach(function(btn){
            btn.onclick = function() { showPinEditModal(btn.dataset.pid); };
        });
        container.querySelectorAll(".tlg-pin-del").forEach(function(btn){
            btn.onclick = function() {
                var paths = getPinnedPaths(); var idx = paths.findIndex(function(x){ return x.id === btn.dataset.pid; });
                if (idx === -1) return;
                if (!confirm("坍缩常用路径「" + paths[idx].name + "」?")) return;
                paths.splice(idx, 1); saveWorlds(); refreshPinnedPaths(); toast("已坍缩");
            };
        });
    }

    function showPinEditModal(pathId) {
        var paths = getPinnedPaths(); var p = paths.find(function(x){ return x.id === pathId; }); if (!p) return;
        var existing = document.getElementById("tlg-pin-edit-modal"); if (existing) existing.remove();
        var nodeOpts = state.nodes.map(function(n){ return '<option value="' + escHtml(n.id) + '"' + (n.id === p.nodeId ? " selected" : "") + '>' + escHtml(n.name) + '</option>'; }).join("");
        var backdrop = document.createElement("div"); backdrop.id = "tlg-pin-edit-modal";
        backdrop.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100dvh;background:rgba(0,0,0,0.85);z-index:2147483647;display:flex;align-items:flex-start;justify-content:center;padding:16px;padding-top:8vh;box-sizing:border-box;overflow-y:auto;";
        backdrop.innerHTML = '<div class="tlg-modal"><div class="tlg-modal-title">✎ 编辑常用路径</div>' +
            '<label class="tlg-label">路径名称</label><input class="tlg-input" id="tlg-pine-name" value="' + escHtml(p.name) + '" style="margin-bottom:10px" />' +
            '<label class="tlg-label">终点节点</label><select class="tlg-select" id="tlg-pine-node" style="width:100%;margin-bottom:10px;">' + nodeOpts + '</select>' +
            '<label class="tlg-label">路径描述</label><textarea class="tlg-textarea" id="tlg-pine-desc" style="min-height:100px;margin-bottom:10px">' + escHtml(p.userDesc || p.autoDesc || "") + '</textarea>' +
            '<div class="tlg-modal-actions">' +
            '<button type="button" class="tlg-btn" id="tlg-pine-cancel">取消</button>' +
            '<button type="button" class="tlg-btn" id="tlg-pine-ai" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">AI重新生成</button>' +
            '<button type="button" class="tlg-btn tlg-btn-primary" id="tlg-pine-ok">保存</button>' +
            '</div></div>';
        document.body.appendChild(backdrop);
        backdrop.querySelector("#tlg-pine-cancel").onclick = function() { backdrop.remove(); };
        backdrop.querySelector("#tlg-pine-ok").onclick = function() {
            p.name = backdrop.querySelector("#tlg-pine-name").value.trim() || p.name;
            p.nodeId = backdrop.querySelector("#tlg-pine-node").value || p.nodeId;
            p.userDesc = backdrop.querySelector("#tlg-pine-desc").value.trim();
            saveWorlds(); backdrop.remove(); refreshPinnedPaths(); toast("路径已更新");
        };
        backdrop.querySelector("#tlg-pine-ai").onclick = function() {
            var self = this; self.disabled = true; self.textContent = "生成中...";
            var targetNodeId = backdrop.querySelector("#tlg-pine-node").value || p.nodeId;
            generatePathDesc(targetNodeId, function(desc) {
                backdrop.querySelector("#tlg-pine-desc").value = desc;
                p.autoDesc = desc;
                self.disabled = false; self.textContent = "AI重新生成";
            });
        };
        backdrop.addEventListener("click", function(e) { if (e.target === backdrop) backdrop.remove(); });
    }

    function refreshArchive() {
        var container = document.getElementById("tlg-archive-list"); if (!container) return;
        refreshPinnedPaths();
        if (!state.nodes.length) { container.innerHTML = '<div style="color:#5a5a6a;padding:40px 20px;text-align:center;font-style:italic;letter-spacing:1px;">河流静默,因果尚未铭刻</div>'; return; }
        var sorted = state.nodes.slice().sort(function (a, b) { return b.timestamp - a.timestamp; });
        container.innerHTML = sorted.map(function (node) {
            var isCurrent = node.id === state.currentNodeId;
            return '<div class="tlg-archive-card ' + (isCurrent ? "current" : "") + '"><div class="tlg-archive-title">' + escHtml(node.name) + (isCurrent ? " <span style='color:#7a7a8a;font-size:11px'>(当前)</span>" : "") + "</div>" +
                '<div class="tlg-archive-meta">' + new Date(node.timestamp).toLocaleString() + " · 消息 " + node.msgIdx + '</div><div class="tlg-archive-brief">' + escHtml(node.brief || "") + "</div>" +
                '<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="tlg-btn tlg-archive-view" data-nid="' + node.id + '">追踪节点</button><button type="button" class="tlg-btn tlg-btn-primary tlg-archive-jump" data-nid="' + node.id + '">↩ 跳转至此</button>' +
                (!isCurrent ? '<button type="button" class="tlg-btn tlg-archive-graft" data-nid="' + node.id + '">⇢ 嫁接</button>' : '') +
                '<button type="button" class="tlg-btn tlg-btn-danger tlg-archive-del" data-nid="' + node.id + '" style="margin-left:auto">✕</button></div></div>';
        }).join("");
        container.querySelectorAll(".tlg-archive-view").forEach(function (btn) { btn.onclick = function () { switchTab("tree"); openBriefPanel(btn.dataset.nid); }; });
        container.querySelectorAll(".tlg-archive-jump").forEach(function (btn) { btn.onclick = function () { jumpToNode(btn.dataset.nid); }; });
        container.querySelectorAll(".tlg-archive-del").forEach(function (btn) {
            btn.onclick = function () {
                if (btn.dataset.nid === state.currentNodeId) { toast("无法坍缩当前所在节点"); return; }
                var n = findNode(btn.dataset.nid);
                if (!confirm("确定坍缩节点「" + (n ? n.name : "") + "」?")) return;
                deleteNode(btn.dataset.nid);
            };
        });
        container.querySelectorAll(".tlg-archive-graft").forEach(function (btn) { btn.onclick = function () { showGraftModal(btn.dataset.nid); }; });
    }

    function deleteNode(nodeId) {
        var node = findNode(nodeId); if (!node) return;
        if (!node.parentId) { toast("无法坍缩根节点"); return; }
        var parent = findNode(node.parentId);
        if (node.children && node.children.length > 0) {
            for (var i = 0; i < node.children.length; i++) {
                var childId = node.children[i];
                var child = findNode(childId);
                if (child) {
                    child.parentId = node.parentId;
                    if (parent && parent.children.indexOf(childId) === -1) {
                        parent.children.push(childId);
                    }
                }
            }
        }
        if (parent) parent.children = parent.children.filter(function (id) { return id !== nodeId; });
        state.nodes = state.nodes.filter(function (x) { return x.id !== nodeId; });
        if (state.currentNodeId === nodeId) state.currentNodeId = node.parentId;
        if (state.selectedNodeId === nodeId) state.selectedNodeId = null;
        saveCurrentWorld(); renderCanvas(); refreshArchive(); toast("节点已坍缩,子节点已重连至上级");
    }

    function graftNode(nodeId, newParentId) {
        if (nodeId === newParentId) { toast("不能嫁接到自身"); return; }
        var node = findNode(nodeId); if (!node) return;
        function isDescendant(ancestorId, targetId) {
            var n = findNode(targetId); if (!n) return false;
            if (n.parentId === ancestorId) return true;
            return n.parentId ? isDescendant(ancestorId, n.parentId) : false;
        }
        if (isDescendant(nodeId, newParentId)) { toast("目标节点是此节点的延续,无法嫁接"); return; }
        var oldParent = findNode(node.parentId);
        if (oldParent) oldParent.children = oldParent.children.filter(function (id) { return id !== nodeId; });
        var newParent = findNode(newParentId); if (!newParent) { toast("目标节点不存在"); return; }
        if (newParent.children.indexOf(nodeId) === -1) newParent.children.push(nodeId);
        node.parentId = newParentId;
        saveCurrentWorld(); renderCanvas(); refreshArchive(); toast("节点已嫁接至「" + newParent.name + "」");
    }

    function showGraftModal(nodeId) {
        var node = findNode(nodeId); if (!node) return;
        var candidates = state.nodes.filter(function (n) { return n.id !== nodeId; });
        if (!candidates.length) { toast("没有可嫁接的目标节点"); return; }
        var existing = document.getElementById("tlg-graft-modal"); if (existing) existing.remove();
        var backdrop = document.createElement("div"); backdrop.id = "tlg-graft-modal";
        backdrop.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100dvh;background:rgba(0,0,0,0.85);z-index:2147483647;display:flex;align-items:flex-start;justify-content:center;padding:16px;padding-top:10vh;box-sizing:border-box;overflow-y:auto;";
        var opts = candidates.map(function (n) { return '<option value="' + escHtml(n.id) + '">' + escHtml(n.name) + (n.id === node.parentId ? " (当前父)" : "") + '</option>'; }).join("");
        backdrop.innerHTML = '<div class="tlg-modal"><div class="tlg-modal-title">⇢ 嫁接节点</div>' +
            '<div style="font-size:12px;color:#7a7a8a;margin-bottom:12px;">将「' + escHtml(node.name) + '」及其子树移动到新上级节点下</div>' +
            '<label class="tlg-label">选择新上级节点</label><select class="tlg-select" id="tlg-graft-target" style="width:100%;margin-bottom:16px;">' + opts + '</select>' +
            '<div class="tlg-modal-actions"><button type="button" class="tlg-btn" id="tlg-graft-cancel">取消</button><button type="button" class="tlg-btn tlg-btn-primary" id="tlg-graft-ok">确认嫁接</button></div></div>';
        document.body.appendChild(backdrop);
        var sel = backdrop.querySelector("#tlg-graft-target");
        var nonParent = candidates.find(function (n) { return n.id !== node.parentId; });
        if (nonParent) sel.value = nonParent.id;
        backdrop.querySelector("#tlg-graft-cancel").onclick = function () { backdrop.remove(); };
        backdrop.querySelector("#tlg-graft-ok").onclick = function () {
            if (!sel.value) { toast("请选择目标节点"); return; }
            graftNode(nodeId, sel.value); backdrop.remove();
        };
        backdrop.addEventListener("click", function (e) { if (e.target === backdrop) backdrop.remove(); });
    }

    // ══════════════════════════════════════
    // 总结 / 浓缩
    // ══════════════════════════════════════
    function refreshSummary() {
        var list = document.getElementById("tlg-summary-list"); if (!list) return;
        var catchupHtml = '<button type="button" class="tlg-btn" id="tlg-summary-catchup-btn" style="width:100%;margin-top:8px;writing-mode:horizontal-tb;white-space:nowrap;height:auto;">📋 补全历史切片</button>';
        if (!state.summaries || !state.summaries.length) {
            list.innerHTML = '<div style="color:#5a5a6a;padding:20px 0;text-align:center;font-style:italic;">虚空寂寂,尚无因果被铭刻于此</div>' + catchupHtml;
            var cb = document.getElementById("tlg-summary-catchup-btn"); if (cb) cb.addEventListener("click", runCatchupSummary);
            return;
        }
        var latest = state.summaries[state.summaries.length - 1];
        var preview = (latest.text || "").slice(0, 120) + (latest.text && latest.text.length > 120 ? "..." : "");
        var latestFloor = (latest.floorFrom >= 0 && latest.floorTo >= 0) ? ' · #' + latest.floorFrom + '~#' + latest.floorTo : '';
        var compressedBadge = latest.compressed ? ' <span style="font-size:10px;background:#1a1a2a;border:1px solid #3a3a5a;color:#9090b0;padding:1px 5px;border-radius:3px;">已浓缩·' + (latest.sourceCount || "?") + '条</span>' : '';
        list.innerHTML =
            '<div style="background:#050508;border:1px solid #2a2a3a;border-radius:4px;padding:12px;margin-bottom:8px;">' +
            '<div style="font-size:11px;color:#7a7a8a;margin-bottom:4px;">最新提取 · ' + new Date(latest.timestamp).toLocaleString() + latestFloor + compressedBadge + '</div>' +
            '<div style="font-size:13px;white-space:pre-wrap;max-height:80px;overflow:hidden;color:#d0d0d8;line-height:1.6;">' + escHtml(preview) + '</div>' +
            '</div>' +
            '<button type="button" class="tlg-btn tlg-btn-primary" id="tlg-summary-history-btn" style="width:100%;margin-bottom:8px;">📜 观测档案库 (' + state.summaries.length + ' 条)</button>' +
            catchupHtml;
        document.getElementById("tlg-summary-history-btn").addEventListener("click", function () { switchTab("vault"); });
        var cb2 = document.getElementById("tlg-summary-catchup-btn"); if (cb2) cb2.addEventListener("click", runCatchupSummary);
    }

    function refreshVault() {
        var container = document.getElementById("tlg-vault-container"); if (!container) return;
        var ctrlHtml = '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;align-items:center;">' +
            '<input type="text" id="tlg-sh-search" placeholder="检索关键词..." style="flex:1;min-width:0;padding:8px 12px;background:#000;border:1px solid #2a2a3a;border-radius:3px;color:#e0e0e8;font-size:14px;outline:none;" />' +
            '<span id="tlg-sh-count" style="font-size:12px;color:#7a7a8a;white-space:nowrap;">' + (state.summaries ? state.summaries.length : 0) + ' 条</span>' +
            '</div>' +
            '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;">' +
            '<button type="button" class="tlg-btn" id="tlg-vault-catchup" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;"> 补全历史切片</button>' +
            '<button type="button" class="tlg-btn" id="tlg-vault-compress-range" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">⧗ 选范围浓缩</button>' +
            '<button type="button" class="tlg-btn tlg-btn-danger" id="tlg-vault-clear-all" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;margin-left:auto;">⊖ 清空全部</button>' +
            '</div>';
        container.innerHTML = ctrlHtml + '<div id="tlg-sh-list"></div>';
        renderSummaryList("");
        document.getElementById("tlg-sh-search").addEventListener("input", function () { renderSummaryList(this.value.trim().toLowerCase()); });
        document.getElementById("tlg-vault-catchup").addEventListener("click", runCatchupSummary);
        document.getElementById("tlg-vault-compress-range").addEventListener("click", showCompressRangeModal);
        document.getElementById("tlg-vault-clear-all").addEventListener("click", function() {
            if (!state.summaries || !state.summaries.length) { toast("已经是空的"); return; }
            if (!confirm("确定清空全部 " + state.summaries.length + " 条摘要?此操作不可撤销。")) return;
            state.summaries = [];
            saveCurrentWorld(); refreshSummary();
            renderSummaryList("");
            toast("已清空全部摘要");
        });

    }

    function renderSummaryList(keyword) {
        var listWrap = document.getElementById("tlg-sh-list"); if (!listWrap) return;
        var items = (state.summaries || []).slice().reverse();
        if (keyword) { items = items.filter(function (s) { return (s.text || "").toLowerCase().indexOf(keyword) !== -1; }); }
        var countEl = document.getElementById("tlg-sh-count"); if (countEl) countEl.textContent = items.length + " 条";
        if (!items.length) { listWrap.innerHTML = '<div style="color:#5a5a6a;padding:40px 20px;text-align:center;font-style:italic;">' + (keyword ? "因果之中未见此痕迹" : "虚空寂寂,尚无因果被铭刻于此") + '</div>'; return; }
        listWrap.innerHTML = items.map(function (s) {
            var realIdx = state.summaries.indexOf(s);
            var floorInfo = (s.floorFrom >= 0 && s.floorTo >= 0) ? ' · <span style="color:#9999bb;">#' + s.floorFrom + '~#' + s.floorTo + '</span>' : '';
            var compBadge = s.compressed ? ' <span style="font-size:10px;background:#1a1a2a;border:1px solid #3a3a5a;color:#9090b0;padding:1px 4px;border-radius:3px;">已浓缩·' + (s.sourceCount || "?") + '条</span>' : '';
            return '<div class="tlg-sh-item" style="margin-bottom:10px;background:#050508;border:1px solid #1e1e2a;border-radius:4px;padding:12px;">' +
                '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">' +
                '<span style="font-size:11px;color:#7a7a8a;">' + new Date(s.timestamp).toLocaleString() + floorInfo + compBadge + '</span>' +
                '<span style="font-size:11px;color:#7a7a8a;">#' + (realIdx + 1) + '</span></div>' +
                '<div class="tlg-sh-text" id="tlg-sh-text-' + realIdx + '" style="font-size:13px;white-space:pre-wrap;word-break:break-word;line-height:1.8;max-height:200px;overflow-y:auto;color:#d0d0d8;">' + escHtml(s.text) + '</div>' +
                '<div id="tlg-sh-editarea-' + realIdx + '" style="display:none;margin-top:8px;">' +
                '<textarea style="width:100%;min-height:120px;padding:10px;background:#000;border:1px solid #2a2a3a;border-radius:3px;color:#e0e0e8;font-size:13px;line-height:1.6;resize:vertical;box-sizing:border-box;outline:none;" id="tlg-sh-ta-' + realIdx + '">' + escHtml(s.text) + '</textarea>' +
                '<button type="button" class="tlg-btn tlg-btn-primary tlg-sh-save" data-idx="' + realIdx + '" style="margin-top:6px;width:100%;writing-mode:horizontal-tb;white-space:nowrap;height:auto;">保存</button></div>' +
                '<div style="margin-top:10px;display:flex;gap:8px;">' +
                '<button type="button" class="tlg-btn tlg-sh-edit" data-idx="' + realIdx + '" style="font-size:11px;writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">✎ 编辑</button>' +
                (!s.compressed ? '<button type="button" class="tlg-btn tlg-sh-compress1" data-idx="' + realIdx + '" style="font-size:11px;writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;"> ⧗单条浓缩</button>' : '') +
                '<button type="button" class="tlg-btn tlg-btn-danger tlg-sh-del" data-idx="' + realIdx + '" style="font-size:11px;margin-left:auto;writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">⊖ 抹除</button>' +
                '</div></div>';
        }).join("");
        listWrap.querySelectorAll(".tlg-sh-edit").forEach(function (btn) {
            btn.addEventListener("click", function () {
                var idx = Number(btn.dataset.idx);
                var textDiv = document.getElementById("tlg-sh-text-" + idx);
                var editArea = document.getElementById("tlg-sh-editarea-" + idx);
                if (textDiv) textDiv.style.display = "none"; if (editArea) editArea.style.display = "block"; btn.style.display = "none";
            });
        });
        listWrap.querySelectorAll(".tlg-sh-save").forEach(function (btn) {
            btn.addEventListener("click", function () {
                flashBtn(this); var idx = Number(btn.dataset.idx); var ta = document.getElementById("tlg-sh-ta-" + idx);
                if (ta && state.summaries[idx]) state.summaries[idx].text = ta.value;
                saveCurrentWorld(); refreshSummary();
                var kw = (document.getElementById("tlg-sh-search") || {}).value || ""; renderSummaryList(kw.trim().toLowerCase()); toast("档案已更新");
            });
        });
        listWrap.querySelectorAll(".tlg-sh-del").forEach(function (btn) {
            btn.addEventListener("click", function () {
                var idx = Number(btn.dataset.idx); if (!confirm("确定抹除这条记录?")) return;
                state.summaries.splice(idx, 1); saveCurrentWorld(); refreshSummary();
                var kw = (document.getElementById("tlg-sh-search") || {}).value || ""; renderSummaryList(kw.trim().toLowerCase()); toast("已抹除");
            });
        });
        listWrap.querySelectorAll(".tlg-sh-compress1").forEach(function(btn) {
            btn.addEventListener("click", function() {
                var idx = Number(btn.dataset.idx);
                if (!confirm("将第 #" + (idx+1) + " 条单独浓缩(重写为更精简版本)?")) return;
                compressSummaries([idx], function(compressed) {
                    if (compressed) {
                        state.summaries[idx] = compressed[0];
                        saveCurrentWorld(); refreshSummary();
                        var kw = (document.getElementById("tlg-sh-search") || {}).value || ""; renderSummaryList(kw.trim().toLowerCase());
                        toast("⧗单条浓缩完成");
                    }
                });
            });
        });
    }

    function showCompressRangeModal() {
        var existing = document.getElementById("tlg-compress-modal"); if (existing) existing.remove();
        if (!state.summaries || state.summaries.length < 2) { toast("至少需要2条总结才能选范围浓缩"); return; }
        var backdrop = document.createElement("div"); backdrop.id = "tlg-compress-modal";
        backdrop.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100dvh;background:rgba(0,0,0,0.85);z-index:2147483647;display:flex;align-items:flex-start;justify-content:center;padding:16px;padding-top:10vh;box-sizing:border-box;overflow-y:auto;";
        var maxIdx = state.summaries.length;
        var opts = state.summaries.map(function(s, i) { return '<option value="' + i + '">#' + (i+1) + ' · ' + new Date(s.timestamp).toLocaleDateString() + (s.compressed ? " [已浓缩]" : "") + '</option>'; }).join("");
        backdrop.innerHTML = '<div class="tlg-modal"><div class="tlg-modal-title"> 选范围浓缩</div>' +
            '<div style="font-size:12px;color:#7a7a8a;margin-bottom:12px;">选择起止条目,将该范围内的未浓缩条目合并压缩为一条。</div>' +
            '<label class="tlg-label">起始(含)</label><select class="tlg-select" id="tlg-cr-from" style="width:100%;margin-bottom:10px;">' + opts + '</select>' +
            '<label class="tlg-label">结束(含)</label><select class="tlg-select" id="tlg-cr-to" style="width:100%;margin-bottom:16px;">' + opts + '</select>' +
            '<div class="tlg-modal-actions"><button type="button" class="tlg-btn" id="tlg-cr-cancel">取消</button><button type="button" class="tlg-btn tlg-btn-primary" id="tlg-cr-ok">确认浓缩</button></div></div>';
        document.body.appendChild(backdrop);
        var fromSel = backdrop.querySelector("#tlg-cr-from");
        var toSel = backdrop.querySelector("#tlg-cr-to");
        toSel.selectedIndex = maxIdx - 1;
        backdrop.querySelector("#tlg-cr-cancel").onclick = function() { backdrop.remove(); };
        backdrop.querySelector("#tlg-cr-ok").onclick = function() {
            var from = parseInt(fromSel.value, 10), to = parseInt(toSel.value, 10);
            if (from > to) { toast("起始不能大于结束"); return; }
            var indices = [];
            for (var i = from; i <= to; i++) { if (!state.summaries[i].compressed) indices.push(i); }
            if (!indices.length) { toast("所选范围内无未浓缩条目"); backdrop.remove(); return; }
            backdrop.remove();
            compressSummariesAndReplace(indices);
        };
        backdrop.addEventListener("click", function(e) { if (e.target === backdrop) backdrop.remove(); });
    }

    function compressSummaries(indices, callback) {
        if (!apiUrl) { toast("请先配置API地址"); return; }
        var capturedNodeId = state.currentNodeId;
        if (!capturedNodeId) console.warn("[浓缩] nodeId 为空,请检查触发时机");
        var texts = indices.map(function(i){ return state.summaries[i].text; }).join("\n\n---\n\n");
        var prompt = (globalApi.compressPrompt || "").replace("{{context}}", texts);
        toast("⧗ 浓缩中...");
        fetch(buildEndpoint(apiUrl, "/chat/completions"), {
            method: "POST", headers: Object.assign({ "Content-Type": "application/json" }, apiKey ? { Authorization: "Bearer " + apiKey } : {}),
            body: JSON.stringify({ model: model || undefined, messages: [{ role: "user", content: prompt }], max_tokens: 1024 })
        }).then(function(r){ return r.json(); }).then(function(data){
            var text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
            callback([{ timestamp: Date.now(), text: text, nodeId: capturedNodeId, compressed: true, sourceCount: indices.length }]);
        }).catch(function(e){ toast("浓缩失败:" + e.message); });
    }

    function compressSummariesAndReplace(indices) {
        compressSummaries(indices, function(compressed) {
            if (!compressed) return;
            var sorted = indices.slice().sort(function(a,b){ return b-a; });
            sorted.forEach(function(i){ state.summaries.splice(i, 1); });
            state.summaries.splice(indices[0], 0, compressed[0]);
            saveCurrentWorld(); refreshSummary();
            var kw = (document.getElementById("tlg-sh-search") || {}).value || ""; renderSummaryList(kw.trim().toLowerCase());
            toast("✓ 浓缩完成," + indices.length + " 条合并为 1 条");
        });
    }
    // 检查是否需要自动浓缩(写入新总结后调用)
    function checkAutoCompress() {
        if (!globalApi.autoCompress) return;
        var maxCount = Math.max(10, globalApi.summaryMaxCount || 100);
        if (state.summaries.length <= maxCount) return;
        // 取最旧的未浓缩条目
        var batchSize = Math.max(2, globalApi.compressBatchSize || 10);
        var indices = [];
        var path = getPathToRoot(state.currentNodeId);
        for (var i = 0; i < state.summaries.length && indices.length < batchSize; i++) {
            if (!state.summaries[i].compressed && (!state.summaries[i].nodeId || path.indexOf(state.summaries[i].nodeId) !== -1)) {
                indices.push(i);
            }
        }
        if (indices.length < 2) {
            toast("⚠ 档案库已满(" + state.summaries.length + " 条),已无可浓缩的未浓缩条目,请手动清理");
            return;
        }
        toast("⚙ 档案库已满,自动浓缩最旧 " + indices.length + " 条...");
        compressSummariesAndReplace(indices);
    }

    // ── AI 接口 ──
    function updateInjection() {
        var st = getST(); if (!st || typeof st.setExtensionPrompt !== "function") return;
        if (!state.summaries || !state.summaries.length) { st.setExtensionPrompt(EXT_NAME, "", 1, 2); return; }
        var items;
        if (globalApi.summaryFilterMode !== false) {
            var path = getPathToRoot(state.currentNodeId);
            items = state.summaries.filter(function (s) { return !s.nodeId || path.indexOf(s.nodeId) !== -1; });
        } else { items = state.summaries.slice(); }
        if (!items.length) { st.setExtensionPrompt(EXT_NAME, "", 1, 2); return; }
        var count = Math.min(3, items.length); var recent = items.slice(-count);
        var template = globalApi.vectorPrompt || ""; var content = recent.map(function (s) { return s.text; }).join("\n\n---\n\n");
        var injectionText = (template && template.indexOf("{{context}}") !== -1) ? template.replace("{{context}}", content) : "以下为已记录的近期因果档案:\n\n" + content + "\n\n请保持叙事与上述记录的连续性。";
        st.setExtensionPrompt(EXT_NAME, injectionText, 1, 2);
    }
        function updateInjectionWithVector() {
        var st = getST(); if (!st || typeof st.setExtensionPrompt !== "function") return;
        if (!state.summaries || !state.summaries.length) { st.setExtensionPrompt(EXT_NAME, "", 1, 2); return; }
        var vecUrl = (globalApi.vectorUrl || "").trim(), vecKey = (globalApi.vectorKey || "").trim(), vecModel = (globalApi.vectorModel || "").trim();
        if (!vecUrl || !vecModel) { updateInjection(); return; }
        var queryWindow = Math.max(1, globalApi.vectorQueryWindow || 5);
        var chat = (st.chat || []).slice(-queryWindow).map(function (m) { return (m.mes || "").slice(0, 300); }).join(" ");
        if (!chat.trim()) { updateInjection(); return; }
        _vectorSearchWithRetry(st, vecUrl, vecKey, vecModel, chat, 0);
    }

    function _vectorSearchWithRetry(st, vecUrl, vecKey, vecModel, chat, retryCount) {
        var MAX_RETRIES = 3;
        var topK = Math.max(1, globalApi.vectorTopK || 8);
        var chunkLen = Math.max(100, globalApi.vectorChunkLen || 600);
        var threshold = globalApi.vectorThreshold || 0;
        fetch(buildEndpoint(vecUrl, "/embeddings"), {
            method: "POST", headers: Object.assign({ "Content-Type": "application/json" }, vecKey ? { Authorization: "Bearer " + vecKey } : {}),
            body: JSON.stringify({ model: vecModel, input: chat })
        }).then(function (r) { if (!r.ok) throw new Error("嵌入请求 HTTP " + r.status); return r.json(); }).then(function (data) {
            var queryVec = data.data && data.data[0] && data.data[0].embedding;
            if (!queryVec) { updateInjection(); return; }
            var pool;
            if (globalApi.summaryFilterMode !== false) {
                var path = getPathToRoot(state.currentNodeId);
                pool = state.summaries.filter(function (s) { return !s.nodeId || path.indexOf(s.nodeId) !== -1; });
            } else { pool = state.summaries.slice(); }
            if (!pool.length) { updateInjection(); return; }
            var texts = pool.map(function (s) { return s.text.slice(0, chunkLen); });
            return fetch(buildEndpoint(vecUrl, "/embeddings"), {
                method: "POST", headers: Object.assign({ "Content-Type": "application/json" }, vecKey ? { Authorization: "Bearer " + vecKey } : {}),
                body: JSON.stringify({ model: vecModel, input: texts })
            }).then(function (r2) { if (!r2.ok) throw new Error("档案嵌入 HTTP " + r2.status); return r2.json(); }).then(function (data2) {
                var embeddings = (data2.data || []).map(function (d) { return d.embedding; });
                var scored = [];
                for (var i = 0; i < embeddings.length; i++) {
                    if (!embeddings[i]) continue;
                    var emb = embeddings[i], dot = 0, na = 0, nb = 0;
                    for (var k = 0; k < emb.length; k++) { dot += queryVec[k] * emb[k]; na += queryVec[k] * queryVec[k]; nb += emb[k] * emb[k]; }
                    var sim = dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-8);
                    scored.push({ idx: i, score: sim, text: pool[i].text });
                }
                scored.sort(function (a, b) { return b.score - a.score; });
                if (threshold > 0) {
                    scored = scored.filter(function (s) { return s.score >= threshold; });
                }
                if (!scored.length) { updateInjection(); return; }
                var candidates = scored.slice(0, topK);
                var rerankUrl = (globalApi.rerankUrl || "").trim();
                var rerankModel = (globalApi.rerankModel || "").trim();
                if (rerankUrl && rerankModel && candidates.length > 1) {
                    _rerankAndInject(st, rerankUrl, (globalApi.rerankKey || "").trim(), rerankModel, chat, candidates, 0);
                } else {
                    _finalInject(st, candidates);
                }
            });
        }).catch(function (e) {
            console.error("[TLG] Vector:", e);
            if (retryCount < MAX_RETRIES) {
                var delay = (retryCount + 1) * 2000;
                toast("⚠ 向量检索失败," + (delay / 1000) + "秒后重试 (" + (retryCount + 1) + "/" + MAX_RETRIES + ")");
                setTimeout(function () { _vectorSearchWithRetry(st, vecUrl, vecKey, vecModel, chat, retryCount + 1); }, delay);
            } else {
                toast("⚠ 向量检索最终失败,回退直接注入");
                updateInjection();
            }
        });
    }

    // ── 重排接口 /rerank ──
    function _rerankAndInject(st, rerankUrl, rerankKey, rerankModel, query, candidates, retryCount) {
        var MAX_RETRIES = 2;
        var topN = Math.max(1, globalApi.rerankTopN || 3);
        var rerankThreshold = globalApi.rerankThreshold || 0;
        var documents = candidates.map(function (c) { return c.text; });
        fetch(buildEndpoint(rerankUrl, "/rerank"), {
            method: "POST",
            headers: Object.assign({ "Content-Type": "application/json" }, rerankKey ? { Authorization: "Bearer " + rerankKey } : {}),
            body: JSON.stringify({ model: rerankModel, query: query, documents: documents, top_n: topN })
        }).then(function (r) { if (!r.ok) throw new Error("重排 HTTP " + r.status); return r.json(); }).then(function (data) {
            var results = data.results || [];
            if (results.length) {
                results.sort(function (a, b) { return (b.relevance_score || 0) - (a.relevance_score || 0); });
                if (rerankThreshold > 0) {
                    results = results.filter(function (r) { return (r.relevance_score || 0) >= rerankThreshold; });
                }
                var reranked = results.slice(0, topN).map(function (item) { return candidates[item.index]; });
                _finalInject(st, reranked.length ? reranked : candidates.slice(0, topN));
            } else {
                _finalInject(st, candidates.slice(0, topN));
            }
        }).catch(function (e) {
            console.error("[TLG] Rerank:", e);
            if (retryCount < MAX_RETRIES) {
                var delay = (retryCount + 1) * 1500;
                toast("⚠ 重排失败," + (delay / 1000) + "秒后重试");
                setTimeout(function () { _rerankAndInject(st, rerankUrl, rerankKey, rerankModel, query, candidates, retryCount + 1); }, delay);
            } else {
                toast("⚠ 重排最终失败,使用向量原始排序");
                _finalInject(st, candidates);
            }
        });
    }

    function _finalInject(st, items) {
        var topN = Math.max(1, globalApi.rerankTopN || 3);
        var maxChars = Math.max(200, globalApi.vectorMaxChars || 4000);
        var final = items.slice(0, topN);
        var parts = [], usedChars = 0;
        for (var i = 0; i < final.length; i++) {
            var text = final[i].text || "";
            if (usedChars + text.length > maxChars) {
                var remain = maxChars - usedChars;
                if (remain > 50) parts.push(text.slice(0, remain) + "...");
                break;
            }
            parts.push(text); usedChars += text.length;
        }
        var content = parts.join("\n\n---\n\n");
        var template = globalApi.vectorPrompt || "";
        var injectionText = (template && template.indexOf("{{context}}") !== -1) ? template.replace("{{context}}", content) : "以下为与当前情境相关的因果档案:\n\n" + content;
        var depth = Math.max(0, globalApi.vectorInjectDepth || 0);
        st.setExtensionPrompt(EXT_NAME, injectionText, 1, depth);
    }

    function buildEndpoint(base, path) {
        var url = (base || "").trim().replace(/\/+$/, "");
        if (path === "/chat/completions" && /\/chat\/completions$/.test(url)) return url;
        if (path === "/models" && /\/models$/.test(url)) return url;
        if (!/\/v\d+/.test(url)) url += "/v1"; return url + path;
    }

    // ── 切片请求(总结) ──
    function _doSummaryRequest(messagesArray, auto, sourceLabel, onDone) {
        var apiUrl = (globalApi.apiUrl || "").trim(), apiKey = (globalApi.apiKey || "").trim();
        var model = (globalApi.model || "").trim(), summaryPrompt = (globalApi.summaryPrompt || "").trim();
        var capturedNodeId = state.currentNodeId;
        if (!capturedNodeId) console.warn("[总结] nodeId 为空,请检查触发时机");
        if (!apiUrl) { toast("切片失败:未设置 API 地址"); if (typeof onDone === "function") onDone(); return; }
        if (!messagesArray || !messagesArray.length) { if (!auto) toast("没有可用的消息"); if (typeof onDone === "function") onDone(); return; }

        var st = getST();
        var firstFloor = -1, lastFloor = -1;
        if (st && st.chat) {
            for (var fi = 0; fi < st.chat.length; fi++) {
                if (st.chat[fi] === messagesArray[0] && firstFloor === -1) firstFloor = fi;
                if (st.chat[fi] === messagesArray[messagesArray.length - 1]) lastFloor = fi;
            }
        }
        var floorLabel = (firstFloor >= 0 && lastFloor >= 0) ? " [#" + firstFloor + "~#" + lastFloor + "]" : "";
        var lockedWorldId = currentWorldId;
        var recentChat = messagesArray.map(function (m) { return (m.name || m.role || "???") + ": " + (m.mes || ""); }).join("\n");
        var prompt = summaryPrompt.replace("{{context}}", recentChat);
        var btn = document.getElementById("tlg-summary-run"); if (btn) btn.disabled = true;
        var label = sourceLabel || (auto ? "自动" : "手动");
        toast("⧗ " + label + "切片中..." + floorLabel);
        var sendBtn = document.getElementById("send_but");
        if (sendBtn) { sendBtn.disabled = true; sendBtn.style.opacity = "0.4"; }

        fetch(buildEndpoint(apiUrl, "/chat/completions"), {
            method: "POST", headers: Object.assign({ "Content-Type": "application/json" }, apiKey ? { Authorization: "Bearer " + apiKey } : {}),
            body: JSON.stringify({ model: model || undefined, messages: [{ role: "user", content: prompt }], max_tokens: 2048})
        }).then(function (res) { if (!res.ok) throw new Error("HTTP " + res.status); return res.json(); })
        .then(function (data) {
            var text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
            if (lockedWorldId && worlds[lockedWorldId]) {
                if (!worlds[lockedWorldId].summaries) worlds[lockedWorldId].summaries = [];
                worlds[lockedWorldId].summaries.push({ timestamp: Date.now(), text: text, nodeId: capturedNodeId, floorFrom: firstFloor, floorTo: lastFloor });
                if (auto && firstFloor >= 0 && lastFloor >= 0) {
                    state.lastAutoSummaryRange = { floorFrom: firstFloor, floorTo: lastFloor, summaryIdx: worlds[lockedWorldId].summaries.length - 1 };
                }
                if (lockedWorldId === currentWorldId) {
                    state.summaries = worlds[lockedWorldId].summaries;
                    refreshSummary();
                }
                saveWorlds(); updateInjectionWithVector();
                checkAutoCompress();
                toast("✓ " + label + "切片完成" + floorLabel);
            }
        }).catch(function (e) { toast("✗ " + label + "切片失败:" + e.message); })
        .then(function () {
            if (btn) btn.disabled = false;
            if (sendBtn) { sendBtn.disabled = false; sendBtn.style.opacity = ""; }
            if (typeof onDone === "function") onDone();
        });
    }
    
    function _getCoveredUpTo() {
        var coveredUpTo = -1;
        if (state.summaries && state.summaries.length) {
            for (var i = 0; i < state.summaries.length; i++) {
                var s = state.summaries[i];
                if (typeof s.floorTo === "number" && s.floorTo > coveredUpTo) coveredUpTo = s.floorTo;
            }
        }
        return coveredUpTo;
    }

    function runSummaryWithMessages(messagesArray) { _doSummaryRequest(messagesArray, true, "跳转前"); }

    function runSummary(auto) {
        var st = getST(); if (!st || !st.chat || !st.chat.length) { if (!auto) toast("当前无聊天消息"); return; }
        ensureWorldExists();
        var interval = globalApi.autoInterval || 10;
        var coveredUpTo = _getCoveredUpTo();
        var uncovered = [];
        for (var j = 0; j < st.chat.length; j++) {
            if (j === 0) continue;
            if (j <= coveredUpTo) continue;
            uncovered.push(st.chat[j]);
        }
        if (auto) {
            if (uncovered.length < interval) return;
            var batch = uncovered.slice(0, interval);
            _doSummaryRequest(batch, true, "自动");
        } else {
            var count = globalApi.manualCount || 20;
            var recent = st.chat.slice(-count);
            if (recent.length && recent[0] === st.chat[0]) recent = recent.slice(1);
            _doSummaryRequest(recent, false, "手动");
        }
    }

    function runCatchupSummary() {
        var st = getST(); if (!st || !st.chat || !st.chat.length) { toast("当前无聊天消息"); return; }
        ensureWorldExists();
        var batchSize = Math.max(1, globalApi.autoInterval || 10);
        var coveredUpTo = -1;
        if (state.summaries && state.summaries.length) {
            for (var i = 0; i < state.summaries.length; i++) {
                var s = state.summaries[i];
                if (typeof s.floorTo === "number" && s.floorTo > coveredUpTo) coveredUpTo = s.floorTo;
            }
        }
        var uncovered = [];
        for (var j = 0; j < st.chat.length; j++) {
            if (j === 0) continue;
            if (j <= coveredUpTo) continue;
            uncovered.push(st.chat[j]);
        }
        if (!uncovered.length) { toast("所有楼层已被覆盖,无需补全"); return; }
        var batches = [];
        for (var k = 0; k < uncovered.length; k += batchSize) {
            var batch = uncovered.slice(k, k + batchSize);
            if (batch.length < batchSize) break;
            batches.push(batch);
        }
        if (!batches.length) { toast("未覆盖消息不足 " + batchSize + " 条,暂不补全"); return; }
        toast(" 开始补全历史切片,共 " + batches.length + " 批...");
        var sendBtn = document.getElementById("send_but");
        if (sendBtn) { sendBtn.disabled = true; sendBtn.style.opacity = "0.4"; }
        var catchupBtns = document.querySelectorAll("#tlg-summary-catchup-btn,#tlg-vault-catchup");
        catchupBtns.forEach(function(b){ b.disabled = true; });
        var idx = 0;
        function nextBatch() {
            if (idx >= batches.length) {
                toast("✓ 历史补全完成,共 " + batches.length + " 批");
                if (sendBtn) { sendBtn.disabled = false; sendBtn.style.opacity = ""; }
                catchupBtns.forEach(function(b){ b.disabled = false; });
                return;
            }
            var batch = batches[idx]; idx++;
            _doSummaryRequest(batch, true, "补全 " + idx + "/" + batches.length, nextBatch);
        }
        nextBatch();
    }
    
    // ══════════════════════════════════════
    // 摘要引擎(记忆抽取)
    // ══════════════════════════════════════
    // 获取当前 MVU 内的游戏时间(若有)
    function getTurnTime() {
        try {
            var snap = window.__tlg_mvu_snapshot || {};
            var t = snap.time || snap.game_time || snap.current_time || snap.date || snap.gameTime || "";
            return String(t).trim();
        } catch (e) { return ""; }
    }

    // 解析 AI 返回的摘要 JSON,做基本容错
    function parseMemoryJson(raw) {
        try {
            var cleaned = raw.trim()
                .replace(/^```json\s*/i, "").replace(/^```\s*/i, "")
                .replace(/```\s*$/i, "").trim();
            var match = cleaned.match(/\{[\s\S]*\}/);
            if (match) cleaned = match[0];
            var obj = JSON.parse(cleaned);
            return {
                narrative: typeof obj.narrative === "string" ? obj.narrative : (typeof obj.summary === "string" ? obj.summary : ""),
                turn_time: obj.turn_time || null,
                location: obj.location || null,
                characters: Array.isArray(obj.characters) ? obj.characters : [],
                items: Array.isArray(obj.items) ? obj.items : [],
                key_events: Array.isArray(obj.key_events) ? obj.key_events : [],
                unresolved: Array.isArray(obj.unresolved) ? obj.unresolved : [],
                importance: typeof obj.importance === "number" ? Math.min(10, Math.max(1, obj.importance)) : 5
            };
        } catch (e) {
            return {
                narrative: raw.slice(0, 3000), turn_time: null, location: null,
                characters: [], items: [], key_events: [], unresolved: [], importance: 5
            };
        }
    }

    // ██████████████████████████████████████████████████████████████████████
    // 摘要结果 → 地理树
    // ██████████████████████████████████████████████████████████████████████
    function applyGeoUpdates(location, lockedWorldId) {
        if (!location || !lockedWorldId || !worlds[lockedWorldId]) return;
        if (!worlds[lockedWorldId].geoTree) worlds[lockedWorldId].geoTree = {};
        var tree = worlds[lockedWorldId].geoTree;
        var path = location.path;
        if (!Array.isArray(path) || !path.length) return;

        var PLACEHOLDER_BLOCKLIST = ["未知", "未知所在", "未知地点", "未知位置", "某处", "某地", "不明", "不明地点", "不明位置", "暂无", "待定", "无", "none", "unknown", "n/a"];
        for (var bl = 0; bl < path.length; bl++) {
            var seg = (path[bl] || "").trim().toLowerCase();
            if (!seg || PLACEHOLDER_BLOCKLIST.indexOf(seg) !== -1) {
                console.warn("[地理] 检测到占位/空地名,已丢弃本轮地点更新:", JSON.stringify(path));
                return;
            }
        }

        var SUFFIXES = /[城镇村国区街路府殿宫楼阁谷山洞岛市县省堡寨营坊]$/;
        function normalize(name) {
            return name.toLowerCase().replace(/\s+/g, "").replace(/[((].*?[))]/g, "").replace(SUFFIXES, "");
        }
        function isSimilar(a, b) {
            var na = normalize(a), nb = normalize(b);
            if (a.replace(/\s+/g, "") === b.replace(/\s+/g, "")) return true;
            if (!na || !nb) return false;
            if (na === nb) return true;
            var shorter = na.length <= nb.length ? na : nb;
            var longer  = na.length <= nb.length ? nb : na;
            if (shorter.length < 2) return false;
            var isAffix = longer.indexOf(shorter) === 0 || longer.indexOf(shorter) === longer.length - shorter.length;
            return isAffix && shorter.length >= longer.length / 2;
        }
        function findSimilarInLevel(siblings, newName) {
            var keys = Object.keys(siblings);
            for (var i = 0; i < keys.length; i++) { if (isSimilar(keys[i], newName)) return keys[i]; }
            return null;
        }

        var normalizedPath = [];
        var cur0 = tree;
        for (var p = 0; p < path.length; p++) {
            var similar = findSimilarInLevel(cur0, path[p]);
            if (similar) {
                normalizedPath.push(similar);
                cur0 = cur0[similar].children;
            } else {
                normalizedPath.push(path[p]);
                if (!cur0[path[p]]) cur0[path[p]] = { desc: "", locked: false, isCurrent: false, hidden: false, children: {} };
                cur0 = cur0[path[p]].children;
            }
        }
        path = normalizedPath;

        function clearCurrent(obj) {
            Object.keys(obj).forEach(function(k) { obj[k].isCurrent = false; if (obj[k].children) clearCurrent(obj[k].children); });
        }
        clearCurrent(tree);

        var cur = tree;
        for (var i = 0; i < path.length; i++) {
            var name = path[i];
            if (i === path.length - 1) {
                if (!cur[name].locked && location.desc) {
                    if (!cur[name].desc) cur[name].desc = location.desc;
                    else if (cur[name].desc.indexOf(location.desc) === -1) cur[name].desc += ";" + location.desc;
                    if (cur[name].desc.length > 300) cur[name].desc = cur[name].desc.slice(0, 300) + "...";
                }
                if (location.is_current) cur[name].isCurrent = true;
            }
            cur = cur[name].children;
        }

        if (Array.isArray(location.moved_from) && location.moved_from.length) {
            var mfPath = location.moved_from;
            var cur2 = tree;
            for (var j = 0; j < mfPath.length; j++) {
                var sim2 = findSimilarInLevel(cur2, mfPath[j]);
                var use2 = sim2 || mfPath[j];
                if (!cur2[use2]) cur2[use2] = { desc: "", locked: false, isCurrent: false, hidden: false, children: {} };
                cur2 = cur2[use2].children;
            }
        }
        saveWorlds();
    }

    // 地理树:合并两个节点
    function mergeGeoNodes(lockedWorldId, srcPath, destPath) {
        if (!worlds[lockedWorldId] || !worlds[lockedWorldId].geoTree) return false;
        var tree = worlds[lockedWorldId].geoTree;
        function locate(path) {
            var cur = tree, parent = null, key = null;
            for (var i = 0; i < path.length; i++) {
                if (!cur[path[i]]) return null;
                parent = cur; key = path[i];
                cur = i === path.length - 1 ? cur[path[i]] : cur[path[i]].children;
            }
            return { node: parent[key], parent: parent, key: key };
        }
        function mergeChildren(destChildren, srcChildren) {
            Object.keys(srcChildren).forEach(function(k) {
                if (!destChildren[k]) { destChildren[k] = srcChildren[k]; }
                else {
                    if (srcChildren[k].desc && destChildren[k].desc.indexOf(srcChildren[k].desc) === -1)
                        destChildren[k].desc = destChildren[k].desc ? destChildren[k].desc + ";" + srcChildren[k].desc : srcChildren[k].desc;
                    mergeChildren(destChildren[k].children, srcChildren[k].children);
                }
            });
        }
        var src = locate(srcPath), dest = locate(destPath);
        if (!src || !dest) return false;
        if (src.node.desc && dest.node.desc.indexOf(src.node.desc) === -1)
            dest.node.desc = dest.node.desc ? dest.node.desc + ";" + src.node.desc : src.node.desc;
        mergeChildren(dest.node.children, src.node.children);
        delete src.parent[src.key];
        saveWorlds(); return true;
    }

    // ██████████████████████████████████████████████████████████████████████
    // 摘要结果 → NPC 样本库
    // ██████████████████████████████████████████████████████████████████████
    function applyNpcUpdates(characters, lockedWorldId, turnTime) {
        if (!characters || !characters.length || !lockedWorldId || !worlds[lockedWorldId]) return;
        var world = worlds[lockedWorldId];
        var archive = world.npcArchive || (world.npcArchive = {});
        var pending = world.pendingReview || (world.pendingReview = { npc: [], item: [] });
        var GENERIC_BLOCKLIST = ["你", "我", "他", "她", "它", "主角", "玩家", "那个人", "对方", "自己", "user", "player"];

        function findExactNpc(names, newName) {
            var target = newName.trim();
            for (var i = 0; i < names.length; i++) { if (names[i].trim() === target) return names[i]; }
            return null;
        }

        characters.forEach(function(ch) {
            if (!ch.name || GENERIC_BLOCKLIST.indexOf(ch.name.trim().toLowerCase()) !== -1) return;
            var rawName = ch.name.trim();
            var standardName = findExactNpc(Object.keys(archive), rawName) || rawName;

            if (ch.certain === false) {
                pending.npc.push({ name: rawName, role: ch.role || "", state_delta: ch.state_delta || null,
                    certain: ch.certain !== false, timestamp: turnTime || "", turn: state.turnCounter || 0 });
                return;
            }
            if (!archive[standardName]) {
                archive[standardName] = { role: ch.role || "", tier: "normal",
                    order: Date.now(), hidden: false, lastActiveTurn: 0,
                    appearance: { value: "", locked: false }, age: { value: "", locked: false }, timeline: [], custom: [] };
            }
            if (ch.role && !archive[standardName].role) archive[standardName].role = ch.role;
            archive[standardName].timeline.push({ event: ch.state_delta, timestamp: turnTime || getTurnTime() || "", auto: true, createdAt: Date.now() });
            archive[standardName].lastActiveTurn = state.turnCounter || 0;
            if (ch.aliases && ch.aliases.length) {
                if (!archive[standardName].aliases) archive[standardName].aliases = [];
                ch.aliases.forEach(function(a) {
                    if (a && archive[standardName].aliases.indexOf(a) === -1) archive[standardName].aliases.push(a);
                });
            }
            if (ch.age && ch.age !== "null") {
                archive[standardName].age = { value: ch.age, locked: false };
            }
        });
        saveWorlds();
    }

    function mergeNpcEntries(lockedWorldId, srcName, destName) {
        var archive = worlds[lockedWorldId] && worlds[lockedWorldId].npcArchive;
        if (!archive || !archive[srcName] || !archive[destName]) return false;
        archive[destName].timeline = archive[destName].timeline.concat(archive[srcName].timeline);
        archive[destName].timeline.sort(function(a, b) { return (a.timestamp || "").localeCompare(b.timestamp || ""); });
        archive[destName].lastActiveTurn = Math.max(archive[destName].lastActiveTurn || 0, archive[srcName].lastActiveTurn || 0);
        delete archive[srcName];
        saveWorlds(); return true;
    }

    function applyItemUpdates(items, lockedWorldId, turnTime) {
        if (!items || !items.length || !lockedWorldId || !worlds[lockedWorldId]) return;
        var world = worlds[lockedWorldId];
        var archive = world.itemArchive || (world.itemArchive = {});
        var pending = world.pendingReview || (world.pendingReview = { npc: [], item: [] });

        function findExactItem(names, newName) {
            var target = newName.trim();
            for (var i = 0; i < names.length; i++) { if (names[i].trim() === target) return names[i]; }
            return null;
        }

        items.forEach(function(it) {
            if (!it.name) return;
                if (it.certain === false) {
                pending.item.push({ name: it.name.trim(), change: it.change || null, owner: it.owner || null,
                    state: it.state || null, certain: it.certain !== false, timestamp: turnTime || "", turn: state.turnCounter || 0 });
                return;
            }
            var standardName = findExactItem(Object.keys(archive), it.name.trim()) || it.name.trim();
            if (!archive[standardName]) archive[standardName] = { hidden: false, lastActiveTurn: 0, history: [] };
            archive[standardName].history.push({ change: it.change, owner: it.owner || null, state: it.state || null, timestamp: turnTime || "" });
            archive[standardName].lastActiveTurn = state.turnCounter || 0;
            if (it.aliases && it.aliases.length) {
                if (!archive[standardName].aliases) archive[standardName].aliases = [];
                it.aliases.forEach(function(a) {
                    if (a && archive[standardName].aliases.indexOf(a) === -1) archive[standardName].aliases.push(a);
                });
            }
        });
        saveWorlds();
    }

    function mergeItemEntries(lockedWorldId, srcName, destName) {
        var archive = worlds[lockedWorldId] && worlds[lockedWorldId].itemArchive;
        if (!archive || !archive[srcName] || !archive[destName]) return false;
        archive[destName].history = archive[destName].history.concat(archive[srcName].history);
        archive[destName].history.sort(function(a, b) { return (a.timestamp || "").localeCompare(b.timestamp || ""); });
        archive[destName].lastActiveTurn = Math.max(archive[destName].lastActiveTurn || 0, archive[srcName].lastActiveTurn || 0);
        delete archive[srcName];
        saveWorlds(); return true;
    }

    function startDigestGrace() {
        cancelDigestGrace();
        var seconds = Math.max(0, globalApi.digestGraceSeconds || 15);
        if (seconds === 0) {
            setTimeout(function() { runDigestRequest(); }, 1000);
            return;
        }
        _digestCountdown = seconds;
        showDigestGraceUI();
        _digestTimer = setInterval(function() {
            _digestCountdown--;
            updateDigestGraceUI();
            if (_digestCountdown <= 0) {
                cancelDigestGrace();
                runDigestRequest();
            }
        }, 1000);
    }

    function cancelDigestGrace() {
        if (_digestTimer) { clearInterval(_digestTimer); _digestTimer = null; }
        _digestCountdown = 0;
        hideDigestGraceUI();
    }

    function showDigestGraceUI() {
        var bar = document.getElementById("tlg-digest-grace-bar");
        if (!bar) {
            bar = document.createElement("div");
            bar.id = "tlg-digest-grace-bar";
            bar.style.cssText = "position:fixed;bottom:80px;right:16px;z-index:2147483646;background:#0a0a14;border:1px solid #2a2a3a;border-radius:6px;padding:8px 14px;display:flex;align-items:center;gap:10px;font-size:12px;color:#c0c0c8;box-shadow:0 4px 16px rgba(0,0,0,0.6);pointer-events:auto;";
            bar.innerHTML = '<span id="tlg-digest-grace-text"></span><button type="button" id="tlg-digest-grace-cancel" style="background:none;border:1px solid #3a3a4a;border-radius:3px;color:#e0e0e8;padding:3px 8px;font-size:11px;cursor:pointer;">取消</button>';
            document.body.appendChild(bar);
            document.getElementById("tlg-digest-grace-cancel").onclick = function() {
                cancelDigestGrace();
                toast("∮ 本轮铭刻已取消。");
            };
        }
        bar.style.display = "flex";
        updateDigestGraceUI();
    }

    function updateDigestGraceUI() {
        var text = document.getElementById("tlg-digest-grace-text");
        if (text) text.textContent = "∮ 铭刻倒计时 " + _digestCountdown + "s";
    }

    function hideDigestGraceUI() {
        var bar = document.getElementById("tlg-digest-grace-bar");
        if (bar) bar.style.display = "none";
    }
    // 从消息HTML中去除标签,保留纯文本
    function stripHtmlTags(html) {
        return String(html || "")
            .replace(/<thinking[\s\S]*?<\/thinking>/gi, "")
            .replace(/<[^>]+>/g, " ")
            .replace(/&nbsp;/gi, " ")
            .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"')
            .replace(/\s{2,}/g, " ")
            .trim();
    }

    // 从AI回复开头的美化标签中提取时间/地点
    function extractHeaderMeta(html) {
        var meta = { time: "", location: "" };
        if (!html) return meta;
        // 去掉thinking后,取开头的标签块内容
        var cleaned = html.replace(/<thinking[\s\S]*?<\/thinking>/gi, "").trim();
        // 取第一个块级标签的全部文本(通常是状态面板)
        var headerMatch = cleaned.match(/^(<(?:div|header|section|table|p)[^>]*>[\s\S]*?<\/(?:div|header|section|table|p)>)/i);
        var headerText = "";
        if (headerMatch) {
            headerText = headerMatch[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        }
        if (!headerText) {
            // 兜底:取前200字符的纯文本
            headerText = cleaned.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
        }
        // 提取时间
        var timePatterns = [
            /(?:时间|日期|TIME|当前时间)[::\s]*([^\n|;;,,<]{2,20})/i,
            /(第[一二三四五六七八九十百千\d]+[天日章回幕][\s\S]{0,10}?(?:清晨|早上|上午|中午|下午|傍晚|黄昏|入夜|夜晚|深夜|子时|丑时|寅时|卯时|辰时|巳时|午时|未时|申时|酉时|戌时|亥时)?)/,
            /((?:黎明|清晨|早上|上午|中午|下午|傍晚|黄昏|入夜|夜晚|深夜|子时|丑时|寅时|卯时|辰时|巳时|午时|未时|申时|酉时|戌时|亥时)[前后]?)/
        ];
        for (var ti = 0; ti < timePatterns.length; ti++) {
            var tm = headerText.match(timePatterns[ti]);
            if (tm) { meta.time = (tm[1] || tm[0]).replace(/^(?:时间|日期|TIME|当前时间)[::\s]*/i, "").trim(); break; }
        }
        // 提取地点
        var locPatterns = [
            /(?:地点|位置|location|场景|所在)[::\s]*([^\n|;;,,<]{2,30})/i
        ];
        for (var li = 0; li < locPatterns.length; li++) {
            var lm = headerText.match(locPatterns[li]);
            if (lm && lm[1]) { meta.location = lm[1].trim(); break; }
        }
        return meta;
    }
    function buildDigestContextHints(lockedWorldId) {
        var geoHint = "", npcHint = "", itemHint = "";
        var wid = lockedWorldId;
        if (!wid || !worlds[wid]) return { geoHint: geoHint, npcHint: npcHint, itemHint: itemHint };

        var ACTIVE_WINDOW = 20;
        var nowTurn = state.turnCounter || 0;

        function stripHidden(obj) {
            var out = {};
            Object.keys(obj).forEach(function(k) {
                if (obj[k].hidden) return;
                out[k] = { desc: obj[k].desc || "", children: stripHidden(obj[k].children || {}) };
            });
            return out;
        }
        var visibleGeo = stripHidden(worlds[wid].geoTree || {});
        if (Object.keys(visibleGeo).length)
            geoHint = "\n\n【已记录地点(树状结构,请按同层匹配规则对照使用)】\n" + JSON.stringify(visibleGeo, null, 2);

        var npcArchive = worlds[wid].npcArchive || {};
        var activeNpc = Object.keys(npcArchive).filter(function(name) {
            var e = npcArchive[name];
            return !e.hidden && (nowTurn - (e.lastActiveTurn || 0)) <= ACTIVE_WINDOW;
        }).map(function(name) {
            var role = npcArchive[name].role;
            return role ? name + "(" + role + ")" : name;
        });
        if (activeNpc.length)
            npcHint = "\n\n【本轮可能在场角色(仅供消歧参考,不代表一定在场)】\n" + activeNpc.join("、");

        var itemArchive = worlds[wid].itemArchive || {};
        var activeItems = Object.keys(itemArchive).filter(function(name) {
            var e = itemArchive[name];
            return !e.hidden && (nowTurn - (e.lastActiveTurn || 0)) <= ACTIVE_WINDOW;
        });
        if (activeItems.length)
            itemHint = "\n\n【已记录物品】\n" + activeItems.join("、");

        return { geoHint: geoHint, npcHint: npcHint, itemHint: itemHint };
    }

    function runDigestRequest(retryCount) {
        retryCount = retryCount || 0;
        var MAX_RETRIES = 3;
        var digestUrl = (globalApi.digestUrl || "").trim();
        var digestKey = (globalApi.digestKey || "").trim();
        var digestModel = (globalApi.digestModel || "").trim();
        var digestPrompt = (globalApi.digestPrompt || "").trim();
        if (!digestUrl || !digestPrompt) return;
        var st = getST(); if (!st || !st.chat || !st.chat.length) return;
        ensureWorldExists();

        // 取最新一条AI回复
        var lastMsg = null;
        for (var i = st.chat.length - 1; i >= 0; i--) {
            if (!st.chat[i].is_user && st.chat[i].mes) { lastMsg = st.chat[i]; break; }
        }
        if (!lastMsg) return;

        // 也取用户最近一条,提供上下文
        var userMsg = null;
        for (var j = st.chat.length - 1; j >= 0; j--) {
            if (st.chat[j].is_user && st.chat[j].mes) { userMsg = st.chat[j]; break; }
        }
        var rawAI = lastMsg.mes || "";
        var headerMeta = extractHeaderMeta(rawAI);

        var context = "";
        if (userMsg) context += (userMsg.name || "User") + ": " + stripHtmlTags(userMsg.mes) + "\n";
        context += (lastMsg.name || "AI") + ": " + stripHtmlTags(rawAI);

        var turnTime = getTurnTime() || headerMeta.time || "";
        var turnTimeHint = turnTime ? "系统提供的当前游戏时间:" + turnTime : "(系统未提供游戏时间,请从正文开头的状态面板中提取)";
        if (headerMeta.location) turnTimeHint += "\n系统提供的当前地点:" + headerMeta.location;
        
        // 注入已有地理路径和物品列表,帮助AI保持命名一致
        // 回合计数器自增(供 NPC/物品的"最近活跃"判定使用)
        state.turnCounter = (state.turnCounter || 0) + 1;

        var hints = buildDigestContextHints(getLinkedWorldId() || currentWorldId);
        context = context + hints.geoHint + hints.npcHint + hints.itemHint;

        var prompt = digestPrompt
            .replace(/\{\{turn_time_hint\}\}/g, turnTimeHint)
            .replace(/\{\{turn_time\}\}/g, turnTime || "")
            .replace(/\{\{context\}\}/g, context);

        var lockedWorldId = currentWorldId;
        var turnIdx = st.chat.length - 1;

        fetch(buildEndpoint(digestUrl, "/chat/completions"), {
            method: "POST",
            headers: Object.assign({ "Content-Type": "application/json" }, digestKey ? { Authorization: "Bearer " + digestKey } : {}),
            body: JSON.stringify({ model: digestModel || undefined, messages: [{ role: "user", content: prompt }], max_tokens: 4096 })
        }).then(function (r) {
            if (!r.ok) throw new Error("HTTP " + r.status);
            return r.json();
        }).then(function (data) {
            var raw = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
            if (!raw.trim()) { toast("⚠ 记忆抽取返回为空"); return; }
            var parsed = parseMemoryJson(raw);
            if (!parsed.narrative) { toast("⚠ 记忆解析失败:无narrative字段"); return; }

            if (!lockedWorldId || !worlds[lockedWorldId]) return;

            // 存入 memories
            if (!worlds[lockedWorldId].memories) worlds[lockedWorldId].memories = [];
            var newMemId = generateId();
            worlds[lockedWorldId].memories.push({
                id: newMemId,
                turnIdx: turnIdx,
                timestamp: Date.now(),
                nodeId: state.currentNodeId,
                narrative: parsed.narrative,
                turn_time: parsed.turn_time,
                location: parsed.location,
                characters: parsed.characters,
                items: parsed.items,
                key_events: parsed.key_events,
                unresolved: parsed.unresolved,
                importance: parsed.importance
            });
            _lastDigestMemoryId = newMemId;

            // 上限保护
            var maxCount = globalApi.factUnitsMaxCount || 500;
            if (worlds[lockedWorldId].memories.length > maxCount) {
                worlds[lockedWorldId].memories = worlds[lockedWorldId].memories.slice(-maxCount);
            }

            // 分发到地理和NPC
            if (parsed.location) applyGeoUpdates(parsed.location, lockedWorldId);
            if (parsed.characters && parsed.characters.length) applyNpcUpdates(parsed.characters, lockedWorldId, parsed.turn_time || "");
            if (parsed.items && parsed.items.length) applyItemUpdates(parsed.items, lockedWorldId, parsed.turn_time || "");
            if (lockedWorldId === currentWorldId) {
                state.memories = worlds[lockedWorldId].memories;
            }
            saveWorlds();

            var geoCount = parsed.location ? 1 : 0;
            var npcCount = parsed.characters.length;
            toast("✓ 记忆 +1 | 地理 +" + geoCount + " | NPC +" + npcCount + " | 重要度 " + parsed.importance);
        }).catch(function (e) {
            console.error("[TLG] Digest:", e);
            if (retryCount < MAX_RETRIES) {
                var delay = (retryCount + 1) * 3000;
                toast("⚠ 记忆抽取失败," + (delay / 1000) + "秒后重试 (" + (retryCount + 1) + "/" + MAX_RETRIES + ")");
                setTimeout(function () { runDigestRequest(retryCount + 1); }, delay);
            } else {
                toast("✗ 记忆抽取最终失败: " + e.message);
            }
        });
    }
	function runCatchupDigest() {
	    var st = getST(); if (!st || !st.chat || !st.chat.length) { toast("当前无聊天消息。"); return; }
	    var digestUrl = (globalApi.digestUrl || "").trim();
	    var digestKey = (globalApi.digestKey || "").trim();
	    var digestModel = (globalApi.digestModel || "").trim();
	    var digestPrompt = (globalApi.digestPrompt || "").trim();
	    if (!digestUrl || !digestPrompt) { toast("⚠ 请先配置摘要引擎端点与提示词。"); return; }
	    ensureWorldExists();
	    var batchSize = Math.max(1, globalApi.digestBatchSize || 1);

	    // 计算已覆盖的最大楼层号
	    var coveredTurns = {};
	    var mems = (currentWorldId && worlds[currentWorldId]) ? (worlds[currentWorldId].memories || []) : [];
	    for (var i = 0; i < mems.length; i++) {
	    if (typeof mems[i].turnIdx === "number") coveredTurns[mems[i].turnIdx] = true;
	    }

	    // 收集未覆盖楼层(跳过#0开场白)
	    var uncovered = [];
	    for (var j = 1; j < st.chat.length; j++) {
	        if (coveredTurns[j]) continue;
	        if (!st.chat[j].mes) continue;
	        uncovered.push({ idx: j, msg: st.chat[j] });
	    }
	    if (!uncovered.length) { toast("所有楼层已有摘要覆盖,无需补全。"); return; }

	    // 按 batchSize 分批,每批内的消息合并为一个 context
	    var batches = [];
	    for (var k = 0; k < uncovered.length; k += batchSize) {
	        var batch = uncovered.slice(k, k + batchSize);
	        batches.push(batch);
	    }
	    if (!batches.length) { toast("无可补全内容。"); return; }

	    toast("∮ 开始补全历史摘要,共 " + batches.length + " 批...");
	    var sendBtn = document.getElementById("send_but");
	    if (sendBtn) { sendBtn.disabled = true; sendBtn.style.opacity = "0.4"; }
	    var catchupBtns = document.querySelectorAll("#tlg-digest-catchup-btn,#tlg-vault-digest-catchup");
	    catchupBtns.forEach(function(b) { b.disabled = true; });

	    var lockedWorldId = currentWorldId;
	    var idx = 0;

	    function nextBatch() {
	        if (idx >= batches.length) {
	            toast("✓ 摘要补全完成,共 " + batches.length + " 批。");
	            if (sendBtn) { sendBtn.disabled = false; sendBtn.style.opacity = ""; }
	            catchupBtns.forEach(function(b) { b.disabled = false; });
	            return;
	        }
	        var batch = batches[idx]; idx++;

	        // 组装 context
	        var context = "";
	        for (var m = 0; m < batch.length; m++) {
	            var msg = batch[m].msg;
	            var msgText = stripHtmlTags(msg.mes);
	            context += (msg.is_user ? (msg.name || "User") : (msg.name || "AI")) + ": " + msgText + "\n";
	            if (!msg.is_user && m === batch.length - 1) {
	                var batchMeta = extractHeaderMeta(msg.mes);
	                if (batchMeta.time && !turnTime) turnTime = batchMeta.time;
	            }
	        }

	        var turnTime = ""; // 补全时无法获取精确游戏时间,留空让 AI 从正文提取
	        var turnTimeHint = "(系统未提供游戏时间,请从正文中提取)";
	        var prompt = digestPrompt
	            .replace(/\{\{turn_time_hint\}\}/g, turnTimeHint)
	            .replace(/\{\{turn_time\}\}/g, turnTime)
	            .replace(/\{\{context\}\}/g, context);

	        var batchTurnIdx = batch[batch.length - 1].idx; // 记录为批次最后一条的楼层号

	        fetch(buildEndpoint(digestUrl, "/chat/completions"), {
	            method: "POST",
	            headers: Object.assign({ "Content-Type": "application/json" }, digestKey ? { Authorization: "Bearer " + digestKey } : {}),
	            body: JSON.stringify({ model: digestModel || undefined, messages: [{ role: "user", content: prompt }], max_tokens: 4096 })
	        }).then(function(r) {
	            if (!r.ok) throw new Error("HTTP " + r.status);
	            return r.json();
	        }).then(function(data) {
	            var raw = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
	            if (!raw.trim()) { toast("⚠ 补全批次 " + idx + " 返回为空,跳过。"); nextBatch(); return; }
	            var parsed = parseMemoryJson(raw);
	            if (!parsed.narrative) { toast("⚠ 补全批次 " + idx + " 解析失败,跳过。"); nextBatch(); return; }

	            if (!lockedWorldId || !worlds[lockedWorldId]) { nextBatch(); return; }
	            if (!worlds[lockedWorldId].memories) worlds[lockedWorldId].memories = [];

	            worlds[lockedWorldId].memories.push({
	                id: generateId(),
	                turnIdx: batchTurnIdx,
	                timestamp: Date.now(),
	                nodeId: state.currentNodeId,
	                narrative: parsed.narrative,
	                turn_time: parsed.turn_time,
	                location: parsed.location,
	                characters: parsed.characters,
	                items: parsed.items,
	                key_events: parsed.key_events,
	                unresolved: parsed.unresolved,
	                importance: parsed.importance
	            });

	            // 分发到地理和NPC
	            if (parsed.location) applyGeoUpdates(parsed.location, lockedWorldId);
	            if (parsed.characters && parsed.characters.length) applyNpcUpdates(parsed.characters, lockedWorldId);
	            if (parsed.items && parsed.items.length) applyItemUpdates(parsed.items, lockedWorldId);
	            if (lockedWorldId === currentWorldId) {
	                state.memories = worlds[lockedWorldId].memories;
	            }
	            saveWorlds();
	            toast("∮ 补全 " + idx + "/" + batches.length + " 完成");
	            // 延迟 1 秒再发下一批,避免 rate limit
	            setTimeout(nextBatch, 1000);
	        }).catch(function(e) {
	            toast("✗ 补全批次 " + idx + " 失败: " + e.message + ",继续下一批。");
	            setTimeout(nextBatch, 2000);
	        });
	    }
	    nextBatch();
	}
	    
	    function fetchDigestModelList() {
	        var apiUrl = (globalApi.digestUrl || "").trim(), apiKey = (globalApi.digestKey || "").trim();
	        if (!apiUrl) { toast("请先设置摘要API地址"); return; }
	        var btn = document.getElementById("tlg-fetch-digest-models"); if (btn) btn.disabled = true;
	        toast("检测摘要模型...");
	        fetch(buildEndpoint(apiUrl, "/models"), { headers: apiKey ? { Authorization: "Bearer " + apiKey } : {} })
	        .then(function (res) { if (!res.ok) throw new Error("HTTP " + res.status); return res.json(); })
	        .then(function (data) {
	            var models = (data.data || data.models || []).map(function (m) { return typeof m === "string" ? m : (m.id || m.name || ""); }).filter(Boolean);
	            globalApi.digestModelList = models; saveGlobalApi(); populateDigestModelSelect();
	            toast("已识别 " + models.length + " 个摘要模型");
	        }).catch(function (e) { toast("通信失败: " + e.message); })
	        .then(function () { if (btn) btn.disabled = false; });
	    }

	    function populateDigestModelSelect() {
	        var sel = document.getElementById("tlg-digest-model-select"); if (!sel) return;
	        sel.innerHTML = '<option value="">-- 选择摘要核心 --</option>' +
	            (globalApi.digestModelList || []).map(function (m) {
	                return '<option value="' + escHtml(m) + '"' + (m === globalApi.digestModel ? " selected" : "") + '>' + escHtml(m) + '</option>';
	            }).join("");
	    }
	// ══════════════════════════════════════
	// 世界档案:地理树(横向布局,可拖动)
	// ══════════════════════════════════════
	var geoCanvas = null, geoCtx = null;
	var geoCamX = 0, geoCamY = 0, geoCamZoom = 1;
	var geoIsPanning = false, geoPanStartX = 0, geoPanStartY = 0;
	var geoMouseDownX = 0, geoMouseDownY = 0, geoDragMoved = false;
	var geoSelectedPath = null;
	var geoInfoBoxPath = null; // 当前信息框内容对应的节点路径,用于避免每帧重建DOM

	// ══════════════════════════════════════
	// 通用弹窗/表单构件(样式全部交给 style.css 中的
	// .tlg-modal / .tlg-label / .tlg-input / .tlg-textarea / .tlg-select / .tlg-btn 等类处理,
	// 这里只负责拼装结构,不再写重复的内联主题样式)
	// ══════════════════════════════════════
	function tlgField(labelText, innerHtml) {
	    return '<label class="tlg-label">' + escHtml(labelText) + '</label>' + innerHtml;
	}
	function tlgBtn(id, text, variant, extraStyle) {
	    var cls = "tlg-btn" + (variant === "primary" ? " tlg-btn-primary" : "");
	    return '<button type="button" class="' + cls + '" id="' + id + '"' + (extraStyle ? ' style="' + extraStyle + '"' : '') + '>' + escHtml(text) + '</button>';
	}
	function tlgActionsRow(buttonsHtml) {
	    return '<div class="tlg-modal-actions">' + buttonsHtml + '</div>';
	}
	// 统一的弹窗遮罩层:负责居中定位 + 点击空白处关闭,内部内容由调用方填充 .tlg-modal
	function tlgModalBackdrop(id) {
	    var old = document.getElementById(id); if (old) old.remove();
	    var bd = document.createElement("div");
	    bd.id = id;
	    bd.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100dvh;background:rgba(0,0,0,0.85);z-index:2147483647;display:flex;align-items:flex-start;justify-content:center;padding:16px;padding-top:12vh;box-sizing:border-box;overflow-y:auto;-webkit-overflow-scrolling:touch;";
	    bd.addEventListener("click", function(e) { if (e.target === bd) bd.remove(); });
	    return bd;
	}
	// 通用 prompt 弹窗(可复用)
	function tlgPrompt(title, message, defaultVal, callback) {
	    var panel = document.getElementById("tlg-panel");
	    var bd = document.createElement("div");
	    bd.className = "tlg-modal-backdrop";
	    bd.innerHTML = '<div class="tlg-modal">' +
	        '<div class="tlg-modal-title">' + escHtml(title) + '</div>' +
	        (message ? '<div style="font-size:11px;color:rgba(255,255,255,0.6);margin-bottom:10px;white-space:pre-wrap;line-height:1.5;">' + escHtml(message) + '</div>' : '') +
	        '<input type="text" class="tlg-input" id="tlg-prompt-input" value="' + escHtml(defaultVal || "") + '" style="margin-bottom:0;" />' +
	        '<div class="tlg-modal-actions">' +
	        '<button type="button" class="tlg-btn" id="tlg-prompt-cancel">取消</button>' +
	        '<button type="button" class="tlg-btn tlg-btn-primary" id="tlg-prompt-ok">确定</button>' +
	        '</div></div>';
	    (panel || document.body).appendChild(bd);
	    var input = bd.querySelector("#tlg-prompt-input");
	    input.focus();
	    input.select();
	    input.addEventListener("keydown", function(e) { if (e.key === "Enter") { bd.querySelector("#tlg-prompt-ok").click(); } });
	    bd.querySelector("#tlg-prompt-cancel").onclick = function() { bd.remove(); };
	    bd.querySelector("#tlg-prompt-ok").onclick = function() {
	        var val = input.value;
	        bd.remove();
	        if (val !== null && val.trim() !== "") callback(val.trim());
	    };
	}

	// 通用搜索UI构建器
	// 使用方式: ensureSearchUI(element, { btnId, panelId, inputId, resultsId, placeholder, onSearch(keyword) })
	// 其中 onSearch 负责根据 keyword 填充 resultsId 容器
	function ensureSearchUI(scopeEl, cfg) {
	    if (!scopeEl || document.getElementById(cfg.btnId)) return;
	    if (getComputedStyle(scopeEl).position === "static") scopeEl.style.position = "relative";

	    // 搜索按钮
	    var btn = document.createElement("button");
	    btn.type = "button"; btn.id = cfg.btnId; btn.className = "tlg-btn";
	    btn.title = "搜索";
	    btn.style.cssText = "position:absolute;top:8px;right:8px;z-index:5;padding:4px 8px;font-size:12px;";
	    btn.textContent = "搜索";
	    scopeEl.appendChild(btn);

	    // 搜索面板
	    var panel = document.createElement("div");
	    panel.id = cfg.panelId; panel.className = "tlg-modal";
	    panel.style.cssText = "position:absolute;top:38px;right:8px;z-index:5;width:220px;max-width:70vw;max-height:280px;padding:10px;display:none;";
	    panel.innerHTML =
	        '<input type="text" id="' + cfg.inputId + '" class="tlg-input" placeholder="' + escHtml(cfg.placeholder) + '" />' +
	        '<div id="' + cfg.resultsId + '" style="max-height:200px;overflow-y:auto;"></div>';
	    scopeEl.appendChild(panel);

	    btn.onclick = function() {
	        var opening = panel.style.display === "none";
	        panel.style.display = opening ? "block" : "none";
	        if (opening) { var inp = document.getElementById(cfg.inputId); inp.value = ""; inp.focus(); cfg.onSearch(""); }
	    };
	    panel.querySelector("#" + cfg.inputId).oninput = function(e) { cfg.onSearch(e.target.value.trim()); };
	    document.addEventListener("click", function(e) {
	        if (panel.style.display !== "none" && e.target !== btn && !panel.contains(e.target)) panel.style.display = "none";
	    });
	}
	function tlgSearchResultItem(cls, dataAttr, dataVal, label, sub) {
	    return '<div class="' + cls + '" data-' + dataAttr + '="' + escHtml(dataVal) + '" style="padding:6px 8px;font-size:11px;cursor:pointer;border-bottom:1px solid #1a1a26;">' +
	        '<div>' + escHtml(label) + '</div>' + (sub ? '<div style="color:rgba(255,255,255,0.5);font-size:10px;margin-top:2px;">' + escHtml(sub) + '</div>' : '') +
	        '</div>';
	}
	function tlgSearchEmpty() { return '<div style="color:rgba(255,255,255,0.45);font-size:11px;padding:6px 2px;">无匹配结果</div>'; }

	// ─────────────────────────────────────
	// 地理数据
	// ─────────────────────────────────────
	function getGeoTree() {
	    if (!currentWorldId || !worlds[currentWorldId]) return {};
	    if (!worlds[currentWorldId].geoTree) worlds[currentWorldId].geoTree = {};
	    return worlds[currentWorldId].geoTree;
	}
	function getGeoNodeByPath(path) {
	    var tree = getGeoTree(); var cur = tree;
	    for (var i = 0; i < path.length; i++) {
	        if (!cur[path[i]]) return null;
	        cur = (i === path.length - 1) ? cur[path[i]] : cur[path[i]].children;
	    }
	    return cur;
	}
	function flattenGeoTree(tree, depth, parentPath) {
	    if (!tree) return [];
	    depth = depth || 0; parentPath = parentPath || [];
	    var result = [];
	    Object.keys(tree).sort().forEach(function(k) {
	        var node = tree[k];
	        if (node.hidden) return;
	        result.push({ name: k, path: parentPath.concat([k]), depth: depth, desc: node.desc || "", locked: !!node.locked, isCurrent: !!node.isCurrent });
	        if (node.children) result = result.concat(flattenGeoTree(node.children, depth + 1, parentPath.concat([k])));
	    });
	    return result;
	}
	function findGeoParentPath(path) { return path.slice(0, -1); }
	function depthToX(depth) { return depth * 180 + 80; }

	// ─────────────────────────────────────
	// 地理Canvas
	// ─────────────────────────────────────
	function initGeoCanvas() {
	    geoCanvas = document.getElementById("tlg-geo-canvas"); if (!geoCanvas) return;
	    geoCtx = geoCanvas.getContext("2d"); renderGeoCanvas();
	    geoCanvas.addEventListener("mousedown", function(e) {
	        if (e.button !== 0) return;
	        geoDragMoved = false;
	        geoMouseDownX = e.clientX; geoMouseDownY = e.clientY;
	        geoIsPanning = true;
	        geoPanStartX = e.clientX - geoCamX; geoPanStartY = e.clientY - geoCamY;
	        geoCanvas.style.cursor = "grabbing";
	    });
	    geoCanvas.addEventListener("mousemove", function(e) {
	        if (!geoIsPanning) return;
	        if (Math.abs(e.clientX - geoMouseDownX) > 4 || Math.abs(e.clientY - geoMouseDownY) > 4) geoDragMoved = true;
	        geoCamX = e.clientX - geoPanStartX; geoCamY = e.clientY - geoPanStartY;
	        renderGeoCanvas();
	    });
	    geoCanvas.addEventListener("mouseup", function(e) {
	        geoIsPanning = false;
	        geoCanvas.style.cursor = "grab";
	        if (!geoDragMoved) { handleGeoClick(e.clientX, e.clientY); }
	    });
	    geoCanvas.addEventListener("mouseleave", function() { geoIsPanning = false; geoCanvas.style.cursor = "grab"; });
	    geoCanvas.addEventListener("wheel", function(e) {
	        e.preventDefault();
	        geoCamZoom = Math.max(0.2, Math.min(5, geoCamZoom * (e.deltaY < 0 ? 1.1 : 0.9))); renderGeoCanvas();
	    });
	    // 触摸
	    geoCanvas.addEventListener("touchstart", function(e) {
	        if (e.touches.length === 1) {
	            geoDragMoved = false;
	            geoMouseDownX = e.touches[0].clientX;
	            geoMouseDownY = e.touches[0].clientY;
	            geoIsPanning = true;
	            geoPanStartX = e.touches[0].clientX - geoCamX;
	            geoPanStartY = e.touches[0].clientY - geoCamY;
	        } else if (e.touches.length === 2) {
	            geoIsPanning = false;
	            var dx = e.touches[0].clientX - e.touches[1].clientX;
	            var dy = e.touches[0].clientY - e.touches[1].clientY;
	            geoLastTouchDist = Math.sqrt(dx * dx + dy * dy);
	        }
	    }, { passive: false });
	    geoCanvas.addEventListener("touchmove", function(e) {
	        e.preventDefault();
	        if (e.touches.length === 1 && geoIsPanning) {
	            geoCamX = e.touches[0].clientX - geoPanStartX; geoCamY = e.touches[0].clientY - geoPanStartY;
	            renderGeoCanvas();
	        } else if (e.touches.length === 2) {
	            var dx = e.touches[0].clientX - e.touches[1].clientX;
	            var dy = e.touches[0].clientY - e.touches[1].clientY;
	            var dist = Math.sqrt(dx * dx + dy * dy);
	            if (geoLastTouchDist > 0) {
	                geoCamZoom = Math.max(0.2, Math.min(5, geoCamZoom * (dist / geoLastTouchDist)));
	                renderGeoCanvas();
	            }
	            geoLastTouchDist = dist;
	        }
	    }, { passive: false });
	    geoCanvas.addEventListener("touchend", function(e) {
	        if (geoIsPanning && !geoDragMoved && e.changedTouches.length === 1) {
	            handleGeoClick(e.changedTouches[0].clientX, e.changedTouches[0].clientY);
	        }
	        geoIsPanning = false; geoLastTouchDist = 0;
	    });
	}

    function layoutGeoNodes(nodes) {
        var byDepth = {}, X_GAP = 180, Y_GAP = 70;
        for (var i = 0; i < nodes.length; i++) {
            var d = nodes[i].depth; if (!byDepth[d]) byDepth[d] = [];
            byDepth[d].push(nodes[i]);
        }
        var depths = Object.keys(byDepth).map(Number).sort(function(a,b){ return a-b; });
        for (var di = 0; di < depths.length; di++) {
            var row = byDepth[depths[di]], startY = -(row.length - 1) * Y_GAP / 2;
            for (var ri = 0; ri < row.length; ri++) {
                row[ri].x = depthToX(depths[di]) + ri * 30 - (row.length - 1) * 15;
                row[ri].y = startY + ri * Y_GAP;
            }
        }
        return nodes;
    }

    function renderGeoCanvas() {
        if (!geoCanvas || !geoCtx) return;
        var dpr = window.devicePixelRatio || 1;
        var rect = geoCanvas.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        geoCanvas.width = rect.width * dpr; geoCanvas.height = rect.height * dpr;
        geoCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
        geoCtx.fillStyle = "#000000"; geoCtx.fillRect(0, 0, rect.width, rect.height);
        geoCtx.save(); geoCtx.translate(rect.width / 2 + geoCamX, rect.height / 2 + geoCamY); geoCtx.scale(geoCamZoom, geoCamZoom);

        var tree = getGeoTree(); var nodes = flattenGeoTree(tree); var layout = layoutGeoNodes(nodes);
        var NODE_R = 14, nodeMap = {};
        for (var i = 0; i < layout.length; i++) nodeMap[layout[i].path.join("/")] = layout[i];

        for (var i = 0; i < layout.length; i++) {
            var n = layout[i]; if (n.path.length <= 1) continue;
            var parentPath = n.path.slice(0, -1).join("/"); var parent = nodeMap[parentPath];
            if (!parent) continue;
            geoCtx.beginPath(); geoCtx.moveTo(parent.x, parent.y + NODE_R);
            var cy = (parent.y + n.y) / 2;
            geoCtx.bezierCurveTo(parent.x, cy, n.x, cy, n.x, n.y - NODE_R);
            var isActive = geoInfoBoxPath && geoInfoBoxPath.join("/") === n.path.join("/");
            geoCtx.strokeStyle = isActive ? "rgba(255,255,255,0.6)" : "rgba(140,140,160,0.3)";
            geoCtx.lineWidth = isActive ? 2.5 : 1.5; geoCtx.stroke();
        }
        for (var i = 0; i < layout.length; i++) {
            var node = layout[i], isCur = node.isCurrent;
            var sel = geoSelectedPath && geoSelectedPath.join("/") === node.path.join("/");
            var focus = geoInfoBoxPath && geoInfoBoxPath.join("/") === node.path.join("/");
            geoCtx.beginPath(); geoCtx.arc(node.x, node.y, NODE_R, 0, Math.PI * 2);
            if (isCur) geoCtx.fillStyle = "#ffffff";
            else if (sel || focus) geoCtx.fillStyle = "rgba(220,220,240,0.9)";
            else geoCtx.fillStyle = "rgba(100,100,120,0.6)";
            geoCtx.fill();
            if (sel || focus) { geoCtx.strokeStyle = "rgba(255,255,255,0.5)"; geoCtx.lineWidth = 2; geoCtx.stroke(); }
            geoCtx.fillStyle = isCur ? "#000" : "rgba(200,200,220,0.9)";
            geoCtx.font = "10px sans-serif"; geoCtx.textAlign = "center"; geoCtx.textBaseline = "top";
            var lbl = node.name.length > 8 ? node.name.slice(0, 7) + ".." : node.name;
            geoCtx.fillText(lbl, node.x, node.y + NODE_R + 5);
        }
        geoCtx.restore();
	    updateGeoInfoBox();
    }

	function handleGeoClick(clientX, clientY) {
	    var path = geoHitTest(clientX, clientY);
	    if (!path) { geoInfoBoxPath = null; geoSelectedPath = null; renderGeoCanvas(); return; }
	    if (geoSelectedPath && geoSelectedPath.join("/") === path.join("/")) {
	        geoSelectedPath = null;
	    } else {
	        geoSelectedPath = path;
	    }
	    geoInfoBoxPath = geoSelectedPath;
	    renderGeoCanvas();
	}

	function geoHitTest(clientX, clientY) {
	    if (!geoCanvas) return null;
	    var rect = geoCanvas.getBoundingClientRect();
	    var wx = (clientX - rect.left - rect.width / 2 - geoCamX) / geoCamZoom;
	    var wy = (clientY - rect.top - rect.height / 2 - geoCamY) / geoCamZoom;
	    var nodes = flattenGeoTree(getGeoTree()); var layout = layoutGeoNodes(nodes);
	    for (var i = layout.length - 1; i >= 0; i--) {
	        var n = layout[i], dx = wx - n.x, dy = wy - n.y;
	        if (dx * dx + dy * dy <= 18 * 18) return n.path;
	    }
	    return null;
	}

	function updateGeoInfoBox() {
	    var box = document.getElementById("tlg-geo-infobox");
	    if (!box) return;
	    if (!geoInfoBoxPath) { box.style.display = "none"; return; }
	    var node = getGeoNodeByPath(geoInfoBoxPath);
	    if (!node) { box.style.display = "none"; return; }
	    box.style.display = "block";
	    var titleEl = box.querySelector(".tlg-archive-title");
	    if (titleEl) titleEl.textContent = geoInfoBoxPath.join(" / ");
	    var briefEl = box.querySelector(".tlg-archive-brief");
	    if (briefEl) briefEl.textContent = node.desc || "(空)";
	}

	// ─────────────────────────────────────
	// 地理搜索
	// ─────────────────────────────────────
	function ensureGeoSearchUI() {
	    ensureSearchUI(document.getElementById("tlg-geo-view"), {
	        btnId: "tlg-geo-search-btn", panelId: "tlg-geo-search-panel", inputId: "tlg-geo-search-input", resultsId: "tlg-geo-search-results",
	        placeholder: "搜索地点...",
	        onSearch: function(keyword) {
	            var container = document.getElementById("tlg-geo-search-results"); if (!container) return;
	            var nodes = flattenGeoTree(getGeoTree());
	            var kw = keyword.toLowerCase();
	            if (!kw) { container.innerHTML = nodes.slice(0, 12).map(function(n) { return tlgSearchResultItem("tlg-geo-sr-item", "path", n.path.join("/"), n.path.join(" / "), n.desc || ""); }).join("") || tlgSearchEmpty(); bindGeoSearchResults(); return; }
	            var matched = nodes.filter(function(n) { return n.path.join("/").toLowerCase().indexOf(kw) !== -1 || (n.desc || "").toLowerCase().indexOf(kw) !== -1; }).slice(0, 15);
	            container.innerHTML = matched.map(function(n) { return tlgSearchResultItem("tlg-geo-sr-item", "path", n.path.join("/"), n.path.join(" / "), n.desc || ""); }).join("") || tlgSearchEmpty();
	            bindGeoSearchResults();
	        }
	    });
	}
	function bindGeoSearchResults() {
	    document.querySelectorAll(".tlg-geo-sr-item").forEach(function(el) {
	        el.onclick = function() {
	            var raw = this.getAttribute("data-path"); if (!raw) return;
	            var path = raw.split("/"); geoSelectedPath = path; geoInfoBoxPath = path; renderGeoCanvas();
	            document.getElementById("tlg-geo-search-panel").style.display = "none";
	        };
	    });
	}

	// ─────────────────────────────────────
	// 地理:添加 / 编辑 / 删除 / 移动 / 合并 / 锁定
	// ─────────────────────────────────────
	function showAddGeoModal(parentPath) {
	    var bd = tlgModalBackdrop("tlg-geo-add");
	    bd.innerHTML = '<div class="tlg-modal">' +
	        '<div class="tlg-modal-title">添加地点' + (parentPath && parentPath.length ? ' (父:' + parentPath.join(" / ") + ')' : '') + '</div>' +
	        tlgField("名称", '<input class="tlg-input" id="tlg-geo-add-name" placeholder="地点名称" />') +
	        tlgField("描述", '<textarea class="tlg-textarea" id="tlg-geo-add-desc" placeholder="可选描述" style="min-height:60px"></textarea>') +
	        tlgActionsRow(tlgBtn("tlg-geo-add-cancel", "取消") + tlgBtn("tlg-geo-add-ok", "添加", "primary")) + '</div>';
	    document.body.appendChild(bd);
	    bd.querySelector("#tlg-geo-add-cancel").onclick = function() { bd.remove(); };
	    bd.querySelector("#tlg-geo-add-ok").onclick = function() {
	        var name = bd.querySelector("#tlg-geo-add-name").value.trim(); if (!name) { toast("名称不能为空"); return; }
	        var desc = bd.querySelector("#tlg-geo-add-desc").value.trim();
	        var tree = getGeoTree(); var cur = tree;
	        if (parentPath && parentPath.length) {
	            for (var i = 0; i < parentPath.length; i++) {
	                if (!cur[parentPath[i]]) cur[parentPath[i]] = { desc: "", locked: false, isCurrent: false, hidden: false, children: {} };
	                cur = cur[parentPath[i]].children;
	            }
	        }
	        if (cur[name]) { toast("同名地点已存在"); return; }
	        cur[name] = { desc: desc, locked: false, isCurrent: false, hidden: false, children: {} };
	        saveWorlds(); bd.remove(); renderGeoCanvas(); toast("添加完成");
	    };
	}

    function showEditGeoModal(path) {
        var node = getGeoNodeByPath(path); if (!node) return;
        var bd = tlgModalBackdrop("tlg-geo-edit");  
        bd.innerHTML = '<div class="tlg-modal">' +
            '<div class="tlg-modal-title">编辑: ' + escHtml(path.join(" / ")) + '</div>' +
            tlgField("描述", '<textarea class="tlg-textarea" id="tlg-geo-edit-desc" style="min-height:80px">' + escHtml(node.desc || "") + '</textarea>') +
            '<div class="tlg-row">' +
            '<label style="display:flex;align-items:center;gap:4px;font-size:12px;color:#fff;"><input type="checkbox" id="tlg-geo-edit-lock"' + (node.locked ? " checked" : "") + ' /> 锁定(禁止自动重写)</label>' +
            '<label style="display:flex;align-items:center;gap:4px;font-size:12px;color:#fff;margin-left:12px;"><input type="checkbox" id="tlg-geo-edit-hide"' + (node.hidden ? " checked" : "") + ' /> 隐藏</label>' +
            '</div>' +
            tlgActionsRow(tlgBtn("tlg-geo-edit-cancel", "取消") + tlgBtn("tlg-geo-edit-ok", "保存", "primary")) + '</div>';
        document.body.appendChild(bd);
        bd.querySelector("#tlg-geo-edit-cancel").onclick = function() { bd.remove(); };
        bd.querySelector("#tlg-geo-edit-ok").onclick = function() {
            node.desc = bd.querySelector("#tlg-geo-edit-desc").value.trim();
            node.locked = bd.querySelector("#tlg-geo-edit-lock").checked;
            node.hidden = bd.querySelector("#tlg-geo-edit-hide").checked;
            saveWorlds(); bd.remove(); renderGeoCanvas(); toast("已更新");
        };
    }

	function showDeleteGeoModal(path) {
	    var bd = tlgModalBackdrop("tlg-geo-delete");
	    bd.innerHTML = '<div class="tlg-modal">' +
	        '<div class="tlg-modal-title">删除地点</div>' +
	        '<div style="font-size:12px;color:#fff;margin-bottom:12px;">确定删除「' + escHtml(path.join(" / ")) + '」及其所有子地点?</div>' +
	        tlgActionsRow(tlgBtn("tlg-geo-del-cancel", "取消") + tlgBtn("tlg-geo-del-ok", "删除", "danger")) + '</div>';
	    document.body.appendChild(bd);
	    bd.querySelector("#tlg-geo-del-cancel").onclick = function() { bd.remove(); };
	    bd.querySelector("#tlg-geo-del-ok").onclick = function() { deleteGeoNode(path); saveWorlds(); geoInfoBoxPath = null; geoSelectedPath = null; renderGeoCanvas(); bd.remove(); toast("已删除"); };
	}

	function deleteGeoNode(path) {
	    var tree = getGeoTree(); if (!path || !path.length) return;
	    if (path.length === 1) { delete tree[path[0]]; return; }
	    var parent = getGeoNodeByPath(path.slice(0, -1));
	    if (parent && parent.children) delete parent.children[path[path.length - 1]];
	}

	function showMoveGeoModal(srcPath) {
	    var bd = tlgModalBackdrop("tlg-geo-move");
	    var nodes = flattenGeoTree(getGeoTree());
	    var options = nodes.map(function(n) { return '<option value="' + escHtml(n.path.join("/")) + '">' + escHtml(n.path.join(" / ")) + '</option>'; }).join("");
	    bd.innerHTML = '<div class="tlg-modal">' +
	        '<div class="tlg-modal-title">移动地点: ' + escHtml(srcPath.join(" / ")) + '</div>' +
	        tlgField("新父级", '<select class="tlg-select" id="tlg-geo-move-target">' + options + '</select>') +
	        tlgActionsRow(tlgBtn("tlg-geo-move-cancel", "取消") + tlgBtn("tlg-geo-move-ok", "移动", "primary")) + '</div>';
	    document.body.appendChild(bd);
	    bd.querySelector("#tlg-geo-move-cancel").onclick = function() { bd.remove(); };
	    bd.querySelector("#tlg-geo-move-ok").onclick = function() {
	        var targetPath = bd.querySelector("#tlg-geo-move-target").value.split("/");
	        moveGeoNode(srcPath, targetPath); saveWorlds(); geoInfoBoxPath = null; geoSelectedPath = null; renderGeoCanvas(); bd.remove(); toast("已移动");
	    };
	}

	function moveGeoNode(srcPath, destParentPath) {
	    var tree = getGeoTree();
	    var src = getGeoNodeByPath(srcPath); if (!src) return;
	    var srcParent = srcPath.length > 1 ? getGeoNodeByPath(srcPath.slice(0, -1)) : null;
	    var srcKey = srcPath[srcPath.length - 1];
	    var destParent = getGeoNodeByPath(destParentPath); if (!destParent) return;
	    if (destParent.children[srcKey]) { toast("目标下已存在同名子节点"); return; }
	    destParent.children[srcKey] = src;
	    if (srcParent && srcParent.children) delete srcParent.children[srcKey];
	    else if (srcPath.length === 1) delete tree[srcKey];
	}

	function initGeoButtons() {
	    document.getElementById("tlg-geo-add-root").onclick = function() { showAddGeoModal(null); };
	    document.getElementById("tlg-geo-add-child").onclick = function() {
	        if (!geoSelectedPath) { toast("请先在画布上选择一个父节点"); return; }
	        showAddGeoModal(geoSelectedPath);
	    };
	    document.getElementById("tlg-geo-edit").onclick = function() {
	        if (!geoInfoBoxPath) { toast("请先在画布上选择一个节点"); return; }
	        showEditGeoModal(geoInfoBoxPath);
	    };
	    document.getElementById("tlg-geo-del").onclick = function() {
	        if (!geoInfoBoxPath) { toast("请先在画布上选择一个节点"); return; }
	        showDeleteGeoModal(geoInfoBoxPath);
	    };
	    document.getElementById("tlg-geo-move").onclick = function() {
	        if (!geoInfoBoxPath) { toast("请先在画布上选择一个节点"); return; }
	        showMoveGeoModal(geoInfoBoxPath);
	    };
	    document.getElementById("tlg-geo-merge").onclick = function() {
	        if (!geoInfoBoxPath) { toast("请先在画布上选择一个节点"); return; }
	        showMergeGeoModal(geoInfoBoxPath);
	    };
	    document.getElementById("tlg-geo-recenter").onclick = function() { geoCamX = 0; geoCamY = 0; geoCamZoom = 1; renderGeoCanvas(); };
	}

	// ─────────────────────────────────────
	// 地理:合并
	// ─────────────────────────────────────
	function showMergeGeoModal(srcPath) {
	    var nodes = flattenGeoTree(getGeoTree());
	    var options = nodes.map(function(n) { return '<option value="' + escHtml(n.path.join("/")) + '">' + escHtml(n.path.join(" / ")) + '</option>'; }).join("");
	    var bd = tlgModalBackdrop("tlg-geo-merge");
	    bd.innerHTML = '<div class="tlg-modal">' +
	        '<div class="tlg-modal-title">合并地点: ' + escHtml(srcPath.join(" / ")) + '</div>' +
	        '<div style="font-size:11px;color:#c0c0c8;margin-bottom:8px;">将此地点的子节点、描述并入目标节点,然后删除此地点。</div>' +
	        tlgField("目标节点", '<select class="tlg-select" id="tlg-geo-merge-target">' + options + '</select>') +
	        tlgActionsRow(tlgBtn("tlg-geo-merge-cancel", "取消") + tlgBtn("tlg-geo-merge-ok", "合并", "primary")) + '</div>';
	    document.body.appendChild(bd);
	    bd.querySelector("#tlg-geo-merge-cancel").onclick = function() { bd.remove(); };
	    bd.querySelector("#tlg-geo-merge-ok").onclick = function() {
	        var targetPath = bd.querySelector("#tlg-geo-merge-target").value.split("/");
	        mergeGeoNodes(currentWorldId, srcPath, targetPath);
	        geoInfoBoxPath = null; geoSelectedPath = null; renderGeoCanvas(); bd.remove(); toast("合并完成");
	    };
	}
	
	// ══════════════════════════════════════
	// NPC 样本库
	// ══════════════════════════════════════
	function getNpcArchive() {
	    if (!currentWorldId || !worlds[currentWorldId]) return {};
	    if (!worlds[currentWorldId].npcArchive) worlds[currentWorldId].npcArchive = {};
	    return worlds[currentWorldId].npcArchive;
	}
	function getMvuNpcData() {
	    var mvu = getMVUStatData();
	    if (!mvu) return {};
	    var direct = (mvu && mvu.npcObj) ? mvu.npcObj : {};
	    if (Object.keys(direct).length) return direct;
	    return {};
	}

    // ══════════════════════════════════════
    // MVU 血条渲染(共用)
    // ══════════════════════════════════════
    var MVU_BAR_COLORS = {
        "生命":"rgba(80,180,160,0.5),rgba(150,230,210,0.8)",
        "健康值":"rgba(80,180,160,0.5),rgba(150,230,210,0.8)",
        "法力":"rgba(80,120,200,0.5),rgba(140,180,250,0.8)",
        "当前法力":"rgba(80,120,200,0.5),rgba(140,180,250,0.8)",
        "因果权重":"rgba(200,200,240,0.45),rgba(245,245,255,0.85)",
        "因果":"rgba(200,200,240,0.45),rgba(245,245,255,0.85)",
        "好感度":"rgba(190,170,80,0.4),rgba(240,225,130,0.75)",
        "好感":"rgba(190,170,80,0.4),rgba(240,225,130,0.75)",
        "暧昧值":"rgba(200,100,150,0.4),rgba(245,150,200,0.75)",
        "暧昧":"rgba(200,100,150,0.4),rgba(245,150,200,0.75)"
    };
    function getMvuBarColor(key) {
        var lower = (key||"").toLowerCase();
        var keys = Object.keys(MVU_BAR_COLORS);
        for (var bi = 0; bi < keys.length; bi++) {
            if (lower.indexOf(keys[bi].toLowerCase())!==-1 || keys[bi].toLowerCase().indexOf(lower)!==-1)
                return MVU_BAR_COLORS[keys[bi]];
        }
        return "rgba(100,100,100,0.4),rgba(160,160,160,0.7)";
    }
    function renderMvuBars(md) {
        if (!md) return "";
        var html = "";
        var keys = Object.keys(md);
        for (var mk = 0; mk < keys.length; mk++) {
            var k = keys[mk], val = md[k];
            var maxKey = k + "Max";
            if (typeof val === "number" && md[maxKey] !== undefined) {
                var max = md[maxKey] || 100;
                var pct = Math.min(100, Math.max(0, Math.round(val / max * 100)));
                var colors = getMvuBarColor(k);
                html += '<div style="margin-top:4px;"><div style="font-size:10px;color:rgba(255,255,255,0.7);margin-bottom:2px;">' + escHtml(k) + '</div>' +
                    '<div style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:3px;height:14px;position:relative;overflow:hidden;">' +
                    '<div style="height:100%;width:' + pct + '%;background:linear-gradient(90deg,' + colors + ');transition:width 0.4s;"></div>' +
                    '<div style="position:absolute;top:0;left:0;width:100%;height:100%;text-align:center;font-size:9px;color:#fff;line-height:14px;font-weight:bold;text-shadow:0 0 2px #000;">' + val + '/' + max + '</div>' +
                    '</div></div>';
            } else if (typeof val === "number" && !k.endsWith("Max")) {
                var pct2 = Math.min(100, Math.max(0, val));
                var colors2 = getMvuBarColor(k);
                html += '<div style="margin-top:4px;"><div style="font-size:10px;color:rgba(255,255,255,0.7);margin-bottom:2px;">' + escHtml(k) + '</div>' +
                    '<div style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:3px;height:14px;position:relative;overflow:hidden;">' +
                    '<div style="height:100%;width:' + pct2 + '%;background:linear-gradient(90deg,' + colors2 + ');transition:width 0.4s;"></div>' +
                    '<div style="position:absolute;top:0;left:0;width:100%;height:100%;text-align:center;font-size:9px;color:#fff;line-height:14px;font-weight:bold;text-shadow:0 0 2px #000;">' + val + '</div>' +
                    '</div></div>';
            }
        }
        return html;
    }

	function refreshNpcList() {
	    var container = document.getElementById("tlg-npc-list"); if (!container) return;
	    var archive = getNpcArchive(); var mvu = getMvuNpcData();
	    var names = Object.keys(archive).filter(function(n) { return !archive[n].hidden; });
	    if (!names.length) { container.innerHTML = '<div style="color:#5a5a6a;padding:40px 20px;text-align:center;font-style:italic;letter-spacing:2px;">虚空寂寂,再无他人</div>'; return; }
	    container.innerHTML = names.map(function(name) {
	        var e = archive[name];
	        var rawMvu = mvu[name] || {};
	        var barHtml = rawMvu && Object.keys(rawMvu).length ? renderMvuBars(rawMvu) : "";
	        return '<div class="tlg-npc-card" draggable="true" data-name="' + escHtml(name) + '" data-tier="' + escHtml(e.tier || "normal") + '" style="padding:10px;margin-bottom:8px;background:#000;border: 1px solid #2a2a3a;border-radius:4px;cursor:pointer;">' +
	            '<div style="font-weight:600;font-size:14px;color:#ffffff;">' + escHtml(name) +
	            (e.role ? ' <span style="font-size:10px;color:rgba(255,255,255,0.6)">(' + escHtml(e.role) + ')</span>' : '') +
	            (e.tier === "core" ? ' <span style="color:#e0c080;font-size:10px;">★</span>' : e.tier === "important" ? ' <span style="color:#80a0d0;font-size:10px;">▲</span>' : '') +
	            '</div>' + barHtml + '</div>';
	    }).join("");
	    container.querySelectorAll(".tlg-npc-card").forEach(function(card) {
	        card.onclick = function() { showNpcDetail(card.dataset.name); };
	    });
	}

	function showNpcDetail(name) {
	    var archive = getNpcArchive(); var e = archive[name]; if (!e) return;
	    var mvu = getMvuNpcData(); var rawMvu = mvu[name] || {};
	    var barHtml = rawMvu && Object.keys(rawMvu).length ? renderMvuBars(rawMvu) : '<div style="color:#5a5a6a;font-size:11px;padding:6px 0;">暂无附加数据。</div>';
	    var tl = (e.timeline || []).slice().reverse().map(function(ev) {
	        return '<div style="font-size:11px;color:rgba(255,255,255,0.7);padding:3px 0;border-bottom:1px solid #1a1a26;">' +
	            (ev.timestamp ? '<span style="color:rgba(255,255,255,0.4);">[' + escHtml(ev.timestamp) + ']</span> ' : '') +
	            escHtml(ev.event || ev.state_delta || "") + (ev.auto ? ' <span style="font-size:9px;color:rgba(255,255,255,0.4);">自动</span>' : '') +
	            '</div>';
	    }).join("");
	    var bd = tlgModalBackdrop("tlg-npc-detail");
	    bd.innerHTML = '<div class="tlg-modal" style="max-width:500px;">' +
	        '<div class="tlg-modal-title">' + escHtml(name) + (e.role ? ' (' + escHtml(e.role) + ')' : '') + '</div>' +
	        '<div class="tlg-row" style="margin-bottom:8px;gap:4px;"><span class="tlg-btn" id="tlg-npc-tier-label" style="font-size:10px;border:1px solid #4a4a5e;">' + (e.tier === "core" ? "核心" : e.tier === "important" ? "重要" : "普通") + '</span></div>' +
	        barHtml +
	        '<div style="margin-top:10px;">' + tl + '</div>' +
	        '<div class="tlg-modal-actions">' +
	        '<button type="button" class="tlg-btn" id="tlg-npc-tier-up">⇡ 升级</button>' +
	        '<button type="button" class="tlg-btn" id="tlg-npc-tier-down">⇣ 降级</button>' +
	        '<button type="button" class="tlg-btn" id="tlg-npc-merge">+ 合并角色</button>' +
	        '<button type="button" class="tlg-btn tlg-btn-primary" id="tlg-npc-close">关闭</button>' +
	        '</div></div>';
	    document.body.appendChild(bd);
	    bd.querySelector("#tlg-npc-close").onclick = function() { bd.remove(); };
	    bd.querySelector("#tlg-npc-tier-up").onclick = function() {
	        e.tier = e.tier === "core" ? "core" : e.tier === "important" ? "core" : "important"; saveWorlds(); refreshNpcList(); bd.remove();
	    };
	    bd.querySelector("#tlg-npc-tier-down").onclick = function() {
	        e.tier = e.tier === "normal" ? "normal" : e.tier === "important" ? "normal" : "important"; saveWorlds(); refreshNpcList(); bd.remove();
	    };
	    bd.querySelector("#tlg-npc-merge").onclick = function() { bd.remove(); showMergeNpcModal(name); };
	}

	function showMergeNpcModal(srcName) {
	    var archive = getNpcArchive();
	    var candidates = Object.keys(archive).filter(function(n) { return n !== srcName && !archive[n].hidden; });
	    if (!candidates.length) { toast("没有其他角色可合并"); return; }
	    var options = candidates.map(function(n) { return '<option value="' + escHtml(n) + '">' + escHtml(n) + '</option>'; }).join("");
	    var bd = tlgModalBackdrop("tlg-npc-merge");
	    bd.innerHTML = '<div class="tlg-modal">' +
	        '<div class="tlg-modal-title">合并角色: ' + escHtml(srcName) + '</div>' +
	        '<div style="font-size:11px;color:#c0c0c8;margin-bottom:8px;">将时间线合并到目标角色,然后删除源角色。</div>' +
	        tlgField("目标角色", '<select class="tlg-select" id="tlg-npc-merge-target">' + options + '</select>') +
	        tlgActionsRow(tlgBtn("tlg-npc-merge-cancel", "取消") + tlgBtn("tlg-npc-merge-ok", "合并", "primary")) + '</div>';
	    document.body.appendChild(bd);
	    bd.querySelector("#tlg-npc-merge-cancel").onclick = function() { bd.remove(); };
	    bd.querySelector("#tlg-npc-merge-ok").onclick = function() {
	        var target = bd.querySelector("#tlg-npc-merge-target").value; mergeNpcEntries(currentWorldId, srcName, target);
	        saveWorlds(); refreshNpcList(); bd.remove(); toast("合并完成");
	    };
	}

	// ══════════════════════════════════════
	// 物品追踪
	// ══════════════════════════════════════
	function getItemArchive() {
	    if (!currentWorldId || !worlds[currentWorldId]) return {};
	    if (!worlds[currentWorldId].itemArchive) worlds[currentWorldId].itemArchive = {};
	    return worlds[currentWorldId].itemArchive;
	}
	function refreshItemList() {
	    var container = document.getElementById("tlg-item-list"); if (!container) return;
	    var archive = getItemArchive();
	    var names = Object.keys(archive).filter(function(n) { return !archive[n].hidden; });
	    if (!names.length) { container.innerHTML = '<div style="color:#5a5a6a;padding:40px 20px;text-align:center;font-style:italic;letter-spacing:2px;">虚空寂寂,因果尚未铸器</div>'; return; }
	    // 按当前持有者分组
	    var groups = {};
	    names.forEach(function(name) {
	        var h = archive[name].history || [];
	        var last = h.length ? h[h.length - 1] : {};
	        var owner = last.owner || "无主";
	        if (!groups[owner]) groups[owner] = [];
	        groups[owner].push(name);
	    });
	    var ownerKeys = Object.keys(groups).sort();
	    var html = "";
	    ownerKeys.forEach(function(owner) {
	        html += '<div class="tlg-item-group" data-owner="' + escHtml(owner) + '" style="margin-bottom:6px;">' +
	            '<div class="tlg-item-owner-header" style="font-size:11px;color:#6a6a7a;padding:4px 8px;background:#050510;border:1px solid #1a1a26;border-radius:3px 3px 0 0;">◆ ' + escHtml(owner) + ' (' + groups[owner].length + ')</div>';
	        groups[owner].forEach(function(name) {
	            var h = archive[name].history || [];
	            var last = h.length ? h[h.length - 1] : {};
	            html += '<div class="tlg-item-card" draggable="true" data-name="' + escHtml(name) + '" style="padding:6px 8px;border:1px solid #1a1a26;border-top:none;background:#000;cursor:pointer;">' +
	                escHtml(name) + (last.state ? ' <span style="font-size:10px;color:rgba(255,255,255,0.5)">[' + escHtml(last.state) + ']</span>' : '') +
	                '</div>';
	        });
	        html += '</div>';
	    });
	    container.innerHTML = html;
	    container.querySelectorAll(".tlg-item-card").forEach(function(card) {
	        card.onclick = function() { showItemDetail(card.dataset.name); };
	    });
	    // 拖拽:改持有者
	    container.querySelectorAll(".tlg-item-card").forEach(function(card) {
	        card.addEventListener("dragstart", function(e) { e.dataTransfer.setData("text/plain", card.dataset.name); card.style.opacity = "0.4"; });
	        card.addEventListener("dragend", function(e) { card.style.opacity = "1"; });
	    });
	    container.querySelectorAll(".tlg-item-owner-header").forEach(function(header) {
	        header.addEventListener("dragover", function(e) { e.preventDefault(); });
	        header.addEventListener("drop", function(e) {
	            e.preventDefault();
	            var itemName = e.dataTransfer.getData("text/plain");
	            var archive = getItemArchive();
	            if (!archive[itemName]) return;
	            var newOwner = header.parentElement.getAttribute("data-owner") || null;
	            archive[itemName].history.push({ change: "转移", owner: newOwner, state: null, timestamp: "" });
	            archive[itemName].lastActiveTurn = state.turnCounter || 0;
	            saveWorlds(); refreshItemList();
	            toast(itemName + " → " + (newOwner || "无主"));
	        });
	    });
	}

	function showItemDetail(name) {
	    var archive = getItemArchive(); var e = archive[name]; if (!e) return;
	    var hist = (e.history || []).slice().reverse().map(function(ev) {
	        return '<div style="font-size:11px;color:rgba(255,255,255,0.7);padding:3px 0;border-bottom:1px solid #1a1a26;">' +
	            (ev.timestamp ? '<span style="color:rgba(255,255,255,0.4);">[' + escHtml(ev.timestamp) + ']</span> ' : '') +
	            escHtml(ev.change || "变动") + (ev.owner ? " → " + escHtml(ev.owner) : "") + (ev.state ? " [" + escHtml(ev.state) + "]" : "") +
	            '</div>';
	    }).join("");
	    var bd = tlgModalBackdrop("tlg-item-detail");
	    bd.innerHTML = '<div class="tlg-modal" style="max-width:500px;">' +
	        '<div class="tlg-modal-title">' + escHtml(name) + '</div>' +
	        '<div style="margin-top:8px;">' + hist + '</div>' +
	        '<div class="tlg-modal-actions">' +
	        '<button type="button" class="tlg-btn" id="tlg-item-merge">+ 合并物品</button>' +
	        '<button type="button" class="tlg-btn tlg-btn-primary" id="tlg-item-close">关闭</button>' +
	        '</div></div>';
	    document.body.appendChild(bd);
	    bd.querySelector("#tlg-item-close").onclick = function() { bd.remove(); };
	    bd.querySelector("#tlg-item-merge").onclick = function() { bd.remove(); showMergeItemModal(name); };
	}

	function showMergeItemModal(srcName) {
	    var archive = getItemArchive();
	    var candidates = Object.keys(archive).filter(function(n) { return n !== srcName && !archive[n].hidden; });
	    if (!candidates.length) { toast("没有其他物品可合并"); return; }
	    var options = candidates.map(function(n) { return '<option value="' + escHtml(n) + '">' + escHtml(n) + '</option>'; }).join("");
	    var bd = tlgModalBackdrop("tlg-item-merge");
	    bd.innerHTML = '<div class="tlg-modal">' +
	        '<div class="tlg-modal-title">合并物品: ' + escHtml(srcName) + '</div>' +
	        '<div style="font-size:11px;color:#c0c0c8;margin-bottom:8px;">将变动历史合并到目标物品,然后删除源物品。</div>' +
	        tlgField("目标物品", '<select class="tlg-select" id="tlg-item-merge-target">' + options + '</select>') +
	        tlgActionsRow(tlgBtn("tlg-item-merge-cancel", "取消") + tlgBtn("tlg-item-merge-ok", "合并", "primary")) + '</div>';
	    document.body.appendChild(bd);
	    bd.querySelector("#tlg-item-merge-cancel").onclick = function() { bd.remove(); };
	    bd.querySelector("#tlg-item-merge-ok").onclick = function() {
	        var target = bd.querySelector("#tlg-item-merge-target").value; mergeItemEntries(currentWorldId, srcName, target);
	        saveWorlds(); refreshItemList(); bd.remove(); toast("合并完成");
	    };
	}

    // ══════════════════════════════════════
    // 诸世界
    // ══════════════════════════════════════
    function refreshWorlds() {
        var container = document.getElementById("tlg-worlds-list"); if (!container) return;
        var ids = Object.keys(worlds);
        if (!ids.length) {
            container.innerHTML = '<div style="color:#5a5a6a;padding:40px 20px;text-align:center;font-style:italic;letter-spacing:2px;">虚空寂寂,尚无世界被开凿</div>';
            return;
        }
        container.innerHTML = ids.map(function(id) {
            var w = worlds[id]; var isCur = id === currentWorldId;
            return '<div style="padding:10px;margin-bottom:8px;background:#000;border:1px solid ' + (isCur ? "#ffffff" : "#2a2a3a") + ';border-radius:4px;">' +
                '<div style="font-weight:600;font-size:14px;color:#ffffff;margin-bottom:4px;">' + escHtml(w.name || id) + (isCur ? ' <span style="color:#ffffff;font-size:10px;">◉ 当前</span>' : '') + '</div>' +
                '<div style="font-size:10px;color:rgba(255,255,255,0.5);margin-bottom:8px;">' + (w.nodes ? w.nodes.length : 0) + '节点 · ' + (w.summaries ? w.summaries.length : 0) + '档案</div>' +
                '<div style="display:flex;gap:6px;flex-wrap:wrap;">' +
                (!isCur ? '<button type="button" class="tlg-btn tlg-worlds-switch" data-id="' + id + '" style="font-size:11px;writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">↩ 切换</button>' : '') +
                '<button type="button" class="tlg-btn tlg-worlds-export" data-id="' + id + '" style="font-size:11px;writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">⬇ 导出</button>' +
                '<button type="button" class="tlg-btn tlg-worlds-import-replace" data-id="' + id + '" style="font-size:11px;writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">⬆ 导入</button>' +
                '<button type="button" class="tlg-btn tlg-btn-danger tlg-worlds-del" data-id="' + id + '" style="font-size:11px;margin-left:auto;writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">✕</button>' +
                '</div></div>';
        }).join("");
        container.querySelectorAll(".tlg-worlds-switch").forEach(function(btn) {
            btn.onclick = function() {
                if (currentWorldId === btn.dataset.id) return;
                setLinkedWorldId(btn.dataset.id); loadCurrentWorld();
                ensurePanelBuilt(); injectMenuButton(); renderCanvas(); refreshArchive(); refreshSummary(); refreshVault(); refreshWorlds();
                toast("已切换");
            };
        });
        container.querySelectorAll(".tlg-worlds-export").forEach(function(btn) {
            btn.onclick = function() {
                var id = btn.dataset.id; if (!worlds[id]) return;
                var blob = new Blob([JSON.stringify(worlds[id], null, 2)], {type:"application/json"});
                var a = document.createElement("a"); a.href = URL.createObjectURL(blob);
                a.download = (worlds[id].name || id) + ".json"; a.click(); URL.revokeObjectURL(a.href);
            };
        });
        container.querySelectorAll(".tlg-worlds-import-replace").forEach(function(btn) {
            btn.onclick = function() {
                var id = btn.dataset.id;
                var inp = document.createElement("input"); inp.type = "file"; inp.accept = ".json";
                inp.onchange = function() {
                    var file = inp.files[0]; if (!file) return;
                    var reader = new FileReader();
                    reader.onload = function() {
                        try {
                            var data = JSON.parse(reader.result);
                            if (!data.nodes) { toast("无效的配置文件"); return; }
                            worlds[id] = data; saveWorlds(); refreshWorlds();
                            if (id === currentWorldId) { loadCurrentWorld(); renderCanvas(); refreshArchive(); refreshSummary(); refreshVault(); }
                            toast("已导入替换");
                        } catch(e) { toast("解析失败: " + e.message); }
                    };
                    reader.readAsText(file);
                };
                inp.click();
            };
        });
        container.querySelectorAll(".tlg-worlds-del").forEach(function(btn) {
            btn.onclick = function() {
                var id = btn.dataset.id;
                if (id === currentWorldId) { toast("无法删除正在使用的世界"); return; }
                if (!confirm("删除世界「" + (worlds[id] ? worlds[id].name : id) + "」?")) return;
                delete worlds[id]; saveWorlds(); refreshWorlds(); toast("已删除");
            };
        });
    }

    function createNewWorldManual() {
        var chatId = getCurrentChatId();
        tlgPrompt("新建世界", "", chatId || ("世界 " + (Object.keys(worlds).length + 1)), function(name) {
            var wid = generateId();
            worlds[wid] = { name: name, chatId: chatId, nodes: [], summaries: [], memories: [], currentNodeId: null, npcArchive: {}, itemArchive: {}, geoTree: {}, pendingReview: { npc: [], item: [] } };
            currentWorldId = wid; setLinkedWorldId(wid);
            state.nodes = []; state.summaries = []; state.memories = []; state.currentNodeId = null;
            saveWorlds(); refreshWorlds(); renderCanvas(); refreshArchive();
            toast("世界已创建: " + name);
        });
    };

	// ══════════════════════════════════════
	// 模型列表获取
	// ══════════════════════════════════════
	function fetchModelList() {
	    var apiUrl = (globalApi.apiUrl || "").trim(), apiKey = (globalApi.apiKey || "").trim();
	    if (!apiUrl) { toast("请先设置API地址"); return; }
	    var btn = document.getElementById("tlg-fetch-models"); if (btn) btn.disabled = true;
	    toast("检测模型...");
	    fetch(buildEndpoint(apiUrl, "/models"), { headers: apiKey ? { Authorization: "Bearer " + apiKey } : {} })
	    .then(function (res) { if (!res.ok) throw new Error("HTTP " + res.status); return res.json(); })
	    .then(function (data) {
	        var models = (data.data || data.models || []).map(function (m) { return typeof m === "string" ? m : (m.id || m.name || ""); }).filter(Boolean);
	        globalApi.modelList = models; saveGlobalApi(); populateModelSelect();
	        toast("已识别 " + models.length + " 个模型");
	    }).catch(function (e) { toast("通信失败: " + e.message); })
	    .then(function () { if (btn) btn.disabled = false; });
	}
	function fetchVectorModelList() {
	    var apiUrl = (globalApi.vectorUrl || "").trim(), apiKey = (globalApi.vectorKey || "").trim();
	    if (!apiUrl) { toast("请先设置向量API地址"); return; }
	    var btn = document.getElementById("tlg-fetch-vec-models"); if (btn) btn.disabled = true;
	    toast("检测向量模型...");
	    fetch(buildEndpoint(apiUrl, "/models"), { headers: apiKey ? { Authorization: "Bearer " + apiKey } : {} })
	    .then(function (res) { if (!res.ok) throw new Error("HTTP " + res.status); return res.json(); })
	    .then(function (data) {
	        var models = (data.data || data.models || []).map(function (m) { return typeof m === "string" ? m : (m.id || m.name || ""); }).filter(Boolean);
	        globalApi.vectorModelList = models; saveGlobalApi(); populateVectorModelSelect();
	        toast("已识别 " + models.length + " 个向量模型");
	    }).catch(function (e) { toast("通信失败: " + e.message); })
	    .then(function () { if (btn) btn.disabled = false; });
	}
	function fetchRerankModelList() {
	    var apiUrl = (globalApi.rerankUrl || "").trim(), apiKey = (globalApi.rerankKey || "").trim();
	    if (!apiUrl) { toast("请先设置重排API地址"); return; }
	    var btn = document.getElementById("tlg-fetch-rerank-models"); if (btn) btn.disabled = true;
	    toast("检测重排模型...");
	    fetch(buildEndpoint(apiUrl, "/models"), { headers: apiKey ? { Authorization: "Bearer " + apiKey } : {} })
	    .then(function (res) { if (!res.ok) throw new Error("HTTP " + res.status); return res.json(); })
	    .then(function (data) {
	        var models = (data.data || data.models || []).map(function (m) { return typeof m === "string" ? m : (m.id || m.name || ""); }).filter(Boolean);
	        globalApi.rerankModelList = models; saveGlobalApi(); populateRerankModelSelect();
	        toast("已识别 " + models.length + " 个重排模型");
	    }).catch(function (e) { toast("通信失败: " + e.message); })
	    .then(function () { if (btn) btn.disabled = false; });
	}


    // ══════════════════════════════════════
    // 面板构建
    // ══════════════════════════════════════
    function ensurePanelBuilt() {
        if (document.getElementById("tlg-panel")) return;
        var panel = document.createElement("div");
        panel.id = "tlg-panel";
        document.body.appendChild(panel);
        var s = globalApi;

        var summaryTabHtml =
            '<div class="tlg-view" data-tab="summary">' +
            '<div class="tlg-scroll-panel">' +
            '<div style="font-size:15px;font-weight:600;color:#ffffff;margin-bottom:12px;">因果操作台</div>' +
            '<div class="tlg-section"><div class="tlg-section-title">总结切片</div>' +
            '<div class="tlg-row"><span class="tlg-label" style="margin:0">自动切片</span><div class="tlg-toggle ' + (s.autoMode ? "on" : "") + '" id="tlg-auto-toggle"></div></div>' +
            '<div class="tlg-row"><label class="tlg-label" style="margin:0;flex:1">每 <input class="tlg-input" id="tlg-auto-interval" type="number" min="1" value="' + (s.autoInterval || 10) + '" style="width:60px;display:inline-block;padding:4px 6px;margin:0 4px;font-size:14px"> 回合切片一次</label></div>' +
            '<div class="tlg-row"><span class="tlg-label" style="margin:0">跳转前自动总结</span><div class="tlg-toggle ' + (s.jumpSummary !== false ? "on" : "") + '" id="tlg-jump-summary-toggle"></div></div>' +
            '<div class="tlg-row"><label class="tlg-label" style="margin:0;flex:1">跳跃后维持 <input class="tlg-input" id="tlg-last-n" type="number" min="1" value="' + (s.lastNMessages || 5) + '" style="width:60px;display:inline-block;padding:4px 6px;margin:0 4px;font-size:14px"> 条</label></div>' +
            '<div class="tlg-row"><label class="tlg-label" style="margin:0;flex:1">手动提取最近 <input class="tlg-input" id="tlg-manual-count" type="number" min="1" value="' + (s.manualCount || 20) + '" style="width:60px;display:inline-block;padding:4px 6px;margin:0 4px;font-size:14px"> 步</label></div>' +
            '<button type="button" class="tlg-btn tlg-btn-primary" id="tlg-summary-run" style="margin-top:10px;writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">▶ 立即执行切片</button></div>' +
            '<div class="tlg-section"><div class="tlg-section-title">摘要铭刻</div>' +
            '<div class="tlg-row"><span class="tlg-label" style="margin:0">自动铭刻(每回合触发)</span><div class="tlg-toggle ' + (s.digestAutoMode !== false ? "on" : "") + '" id="tlg-digest-auto-toggle"></div></div>' +
            '<div class="tlg-row"><label class="tlg-label" style="margin:0;flex:1">铭刻缓冲 <input class="tlg-input" id="tlg-digest-grace" type="number" min="0" max="120" value="' + (s.digestGraceSeconds || 15) + '" style="width:60px;display:inline-block;padding:4px 6px;margin:0 4px;font-size:14px"> 秒</label></div>' +
            '<div class="tlg-row"><label class="tlg-label" style="margin:0;flex:1">补全批次 <input class="tlg-input" id="tlg-digest-batch-size" type="number" min="1" max="20" value="' + (s.digestBatchSize || 1) + '" style="width:60px;display:inline-block;padding:4px 6px;margin:0 4px;font-size:14px"> 回合/批</label></div>' +
            '<button type="button" class="tlg-btn" id="tlg-digest-catchup-btn" style="margin-top:6px;writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">∮ 补全历史摘要</button></div>' +
            '<div class="tlg-section"><div class="tlg-section-title">自动浓缩</div>' +
            '<div class="tlg-row"><span class="tlg-label" style="margin:0">档案满时自动浓缩</span><div class="tlg-toggle ' + (s.autoCompress ? "on" : "") + '" id="tlg-auto-compress-toggle"></div></div>' +
            '<div class="tlg-row"><label class="tlg-label" style="margin:0;flex:1">档案上限 <input class="tlg-input" id="tlg-summary-max" type="number" min="10" value="' + (s.summaryMaxCount || 100) + '" style="width:60px;display:inline-block;padding:4px 6px;margin:0 4px;font-size:14px"> 条 · 每批浓缩 <input class="tlg-input" id="tlg-compress-batch" type="number" min="2" value="' + (s.compressBatchSize || 10) + '" style="width:60px;display:inline-block;padding:4px 6px;margin:0 4px;font-size:14px"> 条</label></div></div>' +
            '<div class="tlg-section"><div class="tlg-section-title">记录仪指令</div>' +
            '<label class="tlg-label">总结提示词({{context}})</label><textarea class="tlg-textarea" id="tlg-summary-prompt" style="min-height:100px">' + escHtml(s.summaryPrompt || "") + '</textarea></div>' +
            '<div class="tlg-section"><div class="tlg-section-title">最新档案</div><div id="tlg-summary-list"></div></div>' +
            '</div></div>';

        var engineTabHtml =
            '<div class="tlg-view" data-tab="engine">' +
            '<div class="tlg-scroll-panel">' +
            // 主 API
            '<div class="tlg-section"><div class="tlg-section-title">演算核心</div>' +
            '<div class="tlg-row"><label class="tlg-label" style="margin:0;flex:1">API 地址</label><input class="tlg-input" id="tlg-api-url" value="' + escHtml(s.apiUrl || "") + '" style="flex:1;margin-bottom:0" /></div>' +
            '<div class="tlg-row"><label class="tlg-label" style="margin:0;flex:1">密钥</label><input class="tlg-input" id="tlg-api-key" type="password" value="' + escHtml(s.apiKey || "") + '" style="flex:1;margin-bottom:0" /></div>' +
            '<div class="tlg-row"><label class="tlg-label" style="margin:0;flex:1">核心</label><select class="tlg-select" id="tlg-model-select" style="flex:1;margin-bottom:0"></select></div>' +
            '<div class="tlg-row"><button type="button" class="tlg-btn" id="tlg-fetch-models" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">检测模型</button><button type="button" class="tlg-btn" id="tlg-test-api" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">探针</button></div>' +
            '</div>' +
            // 向量 API
            '<div class="tlg-section"><div class="tlg-section-title">辅助核心</div>' +
            '<div class="tlg-row"><label class="tlg-label" style="margin:0;flex:1">API 地址</label><input class="tlg-input" id="tlg-vec-url" value="' + escHtml(s.vectorUrl || "") + '" style="flex:1;margin-bottom:0" /></div>' +
            '<div class="tlg-row"><label class="tlg-label" style="margin:0;flex:1">密钥</label><input class="tlg-input" id="tlg-vec-key" type="password" value="' + escHtml(s.vectorKey || "") + '" style="flex:1;margin-bottom:0" /></div>' +
            '<div class="tlg-row"><label class="tlg-label" style="margin:0;flex:1">核心</label><select class="tlg-select" id="tlg-vec-model-select" style="flex:1;margin-bottom:0"></select></div>' +
            '<div class="tlg-row"><button type="button" class="tlg-btn" id="tlg-fetch-vec-models" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">检测模型</button><button type="button" class="tlg-btn" id="tlg-test-vec-api" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">探针</button></div>' +
            '</div>' +
            // 重排 API
            '<div class="tlg-section"><div class="tlg-section-title">重排核心</div>' +
            '<div class="tlg-row"><label class="tlg-label" style="margin:0;flex:1">API 地址</label><input class="tlg-input" id="tlg-rerank-url" value="' + escHtml(s.rerankUrl || "") + '" style="flex:1;margin-bottom:0" /></div>' +
            '<div class="tlg-row"><label class="tlg-label" style="margin:0;flex:1">密钥</label><input class="tlg-input" id="tlg-rerank-key" type="password" value="' + escHtml(s.rerankKey || "") + '" style="flex:1;margin-bottom:0" /></div>' +
            '<div class="tlg-row"><label class="tlg-label" style="margin:0;flex:1">核心</label><select class="tlg-select" id="tlg-rerank-model-select" style="flex:1;margin-bottom:0"></select></div>' +
            '<div class="tlg-row"><button type="button" class="tlg-btn" id="tlg-fetch-rerank-models" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">检测模型</button><button type="button" class="tlg-btn" id="tlg-test-rerank-api" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">探针</button></div>' +
            '</div>' +
            // 摘要 API
            '<div class="tlg-section"><div class="tlg-section-title">摘要引擎</div>' +
            '<div class="tlg-row"><label class="tlg-label" style="margin:0;flex:1">API 地址</label><input class="tlg-input" id="tlg-digest-url" value="' + escHtml(s.digestUrl || "") + '" style="flex:1;margin-bottom:0" /></div>' +
            '<div class="tlg-row"><label class="tlg-label" style="margin:0;flex:1">密钥</label><input class="tlg-input" id="tlg-digest-key" type="password" value="' + escHtml(s.digestKey || "") + '" style="flex:1;margin-bottom:0" /></div>' +
            '<div class="tlg-row"><label class="tlg-label" style="margin:0;flex:1">核心</label><select class="tlg-select" id="tlg-digest-model-select" style="flex:1;margin-bottom:0"></select></div>' +
            '<div class="tlg-row"><button type="button" class="tlg-btn" id="tlg-fetch-digest-models" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">检测模型</button><button type="button" class="tlg-btn" id="tlg-test-digest-api" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">探针</button></div>' +
            '<label class="tlg-label">摘要 提示词</label><textarea class="tlg-textarea" id="tlg-digest-prompt" style="min-height:120px">' + escHtml(s.digestPrompt || "") + '</textarea>' +
            '<label class="tlg-label">事实单元 上限</label><input class="tlg-input" id="tlg-fact-max" type="number" min="10" value="' + (s.factUnitsMaxCount || 500) + '" style="width:80px;margin-bottom:8px" />' +
            '</div>' +
            '</div></div>';

        panel.innerHTML =
            '<div style="display:flex;align-items:center;justify-content:space-between;padding:0 14px;height:44px;border-bottom:1px solid #2a2a3a;flex-shrink:0;">' +
            '<span style="font-weight:700;font-size:15px;color:#ffffff;letter-spacing:1px;">河岸凝视</span>' +
            '<div style="display:flex;align-items:center;gap:10px;">' +
            '<span id="tlg_enable_toggle" class="tlg-enable-toggle on" style="font-size:12px;cursor:pointer;color:#c0c0c8;padding:2px 8px;border:1px solid #2a2a3a;border-radius:3px;">◉</span>' +
            '<span id="tlg_close_btn" style="cursor:pointer;font-size:20px;color:#7a7a8a;line-height:1;">✕</span>' +
            '</div></div>' +
            '<div class="tlg-tabs" style="display:flex;border-bottom:1px solid #2a2a3a;flex-shrink:0;overflow-x:auto;">' +
            '<div class="tlg-tab active" data-tab="tree" style="padding:10px 14px;font-size:12px;cursor:pointer;white-space:nowrap;color:#c0c0c8;border-bottom:2px solid transparent;">命运分支线</div>' +
            '<div class="tlg-tab" data-tab="archive" style="padding:10px 14px;font-size:12px;cursor:pointer;white-space:nowrap;color:#c0c0c8;border-bottom:2px solid transparent;">观测坐标</div>' +
            '<div class="tlg-tab" data-tab="summary" style="padding:10px 14px;font-size:12px;cursor:pointer;white-space:nowrap;color:#c0c0c8;border-bottom:2px solid transparent;">因果操作台</div>' +
            '<div class="tlg-tab" data-tab="vault" style="padding:10px 14px;font-size:12px;cursor:pointer;white-space:nowrap;color:#c0c0c8;border-bottom:2px solid transparent;">观测档案库</div>' +
            '<div class="tlg-tab" data-tab="worldarchive" style="padding:10px 14px;font-size:12px;cursor:pointer;white-space:nowrap;color:#c0c0c8;border-bottom:2px solid transparent;">世界档案</div>' +
            '<div class="tlg-tab" data-tab="worlds" style="padding:10px 14px;font-size:12px;cursor:pointer;white-space:nowrap;color:#c0c0c8;border-bottom:2px solid transparent;">诸世界</div>' +
            '<div class="tlg-tab" data-tab="engine" style="padding:10px 14px;font-size:12px;cursor:pointer;white-space:nowrap;color:#c0c0c8;border-bottom:2px solid transparent;">引擎核心</div>' +
            '</div>' +
            '<div class="tlg-body" style="flex:1;min-height:0;overflow:hidden;position:relative;">' +
            '<div class="tlg-view active" data-tab="tree" style="display:flex;flex-direction:column;position:absolute;inset:0;overflow:hidden;">' +
            '<div style="flex:1;position:relative;overflow:hidden;"><canvas id="tlg-canvas" style="width:100%;height:100%;display:block;"></canvas></div>' +
            '<div id="tlg-brief-panel" class="tlg-brief-panel" style="background:#000;border-top:1px solid #2a2a3a;padding:12px;max-height:40vh;overflow-y:auto;display:none;">' +
            '<div class="tlg-brief-header" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">' +
            '<span style="font-weight:600;font-size:13px;color:#ffffff;"></span>' +
            '<span id="tlg-brief-close" style="cursor:pointer;font-size:16px;color:#7a7a8a;">✕</span></div>' +
            '<div class="tlg-brief-body"></div><div class="tlg-brief-footer"></div></div>' +
            '<div style="display:flex;gap:6px;padding:8px;border-top:1px solid #1a1a26;flex-shrink:0;background:#000;">' +
            '<button type="button" class="tlg-btn" id="tlg-anchor-btn" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">⚓ 锚定</button>' +
            '<button type="button" class="tlg-btn" id="tlg-center-btn" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">⊞ 定位</button>' +
            '<button type="button" class="tlg-btn" id="tlg-home-btn" style="margin-left:auto;writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">⌂ 归位</button>' +
            '</div></div>' +
            '<div class="tlg-view" data-tab="archive" style="position:absolute;inset:0;overflow-y:auto;padding:16px;display:none;">' +
            '<div style="margin-bottom:12px;"><div style="font-size:15px;font-weight:600;color:#ffffff;margin-bottom:8px;">观测坐标</div><div id="tlg-pinned-paths"></div></div>' +
            '<div style="margin-top:8px;"><div style="font-size:15px;font-weight:600;color:#ffffff;margin-bottom:8px;">全部节点</div><div id="tlg-archive-list"></div></div></div>' +
            summaryTabHtml +
            '<div class="tlg-view" data-tab="vault" style="position:absolute;inset:0;overflow-y:auto;padding:16px;display:none;">' +
            '<div style="font-size:15px;font-weight:600;color:#ffffff;margin-bottom:8px;">观测档案库</div><div id="tlg-vault-container"></div></div>' +
            '<div class="tlg-view" data-tab="worldarchive" style="position:absolute;inset:0;overflow-y:auto;padding:16px;display:none;">' +
            '<div style="display:flex;gap:0;margin-bottom:12px;border-bottom:1px solid #2a2a3a;">' +
            '<div class="tlg-subtab active" data-subtab="geo" style="padding:8px 14px;font-size:12px;cursor:pointer;color:#c0c0c8;border-bottom:2px solid transparent;">地理树</div>' +
            '<div class="tlg-subtab" data-subtab="npc" style="padding:8px 14px;font-size:12px;cursor:pointer;color:#c0c0c8;border-bottom:2px solid transparent;">NPC样本库</div>' +
            '<div class="tlg-subtab" data-subtab="item" style="padding:8px 14px;font-size:12px;cursor:pointer;color:#c0c0c8;border-bottom:2px solid transparent;">物品追踪</div></div>' +
            '<div id="tlg-geo-view" style="position:relative;">' +
            '<div style="display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap;">' +
            '<button type="button" class="tlg-btn" id="tlg-geo-add-root" style="font-size:11px;writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">+ 添加根地点</button>' +
            '<button type="button" class="tlg-btn" id="tlg-geo-add-child" style="font-size:11px;writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">+ 添加子地点</button>' +
            '<button type="button" class="tlg-btn" id="tlg-geo-edit" style="font-size:11px;writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">编辑</button>' +
            '<button type="button" class="tlg-btn" id="tlg-geo-del" style="font-size:11px;writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">删除</button>' +
            '<button type="button" class="tlg-btn" id="tlg-geo-move" style="font-size:11px;writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">移动</button>' +
            '<button type="button" class="tlg-btn" id="tlg-geo-merge" style="font-size:11px;writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">合并</button>' +
            '<button type="button" class="tlg-btn" id="tlg-geo-recenter" style="font-size:11px;margin-left:auto;writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">⊞ 居中</button>' +
            '</div>' +
            '<div style="height:320px;border:1px solid #1a1a26;border-radius:4px;overflow:hidden;background:#000;">' +
            '<canvas id="tlg-geo-canvas" style="width:100%;height:100%;display:block;"></canvas></div>' +
            '<div id="tlg-geo-infobox" class="tlg-section" style="margin-top:8px;display:none;">' +
            '<div class="tlg-archive-title" style="font-size:13px;color:#ffffff;"></div>' +
            '<div class="tlg-archive-brief" style="font-size:11px;color:rgba(255,255,255,0.7);max-height:120px;overflow-y:auto;"></div></div>' +
            '</div>' +
            '<div id="tlg-npc-view" style="display:none;">' +
            '<div id="tlg-npc-list" style="margin-top:0;"></div></div>' +
            '<div id="tlg-item-view" style="display:none;">' +
            '<div id="tlg-item-list" style="margin-top:0;"></div></div>' +
            '</div>' +
            '<div class="tlg-view" data-tab="worlds" style="position:absolute;inset:0;overflow-y:auto;padding:16px;display:none;">' +
            '<div style="display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap;">' +
            '<button type="button" class="tlg-btn" id="tlg-worlds-create" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">+ 创建世界</button>' +
            '<button type="button" class="tlg-btn" id="tlg-worlds-import-new" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">导入</button>' +
            '</div>' +
            '<div id="tlg-worlds-list"></div></div>' +
            engineTabHtml +
            '</div>';
        canvas = panel.querySelector("#tlg-canvas");
        ctx = canvas.getContext("2d");
        bindPanelEvents();
        initCanvasEvents();
        initGeoCanvas();
        initGeoButtons();
        ensureGeoSearchUI();
        populateModelSelect();
        populateVectorModelSelect();
        populateRerankModelSelect();
        populateDigestModelSelect();
        // 隐藏摘要引擎的操作控件(自动模式/批次/缓冲/补全按钮已移至因果操作台,这里是引擎核心)
        var digestEngineControls = document.querySelectorAll("#tlg-digest-auto-toggle, #tlg-digest-batch-size, #tlg-digest-grace, #tlg-digest-catchup-btn");
        digestEngineControls.forEach(function(el) { if (el) el.style.display = "none"; });
    }

    function bindPanelEvents() {
        var panel = document.getElementById("tlg-panel"); if (!panel) return;
        panel.querySelector("#tlg_close_btn").onclick = closePanel;
        panel.querySelector("#tlg_enable_toggle").onclick = function() { setEnabled(!isEnabled()); };
        panel.querySelectorAll(".tlg-tab").forEach(function(tab) {
            tab.onclick = function() { switchTab(tab.dataset.tab); };
        });
        panel.querySelectorAll(".tlg-subtab").forEach(function(tab) {
            tab.onclick = function() {
                panel.querySelectorAll(".tlg-subtab").forEach(function(t) { t.classList.remove("active"); });
                tab.classList.add("active");
                var sub = tab.dataset.subtab;
                document.getElementById("tlg-geo-view").style.display = sub === "geo" ? "block" : "none";
                document.getElementById("tlg-npc-view").style.display = sub === "npc" ? "block" : "none";
                document.getElementById("tlg-item-view").style.display = sub === "item" ? "block" : "none";
                if (sub === "geo") { initGeoCanvas(); renderGeoCanvas(); }
                if (sub === "npc") refreshNpcList();
                if (sub === "item") refreshItemList();
            };
        });
        panel.querySelector("#tlg-anchor-btn").onclick = function() { showAnchorModal(""); };
        panel.querySelector("#tlg-center-btn").onclick = centerOnCurrentNode;
        panel.querySelector("#tlg-home-btn").onclick = function() {
            if (state._jumpedToIdx !== null) {
                state._jumpedToIdx = null; state._chatLenAtJump = null;
                var st = getST();
                if (st && st.chat_metadata) {
                    delete st.chat_metadata._tlg_jumpedToIdx;
                    delete st.chat_metadata._tlg_chatLenAtJump;
                    if (typeof st.saveMetadata === "function") st.saveMetadata();
                }
                applyRecentVisibility();
                toast("已归位到普通视野");
            }
            var st2 = getST();
            var latestFloor = st2 && st2.chat ? st2.chat.length - 1 : 0;
            var curNode = findNode(state.currentNodeId);
            if (curNode && latestFloor > curNode.msgIdx) {
                createAnchorAtFloor("归位·" + state.nodes.length, "自动归位生成", latestFloor);
            } else if (!curNode || latestFloor === curNode.msgIdx) {
                toast("已在最新楼层,无需归位");
            }
        };
        panel.querySelector("#tlg-brief-close").onclick = closeBriefPanel;
        panel.querySelector("#tlg-summary-run").onclick = function() { runSummary(false); };
        panel.querySelector("#tlg-auto-toggle").onclick = function() {
            globalApi.autoMode = !globalApi.autoMode;
            this.classList.toggle("on", globalApi.autoMode);
            saveGlobalApi();
        };
        panel.querySelector("#tlg-auto-compress-toggle").onclick = function() {
            globalApi.autoCompress = !globalApi.autoCompress;
            this.classList.toggle("on", globalApi.autoCompress);
            saveGlobalApi();
        };
        panel.querySelector("#tlg-jump-summary-toggle").onclick = function() {
            globalApi.jumpSummary = !globalApi.jumpSummary;
            this.classList.toggle("on", globalApi.jumpSummary !== false);
            saveGlobalApi();
        };
        panel.querySelector("#tlg-digest-auto-toggle").onclick = function() {
            globalApi.digestAutoMode = !globalApi.digestAutoMode;
            this.classList.toggle("on", globalApi.digestAutoMode !== false);
            saveGlobalApi();
        };
        panel.querySelector("#tlg-digest-catchup-btn").onclick = runCatchupDigest;
        panel.querySelector("#tlg-fetch-models").onclick = fetchModelList;
        panel.querySelector("#tlg-fetch-vec-models").onclick = fetchVectorModelList;
        panel.querySelector("#tlg-fetch-rerank-models").onclick = fetchRerankModelList;
        panel.querySelector("#tlg-fetch-digest-models").onclick = fetchDigestModelList;
        panel.querySelector("#tlg-test-api").onclick = function() {
            var url = document.getElementById("tlg-api-url").value.trim();
            var key = document.getElementById("tlg-api-key").value.trim();
            if (!url) { toast("API地址为空"); return; }
            toast("发送探针...");
            fetch(buildEndpoint(url, "/models"), { headers: key ? { Authorization: "Bearer " + key } : {} })
            .then(function(r) { toast(r.ok ? "✓ 节点联通" : "✗ 阻断: " + r.status); })
            .catch(function(e) { toast("✗ " + e.message); });
        };
        panel.querySelector("#tlg-test-vec-api").onclick = function() {
            var url = document.getElementById("tlg-vec-url").value.trim();
            var key = document.getElementById("tlg-vec-key").value.trim();
            if (!url) { toast("向量地址为空"); return; }
            toast("发送向量探针...");
            fetch(buildEndpoint(url, "/models"), { headers: key ? { Authorization: "Bearer " + key } : {} })
            .then(function(r) { toast(r.ok ? "✓ 向量节点联通" : "✗ 阻断: " + r.status); })
            .catch(function(e) { toast("✗ " + e.message); });
        };
        panel.querySelector("#tlg-test-rerank-api").onclick = function() {
            var url = document.getElementById("tlg-rerank-url").value.trim();
            var key = document.getElementById("tlg-rerank-key").value.trim();
            if (!url) { toast("重排地址为空"); return; }
            toast("发送重排探针...");
            fetch(buildEndpoint(url, "/models"), { headers: key ? { Authorization: "Bearer " + key } : {} })
            .then(function(r) { toast(r.ok ? "✓ 重排节点联通" : "✗ 阻断: " + r.status); })
            .catch(function(e) { toast("✗ " + e.message); });
        };
        panel.querySelector("#tlg-test-digest-api").onclick = function() {
            var url = document.getElementById("tlg-digest-url").value.trim();
            var key = document.getElementById("tlg-digest-key").value.trim();
            if (!url) { toast("摘要地址为空"); return; }
            toast("发送摘要探针...");
            fetch(buildEndpoint(url, "/models"), { headers: key ? { Authorization: "Bearer " + key } : {} })
            .then(function(r) { toast(r.ok ? "✓ 摘要节点联通" : "✗ 阻断: " + r.status); })
            .catch(function(e) { toast("✗ " + e.message); });
        };
        panel.querySelector("#tlg-worlds-create").onclick = createNewWorldManual;
        panel.querySelector("#tlg-worlds-import-new").onclick = function() {
            var inp = document.createElement("input"); inp.type = "file"; inp.accept = ".json";
            inp.onchange = function() {
                var file = inp.files[0]; if (!file) return;
                var reader = new FileReader();
                reader.onload = function() {
                    try {
                        var data = JSON.parse(reader.result);
                        if (!data.nodes) { toast("无效的世界文件"); return; }
                        var wid = data.id || generateId();
                        data.id = wid; worlds[wid] = data;
                        currentWorldId = wid; setLinkedWorldId(wid);
                        state.nodes = data.nodes || []; state.summaries = data.summaries || [];
                        state.memories = data.memories || [];
                        state.currentNodeId = data.currentNodeId || (state.nodes.length ? state.nodes[0].id : null);
                        saveWorlds(); refreshWorlds(); renderCanvas(); refreshArchive();
                        toast("已导入世界: " + (data.name || wid));
                    } catch(e) { toast("解析失败: " + e.message); }
                };
                reader.readAsText(file);
            };
            inp.click();
        };

        // engine-save: 摘取所有输入框的值写回globalApi
        function engineSave() {
            try {
                globalApi.apiUrl = (document.getElementById("tlg-api-url") || {}).value || "";
                globalApi.apiKey = (document.getElementById("tlg-api-key") || {}).value || "";
                globalApi.model = (document.getElementById("tlg-model-select") || {}).value || "";
                globalApi.vectorUrl = (document.getElementById("tlg-vec-url") || {}).value || "";
                globalApi.vectorKey = (document.getElementById("tlg-vec-key") || {}).value || "";
                globalApi.vectorModel = (document.getElementById("tlg-vec-model-select") || {}).value || "";
                globalApi.rerankUrl = (document.getElementById("tlg-rerank-url") || {}).value || "";
                globalApi.rerankKey = (document.getElementById("tlg-rerank-key") || {}).value || "";
                globalApi.rerankModel = (document.getElementById("tlg-rerank-model-select") || {}).value || "";
                globalApi.digestUrl = (document.getElementById("tlg-digest-url") || {}).value || "";
                globalApi.digestKey = (document.getElementById("tlg-digest-key") || {}).value || "";
                globalApi.digestModel = (document.getElementById("tlg-digest-model-select") || {}).value || "";
                globalApi.summaryPrompt = (document.getElementById("tlg-summary-prompt") || {}).value || "";
                globalApi.digestPrompt = (document.getElementById("tlg-digest-prompt") || {}).value || "";
                globalApi.factUnitsMaxCount = parseInt((document.getElementById("tlg-fact-max") || {}).value, 10) || 500;
                globalApi.autoInterval = parseInt((document.getElementById("tlg-auto-interval") || {}).value, 10) || 10;
                globalApi.lastNMessages = parseInt((document.getElementById("tlg-last-n") || {}).value, 10) || 5;
                globalApi.manualCount = parseInt((document.getElementById("tlg-manual-count") || {}).value, 10) || 20;
                globalApi.digestGraceSeconds = parseInt((document.getElementById("tlg-digest-grace") || {}).value, 10) || 15;
                globalApi.digestBatchSize = parseInt((document.getElementById("tlg-digest-batch-size") || {}).value, 10) || 1;
                globalApi.summaryMaxCount = parseInt((document.getElementById("tlg-summary-max") || {}).value, 10) || 100;
                globalApi.compressBatchSize = parseInt((document.getElementById("tlg-compress-batch") || {}).value, 10) || 10;
                saveGlobalApi();
            } catch(e) {}
        }
        var engineInputs = panel.querySelectorAll(".tlg-input, .tlg-textarea, .tlg-select");
        engineInputs.forEach(function(el) {
            el.addEventListener("input", engineSave);
            el.addEventListener("change", engineSave);
        });
    }

    function initCanvasEvents() {
        if (!canvas) return;
        canvas.addEventListener("mousedown", function(e) {
            if (e.button !== 0) return;
            panStartX = e.clientX - camX; panStartY = e.clientY - camY;
            isPanning = true; canvas.style.cursor = "grabbing";
        });
        canvas.addEventListener("mousemove", function(e) {
            if (!isPanning) return;
            camX = e.clientX - panStartX; camY = e.clientY - panStartY;
            renderCanvas();
        });
        canvas.addEventListener("mouseup", function(e) {
            isPanning = false; canvas.style.cursor = "grab";
            var hit = canvasHitTest(e.clientX, e.clientY);
            if (hit === "__virtual__") {
                triggerRipple(virtualMarkerPos.x, virtualMarkerPos.y);
                var st = getST();
                var latestFloor = st && st.chat ? st.chat.length - 1 : 0;
                createAnchorAtFloor("当前最新", "由目光停驻之地触发", latestFloor);
                return;
            }
            state.selectedNodeId = (hit && state.selectedNodeId === hit) ? null : hit;
            if (state.selectedNodeId) openBriefPanel(state.selectedNodeId);
            else closeBriefPanel();
            renderCanvas();
        });
        canvas.addEventListener("mouseleave", function() { isPanning = false; canvas.style.cursor = "grab"; });
        canvas.addEventListener("wheel", function(e) {
            e.preventDefault();
            camZoom = Math.max(0.2, Math.min(5, camZoom * (e.deltaY < 0 ? 1.1 : 0.9)));
            renderCanvas();
        });
        canvas.style.cursor = "grab";
        canvas.addEventListener("touchstart", function(e) {
            if (e.touches.length === 1) {
                isPanning = true;
                panStartX = e.touches[0].clientX - camX;
                panStartY = e.touches[0].clientY - camY;
            }
        }, { passive: false });
        canvas.addEventListener("touchmove", function(e) {
            e.preventDefault();
            if (e.touches.length === 1 && isPanning) {
                camX = e.touches[0].clientX - panStartX;
                camY = e.touches[0].clientY - panStartY;
                renderCanvas();
            }
        }, { passive: false });
        canvas.addEventListener("touchend", function(e) {
            var hit = canvasHitTest(e.changedTouches[0].clientX, e.changedTouches[0].clientY);
            state.selectedNodeId = (hit && state.selectedNodeId === hit) ? null : hit;
            if (state.selectedNodeId) openBriefPanel(state.selectedNodeId);
            else closeBriefPanel();
            renderCanvas();
            isPanning = false;
        });
    }

    function openPanel() {
        var panel = document.getElementById("tlg-panel");
        if (!panel) { ensurePanelBuilt(); panel = document.getElementById("tlg-panel"); }
        if (!panel) return;
        panel.style.display = "flex";
        renderCanvas();
        refreshArchive();
        refreshSummary();
        refreshVault();
        refreshWorlds();
    }

    function closePanel() {
        var panel = document.getElementById("tlg-panel");
        if (panel) panel.style.display = "none";
    }

    function switchTab(tabName) {
        var panel = document.getElementById("tlg-panel"); if (!panel) return;
        panel.querySelectorAll(".tlg-tab").forEach(function(t) { t.classList.toggle("active", t.dataset.tab === tabName); });
        panel.querySelectorAll(".tlg-view").forEach(function(v) { v.style.display = v.dataset.tab === tabName ? "flex" : "none"; });
        if (tabName === "tree") { renderCanvas(); }
        if (tabName === "archive") { refreshArchive(); }
        if (tabName === "summary") { refreshSummary(); }
        if (tabName === "vault") { refreshVault(); }
        if (tabName === "worldarchive") { var geo = document.getElementById("tlg-geo-view"); if (geo) geo.style.display = "block"; renderGeoCanvas(); refreshNpcList(); refreshItemList(); }
        if (tabName === "worlds") { refreshWorlds(); }
    }

    function populateModelSelect() {
        var sel = document.getElementById("tlg-model-select"); if (!sel) return;
        sel.innerHTML = '<option value="">-- 选择演算核心 --</option>' +
            (globalApi.modelList || []).map(function(m) {
                return '<option value="' + escHtml(m) + '"' + (m === globalApi.model ? " selected" : "") + '>' + escHtml(m) + '</option>';
            }).join("");
    }
    function populateVectorModelSelect() {
        var sel = document.getElementById("tlg-vec-model-select"); if (!sel) return;
        sel.innerHTML = '<option value="">-- 选择辅助核心 --</option>' +
            (globalApi.vectorModelList || []).map(function(m) {
                return '<option value="' + escHtml(m) + '"' + (m === globalApi.vectorModel ? " selected" : "") + '>' + escHtml(m) + '</option>';
            }).join("");
    }
    function populateRerankModelSelect() {
        var sel = document.getElementById("tlg-rerank-model-select"); if (!sel) return;
        sel.innerHTML = '<option value="">-- 选择重排核心 --</option>' +
            (globalApi.rerankModelList || []).map(function(m) {
                return '<option value="' + escHtml(m) + '"' + (m === globalApi.rerankModel ? " selected" : "") + '>' + escHtml(m) + '</option>';
            }).join("");
    }

    function injectMenuButton() {
        if (document.getElementById("tlg_menu_btn")) return;
        var btn = document.createElement("div");
        btn.id = "tlg_menu_btn";
        btn.textContent = "⌖ 河岸凝视";
        btn.style.cssText = "padding:6px 12px;background:#050508;border:1px solid #2a2a3a;border-radius:4px;cursor:pointer;color:#c0c0c8;font-size:12px;margin-right:6px;";
        btn.onclick = function() {
            var panel = document.getElementById("tlg-panel");
            if (!panel) { ensurePanelBuilt(); panel = document.getElementById("tlg-panel"); }
            if (!panel) return;
            panel.style.display = panel.style.display === "flex" ? "none" : "flex";
            if (panel.style.display === "flex") {
                renderCanvas();
                refreshArchive();
                refreshSummary();
                refreshVault();
                refreshWorlds();
            }
        };
        var extMenu = document.getElementById("extensionsMenu");
        if (extMenu) extMenu.appendChild(btn);
        else document.body.appendChild(btn);
    }

    /* ============================================================
     * 模块 14 — 事件系统 & 入口
     * ============================================================ */
    function boot() {
        migrateOldData();
        loadCurrentWorld();
        injectMenuButton();
        if (!state.nodes.length || !state.nodes.find(function(n) { return !n.parentId; })) {
            resetState();
            ensureWorldExists();
        }

        var st = getST();
        if (!st || !st.eventSource) return;

        st.eventSource.on(st.event_types.MESSAGE_RECEIVED, function () {
            if (!isEnabled()) return;
            var chat = st.chat;
            if (!chat || !chat.length) return;
            var newLen = chat.length;
            if (newLen === state._lastChatLen) return;
            state._lastChatLen = newLen;
            state.turnsSinceAnchor = (state.turnsSinceAnchor || 0) + 1;
            saveTurnsCounter();

            if (state._jumpedToIdx !== null) {
                applyRecentVisibility();
            }

            if (globalApi.digestAutoMode) {
                startDigestGrace();
            }

            if (globalApi.autoMode) {
                runSummary(true);
            }
        });

        st.eventSource.on(st.event_types.MESSAGE_SENT, function () {
            if (!isEnabled()) return;
            if (state._jumpedToIdx !== null) {
                applyRecentVisibility();
            }
        });

        st.eventSource.on(st.event_types.MESSAGE_SWIPED, function () {
            if (!isEnabled()) return;
            cancelDigestGrace();
            if (_lastDigestMemoryId && currentWorldId && worlds[currentWorldId] && worlds[currentWorldId].memories) {
                var mems = worlds[currentWorldId].memories;
                for (var i = mems.length - 1; i >= 0; i--) {
                    if (mems[i].id === _lastDigestMemoryId) {
                        mems.splice(i, 1);
                        _lastDigestMemoryId = null;
                        if (currentWorldId && worlds[currentWorldId]) {
                            state.memories = worlds[currentWorldId].memories;
                        }
                        saveWorlds();
                        toast("∮ 已撤回上轮铭刻的记忆。");
                        return;
                    }
                }
            }
            _lastDigestMemoryId = null;
        });

        st.eventSource.on(st.event_types.CHAT_CHANGED, function () {
            state._lastChatLen = 0;
            state._jumpedToIdx = null;
            state._chatLenAtJump = null;
            closePanel();
            loadCurrentWorld();
            injectMenuButton();
            renderCanvas();
            refreshArchive();
            refreshSummary();
            refreshVault();
        });

        if (typeof window.SillyTavern === "undefined" && typeof window.SillyTavern?.addSlashCommand !== "undefined") {
            try {
                window.SillyTavern.addSlashCommand("tlg_anchor", function() {
                    showAnchorModal("");
                });
                window.SillyTavern.addSlashCommand("tlg_filter", function() {
                    if (state._jumpedToIdx !== null) {
                        state._jumpedToIdx = null;
                        state._chatLenAtJump = null;
                        var st2 = getST();
                        if (st2 && st2.chat_metadata) {
                            delete st2.chat_metadata._tlg_jumpedToIdx;
                            delete st2.chat_metadata._tlg_chatLenAtJump;
                            if (typeof st2.saveMetadata === "function") st2.saveMetadata();
                        }
                        applyRecentVisibility();
                        toast("已切换至全部视野");
                    } else {
                        var curNode = findNode(state.currentNodeId);
                        if (curNode) {
                            applyJumpVisibility(curNode.id);
                            toast("已切换至本时间线视野");
                        }
                    }
                });
                window.SillyTavern.addSlashCommand("tlg_world", function() {
                    var panel = document.getElementById("tlg-panel");
                    if (!panel) { ensurePanelBuilt(); panel = document.getElementById("tlg-panel"); }
                    if (panel) {
                        panel.style.display = "flex";
                        switchTab("worldarchive");
                    }
                });
            } catch (e) {}
        }

        var intervalId = setInterval(function() {
            renderCanvas();
            var geoCanvasCheck = document.getElementById("tlg-geo-canvas");
            if (geoCanvasCheck && geoCanvasCheck.getBoundingClientRect().width > 0) {
                renderGeoCanvas();
            }
        }, 2000);
    }

    boot();
})();
