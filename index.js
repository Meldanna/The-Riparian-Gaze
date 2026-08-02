/**
 * 河岸凝视 v3.0
 * 新增：诸世界 / 总结原地编辑 / extension_settings持久化
 */
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
        _lastChatLen: 0
    };

    // ── 全局 API 设置（跨世界共享，存 extension_settings）──
    var globalApi = {
        apiUrl: "", apiKey: "", model: "", modelList: [],
        vectorUrl: "", vectorKey: "", vectorModel: "", vectorModelList: [],
        vectorPrompt: "以下为因果档案库中与当前观测焦点相关的历史切片：\n\n{{context}}\n\n处理规则：\n- 这些是已铭刻的因果事实，不可篡改\n- 当前叙事必须与这些记录在逻辑上连续\n- 若当前事件是某条历史线的后果，自然呈现因果关系\n- 不要直接引用或复述这些档案内容",
        summaryPrompt: "你是因果记录仪。对以下对话执行状态切片，提取并压缩为因果档案。\n\n【因果事件链】本段发生的事件，按因果顺序（A导致B导致C），每条一句\n【样本状态变动】主角的生理、心理、物品、关系的变化\n【NPC状态变动】在场NPC的行为、立场、情绪变化\n【悬置因果线】未完成的选择、未触发的后果、埋下的伏笔\n【环境快照】地点·天气·时间·在场实体\n\n对话内容：\n{{context}}\n\n要求：纯事实记录，无评论，无修辞。",
        autoMode: false, autoInterval: 10, lastNMessages: 5
    };

    // ── 诸世界数据 ──
    // worlds = { [worldId]: { id, name, chatId, nodes, summaries, currentNodeId, createdAt, updatedAt } }
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
        el.style.cssText = "position:fixed;left:50%;top:16px;transform:translateX(-50%);max-width:80vw;padding:12px 18px;background:#1a1a28;border:1px solid #3a3a4a;border-radius:8px;color:#e8e8f0;font-size:14px;z-index:2147483647;text-align:center;pointer-events:none;opacity:1;transition:opacity 0.4s;box-shadow:0 4px 20px rgba(0,0,0,0.6);";
        document.body.appendChild(el);
        setTimeout(function () { el.style.opacity = "0"; setTimeout(function () { el.remove(); }, 400); }, duration);
    }
    function flashBtn(btn) {
        if (!btn) return;
        var orig = btn.style.boxShadow || "";
        btn.style.boxShadow = "0 0 12px 2px rgba(192,192,210,0.6)";
        btn.style.transition = "box-shadow 0.3s";
        setTimeout(function () { btn.style.boxShadow = orig; }, 800);
    }
    function escHtml(str) {
        return String(str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }

    // ══════════════════════════════════════
    // 存储层：extension_settings + chat_metadata 指针
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
    function isEnabled() {
        try { return getExtSettings().enabled !== false; } catch (e) { return true; }
    }
    function setEnabled(on) {
        try {
            getExtSettings().enabled = !!on;
            saveExtSettings();
            if (!on) closePanel();
            injectMenuButton();
            var toggle = document.getElementById("tlg_enable_toggle");
            if (toggle) toggle.classList.toggle("on", !!on);
        } catch (e) {}
    }

    // API 设置
    function loadGlobalApi() {
        var es = getExtSettings();
        if (es.api) {
            var keys = Object.keys(globalApi);
            for (var i = 0; i < keys.length; i++) {
                if (es.api[keys[i]] !== undefined) globalApi[keys[i]] = es.api[keys[i]];
            }
        }
    }
    function saveGlobalApi() {
        var es = getExtSettings();
        es.api = JSON.parse(JSON.stringify(globalApi));
        saveExtSettings();
    }

    // 世界存储
    function loadWorlds() {
        var es = getExtSettings();
        if (es.worlds) worlds = JSON.parse(JSON.stringify(es.worlds));
    }
    function saveWorlds() {
        var es = getExtSettings();
        es.worlds = JSON.parse(JSON.stringify(worlds));
        saveExtSettings();
    }

    // 当前聊天 -> 世界指针
    function getCurrentChatId() {
        var st = getST();
        if (!st) return "";
        return st.chatId || (st.getCurrentChatId && st.getCurrentChatId()) || "";
    }
    function getLinkedWorldId() {
        var st = getST();
        if (!st || !st.chat_metadata) return null;
        return st.chat_metadata.tlg_worldId || null;
    }
    function setLinkedWorldId(worldId) {
        var st = getST();
        if (!st) return;
        if (!st.chat_metadata) st.chat_metadata = {};
        st.chat_metadata.tlg_worldId = worldId;
        if (typeof st.saveMetadata === "function") st.saveMetadata();
    }

    // 加载当前世界到 state
    function loadCurrentWorld() {
        loadGlobalApi();
        loadWorlds();
        var worldId = getLinkedWorldId();
        // 如果没有指针，尝试 chatId 匹配
        if (!worldId) {
            var chatId = getCurrentChatId();
            if (chatId) {
                var ids = Object.keys(worlds);
                for (var i = 0; i < ids.length; i++) {
                    if (worlds[ids[i]].chatId === chatId) { worldId = ids[i]; break; }
                }
                if (worldId) setLinkedWorldId(worldId);
            }
                    updateInjection();
        }
        if (worldId && worlds[worldId]) {
            currentWorldId = worldId;
            var w = worlds[worldId];
            state.nodes = w.nodes || [];
            state.summaries = w.summaries || [];
            state.currentNodeId = w.currentNodeId || (state.nodes.length ? state.nodes[0].id : null);
            state.selectedNodeId = null;
        } else {
            currentWorldId = null;
            resetState();
        }
    }

    // 保存当前 state 回世界
    function saveCurrentWorld() {
        if (!currentWorldId) return;
        if (!worlds[currentWorldId]) return;
        worlds[currentWorldId].nodes = JSON.parse(JSON.stringify(state.nodes));
        worlds[currentWorldId].summaries = JSON.parse(JSON.stringify(state.summaries));
        worlds[currentWorldId].currentNodeId = state.currentNodeId;
        worlds[currentWorldId].updatedAt = Date.now();
        saveWorlds();
		updateInjection();
    }

    // 确保当前聊天有世界（锚定时自动创建）
    function ensureWorldExists() {
        if (currentWorldId && worlds[currentWorldId]) return currentWorldId;
        var chatId = getCurrentChatId();
        var name = chatId || ("世界 " + (Object.keys(worlds).length + 1));
        var wid = generateId();
        worlds[wid] = {
            id: wid, name: name, chatId: chatId,
            nodes: JSON.parse(JSON.stringify(state.nodes)),
            summaries: JSON.parse(JSON.stringify(state.summaries)),
            currentNodeId: state.currentNodeId,
            createdAt: Date.now(), updatedAt: Date.now()
        };
        currentWorldId = wid;
        setLinkedWorldId(wid);
        saveWorlds();
        return wid;
    }

    // 兼容旧版迁移
    function migrateOldData() {
        var st = getST();
        if (!st || !st.chat_metadata) return;
        var old = st.chat_metadata[METADATA_KEY];
        if (!old || !old.nodes || !old.nodes.length) return;
        if (getLinkedWorldId()) return; // 已有世界
        var chatId = getCurrentChatId();
        var wid = generateId();
        worlds[wid] = {
            id: wid, name: chatId || "迁移世界",
            chatId: chatId,
            nodes: old.nodes,
            summaries: old.summaries || [],
            currentNodeId: old.currentNodeId || old.nodes[0].id,
            createdAt: Date.now(), updatedAt: Date.now()
        };
        currentWorldId = wid;
        setLinkedWorldId(wid);
        // 迁移旧 API 设置
        if (old.settings) {
            var keys = Object.keys(globalApi);
            for (var i = 0; i < keys.length; i++) {
                if (old.settings[keys[i]] !== undefined && !globalApi[keys[i]]) globalApi[keys[i]] = old.settings[keys[i]];
            }
            saveGlobalApi();
        }
        state.nodes = worlds[wid].nodes;
        state.summaries = worlds[wid].summaries;
        state.currentNodeId = worlds[wid].currentNodeId;
        saveWorlds();
        toast("已从旧版数据迁移。");
    }

    function resetState() {
        var rootId = generateId();
        state.nodes = [{ id: rootId, name: "起源点", brief: "时间线起源。", parentId: null, msgIdx: 0, statData: null, timestamp: Date.now(), children: [] }];
        state.currentNodeId = rootId;
        state.selectedNodeId = null;
        state.summaries = [];
        state.turnsSinceAnchor = 0;
        state._lastChatLen = 0;
    }

    function findNode(id) { return state.nodes.find(function (n) { return n.id === id; }) || null; }
    function getPathToRoot(nodeId) {
        var path = [], cur = findNode(nodeId);
        while (cur) { path.unshift(cur.id); cur = findNode(cur.parentId); }
        return path;
    }

    // ── MVU ──
    function getMVUStatData() {
        try {
            var st = getST();
            if (st && st.chat_metadata && st.chat_metadata.stat_data != null)
                return JSON.parse(JSON.stringify(st.chat_metadata.stat_data));
        } catch (e) {}
        return null;
    }
    function setMVUStatData(data) {
        if (data == null) return;
        try {
            var st = getST();
            if (st && st.chat_metadata) { st.chat_metadata.stat_data = JSON.parse(JSON.stringify(data)); if (typeof st.saveMetadata === "function") st.saveMetadata(); }
        } catch (e) {}
    }
    function applyVisibility(targetNodeId) {
        var st = getST();
        if (!st || !st.chat) return;
        var pathIds = getPathToRoot(targetNodeId);
        var pathNodes = pathIds.map(findNode).filter(Boolean);
        var visible = {}, i, m, node, next, start, end;
        for (i = 0; i < pathNodes.length; i++) {
            node = pathNodes[i]; next = pathNodes[i + 1] || null;
            start = node.msgIdx; end = next ? next.msgIdx - 1 : node.msgIdx;
            for (m = start; m <= end; m++) visible[m] = true;
        }
        var target = findNode(targetNodeId);
        var lastN = Math.max(0, globalApi.lastNMessages || 5);
        var endIdx = target ? target.msgIdx : st.chat.length - 1;
        for (m = Math.max(0, endIdx - lastN + 1); m <= endIdx; m++) visible[m] = true;
        for (i = 0; i < st.chat.length; i++) {
            if (visible[i]) delete st.chat[i].is_hidden; else st.chat[i].is_hidden = true;
        }
        if (typeof st.saveChat === "function") st.saveChat();
    }

    // ── 锚定 / 跳转 ──
    function createAnchor(name, brief) {
        var st = getST(); if (!st) return;
        ensureWorldExists();
        var msgIdx = st.chat ? Math.max(0, st.chat.length - 1) : 0;
        var parentId = state.currentNodeId;
        var newId = generateId();
        var newNode = { id: newId, name: name || ("节点 " + state.nodes.length), brief: brief || "", parentId: parentId, msgIdx: msgIdx, statData: getMVUStatData(), timestamp: Date.now(), children: [] };
        var parent = findNode(parentId);
        if (parent && parent.children.indexOf(newId) === -1) parent.children.push(newId);
        state.nodes.push(newNode);
        state.currentNodeId = newId; state.selectedNodeId = newId; state.turnsSinceAnchor = 0;
        saveCurrentWorld();
        toast("⚓ 已锚定: " + newNode.name);
        renderCanvas(); refreshArchive();
        return newId;
    }
    function jumpToNode(nodeId) {
        var node = findNode(nodeId);
        if (!node) { toast("节点不存在。"); return; }
        if (node.statData != null) setMVUStatData(node.statData);
        applyVisibility(nodeId);
        state.currentNodeId = nodeId; state.turnsSinceAnchor = 0;
        saveCurrentWorld();
        toast("↩ 已跳转至: " + node.name);
        renderCanvas(); refreshArchive(); closeBriefPanel();
    }

    function showAnchorModal(prefillName) {
        if (!isEnabled()) { toast("河岸凝视已关闭。"); return; }
        var existing = document.getElementById("tlg-anchor-modal");
        if (existing) existing.remove();
        var backdrop = document.createElement("div");
        backdrop.id = "tlg-anchor-modal";
        backdrop.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100dvh;background:rgba(0,0,0,0.82);z-index:2147483647;display:flex;align-items:flex-start;justify-content:center;padding:16px;padding-top:12vh;box-sizing:border-box;overflow-y:auto;";
        backdrop.innerHTML =
            '<div class="tlg-modal">' +
            '<div class="tlg-modal-title">⚓ 创建锚定点</div>' +
            '<div style="margin-bottom:12px"><label class="tlg-label">节点名称</label>' +
            '<input class="tlg-input" id="tlg-anc-name" placeholder="例：决斗之前…" value="' + escHtml(prefillName || "") + '" /></div><div>' +
            '<label class="tlg-label">简要描述</label>' +
            '<textarea class="tlg-textarea" id="tlg-anc-brief" placeholder="此时此刻的情况概述…"></textarea>' +
            '</div><div class="tlg-modal-actions">' +
            '<button type="button" class="tlg-btn" id="tlg-anc-cancel">取消</button>' +
            '<button type="button" class="tlg-btn tlg-btn-primary" id="tlg-anc-ok">⚓ 确认锚定</button></div></div>';
        document.body.appendChild(backdrop);
        var nameInput = backdrop.querySelector("#tlg-anc-name");
        backdrop.querySelector("#tlg-anc-cancel").onclick = function () { backdrop.remove(); };
        backdrop.querySelector("#tlg-anc-ok").onclick = function () {
            createAnchor(nameInput.value.trim() || ("节点 " + state.nodes.length), backdrop.querySelector("#tlg-anc-brief").value.trim());
            backdrop.remove();
        };
        backdrop.addEventListener("click", function (e) { if (e.target === backdrop) backdrop.remove(); });
        setTimeout(function () { nameInput.focus(); }, 80);
    }
    // ── 画布 ──
    function layoutTree() {
        var positions = {}, H_GAP = 180, V_GAP = 120;
        function subtreeWidth(nodeId) {
            var node = findNode(nodeId);
            if (!node || !node.children.length) return 1;
            return node.children.reduce(function (s, cid) { return s + subtreeWidth(cid); }, 0);
        }
        function assign(nodeId, depth, slotStart) {
            var node = findNode(nodeId); if (!node) return;
            var w = subtreeWidth(nodeId);
            positions[nodeId] = { x: (slotStart + w / 2) * H_GAP, y: depth * V_GAP + 60 };
            var childSlot = slotStart;
            for (var i = 0; i < node.children.length; i++) {
                var cid = node.children[i], cw = subtreeWidth(cid);
                assign(cid, depth + 1, childSlot); childSlot += cw;
            }
        }
        var root = state.nodes.find(function (n) { return n.parentId === null; });
        if (root) assign(root.id, 0, 0);
        return positions;
    }

    function renderCanvas() {
        if (!canvas || !ctx) return;
        var dpr = window.devicePixelRatio || 1;
        var rect = canvas.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        canvas.width = rect.width * dpr; canvas.height = rect.height * dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = "#050508"; ctx.fillRect(0, 0, rect.width, rect.height);
        ctx.save(); ctx.translate(rect.width / 2 + camX, rect.height / 2 + camY); ctx.scale(camZoom, camZoom);
        var positions = layoutTree(), NODE_R = 22, path = getPathToRoot(state.currentNodeId);
        var i, node, from, to, pos, isCurrent, isSelected, onPath, isActive, cy, label, grd;
        for (i = 0; i < state.nodes.length; i++) {
            node = state.nodes[i]; if (!node.parentId) continue;
            from = positions[node.parentId]; to = positions[node.id]; if (!from || !to) continue;
            isActive = path.indexOf(node.id) !== -1 && path.indexOf(node.parentId) !== -1;
            ctx.beginPath(); ctx.moveTo(from.x, from.y + NODE_R);
            cy = (from.y + to.y) / 2;
            ctx.bezierCurveTo(from.x, cy, to.x, cy, to.x, to.y - NODE_R);
            ctx.strokeStyle = isActive ? "rgba(220,220,230,0.85)" : "rgba(192,192,210,0.18)";
            ctx.lineWidth = isActive ? 1.8 : 1; ctx.shadowBlur = isActive ? 8 : 0;
            ctx.shadowColor = "rgba(192,192,210,0.5)"; ctx.stroke(); ctx.shadowBlur = 0;
        }
        for (i = 0; i < state.nodes.length; i++) {
            node = state.nodes[i]; pos = positions[node.id]; if (!pos) continue;
            isCurrent = node.id === state.currentNodeId; isSelected = node.id === state.selectedNodeId;
            onPath = path.indexOf(node.id) !== -1;
            if (isCurrent) {
                ctx.beginPath(); ctx.arc(pos.x, pos.y, NODE_R + 12, 0, Math.PI * 2);
                grd = ctx.createRadialGradient(pos.x, pos.y, NODE_R, pos.x, pos.y, NODE_R + 14);
                grd.addColorStop(0, "rgba(255,255,255,0.25)"); grd.addColorStop(1, "rgba(255,255,255,0)");
                ctx.fillStyle = grd; ctx.fill();
            }
            ctx.beginPath(); ctx.arc(pos.x, pos.y, NODE_R, 0, Math.PI * 2);
            if (isCurrent) { ctx.fillStyle = "rgba(255,255,255,0.15)"; ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.shadowColor = "rgba(255,255,255,0.8)"; ctx.shadowBlur = 18; }
            else if (isSelected) { ctx.fillStyle = "rgba(192,192,210,0.12)"; ctx.strokeStyle = "#c0c0d0"; ctx.lineWidth = 2; ctx.shadowBlur = 10; }
            else if (onPath) { ctx.fillStyle = "rgba(192,192,210,0.07)"; ctx.strokeStyle = "rgba(192,192,210,0.55)"; ctx.lineWidth = 1.2; ctx.shadowBlur = 0; }
            else { ctx.fillStyle = "rgba(192,192,210,0.04)"; ctx.strokeStyle = "rgba(192,192,210,0.2)"; ctx.lineWidth = 1; ctx.shadowBlur = 0; }
            ctx.fill(); ctx.stroke(); ctx.shadowBlur = 0;
            ctx.fillStyle = isCurrent ? "#fff" : onPath ? "rgba(220,220,230,0.85)" : "rgba(180,180,195,0.55)";
            ctx.font = isCurrent ? "bold 10px sans-serif" : "10px sans-serif";
            ctx.textAlign = "center"; ctx.textBaseline = "top";
            label = node.name.length > 12 ? node.name.slice(0, 11) + "…" : node.name;
            ctx.fillText(label, pos.x, pos.y + NODE_R + 5);
        }
        ctx.restore();
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

    // ── 简介面板 ──
    function openBriefPanel(nodeId) {
        var node = findNode(nodeId); if (!node) return;
        state.selectedNodeId = nodeId;
        var panel = document.getElementById("tlg-brief-panel"); if (!panel) return;
        panel.classList.add("open");
        panel.querySelector(".tlg-brief-header span").textContent = node.name;
        var body = panel.querySelector(".tlg-brief-body");
        body.innerHTML =
            '<div style="margin-bottom:8px;font-size:11px;color:#6a6a78">' + new Date(node.timestamp).toLocaleString() + "</div>" +
            '<div style="margin-bottom:8px;font-size:11px;color:#6a6a78">消息索引: ' + node.msgIdx + " | " + (node.statData ? "MVU快照 ✓" : "无MVU快照") + "</div>" +
            '<div style="white-space:pre-wrap;word-break:break-word">' + (node.brief ? escHtml(node.brief) : "<em style='color:#6a6a78'>暂无描述。</em>") + "</div>" +
            '<div style="margin-top:12px"><label class="tlg-label">编辑描述</label>' +
            '<textarea class="tlg-textarea" id="tlg-brief-edit" style="min-height:100px">' + escHtml(node.brief || "") + "</textarea>" +
            '<button type="button" class="tlg-btn tlg-btn-primary" id="tlg-brief-save" style="margin-top:6px;width:100%!important">保存描述</button></div>';
        body.querySelector("#tlg-brief-save").onclick = function () {
            flashBtn(this); node.brief = body.querySelector("#tlg-brief-edit").value;
            saveCurrentWorld(); toast("描述已保存。"); refreshArchive();
        };
        panel.querySelector(".tlg-brief-footer").innerHTML =
            '<button type="button" class="tlg-btn tlg-btn-jump" id="tlg-brief-jump">↩ 确认跳转至此节点</button>';
        panel.querySelector("#tlg-brief-jump").onclick = function () { jumpToNode(nodeId); };
        renderCanvas();
    }
    function closeBriefPanel() {
        var panel = document.getElementById("tlg-brief-panel");
        if (panel) panel.classList.remove("open");
        state.selectedNodeId = null; renderCanvas();
    }

    // ── 档案库 ──
    function refreshArchive() {
        var container = document.getElementById("tlg-archive-list"); if (!container) return;
        if (!state.nodes.length) { container.innerHTML = '<div style="color:#6a6a78;padding:20px">暂无节点。</div>'; return; }
        var sorted = state.nodes.slice().sort(function (a, b) { return b.timestamp - a.timestamp; });
        container.innerHTML = sorted.map(function (node) {
            var isCurrent = node.id === state.currentNodeId;
            return '<div class="tlg-archive-card ' + (isCurrent ? "current" : "") + '">' +
                '<div class="tlg-archive-title">' + escHtml(node.name) + (isCurrent ? " <span style='color:#6a6a78;font-size:11px'>(当前)</span>" : "") + "</div>" +
                '<div class="tlg-archive-meta">' + new Date(node.timestamp).toLocaleString() + " · 消息 " + node.msgIdx + "</div>" +
                '<div class="tlg-archive-brief">' + escHtml(node.brief || "") + "</div>" +
                '<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">' +
                '<button type="button" class="tlg-btn tlg-archive-view" data-nid="' + node.id + '">在树图中查看</button>' +
                '<button type="button" class="tlg-btn tlg-btn-primary tlg-archive-jump" data-nid="' + node.id + '">↩ 跳转至此</button>' +
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
    }
    function deleteNode(nodeId) {
        var node = findNode(nodeId); if (!node) return;
        var parent = findNode(node.parentId);
        if (parent) parent.children = parent.children.filter(function (id) { return id !== nodeId; });
        function rm(id) { var n = findNode(id); if (!n) return; n.children.slice().forEach(rm); state.nodes = state.nodes.filter(function (x) { return x.id !== id; }); }
        rm(nodeId); saveCurrentWorld(); renderCanvas(); refreshArchive(); toast("节点已删除。");
    }

    // ── 总结池（原地编辑）──
    function refreshSummary() {
        var list = document.getElementById("tlg-summary-list"); if (!list) return;
        if (!state.summaries || !state.summaries.length) {
            list.innerHTML = '<div style="color:#6a6a78;padding:12px">暂无总结记录。</div>'; return;
        }
        var latest = state.summaries[state.summaries.length - 1];
        var preview = (latest.text || "").slice(0, 120);
        if (latest.text && latest.text.length > 120) preview += "…";
        list.innerHTML =
            '<div style="background:#0e0e18;border:1px solid #1a1a28;border-radius:6px;padding:12px;margin-bottom:10px;">' +
            '<div style="font-size:11px;color:#6a6a78;margin-bottom:6px">最新 · ' + new Date(latest.timestamp).toLocaleString() + '</div>' +
            '<div style="font-size:13px;white-space:pre-wrap;max-height:80px;overflow:hidden;">' + escHtml(preview) + '</div></div>' +
            '<button type="button" class="tlg-btn tlg-btn-primary" id="tlg-summary-history-btn" style="width:100%">📜 查看全部历史总结 (' + state.summaries.length + ' 条)</button>';
        document.getElementById("tlg-summary-history-btn").addEventListener("click", function () { openSummaryHistory(); });
    }

    function openSummaryHistory() {
        var old = document.getElementById("tlg-summary-fullscreen"); if (old) old.remove();
        var container = document.createElement("div");
        container.id = "tlg-summary-fullscreen";
        container.style.cssText = "position:absolute;inset:0;z-index:10;background:#050508;display:flex;flex-direction:column;overflow:hidden;";
        var header = document.createElement("div");
        header.style.cssText = "display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #1a1a28;flex-shrink:0;";
        header.innerHTML =
            '<button type="button" class="tlg-btn" id="tlg-sh-back" style="padding:6px 10px;writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">← 返回</button>' +
            '<input type="text" id="tlg-sh-search" placeholder="搜索关键词…" style="flex:1;padding:8px 12px;background:#0e0e18;border:1px solid #1a1a28;border-radius:4px;color:#c0c0c8;font-size:14px;outline:none;min-width:0;" />' +
            '<span id="tlg-sh-count" style="font-size:12px;color:#6a6a78;flex-shrink:0;white-space:nowrap;">' + (state.summaries ? state.summaries.length : 0) + ' 条</span>';
        container.appendChild(header);
        var listWrap = document.createElement("div");
        listWrap.id = "tlg-sh-list";
        listWrap.style.cssText = "flex:1;overflow-y:auto;padding:12px;-webkit-overflow-scrolling:touch;";
        container.appendChild(listWrap);
        var body = document.getElementById("tlg-body"); if (!body) return;
        body.appendChild(container);
        renderSummaryList("");
        document.getElementById("tlg-sh-back").addEventListener("click", function () { container.remove(); });
        document.getElementById("tlg-sh-search").addEventListener("input", function () { renderSummaryList(this.value.trim().toLowerCase()); });
    }

    function renderSummaryList(keyword) {
        var listWrap = document.getElementById("tlg-sh-list"); if (!listWrap) return;
        var items = (state.summaries || []).slice().reverse();
        if (keyword) { items = items.filter(function (s) { return (s.text || "").toLowerCase().indexOf(keyword) !== -1; }); }
        var countEl = document.getElementById("tlg-sh-count");
        if (countEl) countEl.textContent = items.length + " 条";
        if (!items.length) { listWrap.innerHTML = '<div style="color:#6a6a78;padding:20px;text-align:center;">' + (keyword ? "未找到匹配结果。" : "暂无总结记录。") + '</div>'; return; }
        listWrap.innerHTML = items.map(function (s, displayIdx) {
            var realIdx = state.summaries.length - 1 - displayIdx;
            if (keyword) { realIdx = state.summaries.lastIndexOf(s); }
            return '<div class="tlg-sh-item" data-real-idx="' + realIdx + '" style="background:#0a0a10;border:1px solid #1a1a28;border-radius:6px;padding:12px;margin-bottom:10px;">' +
                '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">' +
                '<span style="font-size:11px;color:#6a6a78;">' + new Date(s.timestamp).toLocaleString() + '</span>' +
                '<span style="font-size:11px;color:#6a6a78;">#' + (realIdx + 1) + '</span></div>' +
                '<div class="tlg-sh-text" id="tlg-sh-text-' + realIdx + '" style="font-size:13px;white-space:pre-wrap;word-break:break-word;line-height:1.6;max-height:200px;overflow-y:auto;">' + escHtml(s.text) + '</div>' +
                '<div id="tlg-sh-editarea-' + realIdx + '" style="display:none;margin-top:8px;">' +
                '<textarea style="width:100%;min-height:120px;padding:10px;background:#0e0e18;border:1px solid #1a1a28;border-radius:4px;color:#c0c0c8;font-size:13px;line-height:1.6;resize:vertical;box-sizing:border-box;outline:none;" id="tlg-sh-ta-' + realIdx + '">' + escHtml(s.text) + '</textarea>' +
                '<button type="button" class="tlg-btn tlg-btn-primary tlg-sh-save" data-idx="' + realIdx + '" style="margin-top:6px;width:100%;">保存</button></div>' +
                '<div style="margin-top:10px;display:flex;gap:8px;">' +
                '<button type="button" class="tlg-btn tlg-sh-edit" data-idx="' + realIdx + '" style="font-size:11px;writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">✏️ 编辑</button>' +
                '<button type="button" class="tlg-btn tlg-btn-danger tlg-sh-del" data-idx="' + realIdx + '" style="font-size:11px;margin-left:auto;writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">✕ 删除</button></div></div>';
        }).join("");
        // 绑定编辑（原地展开textarea）
        listWrap.querySelectorAll(".tlg-sh-edit").forEach(function (btn) {
            btn.addEventListener("click", function () {
                var idx = Number(btn.dataset.idx);
                var textDiv = document.getElementById("tlg-sh-text-" + idx);
                var editArea = document.getElementById("tlg-sh-editarea-" + idx);
                if (textDiv) textDiv.style.display = "none";
                if (editArea) editArea.style.display = "block";
                btn.style.display = "none";
            });
        });
        // 绑定保存
        listWrap.querySelectorAll(".tlg-sh-save").forEach(function (btn) {
            btn.addEventListener("click", function () {
                flashBtn(this);
                var idx = Number(btn.dataset.idx);
                var ta = document.getElementById("tlg-sh-ta-" + idx);
                if (ta) state.summaries[idx].text = ta.value;
                saveCurrentWorld(); refreshSummary();
                var kw = (document.getElementById("tlg-sh-search") || {}).value || "";
                renderSummaryList(kw.trim().toLowerCase());
                toast("总结已更新。");
            });
        });
        // 绑定删除
        listWrap.querySelectorAll(".tlg-sh-del").forEach(function (btn) {
            btn.addEventListener("click", function () {
                var idx = Number(btn.dataset.idx);
                if (!confirm("确定删除这条总结？")) return;
                state.summaries.splice(idx, 1);
                saveCurrentWorld(); refreshSummary();
                var kw = (document.getElementById("tlg-sh-search") || {}).value || "";
                renderSummaryList(kw.trim().toLowerCase());
                toast("已删除。");
            });
        });
    }

    // ── API端点 ──
    function buildEndpoint(base, path) {
        var url = (base || "").trim().replace(/\/+$/, "");
        if (path === "/chat/completions" && /\/chat\/completions$/.test(url)) return url;
        if (path === "/models" && /\/models$/.test(url)) return url;
        if (!/\/v\d+/.test(url)) url += "/v1";
        return url + path;
    }
    
    // ── 总结自动注入 AI 上下文 加向量检索──
        function updateInjectionWithVector() {
        var st = getST();
        if (!st || typeof st.setExtensionPrompt !== "function") return;
        if (!state.summaries || !state.summaries.length) { st.setExtensionPrompt(EXT_NAME, "", 1, 4); return; }

        var vecUrl = (globalApi.vectorUrl || "").trim();
        var vecKey = (globalApi.vectorKey || "").trim();
        var vecModel = (globalApi.vectorModel || "").trim();

        // 没有向量 API，降级为取最近 3 条
        if (!vecUrl || !vecModel) { updateInjection(); return; }

        // 取最近几条对话作为查询
        var chat = (st.chat || []).slice(-5).map(function (m) { return (m.mes || "").slice(0, 200); }).join(" ");

        // 对查询文本做 embedding
        fetch(buildEndpoint(vecUrl, "/embeddings"), {
            method: "POST",
            headers: Object.assign({ "Content-Type": "application/json" }, vecKey ? { Authorization: "Bearer " + vecKey } : {}),
            body: JSON.stringify({ model: vecModel, input: chat })
        }).then(function (r) { return r.json(); })
        .then(function (data) {
            var queryVec = data.data && data.data[0] && data.data[0].embedding;
            if (!queryVec) { updateInjection(); return; }

            // 对所有总结做 embedding（简化：每次都算，生产环境应缓存）
            var texts = state.summaries.map(function (s) { return s.text; });
            return fetch(buildEndpoint(vecUrl, "/embeddings"), {
                method: "POST",
                headers: Object.assign({ "Content-Type": "application/json" }, vecKey ? { Authorization: "Bearer " + vecKey } : {}),
                body: JSON.stringify({ model: vecModel, input: texts })
            }).then(function (r2) { return r2.json(); }).then(function (data2) {
                var embeddings = (data2.data || []).map(function (d) { return d.embedding; });
                // 余弦相似度排序
                var scored = embeddings.map(function (emb, idx) {
                    var dot = 0, na = 0, nb = 0;
                    for (var k = 0; k < emb.length; k++) { dot += queryVec[k] * emb[k]; na += queryVec[k] * queryVec[k]; nb += emb[k] * emb[k]; }
                    return { idx: idx, score: dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-8) };
                }).sort(function (a, b) { return b.score - a.score; });

                // 取 top 3
                var top = scored.slice(0, 3);
                var content = top.map(function (t) { return state.summaries[t.idx].text; }).join("\n\n---\n\n");
                var template = globalApi.vectorPrompt || "";
                var injectionText = template.indexOf("{{context}}") !== -1
                    ? template.replace("{{context}}", content)
                    : "以下为与当前情境相关的因果档案：\n\n" + content;
                st.setExtensionPrompt(EXT_NAME, injectionText, 1, 4);
            });
        }).catch(function () { updateInjection(); }); // 失败降级
    }

    
    function runSummary() {
        var apiUrl = (globalApi.apiUrl || "").trim();
        var apiKey = (globalApi.apiKey || "").trim();
        var model = (globalApi.model || "").trim();
        var summaryPrompt = (globalApi.summaryPrompt || "").trim();
        if (!apiUrl) { toast("请先在引擎标签页设置 API 地址。"); return; }
        var st = getST();
        if (!st || !st.chat || !st.chat.length) { toast("当前无聊天消息。"); return; }
        ensureWorldExists();
        var recentChat = st.chat.slice(-20).map(function (m) { return (m.name || m.role || "???") + ": " + (m.mes || ""); }).join("\n");
        var prompt = (summaryPrompt || "").replace("{{context}}", recentChat);
        var btn = document.getElementById("tlg-summary-run");
        if (btn) btn.disabled = true;
        toast("正在生成总结…");
        fetch(buildEndpoint(apiUrl, "/chat/completions"), {
            method: "POST",
            headers: Object.assign({ "Content-Type": "application/json" }, apiKey ? { Authorization: "Bearer " + apiKey } : {}),
            body: JSON.stringify({ model: model || undefined, messages: [{ role: "user", content: prompt }], max_tokens: 512 })
        }).then(function (res) { if (!res.ok) throw new Error("HTTP " + res.status); return res.json(); })
        .then(function (data) {
            var text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
            if (!state.summaries) state.summaries = [];
            state.summaries.push({ timestamp: Date.now(), text: text });
            saveCurrentWorld(); refreshSummary(); toast("总结已生成。");
        }).catch(function (e) { toast("总结失败: " + e.message); })
        .then(function () { if (btn) btn.disabled = false; });
    }

    function fetchModelList() {
        var apiUrl = (globalApi.apiUrl || "").trim();
        var apiKey = (globalApi.apiKey || "").trim();
        if (!apiUrl) { toast("请先设置 API 地址。"); return; }
        var btn = document.getElementById("tlg-fetch-models"); if (btn) btn.disabled = true;
        toast("正在拉取模型列表…");
        fetch(buildEndpoint(apiUrl, "/models"), { headers: apiKey ? { Authorization: "Bearer " + apiKey } : {} })
        .then(function (res) { if (!res.ok) throw new Error("HTTP " + res.status); return res.json(); })
        .then(function (data) {
            var models = (data.data || data.models || []).map(function (m) { return typeof m === "string" ? m : (m.id || m.name || ""); }).filter(Boolean);
            globalApi.modelList = models; saveGlobalApi(); populateModelSelect();
            toast("已加载 " + models.length + " 个模型。");
        }).catch(function (e) { toast("拉取模型失败: " + e.message); })
        .then(function () { if (btn) btn.disabled = false; });
    }
    function populateModelSelect() {
        var sel = document.getElementById("tlg-model-select"); if (!sel) return;
        sel.innerHTML = '<option value="">-- 选择模型 --</option>' +
            (globalApi.modelList || []).map(function (m) { return '<option value="' + escHtml(m) + '"' + (m === globalApi.model ? " selected" : "") + ">" + escHtml(m) + "</option>"; }).join("");
    }
    function fetchVectorModelList() {
        var apiUrl = (globalApi.vectorUrl || "").trim();
        var apiKey = (globalApi.vectorKey || "").trim();
        if (!apiUrl) { toast("请先设置向量 API 地址。"); return; }
        var btn = document.getElementById("tlg-fetch-vec-models"); if (btn) btn.disabled = true;
        toast("正在拉取向量模型列表…");
        fetch(buildEndpoint(apiUrl, "/models"), { headers: apiKey ? { Authorization: "Bearer " + apiKey } : {} })
        .then(function (res) { if (!res.ok) throw new Error("HTTP " + res.status); return res.json(); })
        .then(function (data) {
            var models = (data.data || data.models || []).map(function (m) { return typeof m === "string" ? m : (m.id || m.name || ""); }).filter(Boolean);
            globalApi.vectorModelList = models; saveGlobalApi(); populateVectorModelSelect();
            toast("已加载 " + models.length + " 个向量模型。");
        }).catch(function (e) { toast("拉取向量模型失败: " + e.message); })
        .then(function () { if (btn) btn.disabled = false; });
    }
    function populateVectorModelSelect() {
        var sel = document.getElementById("tlg-vec-model-select"); if (!sel) return;
        sel.innerHTML = '<option value="">-- 选择模型 --</option>' +
            (globalApi.vectorModelList || []).map(function (m) { return '<option value="' + escHtml(m) + '"' + (m === globalApi.vectorModel ? " selected" : "") + ">" + escHtml(m) + "</option>"; }).join("");
    }

    // ── 诸世界 ──
    function refreshWorlds() {
        var container = document.getElementById("tlg-worlds-list"); if (!container) return;
        var chatId = getCurrentChatId();
        var ids = Object.keys(worlds).sort(function (a, b) { return (worlds[b].updatedAt || 0) - (worlds[a].updatedAt || 0); });
        if (!ids.length) { container.innerHTML = '<div style="color:#6a6a78;padding:20px">暂无世界记录。创建第一个锚定点时将自动生成。</div>'; return; }
        container.innerHTML = ids.map(function (wid) {
            var w = worlds[wid];
            var isCurrent = wid === currentWorldId;
            var isLinked = w.chatId === chatId && chatId;
            return '<div style="background:#0a0a10;border:1px solid ' + (isCurrent ? "#c0c0c8" : "#1a1a28") + ';border-radius:6px;padding:12px;margin-bottom:10px;">' +
                '<div style="display:flex;justify-content:space-between;align-items:center;">' +
                '<div style="font-size:14px;font-weight:600;color:#e8e8f0;">' + escHtml(w.name) +
                (isCurrent ? ' <span style="font-size:11px;color:#6a6a78">(当前)</span>' : "") + '</div>' +
                '<button type="button" class="tlg-btn tlg-btn-danger tlg-worlds-del" data-wid="' + wid + '" style="font-size:11px;padding:4px 8px;writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">✕</button></div>' +
                '<div style="font-size:11px;color:#6a6a78;margin-top:4px;">节点: ' + (w.nodes ? w.nodes.length : 0) + ' | 总结: ' + (w.summaries ? w.summaries.length : 0) + '</div>' +
                '<div style="font-size:11px;color:#6a6a78;">chatId: ' + escHtml(w.chatId || "未关联") + '</div>' +
                '<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;">' +
                (!isCurrent && isLinked ? '<button type="button" class="tlg-btn tlg-btn-primary tlg-worlds-switch" data-wid="' + wid + '" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">切换至此</button>' : "") +
                (!isLinked && !isCurrent ? '<button type="button" class="tlg-btn tlg-worlds-link" data-wid="' + wid + '" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">关联当前聊天</button>' : "") +
                '<button type="button" class="tlg-btn tlg-worlds-rename" data-wid="' + wid + '" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">重命名</button>' +
                '<button type="button" class="tlg-btn tlg-worlds-export" data-wid="' + wid + '" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">导出</button>' +
                '</div></div>';
        }).join("");

        // 事件绑定
        container.querySelectorAll(".tlg-worlds-switch").forEach(function (btn) {
            btn.addEventListener("click", function () {
                var wid = btn.dataset.wid;
                currentWorldId = wid;
                setLinkedWorldId(wid);
                var w = worlds[wid];
                state.nodes = w.nodes || []; state.summaries = w.summaries || [];
                state.currentNodeId = w.currentNodeId || (state.nodes.length ? state.nodes[0].id : null);
                state.selectedNodeId = null;
                toast("已切换至: " + w.name);
                refreshWorlds(); renderCanvas(); refreshArchive();
            });
        });
        container.querySelectorAll(".tlg-worlds-link").forEach(function (btn) {
            btn.addEventListener("click", function () {
                var wid = btn.dataset.wid;
                worlds[wid].chatId = chatId;
                currentWorldId = wid;
                setLinkedWorldId(wid);
                var w = worlds[wid];
                state.nodes = w.nodes || []; state.summaries = w.summaries || [];
                state.currentNodeId = w.currentNodeId || (state.nodes.length ? state.nodes[0].id : null);
                saveWorlds();
                toast("已关联并切换至: " + w.name);
                refreshWorlds(); renderCanvas(); refreshArchive();
            });
        });
        container.querySelectorAll(".tlg-worlds-rename").forEach(function (btn) {
            btn.addEventListener("click", function () {
                var wid = btn.dataset.wid;
                var newName = prompt("输入新名称:", worlds[wid].name || "");
                if (newName === null) return;
                worlds[wid].name = newName.trim() || worlds[wid].name;
                saveWorlds(); refreshWorlds(); toast("已重命名。");
            });
        });
        container.querySelectorAll(".tlg-worlds-export").forEach(function (btn) {
            btn.addEventListener("click", function () {
                var wid = btn.dataset.wid;
                var w = worlds[wid];
                var blob = new Blob([JSON.stringify(w, null, 2)], { type: "application/json" });
                var url = URL.createObjectURL(blob);
                var a = document.createElement("a");
                a.href = url; a.download = (w.name || "world") + ".json"; a.click();
                URL.revokeObjectURL(url);
                toast("已导出: " + w.name);
            });
        });
        container.querySelectorAll(".tlg-worlds-del").forEach(function (btn) {
            btn.addEventListener("click", function () {
                var wid = btn.dataset.wid;
                if (wid === currentWorldId) { toast("无法删除当前活跃世界。"); return; }
                if (!confirm("确定删除世界「" + (worlds[wid] ? worlds[wid].name : "") + "」？所有节点和总结将丢失。")) return;
                delete worlds[wid]; saveWorlds(); refreshWorlds(); toast("世界已删除。");
            });
        });
    }

    function importWorld() {
        var input = document.createElement("input");
        input.type = "file"; input.accept = ".json";
        input.onchange = function () {
            var file = input.files[0]; if (!file) return;
            var reader = new FileReader();
            reader.onload = function () {
                try {
                    var data = JSON.parse(reader.result);
                    if (!data.nodes || !data.nodes.length) { toast("无效的世界文件。"); return; }
                    var wid = data.id || generateId();
                    if (worlds[wid]) wid = generateId(); // 防重复
                    data.id = wid;
                    if (!data.name) data.name = file.name.replace(/\.json$/, "");
                    if (!data.createdAt) data.createdAt = Date.now();
                    data.updatedAt = Date.now();
                    worlds[wid] = data;
                    saveWorlds(); refreshWorlds();
                    toast("已导入: " + data.name);
                } catch (e) { toast("导入失败: " + e.message); }
            };
            reader.readAsText(file);
        };
        input.click();
    }
    // ── 面板构建 ──
    function ensurePanelBuilt() {
        if (document.getElementById("tlg-panel")) return;
        var s = globalApi;
        var panel = document.createElement("div");
        panel.id = "tlg-panel";
        panel.style.cssText = "display:none;position:fixed;top:0;left:0;width:100%;height:100%;height:100dvh;background:#050508;color:#c0c0c8;z-index:2147483647;flex-direction:column;font-family:-apple-system,sans-serif;overflow:hidden;";
        panel.innerHTML =
            '<div id="tlg-tabs">' +
            '<div class="tlg-tab active" data-tab="tree">因果树</div>' +
            '<div class="tlg-tab" data-tab="archive">档案库</div>' +
            '<div class="tlg-tab" data-tab="summary">总结池</div>' +
            '<div class="tlg-tab" data-tab="worlds">诸世界</div>' +
            '<div class="tlg-tab" data-tab="engine">引擎设置</div>' +
            '<div id="tlg-close">✕</div></div>' +
            '<div id="tlg-body">' +
            // tree
            '<div class="tlg-view active" id="tlg-view-tree" data-view="tree">' +
            '<div id="tlg-canvas-wrap"><canvas id="tlg-tree-canvas"></canvas>' +
            '<div id="tlg-canvas-toolbar" style="position:absolute;top:10px;left:10px;right:10px;display:flex;flex-direction:row;flex-wrap:wrap;gap:8px;z-index:2;">' +
            '<button type="button" class="tlg-btn" id="tlg-canvas-anchor" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">⚓ 在此锚定</button>' +
            '<button type="button" class="tlg-btn" id="tlg-canvas-reset-view" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">重置视图</button></div></div>' +
            '<div id="tlg-brief-panel">' +
            '<div class="tlg-brief-header"><span>节点</span>' +
            '<button type="button" class="tlg-btn" id="tlg-brief-close" style="padding:2px 8px;writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">✕</button></div>' +
            '<div class="tlg-brief-body"></div><div class="tlg-brief-footer"></div></div></div>' +
            // archive
            '<div class="tlg-view" data-view="archive"><div class="tlg-scroll-panel">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;gap:8px;flex-wrap:wrap">' +
            '<div style="font-size:15px;font-weight:600;color:#e8e8f0">全部节点</div>' +
            '<button type="button" class="tlg-btn tlg-btn-primary" id="tlg-archive-new" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">⚓ 新建锚定</button></div>' +
            '<div id="tlg-archive-list"></div></div></div>' +
            // summary
            '<div class="tlg-view" data-view="summary"><div class="tlg-scroll-panel">' +
            '<div class="tlg-section"><div class="tlg-section-title">自动总结模式</div>' +
            '<div class="tlg-row"><span class="tlg-label" style="margin:0">自动模式</span>' +
            '<div class="tlg-toggle ' + (s.autoMode ? "on" : "") + '" id="tlg-auto-toggle"></div></div>' +
            '<div class="tlg-row"><label class="tlg-label" style="margin:0;flex:1">每 <input class="tlg-input" id="tlg-auto-interval" type="number" min="1" value="' + (s.autoInterval || 10) + '" style="width:70px;display:inline-block;padding:4px 8px;margin:0 6px;font-size:14px"> 轮提醒</label></div>' +
            '<div class="tlg-row"><label class="tlg-label" style="margin:0;flex:1">跳转后显示最后 <input class="tlg-input" id="tlg-last-n" type="number" min="1" value="' + (s.lastNMessages || 5) + '" style="width:70px;display:inline-block;padding:4px 8px;margin:0 6px;font-size:14px"> 条消息</label></div></div>' +
            '<div class="tlg-section"><div class="tlg-section-title">总结提示词</div>' +
            '<label class="tlg-label">提示词模板（{{context}}）</label>' +
            '<textarea class="tlg-textarea" id="tlg-summary-prompt" style="min-height:120px">' + escHtml(s.summaryPrompt || "") + '</textarea>' +
            '<button type="button" class="tlg-btn tlg-btn-primary" id="tlg-summary-run" style="margin-top:10px;writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">▶ 立即生成总结</button></div>' +
            '<div class="tlg-section"><div class="tlg-section-title">总结历史</div><div style="font-size:12px;color:#6a6a78;margin-bottom:8px;">点击下方按钮查看完整历史，支持搜索和编辑。</div><div id="tlg-summary-list"></div></div></div></div>' +
            // worlds
            '<div class="tlg-view" data-view="worlds"><div class="tlg-scroll-panel">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;gap:8px;flex-wrap:wrap;">' +
            '<div style="font-size:15px;font-weight:600;color:#e8e8f0;">诸世界</div>' +
            '<button type="button" class="tlg-btn tlg-btn-primary" id="tlg-worlds-import" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">📥 导入世界</button></div>' +
            '<div style="font-size:12px;color:#6a6a78;margin-bottom:12px;">当前聊天: ' + escHtml(getCurrentChatId() || "未知") + (currentWorldId ? " → " + escHtml((worlds[currentWorldId] || {}).name || "") : " (未关联)") + '</div>' +
            '<div id="tlg-worlds-list"></div></div></div>' +
            // engine
            '<div class="tlg-view" data-view="engine"><div class="tlg-scroll-panel">' +
            '<div class="tlg-section"><div class="tlg-section-title">API 配置</div>' +
            '<label class="tlg-label">API 基础地址</label><div class="tlg-row">' +
            '<input class="tlg-input" id="tlg-api-url" placeholder="https://api.openai.com" value="' + escHtml(s.apiUrl || "") + '" />' +
            '<button type="button" class="tlg-btn" id="tlg-test-api" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">测试</button></div>' +
            '<label class="tlg-label">API 密钥</label>' +
            '<input class="tlg-input" id="tlg-api-key" type="password" value="' + escHtml(s.apiKey || "") + '" style="margin-bottom:12px" />' +
            '<label class="tlg-label">模型</label><div class="tlg-row">' +
            '<select class="tlg-select" id="tlg-model-select" style="flex:1"></select>' +
            '<button type="button" class="tlg-btn" id="tlg-fetch-models" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">拉取列表</button></div>' +
            '<label class="tlg-label">或手动输入</label>' +
            '<input class="tlg-input" id="tlg-model-manual" value="' + escHtml(s.model || "") + '" /></div>' +
            '<div class="tlg-section"><div class="tlg-section-title">向量 API（可选）</div>' +
            '<label class="tlg-label">向量 API 地址</label><div class="tlg-row">' +
            '<input class="tlg-input" id="tlg-vec-url" value="' + escHtml(s.vectorUrl || "") + '" />' +
            '<button type="button" class="tlg-btn" id="tlg-test-vec-api" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">测试</button></div>' +
            '<label class="tlg-label">向量 API 密钥</label>' +
            '<input class="tlg-input" id="tlg-vec-key" type="password" value="' + escHtml(s.vectorKey || "") + '" style="margin-bottom:12px" />' +
            '<label class="tlg-label">向量模型</label><div class="tlg-row">' +
            '<select class="tlg-select" id="tlg-vec-model-select" style="flex:1"></select>' +
            '<button type="button" class="tlg-btn" id="tlg-fetch-vec-models" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">拉取列表</button></div>' +
            '<label class="tlg-label">或手动输入</label>' +
            '<input class="tlg-input" id="tlg-vec-model" value="' + escHtml(s.vectorModel || "") + '" style="margin-bottom:8px" />' +
            '<label class="tlg-label">检索提示词模板</label>' +
            '<textarea class="tlg-textarea" id="tlg-vec-prompt">' + escHtml(s.vectorPrompt || "") + '</textarea></div>' +
            '<button type="button" class="tlg-btn tlg-btn-primary" id="tlg-engine-save" style="width:100%!important;writing-mode:horizontal-tb;white-space:nowrap;height:auto;">保存引擎设置</button>' +
            '</div></div></div>';

        document.body.appendChild(panel);
        bindPanelEvents(panel);
    }

    function openPanel() {
        if (!isEnabled()) { toast("河岸凝视已关闭，请到「扩展」设置中开启。"); return; }
        loadCurrentWorld();
        migrateOldData();
        var existingPanel = document.getElementById("tlg-panel");
        if (existingPanel) existingPanel.remove();
        ensurePanelBuilt();
        var panel = document.getElementById("tlg-panel"); if (!panel) return;
        panel.style.display = "flex";
        document.body.style.overflow = "hidden";
        setTimeout(function () { renderCanvas(); }, 80);
    }
    function closePanel() {
        var panel = document.getElementById("tlg-panel");
        if (panel) panel.style.display = "none";
        document.body.style.overflow = "";
    }
    function switchTab(name) {
        var panel = document.getElementById("tlg-panel"); if (!panel) return;
        panel.querySelectorAll(".tlg-tab").forEach(function (t) { t.classList.toggle("active", t.getAttribute("data-tab") === name); });
        panel.querySelectorAll(".tlg-view").forEach(function (v) {
            var on = v.getAttribute("data-view") === name;
            v.classList.toggle("active", on); v.style.display = on ? "flex" : "none";
        });
        if (name === "tree") setTimeout(renderCanvas, 50);
        else if (name === "archive") refreshArchive();
        else if (name === "summary") refreshSummary();
        else if (name === "worlds") refreshWorlds();
        else if (name === "engine") { populateModelSelect(); populateVectorModelSelect(); }
    }

    function bindPanelEvents(panel) {
        document.getElementById("tlg-close").onclick = closePanel;
        panel.querySelectorAll(".tlg-tab").forEach(function (tab) { tab.onclick = function () { switchTab(tab.getAttribute("data-tab")); }; });
        document.getElementById("tlg-brief-close").onclick = closeBriefPanel;
        document.getElementById("tlg-canvas-anchor").onclick = function () { showAnchorModal(); };
        document.getElementById("tlg-canvas-reset-view").onclick = function () { camX = 0; camY = 0; camZoom = 1; renderCanvas(); };
        document.getElementById("tlg-archive-new").onclick = function () { showAnchorModal(); };
        document.getElementById("tlg-worlds-import").addEventListener("click", importWorld);

        document.getElementById("tlg-auto-toggle").addEventListener("click", function () {
            globalApi.autoMode = !globalApi.autoMode; this.classList.toggle("on", globalApi.autoMode); saveGlobalApi();
        });
        document.getElementById("tlg-auto-interval").addEventListener("change", function () { globalApi.autoInterval = Math.max(1, parseInt(this.value, 10) || 10); saveGlobalApi(); });
        document.getElementById("tlg-last-n").addEventListener("change", function () { globalApi.lastNMessages = Math.max(1, parseInt(this.value, 10) || 5); saveGlobalApi(); });
        document.getElementById("tlg-summary-prompt").addEventListener("change", function () { globalApi.summaryPrompt = this.value; saveGlobalApi(); });
        document.getElementById("tlg-summary-run").addEventListener("click", function () { flashBtn(this); runSummary(); });

        document.getElementById("tlg-engine-save").addEventListener("click", function () {
            flashBtn(this);
            globalApi.apiUrl = document.getElementById("tlg-api-url").value.trim();
            globalApi.apiKey = document.getElementById("tlg-api-key").value.trim();
            globalApi.vectorUrl = document.getElementById("tlg-vec-url").value.trim();
            globalApi.vectorKey = document.getElementById("tlg-vec-key").value.trim();
            var vecManual = document.getElementById("tlg-vec-model").value.trim();
            var vecSel = document.getElementById("tlg-vec-model-select").value;
            globalApi.vectorModel = vecManual || vecSel;
            globalApi.vectorPrompt = document.getElementById("tlg-vec-prompt").value;
            var manual = document.getElementById("tlg-model-manual").value.trim();
            var sel = document.getElementById("tlg-model-select").value;
            globalApi.model = manual || sel;
            saveGlobalApi();
            toast("引擎设置已保存。");
        });
        document.getElementById("tlg-fetch-models").addEventListener("click", function () {
            flashBtn(this);
            globalApi.apiUrl = document.getElementById("tlg-api-url").value.trim();
            globalApi.apiKey = document.getElementById("tlg-api-key").value.trim();
            saveGlobalApi(); fetchModelList();
        });
        document.getElementById("tlg-model-select").addEventListener("change", function () { if (this.value) document.getElementById("tlg-model-manual").value = this.value; });
        document.getElementById("tlg-vec-model-select").addEventListener("change", function () { if (this.value) document.getElementById("tlg-vec-model").value = this.value; });
        document.getElementById("tlg-fetch-vec-models").addEventListener("click", function () {
            flashBtn(this);
            globalApi.vectorUrl = document.getElementById("tlg-vec-url").value.trim();
            globalApi.vectorKey = document.getElementById("tlg-vec-key").value.trim();
            saveGlobalApi(); fetchVectorModelList();
        });
        document.getElementById("tlg-test-api").addEventListener("click", function () {
            var url = document.getElementById("tlg-api-url").value.trim();
            var key = document.getElementById("tlg-api-key").value.trim();
            if (!url) { toast("请先输入地址。"); return; }
            flashBtn(this); toast("正在测试…");
            fetch(buildEndpoint(url, "/models"), { headers: key ? { Authorization: "Bearer " + key } : {} })
            .then(function (res) { toast(res.ok ? "✓ API 可达。" : ("✗ HTTP " + res.status)); })
            .catch(function (e) { toast("✗ " + e.message); });
        });
        document.getElementById("tlg-test-vec-api").addEventListener("click", function () {
            var url = document.getElementById("tlg-vec-url").value.trim();
            var key = document.getElementById("tlg-vec-key").value.trim();
            if (!url) { toast("请先输入向量 API 地址。"); return; }
            flashBtn(this); toast("正在测试…");
            fetch(buildEndpoint(url, "/models"), { headers: key ? { Authorization: "Bearer " + key } : {} })
            .then(function (res) { toast(res.ok ? "✓ 向量 API 可达。" : ("✗ HTTP " + res.status)); })
            .catch(function (e) { toast("✗ " + e.message); });
        });

        initCanvasEvents();
    }

    function initCanvasEvents() {
        var wrap = document.getElementById("tlg-canvas-wrap"); if (!wrap) return;
        canvas = document.getElementById("tlg-tree-canvas");
        ctx = canvas.getContext("2d");
        if (typeof ResizeObserver !== "undefined") { new ResizeObserver(function () { renderCanvas(); }).observe(wrap); }
        canvas.addEventListener("mousedown", function (e) {
            if (e.button !== 0) return;
            var hit = canvasHitTest(e.clientX, e.clientY);
            if (hit) { openBriefPanel(hit); return; }
            isPanning = true; panStartX = e.clientX - camX; panStartY = e.clientY - camY;
        });
        canvas.addEventListener("mousemove", function (e) { if (!isPanning) return; camX = e.clientX - panStartX; camY = e.clientY - panStartY; renderCanvas(); });
        function endPan() { isPanning = false; }
        canvas.addEventListener("mouseup", endPan); canvas.addEventListener("mouseleave", endPan);
        canvas.addEventListener("wheel", function (e) { e.preventDefault(); camZoom = Math.max(0.2, Math.min(4, camZoom * (e.deltaY < 0 ? 1.1 : 0.91))); renderCanvas(); }, { passive: false });
        var lastTouchDist = 0, touchStartHit = null, touchMoved = false;
        canvas.addEventListener("touchstart", function (e) {
            touchMoved = false;
            if (e.touches.length === 1) { isPanning = true; panStartX = e.touches[0].clientX - camX; panStartY = e.touches[0].clientY - camY; touchStartHit = canvasHitTest(e.touches[0].clientX, e.touches[0].clientY); }
            else if (e.touches.length === 2) { isPanning = false; lastTouchDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY); }
        }, { passive: true });
        canvas.addEventListener("touchmove", function (e) {
            touchMoved = true;
            if (e.touches.length === 1 && isPanning) { camX = e.touches[0].clientX - panStartX; camY = e.touches[0].clientY - panStartY; renderCanvas(); }
            else if (e.touches.length === 2) { var dist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY); if (lastTouchDist > 0) { camZoom = Math.max(0.2, Math.min(4, camZoom * (dist / lastTouchDist))); renderCanvas(); } lastTouchDist = dist; }
        }, { passive: true });
        canvas.addEventListener("touchend", function () { if (!touchMoved && touchStartHit) openBriefPanel(touchStartHit); isPanning = false; touchStartHit = null; }, { passive: true });
    }

    // ── 入口 ──
    function injectMenuButton() {
        if (!isEnabled()) { var old = document.getElementById("tlg-menu-btn"); if (old) old.remove(); return; }
        var menu = document.getElementById("extensionsMenu"); if (!menu) return;
        if (document.getElementById("tlg-menu-btn")) return;
        var btn = document.createElement("div");
        btn.id = "tlg-menu-btn"; btn.className = "list-group-item flex-container flexGap5 interactable"; btn.style.cursor = "pointer";
        btn.innerHTML = '<i class="fa-solid fa-water"></i><span>河岸凝视</span>';
        btn.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); var p = document.getElementById("tlg-panel"); if (p && p.style.display === "flex") closePanel(); else openPanel(); });
        menu.appendChild(btn);
    }
    function injectSettingsPanel() {
        if (document.getElementById("tlg_settings_block")) return;
        var host = document.querySelector("#extensions_settings2") || document.querySelector("#extensions_settings") || document.querySelector("#extensions_settings1");
        if (!host) return;
        var enabled = isEnabled();
        var block = document.createElement("div"); block.id = "tlg_settings_block"; block.className = "extension_container";
        block.innerHTML =
            '<div class="inline-drawer"><div class="inline-drawer-toggle inline-drawer-header"><b>🌊 河岸凝视</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>' +
            '<div class="inline-drawer-content"><div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin:8px 0;"><span>启用插件</span>' +
            '<div class="tlg-toggle ' + (enabled ? "on" : "") + '" id="tlg_enable_toggle"></div></div>' +
            '<div style="font-size:12px;opacity:.75;margin-bottom:10px;">关闭后隐藏菜单入口。</div>' +
            '<button type="button" class="tlg-btn tlg-btn-primary" id="tlg_settings_open" style="writing-mode:horizontal-tb;white-space:nowrap;width:auto;height:auto;">打开河岸凝视面板</button>' +
            '<div style="font-size:11px;opacity:.55;margin-top:10px;">斜杠命令：/tlg_anchor</div></div></div>';
        host.appendChild(block);
        document.getElementById("tlg_enable_toggle").onclick = function () { var next = !this.classList.contains("on"); this.classList.toggle("on", next); setEnabled(next); toast(next ? "河岸凝视已启用" : "河岸凝视已关闭"); };
        document.getElementById("tlg_settings_open").onclick = function () { openPanel(); };
    }
    function registerSlashCommand() {
        function wrap(value) { if (!isEnabled()) { toast("河岸凝视已关闭。"); return ""; } loadCurrentWorld(); showAnchorModal(String(value || "")); return ""; }
        var st = getST();
        if (st && st.registerSlashCommand) { st.registerSlashCommand("tlg_anchor", function (a, v) { return wrap(v); }, [], "创建河岸凝视锚定点", true, true); }
        if (window.SillyTavern && window.SillyTavern.SlashCommandParser) {
            try {
                window.SillyTavern.SlashCommandParser.addCommandObject(
                    window.SillyTavern.SlashCommand.fromProps({ name: "tlg_anchor", callback: function (a, v) { return wrap(v); }, helpString: "创建河岸凝视因果锚定点。" })
                );
            } catch (e) {}
        }
    }

    function boot() {
        injectMenuButton();
        injectSettingsPanel();
        new MutationObserver(function () { injectMenuButton(); injectSettingsPanel(); }).observe(document.body, { childList: true, subtree: true });
        setInterval(injectMenuButton, 2000);
        registerSlashCommand();
        try {
            var ctx0 = getST();
            if (ctx0 && ctx0.eventSource && ctx0.eventTypes) {
                ctx0.eventSource.on(ctx0.eventTypes.CHAT_CHANGED, function () {
                    var p = document.getElementById("tlg-panel"); if (p) p.remove();
                    document.body.style.overflow = "";
                });
            }
        } catch (e) {}
                // 启动时加载当前世界并注入
        try { loadCurrentWorld(); } catch (e) {}
        console.log("[TLG] 河岸凝视 v3.0 已加载");
    }

    if (document.readyState === "loading") { document.addEventListener("DOMContentLoaded", boot); }
    else { setTimeout(boot, 300); }
})();
