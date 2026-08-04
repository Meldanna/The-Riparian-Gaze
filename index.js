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
        factUnits: [],
        turnsSinceAnchor: 0,
        _lastChatLen: 0,
        lastAutoSummaryRange: null
    };

    var globalApi = {
        apiUrl: "", apiKey: "", model: "", modelList: [],
        vectorUrl: "", vectorKey: "", vectorModel: "", vectorModelList: [],
        rerankUrl: "", rerankKey: "", rerankModel: "", rerankModelList: [],
        vectorTopK: 8, rerankTopN: 3, vectorThreshold: 0, rerankThreshold: 0,
        vectorQueryWindow: 5, vectorChunkLen: 600, vectorInjectDepth: 0, vectorMaxChars: 4000,
        digestUrl: "", digestKey: "", digestModel: "", digestModelList: [],
        digestPrompt: "", digestAutoMode: true, factUnitsMaxCount: 500,
        rerankUseLLM: false, rerankLLMPrompt: "",
        vectorPrompt: "以下为因果档案库中与当前观测焦点相关的历史切片：\n\n{{context}}\n\n处理规则：\n- 这些是已铭刻的因果事实，不可篡改\n- 当前叙事必须与这些记录在逻辑上连续\n- 若当前事件是某条历史线的后果，自然呈现因果关系\n- 不要直接引用或复述这些档案内容",
        summaryPrompt: "你是因果记录仪。对以下对话执行状态切片，提取并压缩为因果档案。\n\n【因果事件链】本段发生的事件，按因果顺序（A导致B导致C），每条一句\n【样本状态变动】主角的生理、心理、物品、关系的变化\n【NPC状态变动】在场NPC的行为、立场、情绪变化\n【悬置因果线】未完成的选择、未触发的后果、埋下的伏笔\n【环境快照】地点·天气·时间·在场实体\n\n对话内容：\n{{context}}\n\n要求：纯事实记录，无评论，无修辞。输出格式：纯文本，不要使用markdown标记（禁止*、**、#等符号）。直接输出内容。",
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
                if (es.api[keys[i]] !== undefined) globalApi[keys[i]] = es.api[keys[i]];
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
            state.factUnits = w.factUnits || [];
        } else {
            currentWorldId = null; resetState();
        }
        updateInjectionWithVector();
    }
    function saveCurrentWorld() {
        if (!currentWorldId || !worlds[currentWorldId]) return;
        worlds[currentWorldId].nodes = JSON.parse(JSON.stringify(state.nodes));
        worlds[currentWorldId].summaries = JSON.parse(JSON.stringify(state.summaries));
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

    function applyVisibility(targetNodeId) {
        var st = getST(); if (!st || !st.chat) return;
        var pathIds = getPathToRoot(targetNodeId); var pathNodes = pathIds.map(findNode).filter(Boolean);
        var visible = {}, i, m, node, next, start, end;
        for (i = 0; i < pathNodes.length; i++) {
            node = pathNodes[i]; next = pathNodes[i + 1] || null; start = node.msgIdx; end = next ? next.msgIdx - 1 : node.msgIdx;
            for (m = start; m <= end; m++) visible[m] = true;
        }
        var target = findNode(targetNodeId); var lastN = Math.max(0, globalApi.lastNMessages || 5);
        var endIdx = target ? target.msgIdx : st.chat.length - 1;
        for (m = Math.max(0, endIdx - lastN + 1); m <= endIdx; m++) visible[m] = true;
        for (i = 0; i < st.chat.length; i++) {
            if (visible[i]) {
                if (st.chat[i]._tlg_hidden) { delete st.chat[i].is_system; delete st.chat[i]._tlg_hidden; }
            } else {
                if (!st.chat[i].is_system) { st.chat[i].is_system = true; st.chat[i]._tlg_hidden = true; }
            }
        }
        // reloadCurrentChat 让酒馆重新渲染，AI生成时正确过滤隐藏消息
        if (typeof st.reloadCurrentChat === "function") {
            st.reloadCurrentChat();
        }
    }
    function applyRecentVisibility() {
        var st = getST(); if (!st || !st.chat || !st.chat.length) return;
        var lastN = Math.max(1, globalApi.lastNMessages || 5);
        var total = st.chat.length;
        for (var i = 0; i < total; i++) {
            if (i >= total - lastN) {
                if (st.chat[i]._tlg_hidden) { delete st.chat[i].is_system; delete st.chat[i]._tlg_hidden; }
            } else {
                if (!st.chat[i].is_system) { st.chat[i].is_system = true; st.chat[i]._tlg_hidden = true; }
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
        saveTurnsCounter();
        saveCurrentWorld(); toast("⚓ 已锚定: " + newNode.name); renderCanvas(); refreshArchive(); return newId;
    }
    function createAnchorAtFloor(name, brief, floorIdx) {
        var st = getST(); if (!st) return; ensureWorldExists();
        var msgIdx = Math.max(0, Math.min(floorIdx, (st.chat ? st.chat.length - 1 : 0)));
        var parentId = state.currentNodeId; var newId = generateId();
        var newNode = { id: newId, name: name || ("节点@#" + msgIdx), brief: brief || "", parentId: parentId, msgIdx: msgIdx, statData: getMVUStatData(), timestamp: Date.now(), children: [] };
        var parent = findNode(parentId);
        if (parent && parent.children.indexOf(newId) === -1) parent.children.push(newId);
        state.nodes.push(newNode); state.currentNodeId = newId; state.selectedNodeId = newId;
        saveCurrentWorld(); toast("⚓ 已锚定于 #" + msgIdx + ": " + newNode.name); renderCanvas(); refreshArchive(); return newId;
    }

    function jumpToNode(nodeId) {
        var node = findNode(nodeId); if (!node) { toast("节点不存在。"); return; }
        var st = getST();
        var preJumpMessages = null;
        var apiUrl = (globalApi.apiUrl || "").trim();
        if (apiUrl && globalApi.jumpSummary && st && st.chat) {
            var coveredUpTo = -1;
            if (state.summaries && state.summaries.length) {
                for (var si = 0; si < state.summaries.length; si++) {
                    var sm = state.summaries[si];
                    if (typeof sm.floorTo === "number" && sm.floorTo > coveredUpTo) coveredUpTo = sm.floorTo;
                }
            }
            // 不过滤隐藏标记，只看楼层是否已被总结覆盖
            var uncoveredVisible = [];
            for (var mi = 0; mi < st.chat.length; mi++) {
                if (mi === 0) continue;
                if (mi <= coveredUpTo) continue;
                uncoveredVisible.push(st.chat[mi]);
            }
            var interval = globalApi.autoInterval || 10;
            if (uncoveredVisible.length >= interval) {
                var fullCount = Math.floor(uncoveredVisible.length / interval) * interval;
                preJumpMessages = uncoveredVisible.slice(0, fullCount);
            }
        }
        if (node.statData != null) setMVUStatData(node.statData);
        applyVisibility(nodeId);
        state.currentNodeId = nodeId; state.turnsSinceAnchor = 0;
        saveTurnsCounter();
        saveCurrentWorld(); toast("↩ 已跳转至: " + node.name); renderCanvas(); refreshArchive(); closeBriefPanel();
        if (preJumpMessages && preJumpMessages.length > 0) {
            var interval2 = globalApi.autoInterval || 10;
            var jumpBatches = [];
            for (var jb = 0; jb < preJumpMessages.length; jb += interval2) {
                jumpBatches.push(preJumpMessages.slice(jb, jb + interval2));
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

    function runSummaryWithMessages(messagesArray) { _doSummaryRequest(messagesArray, true, "跳转前"); }

    function runSummary(auto) {
        var st = getST(); if (!st || !st.chat || !st.chat.length) { if (!auto) toast("当前无聊天消息。"); return; }
        ensureWorldExists();
        if (auto) {
            // 自动模式：按楼层精确取"上次总结之后"的未覆盖消息
            var interval = globalApi.autoInterval || 10;
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
            // 必须满一个完整间隔才总结
            if (uncovered.length < interval) return;
            // 只取刚好一个间隔的量
            var batch = uncovered.slice(0, interval);
            _doSummaryRequest(batch, true, "自动");
        } else {
            // 手动模式：取最近 N 条（不过滤隐藏）
            var count = globalApi.manualCount || 20;
            var recent = st.chat.slice(-count);
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
    // 摘要API：每回合事实单元抽取
    // ══════════════════════════════════════
    function getTurnTime() {
        try {
            var snap = window.__tlg_mvu_snapshot || {};
            var t = snap.time || snap.game_time || snap.current_time || snap.date || snap.gameTime || "";
            return String(t).trim();
        } catch (e) { return ""; }
    }

    function parseFactUnits(rawText) {
        var lines = rawText.split("\n");
        var units = [];
        var st = getST();
        var turnIdx = (st && st.chat) ? Math.max(0, st.chat.length - 1) : 0;
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!line || line.indexOf("[T]:") === -1) continue;
            var unit = { raw: line, T: "", L: "", E: "", I: "", A: "", C: "", timestamp: Date.now(), turnIdx: turnIdx };
            var fields = line.split(" | ");
            for (var j = 0; j < fields.length; j++) {
                var f = fields[j].trim();
                if (f.indexOf("[T]:") === 0) unit.T = f.slice(4).trim();
                else if (f.indexOf("[L]:") === 0) unit.L = f.slice(4).trim();
                else if (f.indexOf("[E]:") === 0) unit.E = f.slice(4).trim();
                else if (f.indexOf("[I]:") === 0) unit.I = f.slice(4).trim();
                else if (f.indexOf("[A]:") === 0) unit.A = f.slice(4).trim();
                else if (f.indexOf("[C]:") === 0) unit.C = f.slice(4).trim();
            }
            if (unit.T || unit.L || unit.E || unit.A) units.push(unit);
        }
        return units;
    }

    function extractGeoFromUnits(units) {
        var geoEntries = [];
        for (var i = 0; i < units.length; i++) {
            var L = units[i].L;
            if (!L || L === "NULL") continue;
            var parts = L.split("→");
            for (var p = 0; p < parts.length; p++) {
                var loc = parts[p].trim();
                if (loc && loc !== "NULL") {
                    geoEntries.push({
                        path: loc,
                        turnIdx: units[i].turnIdx,
                        timestamp: units[i].timestamp,
                        time: units[i].T !== "NULL" ? units[i].T : ""
                    });
                }
            }
        }
        return geoEntries;
    }

    function extractNPCFromUnits(units) {
        var npcEntries = [];
        for (var i = 0; i < units.length; i++) {
            var E = units[i].E;
            if (!E || E === "NULL") continue;
            var chars = E.split("；");
            for (var c = 0; c < chars.length; c++) {
                var charStr = chars[c].trim();
                if (!charStr) continue;
                // 格式：姓名（身份标签）：变化描述
                var nameMatch = charStr.match(/^(.+?)（(.+?)）：(.+)$/);
                if (nameMatch) {
                    npcEntries.push({
                        name: nameMatch[1].trim(),
                        role: nameMatch[2].trim(),
                        change: nameMatch[3].trim(),
                        location: (units[i].L && units[i].L !== "NULL") ? units[i].L : "",
                        time: (units[i].T && units[i].T !== "NULL") ? units[i].T : "",
                        turnIdx: units[i].turnIdx,
                        timestamp: units[i].timestamp
                    });
                }
            }
        }
        return npcEntries;
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

        // 取最新一条AI回复作为本回合内容
        var lastMsg = null;
        for (var i = st.chat.length - 1; i >= 0; i--) {
            if (!st.chat[i].is_user && st.chat[i].mes) { lastMsg = st.chat[i]; break; }
        }
        if (!lastMsg) return;

        var turnTime = getTurnTime();
        var context = (lastMsg.mes || "").trim();
        if (!context) return;

        var prompt = digestPrompt
            .replace(/\{\{turn_time\}\}/g, turnTime || "（未知）")
            .replace(/\{\{context\}\}/g, context);

        var lockedWorldId = currentWorldId;

        fetch(buildEndpoint(digestUrl, "/chat/completions"), {
            method: "POST",
            headers: Object.assign({ "Content-Type": "application/json" }, digestKey ? { Authorization: "Bearer " + digestKey } : {}),
            body: JSON.stringify({
                model: digestModel || undefined,
                messages: [{ role: "user", content: prompt }],
                max_tokens: 4096
            })
        }).then(function (r) {
            if (!r.ok) throw new Error("HTTP " + r.status);
            return r.json();
        }).then(function (data) {
            var text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
            if (!text.trim()) { toast("⚠ 事实单元返回为空。"); return; }
            var units = parseFactUnits(text);
            if (!units.length) { toast("⚠ 事实单元解析失败，未识别到有效行。"); return; }
            if (lockedWorldId && worlds[lockedWorldId]) {
                if (!worlds[lockedWorldId].factUnits) worlds[lockedWorldId].factUnits = [];
                if (!worlds[lockedWorldId].geoBuffer) worlds[lockedWorldId].geoBuffer = [];
                if (!worlds[lockedWorldId].npcBuffer) worlds[lockedWorldId].npcBuffer = [];
                worlds[lockedWorldId].factUnits = worlds[lockedWorldId].factUnits.concat(units);
                var maxCount = globalApi.factUnitsMaxCount || 500;
                if (worlds[lockedWorldId].factUnits.length > maxCount) {
                    worlds[lockedWorldId].factUnits = worlds[lockedWorldId].factUnits.slice(-maxCount);
                }
                var geoEntries = extractGeoFromUnits(units);
                var npcEntries = extractNPCFromUnits(units);
                worlds[lockedWorldId].geoBuffer = worlds[lockedWorldId].geoBuffer.concat(geoEntries);
                worlds[lockedWorldId].npcBuffer = worlds[lockedWorldId].npcBuffer.concat(npcEntries);
                if (worlds[lockedWorldId].geoBuffer.length > 2000) worlds[lockedWorldId].geoBuffer = worlds[lockedWorldId].geoBuffer.slice(-2000);
                if (worlds[lockedWorldId].npcBuffer.length > 2000) worlds[lockedWorldId].npcBuffer = worlds[lockedWorldId].npcBuffer.slice(-2000);
                if (lockedWorldId === currentWorldId) {
                    state.factUnits = worlds[lockedWorldId].factUnits;
                }
                saveWorlds();
                toast("✓ 事实单元 +" + units.length + " | 地理 +" + geoEntries.length + " | NPC +" + npcEntries.length);
            }
        }).catch(function (e) {
            console.error("[TLG] Digest:", e);
            if (retryCount < MAX_RETRIES) {
                var delay = (retryCount + 1) * 3000;
                toast("⚠ 事实抽取失败，" + (delay / 1000) + "秒后重试 (" + (retryCount + 1) + "/" + MAX_RETRIES + ")");
                setTimeout(function () { runDigestRequest(retryCount + 1); }, delay);
            } else {
                toast("✗ 事实抽取最终失败: " + e.message);
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
            '<div class="tlg-section"><div class="tlg-section-title">主解析引擎</div>' +
            '<label class="tlg-label">连接端点</label><div class="tlg-row"><input class="tlg-input" id="tlg-api-url" placeholder="https://api.openai.com" value="' + escHtml(s.apiUrl || "") + '" /><button type="button" class="tlg-btn" id="tlg-test-api" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">探针</button></div>' +
            '<label class="tlg-label">认证密钥</label><input class="tlg-input" id="tlg-api-key" type="password" value="' + escHtml(s.apiKey || "") + '" style="margin-bottom:10px" />' +
            '<label class="tlg-label">演算核心</label><div class="tlg-row"><select class="tlg-select" id="tlg-model-select" style="flex:1"></select><button type="button" class="tlg-btn" id="tlg-fetch-models" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">检索</button></div>' +
            '<label class="tlg-label">或强制指定</label><input class="tlg-input" id="tlg-rerank-model" value="' + escHtml(s.rerankModel || "") + '" style="margin-bottom:8px" />' +
            '<div class="tlg-row"><span class="tlg-label" style="margin:0">使用LLM深度精排（支持!CONFLICT !HISTORICAL标记）</span><div class="tlg-toggle ' + (s.rerankUseLLM ? "on" : "") + '" id="tlg-rerank-use-llm"></div></div>' +
            '<label class="tlg-label">LLM精排提示词（仅开启LLM精排时生效）</label>' +
            '<textarea class="tlg-textarea" id="tlg-rerank-llm-prompt" style="min-height:140px;font-size:11px;">' + escHtml(s.rerankLLMPrompt || "") + '</textarea></div>' +
            '<div class="tlg-section"><div class="tlg-section-title">联想网络（辅助引擎）</div>' +
            '<label class="tlg-label">向量端点</label><div class="tlg-row"><input class="tlg-input" id="tlg-vec-url" value="' + escHtml(s.vectorUrl || "") + '" /><button type="button" class="tlg-btn" id="tlg-test-vec-api" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">探针</button></div>' +
            '<label class="tlg-label">向量密钥</label><input class="tlg-input" id="tlg-vec-key" type="password" value="' + escHtml(s.vectorKey || "") + '" style="margin-bottom:10px" />' +
            '<label class="tlg-label">降维核心</label><div class="tlg-row"><select class="tlg-select" id="tlg-vec-model-select" style="flex:1"></select><button type="button" class="tlg-btn" id="tlg-fetch-vec-models" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">检索</button></div>' +
            '<label class="tlg-label">或强制指定</label><input class="tlg-input" id="tlg-vec-model" value="' + escHtml(s.vectorModel || "") + '" style="margin-bottom:8px" />' +
            '<label class="tlg-label">联想提示词（{{context}} = 最终注入内容）</label><textarea class="tlg-textarea" id="tlg-vec-prompt">' + escHtml(s.vectorPrompt || "") + '</textarea></div>' +
            '<div class="tlg-section"><div class="tlg-section-title">召回参数</div>' +
            '<div style="font-size:11px;color:#7a7a8a;margin-bottom:10px;">控制 向量检索 → 重排 → 注入 完整流程的所有参数。</div>' +
            '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px 14px;">' +
            '<div><label class="tlg-label">查询窗口（最近N条消息→生成查询向量）</label><input class="tlg-input" id="tlg-vec-query-window" type="number" min="1" max="20" value="' + (s.vectorQueryWindow || 5) + '" style="width:70px" /></div>' +
            '<div><label class="tlg-label">档案截断（每条嵌入取前N字符）</label><input class="tlg-input" id="tlg-vec-chunk-len" type="number" min="100" max="2000" step="50" value="' + (s.vectorChunkLen || 600) + '" style="width:80px" /></div>' +
            '<div><label class="tlg-label">初筛召回 Top-K（向量排序后保留候选数）</label><input class="tlg-input" id="tlg-vec-topk" type="number" min="1" max="50" value="' + (s.vectorTopK || 8) + '" style="width:70px" /></div>' +
            '<div><label class="tlg-label">相似度阈值（低于此值丢弃，0=全保留）</label><input class="tlg-input" id="tlg-vec-threshold" type="number" min="0" max="1" step="0.05" value="' + (s.vectorThreshold || 0) + '" style="width:80px" /></div>' +
            '<div><label class="tlg-label">最终注入 Top-N（重排后取前N条）</label><input class="tlg-input" id="tlg-rerank-topn" type="number" min="1" max="20" value="' + (s.rerankTopN || 3) + '" style="width:70px" /></div>' +
            '<div><label class="tlg-label">重排相关度阈值（0=不过滤）</label><input class="tlg-input" id="tlg-rerank-threshold" type="number" min="0" max="1" step="0.05" value="' + (s.rerankThreshold || 0) + '" style="width:80px" /></div>' +
            '<div><label class="tlg-label">注入深度（0=最底部贴近最新消息）</label><input class="tlg-input" id="tlg-vec-inject-depth" type="number" min="0" max="50" value="' + (s.vectorInjectDepth || 0) + '" style="width:70px" /></div>' +
            '<div><label class="tlg-label">最大注入字符（防撑爆上下文）</label><input class="tlg-input" id="tlg-vec-max-chars" type="number" min="200" max="20000" step="100" value="' + (s.vectorMaxChars || 4000) + '" style="width:80px" /></div>' +
            '</div></div>' +
            '<div class="tlg-section"><div class="tlg-section-title">摘要引擎（每回合事实抽取）</div>' +
            '<div style="font-size:11px;color:#7a7a8a;margin-bottom:8px;">每回合AI生成后异步调用，输出结构化事实单元[T][L][E][I][A][C]，供向量检索。与总结功能并行，各自独立，互不替代。</div>' +
            '<div class="tlg-row"><span class="tlg-label" style="margin:0">自动模式（每回合触发）</span><div class="tlg-toggle ' + (s.digestAutoMode !== false ? "on" : "") + '" id="tlg-digest-auto-toggle"></div></div>' +
            '<label class="tlg-label">摘要端点</label><div class="tlg-row"><input class="tlg-input" id="tlg-digest-url" value="' + escHtml(s.digestUrl || "") + '" /><button type="button" class="tlg-btn" id="tlg-test-digest-api" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">探针</button></div>' +
            '<label class="tlg-label">摘要密钥</label><input class="tlg-input" id="tlg-digest-key" type="password" value="' + escHtml(s.digestKey || "") + '" style="margin-bottom:8px" />' +
            '<label class="tlg-label">摘要核心</label><div class="tlg-row"><select class="tlg-select" id="tlg-digest-model-select" style="flex:1"></select><button type="button" class="tlg-btn" id="tlg-fetch-digest-models" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">检索</button></div>' +
            '<label class="tlg-label">或强制指定</label><input class="tlg-input" id="tlg-digest-model" value="' + escHtml(s.digestModel || "") + '" style="margin-bottom:8px" />' +
            '<label class="tlg-label">事实单元上限（超出后删最旧，建议500~2000）</label><input class="tlg-input" id="tlg-fact-units-max" type="number" min="50" max="5000" value="' + (s.factUnitsMaxCount || 500) + '" style="width:80px;margin-bottom:8px" />' +
            '<label class="tlg-label">摘要提示词（{{turn_time}}=游戏内时间 {{context}}=本回合正文）</label>' +
            '<textarea class="tlg-textarea" id="tlg-digest-prompt" style="min-height:200px;font-size:11px;">' + escHtml(s.digestPrompt || "") + '</textarea></div>' +
            '<div class="tlg-section"><div class="tlg-section-title">重排引擎（Rerank，可选）</div>' +
            '<div style="font-size:11px;color:#7a7a8a;margin-bottom:8px;">对向量初筛结果进行语义精排。留空则跳过重排，直接从 Top-K 取 Top-N。</div>' +
            '<label class="tlg-label">重排端点</label><div class="tlg-row"><input class="tlg-input" id="tlg-rerank-url" value="' + escHtml(s.rerankUrl || "") + '" /><button type="button" class="tlg-btn" id="tlg-test-rerank-api" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">探针</button></div>' +
            '<label class="tlg-label">重排密钥</label><input class="tlg-input" id="tlg-rerank-key" type="password" value="' + escHtml(s.rerankKey || "") + '" style="margin-bottom:8px" />' +
            '<label class="tlg-label">重排核心</label><div class="tlg-row"><select class="tlg-select" id="tlg-rerank-model-select" style="flex:1"></select><button type="button" class="tlg-btn" id="tlg-fetch-rerank-models" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">检索</button></div>' +
            '<label class="tlg-label">或强制指定</label><input class="tlg-input" id="tlg-rerank-model" value="' + escHtml(s.rerankModel || "") + '" /></div>' +
            '<div class="tlg-section"><div class="tlg-section-title">提示词配置</div>' +
            '<label class="tlg-label">浓缩指令（{{context}}）</label><textarea class="tlg-textarea" id="tlg-compress-prompt" style="min-height:80px">' + escHtml(s.compressPrompt || "") + '</textarea>' +
            '<label class="tlg-label">路径摘要指令（{{context}}）</label><textarea class="tlg-textarea" id="tlg-path-summary-prompt" style="min-height:80px">' + escHtml(s.pathSummaryPrompt || "") + '</textarea></div>' +
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
            globalApi.apiUrl = document.getElementById("tlg-api-url").value.trim();
            globalApi.apiKey = document.getElementById("tlg-api-key").value.trim();
            globalApi.vectorUrl = document.getElementById("tlg-vec-url").value.trim();
            globalApi.vectorKey = document.getElementById("tlg-vec-key").value.trim();
            globalApi.vectorModel = document.getElementById("tlg-vec-model").value.trim() || document.getElementById("tlg-vec-model-select").value;
            globalApi.vectorPrompt = document.getElementById("tlg-vec-prompt").value;
            globalApi.model = document.getElementById("tlg-model-manual").value.trim() || document.getElementById("tlg-model-select").value;
            globalApi.compressPrompt = document.getElementById("tlg-compress-prompt").value;
            globalApi.pathSummaryPrompt = document.getElementById("tlg-path-summary-prompt").value;
            globalApi.vectorTopK = Math.max(1, parseInt(document.getElementById("tlg-vec-topk").value) || 8);
            globalApi.vectorThreshold = Math.max(0, parseFloat(document.getElementById("tlg-vec-threshold").value) || 0);
            globalApi.vectorQueryWindow = Math.max(1, parseInt(document.getElementById("tlg-vec-query-window").value) || 5);
            globalApi.vectorChunkLen = Math.max(100, parseInt(document.getElementById("tlg-vec-chunk-len").value) || 600);
            globalApi.vectorInjectDepth = Math.max(0, parseInt(document.getElementById("tlg-vec-inject-depth").value) || 0);
            globalApi.vectorMaxChars = Math.max(200, parseInt(document.getElementById("tlg-vec-max-chars").value) || 4000);
            globalApi.rerankTopN = Math.max(1, parseInt(document.getElementById("tlg-rerank-topn").value) || 3);
            globalApi.rerankThreshold = Math.max(0, parseFloat(document.getElementById("tlg-rerank-threshold").value) || 0);
            globalApi.rerankUrl = document.getElementById("tlg-rerank-url").value.trim();
            globalApi.rerankKey = document.getElementById("tlg-rerank-key").value.trim();
            globalApi.rerankModel = document.getElementById("tlg-rerank-model").value.trim() || document.getElementById("tlg-rerank-model-select").value;
            globalApi.digestUrl = document.getElementById("tlg-digest-url").value.trim();
            globalApi.digestKey = document.getElementById("tlg-digest-key").value.trim();
            globalApi.digestModel = document.getElementById("tlg-digest-model").value.trim() || document.getElementById("tlg-digest-model-select").value;
            globalApi.digestPrompt = document.getElementById("tlg-digest-prompt").value;
            globalApi.digestAutoMode = document.getElementById("tlg-digest-auto-toggle").classList.contains("on");
            globalApi.factUnitsMaxCount = Math.max(50, parseInt(document.getElementById("tlg-fact-units-max").value) || 500);
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
                        if (!state._lastChatLen || state._lastChatLen <= 0) {
                            state._lastChatLen = curLen;
                        }
                        var prevLen = state._lastChatLen;
                        if (curLen > prevLen) {
                            state.turnsSinceAnchor = (state.turnsSinceAnchor || 0) + (curLen - prevLen);
                            state._lastChatLen = curLen;
                        }
                    }
                    saveTurnsCounter();
                    if (globalApi.autoMode && state.turnsSinceAnchor >= (globalApi.autoInterval || 10)) {
                        var interval = globalApi.autoInterval || 10;
                        var coveredUpTo = -1;
                        if (state.summaries && state.summaries.length) {
                            for (var si = 0; si < state.summaries.length; si++) {
                                var sm = state.summaries[si];
                                if (typeof sm.floorTo === "number" && sm.floorTo > coveredUpTo) coveredUpTo = sm.floorTo;
                            }
                        }
                        var actualUncovered = 0;
                        for (var ui = 1; ui < st2.chat.length; ui++) {
                            if (ui > coveredUpTo) actualUncovered++;
                        }
                        if (actualUncovered >= interval) {
                            state.turnsSinceAnchor = 0;
                            saveTurnsCounter();
                            toast("⚙ 自律模式触发（未覆盖 " + actualUncovered + " 楼）");
                            runSummary(true);
                        }
                    }
                    applyRecentVisibility();
                    saveCurrentWorld();
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
                            if (!state._lastChatLen || state._lastChatLen <= 0) {
                                state._lastChatLen = curLen;
                            }
                            var prevLen = state._lastChatLen;
                            if (curLen > prevLen) {
                                state.turnsSinceAnchor = (state.turnsSinceAnchor || 0) + (curLen - prevLen);
                                state._lastChatLen = curLen;
                                saveTurnsCounter();
                            }
                        }
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
