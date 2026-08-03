/* 河岸凝视 v3.2 */
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
        lastAutoSummaryRange: null  // { floorFrom, floorTo, summaryIdx }
    };

    var globalApi = {
        apiUrl: "", apiKey: "", model: "", modelList: [],
        vectorUrl: "", vectorKey: "", vectorModel: "", vectorModelList: [],
        vectorPrompt: "以下为因果档案库中与当前观测焦点相关的历史切片：\n\n{{context}}\n\n处理规则：\n- 这些是已铭刻的因果事实，不可篡改\n- 当前叙事必须与这些记录在逻辑上连续\n- 若当前事件是某条历史线的后果，自然呈现因果关系\n- 不要直接引用或复述这些档案内容",
        summaryPrompt: "你是因果记录仪。对以下对话执行状态切片，提取并压缩为因果档案。\n\n【因果事件链】本段发生的事件，按因果顺序（A导致B导致C），每条一句\n【样本状态变动】主角的生理、心理、物品、关系的变化\n【NPC状态变动】在场NPC的行为、立场、情绪变化\n【悬置因果线】未完成的选择、未触发的后果、埋下的伏笔\n【环境快照】地点·天气·时间·在场实体\n\n对话内容：\n{{context}}\n\n要求：纯事实记录，无评论，无修辞。输出格式：纯文本，不要使用markdown标记（禁止*、**、#等符号）。直接输出内容。",
        summaryFilterMode: true,
        autoMode: false, autoInterval: 10, lastNMessages: 5,
        jumpSummary: true,
        summaryMaxCount: 100,
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
        if (typeof st.saveMetadata === "function") {
            st.saveMetadata();
        } else if (typeof window.saveMetadataDebounced === "function") {
            window.saveMetadataDebounced();
        }
        // 延迟验证，确保写入
        setTimeout(function () {
            var verify = getST();
            if (verify && verify.chat_metadata && verify.chat_metadata.tlg_worldId !== worldId) {
                if (verify.chat_metadata) verify.chat_metadata.tlg_worldId = worldId;
                if (typeof verify.saveMetadata === "function") verify.saveMetadata();
            }
        }, 800);
    }
    function loadCurrentWorld() {
        loadGlobalApi(); loadWorlds();
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
            // 防护：如果节点列表为空或无根节点，自动重建
            if (!state.nodes.length || !state.nodes.find(function(n) { return !n.parentId; })) {
                var rootId = generateId();
                state.nodes.unshift({ id: rootId, name: "起源点", brief: "时间线起源。", parentId: null, msgIdx: 0, statData: null, timestamp: Date.now(), children: [] });
                if (!state.nodes.find(function(n) { return n.id === w.currentNodeId; })) w.currentNodeId = rootId;
            }
            state.currentNodeId = w.currentNodeId || (state.nodes.length ? state.nodes[0].id : null);
            state.selectedNodeId = null;
            state.turnsSinceAnchor = w.turnsSinceAnchor || 0;
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
        worlds[currentWorldId].turnsSinceAnchor = state.turnsSinceAnchor;
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
            currentNodeId: old.currentNodeId || old.nodes[0].id, createdAt: Date.now(), updatedAt: Date.now()
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
            // 最优先：渲染脚本桥接到主窗口的快照
            if (window.__tlg_mvu_snapshot && Object.keys(window.__tlg_mvu_snapshot).length > 0) {
                return JSON.parse(JSON.stringify(window.__tlg_mvu_snapshot));
            }
            // 次优先：Mvu 框架标准接口
            if (typeof window.Mvu !== "undefined" && typeof window.Mvu.getMvuVariable === "function") {
                var v = window.Mvu.getMvuVariable("stat_data");
                if (v != null) return JSON.parse(JSON.stringify(v));
            }
            // fallback：chat_metadata 各路径
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
            // 写回桥接变量
            window.__tlg_mvu_snapshot = JSON.parse(JSON.stringify(data));
            // 尝试通过 iframe 写回 MVU
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
        // 用 is_system 隐藏（酒馆原生机制），加 _tlg_hidden 标记以便恢复
        for (i = 0; i < st.chat.length; i++) {
            if (visible[i]) {
                // 恢复：只恢复我们标记过的
                if (st.chat[i]._tlg_hidden) { delete st.chat[i].is_system; delete st.chat[i]._tlg_hidden; }
            } else {
                if (!st.chat[i].is_system) { st.chat[i].is_system = true; st.chat[i]._tlg_hidden = true; }
            }
        }
        if (typeof st.saveChat === "function") st.saveChat();
    }

    function applyRecentVisibility() {
        var st = getST(); if (!st || !st.chat || !st.chat.length) return;
        var lastN = Math.max(1, globalApi.lastNMessages || 5);
        var total = st.chat.length;
        var changed = false;
        for (var i = 0; i < total; i++) {
            if (i >= total - lastN) {
                // 可见：恢复我们标记过的
                if (st.chat[i]._tlg_hidden) { delete st.chat[i].is_system; delete st.chat[i]._tlg_hidden; changed = true; }
            } else {
                // 隐藏
                if (!st.chat[i].is_system) { st.chat[i].is_system = true; st.chat[i]._tlg_hidden = true; changed = true; }
            }
        }
        if (changed && typeof st.saveChat === "function") st.saveChat();
    }

    function createAnchor(name, brief) {
        var st = getST(); if (!st) return; ensureWorldExists();
        var msgIdx = st.chat ? Math.max(0, st.chat.length - 1) : 0;
        var parentId = state.currentNodeId; var newId = generateId();
        var newNode = { id: newId, name: name || ("节点 " + state.nodes.length), brief: brief || "", parentId: parentId, msgIdx: msgIdx, statData: getMVUStatData(), timestamp: Date.now(), children: [] };
        var parent = findNode(parentId);
        if (parent && parent.children.indexOf(newId) === -1) parent.children.push(newId);
        state.nodes.push(newNode); state.currentNodeId = newId; state.selectedNodeId = newId; state.turnsSinceAnchor = 0;
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
    // ② 跳转
    // ══════════════════════════════════════
    function jumpToNode(nodeId) {
        var node = findNode(nodeId); if (!node) { toast("节点不存在。"); return; }
        var st = getST();

        var preJumpMessages = null;
        var apiUrl = (globalApi.apiUrl || "").trim();
        if (apiUrl && globalApi.jumpSummary && st && st.chat && state.turnsSinceAnchor > 0) {
            var visible = st.chat.filter(function (m) { return !m._tlg_hidden && !m.is_hidden; });
            if (visible.length > 0) {
                preJumpMessages = visible.slice(-(globalApi.autoInterval || 10));
            }
        }

        if (node.statData != null) setMVUStatData(node.statData);

        applyVisibility(nodeId);
        state.currentNodeId = nodeId; state.turnsSinceAnchor = 0;
        saveCurrentWorld(); toast("↩ 已跳转至: " + node.name); renderCanvas(); refreshArchive(); closeBriefPanel();

        if (preJumpMessages && preJumpMessages.length > 0) {
            runSummaryWithMessages(preJumpMessages);
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
            if (floorVal !== "") {
                createAnchorAtFloor(ancName, ancBrief, parseInt(floorVal, 10) || 0);
            } else {
                createAnchor(ancName, ancBrief);
            }
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
            } else {
                ctx.strokeStyle = "rgba(140,140,160,0.4)"; ctx.lineWidth = 2; ctx.shadowBlur = 0;
            }
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
            }

            ctx.beginPath(); ctx.arc(pos.x, pos.y, NODE_R, 0, Math.PI * 2);
            if (isCurrent) { ctx.fillStyle = "#ffffff"; ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 3; }
            else if (isSelected) { ctx.fillStyle = "#2a2a3a"; ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 2.5; }
            else if (onPath) { ctx.fillStyle = "#1a1a2a"; ctx.strokeStyle = "rgba(255,255,255,0.7)"; ctx.lineWidth = 2; }
            else { ctx.fillStyle = "#0a0a12"; ctx.strokeStyle = "rgba(140,140,160,0.5)"; ctx.lineWidth = 1.5; }
            ctx.fill(); ctx.stroke();

            ctx.font = "bold 11px -apple-system, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
            ctx.fillStyle = isCurrent ? "#000000" : "#ffffff";
            label = (node.name || "").slice(0, 4); ctx.fillText(label, pos.x, pos.y);
            ctx.font = "10px -apple-system, sans-serif"; ctx.fillStyle = "rgba(255,255,255,0.5)";
            ctx.fillText("#" + (node.msgIdx || 0), pos.x, pos.y + NODE_R + 14);
        }

        if (ripple) {
            var elapsed = Date.now() - ripple.startTime, maxDur = 600;
            if (elapsed < maxDur) {
                var prog = elapsed / maxDur, r = 40 + prog * 80, alpha = 0.6 * (1 - prog);
                ctx.beginPath(); ctx.arc(ripple.x, ripple.y, r, 0, Math.PI * 2);
                ctx.strokeStyle = "rgba(255,255,255," + alpha + ")"; ctx.lineWidth = 2; ctx.stroke();
            } else { ripple = null; }
        }
        ctx.restore();
        requestAnimationFrame(renderCanvas);
    }

    function canvasHitTest(mx, my) {
        var rect = canvas.getBoundingClientRect();
        var worldX = (mx - rect.left - rect.width / 2 - camX) / camZoom;
        var worldY = (my - rect.top - rect.height / 2 - camY) / camZoom;
        var positions = layoutTree(), NODE_R = 22;
        for (var i = 0; i < state.nodes.length; i++) {
            var pos = positions[state.nodes[i].id]; if (!pos) continue;
            if (Math.hypot(worldX - pos.x, worldY - pos.y) < NODE_R + 6) return state.nodes[i].id;
        }
        return null;
    }
    function centerOnNode(nodeId) {
        var positions = layoutTree(); var pos = positions[nodeId]; if (!pos) return;
        camX = -pos.x * camZoom; camY = -pos.y * camZoom;
    }

    // ── 节点操作 ──
    function deleteNode(nodeId) {
        var node = findNode(nodeId); if (!node) return;
        // 禁止删除根节点
        if (!node.parentId) { toast("无法删除根节点（起源点）。"); return; }
        var parent = findNode(node.parentId);
        if (parent) parent.children = parent.children.filter(function (id) { return id !== nodeId; });
        function rm(id) { var n = findNode(id); if (!n) return; n.children.slice().forEach(rm); state.nodes = state.nodes.filter(function (x) { return x.id !== id; }); }
        rm(nodeId);
        // 如果删掉的是当前节点，回退到父节点
        if (state.currentNodeId === nodeId) state.currentNodeId = node.parentId;
        saveCurrentWorld(); renderCanvas(); refreshArchive(); toast("节点已删除。");
    }
    function renameNode(nodeId) {
        var node = findNode(nodeId); if (!node) return;
        var existing = document.getElementById("tlg-rename-modal"); if (existing) existing.remove();
        var backdrop = document.createElement("div"); backdrop.id = "tlg-rename-modal";
        backdrop.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100dvh;background:rgba(0,0,0,0.85);z-index:2147483647;display:flex;align-items:flex-start;justify-content:center;padding:16px;padding-top:12vh;box-sizing:border-box;";
        backdrop.innerHTML = '<div class="tlg-modal"><div class="tlg-modal-title">✏️ 重命名</div><div style="margin-bottom:12px"><input class="tlg-input" id="tlg-ren-name" value="' + escHtml(node.name) + '" /></div><div style="margin-bottom:12px"><label class="tlg-label">简要描述</label><textarea class="tlg-textarea" id="tlg-ren-brief">' + escHtml(node.brief || "") + '</textarea></div><div class="tlg-modal-actions"><button type="button" class="tlg-btn" id="tlg-ren-cancel">取消</button><button type="button" class="tlg-btn tlg-btn-primary" id="tlg-ren-ok">确认</button></div></div>';
        document.body.appendChild(backdrop);
        backdrop.querySelector("#tlg-ren-cancel").onclick = function () { backdrop.remove(); };
        backdrop.querySelector("#tlg-ren-ok").onclick = function () {
            node.name = backdrop.querySelector("#tlg-ren-name").value.trim() || node.name;
            node.brief = backdrop.querySelector("#tlg-ren-brief").value.trim();
            saveCurrentWorld(); renderCanvas(); refreshArchive(); backdrop.remove(); toast("已更新。");
        };
        backdrop.addEventListener("click", function (e) { if (e.target === backdrop) backdrop.remove(); });
    }

    // ── 嫁接 ──
    function showGraftModal(nodeId) {
        var node = findNode(nodeId); if (!node || !node.parentId) { toast("根节点不可嫁接。"); return; }
        var existing = document.getElementById("tlg-graft-modal"); if (existing) existing.remove();
        var backdrop = document.createElement("div"); backdrop.id = "tlg-graft-modal";
        backdrop.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100dvh;background:rgba(0,0,0,0.85);z-index:2147483647;display:flex;align-items:flex-start;justify-content:center;padding:16px;padding-top:12vh;box-sizing:border-box;";
        var opts = state.nodes.filter(function (n) { return n.id !== nodeId && getPathToRoot(nodeId).indexOf(n.id) === -1; });
        var optionsHtml = opts.map(function (n) {
            return '<option value="' + escHtml(n.id) + '">' + escHtml(n.name) + ' (#' + n.msgIdx + ')</option>';
        }).join("");
        backdrop.innerHTML = '<div class="tlg-modal"><div class="tlg-modal-title">🌿 嫁接节点</div><p style="font-size:12px;color:#aaa;">将【' + escHtml(node.name) + '】移动到新的父节点下:</p><div style="margin-bottom:12px"><select class="tlg-input" id="tlg-graft-target">' + optionsHtml + '</select></div><div class="tlg-modal-actions"><button type="button" class="tlg-btn" id="tlg-graft-cancel">取消</button><button type="button" class="tlg-btn tlg-btn-primary" id="tlg-graft-ok">确认嫁接</button></div></div>';
        document.body.appendChild(backdrop);
        backdrop.querySelector("#tlg-graft-cancel").onclick = function () { backdrop.remove(); };
        backdrop.querySelector("#tlg-graft-ok").onclick = function () {
            var targetId = backdrop.querySelector("#tlg-graft-target").value;
            if (!targetId) { backdrop.remove(); return; }
            var oldParent = findNode(node.parentId);
            if (oldParent) oldParent.children = oldParent.children.filter(function (id) { return id !== nodeId; });
            node.parentId = targetId;
            var newParent = findNode(targetId);
            if (newParent && newParent.children.indexOf(nodeId) === -1) newParent.children.push(nodeId);
            saveCurrentWorld(); renderCanvas(); refreshArchive(); backdrop.remove(); toast("嫁接完成。");
        };
        backdrop.addEventListener("click", function (e) { if (e.target === backdrop) backdrop.remove(); });
    }

    // ── 节点简报面板 ──
    function showBriefPanel(nodeId) {
        var node = findNode(nodeId); if (!node) return;
        closeBriefPanel();
        var panel = document.createElement("div"); panel.id = "tlg-brief-panel";
        panel.style.cssText = "position:absolute;top:10px;right:10px;width:220px;max-height:60%;background:#0a0a12;border:1px solid #2a2a3a;border-radius:6px;padding:14px;overflow-y:auto;z-index:100;color:#e0e0e8;font-size:12px;line-height:1.5;";
        var isCurrent = node.id === state.currentNodeId;
        panel.innerHTML = '<div style="font-weight:bold;margin-bottom:8px;font-size:13px;">' + escHtml(node.name) + '</div>' +
            '<div style="color:#9a9ab0;margin-bottom:6px;">楼层 #' + node.msgIdx + '</div>' +
            (node.brief ? '<div style="margin-bottom:10px;color:#c0c0d0;">' + escHtml(node.brief) + '</div>' : '') +
            '<div style="display:flex;gap:6px;flex-wrap:wrap;">' +
            (isCurrent ? '' : '<button type="button" class="tlg-btn tlg-btn-primary tlg-brief-jump" style="font-size:11px;padding:4px 10px;writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">跳转</button>') +
            '<button type="button" class="tlg-btn tlg-brief-rename" style="font-size:11px;padding:4px 10px;writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">重命名</button>' +
            '<button type="button" class="tlg-btn tlg-brief-graft" style="font-size:11px;padding:4px 10px;writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">嫁接</button>' +
            '<button type="button" class="tlg-btn tlg-btn-danger tlg-brief-del" style="font-size:11px;padding:4px 10px;writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">删除</button>' +
            '</div>';
        var canvasWrap = document.getElementById("tlg-canvas-wrap"); if (canvasWrap) canvasWrap.appendChild(panel);
        var jumpBtn = panel.querySelector(".tlg-brief-jump");
        if (jumpBtn) jumpBtn.onclick = function () { jumpToNode(nodeId); };
        panel.querySelector(".tlg-brief-rename").onclick = function () { renameNode(nodeId); closeBriefPanel(); };
        panel.querySelector(".tlg-brief-graft").onclick = function () { showGraftModal(nodeId); closeBriefPanel(); };
        panel.querySelector(".tlg-brief-del").onclick = function () { if (confirm("确认删除节点 \"" + node.name + "\"？")) { deleteNode(nodeId); closeBriefPanel(); } };
    }
    function closeBriefPanel() { var p = document.getElementById("tlg-brief-panel"); if (p) p.remove(); }

    // ══════════════════════════════════════
    // ③ 因果总结
    // ══════════════════════════════════════
    function buildEndpoint(baseUrl, path) {
        if (!baseUrl) return path;
        var url = baseUrl.replace(/\/+$/, "");
        if (url.match(/\/v1$/i)) return url + path;
        return url + "/v1" + path;
    }
    function refreshSummary() {
        var list = document.getElementById("tlg-summary-list"); if (!list) return;
        if (!state.summaries || !state.summaries.length) {
            list.innerHTML = '<div style="text-align:center;color:#6a6a7a;padding:20px;font-size:12px;">暂无提取记录。</div><button type="button" class="tlg-btn" id="tlg-summary-catchup-btn" style="width:100%;margin-top:8px;">📋 补全历史切片</button>';
            var cb = document.getElementById("tlg-summary-catchup-btn");
            if (cb) cb.addEventListener("click", function () { runCatchupSummary(); });
            return;
        }
        var latest = state.summaries[state.summaries.length - 1];
        var preview = (latest.text || "").slice(0, 120); if (latest.text && latest.text.length > 120) preview += "…";
        var latestFloor = (latest.floorFrom >= 0 && latest.floorTo >= 0) ? ' · #' + latest.floorFrom + '~#' + latest.floorTo : '';
        list.innerHTML = '<div style="background:#050508;border:1px solid #2a2a3a;border-radius:4px;padding:12px;margin-bottom:10px;"><div style="font-size:11px;color:#7a7a8a;margin-bottom:6px">最新提取 · ' + new Date(latest.timestamp).toLocaleString() + latestFloor + '</div><div style="font-size:13px;white-space:pre-wrap;max-height:80px;overflow:hidden;color:#d0d0d8;line-height:1.6;">' + escHtml(preview) + '</div></div><button type="button" class="tlg-btn tlg-btn-primary" id="tlg-summary-history-btn" style="width:100%">📜 查看完整档案记录 (' + state.summaries.length + ' 条)</button><button type="button" class="tlg-btn" id="tlg-summary-catchup-btn" style="width:100%;margin-top:8px;">📋 补全历史切片</button>';
        document.getElementById("tlg-summary-history-btn").addEventListener("click", showSummaryHistory);
        var cb2 = document.getElementById("tlg-summary-catchup-btn");
        if (cb2) cb2.addEventListener("click", function () { runCatchupSummary(); });
    }
    function refreshArchive() { refreshSummary(); }

    function showSummaryHistory() {
        var wrap = document.getElementById("tlg-summary-wrap"); if (!wrap) return;
        wrap.innerHTML = '<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;"><button type="button" class="tlg-btn" id="tlg-sh-back" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">← 返回</button><span style="font-size:13px;color:#e0e0e8;">档案记录</span><span style="font-size:11px;color:#7a7a8a;margin-left:auto;">共 ' + state.summaries.length + ' 条</span></div><div id="tlg-sh-list" style="overflow-y:auto;flex:1;"></div>';
        document.getElementById("tlg-sh-back").addEventListener("click", function () { renderSummarySection(wrap); });
        renderSummaryList();
    }
    function renderSummaryList(filter) {
        var listWrap = document.getElementById("tlg-sh-list"); if (!listWrap) return;
        var items = state.summaries;
        if (filter) items = items.filter(function (s) { return s.text && s.text.toLowerCase().indexOf(filter.toLowerCase()) !== -1; });
        listWrap.innerHTML = items.map(function (s, displayIdx) {
            var realIdx = state.summaries.indexOf(s);
            var floorInfo = (s.floorFrom >= 0 && s.floorTo >= 0) ? ' · <span style="color:#9999bb;">#' + s.floorFrom + '~#' + s.floorTo + '</span>' : '';
            return '<div class="tlg-sh-item" data-real-idx="' + realIdx + '" style="margin-bottom:10px;"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;"><span style="font-size:11px;color:#7a7a8a;">' + new Date(s.timestamp).toLocaleString() + floorInfo + '</span><span style="font-size:11px;color:#7a7a8a;">#' + (realIdx + 1) + '</span></div><div class="tlg-sh-text" id="tlg-sh-text-' + realIdx + '" style="font-size:13px;white-space:pre-wrap;word-break:break-word;line-height:1.8;max-height:200px;overflow-y:auto;color:#d0d0d8;">' + escHtml(s.text) + '</div><div id="tlg-sh-editarea-' + realIdx + '" style="display:none;margin-top:8px;"><textarea style="width:100%;min-height:120px;padding:10px;background:#000;border:1px solid #2a2a3a;border-radius:3px;color:#e0e0e8;font-size:13px;line-height:1.6;resize:vertical;box-sizing:border-box;outline:none;" id="tlg-sh-ta-' + realIdx + '">' + escHtml(s.text) + '</textarea><button type="button" class="tlg-btn tlg-btn-primary tlg-sh-save" data-idx="' + realIdx + '" style="margin-top:6px;width:100%;writing-mode:horizontal-tb;white-space:nowrap;height:auto;">保存档案</button></div><div style="margin-top:10px;display:flex;gap:8px;"><button type="button" class="tlg-btn tlg-sh-edit" data-idx="' + realIdx + '" style="font-size:11px;writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">✏️ 编辑</button><button type="button" class="tlg-btn tlg-btn-danger tlg-sh-del" data-idx="' + realIdx + '" style="font-size:11px;margin-left:auto;writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">✕ 抹除</button></div></div>';
        }).join("");
        listWrap.querySelectorAll(".tlg-sh-edit").forEach(function (btn) {
            btn.addEventListener("click", function () {
                var idx = parseInt(btn.dataset.idx, 10); var area = document.getElementById("tlg-sh-editarea-" + idx);
                if (area) area.style.display = area.style.display === "none" ? "block" : "none";
            });
        });
        listWrap.querySelectorAll(".tlg-sh-save").forEach(function (btn) {
            btn.addEventListener("click", function () {
                var idx = parseInt(btn.dataset.idx, 10); var ta = document.getElementById("tlg-sh-ta-" + idx);
                if (ta && state.summaries[idx]) { state.summaries[idx].text = ta.value; saveCurrentWorld(); renderSummaryList(); toast("已保存。"); }
            });
        });
        listWrap.querySelectorAll(".tlg-sh-del").forEach(function (btn) {
            btn.addEventListener("click", function () {
                var idx = parseInt(btn.dataset.idx, 10);
                if (confirm("确认抹除第 " + (idx + 1) + " 条？")) { state.summaries.splice(idx, 1); saveCurrentWorld(); renderSummaryList(); toast("已抹除。"); }
            });
        });
    }
    function renderSummarySection(wrap) {
        if (!wrap) wrap = document.getElementById("tlg-summary-wrap"); if (!wrap) return;
        var s = globalApi;
        wrap.innerHTML = '<div style="margin-bottom:12px"><label class="tlg-label">手动提取最近 <input id="tlg-manual-count" type="number" min="1" value="' + (s.manualCount || 20) + '" style="width:50px;background:#111;border:1px solid #333;color:#eee;border-radius:3px;padding:2px 4px;text-align:center;"> 条消息</label><button type="button" class="tlg-btn tlg-btn-primary" id="tlg-summary-run" style="margin-top:8px;width:100%">⚡ 手动切片</button></div><div id="tlg-summary-list"></div>';
        document.getElementById("tlg-summary-run").addEventListener("click", function () { runSummary(false); });
        document.getElementById("tlg-manual-count").addEventListener("change", function () { globalApi.manualCount = Math.max(1, parseInt(this.value, 10) || 20); saveGlobalApi(); });
        refreshSummary();
    }

    // ══════════════════════════════════════
    // 注入 AI（向量 / 直接）
    // ══════════════════════════════════════
    function updateInjectionWithVector() {
        var st = getST(); if (!st) return;
        if (!state.summaries || !state.summaries.length) {
            if (typeof st.setExtensionPrompt === "function") st.setExtensionPrompt(EXT_NAME, "", 1, 0);
            return;
        }
        var text = state.summaries.map(function (s) { return s.text; }).join("\n\n---\n\n");
        var prompt = (globalApi.vectorPrompt || "{{context}}").replace("{{context}}", text);
        if (typeof st.setExtensionPrompt === "function") st.setExtensionPrompt(EXT_NAME, prompt, 1, 0);
    }

    function _doSummaryRequest(messagesArray, auto, sourceLabel, onDone) {
        var apiUrl = (globalApi.apiUrl || "").trim(), apiKey = (globalApi.apiKey || "").trim();
        var model = (globalApi.model || "").trim(), summaryPrompt = (globalApi.summaryPrompt || "").trim();
        if (!apiUrl) { toast("切片失败：未设置 API 地址。"); if (typeof onDone === "function") onDone(); return; }
        if (!messagesArray || !messagesArray.length) { if (!auto) toast("没有可用的消息。"); if (typeof onDone === "function") onDone(); return; }

        // 计算楼层范围
        var st = getST();
        var firstFloor = -1, lastFloor = -1;
        if (st && st.chat) {
            for (var fi = 0; fi < st.chat.length; fi++) {
                if (st.chat[fi] === messagesArray[0] && firstFloor === -1) firstFloor = fi;
                if (st.chat[fi] === messagesArray[messagesArray.length - 1]) lastFloor = fi;
            }
            if (firstFloor === -1 && messagesArray[0] && messagesArray[0].send_date) {
                for (var fi2 = 0; fi2 < st.chat.length; fi2++) {
                    if (st.chat[fi2].send_date === messagesArray[0].send_date && firstFloor === -1) firstFloor = fi2;
                    if (st.chat[fi2].send_date === messagesArray[messagesArray.length - 1].send_date) lastFloor = fi2;
                }
            }
        }
        var floorLabel = (firstFloor >= 0 && lastFloor >= 0) ? " [#" + firstFloor + "~#" + lastFloor + "]" : "";

        var lockedWorldId = currentWorldId;
        var recentChat = messagesArray.map(function (m) { return (m.name || m.role || "???") + ": " + (m.mes || ""); }).join("\n");
        var prompt = summaryPrompt.replace("{{context}}", recentChat);
        var btn = document.getElementById("tlg-summary-run"); if (btn) btn.disabled = true;
        var label = sourceLabel || (auto ? "自动" : "手动");
        toast("⏳ " + label + "切片中…" + floorLabel);

        // 禁用发送按钮
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
                worlds[lockedWorldId].summaries.push({
                    timestamp: Date.now(), text: text, nodeId: state.currentNodeId,
                    floorFrom: firstFloor, floorTo: lastFloor
                });
                // 记录最后一次自动总结的范围（用于 swipe 重写）
                if (auto && firstFloor >= 0 && lastFloor >= 0) {
                    state.lastAutoSummaryRange = {
                        floorFrom: firstFloor,
                        floorTo: lastFloor,
                        summaryIdx: worlds[lockedWorldId].summaries.length - 1
                    };
                }
                var maxCount = Math.max(10, globalApi.summaryMaxCount || 100);
                var trimmed = 0;
                if (worlds[lockedWorldId].summaries.length > maxCount) {
                    trimmed = worlds[lockedWorldId].summaries.length - maxCount;
                    worlds[lockedWorldId].summaries.splice(0, trimmed);
                }
                if (lockedWorldId === currentWorldId) {
                    state.summaries = worlds[lockedWorldId].summaries;
                    refreshSummary();
                }
                saveWorlds(); updateInjectionWithVector();
                if (trimmed > 0) {
                    toast("✓ " + label + "切片完成" + floorLabel + "（已清理最旧 " + trimmed + " 条）。");
                } else {
                    toast("✓ " + label + "切片完成" + floorLabel);
                }
            }
        }).catch(function (e) { toast("✗ " + label + "切片失败：" + e.message); })
        .then(function () {
            if (btn) btn.disabled = false;
            if (sendBtn) { sendBtn.disabled = false; sendBtn.style.opacity = ""; }
            if (typeof onDone === "function") onDone();
        });
    }

    function runSummaryWithMessages(messagesArray) {
        _doSummaryRequest(messagesArray, true, "跳转前");
    }

    function runSummary(auto) {
        var st = getST(); if (!st || !st.chat || !st.chat.length) { if (!auto) toast("当前无聊天消息。"); return; }
        ensureWorldExists();
        var count = auto ? (globalApi.autoInterval || 10) : (globalApi.manualCount || 20);
        var visible = st.chat.filter(function (m) { return !m._tlg_hidden && !m.is_hidden; });
        var recent = visible.slice(-count);
        _doSummaryRequest(recent, auto, auto ? "自动" : "手动");
    }

    function runCatchupSummary() {
        var st = getST(); if (!st || !st.chat || !st.chat.length) { toast("当前无聊天消息。"); return; }
        ensureWorldExists();
        var batchSize = globalApi.manualCount || 20;
        var allMessages = st.chat.filter(function (m) { return !m._tlg_hidden && !m.is_hidden; });
        if (!allMessages.length) { toast("没有可用消息。"); return; }

        // 找出已被总结覆盖的最高楼层
        var coveredUpTo = -1;
        if (state.summaries && state.summaries.length) {
            for (var i = 0; i < state.summaries.length; i++) {
                var s = state.summaries[i];
                if (typeof s.floorTo === "number" && s.floorTo > coveredUpTo) coveredUpTo = s.floorTo;
            }
        }

        // 筛选未被覆盖的消息
        var uncovered = [];
        for (var j = 0; j < st.chat.length; j++) {
            if (j <= coveredUpTo) continue;
            if (st.chat[j]._tlg_hidden || st.chat[j].is_hidden) continue;
            uncovered.push(st.chat[j]);
        }
        if (!uncovered.length) { toast("所有楼层已被覆盖，无需补全。"); return; }

        // 分批执行
        var batches = [];
        for (var k = 0; k < uncovered.length; k += batchSize) {
            batches.push(uncovered.slice(k, k + batchSize));
        }

        toast("📋 开始补全历史切片，共 " + batches.length + " 批…");
        var sendBtn = document.getElementById("send_but");
        if (sendBtn) { sendBtn.disabled = true; sendBtn.style.opacity = "0.4"; }
        var catchBtn = document.getElementById("tlg-summary-catchup-btn"); if (catchBtn) catchBtn.disabled = true;

        var idx = 0;
        function nextBatch() {
            if (idx >= batches.length) {
                toast("✓ 历史补全完成，共 " + batches.length + " 批。");
                if (sendBtn) { sendBtn.disabled = false; sendBtn.style.opacity = ""; }
                if (catchBtn) catchBtn.disabled = false;
                return;
            }
            var batch = batches[idx]; idx++;
            _doSummaryRequest(batch, true, "补全 " + idx + "/" + batches.length, nextBatch);
        }
        nextBatch();
    }

    // ══════════════════════════════════════
    // ④ 世界管理弹窗
    // ══════════════════════════════════════
    function showWorldManager() {
        var existing = document.getElementById("tlg-world-mgr"); if (existing) existing.remove();
        var backdrop = document.createElement("div"); backdrop.id = "tlg-world-mgr";
        backdrop.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100dvh;background:rgba(0,0,0,0.85);z-index:2147483647;display:flex;align-items:flex-start;justify-content:center;padding:16px;padding-top:10vh;box-sizing:border-box;overflow-y:auto;";
        var html = '<div class="tlg-modal" style="max-width:420px;width:100%;"><div class="tlg-modal-title">🌐 世界管理</div><div id="tlg-wm-list" style="max-height:50vh;overflow-y:auto;margin-bottom:12px;">';
        var ids = Object.keys(worlds);
        for (var i = 0; i < ids.length; i++) {
            var w = worlds[ids[i]], isCurrent = ids[i] === currentWorldId;
            html += '<div style="display:flex;align-items:center;gap:8px;padding:8px;border:1px solid ' + (isCurrent ? '#ffffff' : '#2a2a3a') + ';border-radius:4px;margin-bottom:6px;' + (isCurrent ? 'background:#1a1a2a;' : '') + '">';
            html += '<span style="flex:1;font-size:12px;color:#e0e0e8;">' + escHtml(w.name) + (isCurrent ? ' <span style="color:#7a7a8a;">(当前)</span>' : '') + '</span>';
            html += '<button type="button" class="tlg-btn tlg-wm-switch" data-wid="' + ids[i] + '" style="font-size:10px;padding:3px 8px;writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">' + (isCurrent ? '✓' : '切换') + '</button>';
            html += '<button type="button" class="tlg-btn tlg-btn-danger tlg-wm-del" data-wid="' + ids[i] + '" style="font-size:10px;padding:3px 8px;writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">✕</button>';
            html += '</div>';
        }
        html += '</div><div class="tlg-modal-actions"><button type="button" class="tlg-btn" id="tlg-wm-close">关闭</button><button type="button" class="tlg-btn tlg-btn-primary" id="tlg-wm-new">+ 手动新建世界</button></div></div>';
        backdrop.innerHTML = html; document.body.appendChild(backdrop);
        backdrop.querySelector("#tlg-wm-close").onclick = function () { backdrop.remove(); };
        backdrop.querySelector("#tlg-wm-new").onclick = function () {
            var name = prompt("新世界名称:", "世界 " + (Object.keys(worlds).length + 1));
            if (!name) return;
            resetState(); currentWorldId = null;
            ensureWorldExists(); worlds[currentWorldId].name = name; saveWorlds();
            backdrop.remove(); showWorldManager();
        };
        backdrop.querySelectorAll(".tlg-wm-switch").forEach(function (btn) {
            btn.addEventListener("click", function () {
                var wid = btn.dataset.wid;
                if (wid === currentWorldId) return;
                currentWorldId = wid; setLinkedWorldId(wid);
                var w = worlds[wid]; state.nodes = w.nodes || []; state.summaries = w.summaries || [];
                state.currentNodeId = w.currentNodeId || (state.nodes.length ? state.nodes[0].id : null);
                state.selectedNodeId = null; state.turnsSinceAnchor = w.turnsSinceAnchor || 0;
                saveCurrentWorld(); backdrop.remove(); showWorldManager(); toast("已切换至: " + w.name);
                renderCanvas(); refreshArchive();
            });
        });
        backdrop.querySelectorAll(".tlg-wm-del").forEach(function (btn) {
            btn.addEventListener("click", function () {
                var wid = btn.dataset.wid;
                if (!confirm("确认删除世界 \"" + (worlds[wid] && worlds[wid].name) + "\"？")) return;
                delete worlds[wid];
                if (currentWorldId === wid) { currentWorldId = null; resetState(); }
                saveWorlds(); backdrop.remove(); showWorldManager(); toast("世界已删除。");
            });
        });
        backdrop.addEventListener("click", function (e) { if (e.target === backdrop) backdrop.remove(); });
    }

    // ══════════════════════════════════════
    // ⑤ 面板 UI
    // ══════════════════════════════════════
    var panelBuilt = false;
    function openPanel() {
        if (!isEnabled()) { toast("河岸凝视已关闭。"); return; }
        ensurePanelBuilt(); var p = document.getElementById("tlg-panel"); if (p) { p.style.display = "flex"; document.body.style.overflow = "hidden"; }
        loadCurrentWorld(); renderCanvas(); refreshArchive();
        setTimeout(function () { if (state.currentNodeId) centerOnNode(state.currentNodeId); }, 100);
    }
    function closePanel() { var p = document.getElementById("tlg-panel"); if (p) { p.style.display = "none"; document.body.style.overflow = ""; } }
    function ensurePanelBuilt() {
        if (panelBuilt && document.getElementById("tlg-panel")) return;
        var old = document.getElementById("tlg-panel"); if (old) old.remove();
        var panel = document.createElement("div"); panel.id = "tlg-panel";
        panel.style.cssText = "display:none;position:fixed;top:0;left:0;width:100%;height:100%;height:100dvh;background:#000000;color:#e8e8f0;z-index:2147483647;flex-direction:column;font-family:'result',-apple-system,sans-serif;overflow:hidden;";
        var s = globalApi;
        panel.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-bottom:1px solid #1a1a2a;flex-shrink:0;"><span style="font-size:15px;letter-spacing:1px;">河岸凝视</span><div style="display:flex;gap:8px;"><button type="button" class="tlg-btn" id="tlg-world-btn" style="font-size:11px;padding:4px 10px;writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">🌐 世界</button><button type="button" class="tlg-btn" id="tlg-close-btn" style="font-size:11px;padding:4px 10px;writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">✕ 关闭</button></div></div>' +
            '<div style="display:flex;flex:1;overflow:hidden;">' +
            '<div id="tlg-canvas-wrap" style="flex:1;position:relative;overflow:hidden;background:#000000;"><canvas id="tlg-canvas" style="width:100%;height:100%;display:block;"></canvas></div>' +
            '<div id="tlg-sidebar" style="width:320px;border-left:1px solid #1a1a2a;display:flex;flex-direction:column;overflow:hidden;background:#000000;flex-shrink:0;">' +
            '<div style="display:flex;border-bottom:1px solid #1a1a2a;flex-shrink:0;"><button type="button" class="tlg-tab active" data-tab="archive">档案</button><button type="button" class="tlg-tab" data-tab="settings">设置</button></div>' +
            '<div id="tlg-tab-archive" class="tlg-tab-content active" style="flex:1;overflow-y:auto;padding:14px;">' +
            '<div style="margin-bottom:16px;"><button type="button" class="tlg-btn tlg-btn-primary" id="tlg-anchor-btn" style="width:100%;margin-bottom:8px;">⚓ 锚定因果节点</button></div>' +
            '<div id="tlg-summary-wrap"></div>' +
            '</div>' +
            '<div id="tlg-tab-settings" class="tlg-tab-content" style="flex:1;overflow-y:auto;padding:14px;">' +
            '<div style="margin-bottom:14px;"><label class="tlg-label">副 API 地址</label><input class="tlg-input" id="tlg-api-url" value="' + escHtml(s.apiUrl) + '" placeholder="https://..." /></div>' +
            '<div style="margin-bottom:14px;"><label class="tlg-label">API Key</label><input class="tlg-input" id="tlg-api-key" type="password" value="' + escHtml(s.apiKey) + '" /></div>' +
            '<div style="margin-bottom:14px;"><label class="tlg-label">模型</label><input class="tlg-input" id="tlg-api-model" value="' + escHtml(s.model) + '" /></div>' +
            '<div style="margin-bottom:14px;"><label class="tlg-label">向量注入提示词</label><textarea class="tlg-textarea" id="tlg-vector-prompt" rows="3">' + escHtml(s.vectorPrompt) + '</textarea></div>' +
            '<div style="margin-bottom:14px;"><label class="tlg-label">切片提示词</label><textarea class="tlg-textarea" id="tlg-summary-prompt" rows="4">' + escHtml(s.summaryPrompt) + '</textarea></div>' +
            '<div style="margin-bottom:14px;display:flex;gap:10px;flex-wrap:wrap;align-items:center;">' +
            '<label style="font-size:12px;color:#aaa;display:flex;align-items:center;gap:4px;"><input type="checkbox" id="tlg-auto-mode" ' + (s.autoMode ? 'checked' : '') + ' /> 自律模式</label>' +
            '<label style="font-size:12px;color:#aaa;">间隔 <input id="tlg-auto-interval" type="number" min="1" value="' + (s.autoInterval || 10) + '" style="width:40px;background:#111;border:1px solid #333;color:#eee;border-radius:3px;padding:2px;text-align:center;" /> 回合</label>' +
            '</div>' +
            '<div style="margin-bottom:14px;"><label style="font-size:12px;color:#aaa;display:flex;align-items:center;gap:4px;"><input type="checkbox" id="tlg-jump-summary" ' + (s.jumpSummary ? 'checked' : '') + ' /> 跳转前自动切片</label></div>' +
            '<div style="margin-bottom:14px;"><label class="tlg-label">AI 可见最近消息数</label><input class="tlg-input" id="tlg-last-n" type="number" min="1" value="' + (s.lastNMessages || 5) + '" /></div>' +
            '<div style="margin-bottom:14px;"><label class="tlg-label">最大总结保留数</label><input class="tlg-input" id="tlg-max-summaries" type="number" min="10" value="' + (s.summaryMaxCount || 100) + '" /></div>' +
            '</div></div></div>';
        document.body.appendChild(panel);
        // inject styles
        if (!document.getElementById("tlg-styles")) {
            var style = document.createElement("style"); style.id = "tlg-styles";
            style.textContent = '.tlg-modal{background:#0a0a12;border:1px solid #2a2a3a;border-radius:6px;padding:20px;max-width:360px;width:100%;box-sizing:border-box;}.tlg-modal-title{font-size:15px;margin-bottom:14px;color:#fff;}.tlg-modal-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:14px;}.tlg-label{display:block;font-size:11px;color:#8a8a9a;margin-bottom:4px;}.tlg-input,.tlg-textarea{width:100%;padding:8px 10px;background:#050508;border:1px solid #2a2a3a;border-radius:4px;color:#e0e0e8;font-size:13px;box-sizing:border-box;outline:none;}.tlg-textarea{resize:vertical;min-height:60px;}.tlg-btn{padding:6px 14px;border:1px solid #3a3a4a;border-radius:4px;background:#0a0a12;color:#e0e0e8;cursor:pointer;font-size:12px;transition:all 0.15s;}.tlg-btn:hover{border-color:#6a6a7a;background:#1a1a2a;}.tlg-btn-primary{background:#1a1a3a;border-color:#4a4a6a;}.tlg-btn-primary:hover{background:#2a2a4a;border-color:#7a7a9a;}.tlg-btn-danger{border-color:#4a2a2a;color:#ff6b6b;}.tlg-btn-danger:hover{background:#2a1a1a;border-color:#6a3a3a;}.tlg-tab{flex:1;padding:10px;background:transparent;border:none;color:#6a6a7a;cursor:pointer;font-size:12px;border-bottom:2px solid transparent;}.tlg-tab.active{color:#ffffff;border-bottom-color:#ffffff;}.tlg-tab-content{display:none;}.tlg-tab-content.active{display:flex;flex-direction:column;}';
            document.head.appendChild(style);
        }
        bindPanelEvents(panel); panelBuilt = true;
    }
    function bindPanelEvents(panel) {
        panel.querySelector("#tlg-close-btn").onclick = closePanel;
        panel.querySelector("#tlg-world-btn").onclick = showWorldManager;
        panel.querySelector("#tlg-anchor-btn").onclick = function () { showAnchorModal(); };
        panel.querySelectorAll(".tlg-tab").forEach(function (tab) {
            tab.addEventListener("click", function () {
                panel.querySelectorAll(".tlg-tab").forEach(function (t) { t.classList.remove("active"); });
                panel.querySelectorAll(".tlg-tab-content").forEach(function (c) { c.classList.remove("active"); });
                tab.classList.add("active");
                document.getElementById("tlg-tab-" + tab.dataset.tab).classList.add("active");
            });
        });
        // canvas
        canvas = panel.querySelector("#tlg-canvas"); ctx = canvas.getContext("2d");
        canvas.addEventListener("pointerdown", function (e) {
            if (e.button === 0) { isPanning = true; panStartX = e.clientX - camX; panStartY = e.clientY - camY; canvas.setPointerCapture(e.pointerId); }
        });
        canvas.addEventListener("pointermove", function (e) { if (isPanning) { camX = e.clientX - panStartX; camY = e.clientY - panStartY; } });
        canvas.addEventListener("pointerup", function (e) { isPanning = false; });
        canvas.addEventListener("click", function (e) {
            var hit = canvasHitTest(e.clientX, e.clientY);
            if (hit) { state.selectedNodeId = hit; var positions = layoutTree(); if (positions[hit]) triggerRipple(positions[hit].x, positions[hit].y); showBriefPanel(hit); }
            else { state.selectedNodeId = null; closeBriefPanel(); }
        });
        canvas.addEventListener("dblclick", function (e) {
            var hit = canvasHitTest(e.clientX, e.clientY);
            if (hit && hit !== state.currentNodeId) jumpToNode(hit);
        });
        canvas.addEventListener("wheel", function (e) { e.preventDefault(); var d = e.deltaY > 0 ? 0.9 : 1.1; camZoom = Math.max(0.3, Math.min(3, camZoom * d)); }, { passive: false });
        // settings bindings
        var ids = ["tlg-api-url", "tlg-api-key", "tlg-api-model", "tlg-vector-prompt", "tlg-summary-prompt", "tlg-last-n", "tlg-auto-interval", "tlg-max-summaries"];
        var keys = ["apiUrl", "apiKey", "model", "vectorPrompt", "summaryPrompt", "lastNMessages", "autoInterval", "summaryMaxCount"];
        for (var i = 0; i < ids.length; i++) {
            (function (id, key) {
                var el = document.getElementById(id); if (!el) return;
                el.addEventListener("change", function () {
                    var v = el.value; if (el.type === "number") v = parseInt(v, 10) || 0;
                    globalApi[key] = v; saveGlobalApi();
                });
            })(ids[i], keys[i]);
        }
        document.getElementById("tlg-auto-mode").addEventListener("change", function () { globalApi.autoMode = this.checked; saveGlobalApi(); });
        document.getElementById("tlg-jump-summary").addEventListener("change", function () { globalApi.jumpSummary = this.checked; saveGlobalApi(); });
        document.getElementById("tlg-manual-count").addEventListener("change", function () { globalApi.manualCount = Math.max(1, parseInt(this.value, 10) || 20); saveGlobalApi(); });
        renderSummarySection(document.getElementById("tlg-summary-wrap"));
        renderCanvas();
    }

    // ══════════════════════════════════════
    // 菜单按钮 & 设置面板注入
    // ══════════════════════════════════════
    function injectMenuButton() {
        if (document.getElementById("tlg_menu_btn")) return;
        var targets = ["#extensionsMenu", "#leftNavDrawerContent", "#top-bar"];
        var container = null;
        for (var i = 0; i < targets.length; i++) { container = document.querySelector(targets[i]); if (container) break; }
        if (!container) return;
        var btn = document.createElement("div"); btn.id = "tlg_menu_btn";
        btn.style.cssText = "cursor:pointer;padding:8px 12px;display:flex;align-items:center;gap:8px;font-size:13px;color:#ccc;";
        btn.innerHTML = '<span style="font-size:16px;">🌊</span><span>河岸凝视</span>';
        btn.onclick = function () { openPanel(); };
        container.appendChild(btn);
    }
    function injectSettingsPanel() {}

    // ══════════════════════════════════════
    // 斜杠命令
    // ══════════════════════════════════════
    function registerSlashCommand() {
        try {
            var st = getST();
            if (st && st.registerSlashCommand) {
                st.registerSlashCommand("tlg", function (args) {
                    var sub = (args && args[0]) || "";
                    if (sub === "open") openPanel();
                    else if (sub === "anchor") showAnchorModal(args.slice(1).join(" "));
                    else if (sub === "summary") runSummary(false);
                    else openPanel();
                }, [], "打开河岸凝视面板", true, true);
            }
        } catch (e) {}
    }

    // ══════════════════════════════════════
    // Boot
    // ══════════════════════════════════════
    function boot() {
        injectMenuButton(); injectSettingsPanel();
        new MutationObserver(function () { injectMenuButton(); injectSettingsPanel(); }).observe(document.body, { childList: true, subtree: true });
        setInterval(injectMenuButton, 2000); registerSlashCommand();
        try { loadCurrentWorld(); } catch (e) {}

        // 确保启动时：如果没有世界则自动创建
        if (!currentWorldId && getCurrentChatId()) {
            ensureWorldExists(); saveCurrentWorld();
        }

        try {
            var ctx1 = getST();
            if (ctx1 && ctx1.eventSource && ctx1.eventTypes) {
                var countFn = function () {
                    if (!isEnabled()) return;
                    // 如果中途丢失了世界 ID，尝试重载或补建
                    if (!currentWorldId) {
                        loadCurrentWorld();
                        if (!currentWorldId && getCurrentChatId()) { ensureWorldExists(); saveCurrentWorld(); }
                    }
                    state.turnsSinceAnchor = (state.turnsSinceAnchor || 0) + 1;
                    if (globalApi.autoMode && state.turnsSinceAnchor >= (globalApi.autoInterval || 10)) {
                        state.turnsSinceAnchor = 0;
                        toast("⚙ 自律模式触发，开始自动切片…");
                        runSummary(true);
                    }
                    // 平时也隐藏旧消息，只保留最近 N 条
                    applyRecentVisibility();
                    saveCurrentWorld();
                    updateInjectionWithVector();
                };
                ctx1.eventSource.on(ctx1.eventTypes.MESSAGE_RECEIVED, countFn);

                if (ctx1.eventTypes.MESSAGE_SWIPED) {
                    ctx1.eventSource.on(ctx1.eventTypes.MESSAGE_SWIPED, function (msgIdx) {
                        if (!isEnabled() || !state.lastAutoSummaryRange) return;
                        var range = state.lastAutoSummaryRange;
                        var idx = typeof msgIdx === "number" ? msgIdx : (msgIdx && msgIdx.id != null ? msgIdx.id : -1);
                        if (idx < 0) { var st2 = getST(); idx = st2 && st2.chat ? st2.chat.length - 1 : -1; }
                        if (idx >= range.floorFrom && idx <= range.floorTo) {
                            // 删除关联的最后一条自动总结
                            if (state.summaries && state.summaries.length > range.summaryIdx) {
                                state.summaries.splice(range.summaryIdx, 1);
                                if (currentWorldId && worlds[currentWorldId]) {
                                    worlds[currentWorldId].summaries = state.summaries;
                                }
                                saveWorlds();
                            }
                            state.lastAutoSummaryRange = null;
                            state.turnsSinceAnchor = 0;
                            toast("🔄 检测到重试，已撤销最近自动切片，将在下次达到阈值时重新切片。");
                        }
                    });
                }

                ctx1.eventSource.on(ctx1.eventTypes.CHAT_CHANGED, function () {
                    var p = document.getElementById("tlg-panel"); if (p) p.remove();
                    canvas = null; ctx = null; document.body.style.overflow = ""; panelBuilt = false;
                    // 切换聊天时，自动加载世界，没有则创建
                    setTimeout(function () {
                        loadCurrentWorld();
                        if (!currentWorldId && getCurrentChatId()) {
                            ensureWorldExists(); saveCurrentWorld();
                        }
                        updateInjectionWithVector();
                    }, 500);
                });
            }
        } catch (e) {}
        console.log("[TLG] 河岸凝视 v3.2 已上线");
    }

    if (document.readyState === "loading") { document.addEventListener("DOMContentLoaded", boot); } else { setTimeout(boot, 300); }
})();
