/* 河岸凝视 v3 */
(function () {
    "use strict";

    var EXT_NAME = "RiparianGaze";
    var METADATA_KEY = "tlg_data";

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

    var globalApi = {
        apiUrl: "", apiKey: "", model: "", modelList: [],
        vectorUrl: "", vectorKey: "", vectorModel: "", vectorModelList: [],
        rerankUrl: "", rerankKey: "", rerankModel: "", rerankModelList: [],
        vectorTopK: 8, rerankTopN: 3, vectorThreshold: 0, rerankThreshold: 0,
        vectorQueryWindow: 5, vectorChunkLen: 600, vectorInjectDepth: 0, vectorMaxChars: 4000,
        digestUrl: "", digestKey: "", digestModel: "", digestModelList: [],
        digestPrompt: "你是因果观测仪。分析以下对话，输出JSON对象，不要任何额外文字。\n\n{\n  \"narrative\": \"（必填）本轮发生事件的完整自然语言叙述。\",\n  \"turn_time\": \"本轮剧情内时间，原文无则null\",\n  \"location\": { \"path\": [\"一级地名\",\"二级地名\"], \"desc\": \"简介\", \"is_current\": true, \"moved_from\": null },\n  \"characters\": [{ \"name\": \"标准名\", \"role\": \"身份\", \"state_delta\": \"变化\", \"present\": true }],\n  \"items\": [{ \"name\": \"物品全称\", \"change\": \"变动类型\", \"owner\": \"持有者\", \"state\": \"状态\" }],\n  \"key_events\": [\"关键词1\",\"关键词2\"],\n  \"unresolved\": [\"悬置线索1\"],\n  \"importance\": 7\n}\n\n【narrative 字段写作规则——这是唯一会被向量化的字段，决定检索质量】\n\n1. 不限字数。信息量大就写多，日常寒暄可以短。穷尽记录，不省略。\n2. 每个事件必须写成完整的\"时间+地点+人物+动作+结果\"绑定句，禁止让任何要素脱节。\n   正确：\"入夜后，林夜在朝露客栈二楼天字房被持刀男子拦截索要青铜怀表，拒绝后右臂被刺伤。\"\n   错误：\"有人索要怀表。林夜受伤了。在客栈里。入夜后。\"（时间、地点、人物、事件各自散落）\n3. 角色首次出现时必须带身份标注（如\"苏晚（术士）\"），后续同一段内可只用名字。\n4. 因果关系用\"因此/导致/随后\"等连接词显式串联，不要让读者自行推断因果。\n5. 关系变化和情绪转折要写明触发原因：\"因为苏晚出手相救且未趁机夺取怀表，林夜对她从戒备转为初步信任。\"\n6. 地点移动要写\"从A前往B\"，不要只写目的地。\n7. 物品状态变化要写\"某物从A状态变为B状态\"，不要只写最终状态。\n8. 保留重要对话的核心语义（不逐字引用，但保留信息量），如威胁、承诺、揭示秘密等。\n\n【其他字段规则】\n- turn_time：本轮剧情时间（如\"入夜后\"\"第三天清晨\"\"子时三刻\"）。回合开头通常有时间标记，正文可能有\"上午\"\"下午\"等相对时间。原文完全无时间信息则null。\n- location.path：当前所在地层级数组，如[\"青州\",\"云隐镇\",\"朝露客栈\",\"二楼天字房\"]。越具体越好。\n- location.is_current：主角当前是否在此处。\n- location.moved_from：如果本轮发生了位置移动，填出发地path数组，否则null。\n- location.desc：该地点的简介（首次出现时写，已知地点可不写）。\n- characters：只列本轮有实质互动或状态变化的角色。name必须用标准名（不用\"那个人\"\"她\"等代词）。role填身份标签。state_delta写\"从X变为Y（原因）\"，无变化则null。\n- items：只列本轮有状态变动的物品。无变动则空数组。\n- key_events：提取3-8个关键词/短语，供关键词检索。必须是名词或名词短语。\n- unresolved：本轮出现但未解决的伏笔、悬念、被打断的事件。无则空数组。\n- importance：1-10分。日常寒暄1-3，一般推进4-6，关键转折/战斗/揭秘/关系巨变7-10。\n- 无相关内容的字段输出null或空数组。\n- 禁止输出markdown，直接输出JSON。\n\n{{turn_time_hint}}\n\n对话内容：\n{{context}}",
        queryRefinePrompt: "你是\"向量索引构造仪\"，任务是从当前对话语境中提取所有具有检索价值的信息，供向量数据库检索历史事实单元使用。你不做判断、不做评分、不做解释，只做提炼。\n\n【提炼规则——每一类都穷尽提取，不限数量，有多少提多少】\n\n1. 时间信息：当前语境中所有时间相关表述。包括绝对时间（\"子时\"\"第三天黎明\"）和相对时间（\"上午\"\"入夜后\"\"三天前\"）。每个单独列出。没有则该行不输出。\n\n2. 地理坐标：当前所处的具体位置，以及对话中提及的所有其他地点。每个地点用\"/\"分隔层级。没有则该行不输出。\n\n3. 物品全称：当前对话中被提及、被使用、被观察、被寻找、被讨论的所有物品。必须用其在文中出现的全称，不要简化或改写。没有则该行不输出。\n\n4. 角色姓名：当前正在互动的、被提及的、被讨论的、即将登场暗示的所有角色。只写姓名本体。没有则该行不输出。\n\n5. 状态关键词：当前语境中涉及的所有角色状态、物品状态、关系状态（如\"骨折\"\"中毒\"\"敌对\"\"损毁\"\"丢失\"\"信任\"\"恢复\"）。直接对应事实单元的[E][I][C]字段。没有则该行不输出。\n\n6. 事件关键词：当前情节中正在发生、刚刚发生、或被回忆讨论的事件核心词（如\"失窃\"\"暗杀\"\"交易\"\"逃离\"\"封印破碎\"\"追踪\"\"审讯\"）。直接对应事实单元的[A][C]字段。没有则该行不输出。\n\n【质量规则】\n- 每个关键词必须是名词或名词短语，禁止动词短语、禁止完整句子。\n- 禁止输出同义重复项——只保留信息量更大的那个。\n- 禁止输出通用词（\"房间\"\"东西\"\"有人\"\"事情\"这类无检索价值的词）。\n- 禁止编造原文中不存在的词。\n\n【输出格式（唯一允许的格式，空类不输出该行）】\n[TIME]: <逗号分隔>\n[PLACE]: <逗号分隔>\n[ITEM]: <逗号分隔>\n[CHAR]: <逗号分隔>\n[STATE]: <逗号分隔>\n[EVENT]: <逗号分隔>\n\n现在基于以下最新对话内容提取：\n{{context}}",
        digestAutoMode: true, factUnitsMaxCount: 500,
        rerankUseLLM: false,
        rerankLLMPrompt: "你是\"因果一致性终审官\"，负责对向量检索召回的历史事实单元进行相关性终审评分，筛出真正有用的记忆，过滤噪音。你不生成叙事文本，不改写片段内容，只打分排序。\n\n【输入】\n- 当前语境摘要：{{current_context_summary}}\n- 当前语境时间信息：{{current_time}}（可能为空）\n- 当前语境地点信息：{{current_place}}（可能为空）\n- 待评分事实单元列表（含ID、回合号）：{{candidate_fragments}}\n\n【前置规则：同实体/同物品状态去重（在打分之前执行，优先级最高）】\n1. 将候选片段按其[E]或[I]中出现的实体/物品全称分组。\n2. 组内若存在多条记录同一实体/物品但状态互斥，只保留回合号最新的一条参与后续打分；其余较旧记录标记!HISTORICAL。\n3. 若当前语境包含回忆性触发词（\"想起\"\"曾经\"\"对比之前\"\"记得那时\"\"回忆\"等），则!HISTORICAL记录可重新参评，但ID后保留!HISTORICAL标记。\n4. !HISTORICAL与!CONFLICT是两套独立标记，互不覆盖。\n\n【评分权重准则（总分10分，仅对通过前置规则的片段执行）】\n1. 实体一致性（权重50%，最多5分）：片段中的[I]物品或[E]实体，是否与当前语境完全匹配且状态相关。完全匹配且状态相关：5分。部分匹配：2-3分。无匹配：0分。\n2. 动作连续性（权重30%，最多3分）：该片段的[A]动作或[C]因果，是否构成当前语境中正在发生动作的起因/前序/直接后果。是：2-3分。间接关联：1分。无关：0分。\n3. 环境逻辑（权重20%，最多2分）：片段的[T]时间和[L]地点与当前语境是否兼容。一致或当前信息为空：2分。不确定但不矛盾：1分。明显矛盾：0分，并标记!CONFLICT。\n\n【特殊规则】\n- !CONFLICT片段无论总分多少，强制排在最前。\n- 严禁对片段内容做任何改写、总结或解释。\n- 严禁输出评分依据或分析过程。\n\n【输出格式（唯一允许的格式）】\n按分数从高到低排列的片段ID列表，逗号分隔，标记紧跟ID。\n示例：frag_014!CONFLICT,frag_007,frag_022!HISTORICAL,frag_003\n\n现在开始评分。",
        vectorPrompt: "以下为因果档案库中与当前观测焦点相关的历史切片：\n\n{{context}}\n\n处理规则：\n- 这些是已铭刻的因果事实，不可篡改\n- 当前叙事必须与这些记录在逻辑上连续\n- 若当前事件是某条历史线的后果，自然呈现因果关系\n- 不要直接引用或复述这些档案内容",
        summaryPrompt: "你是因果记录仪。对以下对话内容执行全量信息提取，输出一份完整的因果档案，字数在300-500。\n\n【提取要求——不缩写、不省略、不合并】\n\n这份档案将直接注入AI上下文供叙事引擎参考，也供人类玩家回顾。任何遗漏都会导致后续剧情失忆或穿帮。你的职责是\"穷尽记录\"而不是\"精简字数\"。\n\n按以下分类逐一提取，有内容就写，没有就跳过该类（不写\"无\"或\"暂无\"）：\n\n【因果事件链】\n本段中发生的所有事件，按时间顺序逐条列出。每条写清楚：谁、在哪、对谁、做了什么、直接结果是什么。事件之间如果存在因果关系（A导致B导致C），用\"→\"标明因果方向。不存在因果关系的并行事件各自独立成条。\n- 不合并：两个独立事件不要压进一句话。\n- 不省略：哪怕是\"小事\"（如某人说了一句关键台词、某人递出一个物品），只要它对理解剧情有价值，就单独列出。\n\n【角色状态变动】\n所有在本段中出现的角色（包括主角），每人单独列出这段时间内的状态变化过程：\n- 不要只写\"结束时\"的状态快照\n- 要写\"从什么变成了什么\"的变化轨迹\n- 如果某项在这段时间内没有变化，写\"未变\"并注明维持的状态是什么\n- 如果某项经历了多次变化，按顺序全部写出\n\n格式（每人一段）：\n角色名（身份）\n- 生理变化：从xxx到xxx（原因：xxx）。若未变：维持xxx状态。\n- 心理变化：从xxx到xxx（触发事件：xxx）。若未变：维持xxx倾向。\n- 关系变化：与[角色名]从xxx变为xxx（触发事件：xxx）。若无变化可不写此项。\n- 位置变化：从xxx移动到xxx。若未移动：始终在xxx。\n- 物品变化：获得/失去/使用了xxx。若无变动可不写此项。\n\n【物品变动明细】\n所有在本段中发生状态变化的物品，逐个列出：\n- 物品全称\n- 变动类型（获得/失去/使用/损毁/移交/发现/状态改变）\n- 变动前状态 → 变动后状态\n- 当前持有者\n没有物品变动则跳过此类。\n\n【地理信息】\n本段中出现的所有地点，包括：\n- 当前所在地（写完整层级，如\"青州/云隐镇/朝露客栈/二楼\"）\n- 新发现的地点（写完整层级 + 关键特征描述）\n- 地点间的移动轨迹（从哪到哪，经过了哪里）\n没有地理信息则跳过此类。\n\n【新揭示信息】\n本段中首次揭露的、此前未知的信息（身世、秘密、规则、历史、真相等），逐条列出。每条写清楚\"揭示了什么\"以及\"由谁/通过什么方式揭示\"。\n没有则跳过。\n\n【悬置因果线】\n本段中出现但尚未解决/尚未产生后果的事项：\n- 未完成的选择\n- 被打断的事件\n- 未触发的后果\n- 埋下的伏笔\n- 引发的疑问\n逐条列出，每条写清楚\"什么事悬着\"以及\"为什么还没解决\"。\n没有则跳过。\n\n【格式规则】\n- 纯文本输出，禁止使用任何markdown标记（禁止*、**、#、-等符号）\n- 类别标题用【】包裹\n- 直接输出内容，不要开场白、不要结尾总结\n- 信息量大就输出多，这是正确行为，提取角色的重要对话语句（非全部对话），不要自行精简\n\n对话内容：\n{{context}}",
        compressPrompt: "以下是若干条历史因果档案，请将其浓缩合并为一条，保留所有关键事件、状态变化和悬置因果线，删除重复和次要细节。输出格式：纯文本，禁止markdown标记，直接输出内容。\n\n{{context}}",
        pathSummaryPrompt: "以下是一条命运路径上的节点描述和相关因果档案。请为这条路径生成一段完整的剧情摘要，概括主要事件走向、关键转折和当前状态。长度200~400字，确保信息充分。输出格式：纯文本，禁止markdown标记，直接输出内容。\n\n{{context}}",
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
        duration = duration || 2800;
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
                // 不用空字符串覆盖非空默认值（提示词保护）
                if (es.api[k] === "" && typeof globalApi[k] === "string" && globalApi[k].length > 0) continue;
                globalApi[k] = es.api[k];
            }
        }
    }
    function saveGlobalApi() { var es = getExtSettings(); es.api = JSON.parse(JSON.stringify(globalApi)); saveExtSettings(); }
    function loadWorlds() { var es = getExtSettings(); if (es.worlds) worlds = JSON.parse(JSON.stringify(es.worlds)); }
    function saveWorlds() { var es = getExtSettings(); es.worlds = JSON.parse(JSON.stringify(worlds)); saveExtSettings(); }

    // turnsSinceAnchor 单独存在 extensionSettings 根部，不依赖 currentWorldId
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
          // 从 chatMetadata 恢复跳转状态
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
        saveWorlds(); toast("已从旧版数据迁移。");
    }
    function resetState() {
        var rootId = generateId();
        state.nodes = [{ id: rootId, name: "起源点", brief: "时间线起源。", parentId: null, msgIdx: 0, statData: null, timestamp: Date.now(), children: [] }];
        state.currentNodeId = rootId; state.selectedNodeId = null; state.summaries = []; state.turnsSinceAnchor = 0; state._lastChatLen = 0;
    }
    function findNode(id) { return state.nodes.find(function (n) { return n.id === id; }) || null; }
    function getPathToRoot(nodeId) {
        var path = [], cur = findNode(nodeId);
        while (cur) { path.unshift(cur.id); cur = findNode(cur.parentId); }
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

        // 写进 chat_metadata（注意是下划线），重启后可恢复
        if (st.chat_metadata) {
            st.chat_metadata._tlg_jumpedToIdx = endIdx;
            st.chat_metadata._tlg_chatLenAtJump = st.chat.length;
        }

        // 只保存，不 reload
        if (typeof st.saveChat === "function") st.saveChat();
        if (typeof st.saveMetadata === "function") st.saveMetadata();
        else if (typeof window.saveMetadataDebounced === "function") window.saveMetadataDebounced();
    }
    
    function applyRecentVisibility() {
        var st = getST(); if (!st || !st.chat || !st.chat.length) return;
        var lastN = Math.max(1, globalApi.lastNMessages || 5);
        var total = st.chat.length;

        // 跳转模式
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

        // 正常模式
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
        // 找最合适的父节点：msgIdx 最接近且 <= 目标楼层的已有节点
        var bestParent = null;
        var bestDist = Infinity;
        for (var i = 0; i < state.nodes.length; i++) {
            var n = state.nodes[i];
            if (n.msgIdx <= msgIdx) {
                var dist = msgIdx - n.msgIdx;
                if (dist < bestDist) { bestDist = dist; bestParent = n; }
            }
        }
        // 如果没找到（不该发生），用根节点
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
        var node = findNode(nodeId); if (!node) { toast("节点不存在。"); return; }
        var st = getST();

        // ── 跳转前自动总结：不受间隔约束，全部未覆盖楼层都总结 ──
        var apiUrl = (globalApi.apiUrl || "").trim();
        if (apiUrl && globalApi.jumpSummary && st && st.chat) {
            var coveredUpTo = _getCoveredUpTo();
            var uncovered = [];
            for (var mi = 1; mi < st.chat.length; mi++) {
                if (mi <= coveredUpTo) continue;
                uncovered.push(st.chat[mi]);
            }
            // 有未覆盖楼层就全部总结（按间隔分批，但不要求满一批）
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

        // ── 恢复 MVU 变量 ──
        if (node.statData != null) setMVUStatData(node.statData);

        // ── 跳转后隐藏：只显示目标节点前 lastN 条，其余全隐藏 ──
        applyJumpVisibility(nodeId);

        state.currentNodeId = nodeId; state.turnsSinceAnchor = 0;
        saveTurnsCounter();
        saveCurrentWorld(); toast("↩ 已跳转至: " + node.name); renderCanvas(); refreshArchive(); closeBriefPanel();
    }

    function showAnchorModal(prefillName) {
        if (!isEnabled()) { toast("河岸凝视已关闭。"); return; }
        var existing = document.getElementById("tlg-anchor-modal"); if (existing) existing.remove();
        var backdrop = document.createElement("div"); backdrop.id = "tlg-anchor-modal";
        backdrop.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100dvh;background:rgba(0,0,0,0.85);z-index:2147483647;display:flex;align-items:flex-start;justify-content:center;padding:16px;padding-top:12vh;box-sizing:border-box;overflow-y:auto;";
        var st = getST(); var maxFloor = st && st.chat ? st.chat.length - 1 : 0;
        backdrop.innerHTML = '<div class="tlg-modal"><div class="tlg-modal-title">⚓ 锚定因果刻度</div><div style="margin-bottom:12px"><label class="tlg-label">节点名称</label><input class="tlg-input" id="tlg-anc-name" placeholder="例：抉择之前…" value="' + escHtml(prefillName || "") + '" /></div><div style="margin-bottom:12px"><label class="tlg-label">简要描述</label><textarea class="tlg-textarea" id="tlg-anc-brief" placeholder="此时此刻的情况概述…"></textarea></div><div style="margin-bottom:12px"><label class="tlg-label">锚定楼层（留空=当前最新 #' + maxFloor + '）</label><input class="tlg-input" id="tlg-anc-floor" type="number" min="0" max="' + maxFloor + '" placeholder="' + maxFloor + '" /></div><div class="tlg-modal-actions"><button type="button" class="tlg-btn" id="tlg-anc-cancel">取消</button><button type="button" class="tlg-btn tlg-btn-primary" id="tlg-anc-ok">确认锚定</button></div></div>';
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
        return null;
    }

    function openBriefPanel(nodeId) {
        var node = findNode(nodeId); if (!node) return; state.selectedNodeId = nodeId;
        var panel = document.getElementById("tlg-brief-panel"); if (!panel) return;
        panel.classList.add("open"); panel.querySelector(".tlg-brief-header span").textContent = node.name;
        var body = panel.querySelector(".tlg-brief-body");
        body.innerHTML = '<div style="margin-bottom:8px;font-size:11px;color:#7a7a8a">' + new Date(node.timestamp).toLocaleString() + "</div>" +
            '<div style="margin-bottom:8px;font-size:11px;color:#7a7a8a">消息索引: ' + node.msgIdx + " | " + (node.statData ? "MVU快照 ✓" : "无MVU快照") + "</div>" +
            '<div style="white-space:pre-wrap;word-break:break-word">' + (node.brief ? escHtml(node.brief) : "<em style='color:#7a7a8a'>暂无描述。</em>") + "</div>" +
            '<div style="margin-top:12px"><label class="tlg-label">编辑描述</label><textarea class="tlg-textarea" id="tlg-brief-edit" style="min-height:80px">' + escHtml(node.brief || "") + "</textarea>" +
            '<button type="button" class="tlg-btn tlg-btn-primary" id="tlg-brief-save" style="margin-top:6px;width:100%!important">保存描述</button></div>';
        body.querySelector("#tlg-brief-save").onclick = function () {
            flashBtn(this); node.brief = body.querySelector("#tlg-brief-edit").value; saveCurrentWorld(); toast("描述已保存。"); refreshArchive();
        };
        panel.querySelector(".tlg-brief-footer").innerHTML =
            '<button type="button" class="tlg-btn" id="tlg-brief-rename" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;margin-bottom:6px;width:100%!important;">✎ 重命名</button>' +
            '<button type="button" class="tlg-btn" id="tlg-brief-pin" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;margin-bottom:6px;width:100%!important;">📌 设为常用路径</button>' +
            '<button type="button" class="tlg-btn tlg-btn-jump" id="tlg-brief-jump">↩ 确认跳转至此因果</button>';
        panel.querySelector("#tlg-brief-jump").onclick = function () { jumpToNode(nodeId); };
        panel.querySelector("#tlg-brief-rename").onclick = function () {
            var newName = prompt("新节点名称：", node.name);
            if (newName === null) return; newName = newName.trim(); if (!newName) return;
            node.name = newName; panel.querySelector(".tlg-brief-header span").textContent = newName;
            saveCurrentWorld(); refreshArchive(); renderCanvas(); toast("节点已重命名。");
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
        backdrop.innerHTML = '<div class="tlg-modal"><div class="tlg-modal-title">📌 设为常用路径</div>' +
            '<div style="font-size:12px;color:#7a7a8a;margin-bottom:12px;">终点节点：' + escHtml(node.name) + '（可在观测坐标里调整终点）</div>' +
            '<label class="tlg-label">路径名称</label><input class="tlg-input" id="tlg-pin-name" value="' + escHtml(node.name + " 路径") + '" style="margin-bottom:10px" />' +
            '<label class="tlg-label">路径描述</label><textarea class="tlg-textarea" id="tlg-pin-desc" placeholder="手写描述，或点击AI生成…" style="min-height:80px;margin-bottom:10px"></textarea>' +
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
            saveWorlds(); backdrop.remove(); toast("常用路径已保存：" + name);
            refreshArchive();
        };
        backdrop.querySelector("#tlg-pin-ai").onclick = function () {
            var self = this; self.disabled = true; self.textContent = "生成中…";
            generatePathDesc(nodeId, function(desc) {
                backdrop.querySelector("#tlg-pin-desc").value = desc;
                self.disabled = false; self.textContent = "AI生成描述";
            });
        };
        backdrop.addEventListener("click", function (e) { if (e.target === backdrop) backdrop.remove(); });
    }

    function generatePathDesc(nodeId, callback) {
        var apiUrl = (globalApi.apiUrl || "").trim(), apiKey = (globalApi.apiKey || "").trim(), model = (globalApi.model || "").trim();
        if (!apiUrl) { toast("请先配置API地址。"); callback(""); return; }
        var pathIds = getPathToRoot(nodeId);
        var pathNodes = pathIds.map(findNode).filter(Boolean);
        var contextParts = [];
        // 1. 节点信息
        pathNodes.forEach(function(n) {
            var info = "节点【" + n.name + "】(#" + n.msgIdx + ")";
            if (n.brief) info += "：" + n.brief;
            contextParts.push(info);
        });
        // 2. 相关档案（多取一些）
        var relSummaries = state.summaries.filter(function(s) { return !s.nodeId || pathIds.indexOf(s.nodeId) !== -1; }).slice(-10);
        if (relSummaries.length) {
            contextParts.push("路径相关因果档案：\n" + relSummaries.map(function(s){ return s.text; }).join("\n---\n"));
        }
        // 3. 如果上下文仍然太少，补充最近的聊天消息
        if (contextParts.join("").length < 100) {
            var st = getST();
            if (st && st.chat) {
                var targetNode = findNode(nodeId);
                var endIdx = targetNode ? targetNode.msgIdx : st.chat.length - 1;
                var startIdx = Math.max(0, endIdx - 10);
                var chatSlice = st.chat.slice(startIdx, endIdx + 1).filter(function(m) { return m.mes; });
                if (chatSlice.length) {
                    contextParts.push("该节点附近的对话：\n" + chatSlice.map(function(m) { return (m.name || m.role || "?") + ": " + (m.mes || "").slice(0, 150); }).join("\n"));
                }
            }
        }
        var context = contextParts.join("\n\n");
        if (!context.trim()) { toast("路径上下文为空，无法生成。"); callback(""); return; }
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
                toast("⚠ AI 生成内容过短（" + text.length + "字），可能上下文不足。");
            }
            callback(text);
        }).catch(function(e){ toast("生成失败：" + e.message); callback(""); });
    }

    function refreshPinnedPaths() {
        var container = document.getElementById("tlg-pinned-paths"); if (!container) return;
        var paths = getPinnedPaths();
        if (!paths.length) { container.innerHTML = '<div style="color:#5a5a6a;font-size:12px;padding:8px 0;">暂无常用路径。点击节点可设置。</div>'; return; }
        var nodeOpts = state.nodes.map(function(n){ return '<option value="' + escHtml(n.id) + '">' + escHtml(n.name) + '</option>'; }).join("");
        container.innerHTML = paths.map(function(p) {
            var endNode = findNode(p.nodeId);
            var desc = p.userDesc || p.autoDesc || "";
            return '<div style="background:#050508;border:1px solid #2a2a3a;border-radius:4px;padding:10px;margin-bottom:8px;">' +
                '<div style="font-size:13px;font-weight:600;color:#e8e8f0;margin-bottom:4px;">' + escHtml(p.name) + '</div>' +
                '<div style="font-size:11px;color:#7a7a8a;margin-bottom:6px;">终点：' + escHtml(endNode ? endNode.name : "未知") + '</div>' +
                (desc ? '<div style="font-size:12px;color:#9a9aaa;margin-bottom:8px;white-space:pre-wrap">' + escHtml(desc.slice(0, 80)) + (desc.length > 80 ? "…" : "") + '</div>' : '') +
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
                if (!confirm("删除常用路径「" + paths[idx].name + "」？")) return;
                paths.splice(idx, 1); saveWorlds(); refreshPinnedPaths(); toast("已删除。");
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
            saveWorlds(); backdrop.remove(); refreshPinnedPaths(); toast("路径已更新。");
        };
        backdrop.querySelector("#tlg-pine-ai").onclick = function() {
            var self = this; self.disabled = true; self.textContent = "生成中…";
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
        // 常用路径区块
        refreshPinnedPaths();
        if (!state.nodes.length) { container.innerHTML = '<div style="color:#5a5a6a;padding:40px 20px;text-align:center;font-style:italic;letter-spacing:1px;">河流静默，因果尚未铭刻。</div>'; return; }
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
                if (btn.dataset.nid === state.currentNodeId) { toast("无法删除当前所在节点。"); return; }
                var n = findNode(btn.dataset.nid);
                if (!confirm("确定删除节点「" + (n ? n.name : "") + "」？")) return;
                deleteNode(btn.dataset.nid);
            };
        });
        container.querySelectorAll(".tlg-archive-graft").forEach(function (btn) { btn.onclick = function () { showGraftModal(btn.dataset.nid); }; });
    }

    function deleteNode(nodeId) {
        var node = findNode(nodeId); if (!node) return;
        if (!node.parentId) { toast("无法删除根节点。"); return; }
        var parent = findNode(node.parentId);
        // 将被删节点的子节点重新挂载到父节点
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
        saveCurrentWorld(); renderCanvas(); refreshArchive(); toast("节点已删除，子节点已重连至父级。");
    }

    function graftNode(nodeId, newParentId) {
        if (nodeId === newParentId) { toast("不能嫁接到自身。"); return; }
        var node = findNode(nodeId); if (!node) return;
        function isDescendant(ancestorId, targetId) {
            var n = findNode(targetId); if (!n) return false;
            if (n.parentId === ancestorId) return true;
            return n.parentId ? isDescendant(ancestorId, n.parentId) : false;
        }
        if (isDescendant(nodeId, newParentId)) { toast("目标节点是此节点的子孙，无法嫁接。"); return; }
        var oldParent = findNode(node.parentId);
        if (oldParent) oldParent.children = oldParent.children.filter(function (id) { return id !== nodeId; });
        var newParent = findNode(newParentId); if (!newParent) { toast("目标节点不存在。"); return; }
        if (newParent.children.indexOf(nodeId) === -1) newParent.children.push(nodeId);
        node.parentId = newParentId;
        saveCurrentWorld(); renderCanvas(); refreshArchive(); toast("节点已嫁接至「" + newParent.name + "」。");
    }

    function showGraftModal(nodeId) {
        var node = findNode(nodeId); if (!node) return;
        var candidates = state.nodes.filter(function (n) { return n.id !== nodeId; });
        if (!candidates.length) { toast("没有可嫁接的目标节点。"); return; }
        var existing = document.getElementById("tlg-graft-modal"); if (existing) existing.remove();
        var backdrop = document.createElement("div"); backdrop.id = "tlg-graft-modal";
        backdrop.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100dvh;background:rgba(0,0,0,0.85);z-index:2147483647;display:flex;align-items:flex-start;justify-content:center;padding:16px;padding-top:10vh;box-sizing:border-box;overflow-y:auto;";
        var opts = candidates.map(function (n) { return '<option value="' + escHtml(n.id) + '">' + escHtml(n.name) + (n.id === node.parentId ? " (当前父)" : "") + '</option>'; }).join("");
        backdrop.innerHTML = '<div class="tlg-modal"><div class="tlg-modal-title">⇢ 嫁接节点</div>' +
            '<div style="font-size:12px;color:#7a7a8a;margin-bottom:12px;">将「' + escHtml(node.name) + '」及其子树移动到新父节点下。</div>' +
            '<label class="tlg-label">选择新父节点</label><select class="tlg-select" id="tlg-graft-target" style="width:100%;margin-bottom:16px;">' + opts + '</select>' +
            '<div class="tlg-modal-actions"><button type="button" class="tlg-btn" id="tlg-graft-cancel">取消</button><button type="button" class="tlg-btn tlg-btn-primary" id="tlg-graft-ok">确认嫁接</button></div></div>';
        document.body.appendChild(backdrop);
        var sel = backdrop.querySelector("#tlg-graft-target");
        var nonParent = candidates.find(function (n) { return n.id !== node.parentId; });
        if (nonParent) sel.value = nonParent.id;
        backdrop.querySelector("#tlg-graft-cancel").onclick = function () { backdrop.remove(); };
        backdrop.querySelector("#tlg-graft-ok").onclick = function () {
            if (!sel.value) { toast("请选择目标节点。"); return; }
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
            list.innerHTML = '<div style="color:#5a5a6a;padding:20px 0;text-align:center;font-style:italic;">虚空寂寂，尚无因果被铭刻于此。</div>' + catchupHtml;
            var cb = document.getElementById("tlg-summary-catchup-btn"); if (cb) cb.addEventListener("click", runCatchupSummary);
            return;
        }
        var latest = state.summaries[state.summaries.length - 1];
        var preview = (latest.text || "").slice(0, 120) + (latest.text && latest.text.length > 120 ? "…" : "");
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
        // 浓缩控制区
        var ctrlHtml = '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;align-items:center;">' +
            '<input type="text" id="tlg-sh-search" placeholder="检索关键词…" style="flex:1;min-width:0;padding:8px 12px;background:#000;border:1px solid #2a2a3a;border-radius:3px;color:#e0e0e8;font-size:14px;outline:none;" />' +
            '<span id="tlg-sh-count" style="font-size:12px;color:#7a7a8a;white-space:nowrap;">' + (state.summaries ? state.summaries.length : 0) + ' 条</span>' +
            '</div>' +
            '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;">' +
            '<button type="button" class="tlg-btn" id="tlg-vault-catchup" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">📋 补全历史切片</button>' +
            '<button type="button" class="tlg-btn" id="tlg-vault-compress-range" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">🗜 选范围浓缩</button>' +
            '</div>';
        container.innerHTML = ctrlHtml + '<div id="tlg-sh-list"></div>';
        renderSummaryList("");
        document.getElementById("tlg-sh-search").addEventListener("input", function () { renderSummaryList(this.value.trim().toLowerCase()); });
        document.getElementById("tlg-vault-catchup").addEventListener("click", runCatchupSummary);
        document.getElementById("tlg-vault-compress-range").addEventListener("click", showCompressRangeModal);
    }

    function renderSummaryList(keyword) {
        var listWrap = document.getElementById("tlg-sh-list"); if (!listWrap) return;
        var items = (state.summaries || []).slice().reverse();
        if (keyword) { items = items.filter(function (s) { return (s.text || "").toLowerCase().indexOf(keyword) !== -1; }); }
        var countEl = document.getElementById("tlg-sh-count"); if (countEl) countEl.textContent = items.length + " 条";
        if (!items.length) { listWrap.innerHTML = '<div style="color:#5a5a6a;padding:40px 20px;text-align:center;font-style:italic;">' + (keyword ? "因果之中未见此痕迹。" : "虚空寂寂，尚无因果被铭刻于此。") + '</div>'; return; }
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
                '<button type="button" class="tlg-btn tlg-sh-edit" data-idx="' + realIdx + '" style="font-size:11px;writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">✏️ 编辑</button>' +
                (!s.compressed ? '<button type="button" class="tlg-btn tlg-sh-compress1" data-idx="' + realIdx + '" style="font-size:11px;writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">🗜 单条浓缩</button>' : '') +
                '<button type="button" class="tlg-btn tlg-btn-danger tlg-sh-del" data-idx="' + realIdx + '" style="font-size:11px;margin-left:auto;writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">✕ 抹除</button>' +
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
                var kw = (document.getElementById("tlg-sh-search") || {}).value || ""; renderSummaryList(kw.trim().toLowerCase()); toast("档案已更新。");
            });
        });
        listWrap.querySelectorAll(".tlg-sh-del").forEach(function (btn) {
            btn.addEventListener("click", function () {
                var idx = Number(btn.dataset.idx); if (!confirm("确定抹除这条记录？")) return;
                state.summaries.splice(idx, 1); saveCurrentWorld(); refreshSummary();
                var kw = (document.getElementById("tlg-sh-search") || {}).value || ""; renderSummaryList(kw.trim().toLowerCase()); toast("已抹除。");
            });
        });
        listWrap.querySelectorAll(".tlg-sh-compress1").forEach(function(btn) {
            btn.addEventListener("click", function() {
                var idx = Number(btn.dataset.idx);
                if (!confirm("将第 #" + (idx+1) + " 条单独浓缩（重写为更精简版本）？")) return;
                compressSummaries([idx], function(compressed) {
                    if (compressed) {
                        state.summaries[idx] = compressed[0];
                        saveCurrentWorld(); refreshSummary();
                        var kw = (document.getElementById("tlg-sh-search") || {}).value || ""; renderSummaryList(kw.trim().toLowerCase());
                        toast("单条浓缩完成。");
                    }
                });
            });
        });
    }

    function showCompressRangeModal() {
        var existing = document.getElementById("tlg-compress-modal"); if (existing) existing.remove();
        if (!state.summaries || state.summaries.length < 2) { toast("至少需要2条总结才能选范围浓缩。"); return; }
        var backdrop = document.createElement("div"); backdrop.id = "tlg-compress-modal";
        backdrop.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100dvh;background:rgba(0,0,0,0.85);z-index:2147483647;display:flex;align-items:flex-start;justify-content:center;padding:16px;padding-top:10vh;box-sizing:border-box;overflow-y:auto;";
        var maxIdx = state.summaries.length;
        var opts = state.summaries.map(function(s, i) { return '<option value="' + i + '">#' + (i+1) + ' · ' + new Date(s.timestamp).toLocaleDateString() + (s.compressed ? " [已浓缩]" : "") + '</option>'; }).join("");
        backdrop.innerHTML = '<div class="tlg-modal"><div class="tlg-modal-title">🗜 选范围浓缩</div>' +
            '<div style="font-size:12px;color:#7a7a8a;margin-bottom:12px;">选择起止条目，将该范围内的未浓缩条目合并压缩为一条。</div>' +
            '<label class="tlg-label">起始（含）</label><select class="tlg-select" id="tlg-cr-from" style="width:100%;margin-bottom:10px;">' + opts + '</select>' +
            '<label class="tlg-label">结束（含）</label><select class="tlg-select" id="tlg-cr-to" style="width:100%;margin-bottom:16px;">' + opts + '</select>' +
            '<div class="tlg-modal-actions"><button type="button" class="tlg-btn" id="tlg-cr-cancel">取消</button><button type="button" class="tlg-btn tlg-btn-primary" id="tlg-cr-ok">确认浓缩</button></div></div>';
        document.body.appendChild(backdrop);
        var fromSel = backdrop.querySelector("#tlg-cr-from");
        var toSel = backdrop.querySelector("#tlg-cr-to");
        toSel.selectedIndex = maxIdx - 1;
        backdrop.querySelector("#tlg-cr-cancel").onclick = function() { backdrop.remove(); };
        backdrop.querySelector("#tlg-cr-ok").onclick = function() {
            var from = parseInt(fromSel.value, 10), to = parseInt(toSel.value, 10);
            if (from > to) { toast("起始不能大于结束。"); return; }
            var indices = [];
            for (var i = from; i <= to; i++) { if (!state.summaries[i].compressed) indices.push(i); }
            if (!indices.length) { toast("所选范围内无未浓缩条目。"); backdrop.remove(); return; }
            backdrop.remove();
            compressSummariesAndReplace(indices);
        };
        backdrop.addEventListener("click", function(e) { if (e.target === backdrop) backdrop.remove(); });
    }

    // 浓缩核心：把 indices 对应的总结发给API浓缩，回调返回结果文本
    function compressSummaries(indices, callback) {
        var apiUrl = (globalApi.apiUrl || "").trim(), apiKey = (globalApi.apiKey || "").trim(), model = (globalApi.model || "").trim();
        if (!apiUrl) { toast("请先配置API地址。"); return; }
        var texts = indices.map(function(i){ return state.summaries[i].text; }).join("\n\n---\n\n");
        var prompt = (globalApi.compressPrompt || "").replace("{{context}}", texts);
        toast("⏳ 浓缩中…");
        fetch(buildEndpoint(apiUrl, "/chat/completions"), {
            method: "POST", headers: Object.assign({ "Content-Type": "application/json" }, apiKey ? { Authorization: "Bearer " + apiKey } : {}),
            body: JSON.stringify({ model: model || undefined, messages: [{ role: "user", content: prompt }], max_tokens: 1024 })
        }).then(function(r){ return r.json(); }).then(function(data){
            var text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
            callback([{ timestamp: Date.now(), text: text, nodeId: state.currentNodeId, compressed: true, sourceCount: indices.length }]);
        }).catch(function(e){ toast("浓缩失败：" + e.message); });
    }

    // 把 indices 对应条目替换为一条浓缩结果
    function compressSummariesAndReplace(indices) {
        compressSummaries(indices, function(compressed) {
            if (!compressed) return;
            // 从大到小删除，避免索引偏移
            var sorted = indices.slice().sort(function(a,b){ return b-a; });
            sorted.forEach(function(i){ state.summaries.splice(i, 1); });
            // 在最小索引位置插入浓缩结果
            state.summaries.splice(indices[0], 0, compressed[0]);
            saveCurrentWorld(); refreshSummary();
            var kw = (document.getElementById("tlg-sh-search") || {}).value || ""; renderSummaryList(kw.trim().toLowerCase());
            toast("✓ 浓缩完成，" + indices.length + " 条合并为 1 条。");
        });
    }

    // 检查是否需要自动浓缩（写入新总结后调用）
    function checkAutoCompress() {
        if (!globalApi.autoCompress) return;
        var maxCount = Math.max(10, globalApi.summaryMaxCount || 100);
        if (state.summaries.length <= maxCount) return;
        // 取最旧的未浓缩条目
        var batchSize = Math.max(2, globalApi.compressBatchSize || 10);
        var indices = [];
        for (var i = 0; i < state.summaries.length && indices.length < batchSize; i++) {
            if (!state.summaries[i].compressed) indices.push(i);
        }
        if (indices.length < 2) {
            toast("⚠ 档案库已满（" + state.summaries.length + " 条），已无可浓缩的未浓缩条目，请手动清理。");
            return;
        }
        toast("⚙ 档案库已满，自动浓缩最旧 " + indices.length + " 条…");
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
        var injectionText = (template && template.indexOf("{{context}}") !== -1) ? template.replace("{{context}}", content) : "以下为已记录的近期因果档案：\n\n" + content + "\n\n请保持叙事与上述记录的连续性。";
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
                // 相似度阈值过滤
                if (threshold > 0) {
                    scored = scored.filter(function (s) { return s.score >= threshold; });
                }
                if (!scored.length) { updateInjection(); return; }
                var candidates = scored.slice(0, topK);
                // 是否重排
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
                toast("⚠ 向量检索失败，" + (delay / 1000) + "秒后重试 (" + (retryCount + 1) + "/" + MAX_RETRIES + ")");
                setTimeout(function () { _vectorSearchWithRetry(st, vecUrl, vecKey, vecModel, chat, retryCount + 1); }, delay);
            } else {
                toast("⚠ 向量检索最终失败，回退直接注入。");
                updateInjection();
            }
        });
    }

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
                // 重排阈值过滤
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
                toast("⚠ 重排失败，" + (delay / 1000) + "秒后重试");
                setTimeout(function () { _rerankAndInject(st, rerankUrl, rerankKey, rerankModel, query, candidates, retryCount + 1); }, delay);
            } else {
                toast("⚠ 重排最终失败，使用向量原始排序。");
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
                if (remain > 50) parts.push(text.slice(0, remain) + "…");
                break;
            }
            parts.push(text); usedChars += text.length;
        }
        var content = parts.join("\n\n---\n\n");
        var template = globalApi.vectorPrompt || "";
        var injectionText = (template && template.indexOf("{{context}}") !== -1) ? template.replace("{{context}}", content) : "以下为与当前情境相关的因果档案：\n\n" + content;
        var depth = Math.max(0, globalApi.vectorInjectDepth || 0);
        st.setExtensionPrompt(EXT_NAME, injectionText, 1, depth);
    }

    function buildEndpoint(base, path) {
        var url = (base || "").trim().replace(/\/+$/, "");
        if (path === "/chat/completions" && /\/chat\/completions$/.test(url)) return url;
        if (path === "/models" && /\/models$/.test(url)) return url;
        if (!/\/v\d+/.test(url)) url += "/v1"; return url + path;
    }

    function _doSummaryRequest(messagesArray, auto, sourceLabel, onDone) {
        var apiUrl = (globalApi.apiUrl || "").trim(), apiKey = (globalApi.apiKey || "").trim();
        var model = (globalApi.model || "").trim(), summaryPrompt = (globalApi.summaryPrompt || "").trim();
        if (!apiUrl) { toast("切片失败：未设置 API 地址。"); if (typeof onDone === "function") onDone(); return; }
        if (!messagesArray || !messagesArray.length) { if (!auto) toast("没有可用的消息。"); if (typeof onDone === "function") onDone(); return; }

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
        toast("⏳ " + label + "切片中…" + floorLabel);
        var sendBtn = document.getElementById("send_but");
        if (sendBtn) { sendBtn.disabled = true; sendBtn.style.opacity = "0.4"; }

        fetch(buildEndpoint(apiUrl, "/chat/completions"), {
            method: "POST", headers: Object.assign({ "Content-Type": "application/json" }, apiKey ? { Authorization: "Bearer " + apiKey } : {}),
            body: JSON.stringify({ model: model || undefined, messages: [{ role: "user", content: prompt }], max_tokens: 2048 })
        }).then(function (res) { if (!res.ok) throw new Error("HTTP " + res.status); return res.json(); })
        .then(function (data) {
            var text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
            if (lockedWorldId && worlds[lockedWorldId]) {
                if (!worlds[lockedWorldId].summaries) worlds[lockedWorldId].summaries = [];
                worlds[lockedWorldId].summaries.push({ timestamp: Date.now(), text: text, nodeId: state.currentNodeId, floorFrom: firstFloor, floorTo: lastFloor });
                if (auto && firstFloor >= 0 && lastFloor >= 0) {
                    state.lastAutoSummaryRange = { floorFrom: firstFloor, floorTo: lastFloor, summaryIdx: worlds[lockedWorldId].summaries.length - 1 };
                }
                if (lockedWorldId === currentWorldId) {
                    state.summaries = worlds[lockedWorldId].summaries;
                    refreshSummary();
                }
                saveWorlds(); updateInjectionWithVector();
                // 检查是否需要自动浓缩（上限保护）
                checkAutoCompress();
                toast("✓ " + label + "切片完成" + floorLabel);
            }
        }).catch(function (e) { toast("✗ " + label + "切片失败：" + e.message); })
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
        var st = getST(); if (!st || !st.chat || !st.chat.length) { if (!auto) toast("当前无聊天消息。"); return; }
        ensureWorldExists();
        var interval = globalApi.autoInterval || 10;
        var coveredUpTo = _getCoveredUpTo();
        // 收集未覆盖楼层（跳过#0，不过滤隐藏标记）
        var uncovered = [];
        for (var j = 0; j < st.chat.length; j++) {
            if (j === 0) continue;
            if (j <= coveredUpTo) continue;
            uncovered.push(st.chat[j]);
        }
        if (auto) {
            // 自动模式：必须满一个完整间隔
            if (uncovered.length < interval) return;
            var batch = uncovered.slice(0, interval);
            _doSummaryRequest(batch, true, "自动");
        } else {
            // 手动模式：取最近 N 条（不过滤隐藏）
            var count = globalApi.manualCount || 20;
            var recent = st.chat.slice(-count);
            if (recent.length && recent[0] === st.chat[0]) recent = recent.slice(1); // 跳过开场白
            _doSummaryRequest(recent, false, "手动");
        }
    }

    function runCatchupSummary() {
        var st = getST(); if (!st || !st.chat || !st.chat.length) { toast("当前无聊天消息。"); return; }
        ensureWorldExists();
        var batchSize = Math.max(1, globalApi.autoInterval || 10);
        // 计算已覆盖的最大楼层号
        var coveredUpTo = -1;
        if (state.summaries && state.summaries.length) {
            for (var i = 0; i < state.summaries.length; i++) {
                var s = state.summaries[i];
                if (typeof s.floorTo === "number" && s.floorTo > coveredUpTo) coveredUpTo = s.floorTo;
            }
        }
        // 收集未覆盖楼层（跳过#0开场白，不过滤隐藏标记）
        var uncovered = [];
        for (var j = 0; j < st.chat.length; j++) {
            if (j === 0) continue;
            if (j <= coveredUpTo) continue;
            uncovered.push(st.chat[j]);
        }
        if (!uncovered.length) { toast("所有楼层已被覆盖，无需补全。"); return; }
        // 分批，最后一批不满 batchSize 则丢弃
        var batches = [];
        for (var k = 0; k < uncovered.length; k += batchSize) {
            var batch = uncovered.slice(k, k + batchSize);
            if (batch.length < batchSize) break;
            batches.push(batch);
        }
        if (!batches.length) { toast("未覆盖消息不足 " + batchSize + " 条，暂不补全。"); return; }
        toast("📋 开始补全历史切片，共 " + batches.length + " 批…");
        var sendBtn = document.getElementById("send_but");
        if (sendBtn) { sendBtn.disabled = true; sendBtn.style.opacity = "0.4"; }
        var catchupBtns = document.querySelectorAll("#tlg-summary-catchup-btn,#tlg-vault-catchup");
        catchupBtns.forEach(function(b){ b.disabled = true; });
        var idx = 0;
        function nextBatch() {
            if (idx >= batches.length) {
                toast("✓ 历史补全完成，共 " + batches.length + " 批。");
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
    // 摘要API：每回合记忆抽取
    // ══════════════════════════════════════
    function getTurnTime() {
        try {
            var snap = window.__tlg_mvu_snapshot || {};
            var t = snap.time || snap.game_time || snap.current_time || snap.date || snap.gameTime || "";
            return String(t).trim();
        } catch (e) { return ""; }
    }

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
            // JSON解析失败：把原始文本当narrative降级
            return {
                narrative: raw.slice(0, 3000), turn_time: null, location: null,
                characters: [], items: [], key_events: [], unresolved: [], importance: 5
            };
        }
    }

    function applyGeoUpdates(location, lockedWorldId) {
        if (!location || !lockedWorldId || !worlds[lockedWorldId]) return;
        if (!worlds[lockedWorldId].geoTree) worlds[lockedWorldId].geoTree = {};
        var tree = worlds[lockedWorldId].geoTree;
        var path = location.path;
        if (!Array.isArray(path) || !path.length) return;

        // 清除所有 isCurrent 标记
        function clearCurrent(obj) {
            var keys = Object.keys(obj);
            for (var i = 0; i < keys.length; i++) {
                obj[keys[i]].isCurrent = false;
                if (obj[keys[i]].children) clearCurrent(obj[keys[i]].children);
            }
        }
        clearCurrent(tree);

        // 沿 path 创建/更新节点
        var cur = tree;
        for (var i = 0; i < path.length; i++) {
            var name = path[i];
            if (!cur[name]) {
                cur[name] = { desc: "", locked: false, isCurrent: false, children: {} };
            }
            if (i === path.length - 1) {
                if (!cur[name].locked && location.desc) cur[name].desc = location.desc;
                if (location.is_current) cur[name].isCurrent = true;
            }
            cur = cur[name].children;
        }

        // 如果有 moved_from，也创建起点路径（不标 isCurrent）
        if (Array.isArray(location.moved_from) && location.moved_from.length) {
            var cur2 = tree;
            for (var j = 0; j < location.moved_from.length; j++) {
                var n2 = location.moved_from[j];
                if (!cur2[n2]) cur2[n2] = { desc: "", locked: false, isCurrent: false, children: {} };
                cur2 = cur2[n2].children;
            }
        }
        saveWorlds();
        if (typeof refreshGeoTree === "function") refreshGeoTree();
    }

    function applyNpcUpdates(characters, lockedWorldId) {
        if (!characters || !characters.length || !lockedWorldId || !worlds[lockedWorldId]) return;
        if (!worlds[lockedWorldId].npcArchive) worlds[lockedWorldId].npcArchive = {};
        var archive = worlds[lockedWorldId].npcArchive;
        for (var i = 0; i < characters.length; i++) {
            var ch = characters[i];
            if (!ch.name) continue;
            if (!archive[ch.name]) {
                archive[ch.name] = {
                    role: ch.role || "",
                    appearance: { value: "", locked: false },
                    age: { value: "", locked: false },
                    timeline: [],
                    custom: []
                };
            }
            // 更新 role
            if (ch.role && !archive[ch.name].role) archive[ch.name].role = ch.role;
            // 追加时间线
            if (ch.state_delta && ch.state_delta !== "null") {
                archive[ch.name].timeline.push({
                    event: ch.state_delta,
                    timestamp: getTurnTime() || "",
                    auto: true,
                    createdAt: Date.now()
                });
            }
        }
        saveWorlds();
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

        // 也取用户最近一条，提供上下文
        var userMsg = null;
        for (var j = st.chat.length - 1; j >= 0; j--) {
            if (st.chat[j].is_user && st.chat[j].mes) { userMsg = st.chat[j]; break; }
        }

        var turnTime = getTurnTime();
        var context = "";
        if (userMsg) context += (userMsg.name || "User") + ": " + (userMsg.mes || "") + "\n";
        context += (lastMsg.name || "AI") + ": " + (lastMsg.mes || "");

        var turnTimeHint = turnTime ? "系统提供的当前游戏时间：" + turnTime : "（系统未提供游戏时间，请从正文中提取）";
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
            if (!raw.trim()) { toast("⚠ 记忆抽取返回为空。"); return; }
            var parsed = parseMemoryJson(raw);
            if (!parsed.narrative) { toast("⚠ 记忆解析失败：无narrative字段。"); return; }

            if (!lockedWorldId || !worlds[lockedWorldId]) return;

            // 存入 memories
            if (!worlds[lockedWorldId].memories) worlds[lockedWorldId].memories = [];
            worlds[lockedWorldId].memories.push({
                id: generateId(),
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

            // 上限保护
            var maxCount = globalApi.factUnitsMaxCount || 500;
            if (worlds[lockedWorldId].memories.length > maxCount) {
                worlds[lockedWorldId].memories = worlds[lockedWorldId].memories.slice(-maxCount);
            }

            // 分发到地理和NPC
            if (parsed.location) applyGeoUpdates(parsed.location, lockedWorldId);
            if (parsed.characters.length) applyNpcUpdates(parsed.characters, lockedWorldId);

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
                toast("⚠ 记忆抽取失败，" + (delay / 1000) + "秒后重试 (" + (retryCount + 1) + "/" + MAX_RETRIES + ")");
                setTimeout(function () { runDigestRequest(retryCount + 1); }, delay);
            } else {
                toast("✗ 记忆抽取最终失败: " + e.message);
            }
        });
    }

    function fetchDigestModelList() {
        var apiUrl = (globalApi.digestUrl || "").trim(), apiKey = (globalApi.digestKey || "").trim();
        if (!apiUrl) { toast("请先设置摘要API地址。"); return; }
        var btn = document.getElementById("tlg-fetch-digest-models"); if (btn) btn.disabled = true;
        toast("检测摘要模型…");
        fetch(buildEndpoint(apiUrl, "/models"), { headers: apiKey ? { Authorization: "Bearer " + apiKey } : {} })
        .then(function (res) { if (!res.ok) throw new Error("HTTP " + res.status); return res.json(); })
        .then(function (data) {
            var models = (data.data || data.models || []).map(function (m) { return typeof m === "string" ? m : (m.id || m.name || ""); }).filter(Boolean);
            globalApi.digestModelList = models; saveGlobalApi(); populateDigestModelSelect();
            toast("已识别 " + models.length + " 个摘要模型。");
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
    // 世界档案：地理树
    // ══════════════════════════════════════
    var geoCanvas = null, geoCtx = null;
    var geoCamX = 0, geoCamY = 0, geoCamZoom = 1;
    var geoIsPanning = false, geoPanStartX = 0, geoPanStartY = 0;
    var geoSelectedNode = null;

    function getGeoTree() {
        if (!currentWorldId || !worlds[currentWorldId]) return {};
        if (!worlds[currentWorldId].geoTree) worlds[currentWorldId].geoTree = {};
        return worlds[currentWorldId].geoTree;
    }

    // 把嵌套树扁平化为带坐标的节点列表
    function flattenGeoTree() {
        var tree = getGeoTree();
        var nodes = []; // { name, fullPath, desc, isCurrent, locked, depth, parentPath, children[] }

        function walk(subtree, parentPath, depth) {
            var keys = Object.keys(subtree);
            for (var i = 0; i < keys.length; i++) {
                var name = keys[i];
                var node = subtree[name];
                var fullPath = parentPath ? parentPath + "/" + name : name;
                var childKeys = Object.keys(node.children || {});
                nodes.push({
                    name: name,
                    fullPath: fullPath,
                    desc: node.desc || "",
                    isCurrent: node.isCurrent || false,
                    locked: node.locked || false,
                    depth: depth,
                    parentPath: parentPath,
                    childCount: childKeys.length
                });
                if (node.children) walk(node.children, fullPath, depth + 1);
            }
        }
        walk(tree, "", 0);
        return nodes;
    }

    // 分配坐标（横向排列同层级）
    function layoutGeoNodes(nodes) {
        // 按层级分组
        var byDepth = {};
        for (var i = 0; i < nodes.length; i++) {
            var d = nodes[i].depth;
            if (!byDepth[d]) byDepth[d] = [];
            byDepth[d].push(nodes[i]);
        }
        var H_GAP = 160, V_GAP = 110;
        var depths = Object.keys(byDepth).map(Number).sort(function(a,b){ return a-b; });
        for (var di = 0; di < depths.length; di++) {
            var row = byDepth[depths[di]];
            var totalWidth = row.length * H_GAP;
            var startX = -totalWidth / 2 + H_GAP / 2;
            for (var ri = 0; ri < row.length; ri++) {
                row[ri].x = startX + ri * H_GAP;
                row[ri].y = depths[di] * V_GAP + 60;
            }
        }
        return nodes;
    }

    function renderGeoCanvas() {
        if (!geoCanvas || !geoCtx) return;
        var dpr = window.devicePixelRatio || 1;
        var rect = geoCanvas.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        geoCanvas.width = rect.width * dpr;
        geoCanvas.height = rect.height * dpr;
        geoCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
        geoCtx.fillStyle = "#050508";
        geoCtx.fillRect(0, 0, rect.width, rect.height);

        var nodes = layoutGeoNodes(flattenGeoTree());
        if (!nodes.length) {
            geoCtx.fillStyle = "#5a5a6a";
            geoCtx.font = "13px sans-serif";
            geoCtx.textAlign = "center";
            geoCtx.fillText("暂无地理数据。点击「+ 添加地点」创建。", rect.width / 2, rect.height / 2);
            return;
        }

        geoCtx.save();
        geoCtx.translate(rect.width / 2 + geoCamX, geoCamY + 30);
        geoCtx.scale(geoCamZoom, geoCamZoom);

        var NODE_R = 18;

        // 建立 fullPath → 坐标 的索引
        var posMap = {};
        for (var i = 0; i < nodes.length; i++) posMap[nodes[i].fullPath] = nodes[i];

        // 画连线
        for (var j = 0; j < nodes.length; j++) {
            var n = nodes[j];
            if (!n.parentPath) continue;
            var parent = posMap[n.parentPath];
            if (!parent) continue;
            geoCtx.beginPath();
            geoCtx.moveTo(parent.x, parent.y + NODE_R);
            var cy = (parent.y + n.y) / 2;
            geoCtx.bezierCurveTo(parent.x, cy, n.x, cy, n.x, n.y - NODE_R);
            geoCtx.strokeStyle = "rgba(100,160,100,0.35)";
            geoCtx.lineWidth = 1.5;
            geoCtx.stroke();
        }

        // 画节点
        for (var k = 0; k < nodes.length; k++) {
            var nd = nodes[k];
            var isSelected = geoSelectedNode === nd.fullPath;

            geoCtx.beginPath();
            geoCtx.arc(nd.x, nd.y, NODE_R, 0, Math.PI * 2);

            if (nd.isCurrent) {
                geoCtx.fillStyle = "rgba(80,200,80,0.15)";
                geoCtx.strokeStyle = "#55cc55";
                geoCtx.lineWidth = 2;
                geoCtx.shadowColor = "rgba(80,200,80,0.5)";
                geoCtx.shadowBlur = 10;
            } else if (isSelected) {
                geoCtx.fillStyle = "rgba(180,180,200,0.12)";
                geoCtx.strokeStyle = "#a0a0c0";
                geoCtx.lineWidth = 2;
                geoCtx.shadowBlur = 0;
            } else {
                geoCtx.fillStyle = "rgba(120,160,120,0.06)";
                geoCtx.strokeStyle = "rgba(120,160,120,0.35)";
                geoCtx.lineWidth = 1;
                geoCtx.shadowBlur = 0;
            }
            geoCtx.fill();
            geoCtx.stroke();
            geoCtx.shadowBlur = 0;

            // 标签
            geoCtx.fillStyle = nd.isCurrent ? "#55cc55" : isSelected ? "#c0c0d0" : "rgba(160,180,160,0.7)";
            geoCtx.font = nd.isCurrent ? "bold 10px sans-serif" : "10px sans-serif";
            geoCtx.textAlign = "center";
            geoCtx.textBaseline = "top";
            var label = nd.name.length > 10 ? nd.name.slice(0, 9) + "…" : nd.name;
            geoCtx.fillText(label, nd.x, nd.y + NODE_R + 4);

            if (nd.isCurrent) {
                geoCtx.fillStyle = "rgba(80,200,80,0.6)";
                geoCtx.font = "9px sans-serif";
                geoCtx.fillText("📍", nd.x, nd.y - NODE_R - 12);
            }
        }

        geoCtx.restore();
    }

    function geoHitTest(clientX, clientY) {
        if (!geoCanvas) return null;
        var rect = geoCanvas.getBoundingClientRect();
        var mx = (clientX - rect.left - rect.width / 2 - geoCamX) / geoCamZoom;
        var my = (clientY - rect.top - geoCamY - 30) / geoCamZoom;
        var nodes = layoutGeoNodes(flattenGeoTree());
        var NODE_R = 18;
        for (var i = 0; i < nodes.length; i++) {
            var dx = mx - nodes[i].x, dy = my - nodes[i].y;
            if (dx * dx + dy * dy <= (NODE_R + 4) * (NODE_R + 4)) return nodes[i].fullPath;
        }
        return null;
    }

    function showGeoInfoPanel(fullPath) {
        var tree = getGeoTree();
        var parts = fullPath.split("/");
        var cur = tree;
        var node = null;
        for (var i = 0; i < parts.length; i++) {
            if (!cur[parts[i]]) return;
            node = cur[parts[i]];
            cur = node.children || {};
        }
        if (!node) return;
        geoSelectedNode = fullPath;
        renderGeoCanvas();
        // 简介 toast
        var info = "📍 " + fullPath;
        if (node.desc) info += "\n" + node.desc;
        if (node.isCurrent) info += "\n（主角当前位置）";
        toast(info, 4000);
    }

    function initGeoCanvas() {
        var c = document.getElementById("tlg-geo-canvas");
        if (!c || c === geoCanvas) { renderGeoCanvas(); return; }
        geoCanvas = c;
        geoCtx = c.getContext("2d");

        c.addEventListener("mousedown", function(e) {
            var hit = geoHitTest(e.clientX, e.clientY);
            if (hit) { showGeoInfoPanel(hit); return; }
            geoIsPanning = true;
            geoPanStartX = e.clientX - geoCamX;
            geoPanStartY = e.clientY - geoCamY;
            c.style.cursor = "grabbing";
        });
        c.addEventListener("mousemove", function(e) {
            if (!geoIsPanning) return;
            geoCamX = e.clientX - geoPanStartX;
            geoCamY = e.clientY - geoPanStartY;
            renderGeoCanvas();
        });
        c.addEventListener("mouseup", function() { geoIsPanning = false; c.style.cursor = "grab"; });
        c.addEventListener("mouseleave", function() { geoIsPanning = false; c.style.cursor = "grab"; });
        c.addEventListener("wheel", function(e) {
            e.preventDefault();
            geoCamZoom = Math.max(0.2, Math.min(5, geoCamZoom * (e.deltaY < 0 ? 1.1 : 0.9)));
            renderGeoCanvas();
        }, { passive: false });

        renderGeoCanvas();
    }

    function refreshGeoTree() { renderGeoCanvas(); }

    // 获取所有地理条目的 fullPath 列表（供选择上级用）
    function getAllGeoPaths() {
        var paths = [];
        var nodes = flattenGeoTree();
        for (var i = 0; i < nodes.length; i++) paths.push(nodes[i].fullPath);
        return paths;
    }

    function showAddGeoModal() {
        var existing = document.getElementById("tlg-geo-modal"); if (existing) existing.remove();
        var allPaths = getAllGeoPaths();
        var optionsHtml = '<option value="">（设为最高层级）</option>';
        for (var i = 0; i < allPaths.length; i++) {
            optionsHtml += '<option value="' + escHtml(allPaths[i]) + '">' + escHtml(allPaths[i]) + '</option>';
        }

        var backdrop = document.createElement("div"); backdrop.id = "tlg-geo-modal";
        backdrop.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100dvh;background:rgba(0,0,0,0.85);z-index:2147483647;display:flex;align-items:flex-start;justify-content:center;padding-top:12vh;";
        backdrop.innerHTML = '<div class="tlg-modal" style="background:#0a0a14;border:1px solid #2a2a3a;color:#c0c0c8;">' +
            '<div class="tlg-modal-title" style="color:#e8e8f0;">+ 添加地点</div>' +
            '<label class="tlg-label" style="color:#7a7a8a;">地点名称</label>' +
            '<input class="tlg-input" id="tlg-geo-name-input" placeholder="如：朝露客栈" style="background:#0e0e18;border-color:#2a2a3a;color:#c0c0c8;margin-bottom:10px" />' +
            '<label class="tlg-label" style="color:#7a7a8a;">简介（可选）</label>' +
            '<textarea class="tlg-textarea" id="tlg-geo-desc-input" placeholder="该地点的描述…" style="background:#0e0e18;border-color:#2a2a3a;color:#c0c0c8;min-height:50px;margin-bottom:10px"></textarea>' +
            '<label class="tlg-label" style="color:#7a7a8a;">上级地理（选择父级，或留空设为最高层级）</label>' +
            '<select class="tlg-select" id="tlg-geo-parent-select" style="background:#0e0e18;border-color:#2a2a3a;color:#c0c0c8;margin-bottom:10px;max-height:150px;">' + optionsHtml + '</select>' +
            '<div style="display:flex;gap:10px;align-items:center;margin-bottom:10px;">' +
            '<label style="font-size:11px;color:#7a7a8a;display:flex;align-items:center;gap:6px;"><input type="checkbox" id="tlg-geo-iscurrent" /> 标记为主角当前位置</label>' +
            '</div>' +
            '<div class="tlg-modal-actions"><button type="button" class="tlg-btn" id="tlg-geo-modal-cancel" style="border-color:#2a2a3a;color:#c0c0c8;">取消</button><button type="button" class="tlg-btn tlg-btn-primary" id="tlg-geo-modal-ok">确认添加</button></div>' +
            '</div>';
        document.body.appendChild(backdrop);

        backdrop.querySelector("#tlg-geo-modal-cancel").onclick = function() { backdrop.remove(); };
        backdrop.querySelector("#tlg-geo-modal-ok").onclick = function() {
            var name = backdrop.querySelector("#tlg-geo-name-input").value.trim();
            if (!name) { toast("名称不能为空。"); return; }
            var desc = backdrop.querySelector("#tlg-geo-desc-input").value.trim();
            var parentPath = backdrop.querySelector("#tlg-geo-parent-select").value;
            var isCurrent = backdrop.querySelector("#tlg-geo-iscurrent").checked;

            // 构建 path 数组
            var path;
            if (parentPath) {
                path = parentPath.split("/").concat([name]);
            } else {
                path = [name];
            }

            applyGeoUpdates({ path: path, desc: desc, is_current: isCurrent, moved_from: null }, currentWorldId);
            backdrop.remove();
            toast("地点已添加：" + path.join("/"));
            renderGeoCanvas();
        };
        backdrop.addEventListener("click", function(e) { if (e.target === backdrop) backdrop.remove(); });
        setTimeout(function() { backdrop.querySelector("#tlg-geo-name-input").focus(); }, 80);
    }

    // ══════════════════════════════════════
    // 世界档案：NPC 样本库
    // ══════════════════════════════════════
    function getNpcArchive() {
        if (!currentWorldId || !worlds[currentWorldId]) return {};
        if (!worlds[currentWorldId].npcArchive) worlds[currentWorldId].npcArchive = {};
        return worlds[currentWorldId].npcArchive;
    }

    function refreshNpcList() {
        var container = document.getElementById("tlg-npc-list"); if (!container) return;
        var archive = getNpcArchive();
        var filter = document.getElementById("tlg-npc-filter");
        var filterVal = filter ? filter.value : "all";
        var names = Object.keys(archive);
        if (!names.length) { container.innerHTML = '<div style="color:#5a5a6a;font-style:italic;padding:20px 0;">暂无样本数据。AI每回合自动提取，或手动添加。</div>'; return; }

        var filtered = names.filter(function(name) {
            if (filterVal === "all") return true;
            return (archive[name].tier || "normal") === filterVal;
        });

        container.innerHTML = filtered.map(function(name) {
            var npc = archive[name];
            var tier = npc.tier || "normal";
            var tierLabel = tier === "core" ? "🔴 核心" : tier === "important" ? "🟡 重要" : "⚪ 普通";
            var timelineCount = (npc.timeline || []).length;
            return '<div class="tlg-archive-card" style="margin-bottom:10px;">' +
                '<div style="display:flex;justify-content:space-between;align-items:center;">' +
                '<div class="tlg-archive-title">' + escHtml(name) + ' <span style="font-size:10px;color:#7a7a8a">(' + escHtml(npc.role || "未知") + ')</span></div>' +
                '<span style="font-size:10px;">' + tierLabel + '</span></div>' +
                '<div class="tlg-archive-meta">' + timelineCount + ' 条经历记录</div>' +
                (npc.appearance && npc.appearance.value ? '<div style="font-size:11px;color:#8a8a9a;margin-top:4px;">外貌：' + escHtml(npc.appearance.value.slice(0, 60)) + (npc.appearance.value.length > 60 ? "…" : "") + '</div>' : '') +
                '<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;">' +
                '<button type="button" class="tlg-btn tlg-npc-detail" data-name="' + escHtml(name) + '" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;font-size:11px;">详情</button>' +
                '<select class="tlg-select tlg-npc-tier" data-name="' + escHtml(name) + '" style="width:auto;padding:2px 6px;font-size:10px;"><option value="core"' + (tier === "core" ? " selected" : "") + '>核心</option><option value="important"' + (tier === "important" ? " selected" : "") + '>重要</option><option value="normal"' + (tier === "normal" ? " selected" : "") + '>普通</option></select>' +
                '<button type="button" class="tlg-btn tlg-btn-danger tlg-npc-del" data-name="' + escHtml(name) + '" style="margin-left:auto;writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;font-size:11px;">✕</button>' +
                '</div></div>';
        }).join("");

        container.querySelectorAll(".tlg-npc-detail").forEach(function(btn) {
            btn.onclick = function() { showNpcDetailModal(btn.dataset.name); };
        });
        container.querySelectorAll(".tlg-npc-tier").forEach(function(sel) {
            sel.onchange = function() {
                var arc = getNpcArchive();
                if (arc[sel.dataset.name]) { arc[sel.dataset.name].tier = sel.value; saveWorlds(); }
            };
        });
        container.querySelectorAll(".tlg-npc-del").forEach(function(btn) {
            btn.onclick = function() {
                if (!confirm("删除样本「" + btn.dataset.name + "」？")) return;
                var arc = getNpcArchive(); delete arc[btn.dataset.name]; saveWorlds(); refreshNpcList();
            };
        });
    }

    function showNpcDetailModal(name) {
        var archive = getNpcArchive(); var npc = archive[name]; if (!npc) return;
        var existing = document.getElementById("tlg-npc-modal"); if (existing) existing.remove();
        var backdrop = document.createElement("div"); backdrop.id = "tlg-npc-modal";
        backdrop.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100dvh;background:rgba(0,0,0,0.85);z-index:2147483647;display:flex;align-items:flex-start;justify-content:center;padding:16px;padding-top:6vh;box-sizing:border-box;overflow-y:auto;";
        var timelineHtml = (npc.timeline || []).map(function(t, idx) {
            return '<div style="border-left:2px solid #2a2a3a;padding-left:10px;margin-bottom:8px;">' +
                '<div style="font-size:10px;color:#5a5a6a;">' + (t.timestamp || "未知时间") + (t.auto ? ' · 自动' : ' · 手动') + '</div>' +
                '<div style="font-size:12px;color:#a0a0b0;">' + escHtml(t.event) + '</div>' +
                '</div>';
        }).join("") || '<div style="color:#5a5a6a;font-style:italic">暂无经历记录。</div>';

        backdrop.innerHTML = '<div class="tlg-modal" style="width:520px;max-height:80vh;overflow-y:auto;">' +
            '<div class="tlg-modal-title">' + escHtml(name) + ' <span style="font-size:12px;color:#7a7a8a">(' + escHtml(npc.role || "") + ')</span></div>' +
            '<label class="tlg-label">外貌' + (npc.appearance && npc.appearance.locked ? ' 🔒' : '') + '</label>' +
            '<textarea class="tlg-textarea" id="tlg-npc-appearance" style="min-height:50px">' + escHtml((npc.appearance && npc.appearance.value) || "") + '</textarea>' +
            '<div class="tlg-row" style="margin-top:4px"><label class="tlg-label" style="margin:0;font-size:10px">锁定（AI不可覆盖）</label><input type="checkbox" id="tlg-npc-app-lock" ' + (npc.appearance && npc.appearance.locked ? "checked" : "") + ' /></div>' +
            '<label class="tlg-label" style="margin-top:10px">年龄</label>' +
            '<input class="tlg-input" id="tlg-npc-age" value="' + escHtml((npc.age && npc.age.value) || "") + '" style="margin-bottom:8px" />' +
            '<label class="tlg-label">身份/职业</label>' +
            '<input class="tlg-input" id="tlg-npc-role" value="' + escHtml(npc.role || "") + '" style="margin-bottom:10px" />' +
            '<div style="font-size:12px;font-weight:600;color:#e8e8f0;margin-bottom:6px;">经历时间线（' + (npc.timeline || []).length + '条）</div>' +
            '<div style="max-height:200px;overflow-y:auto;margin-bottom:10px;">' + timelineHtml + '</div>' +
            '<label class="tlg-label">手动添加经历</label>' +
            '<div class="tlg-row"><input class="tlg-input" id="tlg-npc-new-event" placeholder="发生了什么" style="flex:1" /><input class="tlg-input" id="tlg-npc-new-time" placeholder="时间" style="width:80px" /><button type="button" class="tlg-btn tlg-btn-primary" id="tlg-npc-add-event" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">+</button></div>' +
            '<div class="tlg-modal-actions" style="margin-top:12px"><button type="button" class="tlg-btn" id="tlg-npc-modal-close">关闭</button><button type="button" class="tlg-btn tlg-btn-primary" id="tlg-npc-modal-save">保存</button></div></div>';
        document.body.appendChild(backdrop);

        backdrop.querySelector("#tlg-npc-modal-close").onclick = function() { backdrop.remove(); };
        backdrop.querySelector("#tlg-npc-modal-save").onclick = function() {
            npc.appearance = { value: backdrop.querySelector("#tlg-npc-appearance").value, locked: backdrop.querySelector("#tlg-npc-app-lock").checked };
            npc.age = { value: backdrop.querySelector("#tlg-npc-age").value, locked: false };
            npc.role = backdrop.querySelector("#tlg-npc-role").value.trim();
            saveWorlds(); backdrop.remove(); refreshNpcList(); toast("样本已保存。");
        };
        backdrop.querySelector("#tlg-npc-add-event").onclick = function() {
            var evt = backdrop.querySelector("#tlg-npc-new-event").value.trim();
            if (!evt) return;
            var time = backdrop.querySelector("#tlg-npc-new-time").value.trim();
            if (!npc.timeline) npc.timeline = [];
            npc.timeline.push({ event: evt, timestamp: time || getTurnTime() || "", auto: false, createdAt: Date.now() });
            saveWorlds(); backdrop.remove(); showNpcDetailModal(name);
        };
        backdrop.addEventListener("click", function(e) { if (e.target === backdrop) backdrop.remove(); });
    }

    function showAddNpcModal() {
        var name = prompt("角色名称：");
        if (!name || !name.trim()) return;
        name = name.trim();
        var archive = getNpcArchive();
        if (archive[name]) { toast("该角色已存在。"); refreshNpcList(); return; }
        archive[name] = { role: "", appearance: { value: "", locked: false }, age: { value: "", locked: false }, timeline: [], tier: "normal", custom: [] };
        saveWorlds(); refreshNpcList(); toast("已添加：" + name);
    }

    // ══════════════════════════════════════
    // 世界档案：物品追踪
    // ══════════════════════════════════════
    function refreshItemsList() {
        var container = document.getElementById("tlg-items-list"); if (!container) return;
        var memories = state.memories || [];
        // 从所有 memories 中提取物品变动
        var itemMap = {};
        for (var i = 0; i < memories.length; i++) {
            var items = memories[i].items || [];
            for (var j = 0; j < items.length; j++) {
                var item = items[j];
                if (!item.name) continue;
                if (!itemMap[item.name]) itemMap[item.name] = [];
                itemMap[item.name].push({
                    change: item.change || "",
                    owner: item.owner || "",
                    state: item.state || "",
                    turnIdx: memories[i].turnIdx,
                    timestamp: memories[i].timestamp
                });
            }
        }
        var names = Object.keys(itemMap);
        if (!names.length) { container.innerHTML = '<div style="color:#5a5a6a;font-style:italic">暂无物品记录。AI每回合自动提取。</div>'; return; }

        container.innerHTML = names.map(function(name) {
            var history = itemMap[name];
            var latest = history[history.length - 1];
            return '<div class="tlg-archive-card" style="margin-bottom:8px;">' +
                '<div class="tlg-archive-title">' + escHtml(name) + '</div>' +
                '<div class="tlg-archive-meta">持有者：' + escHtml(latest.owner || "未知") + ' · 状态：' + escHtml(latest.state || "未知") + ' · ' + history.length + '条变动记录</div>' +
                '</div>';
        }).join("");
    }

    function fetchModelList() {
        var apiUrl = (globalApi.apiUrl || "").trim(), apiKey = (globalApi.apiKey || "").trim();
        if (!apiUrl) { toast("请先设置 API 地址。"); return; }
        var btn = document.getElementById("tlg-fetch-models"); if (btn) btn.disabled = true; toast("正在检测可用模型…");
        fetch(buildEndpoint(apiUrl, "/models"), { headers: apiKey ? { Authorization: "Bearer " + apiKey } : {} })
        .then(function (res) { if (!res.ok) throw new Error("HTTP " + res.status); return res.json(); })
        .then(function (data) {
            var models = (data.data || data.models || []).map(function (m) { return typeof m === "string" ? m : (m.id || m.name || ""); }).filter(Boolean);
            globalApi.modelList = models; saveGlobalApi(); populateModelSelect(); toast("已识别 " + models.length + " 个核心模型。");
        }).catch(function (e) { toast("通信失败: " + e.message); }).then(function () { if (btn) btn.disabled = false; });
    }
    function populateModelSelect() {
        var sel = document.getElementById("tlg-model-select"); if (!sel) return;
        sel.innerHTML = '<option value="">-- 选择演算核心 --</option>' + (globalApi.modelList || []).map(function (m) { return '<option value="' + escHtml(m) + '"' + (m === globalApi.model ? " selected" : "") + ">" + escHtml(m) + "</option>"; }).join("");
    }
    function createNewWorldManual() {
        var chatId = getCurrentChatId();
        var name = prompt("新世界名称：", chatId || ("世界 " + (Object.keys(worlds).length + 1)));
        if (name === null) return;
        name = name.trim() || ("世界 " + (Object.keys(worlds).length + 1));
        var wid = generateId(); var rootId = generateId();
        worlds[wid] = {
            id: wid, name: name, chatId: chatId,
            nodes: [{ id: rootId, name: "起源点", brief: "时间线起源。", parentId: null, msgIdx: 0, statData: null, timestamp: Date.now(), children: [] }],
            summaries: [], currentNodeId: rootId, pinnedPaths: [],
            createdAt: Date.now(), updatedAt: Date.now()
        };
        currentWorldId = wid; setLinkedWorldId(wid);
        state.nodes = worlds[wid].nodes; state.summaries = []; state.currentNodeId = rootId; state.selectedNodeId = null;
        saveWorlds(); toast("✦ 新世界已创建: " + name); refreshWorlds(); renderCanvas(); refreshArchive();
    }
    function fetchVectorModelList() {
        var apiUrl = (globalApi.vectorUrl || "").trim(), apiKey = (globalApi.vectorKey || "").trim();
        if (!apiUrl) { toast("请先设置向量 API 地址。"); return; }
        var btn = document.getElementById("tlg-fetch-vec-models"); if (btn) btn.disabled = true; toast("检测向量模型…");
        fetch(buildEndpoint(apiUrl, "/models"), { headers: apiKey ? { Authorization: "Bearer " + apiKey } : {} })
        .then(function (res) { if (!res.ok) throw new Error("HTTP " + res.status); return res.json(); })
        .then(function (data) {
            var models = (data.data || data.models || []).map(function (m) { return typeof m === "string" ? m : (m.id || m.name || ""); }).filter(Boolean);
            globalApi.vectorModelList = models; saveGlobalApi(); populateVectorModelSelect(); toast("已识别 " + models.length + " 个向量模型。");
        }).catch(function (e) { toast("通信失败: " + e.message); }).then(function () { if (btn) btn.disabled = false; });
    }
    function fetchRerankModelList() {
        var apiUrl = (globalApi.rerankUrl || "").trim(), apiKey = (globalApi.rerankKey || "").trim();
        if (!apiUrl) { toast("请先设置重排 API 地址。"); return; }
        var btn = document.getElementById("tlg-fetch-rerank-models"); if (btn) btn.disabled = true; toast("检测重排模型…");
        fetch(buildEndpoint(apiUrl, "/models"), { headers: apiKey ? { Authorization: "Bearer " + apiKey } : {} })
        .then(function (res) { if (!res.ok) throw new Error("HTTP " + res.status); return res.json(); })
        .then(function (data) {
            var models = (data.data || data.models || []).map(function (m) { return typeof m === "string" ? m : (m.id || m.name || ""); }).filter(Boolean);
            globalApi.rerankModelList = models; saveGlobalApi(); populateRerankModelSelect(); toast("已识别 " + models.length + " 个重排模型。");
        }).catch(function (e) { toast("通信失败: " + e.message); }).then(function () { if (btn) btn.disabled = false; });
    }
    function populateRerankModelSelect() {
        var sel = document.getElementById("tlg-rerank-model-select"); if (!sel) return;
        sel.innerHTML = '<option value="">-- 选择重排核心 --</option>' + (globalApi.rerankModelList || []).map(function (m) { return '<option value="' + escHtml(m) + '"' + (m === globalApi.rerankModel ? " selected" : "") + ">" + escHtml(m) + "</option>"; }).join("");
    }
    function populateVectorModelSelect() {
        var sel = document.getElementById("tlg-vec-model-select"); if (!sel) return;
        sel.innerHTML = '<option value="">-- 选择辅助核心 --</option>' + (globalApi.vectorModelList || []).map(function (m) { return '<option value="' + escHtml(m) + '"' + (m === globalApi.vectorModel ? " selected" : "") + ">" + escHtml(m) + "</option>"; }).join("");
    }

    function refreshWorlds() {
        var container = document.getElementById("tlg-worlds-list"); if (!container) return;
        var chatId = getCurrentChatId(), ids = Object.keys(worlds).sort(function (a, b) { return (worlds[b].updatedAt || 0) - (worlds[a].updatedAt || 0); });
        if (!ids.length) { container.innerHTML = '<div style="color:#5a5a6a;padding:40px 20px;text-align:center;font-style:italic;">万流归虚——尚无被观测的世界。</div>'; return; }
        container.innerHTML = ids.map(function (wid) {
            var w = worlds[wid], isCurrent = wid === currentWorldId, isLinked = w.chatId === chatId && chatId;
            return '<div style="background:#050508;border:1px solid ' + (isCurrent ? "#ffffff" : "#2a2a3a") + ';border-radius:4px;padding:12px;margin-bottom:10px;">' +
                '<div style="display:flex;justify-content:space-between;align-items:center;">' +
                '<div style="font-size:14px;font-weight:600;color:#ffffff;">' + escHtml(w.name) + (isCurrent ? ' <span style="font-size:11px;color:#7a7a8a">(当前观测焦点)</span>' : "") + '</div>' +
                '<button type="button" class="tlg-btn tlg-btn-danger tlg-worlds-del" data-wid="' + wid + '" style="font-size:11px;padding:4px 8px;writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">✕</button></div>' +
                '<div style="font-size:11px;color:#7a7a8a;margin-top:4px;">刻度: ' + (w.nodes ? w.nodes.length : 0) + ' | 档案: ' + (w.summaries ? w.summaries.length : 0) + '</div>' +
                '<div style="font-size:11px;color:#7a7a8a;">标识: ' + escHtml(w.chatId || "未关联") + '</div>' +
                '<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;">' +
                (!isCurrent && isLinked ? '<button type="button" class="tlg-btn tlg-btn-primary tlg-worlds-switch" data-wid="' + wid + '" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">聚焦于此</button>' : "") +
                (!isLinked && !isCurrent ? '<button type="button" class="tlg-btn tlg-worlds-link" data-wid="' + wid + '" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">连接当前世界</button>' : "") +
                '<button type="button" class="tlg-btn tlg-worlds-rename" data-wid="' + wid + '" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">重命名</button>' +
                '<button type="button" class="tlg-btn tlg-worlds-export" data-wid="' + wid + '" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">提取源数据</button>' +
                '</div></div>';
        }).join("");
        container.querySelectorAll(".tlg-worlds-switch").forEach(function (btn) { btn.addEventListener("click", function () { var wid = btn.dataset.wid; currentWorldId = wid; setLinkedWorldId(wid); var w = worlds[wid]; state.nodes = w.nodes || []; state.summaries = w.summaries || []; state.currentNodeId = w.currentNodeId || (state.nodes.length ? state.nodes[0].id : null); state.selectedNodeId = null; toast("观测焦点已转移: " + w.name); refreshWorlds(); renderCanvas(); refreshArchive(); }); });
        container.querySelectorAll(".tlg-worlds-link").forEach(function (btn) { btn.addEventListener("click", function () { var wid = btn.dataset.wid; worlds[wid].chatId = chatId; currentWorldId = wid; setLinkedWorldId(wid); var w = worlds[wid]; state.nodes = w.nodes || []; state.summaries = w.summaries || []; state.currentNodeId = w.currentNodeId || (state.nodes.length ? state.nodes[0].id : null); saveWorlds(); toast("连接建立并聚焦: " + w.name); refreshWorlds(); renderCanvas(); refreshArchive(); }); });
        container.querySelectorAll(".tlg-worlds-rename").forEach(function (btn) { btn.addEventListener("click", function () { var wid = btn.dataset.wid; var newName = prompt("覆盖标识符:", worlds[wid].name || ""); if (newName === null) return; worlds[wid].name = newName.trim() || worlds[wid].name; saveWorlds(); refreshWorlds(); toast("标识符已覆盖。"); }); });
        container.querySelectorAll(".tlg-worlds-export").forEach(function (btn) { btn.addEventListener("click", function () { var wid = btn.dataset.wid; var w = worlds[wid]; var blob = new Blob([JSON.stringify(w, null, 2)], { type: "application/json" }); var url = URL.createObjectURL(blob); var a = document.createElement("a"); a.href = url; a.download = (w.name || "world") + ".json"; a.click(); URL.revokeObjectURL(url); toast("源数据提取成功: " + w.name); }); });
        container.querySelectorAll(".tlg-worlds-del").forEach(function (btn) { btn.addEventListener("click", function () { var wid = btn.dataset.wid; if (wid === currentWorldId) { toast("无法毁灭当前正聚焦的世界。"); return; } if (!confirm("警告：确认引发「" + (worlds[wid] ? worlds[wid].name : "") + "」的坍缩？所有观测记录将永久湮灭。")) return; delete worlds[wid]; saveWorlds(); refreshWorlds(); toast("世界已坍缩。"); }); });
    }

    function importWorld() {
        var input = document.createElement("input"); input.type = "file"; input.accept = ".json";
        input.onchange = function () {
            var file = input.files[0]; if (!file) return; var reader = new FileReader();
            reader.onload = function () {
                try {
                    var data = JSON.parse(reader.result);
                    if (!data.nodes || !data.nodes.length) { toast("解析失败，非法的世界源数据。"); return; }
                    var wid = data.id || generateId(); if (worlds[wid]) wid = generateId();
                    data.id = wid; if (!data.name) data.name = file.name.replace(/\.json$/, "");
                    if (!data.createdAt) data.createdAt = Date.now(); data.updatedAt = Date.now();
                    if (!data.pinnedPaths) data.pinnedPaths = [];
                    worlds[wid] = data; saveWorlds(); refreshWorlds(); toast("连接建立: " + data.name);
                } catch (e) { toast("维度侵入失败: " + e.message); }
            }; reader.readAsText(file);
        }; input.click();
    }

    function ensurePanelBuilt() {
        if (document.getElementById("tlg-panel")) return;
        var s = globalApi; var panel = document.createElement("div"); panel.id = "tlg-panel";
        panel.style.cssText = "display:none;position:fixed;top:0;left:0;width:100%;height:100%;height:100dvh;background:#000000;color:#e8e8f0;z-index:2147483647;flex-direction:column;font-family:-apple-system,sans-serif;overflow:hidden;";

        var summaryTabHtml =
            '<div class="tlg-view" data-view="summary"><div class="tlg-scroll-panel">' +
            '<div class="tlg-section"><div class="tlg-section-title">自动化切片协议</div>' +
            '<div class="tlg-row"><span class="tlg-label" style="margin:0">自律模式（按步数）</span><div class="tlg-toggle ' + (s.autoMode ? "on" : "") + '" id="tlg-auto-toggle"></div></div>' +
            '<div class="tlg-row"><label class="tlg-label" style="margin:0;flex:1">每 <input class="tlg-input" id="tlg-auto-interval" type="number" min="1" value="' + (s.autoInterval || 10) + '" style="width:60px;display:inline-block;padding:4px 6px;margin:0 4px;font-size:14px"> 步自动触发</label></div>' +
            '<div class="tlg-row"><span class="tlg-label" style="margin:0">跳转前自动总结</span><div class="tlg-toggle ' + (s.jumpSummary !== false ? "on" : "") + '" id="tlg-jump-summary-toggle"></div></div>' +
            '<div class="tlg-row"><label class="tlg-label" style="margin:0;flex:1">跳跃后维持 <input class="tlg-input" id="tlg-last-n" type="number" min="1" value="' + (s.lastNMessages || 5) + '" style="width:60px;display:inline-block;padding:4px 6px;margin:0 4px;font-size:14px"> 条</label></div>' +
            '<div class="tlg-row"><label class="tlg-label" style="margin:0;flex:1">手动提取最近 <input class="tlg-input" id="tlg-manual-count" type="number" min="1" value="' + (s.manualCount || 20) + '" style="width:60px;display:inline-block;padding:4px 6px;margin:0 4px;font-size:14px"> 步</label></div>' +
            '<button type="button" class="tlg-btn tlg-btn-primary" id="tlg-summary-run" style="margin-top:10px;writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">▶ 立即执行切片</button></div>' +
            '<div class="tlg-section"><div class="tlg-section-title">自动浓缩</div>' +
            '<div class="tlg-row"><span class="tlg-label" style="margin:0">档案满时自动浓缩</span><div class="tlg-toggle ' + (s.autoCompress ? "on" : "") + '" id="tlg-auto-compress-toggle"></div></div>' +
            '<div class="tlg-row"><label class="tlg-label" style="margin:0;flex:1">档案上限 <input class="tlg-input" id="tlg-summary-max" type="number" min="10" value="' + (s.summaryMaxCount || 100) + '" style="width:60px;display:inline-block;padding:4px 6px;margin:0 4px;font-size:14px"> 条 · 每批浓缩 <input class="tlg-input" id="tlg-compress-batch" type="number" min="2" value="' + (s.compressBatchSize || 10) + '" style="width:60px;display:inline-block;padding:4px 6px;margin:0 4px;font-size:14px"> 条</label></div></div>' +
            '<div class="tlg-section"><div class="tlg-section-title">记录仪指令</div>' +
            '<label class="tlg-label">总结提示词（{{context}}）</label><textarea class="tlg-textarea" id="tlg-summary-prompt" style="min-height:100px">' + escHtml(s.summaryPrompt || "") + '</textarea></div>' +
            '<div class="tlg-section"><div class="tlg-section-title">最新档案</div><div id="tlg-summary-list"></div></div>' +
            '</div></div>';

        var vaultTabHtml =
            '<div class="tlg-view" data-view="vault"><div class="tlg-scroll-panel"><div id="tlg-vault-container"></div></div></div>';

        panel.innerHTML =
            '<div id="tlg-tabs">' +
            '<div class="tlg-tab active" data-tab="tree">命运分支线</div>' +
            '<div class="tlg-tab" data-tab="archive">观测坐标</div>' +
            '<div class="tlg-tab" data-tab="summary">因果档案</div>' +
            '<div class="tlg-tab" data-tab="vault">观测档案库</div>' +
            '<div class="tlg-tab" data-tab="worldarchive" style="padding:0 18px;height:100%;display:flex;align-items:center;cursor:pointer;font-size:12px;color:#6a6a78;border-bottom:2px solid transparent;white-space:nowrap;">世界档案</div>' +     
            '<div class="tlg-tab" data-tab="worlds">诸世界</div>' +
            '<div class="tlg-tab" data-tab="engine">引擎核心</div>' +
            '<div id="tlg-close">✕</div></div><div id="tlg-body">' +
            // 命运分支线
            '<div class="tlg-view active" id="tlg-view-tree" data-view="tree"><div id="tlg-canvas-wrap"><canvas id="tlg-tree-canvas"></canvas>' +
            '<div id="tlg-canvas-toolbar" style="position:absolute;top:10px;left:10px;right:10px;display:flex;flex-direction:row;flex-wrap:wrap;gap:8px;z-index:2;">' +
            '<button type="button" class="tlg-btn" id="tlg-canvas-anchor" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">⚓ 凝固当前状态</button>' +
            '<button type="button" class="tlg-btn" id="tlg-canvas-center-cur" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">◎ 定位当前</button>' +
            '<button type="button" class="tlg-btn" id="tlg-canvas-reset-view" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">视角归位</button>' +
            '</div></div>' +
            '<div id="tlg-brief-panel"><div class="tlg-brief-header"><span>因果节点</span><button type="button" class="tlg-btn" id="tlg-brief-close" style="padding:2px 8px;writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">✕</button></div><div class="tlg-brief-body"></div><div class="tlg-brief-footer"></div></div></div>' +
            // 观测坐标
            '<div class="tlg-view" data-view="archive"><div class="tlg-scroll-panel">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;gap:8px;flex-wrap:wrap">' +
            '<div style="font-size:15px;font-weight:600;color:#ffffff;">全部锚定坐标</div>' +
            '<button type="button" class="tlg-btn tlg-btn-primary" id="tlg-archive-new" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">⚓ 建立新坐标</button></div>' +
            '<div style="font-size:12px;color:#7a7a8a;margin-bottom:8px;">常用路径</div>' +
            '<div id="tlg-pinned-paths" style="margin-bottom:12px;"></div>' +
            '<div style="font-size:12px;color:#7a7a8a;margin-bottom:8px;border-top:1px solid #1e1e2a;padding-top:10px;">全部节点</div>' +
            '<div id="tlg-archive-list"></div></div></div>' +
            // 因果档案
            summaryTabHtml +
            // 观测档案库
            vaultTabHtml +
            // ═══ 世界档案 ═══
            '<div class="tlg-view" data-view="worldarchive"><div class="tlg-scroll-panel" style="display:flex;flex-direction:column;height:100%;overflow:hidden;">' +
            // 子标签
            '<div style="display:flex;border-bottom:1px solid #1a1a28;flex-shrink:0;">' +
            '<div class="tlg-subtab active" data-subtab="geo" style="padding:8px 16px;cursor:pointer;font-size:12px;color:#6a6a78;border-bottom:2px solid transparent;">地理</div>' +
            '<div class="tlg-subtab" data-subtab="npc" style="padding:8px 16px;cursor:pointer;font-size:12px;color:#6a6a78;border-bottom:2px solid transparent;">样本库</div>' +
            '<div class="tlg-subtab" data-subtab="items" style="padding:8px 16px;cursor:pointer;font-size:12px;color:#6a6a78;border-bottom:2px solid transparent;">物品</div>' +
            '</div>' +
            // 地理子面板
            '<div class="tlg-subpanel active" data-subpanel="geo" style="flex:1;overflow:hidden;position:relative;">' +
            '<canvas id="tlg-geo-canvas" style="width:100%;height:100%;cursor:grab;"></canvas>' +
            '<div style="position:absolute;top:10px;left:10px;display:flex;gap:6px;z-index:2;">' +
            '<button type="button" class="tlg-btn" id="tlg-geo-add" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">+ 添加地点</button>' +
            '<button type="button" class="tlg-btn" id="tlg-geo-reset" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">⊙ 归位</button>' +
            '</div>' +
            '</div>' +
            // NPC子面板
            '<div class="tlg-subpanel" data-subpanel="npc" style="flex:1;overflow-y:auto;padding:14px;display:none;">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">' +
            '<div style="font-size:13px;font-weight:600;color:#e8e8f0;">样本库</div>' +
            '<div style="display:flex;gap:6px;">' +
            '<select id="tlg-npc-filter" class="tlg-select" style="width:auto;padding:4px 8px;font-size:11px;"><option value="all">全部</option><option value="core">核心</option><option value="important">重要</option><option value="normal">普通</option></select>' +
            '<button type="button" class="tlg-btn" id="tlg-npc-add" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">+ 新建</button>' +
            '</div></div>' +
            '<div id="tlg-npc-list"></div>' +
            '</div>' +
            // 物品子面板
            '<div class="tlg-subpanel" data-subpanel="items" style="flex:1;overflow-y:auto;padding:14px;display:none;">' +
            '<div style="font-size:13px;font-weight:600;color:#e8e8f0;margin-bottom:12px;">物品追踪</div>' +
            '<div id="tlg-items-list"></div>' +
            '</div>' +
            '</div></div>' +
            // 诸世界
            '<div class="tlg-view" data-view="worlds"><div class="tlg-scroll-panel">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;gap:8px;flex-wrap:wrap;">' +
            '<div style="font-size:15px;font-weight:600;color:#ffffff;">维度图谱</div>' +
            '<button type="button" class="tlg-btn tlg-btn-primary" id="tlg-worlds-import" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">凝望异世界</button>' +
            '<button type="button" class="tlg-btn" id="tlg-worlds-create" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">✦ 创建新世界</button></div>' +
            '<div style="font-size:12px;color:#7a7a8a;margin-bottom:12px;">当前实体连接: ' + escHtml(getCurrentChatId() || "未知") + (currentWorldId ? " → " + escHtml((worlds[currentWorldId] || {}).name || "") : " (未建立)") + '</div>' +
            '<div id="tlg-worlds-list"></div></div></div>' +
            // 引擎核心
            '<div class="tlg-view" data-view="engine"><div class="tlg-scroll-panel">' +
            // ─── 主解析引擎 ───
            '<div class="tlg-section"><div class="tlg-section-title">主解析引擎（总结 / 路径 / 压缩）</div>' +
            '<label class="tlg-label">连接端点</label><div class="tlg-row"><input class="tlg-input" id="tlg-api-url" placeholder="https://api.openai.com" value="' + escHtml(s.apiUrl || "") + '" /><button type="button" class="tlg-btn" id="tlg-test-api" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">探针</button></div>' +
            '<label class="tlg-label">认证密钥</label><input class="tlg-input" id="tlg-api-key" type="password" value="' + escHtml(s.apiKey || "") + '" style="margin-bottom:10px" />' +
            '<label class="tlg-label">演算核心</label><div class="tlg-row"><select class="tlg-select" id="tlg-model-select" style="flex:1"></select><button type="button" class="tlg-btn" id="tlg-fetch-models" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">检索</button></div>' +
            '<label class="tlg-label">或强制指定</label><input class="tlg-input" id="tlg-model-manual" value="' + escHtml(s.model || "") + '" style="margin-bottom:10px" />' +
            '<label class="tlg-label">总结提示词（{{context}} = 对话内容，注入AI+玩家可见）</label><textarea class="tlg-textarea" id="tlg-engine-summary-prompt" style="min-height:140px;font-size:11px;">' + escHtml(s.summaryPrompt || "") + '</textarea>' +
            '<label class="tlg-label">浓缩指令（{{context}} = 多条档案内容）</label><textarea class="tlg-textarea" id="tlg-compress-prompt" style="min-height:80px;font-size:11px;">' + escHtml(s.compressPrompt || "") + '</textarea>' +
            '<label class="tlg-label">路径摘要指令（{{context}} = 路径信息）</label><textarea class="tlg-textarea" id="tlg-path-summary-prompt" style="min-height:80px;font-size:11px;">' + escHtml(s.pathSummaryPrompt || "") + '</textarea></div>' +
            // ─── 摘要引擎 ───
            '<div class="tlg-section"><div class="tlg-section-title">摘要引擎（每回合事实抽取 → 向量化）</div>' +
            '<div style="font-size:11px;color:#7a7a8a;margin-bottom:8px;">每回合AI生成后异步调用，输出结构化事实单元 [T][L][E][I][A][C]，供向量检索命中。与总结并行独立，互不替代。[E]字段供样本库，[L]字段供地理库。</div>' +
            '<div class="tlg-row"><span class="tlg-label" style="margin:0">自动模式（每回合触发）</span><div class="tlg-toggle ' + (s.digestAutoMode !== false ? "on" : "") + '" id="tlg-digest-auto-toggle"></div></div>' +
            '<label class="tlg-label">摘要端点</label><div class="tlg-row"><input class="tlg-input" id="tlg-digest-url" value="' + escHtml(s.digestUrl || "") + '" /><button type="button" class="tlg-btn" id="tlg-test-digest-api" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">探针</button></div>' +
            '<label class="tlg-label">摘要密钥</label><input class="tlg-input" id="tlg-digest-key" type="password" value="' + escHtml(s.digestKey || "") + '" style="margin-bottom:8px" />' +
            '<label class="tlg-label">摘要核心</label><div class="tlg-row"><select class="tlg-select" id="tlg-digest-model-select" style="flex:1"></select><button type="button" class="tlg-btn" id="tlg-fetch-digest-models" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">检索</button></div>' +
            '<label class="tlg-label">或强制指定</label><input class="tlg-input" id="tlg-digest-model" value="' + escHtml(s.digestModel || "") + '" style="margin-bottom:8px" />' +
            '<label class="tlg-label">事实单元上限（超出删最旧，建议500~2000）</label><input class="tlg-input" id="tlg-fact-units-max" type="number" min="50" max="5000" value="' + (s.factUnitsMaxCount || 500) + '" style="width:100px;margin-bottom:10px" />' +
            '<label class="tlg-label">摘要提示词（{{turn_time}} = 游戏内时间，{{context}} = 本回合正文）</label><textarea class="tlg-textarea" id="tlg-digest-prompt" style="min-height:200px;font-size:11px;">' + escHtml(s.digestPrompt || "") + '</textarea>' +
            '<label class="tlg-label">检索构造器提示词（{{context}} = 最近对话，生成前调用，输出关键词供向量检索）</label><textarea class="tlg-textarea" id="tlg-query-refine-prompt" style="min-height:140px;font-size:11px;">' + escHtml(s.queryRefinePrompt || "") + '</textarea></div>' +
            // ─── 联想网络（向量） ───
            '<div class="tlg-section"><div class="tlg-section-title">联想网络（向量嵌入 / 检索）</div>' +
            '<label class="tlg-label">向量端点</label><div class="tlg-row"><input class="tlg-input" id="tlg-vec-url" value="' + escHtml(s.vectorUrl || "") + '" /><button type="button" class="tlg-btn" id="tlg-test-vec-api" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">探针</button></div>' +
            '<label class="tlg-label">向量密钥</label><input class="tlg-input" id="tlg-vec-key" type="password" value="' + escHtml(s.vectorKey || "") + '" style="margin-bottom:10px" />' +
            '<label class="tlg-label">降维核心</label><div class="tlg-row"><select class="tlg-select" id="tlg-vec-model-select" style="flex:1"></select><button type="button" class="tlg-btn" id="tlg-fetch-vec-models" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">检索</button></div>' +
            '<label class="tlg-label">或强制指定</label><input class="tlg-input" id="tlg-vec-model" value="' + escHtml(s.vectorModel || "") + '" style="margin-bottom:8px" />' +
            '<label class="tlg-label">注入模板（{{context}} = 最终检索命中内容）</label><textarea class="tlg-textarea" id="tlg-vec-prompt" style="min-height:80px;font-size:11px;">' + escHtml(s.vectorPrompt || "") + '</textarea></div>' +
            // ─── 召回参数 ───
            '<div class="tlg-section"><div class="tlg-section-title">召回参数</div>' +
            '<div style="font-size:11px;color:#7a7a8a;margin-bottom:10px;">控制 向量检索 → 重排 → 注入 完整流程。</div>' +
            '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px 14px;">' +
            '<div><label class="tlg-label">查询窗口（最近N条消息生成查询向量）</label><input class="tlg-input" id="tlg-vec-query-window" type="number" min="1" max="20" value="' + (s.vectorQueryWindow || 5) + '" style="width:70px" /></div>' +
            '<div><label class="tlg-label">档案截断（嵌入时每条取前N字符）</label><input class="tlg-input" id="tlg-vec-chunk-len" type="number" min="100" max="2000" step="50" value="' + (s.vectorChunkLen || 600) + '" style="width:80px" /></div>' +
            '<div><label class="tlg-label">初筛召回 Top-K（向量排序后保留候选数）</label><input class="tlg-input" id="tlg-vec-topk" type="number" min="1" max="50" value="' + (s.vectorTopK || 8) + '" style="width:70px" /></div>' +
            '<div><label class="tlg-label">相似度阈值（低于此值丢弃，0=全保留）</label><input class="tlg-input" id="tlg-vec-threshold" type="number" min="0" max="1" step="0.05" value="' + (s.vectorThreshold || 0) + '" style="width:80px" /></div>' +
            '<div><label class="tlg-label">最终注入 Top-N（重排后取前N条）</label><input class="tlg-input" id="tlg-rerank-topn" type="number" min="1" max="20" value="' + (s.rerankTopN || 3) + '" style="width:70px" /></div>' +
            '<div><label class="tlg-label">重排相关度阈值（0=不过滤）</label><input class="tlg-input" id="tlg-rerank-threshold" type="number" min="0" max="1" step="0.05" value="' + (s.rerankThreshold || 0) + '" style="width:80px" /></div>' +
            '<div><label class="tlg-label">注入深度（0=最底部贴近最新消息）</label><input class="tlg-input" id="tlg-vec-inject-depth" type="number" min="0" max="50" value="' + (s.vectorInjectDepth || 0) + '" style="width:70px" /></div>' +
            '<div><label class="tlg-label">最大注入字符（防撑爆上下文）</label><input class="tlg-input" id="tlg-vec-max-chars" type="number" min="200" max="20000" step="100" value="' + (s.vectorMaxChars || 4000) + '" style="width:80px" /></div>' +
            '</div></div>' +
            // ─── 重排引擎 ───
            '<div class="tlg-section"><div class="tlg-section-title">重排引擎（Rerank，可选）</div>' +
            '<div style="font-size:11px;color:#7a7a8a;margin-bottom:8px;">对向量初筛结果进行语义精排。留空则跳过重排，直接从 Top-K 取 Top-N。</div>' +
            '<label class="tlg-label">重排端点</label><div class="tlg-row"><input class="tlg-input" id="tlg-rerank-url" value="' + escHtml(s.rerankUrl || "") + '" /><button type="button" class="tlg-btn" id="tlg-test-rerank-api" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">探针</button></div>' +
            '<label class="tlg-label">重排密钥</label><input class="tlg-input" id="tlg-rerank-key" type="password" value="' + escHtml(s.rerankKey || "") + '" style="margin-bottom:8px" />' +
            '<label class="tlg-label">重排核心</label><div class="tlg-row"><select class="tlg-select" id="tlg-rerank-model-select" style="flex:1"></select><button type="button" class="tlg-btn" id="tlg-fetch-rerank-models" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">检索</button></div>' +
            '<label class="tlg-label">或强制指定</label><input class="tlg-input" id="tlg-rerank-model" value="' + escHtml(s.rerankModel || "") + '" style="margin-bottom:10px" />' +
            '<div class="tlg-row"><span class="tlg-label" style="margin:0">使用LLM深度精排（支持 !CONFLICT !HISTORICAL 标记）</span><div class="tlg-toggle ' + (s.rerankUseLLM ? "on" : "") + '" id="tlg-rerank-use-llm"></div></div>' +
            '<label class="tlg-label">LLM精排提示词（仅开启上方开关时生效，{{current_context_summary}} {{current_time}} {{current_place}} {{candidate_fragments}}）</label><textarea class="tlg-textarea" id="tlg-rerank-llm-prompt" style="min-height:140px;font-size:11px;">' + escHtml(s.rerankLLMPrompt || "") + '</textarea></div>' +
            // ─── 保存按钮 ───
            '<button type="button" class="tlg-btn tlg-btn-primary" id="tlg-engine-save" style="width:100%!important;writing-mode:horizontal-tb;white-space:nowrap;height:auto;">锁定核心配置</button>' +
            '</div></div></div>';

        document.body.appendChild(panel); bindPanelEvents(panel);
    }

    function openPanel() {
        if (!isEnabled()) { toast("观测台已关闭，请解除权限限制。"); return; }
        loadCurrentWorld(); migrateOldData();
        var existingPanel = document.getElementById("tlg-panel"); if (existingPanel) existingPanel.remove();
        ensurePanelBuilt(); var panel = document.getElementById("tlg-panel"); if (!panel) return;
        panel.style.display = "flex"; document.body.style.overflow = "hidden";
        (function animLoop() {
            var p = document.getElementById("tlg-panel"); if (!p || p.style.display !== "flex") return;
            renderCanvas(); requestAnimationFrame(animLoop);
        })();
    }
    function closePanel() { var panel = document.getElementById("tlg-panel"); if (panel) panel.style.display = "none"; document.body.style.overflow = ""; }

    function switchTab(name) {
        var panel = document.getElementById("tlg-panel"); if (!panel) return;
        panel.querySelectorAll(".tlg-tab").forEach(function (t) { t.classList.toggle("active", t.getAttribute("data-tab") === name); });
        panel.querySelectorAll(".tlg-view").forEach(function (v) { var on = v.getAttribute("data-view") === name; v.classList.toggle("active", on); v.style.display = on ? "flex" : "none"; });
        if (name === "tree") { /* animLoop handles render */ }
        else if (name === "archive") refreshArchive();
        else if (name === "summary") refreshSummary();
        else if (name === "vault") refreshVault();
        else if (name === "worlds") refreshWorlds();
        else if (name === "worldarchive") { setTimeout(function(){ initGeoCanvas(); renderGeoCanvas(); refreshNpcList(); refreshItemsList(); }, 50); }
        else if (name === "engine") { populateModelSelect(); populateVectorModelSelect(); populateRerankModelSelect(); populateDigestModelSelect(); }
    }

    function bindPanelEvents(panel) {
        document.getElementById("tlg-close").onclick = closePanel;
        panel.querySelectorAll(".tlg-tab").forEach(function (tab) { tab.onclick = function () { switchTab(tab.getAttribute("data-tab")); }; });
        document.getElementById("tlg-brief-close").onclick = closeBriefPanel;
        document.getElementById("tlg-canvas-anchor").onclick = function () { showAnchorModal(); };
        document.getElementById("tlg-canvas-center-cur").onclick = function () { centerOnCurrentNode(); };
        document.getElementById("tlg-canvas-reset-view").onclick = function () { camX = 0; camY = 0; camZoom = 1; };
        document.getElementById("tlg-archive-new").onclick = function () { showAnchorModal(); };
        document.getElementById("tlg-worlds-import").addEventListener("click", importWorld);
        document.getElementById("tlg-worlds-create").addEventListener("click", createNewWorldManual);
        
        document.getElementById("tlg-auto-toggle").addEventListener("click", function () { globalApi.autoMode = !globalApi.autoMode; this.classList.toggle("on", globalApi.autoMode); saveGlobalApi(); });
        document.getElementById("tlg-auto-interval").addEventListener("change", function () { globalApi.autoInterval = Math.max(1, parseInt(this.value, 10) || 10); saveGlobalApi(); });
        document.getElementById("tlg-jump-summary-toggle").addEventListener("click", function () { globalApi.jumpSummary = !globalApi.jumpSummary; this.classList.toggle("on", globalApi.jumpSummary); saveGlobalApi(); });
        document.getElementById("tlg-last-n").addEventListener("change", function () { globalApi.lastNMessages = Math.max(1, parseInt(this.value, 10) || 5); saveGlobalApi(); });
        document.getElementById("tlg-manual-count").addEventListener("change", function () { globalApi.manualCount = Math.max(1, parseInt(this.value, 10) || 20); saveGlobalApi(); });
        document.getElementById("tlg-summary-max").addEventListener("change", function () { globalApi.summaryMaxCount = Math.max(10, parseInt(this.value, 10) || 100); saveGlobalApi(); });
        document.getElementById("tlg-auto-compress-toggle").addEventListener("click", function () { globalApi.autoCompress = !globalApi.autoCompress; this.classList.toggle("on", globalApi.autoCompress); saveGlobalApi(); });
        document.getElementById("tlg-compress-batch").addEventListener("change", function () { globalApi.compressBatchSize = Math.max(2, parseInt(this.value, 10) || 10); saveGlobalApi(); });
        document.getElementById("tlg-summary-prompt").addEventListener("change", function () { globalApi.summaryPrompt = this.value; saveGlobalApi(); });
        document.getElementById("tlg-summary-run").addEventListener("click", function () { flashBtn(this); runSummary(false); });

        document.getElementById("tlg-engine-save").addEventListener("click", function () {
            flashBtn(this);
            // 主API
            globalApi.apiUrl = document.getElementById("tlg-api-url").value.trim();
            globalApi.apiKey = document.getElementById("tlg-api-key").value.trim();
            globalApi.model = document.getElementById("tlg-model-manual").value.trim() || document.getElementById("tlg-model-select").value;
            globalApi.summaryPrompt = document.getElementById("tlg-engine-summary-prompt").value;
            globalApi.compressPrompt = document.getElementById("tlg-compress-prompt").value;
            globalApi.pathSummaryPrompt = document.getElementById("tlg-path-summary-prompt").value;
                    // 总结提示词双向同步（因果档案页 ↔ 引擎页）
        var summaryPromptSync = function (sourceId) {
            return function () {
                globalApi.summaryPrompt = document.getElementById(sourceId).value;
                var other = sourceId === "tlg-summary-prompt" ? "tlg-engine-summary-prompt" : "tlg-summary-prompt";
                var otherEl = document.getElementById(other);
                if (otherEl) otherEl.value = globalApi.summaryPrompt;
            };
        };
        var sp1 = document.getElementById("tlg-summary-prompt");
        var sp2 = document.getElementById("tlg-engine-summary-prompt");
        if (sp1) sp1.addEventListener("change", summaryPromptSync("tlg-summary-prompt"));
        if (sp2) sp2.addEventListener("change", summaryPromptSync("tlg-engine-summary-prompt"));
            // 摘要API
            globalApi.digestUrl = document.getElementById("tlg-digest-url").value.trim();
            globalApi.digestKey = document.getElementById("tlg-digest-key").value.trim();
            globalApi.digestModel = document.getElementById("tlg-digest-model").value.trim() || document.getElementById("tlg-digest-model-select").value;
            globalApi.digestPrompt = document.getElementById("tlg-digest-prompt").value;
            globalApi.queryRefinePrompt = document.getElementById("tlg-query-refine-prompt").value;
            globalApi.digestAutoMode = document.getElementById("tlg-digest-auto-toggle").classList.contains("on");
            globalApi.factUnitsMaxCount = Math.max(50, parseInt(document.getElementById("tlg-fact-units-max").value) || 500);
            // 向量API
            globalApi.vectorUrl = document.getElementById("tlg-vec-url").value.trim();
            globalApi.vectorKey = document.getElementById("tlg-vec-key").value.trim();
            globalApi.vectorModel = document.getElementById("tlg-vec-model").value.trim() || document.getElementById("tlg-vec-model-select").value;
            globalApi.vectorPrompt = document.getElementById("tlg-vec-prompt").value;
            // 召回参数
            globalApi.vectorQueryWindow = Math.max(1, parseInt(document.getElementById("tlg-vec-query-window").value) || 5);
            globalApi.vectorChunkLen = Math.max(100, parseInt(document.getElementById("tlg-vec-chunk-len").value) || 600);
            globalApi.vectorTopK = Math.max(1, parseInt(document.getElementById("tlg-vec-topk").value) || 8);
            globalApi.vectorThreshold = Math.max(0, parseFloat(document.getElementById("tlg-vec-threshold").value) || 0);
            globalApi.rerankTopN = Math.max(1, parseInt(document.getElementById("tlg-rerank-topn").value) || 3);
            globalApi.rerankThreshold = Math.max(0, parseFloat(document.getElementById("tlg-rerank-threshold").value) || 0);
            globalApi.vectorInjectDepth = Math.max(0, parseInt(document.getElementById("tlg-vec-inject-depth").value) || 0);
            globalApi.vectorMaxChars = Math.max(200, parseInt(document.getElementById("tlg-vec-max-chars").value) || 4000);
            // 重排API
            globalApi.rerankUrl = document.getElementById("tlg-rerank-url").value.trim();
            globalApi.rerankKey = document.getElementById("tlg-rerank-key").value.trim();
            globalApi.rerankModel = document.getElementById("tlg-rerank-model").value.trim() || document.getElementById("tlg-rerank-model-select").value;
            globalApi.rerankUseLLM = document.getElementById("tlg-rerank-use-llm").classList.contains("on");
            globalApi.rerankLLMPrompt = document.getElementById("tlg-rerank-llm-prompt").value;
            saveGlobalApi(); toast("引擎设置已锚定。");
        });

        document.getElementById("tlg-fetch-models").addEventListener("click", function () { flashBtn(this); globalApi.apiUrl = document.getElementById("tlg-api-url").value.trim(); globalApi.apiKey = document.getElementById("tlg-api-key").value.trim(); saveGlobalApi(); fetchModelList(); });
        document.getElementById("tlg-model-select").addEventListener("change", function () { if (this.value) document.getElementById("tlg-model-manual").value = this.value; });
        document.getElementById("tlg-vec-model-select").addEventListener("change", function () { if (this.value) document.getElementById("tlg-vec-model").value = this.value; });
        document.getElementById("tlg-fetch-vec-models").addEventListener("click", function () { flashBtn(this); globalApi.vectorUrl = document.getElementById("tlg-vec-url").value.trim(); globalApi.vectorKey = document.getElementById("tlg-vec-key").value.trim(); saveGlobalApi(); fetchVectorModelList(); });
        document.getElementById("tlg-test-api").addEventListener("click", function () {
            var url = document.getElementById("tlg-api-url").value.trim(), key = document.getElementById("tlg-api-key").value.trim();
            if (!url) { toast("地址为空。"); return; } flashBtn(this); toast("发送探针…");
            fetch(buildEndpoint(url, "/models"), { headers: key ? { Authorization: "Bearer " + key } : {} }).then(function (res) { toast(res.ok ? "✓ 节点联通。" : ("✗ 阻断: " + res.status)); }).catch(function (e) { toast("✗ " + e.message); });
        });
        document.getElementById("tlg-test-vec-api").addEventListener("click", function () {
            var url = document.getElementById("tlg-vec-url").value.trim(), key = document.getElementById("tlg-vec-key").value.trim();
            if (!url) { toast("地址为空。"); return; } flashBtn(this); toast("发送辅助探针…");
            fetch(buildEndpoint(url, "/models"), { headers: key ? { Authorization: "Bearer " + key } : {} }).then(function (res) { toast(res.ok ? "✓ 辅助节点联通。" : ("✗ 阻断: " + res.status)); }).catch(function (e) { toast("✗ " + e.message); });
        });
        document.getElementById("tlg-test-rerank-api").addEventListener("click", function () {
            var url = document.getElementById("tlg-rerank-url").value.trim(), key = document.getElementById("tlg-rerank-key").value.trim();
            if (!url) { toast("地址为空。"); return; } flashBtn(this); toast("发送重排探针…");
            fetch(buildEndpoint(url, "/models"), { headers: key ? { Authorization: "Bearer " + key } : {} }).then(function (res) { toast(res.ok ? "✓ 重排节点联通。" : ("✗ 阻断: " + res.status)); }).catch(function (e) { toast("✗ " + e.message); });
        });
        document.getElementById("tlg-fetch-rerank-models").addEventListener("click", function () { flashBtn(this); globalApi.rerankUrl = document.getElementById("tlg-rerank-url").value.trim(); globalApi.rerankKey = document.getElementById("tlg-rerank-key").value.trim(); saveGlobalApi(); fetchRerankModelList(); });
        document.getElementById("tlg-rerank-model-select").addEventListener("change", function () { if (this.value) document.getElementById("tlg-rerank-model").value = this.value; });
                document.getElementById("tlg-digest-auto-toggle").addEventListener("click", function () {
            globalApi.digestAutoMode = !globalApi.digestAutoMode;
            this.classList.toggle("on", globalApi.digestAutoMode); saveGlobalApi();
        });
        document.getElementById("tlg-test-digest-api").addEventListener("click", function () {
            var url = document.getElementById("tlg-digest-url").value.trim(), key = document.getElementById("tlg-digest-key").value.trim();
            if (!url) { toast("摘要地址为空。"); return; } flashBtn(this); toast("发送摘要探针…");
            fetch(buildEndpoint(url, "/models"), { headers: key ? { Authorization: "Bearer " + key } : {} })
            .then(function (res) { toast(res.ok ? "✓ 摘要节点联通。" : ("✗ 阻断: " + res.status)); })
            .catch(function (e) { toast("✗ " + e.message); });
        });
        document.getElementById("tlg-fetch-digest-models").addEventListener("click", function () {
            flashBtn(this);
            globalApi.digestUrl = document.getElementById("tlg-digest-url").value.trim();
            globalApi.digestKey = document.getElementById("tlg-digest-key").value.trim();
            saveGlobalApi(); fetchDigestModelList();
        });
        document.getElementById("tlg-digest-model-select").addEventListener("change", function () {
            if (this.value) document.getElementById("tlg-digest-model").value = this.value;
        });
        document.getElementById("tlg-rerank-use-llm").addEventListener("click", function () {
            globalApi.rerankUseLLM = !globalApi.rerankUseLLM;
            this.classList.toggle("on", globalApi.rerankUseLLM); saveGlobalApi();
        });
        // 世界档案子标签切换
        panel.querySelectorAll(".tlg-subtab").forEach(function(tab) {
            tab.onclick = function() {
                panel.querySelectorAll(".tlg-subtab").forEach(function(t) { t.classList.remove("active"); t.style.color = "#6a6a78"; t.style.borderBottomColor = "transparent"; });
                panel.querySelectorAll(".tlg-subpanel").forEach(function(p) { p.style.display = "none"; p.classList.remove("active"); });
                tab.classList.add("active"); tab.style.color = "#e8e8f0"; tab.style.borderBottomColor = "#c0c0c8";
                var target = panel.querySelector('.tlg-subpanel[data-subpanel="' + tab.dataset.subtab + '"]');
                if (target) { target.style.display = ""; target.classList.add("active"); }
                if (tab.dataset.subtab === "geo") { setTimeout(function(){ initGeoCanvas(); renderGeoCanvas(); }, 50); }
                else if (tab.dataset.subtab === "npc") { refreshNpcList(); }
                else if (tab.dataset.subtab === "items") { refreshItemsList(); }
            };
        });
        // 地理按钮
        var geoAddBtn = document.getElementById("tlg-geo-add");
        if (geoAddBtn) geoAddBtn.onclick = function() { showAddGeoModal(); };
        var geoResetBtn = document.getElementById("tlg-geo-reset");
        if (geoResetBtn) geoResetBtn.onclick = function() { geoCamX = 0; geoCamY = 0; geoCamZoom = 1; renderGeoCanvas(); };
        // NPC按钮
        var npcAddBtn = document.getElementById("tlg-npc-add");
        if (npcAddBtn) npcAddBtn.onclick = function() { showAddNpcModal(); };
        var npcFilter = document.getElementById("tlg-npc-filter");
        if (npcFilter) npcFilter.onchange = function() { refreshNpcList(); };
        initCanvasEvents();
    }

    function initCanvasEvents() {
        var wrap = document.getElementById("tlg-canvas-wrap"); if (!wrap) return;
        canvas = document.getElementById("tlg-tree-canvas"); ctx = canvas.getContext("2d");
        if (typeof ResizeObserver !== "undefined") { new ResizeObserver(function () {}).observe(wrap); }
        canvas.addEventListener("mousedown", function (e) {
            if (e.button !== 0) return; var hit = canvasHitTest(e.clientX, e.clientY);
            if (hit) {
                var rct = canvas.getBoundingClientRect();
                var wx = (e.clientX - rct.left - rct.width / 2 - camX) / camZoom;
                var wy = (e.clientY - rct.top - rct.height / 2 - camY) / camZoom;
                triggerRipple(wx, wy); openBriefPanel(hit); return;
            }
            isPanning = true; panStartX = e.clientX - camX; panStartY = e.clientY - camY;
        });
        canvas.addEventListener("mousemove", function (e) { if (!isPanning) return; camX = e.clientX - panStartX; camY = e.clientY - panStartY; });
        function endPan() { isPanning = false; }
        canvas.addEventListener("mouseup", endPan); canvas.addEventListener("mouseleave", endPan);
        canvas.addEventListener("wheel", function (e) { e.preventDefault(); camZoom = Math.max(0.2, Math.min(4, camZoom * (e.deltaY < 0 ? 1.1 : 0.91))); }, { passive: false });
        var lastTouchDist = 0, touchStartHit = null, touchMoved = false;
        canvas.addEventListener("touchstart", function (e) {
            touchMoved = false;
            if (e.touches.length === 1) { isPanning = true; panStartX = e.touches[0].clientX - camX; panStartY = e.touches[0].clientY - camY; touchStartHit = canvasHitTest(e.touches[0].clientX, e.touches[0].clientY); }
            else if (e.touches.length === 2) { isPanning = false; lastTouchDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY); }
        }, { passive: true });
        canvas.addEventListener("touchmove", function (e) {
            touchMoved = true;
            if (e.touches.length === 1 && isPanning) { camX = e.touches[0].clientX - panStartX; camY = e.touches[0].clientY - panStartY; }
            else if (e.touches.length === 2) { var dist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY); if (lastTouchDist > 0) { camZoom = Math.max(0.2, Math.min(4, camZoom * (dist / lastTouchDist))); } lastTouchDist = dist; }
        }, { passive: true });
        canvas.addEventListener("touchend", function (e) {
            if (!touchMoved && touchStartHit) {
                var rct = canvas.getBoundingClientRect();
                var wx = (e.changedTouches[0].clientX - rct.left - rct.width / 2 - camX) / camZoom;
                var wy = (e.changedTouches[0].clientY - rct.top - rct.height / 2 - camY) / camZoom;
                triggerRipple(wx, wy); openBriefPanel(touchStartHit);
            }
            isPanning = false; touchStartHit = null;
        }, { passive: true });
    }

       function injectMenuButton() {
        var BTN_ID = "tlg-menu-btn";
        if (document.getElementById(BTN_ID)) return;
        if (!isEnabled()) { var old = document.getElementById("tlg-menu-btn"); if (old) old.remove(); return; }
        var menu = document.getElementById("extensionsMenu"); if (!menu) return; if (document.getElementById("tlg-menu-btn")) return;
        var btn = document.createElement("div"); btn.id = "tlg-menu-btn"; btn.className = "list-group-item flex-container flexGap5 interactable"; btn.style.cursor = "pointer";
        btn.innerHTML = '<i class="fa-solid fa-water" style="color:#ffffff;text-shadow:0 0 4px rgba(0,0,0,0.8);"></i><span style="color:#ffffff;font-weight:900;text-shadow:1px 1px 3px #000000,0 0 8px rgba(0,0,0,0.6);letter-spacing:1px;">河岸凝视</span>';
        btn.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); var p = document.getElementById("tlg-panel"); if (p && p.style.display === "flex") closePanel(); else openPanel(); });
        menu.appendChild(btn);
    }
    function injectSettingsPanel() {
        if (document.getElementById("tlg_settings_block")) return;
        var host = document.querySelector("#extensions_settings2") || document.querySelector("#extensions_settings") || document.querySelector("#extensions_settings1");
        if (!host) return; var enabled = isEnabled();
        var block = document.createElement("div"); block.id = "tlg_settings_block"; block.className = "extension_container";
        block.innerHTML = '<div class="inline-drawer"><div class="inline-drawer-toggle inline-drawer-header"><b>🌊 河岸凝视</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div><div class="inline-drawer-content"><div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin:8px 0;"><span>授予观测权限</span><div class="tlg-toggle ' + (enabled ? "on" : "") + '" id="tlg_enable_toggle"></div></div><div style="font-size:12px;opacity:.75;margin-bottom:10px;">解除或封锁观测台访问。</div><button type="button" class="tlg-btn tlg-btn-primary" id="tlg_settings_open" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">展开高维观测界面</button><div style="font-size:11px;opacity:.55;margin-top:10px;">快捷锚定：/tlg_anchor | 视野滤镜：/tlg_filter</div></div></div>';
        host.appendChild(block);
        document.getElementById("tlg_enable_toggle").onclick = function () { var next = !this.classList.contains("on"); this.classList.toggle("on", next); setEnabled(next); toast(next ? "观测权限已授予" : "观测权限已封锁"); };
        document.getElementById("tlg_settings_open").onclick = function () { openPanel(); };
    }

    function registerSlashCommand() {
        function wrap(value) { if (!isEnabled()) { toast("未授予观测权限。"); return ""; } loadCurrentWorld(); showAnchorModal(String(value || "")); return ""; }
        var st = getST();
        if (st && st.registerSlashCommand) { st.registerSlashCommand("tlg_anchor", function (a, v) { return wrap(v); }, [], "凝固当前因果刻度", true, true); }
        if (window.SillyTavern && window.SillyTavern.SlashCommandParser) {
            try { window.SillyTavern.SlashCommandParser.addCommandObject(window.SillyTavern.SlashCommand.fromProps({ name: "tlg_anchor", callback: function (a, v) { return wrap(v); }, helpString: "建立新的因果锚点。" })); } catch (e) {}
        }
        function toggleFilter() {
            if (!isEnabled()) { toast("未授予观测权限。"); return ""; }
            globalApi.summaryFilterMode = !globalApi.summaryFilterMode; saveGlobalApi(); updateInjectionWithVector();
            toast(globalApi.summaryFilterMode ? "视野滤镜：仅注视本时间线" : "视野滤镜：俯瞰全部因果纠缠"); return "";
        }
        if (st && st.registerSlashCommand) { st.registerSlashCommand("tlg_filter", function (a, v) { return toggleFilter(); }, [], "切换记忆视野滤镜", true, true); }
        if (window.SillyTavern && window.SillyTavern.SlashCommandParser) {
            try { window.SillyTavern.SlashCommandParser.addCommandObject(window.SillyTavern.SlashCommand.fromProps({ name: "tlg_filter", callback: function (a, v) { return toggleFilter(); }, helpString: "切换提取记忆范围：本时间线/全部。" })); } catch (e) {}
        }
    }

    function boot() {
        injectMenuButton(); injectSettingsPanel();
        // MutationObserver：只在按钮不存在时才注入，避免死循环
        var _observerBusy = false;
        new MutationObserver(function () {
            if (_observerBusy) return;
            _observerBusy = true;
            injectMenuButton(); injectSettingsPanel();
            _observerBusy = false;
        }).observe(document.body, { childList: true, subtree: true });
        registerSlashCommand();
        try { loadCurrentWorld(); } catch (e) {}
        if (!currentWorldId && getCurrentChatId()) { ensureWorldExists(); if (!state.nodes.length) resetState(); saveCurrentWorld(); }

                try {
            var ctx1 = getST();
            if (ctx1 && ctx1.eventSource && ctx1.eventTypes) {
                        ctx1.eventSource.on(ctx1.eventTypes.MESSAGE_RECEIVED, function () {
                    if (!isEnabled()) return;
                    loadGlobalApi();
                    var st2 = getST();
                    if (st2 && st2.chat) {
                        var curLen = st2.chat.length;
                        // 初始化同步
                        if (!state._lastChatLen || state._lastChatLen <= 0) state._lastChatLen = curLen;
                        // 如果 chat 变短了（删除/重试），同步但不加计数
                        if (curLen < state._lastChatLen) { state._lastChatLen = curLen; }
                        if (curLen > state._lastChatLen) {
                            state._lastChatLen = curLen;
                        }
                    }
                    // 自动总结：基于 coveredUpTo 判断，不依赖 turnsSinceAnchor
                    if (globalApi.autoMode && st2 && st2.chat) {
                        var interval = globalApi.autoInterval || 10;
                        var coveredUpTo = _getCoveredUpTo();
                        var uncoveredCount = 0;
                        for (var ui = 1; ui < st2.chat.length; ui++) {
                            if (ui > coveredUpTo) uncoveredCount++;
                        }
                        if (uncoveredCount >= interval) {
                            toast("⚙ 自律模式触发（未覆盖 " + uncoveredCount + " 楼）");
                            runSummary(true);
                        }
                    }
                    applyRecentVisibility();
                    saveCurrentWorld();
                    // 每回合异步事实抽取
                    if (globalApi.digestAutoMode !== false) {
                        setTimeout(function () { runDigestRequest(); }, 1000);
                    }
                });

                if (ctx1.eventTypes.MESSAGE_SENT) {
                    ctx1.eventSource.on(ctx1.eventTypes.MESSAGE_SENT, function () {
                        if (!isEnabled()) return;
                        var st3 = getST();
                        if (st3 && st3.chat) {
                            var curLen = st3.chat.length;
                            if (!state._lastChatLen || state._lastChatLen <= 0) state._lastChatLen = curLen;
                            if (curLen < state._lastChatLen) state._lastChatLen = curLen;
                            if (curLen > state._lastChatLen) state._lastChatLen = curLen;
                        }
                        // 发消息时强制刷新隐藏，确保AI生成前状态正确
                        applyRecentVisibility();
                    });
                }

                if (ctx1.eventTypes.MESSAGE_SWIPED) {
                    ctx1.eventSource.on(ctx1.eventTypes.MESSAGE_SWIPED, function (msgIdx) {
                        if (!isEnabled() || !state.lastAutoSummaryRange) return;
                        var range = state.lastAutoSummaryRange;
                        var idx = typeof msgIdx === "number" ? msgIdx : -1;
                        if (idx < 0) { var st4 = getST(); idx = st4 && st4.chat ? st4.chat.length - 1 : -1; }
                        if (idx >= range.floorFrom && idx <= range.floorTo) {
                            if (state.summaries && state.summaries.length > range.summaryIdx) {
                                state.summaries.splice(range.summaryIdx, 1);
                                if (currentWorldId && worlds[currentWorldId]) worlds[currentWorldId].summaries = state.summaries;
                                saveWorlds();
                            }
                            state.lastAutoSummaryRange = null;
                            state.turnsSinceAnchor = 0; saveTurnsCounter();
                            toast("🔄 检测到重试，已撤销最近自动切片。");
                        }
                    });
                }

                ctx1.eventSource.on(ctx1.eventTypes.CHAT_CHANGED, function () {
                    var p = document.getElementById("tlg-panel"); if (p) p.remove();
                    canvas = null; ctx = null; document.body.style.overflow = "";
                    var retries = 0;
                    function tryInit() {
                        retries++;
                        loadCurrentWorld();
                        if (!currentWorldId && getCurrentChatId()) {
                            ensureWorldExists();
                            if (!state.nodes.length) resetState();
                            saveCurrentWorld();
                        } else if (!currentWorldId && !getCurrentChatId() && retries < 5) {
                            setTimeout(tryInit, 600);
                        }
                    }
                    setTimeout(tryInit, 500);
                });
            }
        } catch (e) {}
        console.log("[TLG] 河岸凝视 v3.6 已上线");
    }

    if (document.readyState === "loading") { document.addEventListener("DOMContentLoaded", boot); }
    else { setTimeout(boot, 1000); }
})();
