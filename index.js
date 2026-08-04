/* 河岸凝视 v3.6 */
(function () {
    "use strict";

    var EXT_NAME = "RiparianGaze";
    var METADATA_KEY = "tlg_data";

    var state = {
        nodes: [],
        currentNodeId: null,
        selectedNodeId: null,
        summaries: [],
        turnsSinceAnchor: 0,
        _lastChatLen: 0,
        lastAutoSummaryRange: null
    };

    var globalApi = {
        apiUrl: "", apiKey: "", model: "", modelList: [],
        vectorUrl: "", vectorKey: "", vectorModel: "", vectorModelList: [],
        rerankUrl: "", rerankKey: "", rerankModel: "", rerankModelList: [],
        vectorTopK: 8,
        rerankTopN: 3,
        vectorPrompt: "以下为因果档案库中与当前观测焦点相关的历史切片：\n\n{{context}}\n\n处理规则：\n- 这些是已铭刻的因果事实，不可篡改\n- 当前叙事必须与这些记录在逻辑上连续\n- 若当前事件是某条历史线的后果，自然呈现因果关系\n- 不要直接引用或复述这些档案内容",
        summaryPrompt: "你是因果记录仪。对以下对话执行状态切片，提取并压缩为因果档案。\n\n【因果事件链】本段发生的事件，按因果顺序（A导致B导致C），每条一句\n【样本状态变动】主角的生理、心理、物品、关系的变化\n【NPC状态变动】在场NPC的行为、立场、情绪变化\n【悬置因果线】未完成的选择、未触发的后果、埋下的伏笔\n【环境快照】地点·天气·时间·在场实体\n\n对话内容：\n{{context}}\n\n要求：纯事实记录，无评论，无修辞。输出格式：纯文本，不要使用markdown标记（禁止*、**、#等符号）。直接输出内容。",
        compressPrompt: "以下是若干条历史因果档案，请将其浓缩合并为一条，保留所有关键事件、状态变化和悬置因果线，删除重复和次要细节。输出格式：纯文本，禁止markdown标记，直接输出内容。\n\n{{context}}",
        pathSummaryPrompt: "以下是一条命运路径上的节点描述和相关因果档案，请为这条路径生成一段简短的剧情摘要（200字以内），概括主要事件走向和当前状态。输出格式：纯文本，禁止markdown标记，直接输出内容。\n\n{{context}}",
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
            if (!on) closePanel();
            // 先移除再重建按钮以更新状态
            var btn = document.getElementById("tlg-menu-btn");
            if (btn) btn.remove();
            setTimeout(function() { injectMenuButton(); }, 50); // 延迟避免Observer冲突
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

    // ══════════════════════════════════════
    // 跳转（已修复重复总结）
    // ══════════════════════════════════════
    function jumpToNode(nodeId) {
        var node = findNode(nodeId); if (!node) { toast("节点不存在。"); return; }
        var st = getST();
        var preJumpMessages = null;
        var apiUrl = (globalApi.apiUrl || "").trim();
        if (apiUrl && globalApi.jumpSummary && st && st.chat) {
            // 计算已覆盖最大楼层
            var coveredUpTo = -1;
            if (state.summaries && state.summaries.length) {
                for (var si = 0; si < state.summaries.length; si++) {
                    var sm = state.summaries[si];
                    if (typeof sm.floorTo === "number" && sm.floorTo > coveredUpTo) coveredUpTo = sm.floorTo;
                }
            }
            // 收集未覆盖且可见的消息（跳过#0开场白）
            var uncoveredVisible = [];
            for (var mi = 0; mi < st.chat.length; mi++) {
                if (mi === 0) continue;
                if (mi <= coveredUpTo) continue;
                if (st.chat[mi]._tlg_hidden || st.chat[mi].is_hidden) continue;
                uncoveredVisible.push(st.chat[mi]);
            }
            // 只有未覆盖消息满一个间隔才总结
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
        // 分批发送跳转前总结
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
            '<div style="font-size:12px;color:#7a7a8a;margin-bottom:12px;">终点节点：' + escHtml(node.name) + '</div>' +
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
        pathNodes.forEach(function(n) {
            if (n.brief) contextParts.push("节点【" + n.name + "】：" + n.brief);
        });
        var relSummaries = state.summaries.filter(function(s) { return !s.nodeId || pathIds.indexOf(s.nodeId) !== -1; }).slice(-5);
        if (relSummaries.length) contextParts.push("相关档案：\n" + relSummaries.map(function(s){ return s.text; }).join("\n---\n"));
        var context = contextParts.join("\n\n");
        var prompt = (globalApi.pathSummaryPrompt || "").replace("{{context}}", context);
        fetch(buildEndpoint(apiUrl, "/chat/completions"), {
            method: "POST", headers: Object.assign({ "Content-Type": "application/json" }, apiKey ? { Authorization: "Bearer " + apiKey } : {}),
            body: JSON.stringify({ model: model || undefined, messages: [{ role: "user", content: prompt }], max_tokens: 512 })
        }).then(function(r){ return r.json(); }).then(function(data){
            var text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
            callback(text);
        }).catch(function(e){ toast("生成失败：" + e.message); callback(""); });
    }

    function refreshPinnedPaths() {
        var container = document.getElementById("tlg-pinned-paths"); if (!container) return;
        var paths = getPinnedPaths();
        if (!paths.length) { container.innerHTML = '<div style="color:#5a5a6a;font-size:12px;padding:8px 0;">暂无常用路径。点击节点可设置。</div>'; return; }
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
                if (!confirm("确定删除节点「" + (n ? n.name : "") + "」？子节点将重连至父级。")) return;
                deleteNode(btn.dataset.nid);
            };
        });
        container.querySelectorAll(".tlg-archive-graft").forEach(function (btn) { btn.onclick = function () { showGraftModal(btn.dataset.nid); }; });
    }

    // ══════════════════════════════════════
    // 删除节点（已修复：子节点重连父级）
    // ══════════════════════════════════════
    function deleteNode(nodeId) {
        var node = findNode(nodeId); if (!node) return;
        if (!node.parentId) { toast("无法删除根节点。"); return; }
        var parent = findNode(node.parentId);
        // 将被删节点的子节点重新挂载到父节点下
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
        // 从父节点的 children 中移除被删节点
        if (parent) {
            parent.children = parent.children.filter(function (id) { return id !== nodeId; });
        }
        // 仅删除该节点本身
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
        saveCurrentWorld(); renderCanvas(); refreshArchive(); toast("嫁接完成：" + node.name + " → " + newParent.name);
    }

    function showGraftModal(nodeId) {
        var node = findNode(nodeId); if (!node) return;
        var existing = document.getElementById("tlg-graft-modal"); if (existing) existing.remove();
        var opts = state.nodes.filter(function(n) { return n.id !== nodeId; }).map(function(n) {
            return '<option value="' + escHtml(n.id) + '">' + escHtml(n.name) + ' (#' + n.msgIdx + ')</option>';
        }).join("");
        var backdrop = document.createElement("div"); backdrop.id = "tlg-graft-modal";
        backdrop.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100dvh;background:rgba(0,0,0,0.85);z-index:2147483647;display:flex;align-items:flex-start;justify-content:center;padding:16px;padding-top:12vh;box-sizing:border-box;overflow-y:auto;";
        backdrop.innerHTML = '<div class="tlg-modal"><div class="tlg-modal-title">⇢ 嫁接节点</div>' +
            '<div style="font-size:12px;color:#7a7a8a;margin-bottom:12px;">将「' + escHtml(node.name) + '」移动到新的父节点下</div>' +
            '<label class="tlg-label">选择新父节点</label><select class="tlg-select" id="tlg-graft-target" style="width:100%;margin-bottom:12px">' + opts + '</select>' +
            '<div class="tlg-modal-actions"><button type="button" class="tlg-btn" id="tlg-graft-cancel">取消</button><button type="button" class="tlg-btn tlg-btn-primary" id="tlg-graft-ok">确认嫁接</button></div></div>';
        document.body.appendChild(backdrop);
        backdrop.querySelector("#tlg-graft-cancel").onclick = function() { backdrop.remove(); };
        backdrop.querySelector("#tlg-graft-ok").onclick = function() {
            var target = backdrop.querySelector("#tlg-graft-target").value;
            if (!target) { toast("请选择目标节点。"); return; }
            graftNode(nodeId, target); backdrop.remove();
        };
        backdrop.addEventListener("click", function(e) { if (e.target === backdrop) backdrop.remove(); });
    }

    // ══════════════════════════════════════
    // 总结系统
    // ══════════════════════════════════════
    function buildEndpoint(base, path) {
        var url = (base || "").trim();
        if (!url) return "";
        if (url.endsWith("/")) url = url.slice(0, -1);
        if (!/\/v\d/.test(url)) url += "/v1";
        return url + path;
    }

    function _doSummaryRequest(messages, isBatch, label, callback, retryCount) {
        retryCount = retryCount || 0;
        var MAX_RETRIES = 3;
        var apiUrl = (globalApi.apiUrl || "").trim();
        var apiKey = (globalApi.apiKey || "").trim();
        var model = (globalApi.model || "").trim();
        if (!apiUrl) { toast("请先配置API地址。"); if (callback) callback(); return; }

        var chatText = messages.map(function(m) { return (m.name || m.role || "???") + ": " + (m.mes || m.content || ""); }).join("\n");
        var prompt = (globalApi.summaryPrompt || "").replace("{{context}}", chatText);

        // 计算楼层范围
        var st = getST();
        var floorFrom = -1, floorTo = -1;
        if (st && st.chat) {
            for (var fi = 0; fi < st.chat.length; fi++) {
                if (st.chat[fi] === messages[0]) { floorFrom = fi; break; }
            }
            for (var fj = st.chat.length - 1; fj >= 0; fj--) {
                if (st.chat[fj] === messages[messages.length - 1]) { floorTo = fj; break; }
            }
        }
        // 如果无法通过引用匹配，使用消息内容匹配
        if (floorFrom === -1 && st && st.chat && messages[0]) {
            var firstMes = messages[0].mes || messages[0].content || "";
            for (var fi2 = 0; fi2 < st.chat.length; fi2++) {
                if ((st.chat[fi2].mes || "") === firstMes) { floorFrom = fi2; break; }
            }
        }
        if (floorTo === -1 && st && st.chat && messages[messages.length - 1]) {
            var lastMes = messages[messages.length - 1].mes || messages[messages.length - 1].content || "";
            for (var fj2 = st.chat.length - 1; fj2 >= 0; fj2--) {
                if ((st.chat[fj2].mes || "") === lastMes) { floorTo = fj2; break; }
            }
        }

        fetch(buildEndpoint(apiUrl, "/chat/completions"), {
            method: "POST",
            headers: Object.assign({ "Content-Type": "application/json" }, apiKey ? { Authorization: "Bearer " + apiKey } : {}),
            body: JSON.stringify({ model: model || undefined, messages: [{ role: "user", content: prompt }], max_tokens: 1024 })
        }).then(function(r) {
            if (!r.ok) throw new Error("HTTP " + r.status);
            return r.json();
        }).then(function(data) {
            var text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
            if (!text) { toast("⚠ 总结返回为空。"); if (callback) callback(); return; }
            state.summaries.push({
                id: generateId(), text: text, timestamp: Date.now(),
                nodeId: state.currentNodeId, floorFrom: floorFrom, floorTo: floorTo,
                label: label || ""
            });
            // 自动压缩检查
            if (globalApi.autoCompress && state.summaries.length >= (globalApi.compressBatchSize || 10) * 2) {
                compressSummaries();
            }
            if (globalApi.summaryMaxCount && state.summaries.length > globalApi.summaryMaxCount) {
                state.summaries = state.summaries.slice(-globalApi.summaryMaxCount);
            }
            saveCurrentWorld();
            toast("✓ " + (label || "总结") + " 完成 (#" + floorFrom + "~#" + floorTo + ")");
            refreshSummary();
            if (callback) callback();
        }).catch(function(e) {
            console.error("[TLG] Summary error:", e);
            if (retryCount < MAX_RETRIES) {
                var delay = (retryCount + 1) * 2000;
                toast("⚠ " + (label || "总结") + " 失败，" + delay / 1000 + "秒后重试 (" + (retryCount + 1) + "/" + MAX_RETRIES + ")…");
                setTimeout(function() {
                    _doSummaryRequest(messages, isBatch, label, callback, retryCount + 1);
                }, delay);
            } else {
                toast("✗ " + (label || "总结") + " 最终失败: " + e.message);
                if (callback) callback();
            }
        });
    }

    // 补全历史切片（已修复）
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
        // 收集未覆盖楼层（跳过#0开场白）
        var uncovered = [];
        for (var j = 0; j < st.chat.length; j++) {
            if (j === 0) continue; // 跳过开场白
            if (j <= coveredUpTo) continue;
            if (st.chat[j]._tlg_hidden || st.chat[j].is_hidden) continue;
            uncovered.push(st.chat[j]);
        }
        if (!uncovered.length) { toast("所有楼层已被覆盖，无需补全。"); return; }
        // 分批，最后一批不满 batchSize 则丢弃
        var batches = [];
        for (var k = 0; k < uncovered.length; k += batchSize) {
            var batch = uncovered.slice(k, k + batchSize);
            if (batch.length < batchSize) break; // 不满一批则不总结
            batches.push(batch);
        }
        if (!batches.length) { toast("未覆盖消息不足 " + batchSize + " 条，暂不补全。"); return; }
        toast("📋 开始补全历史切片，共 " + batches.length + " 批…");
        var sendBtn = document.getElementById("send_but");
        if (sendBtn) { sendBtn.disabled = true; sendBtn.style.opacity = "0.4"; }
        var catchupBtns = document.querySelectorAll("#tlg-summary-catchup-btn,#tlg-vault-catchup");
        catchupBtns.forEach(function(b) { b.disabled = true; });
        var idx = 0;
        function nextBatch() {
            if (idx >= batches.length) {
                toast("✓ 历史补全完成，共 " + batches.length + " 批。");
                if (sendBtn) { sendBtn.disabled = false; sendBtn.style.opacity = ""; }
                catchupBtns.forEach(function(b) { b.disabled = false; });
                return;
            }
            var batch = batches[idx]; idx++;
            _doSummaryRequest(batch, true, "补全 " + idx + "/" + batches.length, nextBatch);
        }
        nextBatch();
    }

    function runManualSummary() {
        var st = getST(); if (!st || !st.chat || !st.chat.length) { toast("当前无聊天消息。"); return; }
        ensureWorldExists();
        var count = Math.max(1, globalApi.manualCount || 20);
        var messages = st.chat.slice(-count).filter(function(m) { return !m._tlg_hidden && !m.is_hidden; });
        if (!messages.length) { toast("无可用消息。"); return; }
        toast("📝 总结最近 " + messages.length + " 条消息…");
        _doSummaryRequest(messages, false, "手动总结");
    }

    function compressSummaries() {
        var batchSize = globalApi.compressBatchSize || 10;
        if (state.summaries.length < batchSize) { toast("档案不足，无需压缩。"); return; }
        var apiUrl = (globalApi.apiUrl || "").trim();
        if (!apiUrl) { toast("请先配置API地址。"); return; }
        var batch = state.summaries.slice(0, batchSize);
        var context = batch.map(function(s) { return s.text; }).join("\n---\n");
        var prompt = (globalApi.compressPrompt || "").replace("{{context}}", context);
        var apiKey = (globalApi.apiKey || "").trim();
        var model = (globalApi.model || "").trim();
        toast("🗜 压缩前 " + batchSize + " 条档案…");
        fetch(buildEndpoint(apiUrl, "/chat/completions"), {
            method: "POST",
            headers: Object.assign({ "Content-Type": "application/json" }, apiKey ? { Authorization: "Bearer " + apiKey } : {}),
            body: JSON.stringify({ model: model || undefined, messages: [{ role: "user", content: prompt }], max_tokens: 1024 })
        }).then(function(r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
        .then(function(data) {
            var text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
            if (!text) { toast("压缩返回为空。"); return; }
            var minFloor = Infinity, maxFloor = -1;
            batch.forEach(function(s) {
                if (typeof s.floorFrom === "number" && s.floorFrom < minFloor) minFloor = s.floorFrom;
                if (typeof s.floorTo === "number" && s.floorTo > maxFloor) maxFloor = s.floorTo;
            });
            state.summaries = state.summaries.slice(batchSize);
            state.summaries.unshift({
                id: generateId(), text: text, timestamp: Date.now(), nodeId: state.currentNodeId,
                floorFrom: minFloor === Infinity ? -1 : minFloor, floorTo: maxFloor,
                label: "压缩档案 (#" + (minFloor === Infinity ? "?" : minFloor) + "~#" + maxFloor + ")",
                compressed: true
            });
            saveCurrentWorld(); toast("✓ 压缩完成。"); refreshSummary();
        }).catch(function(e) { toast("✗ 压缩失败: " + e.message); });
    }

    function refreshSummary() {
        var list = document.getElementById("tlg-summary-list"); if (!list) return;
        if (!state.summaries || !state.summaries.length) { list.innerHTML = '<div style="color:#5a5a6a;font-style:italic">河流安静，尚无因果档案。</div>'; return; }
        list.innerHTML = state.summaries.slice().reverse().map(function(s, ri) {
            var idx = state.summaries.length - 1 - ri;
            return '<div style="background:#050508;border:1px solid #2a2a3a;border-radius:4px;padding:10px;margin-bottom:8px;position:relative;">' +
                '<div style="font-size:11px;color:#7a7a8a;margin-bottom:4px;">' + new Date(s.timestamp).toLocaleString() + (s.label ? ' · ' + escHtml(s.label) : '') +
                (typeof s.floorFrom === "number" && s.floorFrom >= 0 ? ' · #' + s.floorFrom + '~#' + s.floorTo : '') +
                (s.compressed ? ' · 🗜' : '') + '</div>' +
                '<div style="font-size:12px;white-space:pre-wrap;line-height:1.6;max-height:200px;overflow-y:auto;">' + escHtml(s.text) + '</div>' +
                '<button type="button" class="tlg-btn tlg-btn-danger tlg-sum-del" data-idx="' + idx + '" style="position:absolute;top:8px;right:8px;font-size:10px;padding:2px 6px;writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">✕</button></div>';
        }).join("");
        list.querySelectorAll(".tlg-sum-del").forEach(function(btn) {
            btn.onclick = function() { state.summaries.splice(Number(btn.dataset.idx), 1); saveCurrentWorld(); refreshSummary(); };
        });
    }

    // ══════════════════════════════════════
    // 向量注入 + 重排
    // ══════════════════════════════════════
    function updateInjectionWithVector() {
        if (!state.summaries || !state.summaries.length) { clearInjection(); return; }
        var st = getST(); if (!st) return;
        var vecUrl = (globalApi.vectorUrl || "").trim();
        if (vecUrl && globalApi.vectorKey) {
            vectorSearchAndInject();
        } else {
            directInject();
        }
    }

    function directInject() {
        var filtered = filterSummariesForPath();
        var text = filtered.map(function(s) { return s.text; }).join("\n---\n");
        var prompt = (globalApi.vectorPrompt || "{{context}}").replace("{{context}}", text);
        injectToChat(prompt);
    }

    function vectorSearchAndInject(retryCount) {
        retryCount = retryCount || 0;
        var MAX_RETRIES = 3;
        var st = getST(); if (!st || !st.chat || !st.chat.length) { directInject(); return; }
        var recentMsgs = st.chat.slice(-3).map(function(m) { return (m.mes || "").slice(0, 200); }).join(" ");
        if (!recentMsgs.trim()) { directInject(); return; }

        var vecUrl = (globalApi.vectorUrl || "").trim();
        var vecKey = (globalApi.vectorKey || "").trim();
        var vecModel = (globalApi.vectorModel || "").trim();
        if (!vecUrl) { directInject(); return; }

        // Step 1: Embed query
        var embedEndpoint = buildEndpoint(vecUrl, "/embeddings");
        fetch(embedEndpoint, {
            method: "POST",
            headers: Object.assign({ "Content-Type": "application/json" }, vecKey ? { Authorization: "Bearer " + vecKey } : {}),
            body: JSON.stringify({ model: vecModel || undefined, input: recentMsgs })
        }).then(function(r) {
            if (!r.ok) throw new Error("嵌入请求失败 HTTP " + r.status);
            return r.json();
        }).then(function(data) {
            var queryEmbed = null;
            if (data.data && data.data[0] && data.data[0].embedding) {
                queryEmbed = data.data[0].embedding;
            }
            if (!queryEmbed) { throw new Error("嵌入响应格式异常"); }
            return embedSummariesAndSearch(queryEmbed);
        }).then(function(topResults) {
            // Step 3: Rerank if configured
            var rerankUrl = (globalApi.rerankUrl || "").trim();
            if (rerankUrl && globalApi.rerankKey && topResults.length > 1) {
                return rerankResults(recentMsgs, topResults);
            }
            return topResults;
        }).then(function(finalResults) {
            var topN = globalApi.rerankTopN || 3;
            var results = finalResults.slice(0, topN);
            var context = results.map(function(r) { return r.text; }).join("\n---\n");
            var prompt = (globalApi.vectorPrompt || "{{context}}").replace("{{context}}", context);
            injectToChat(prompt);
        }).catch(function(e) {
            console.error("[TLG] Vector search error:", e);
            if (retryCount < MAX_RETRIES) {
                var delay = (retryCount + 1) * 1500;
                toast("⚠ 向量检索失败，" + delay / 1000 + "秒后重试 (" + (retryCount + 1) + "/" + MAX_RETRIES + ")…");
                setTimeout(function() { vectorSearchAndInject(retryCount + 1); }, delay);
            } else {
                toast("⚠ 向量检索最终失败，使用直接注入。");
                directInject();
            }
        });
    }

    function embedSummariesAndSearch(queryEmbed) {
        var filtered = filterSummariesForPath();
        if (!filtered.length) return Promise.resolve([]);

        var vecUrl = (globalApi.vectorUrl || "").trim();
        var vecKey = (globalApi.vectorKey || "").trim();
        var vecModel = (globalApi.vectorModel || "").trim();
        var topK = globalApi.vectorTopK || 8;

        var texts = filtered.map(function(s) { return s.text.slice(0, 500); });
        var embedEndpoint = buildEndpoint(vecUrl, "/embeddings");

        return fetch(embedEndpoint, {
            method: "POST",
            headers: Object.assign({ "Content-Type": "application/json" }, vecKey ? { Authorization: "Bearer " + vecKey } : {}),
            body: JSON.stringify({ model: vecModel || undefined, input: texts })
        }).then(function(r) {
            if (!r.ok) throw new Error("档案嵌入失败 HTTP " + r.status);
            return r.json();
        }).then(function(data) {
            if (!data.data || !data.data.length) throw new Error("档案嵌入响应异常");
            // 余弦相似度排序
            var scored = [];
            for (var i = 0; i < data.data.length; i++) {
                var emb = data.data[i].embedding;
                if (!emb) continue;
                var sim = cosineSimilarity(queryEmbed, emb);
                scored.push({ text: filtered[i].text, score: sim, summary: filtered[i] });
            }
            scored.sort(function(a, b) { return b.score - a.score; });
            return scored.slice(0, topK);
        });
    }

    function rerankResults(query, results, retryCount) {
        retryCount = retryCount || 0;
        var MAX_RETRIES = 2;
        var rerankUrl = (globalApi.rerankUrl || "").trim();
        var rerankKey = (globalApi.rerankKey || "").trim();
        var rerankModel = (globalApi.rerankModel || "").trim();
        var topN = globalApi.rerankTopN || 3;

        if (!rerankUrl) return Promise.resolve(results.slice(0, topN));

        var documents = results.map(function(r) { return r.text; });
        var endpoint = buildEndpoint(rerankUrl, "/rerank");

        return fetch(endpoint, {
            method: "POST",
            headers: Object.assign({ "Content-Type": "application/json" }, rerankKey ? { Authorization: "Bearer " + rerankKey } : {}),
            body: JSON.stringify({
                model: rerankModel || undefined,
                query: query,
                documents: documents,
                top_n: topN
            })
        }).then(function(r) {
            if (!r.ok) throw new Error("重排请求失败 HTTP " + r.status);
            return r.json();
        }).then(function(data) {
            // 标准 rerank 响应: { results: [{ index, relevance_score }] }
            if (data.results && data.results.length) {
                var reranked = data.results.sort(function(a, b) { return b.relevance_score - a.relevance_score; });
                return reranked.slice(0, topN).map(function(item) { return results[item.index]; });
            }
            // 兜底
            return results.slice(0, topN);
        }).catch(function(e) {
            console.error("[TLG] Rerank error:", e);
            if (retryCount < MAX_RETRIES) {
                var delay = (retryCount + 1) * 1500;
                toast("⚠ 重排失败，" + delay / 1000 + "秒后重试…");
                return new Promise(function(resolve) {
                    setTimeout(function() { resolve(rerankResults(query, results, retryCount + 1)); }, delay);
                });
            }
            toast("⚠ 重排最终失败，使用原始排序。");
            return results.slice(0, topN);
        });
    }

    function cosineSimilarity(a, b) {
        if (!a || !b || a.length !== b.length) return 0;
        var dot = 0, na = 0, nb = 0;
        for (var i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
        var denom = Math.sqrt(na) * Math.sqrt(nb);
        return denom === 0 ? 0 : dot / denom;
    }

    function filterSummariesForPath() {
        if (!globalApi.summaryFilterMode) return state.summaries || [];
        var pathIds = getPathToRoot(state.currentNodeId);
        return (state.summaries || []).filter(function(s) {
            if (!s.nodeId) return true;
            return pathIds.indexOf(s.nodeId) !== -1;
        });
    }

    function injectToChat(prompt) {
        var st = getST(); if (!st) return;
        // 使用 SillyTavern 的 setExtensionPrompt 注入
        if (typeof st.setExtensionPrompt === "function") {
            st.setExtensionPrompt(EXT_NAME, prompt, 1, 0);
        }
    }

    function clearInjection() {
        var st = getST(); if (!st) return;
        if (typeof st.setExtensionPrompt === "function") {
            st.setExtensionPrompt(EXT_NAME, "", 1, 0);
        }
    }

    // ══════════════════════════════════════
    // 世界管理
    // ══════════════════════════════════════
    function refreshWorlds() {
        var container = document.getElementById("tlg-worlds-list"); if (!container) return;
        var ids = Object.keys(worlds);
        if (!ids.length) { container.innerHTML = '<div style="color:#5a5a6a;padding:20px;text-align:center;font-style:italic">尚无观测世界。请在聊天中锚定以自动创建。</div>'; return; }
        ids.sort(function(a, b) { return (worlds[b].updatedAt || 0) - (worlds[a].updatedAt || 0); });
        container.innerHTML = ids.map(function(wid) {
            var w = worlds[wid]; var isCurrent = wid === currentWorldId;
            return '<div class="tlg-archive-card ' + (isCurrent ? "current" : "") + '" style="margin-bottom:10px;">' +
                '<div class="tlg-archive-title">' + escHtml(w.name) + (isCurrent ? " <span style='color:#7a7a8a;font-size:11px'>(当前)</span>" : "") + '</div>' +
                '<div class="tlg-archive-meta">' + (w.nodes ? w.nodes.length : 0) + ' 节点 · ' + (w.summaries ? w.summaries.length : 0) + ' 档案 · 更新: ' + new Date(w.updatedAt || w.createdAt).toLocaleString() + '</div>' +
                '<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;">' +
                '<button type="button" class="tlg-btn tlg-worlds-switch" data-wid="' + wid + '" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">' + (isCurrent ? "✓ 当前" : "切换") + '</button>' +
                '<button type="button" class="tlg-btn tlg-worlds-rename" data-wid="' + wid + '" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">✎ 命名</button>' +
                '<button type="button" class="tlg-btn tlg-worlds-export" data-wid="' + wid + '" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">↓ 导出</button>' +
                '<button type="button" class="tlg-btn tlg-btn-danger tlg-worlds-del" data-wid="' + wid + '" style="margin-left:auto;writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">✕</button>' +
                '</div></div>';
        }).join("");
        container.querySelectorAll(".tlg-worlds-switch").forEach(function(btn) {
            btn.onclick = function() {
                var wid = btn.dataset.wid;
                if (wid === currentWorldId) return;
                currentWorldId = wid; setLinkedWorldId(wid);
                var w = worlds[wid];
                state.nodes = w.nodes || []; state.summaries = w.summaries || []; state.currentNodeId = w.currentNodeId || (state.nodes.length ? state.nodes[0].id : null);
                state.selectedNodeId = null;
                renderCanvas(); refreshArchive(); refreshWorlds(); toast("已切换至: " + w.name);
            };
        });
        container.querySelectorAll(".tlg-worlds-rename").forEach(function(btn) {
            btn.onclick = function() {
                var w = worlds[btn.dataset.wid]; if (!w) return;
                var name = prompt("新世界名称：", w.name); if (name === null) return; name = name.trim(); if (!name) return;
                w.name = name;
                saveWorlds(); refreshWorlds(); toast("已重命名。");
            };
        });
        container.querySelectorAll(".tlg-worlds-export").forEach(function(btn) {
            btn.onclick = function() {
                var w = worlds[btn.dataset.wid]; if (!w) return;
                var json = JSON.stringify(w, null, 2);
                var blob = new Blob([json], { type: "application/json" });
                var a = document.createElement("a"); a.href = URL.createObjectURL(blob);
                a.download = "TLG_" + (w.name || "world") + ".json"; a.click();
                toast("已导出: " + w.name);
            };
        });
        container.querySelectorAll(".tlg-worlds-del").forEach(function(btn) {
            btn.onclick = function() {
                var wid = btn.dataset.wid; var w = worlds[wid]; if (!w) return;
                if (!confirm("删除世界「" + w.name + "」？此操作不可恢复。")) return;
                delete worlds[wid];
                if (currentWorldId === wid) { currentWorldId = null; resetState(); }
                saveWorlds(); refreshWorlds(); renderCanvas(); refreshArchive(); toast("世界已删除。");
            };
        });
    }

    function importWorld() {
        var input = document.createElement("input"); input.type = "file"; input.accept = ".json";
        input.onchange = function() {
            var file = input.files[0]; if (!file) return;
            var reader = new FileReader();
            reader.onload = function() {
                try {
                    var data = JSON.parse(reader.result);
                    if (!data.nodes || !data.nodes.length) { toast("文件格式无效。"); return; }
                    var wid = data.id || generateId();
                    if (worlds[wid]) wid = generateId();
                    data.id = wid;
                    worlds[wid] = data;
                    saveWorlds(); refreshWorlds(); toast("已导入世界: " + (data.name || wid));
                } catch (e) { toast("导入失败: " + e.message); }
            };
            reader.readAsText(file);
        };
        input.click();
    }

    function createNewWorldManual() {
        var chatId = getCurrentChatId();
        var name = prompt("新世界名称：", chatId || ("世界 " + (Object.keys(worlds).length + 1)));
        if (name === null) return;
        name = name.trim() || ("世界 " + (Object.keys(worlds).length + 1));
        var wid = generateId();
        var rootId = generateId();
        worlds[wid] = {
            id: wid, name: name, chatId: chatId,
            nodes: [{ id: rootId, name: "起源点", brief: "时间线起源。", parentId: null, msgIdx: 0, statData: null, timestamp: Date.now(), children: [] }],
            summaries: [], currentNodeId: rootId, pinnedPaths: [],
            createdAt: Date.now(), updatedAt: Date.now()
        };
        currentWorldId = wid;
        setLinkedWorldId(wid);
        state.nodes = worlds[wid].nodes;
        state.summaries = [];
        state.currentNodeId = rootId;
        state.selectedNodeId = null;
        saveWorlds();
        toast("✦ 新世界已创建: " + name);
        refreshWorlds(); renderCanvas(); refreshArchive();
    }

    // ══════════════════════════════════════
    // API 模型列表拉取
    // ══════════════════════════════════════
    function fetchModelList(type, retryCount) {
        retryCount = retryCount || 0;
        var MAX_RETRIES = 3;
        var url, key, listField;
        if (type === "vector") {
            url = (globalApi.vectorUrl || "").trim();
            key = (globalApi.vectorKey || "").trim();
            listField = "vectorModelList";
        } else if (type === "rerank") {
            url = (globalApi.rerankUrl || "").trim();
            key = (globalApi.rerankKey || "").trim();
            listField = "rerankModelList";
        } else {
            url = (globalApi.apiUrl || "").trim();
            key = (globalApi.apiKey || "").trim();
            listField = "modelList";
        }
        if (!url) { toast("请先填写" + (type === "vector" ? "向量" : type === "rerank" ? "重排" : "主") + "API地址。"); return; }
        toast("拉取模型列表…");
        var endpoint = buildEndpoint(url, "/models");
        fetch(endpoint, {
            headers: key ? { Authorization: "Bearer " + key } : {}
        }).then(function(r) {
            if (!r.ok) throw new Error("HTTP " + r.status);
            return r.json();
        }).then(function(data) {
            var models = (data.data || data.models || []).map(function(m) {
                return typeof m === "string" ? m : (m.id || m.name || "");
            }).filter(Boolean);
            globalApi[listField] = models;
            saveGlobalApi();
            toast("✓ 获取到 " + models.length + " 个模型。");
            populateModelSelect(type);
        }).catch(function(e) {
            if (retryCount < MAX_RETRIES) {
                var delay = (retryCount + 1) * 1500;
                toast("⚠ 拉取失败，" + delay / 1000 + "秒后重试 (" + (retryCount + 1) + "/" + MAX_RETRIES + ")…");
                setTimeout(function() { fetchModelList(type, retryCount + 1); }, delay);
            } else {
                toast("✗ 拉取模型列表最终失败: " + e.message);
            }
        });
    }

    function populateModelSelect(type) {
        var selId, list, currentModel;
        if (type === "vector") { selId = "tlg-vec-model-select"; list = globalApi.vectorModelList || []; currentModel = globalApi.vectorModel; }
        else if (type === "rerank") { selId = "tlg-rerank-model-select"; list = globalApi.rerankModelList || []; currentModel = globalApi.rerankModel; }
        else { selId = "tlg-model-select"; list = globalApi.modelList || []; currentModel = globalApi.model; }
        var sel = document.getElementById(selId); if (!sel) return;
        sel.innerHTML = '<option value="">-- 选择模型 --</option>' +
            list.map(function(m) { return '<option value="' + escHtml(m) + '"' + (m === currentModel ? " selected" : "") + '>' + escHtml(m) + '</option>'; }).join("");
        if (currentModel && list.indexOf(currentModel) === -1) {
            sel.innerHTML += '<option value="' + escHtml(currentModel) + '" selected>' + escHtml(currentModel) + '</option>';
        }
    }

    function testApiConnection(type) {
        var url, key, label;
        if (type === "vector") { url = (globalApi.vectorUrl || "").trim(); key = (globalApi.vectorKey || "").trim(); label = "向量API"; }
        else if (type === "rerank") { url = (globalApi.rerankUrl || "").trim(); key = (globalApi.rerankKey || "").trim(); label = "重排API"; }
        else { url = (globalApi.apiUrl || "").trim(); key = (globalApi.apiKey || "").trim(); label = "主API"; }
        if (!url) { toast("请先填写" + label + "地址。"); return; }
        toast("测试 " + label + " 连接…");
        fetch(buildEndpoint(url, "/models"), {
            headers: key ? { Authorization: "Bearer " + key } : {}
        }).then(function(r) {
            if (r.ok) toast("✓ " + label + " 连接成功。");
            else toast("✗ " + label + " HTTP " + r.status);
        }).catch(function(e) { toast("✗ " + label + " 连接失败: " + e.message); });
    }

    // ══════════════════════════════════════
    // Tab 切换
    // ══════════════════════════════════════
    function switchTab(name) {
        var panel = document.getElementById("tlg-panel"); if (!panel) return;
        panel.querySelectorAll(".tlg-tab").forEach(function(t) { t.classList.toggle("active", t.dataset.tab === name); });
        panel.querySelectorAll(".tlg-panel-view").forEach(function(p) { p.classList.remove("active"); });
        var target = document.getElementById("tlg-view-" + name);
        if (target) target.classList.add("active");
        if (name === "tree") { setTimeout(function() { renderCanvas(); centerOnCurrentNode(); }, 50); }
        else if (name === "archive") { refreshArchive(); }
        else if (name === "summary") { refreshSummary(); }
        else if (name === "engine") { populateModelSelect("main"); populateModelSelect("vector"); populateModelSelect("rerank"); }
        else if (name === "worlds") { refreshWorlds(); }
    }

    // ══════════════════════════════════════
    // 面板 HTML 构建
    // ══════════════════════════════════════
    function ensurePanelBuilt() {
        if (document.getElementById("tlg-panel")) return;
        var panel = document.createElement("div"); panel.id = "tlg-panel";
        panel.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100dvh;background:#000000;z-index:99999;display:flex;flex-direction:column;font-family:'Segoe UI',sans-serif;color:#c0c0c8;overflow:hidden;";
        panel.innerHTML =
            // Tab bar
            '<div style="display:flex;height:44px;border-bottom:1px solid #1a1a28;background:#050508;flex-shrink:0;overflow-x:auto;">' +
                '<div class="tlg-tab active" data-tab="tree" style="padding:0 18px;height:100%;display:flex;align-items:center;cursor:pointer;font-size:12px;color:#6a6a78;border-bottom:2px solid transparent;white-space:nowrap;">🌿 命运分支线</div>' +
                '<div class="tlg-tab" data-tab="archive" style="padding:0 18px;height:100%;display:flex;align-items:center;cursor:pointer;font-size:12px;color:#6a6a78;border-bottom:2px solid transparent;white-space:nowrap;">📁 观测坐标</div>' +
                '<div class="tlg-tab" data-tab="summary" style="padding:0 18px;height:100%;display:flex;align-items:center;cursor:pointer;font-size:12px;color:#6a6a78;border-bottom:2px solid transparent;white-space:nowrap;">📝 因果档案</div>' +
                '<div class="tlg-tab" data-tab="engine" style="padding:0 18px;height:100%;display:flex;align-items:center;cursor:pointer;font-size:12px;color:#6a6a78;border-bottom:2px solid transparent;white-space:nowrap;">⚙️ 引擎核心</div>' +
                '<div class="tlg-tab" data-tab="worlds" style="padding:0 18px;height:100%;display:flex;align-items:center;cursor:pointer;font-size:12px;color:#6a6a78;border-bottom:2px solid transparent;white-space:nowrap;">🌐 诸世界</div>' +
                '<div id="tlg-close-btn" style="margin-left:auto;padding:0 16px;display:flex;align-items:center;cursor:pointer;color:#6a6a78;font-size:18px;">✕</div>' +
            '</div>' +
            // Tab content
            '<div style="flex:1;overflow:hidden;position:relative;">' +
                // Tree
                '<div class="tlg-panel-view active" id="tlg-view-tree" style="position:absolute;inset:0;display:none;flex-direction:row;">' +
                    '<div id="tlg-canvas-wrap" style="flex:1;position:relative;overflow:hidden;">' +
                        '<canvas id="tlg-tree-canvas" style="position:absolute;inset:0;width:100%;height:100%;cursor:grab;"></canvas>' +
                        '<div style="position:absolute;top:12px;left:12px;display:flex;gap:8px;z-index:2;flex-wrap:wrap;">' +
                            '<button type="button" class="tlg-btn" id="tlg-canvas-anchor" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">⚓ 锚定</button>' +
                            '<button type="button" class="tlg-btn" id="tlg-canvas-reset" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">⊙ 归位</button>' +
                        '</div>' +
                    '</div>' +
                    '<div id="tlg-brief-panel" style="width:0;background:#050508;border-left:1px solid #1a1a28;transition:width 0.3s;overflow:hidden;display:flex;flex-direction:column;">' +
                        '<div class="tlg-brief-header" style="padding:14px 16px;border-bottom:1px solid #1a1a28;font-size:13px;font-weight:600;color:#e8e8f0;display:flex;justify-content:space-between;align-items:center;flex-shrink:0;"><span>节点</span><button type="button" class="tlg-btn" id="tlg-brief-close" style="padding:2px 8px;writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">✕</button></div>' +
                        '<div class="tlg-brief-body" style="flex:1;overflow-y:auto;padding:14px 16px;font-size:12px;line-height:1.7;"></div>' +
                        '<div class="tlg-brief-footer" style="padding:10px 16px;border-top:1px solid #1a1a28;flex-shrink:0;"></div>' +
                    '</div>' +
                '</div>' +
                // Archive
                '<div class="tlg-panel-view" id="tlg-view-archive" style="position:absolute;inset:0;display:none;flex-direction:column;overflow-y:auto;padding:16px;">' +
                    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:8px;">' +
                        '<div style="font-size:14px;font-weight:600;color:#e8e8f0;">观测坐标</div>' +
                        '<button type="button" class="tlg-btn tlg-btn-primary" id="tlg-archive-new" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">⚓ 新锚点</button>' +
                    '</div>' +
                    '<div id="tlg-pinned-paths" style="margin-bottom:14px;"></div>' +
                    '<div id="tlg-archive-list"></div>' +
                '</div>' +
                // Summary
                '<div class="tlg-panel-view" id="tlg-view-summary" style="position:absolute;inset:0;display:none;flex-direction:column;overflow-y:auto;padding:16px;gap:14px;">' +
                    '<div style="background:#050508;border:1px solid #1a1a28;border-radius:4px;padding:14px;">' +
                        '<div style="font-size:13px;font-weight:600;color:#e8e8f0;margin-bottom:10px;">总结控制</div>' +
                        '<div style="display:flex;gap:10px;align-items:center;margin-bottom:8px;flex-wrap:wrap;">' +
                            '<span style="font-size:12px;color:#7a7a8a;">自动模式</span>' +
                            '<div class="tlg-toggle ' + (globalApi.autoMode ? "on" : "") + '" id="tlg-auto-toggle" style="position:relative;width:36px;height:20px;background:#1a1a28;border-radius:10px;cursor:pointer;flex-shrink:0;"></div>' +
                            '<span style="font-size:12px;color:#7a7a8a;margin-left:12px;">每</span>' +
                            '<input class="tlg-input" id="tlg-auto-interval" type="number" min="1" max="100" value="' + (globalApi.autoInterval || 10) + '" style="width:50px;padding:4px 6px;" />' +
                            '<span style="font-size:12px;color:#7a7a8a;">回合提醒</span>' +
                        '</div>' +
                        '<div style="display:flex;gap:10px;align-items:center;margin-bottom:8px;flex-wrap:wrap;">' +
                            '<span style="font-size:12px;color:#7a7a8a;">跳转后保留最近</span>' +
                            '<input class="tlg-input" id="tlg-last-n" type="number" min="1" max="100" value="' + (globalApi.lastNMessages || 5) + '" style="width:50px;padding:4px 6px;" />' +
                            '<span style="font-size:12px;color:#7a7a8a;">条消息可见</span>' +
                        '</div>' +
                        '<div style="display:flex;gap:10px;align-items:center;margin-bottom:8px;flex-wrap:wrap;">' +
                            '<span style="font-size:12px;color:#7a7a8a;">跳转前自动总结</span>' +
                            '<div class="tlg-toggle ' + (globalApi.jumpSummary ? "on" : "") + '" id="tlg-jump-summary-toggle" style="position:relative;width:36px;height:20px;background:#1a1a28;border-radius:10px;cursor:pointer;flex-shrink:0;"></div>' +
                        '</div>' +
                        '<div style="display:flex;gap:10px;align-items:center;margin-bottom:10px;flex-wrap:wrap;">' +
                            '<span style="font-size:12px;color:#7a7a8a;">手动总结条数</span>' +
                            '<input class="tlg-input" id="tlg-manual-count" type="number" min="1" max="200" value="' + (globalApi.manualCount || 20) + '" style="width:50px;padding:4px 6px;" />' +
                        '</div>' +
                        '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
                            '<button type="button" class="tlg-btn tlg-btn-primary" id="tlg-summary-manual-btn" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">▶ 手动总结</button>' +
                            '<button type="button" class="tlg-btn" id="tlg-summary-catchup-btn" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">📋 补全历史</button>' +
                            '<button type="button" class="tlg-btn" id="tlg-summary-compress-btn" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">🗜 压缩档案</button>' +
                        '</div>' +
                    '</div>' +
                    '<div style="background:#050508;border:1px solid #1a1a28;border-radius:4px;padding:14px;">' +
                        '<div style="font-size:13px;font-weight:600;color:#e8e8f0;margin-bottom:10px;">总结提示词</div>' +
                        '<label class="tlg-label" style="font-size:11px;color:#7a7a8a;margin-bottom:4px;display:block;">总结Prompt（用 {{context}} 代表对话内容）</label>' +
                        '<textarea class="tlg-textarea" id="tlg-summary-prompt" style="min-height:140px;font-size:11px;">' + escHtml(globalApi.summaryPrompt) + '</textarea>' +
                        '<label class="tlg-label" style="font-size:11px;color:#7a7a8a;margin-top:10px;margin-bottom:4px;display:block;">压缩Prompt（用 {{context}} 代表档案内容）</label>' +
                        '<textarea class="tlg-textarea" id="tlg-compress-prompt" style="min-height:80px;font-size:11px;">' + escHtml(globalApi.compressPrompt) + '</textarea>' +
                        '<label class="tlg-label" style="font-size:11px;color:#7a7a8a;margin-top:10px;margin-bottom:4px;display:block;">路径摘要Prompt（用 {{context}} 代表路径信息）</label>' +
                        '<textarea class="tlg-textarea" id="tlg-path-summary-prompt" style="min-height:80px;font-size:11px;">' + escHtml(globalApi.pathSummaryPrompt) + '</textarea>' +
                        '<button type="button" class="tlg-btn tlg-btn-primary" id="tlg-save-prompts" style="margin-top:10px;width:100%;">保存提示词</button>' +
                    '</div>' +
                    '<div style="background:#050508;border:1px solid #1a1a28;border-radius:4px;padding:14px;">' +
                        '<div style="font-size:13px;font-weight:600;color:#e8e8f0;margin-bottom:10px;">因果档案列表</div>' +
                        '<div id="tlg-summary-list"></div>' +
                    '</div>' +
                '</div>' +
                // Engine
                '<div class="tlg-panel-view" id="tlg-view-engine" style="position:absolute;inset:0;display:none;flex-direction:column;overflow-y:auto;padding:16px;gap:14px;">' +
                    // 主API
                    '<div style="background:#050508;border:1px solid #1a1a28;border-radius:4px;padding:14px;">' +
                        '<div style="font-size:13px;font-weight:600;color:#e8e8f0;margin-bottom:10px;">🔮 主API（总结/路径生成）</div>' +
                        '<label class="tlg-label">API 地址</label>' +
                        '<div style="display:flex;gap:8px;margin-bottom:8px;"><input class="tlg-input" id="tlg-api-url" placeholder="https://api.openai.com" value="' + escHtml(globalApi.apiUrl) + '" style="flex:1;" /><button type="button" class="tlg-btn" id="tlg-test-main-api" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">测试</button></div>' +
                        '<label class="tlg-label">API Key</label>' +
                        '<input class="tlg-input" id="tlg-api-key" type="password" placeholder="sk-…" value="' + escHtml(globalApi.apiKey) + '" style="margin-bottom:8px;" />' +
                        '<label class="tlg-label">模型</label>' +
                        '<div style="display:flex;gap:8px;margin-bottom:6px;"><select class="tlg-select" id="tlg-model-select" style="flex:1;"></select><button type="button" class="tlg-btn" id="tlg-fetch-main-models" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">拉取列表</button></div>' +
                        '<input class="tlg-input" id="tlg-model-manual" placeholder="或手动输入模型名" value="' + escHtml(globalApi.model) + '" />' +
                    '</div>' +
                    // 向量API
                    '<div style="background:#050508;border:1px solid #1a1a28;border-radius:4px;padding:14px;">' +
                        '<div style="font-size:13px;font-weight:600;color:#e8e8f0;margin-bottom:10px;">🧲 向量API（嵌入/检索）</div>' +
                        '<label class="tlg-label">向量API 地址</label>' +
                        '<div style="display:flex;gap:8px;margin-bottom:8px;"><input class="tlg-input" id="tlg-vec-url" placeholder="https://api.openai.com" value="' + escHtml(globalApi.vectorUrl) + '" style="flex:1;" /><button type="button" class="tlg-btn" id="tlg-test-vec-api" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">测试</button></div>' +
                        '<label class="tlg-label">向量API Key</label>' +
                        '<input class="tlg-input" id="tlg-vec-key" type="password" value="' + escHtml(globalApi.vectorKey) + '" style="margin-bottom:8px;" />' +
                        '<label class="tlg-label">嵌入模型</label>' +
                        '<div style="display:flex;gap:8px;margin-bottom:6px;"><select class="tlg-select" id="tlg-vec-model-select" style="flex:1;"></select><button type="button" class="tlg-btn" id="tlg-fetch-vec-models" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">拉取列表</button></div>' +
                        '<input class="tlg-input" id="tlg-vec-model-manual" placeholder="text-embedding-ada-002" value="' + escHtml(globalApi.vectorModel) + '" style="margin-bottom:8px;" />' +
                        '<label class="tlg-label">召回数量 (Top-K)</label>' +
                        '<input class="tlg-input" id="tlg-vec-topk" type="number" min="1" max="50" value="' + (globalApi.vectorTopK || 8) + '" style="width:80px;margin-bottom:8px;" />' +
                        '<label class="tlg-label">检索注入Prompt（用 {{context}} 代表检索结果）</label>' +
                        '<textarea class="tlg-textarea" id="tlg-vec-prompt" style="min-height:100px;font-size:11px;">' + escHtml(globalApi.vectorPrompt) + '</textarea>' +
                    '</div>' +
                    // 重排API
                    '<div style="background:#050508;border:1px solid #1a1a28;border-radius:4px;padding:14px;">' +
                        '<div style="font-size:13px;font-weight:600;color:#e8e8f0;margin-bottom:10px;">🔄 重排API（Rerank）</div>' +
                        '<div style="font-size:11px;color:#7a7a8a;margin-bottom:10px;">可选。对向量召回结果进行二次排序，提升相关性。</div>' +
                        '<label class="tlg-label">重排API 地址</label>' +
                        '<div style="display:flex;gap:8px;margin-bottom:8px;"><input class="tlg-input" id="tlg-rerank-url" placeholder="https://api.cohere.com" value="' + escHtml(globalApi.rerankUrl) + '" style="flex:1;" /><button type="button" class="tlg-btn" id="tlg-test-rerank-api" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">测试</button></div>' +
                        '<label class="tlg-label">重排API Key</label>' +
                        '<input class="tlg-input" id="tlg-rerank-key" type="password" value="' + escHtml(globalApi.rerankKey) + '" style="margin-bottom:8px;" />' +
                        '<label class="tlg-label">重排模型</label>' +
                        '<div style="display:flex;gap:8px;margin-bottom:6px;"><select class="tlg-select" id="tlg-rerank-model-select" style="flex:1;"></select><button type="button" class="tlg-btn" id="tlg-fetch-rerank-models" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">拉取列表</button></div>' +
                        '<input class="tlg-input" id="tlg-rerank-model-manual" placeholder="rerank-multilingual-v3.0" value="' + escHtml(globalApi.rerankModel) + '" style="margin-bottom:8px;" />' +
                        '<label class="tlg-label">重排后保留数量 (Top-N)</label>' +
                        '<input class="tlg-input" id="tlg-rerank-topn" type="number" min="1" max="20" value="' + (globalApi.rerankTopN || 3) + '" style="width:80px;" />' +
                    '</div>' +
                    // 保存按钮
                    '<button type="button" class="tlg-btn tlg-btn-primary" id="tlg-engine-save" style="width:100%;padding:12px;font-size:13px;">💾 保存所有引擎设置</button>' +
                '</div>' +
                // Worlds
                '<div class="tlg-panel-view" id="tlg-view-worlds" style="position:absolute;inset:0;display:none;flex-direction:column;overflow-y:auto;padding:16px;">' +
                    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:8px;">' +
                        '<div style="font-size:14px;font-weight:600;color:#e8e8f0;">诸世界</div>' +
                        '<div style="display:flex;gap:8px;">' +
                            '<button type="button" class="tlg-btn tlg-btn-primary" id="tlg-worlds-create" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">✦ 创建新世界</button>' +
                            '<button type="button" class="tlg-btn" id="tlg-worlds-import" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">↑ 导入世界</button>' +
                        '</div>' +
                    '</div>' +
                    '<div id="tlg-worlds-list"></div>' +
                '</div>' +
            '</div>';

        document.body.appendChild(panel);
        injectPanelStyles();
        bindPanelEvents(panel);
    }

    function injectPanelStyles() {
        if (document.getElementById("tlg-styles")) return;
        var style = document.createElement("style"); style.id = "tlg-styles";
        style.textContent = [
            '.tlg-tab.active { color:#e8e8f0!important; border-bottom-color:#c0c0c8!important; background:#0a0a14!important; }',
            '.tlg-panel-view.active { display:flex!important; }',
            '.tlg-input,.tlg-textarea,.tlg-select { width:100%;padding:8px 10px;background:#0a0a14;border:1px solid #1a1a28;border-radius:4px;color:#c0c0c8;font-size:12px;outline:none; }',
            '.tlg-input:focus,.tlg-textarea:focus,.tlg-select:focus { border-color:#4a4a5a; }',
            '.tlg-textarea { resize:vertical;min-height:60px;line-height:1.6;font-family:Consolas,Monaco,monospace; }',
            '.tlg-label { display:block;font-size:11px;color:#7a7a8a;margin-bottom:4px; }',
            '.tlg-btn { padding:6px 12px;border:1px solid #2a2a3a;background:#0a0a14;color:#c0c0c8;border-radius:4px;cursor:pointer;font-size:11px;transition:all 0.2s;writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto; }',
            '.tlg-btn:hover { border-color:#5a5a6a;background:#12121e; }',
            '.tlg-btn:disabled { opacity:0.4;cursor:not-allowed; }',
            '.tlg-btn-primary { background:rgba(192,192,200,0.08);border-color:#4a4a5a; }',
            '.tlg-btn-primary:hover { background:rgba(192,192,200,0.15);border-color:#8a8a9a; }',
            '.tlg-btn-danger { border-color:#aa4444;color:#aa4444; }',
            '.tlg-btn-danger:hover { background:rgba(170,68,68,0.12); }',
            '.tlg-btn-jump { width:100%;padding:10px;background:rgba(192,192,200,0.06);border:1px solid #4a4a5a;color:#e8e8f0;font-size:12px;font-weight:500; }',
            '.tlg-btn-jump:hover { background:rgba(192,192,200,0.14);border-color:#8a8a9a;box-shadow:0 0 10px rgba(192,192,200,0.15); }',
            '.tlg-toggle { position:relative;width:36px;height:20px;background:#1a1a28;border-radius:10px;cursor:pointer;transition:background 0.2s;flex-shrink:0; }',
            '.tlg-toggle::after { content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;background:#c0c0c8;border-radius:50%;transition:transform 0.2s; }',
            '.tlg-toggle.on { background:#5a5a8a; }',
            '.tlg-toggle.on::after { transform:translateX(16px); }',
            '.tlg-archive-card { background:#050508;border:1px solid #1a1a28;border-radius:4px;padding:12px 14px;margin-bottom:10px;transition:all 0.2s; }',
            '.tlg-archive-card:hover { border-color:#3a3a4a; }',
            '.tlg-archive-card.current { border-color:#6a6a8a;box-shadow:0 0 8px rgba(192,192,200,0.1); }',
            '.tlg-archive-title { font-size:13px;font-weight:600;color:#e8e8f0;margin-bottom:4px; }',
            '.tlg-archive-meta { font-size:11px;color:#5a5a6a;margin-bottom:4px; }',
            '.tlg-archive-brief { font-size:12px;color:#8a8a9a;line-height:1.5; }',
            '.tlg-modal { background:#0a0a14;border:1px solid #2a2a3a;border-radius:6px;padding:20px;width:420px;max-width:90vw;box-shadow:0 0 40px rgba(0,0,0,0.8); }',
            '.tlg-modal-title { font-size:15px;font-weight:600;color:#e8e8f0;margin-bottom:14px; }',
            '.tlg-modal-actions { display:flex;justify-content:flex-end;gap:8px;margin-top:14px;flex-wrap:wrap; }',
            '#tlg-brief-panel.open { width:340px; }',
            '#tlg-panel *::-webkit-scrollbar { width:5px; }',
            '#tlg-panel *::-webkit-scrollbar-track { background:transparent; }',
            '#tlg-panel *::-webkit-scrollbar-thumb { background:#2a2a3a;border-radius:3px; }',
        ].join("\n");
        document.head.appendChild(style);
    }

    function bindPanelEvents(panel) {
        // Close
        document.getElementById("tlg-close-btn").onclick = function() { closePanel(); };

        // Tabs
        panel.querySelectorAll(".tlg-tab").forEach(function(tab) {
            tab.onclick = function() { switchTab(tab.dataset.tab); };
        });

        // Brief panel
        document.getElementById("tlg-brief-close").onclick = function() { closeBriefPanel(); };

        // Tree buttons
        document.getElementById("tlg-canvas-anchor").onclick = function() { showAnchorModal(); };
        document.getElementById("tlg-canvas-reset").onclick = function() { camX = 0; camY = 0; camZoom = 1; centerOnCurrentNode(); renderCanvas(); };

        // Archive
        document.getElementById("tlg-archive-new").onclick = function() { showAnchorModal(); };

        // Summary controls
        document.getElementById("tlg-auto-toggle").onclick = function() {
            globalApi.autoMode = !globalApi.autoMode;
            this.classList.toggle("on", globalApi.autoMode); saveGlobalApi();
        };
        document.getElementById("tlg-jump-summary-toggle").onclick = function() {
            globalApi.jumpSummary = !globalApi.jumpSummary;
            this.classList.toggle("on", globalApi.jumpSummary); saveGlobalApi();
        };
        document.getElementById("tlg-auto-interval").onchange = function() {
            globalApi.autoInterval = Math.max(1, parseInt(this.value) || 10); saveGlobalApi();
        };
        document.getElementById("tlg-last-n").onchange = function() {
            globalApi.lastNMessages = Math.max(1, parseInt(this.value) || 5); saveGlobalApi();
        };
        document.getElementById("tlg-manual-count").onchange = function() {
            globalApi.manualCount = Math.max(1, parseInt(this.value) || 20); saveGlobalApi();
        };
        document.getElementById("tlg-summary-manual-btn").onclick = function() { runManualSummary(); };
        document.getElementById("tlg-summary-catchup-btn").onclick = function() { runCatchupSummary(); };
        document.getElementById("tlg-summary-compress-btn").onclick = function() { compressSummaries(); };

        // Prompt save
        document.getElementById("tlg-save-prompts").onclick = function() {
            globalApi.summaryPrompt = document.getElementById("tlg-summary-prompt").value;
            globalApi.compressPrompt = document.getElementById("tlg-compress-prompt").value;
            globalApi.pathSummaryPrompt = document.getElementById("tlg-path-summary-prompt").value;
            saveGlobalApi(); toast("✓ 提示词已保存。"); flashBtn(this);
        };

        // Engine events
        document.getElementById("tlg-test-main-api").onclick = function() { testApiConnection("main"); };
        document.getElementById("tlg-test-vec-api").onclick = function() { testApiConnection("vector"); };
        document.getElementById("tlg-test-rerank-api").onclick = function() { testApiConnection("rerank"); };
        document.getElementById("tlg-fetch-main-models").onclick = function() { fetchModelList("main"); };
        document.getElementById("tlg-fetch-vec-models").onclick = function() { fetchModelList("vector"); };
        document.getElementById("tlg-fetch-rerank-models").onclick = function() { fetchModelList("rerank"); };

        // Model select sync
        document.getElementById("tlg-model-select").onchange = function() {
            if (this.value) document.getElementById("tlg-model-manual").value = this.value;
        };
        document.getElementById("tlg-vec-model-select").onchange = function() {
            if (this.value) document.getElementById("tlg-vec-model-manual").value = this.value;
        };
        document.getElementById("tlg-rerank-model-select").onchange = function() {
            if (this.value) document.getElementById("tlg-rerank-model-manual").value = this.value;
        };

        // Engine save
        document.getElementById("tlg-engine-save").onclick = function() {
            globalApi.apiUrl = document.getElementById("tlg-api-url").value.trim();
            globalApi.apiKey = document.getElementById("tlg-api-key").value.trim();
            globalApi.model = document.getElementById("tlg-model-manual").value.trim() || document.getElementById("tlg-model-select").value;
            globalApi.vectorUrl = document.getElementById("tlg-vec-url").value.trim();
            globalApi.vectorKey = document.getElementById("tlg-vec-key").value.trim();
            globalApi.vectorModel = document.getElementById("tlg-vec-model-manual").value.trim() || document.getElementById("tlg-vec-model-select").value;
            globalApi.vectorTopK = Math.max(1, parseInt(document.getElementById("tlg-vec-topk").value) || 8);
            globalApi.vectorPrompt = document.getElementById("tlg-vec-prompt").value;
            globalApi.rerankUrl = document.getElementById("tlg-rerank-url").value.trim();
            globalApi.rerankKey = document.getElementById("tlg-rerank-key").value.trim();
            globalApi.rerankModel = document.getElementById("tlg-rerank-model-manual").value.trim() || document.getElementById("tlg-rerank-model-select").value;
            globalApi.rerankTopN = Math.max(1, parseInt(document.getElementById("tlg-rerank-topn").value) || 3);
            saveGlobalApi();
            toast("✓ 引擎设置已保存。"); flashBtn(this);
        };

        // Worlds
        document.getElementById("tlg-worlds-create").onclick = function() { createNewWorldManual(); };
        document.getElementById("tlg-worlds-import").onclick = function() { importWorld(); };

        // Canvas events
        initCanvasEvents();
    }

    function initCanvasEvents() {
        var wrap = document.getElementById("tlg-canvas-wrap"); if (!wrap) return;
        canvas = document.getElementById("tlg-tree-canvas");
        ctx = canvas.getContext("2d");

        canvas.addEventListener("mousedown", function(e) {
            if (e.button !== 0) return;
            var hit = canvasHitTest(e.clientX, e.clientY);
            if (hit) { openBriefPanel(hit); triggerRipple(0, 0); renderCanvas(); return; }
            isPanning = true; panStartX = e.clientX - camX; panStartY = e.clientY - camY;
            canvas.style.cursor = "grabbing";
        });
        canvas.addEventListener("mousemove", function(e) {
            if (!isPanning) return;
            camX = e.clientX - panStartX; camY = e.clientY - panStartY; renderCanvas();
        });
        canvas.addEventListener("mouseup", function() { isPanning = false; canvas.style.cursor = "grab"; });
        canvas.addEventListener("mouseleave", function() { isPanning = false; canvas.style.cursor = "grab"; });
        canvas.addEventListener("wheel", function(e) {
            e.preventDefault();
            var factor = e.deltaY < 0 ? 1.12 : 0.89;
            camZoom = Math.max(0.15, Math.min(5, camZoom * factor)); renderCanvas();
        }, { passive: false });

        // Touch
        var lastTouchDist = 0;
        canvas.addEventListener("touchstart", function(e) {
            if (e.touches.length === 1) {
                var hit = canvasHitTest(e.touches[0].clientX, e.touches[0].clientY);
                if (hit) { openBriefPanel(hit); renderCanvas(); return; }
                isPanning = true; panStartX = e.touches[0].clientX - camX; panStartY = e.touches[0].clientY - camY;
            } else if (e.touches.length === 2) {
                isPanning = false;
                lastTouchDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
            }
        }, { passive: true });
        canvas.addEventListener("touchmove", function(e) {
            if (e.touches.length === 1 && isPanning) {
                camX = e.touches[0].clientX - panStartX; camY = e.touches[0].clientY - panStartY; renderCanvas();
            } else if (e.touches.length === 2) {
                var dist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
                if (lastTouchDist > 0) { camZoom = Math.max(0.15, Math.min(5, camZoom * (dist / lastTouchDist))); renderCanvas(); }
                lastTouchDist = dist;
            }
        }, { passive: true });
        canvas.addEventListener("touchend", function() { isPanning = false; }, { passive: true });

        // Animation loop
        function animLoop() {
            if (document.getElementById("tlg-panel")) { renderCanvas(); requestAnimationFrame(animLoop); }
        }
        requestAnimationFrame(animLoop);
    }

    // ══════════════════════════════════════
    // 打开/关闭面板
    // ══════════════════════════════════════
    function openPanel() {
        if (!isEnabled()) { toast("河岸凝视已关闭。请在菜单中启用。"); return; }
        loadCurrentWorld(); migrateOldData(); ensureWorldExists();
        ensurePanelBuilt();
        switchTab("tree");
        setTimeout(function() { centerOnCurrentNode(); renderCanvas(); refreshArchive(); }, 100);
    }

    function closePanel() {
        var panel = document.getElementById("tlg-panel"); if (panel) panel.remove();
        canvas = null; ctx = null; document.body.style.overflow = "";
    }

    // ══════════════════════════════════════
    // 菜单按钮注入
    // ══════════════════════════════════════
       function injectMenuButton() {
        var BTN_ID = "tlg-menu-btn";
        var existing = document.getElementById(BTN_ID);
        if (existing) {
            // 已存在，只更新开关状态，不重建
            var toggle = existing.querySelector("#tlg_enable_toggle");
            if (toggle) toggle.classList.toggle("on", isEnabled());
            return;
        }

        var targets = ["#extensionsMenu", "#extensionMenuItems", "#extension_menu", ".extensions_block"];
        var container = null;
        for (var i = 0; i < targets.length; i++) {
            container = document.querySelector(targets[i]);
            if (container) break;
        }
        if (!container) return;

        var btn = document.createElement("div"); btn.id = BTN_ID;
        btn.style.cssText = "cursor:pointer;padding:6px 10px;font-size:12px;color:#c0c0c8;display:flex;align-items:center;gap:6px;white-space:nowrap;border-radius:4px;transition:background 0.2s;";
        var enabled = isEnabled();
        btn.innerHTML = '<span style="font-size:15px;">🌊</span> <span>河岸凝视</span>' +
            '<div id="tlg_enable_toggle" class="tlg-toggle ' + (enabled ? "on" : "") + '" style="position:relative;width:28px;height:14px;background:#1a1a28;border-radius:7px;cursor:pointer;margin-left:6px;flex-shrink:0;"></div>';
        btn.onmouseenter = function() { btn.style.background = "rgba(255,255,255,0.04)"; };
        btn.onmouseleave = function() { btn.style.background = ""; };
        btn.onclick = function(e) {
            if (e.target.id === "tlg_enable_toggle" || (e.target.parentElement && e.target.parentElement.id === "tlg_enable_toggle")) {
                e.stopPropagation(); setEnabled(!isEnabled()); return;
            }
            var panel = document.getElementById("tlg-panel");
            if (panel) closePanel(); else openPanel();
        };
        container.appendChild(btn);

        // 也注入 toggle 样式
        injectPanelStyles();
    }

    // ══════════════════════════════════════
    // 斜杠命令
    // ══════════════════════════════════════
    function registerSlashCommand() {
        try {
            if (window.SillyTavern && window.SillyTavern.SlashCommandParser) {
                window.SillyTavern.SlashCommandParser.addCommandObject(
                    window.SillyTavern.SlashCommand.fromProps({
                        name: "tlg_anchor",
                        callback: function(args, value) {
                            if (!isEnabled()) { toast("河岸凝视已关闭。"); return ""; }
                            loadCurrentWorld(); ensureWorldExists();
                            showAnchorModal(String(value || ""));
                            return "";
                        },
                        helpString: "创建河岸凝视因果锚点。"
                    })
                );
            }
        } catch (e) { console.warn("[TLG] Slash command registration:", e); }

        try {
            var st = getST();
            if (st && typeof st.registerSlashCommand === "function") {
                st.registerSlashCommand("tlg_anchor", function(args, value) {
                    if (!isEnabled()) return "";
                    loadCurrentWorld(); ensureWorldExists();
                    showAnchorModal(String(value || ""));
                    return "";
                }, [], "创建河岸凝视因果锚点", true, true);
            }
        } catch (e) {}

        try {
            if (window.SillyTavern && window.SillyTavern.SlashCommandParser) {
                window.SillyTavern.SlashCommandParser.addCommandObject(
                    window.SillyTavern.SlashCommand.fromProps({
                        name: "tlg_open",
                        callback: function() { openPanel(); return ""; },
                        helpString: "打开河岸凝视面板。"
                    })
                );
            }
        } catch (e) {}
    }

    // ══════════════════════════════════════
    // 自动总结监听
    // ══════════════════════════════════════
    function watchAutoSummary() {
        var lastLen = 0;
        setInterval(function() {
            if (!isEnabled() || !globalApi.autoMode) return;
            var st = getST(); if (!st || !st.chat) return;
            var curLen = st.chat.length;
            if (curLen > lastLen) {
                var diff = curLen - lastLen;
                state.turnsSinceAnchor += diff;
                lastLen = curLen;
                state._lastChatLen = curLen;
                saveTurnsCounter();
                if (state.turnsSinceAnchor >= (globalApi.autoInterval || 10)) {
                    toast("⚓ 已过 " + state.turnsSinceAnchor + " 回合，建议锚定或总结。");
                    // 自动执行总结
                    var recentMsgs = st.chat.slice(-(globalApi.autoInterval || 10)).filter(function(m) { return !m._tlg_hidden; });
                    if (recentMsgs.length > 0) {
                        _doSummaryRequest(recentMsgs, true, "自动总结", function() {
                            state.turnsSinceAnchor = 0; saveTurnsCounter();
                        });
                    } else {
                        state.turnsSinceAnchor = 0; saveTurnsCounter();
                    }
                }
            } else { lastLen = curLen; }
        }, 3000);
    }

    // ══════════════════════════════════════
    // 启动
    // ══════════════════════════════════════
    function boot() {
        injectMenuButton();

        var observer = new MutationObserver(function() { injectMenuButton(); });
        observer.observe(document.body, { childList: true, subtree: true });

        registerSlashCommand();
        watchAutoSummary();

        // 监听聊天切换
        try {
            var ctx1 = getST();
            if (ctx1 && ctx1.eventSource && ctx1.eventTypes) {
                ctx1.eventSource.on(ctx1.eventTypes.CHAT_CHANGED, function() {
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

                ctx1.eventSource.on(ctx1.eventTypes.MESSAGE_RECEIVED, function() {
                    if (!isEnabled()) return;
                    loadCurrentWorld();
                    applyRecentVisibility();
                    saveCurrentWorld();
                });
            }
        } catch (e) { console.warn("[TLG] Event binding:", e); }

        loadGlobalApi();
        console.log("[TLG] 河岸凝视 v3.6 已加载。");
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", boot);
    } else {
        boot();
    }
})();


