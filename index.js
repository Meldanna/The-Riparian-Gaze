/**
 * 河岸凝视 v3.0
 * 新增：诸世界标签 / extension_settings全局持久化 / 自定义命名 / 导入导出 / 手动关联
 */
(function () {
    "use strict";

    var EXT_NAME = "RiparianGaze";
    var METADATA_KEY = "tlg_data";

    // ── state：仅存当前世界的运行时数据 ──
    var state = {
        nodes: [],
        currentNodeId: null,
        selectedNodeId: null,
        settings: {
            autoMode: false,
            autoInterval: 10,
            lastNMessages: 5,
            apiUrl: "",
            apiKey: "",
            model: "",
            modelList: [],
            vectorUrl: "",
            vectorKey: "",
            vectorModel: "",
            vectorModelList: [],
            vectorPrompt: "以下为因果档案库中与当前观测焦点相关的历史切片：\n\n{{context}}\n\n处理规则：\n- 这些是已铭刻的因果事实，不可篡改\n- 当前叙事必须与这些记录在逻辑上连续\n- 若当前事件是某条历史线的后果，自然呈现因果关系\n- 不要直接引用或复述这些档案内容",
            summaryPrompt: "你是因果记录仪。对以下对话执行状态切片，提取并压缩为因果档案。\n\n【因果事件链】本段发生的事件，按因果顺序（A导致B导致C），每条一句\n【样本状态变动】主角的生理、心理、物品、关系的变化\n【NPC状态变动】在场NPC的行为、立场、情绪变化\n【悬置因果线】未完成的选择、未触发的后果、埋下的伏笔\n【环境快照】地点·天气·时间·在场实体\n\n对话内容：\n{{context}}\n\n要求：纯事实记录，无评论，无修辞。每条尽量压缩至15字以内。"
        },
        summaries: [],
        turnsSinceAnchor: 0,
        _lastChatLen: 0
    };

    // ── 全局存储（API设置 + 诸世界目录）──
    // 结构：
    //   tlg_global.api         = { apiUrl, apiKey, model, modelList, vectorUrl, ... }
    //   tlg_global.worlds      = { [worldId]: { name, chatId, createdAt, updatedAt } }
    //   tlg_global.worldData   = { [worldId]: { nodes, summaries, settings_override... } }
    //                            ← 每个世界的完整因果树/总结池，存在extension_settings里
    //
    // 当前聊天只存一个指针：chat_metadata.tlg_worldId = worldId
    // 这样即使聊天文件名变了、重新导入，也能通过手动关联接回来

    function getExtSettings() {
        var st = getST();
        var es = (st && st.extensionSettings) || window.extension_settings || {};
        if (!es[EXT_NAME]) es[EXT_NAME] = {};
        return es[EXT_NAME];
    }

    function saveExtSettings() {
        var st = getST();
        if (st && typeof st.saveSettingsDebounced === "function") st.saveSettingsDebounced();
        else if (typeof window.saveSettingsDebounced === "function") window.saveSettingsDebounced();
    }

    // ── 全局 API 设置（跨所有世界共享）──
    var API_FIELDS = ["apiUrl","apiKey","model","modelList","vectorUrl","vectorKey","vectorModel","vectorModelList","vectorPrompt","summaryPrompt","autoMode","autoInterval","lastNMessages"];

    function loadGlobalApi() {
        var es = getExtSettings();
        var api = es.api || {};
        for (var i = 0; i < API_FIELDS.length; i++) {
            var k = API_FIELDS[i];
            if (api[k] !== undefined) state.settings[k] = api[k];
        }
    }

    function saveGlobalApi() {
        var es = getExtSettings();
        if (!es.api) es.api = {};
        for (var i = 0; i < API_FIELDS.length; i++) {
            es.api[API_FIELDS[i]] = state.settings[API_FIELDS[i]];
        }
        saveExtSettings();
    }

    // ── 世界目录操作 ──
    function getWorldsDir() {
        var es = getExtSettings();
        if (!es.worlds) es.worlds = {};
        return es.worlds;
    }

    function getWorldData(worldId) {
        var es = getExtSettings();
        if (!es.worldData) es.worldData = {};
        return es.worldData[worldId] || null;
    }

    function setWorldData(worldId, data) {
        var es = getExtSettings();
        if (!es.worldData) es.worldData = {};
        es.worldData[worldId] = data;
    }

    // 获取当前聊天关联的worldId（存在chat_metadata里）
    function getCurrentWorldId() {
        var st = getST();
        return st && st.chat_metadata && st.chat_metadata.tlg_worldId || null;
    }

    function setCurrentWorldId(worldId) {
        var st = getST();
        if (!st) return;
        if (!st.chat_metadata) st.chat_metadata = {};
        st.chat_metadata.tlg_worldId = worldId;
        if (typeof st.saveMetadata === "function") st.saveMetadata();
        else if (typeof window.saveMetadataDebounced === "function") window.saveMetadataDebounced();
    }

    // 获取当前聊天的chatId（酒馆用来识别聊天文件的唯一标识）
    function getCurrentChatId() {
        var st = getST();
        if (!st) return null;
        return st.chatId || (st.getCurrentChatId && st.getCurrentChatId()) || null;
    }

    // ── 从 extension_settings 加载世界数据到 state ──
    function loadWorldState(worldId) {
        var data = getWorldData(worldId);
        if (data) {
            if (data.nodes) state.nodes = JSON.parse(JSON.stringify(data.nodes));
            if (data.summaries) state.summaries = JSON.parse(JSON.stringify(data.summaries));
            if (data.currentNodeId !== undefined) state.currentNodeId = data.currentNodeId;
            state.selectedNodeId = null;
            state.turnsSinceAnchor = data.turnsSinceAnchor || 0;
            state._lastChatLen = data._lastChatLen || 0;
        } else {
            resetState();
        }
    }

    // ── 把 state 写回 extension_settings ──
    function saveWorldState(worldId) {
        if (!worldId) return;
        setWorldData(worldId, {
            nodes: JSON.parse(JSON.stringify(state.nodes)),
            summaries: JSON.parse(JSON.stringify(state.summaries)),
            currentNodeId: state.currentNodeId,
            turnsSinceAnchor: state.turnsSinceAnchor,
            _lastChatLen: state._lastChatLen,
            updatedAt: Date.now()
        });
        // 更新世界目录里的 updatedAt
        var dir = getWorldsDir();
        if (dir[worldId]) dir[worldId].updatedAt = Date.now();
        saveExtSettings();
    }

    // ── 创建新世界条目 ──
    function createWorldEntry(name, chatId) {
        var worldId = "w_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        var dir = getWorldsDir();
        dir[worldId] = {
            name: name || ("世界 " + Object.keys(dir).length),
            chatId: chatId || null,
            createdAt: Date.now(),
            updatedAt: Date.now()
        };
        saveExtSettings();
        return worldId;
    }

    // ── 主加载入口（打开面板时调用）──
    function loadFromMetadata() {
        var st = getST();
        loadGlobalApi();

        var worldId = getCurrentWorldId();
        if (!worldId) {
            // 尝试按 chatId 自动匹配
            var chatId = getCurrentChatId();
            if (chatId) {
                var dir = getWorldsDir();
                var matched = null;
                var ids = Object.keys(dir);
                for (var i = 0; i < ids.length; i++) {
                    if (dir[ids[i]].chatId === chatId) { matched = ids[i]; break; }
                }
                if (matched) {
                    worldId = matched;
                    setCurrentWorldId(worldId);
                }
            }
        }

        if (!worldId) {
            // 新聊天，尚未关联任何世界：先不自动创建，等用户在面板里操作
            resetState();
            return;
        }

        loadWorldState(worldId);
    }

    // ── 主保存入口 ──
    function saveToMetadata() {
        var worldId = getCurrentWorldId();
        if (worldId) saveWorldState(worldId);
        // 向后兼容：同时写一份到 chat_metadata（方便调试）
        var st = getST();
        if (st) {
            if (!st.chat_metadata) st.chat_metadata = {};
            st.chat_metadata[METADATA_KEY] = { _worldId: worldId };
            if (typeof st.saveMetadata === "function") st.saveMetadata();
        }
    }

    // ── 确保当前聊天有关联世界（面板里用到）──
    function ensureWorldLinked(preferName) {
        var worldId = getCurrentWorldId();
        if (!worldId) {
            var chatId = getCurrentChatId();
            worldId = createWorldEntry(preferName || "未命名世界", chatId);
            setCurrentWorldId(worldId);
            resetState();
            saveWorldState(worldId);
        }
        return worldId;
    }

    // ── 兼容旧数据迁移 ──
    function migrateFromOldFormat() {
        var st = getST();
        if (!st || !st.chat_metadata) return;
        var old = st.chat_metadata[METADATA_KEY];
        if (!old || old._worldId) return; // 已是新格式或空
        if (!old.nodes || !old.nodes.length) return;

        var chatId = getCurrentChatId();
        var worldId = createWorldEntry("迁移世界", chatId);
        setWorldData(worldId, {
            nodes: old.nodes,
            summaries: old.summaries || [],
            currentNodeId: old.currentNodeId,
            turnsSinceAnchor: old.turnsSinceAnchor || 0,
            _lastChatLen: old._lastChatLen || 0,
            updatedAt: Date.now()
        });
        if (old.settings) {
            var es = getExtSettings();
            if (!es.api) es.api = {};
            for (var k in old.settings) {
                if (old.settings.hasOwnProperty(k)) es.api[k] = old.settings[k];
            }
        }
        setCurrentWorldId(worldId);
        st.chat_metadata[METADATA_KEY] = { _worldId: worldId };
        if (typeof st.saveMetadata === "function") st.saveMetadata();
        saveExtSettings();
        toast("已自动迁移旧版数据至「" + (getWorldsDir()[worldId] && getWorldsDir()[worldId].name) + "」");
    }

    // ══════════════════════════════════════════════════
    //  以下为原有逻辑，基本不变，仅把所有 saveToMetadata
    //  / loadFromMetadata 调用保留，内部已重定向到上方
    // ══════════════════════════════════════════════════

    var canvas = null, ctx = null;
    var camX = 0, camY = 0, camZoom = 1;
    var isPanning = false, panStartX = 0, panStartY = 0;

    function getST() {
        return (window.SillyTavern && window.SillyTavern.getContext)
            ? window.SillyTavern.getContext()
            : null;
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
        setTimeout(function () {
            el.style.opacity = "0";
            setTimeout(function () { el.remove(); }, 400);
        }, duration);
    }

    function flashBtn(btn) {
        if (!btn) return;
        var orig = btn.style.boxShadow || "";
        btn.style.boxShadow = "0 0 12px 2px rgba(192,192,210,0.6)";
        btn.style.transition = "box-shadow 0.3s";
        setTimeout(function () { btn.style.boxShadow = orig; }, 800);
    }

    function escHtml(str) {
        return String(str || "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    function isEnabled() {
        try {
            var es = getExtSettings();
            return es.enabled !== false;
        } catch (e) { return true; }
    }

    function setEnabled(on) {
        try {
            getExtSettings().enabled = !!on;
            saveExtSettings();
            if (!on) closePanel();
            injectMenuButton();
            var toggle = document.getElementById("tlg_enable_toggle");
            if (toggle) toggle.classList.toggle("on", !!on);
        } catch (e) { console.warn("[TLG] setEnabled", e); }
    }

    function resetState() {
        var rootId = generateId();
        state.nodes = [{
            id: rootId, name: "起源点", brief: "时间线起源。",
            parentId: null, msgIdx: 0, statData: null,
            timestamp: Date.now(), children: []
        }];
        state.currentNodeId = rootId;
        state.selectedNodeId = null;
        state.summaries = [];
        state.turnsSinceAnchor = 0;
        state._lastChatLen = 0;
    }

    function findNode(id) {
        return state.nodes.find(function (n) { return n.id === id; }) || null;
    }

    function getPathToRoot(nodeId) {
        var path = [];
        var cur = findNode(nodeId);
        while (cur) {
            path.unshift(cur.id);
            cur = findNode(cur.parentId);
        }
        return path;
    }

    function getMVUStatData() {
        try {
            var st = getST();
            if (st && st.chat_metadata && st.chat_metadata.stat_data != null)
                return JSON.parse(JSON.stringify(st.chat_metadata.stat_data));
            if (typeof window.getAllVariables === "function") {
                var all = window.getAllVariables();
                if (all && all.stat_data != null) return JSON.parse(JSON.stringify(all.stat_data));
            }
        } catch (e) {}
        return null;
    }

    function setMVUStatData(data) {
        if (data == null) return;
        try {
            var st = getST();
            if (st && st.chat_metadata) {
                st.chat_metadata.stat_data = JSON.parse(JSON.stringify(data));
                if (typeof st.saveMetadata === "function") st.saveMetadata();
            }
            if (typeof window.setVariable === "function") window.setVariable("stat_data", data);
        } catch (e) {}
    }

    function applyVisibility(targetNodeId) {
        var st = getST();
        if (!st || !st.chat) return;
        var pathIds = getPathToRoot(targetNodeId);
        var pathNodes = pathIds.map(findNode).filter(Boolean);
        var visible = {};
        var i, m, node, next, start, end;
        for (i = 0; i < pathNodes.length; i++) {
            node = pathNodes[i];
            next = pathNodes[i + 1] || null;
            start = node.msgIdx;
            end = next ? next.msgIdx - 1 : node.msgIdx;
            for (m = start; m <= end; m++) visible[m] = true;
        }
        var target = findNode(targetNodeId);
        var lastN = Math.max(0, (state.settings && state.settings.lastNMessages) || 5);
        var endIdx = target ? target.msgIdx : st.chat.length - 1;
        for (m = Math.max(0, endIdx - lastN + 1); m <= endIdx; m++) visible[m] = true;
        for (i = 0; i < st.chat.length; i++) {
            if (visible[i]) delete st.chat[i].is_hidden;
            else st.chat[i].is_hidden = true;
        }
        if (typeof st.saveChat === "function") st.saveChat();
    }

    function createAnchor(name, brief) {
        var st = getST();
        if (!st) return;
        ensureWorldLinked();
        var msgIdx = st.chat ? Math.max(0, st.chat.length - 1) : 0;
        var parentId = state.currentNodeId;
        var newId = generateId();
        var newNode = {
            id: newId,
            name: name || ("节点 " + state.nodes.length),
            brief: brief || "",
            parentId: parentId,
            msgIdx: msgIdx,
            statData: getMVUStatData(),
            timestamp: Date.now(),
            children: []
        };
        var parent = findNode(parentId);
        if (parent && parent.children.indexOf(newId) === -1) parent.children.push(newId);
        state.nodes.push(newNode);
        state.currentNodeId = newId;
        state.selectedNodeId = newId;
        state.turnsSinceAnchor = 0;
        saveToMetadata();
        toast("⚓ 已锚定: " + newNode.name);
        renderCanvas();
        refreshArchive();
        return newId;
    }

    function jumpToNode(nodeId) {
        var node = findNode(nodeId);
        if (!node) { toast("节点不存在。"); return; }
        if (node.statData != null) setMVUStatData(node.statData);
        applyVisibility(nodeId);
        state.currentNodeId = nodeId;
        state.turnsSinceAnchor = 0;
        saveToMetadata();
        toast("↩ 已跳转至: " + node.name);
        renderCanvas();
        refreshArchive();
        closeBriefPanel();
    }

    function showAnchorModal(prefillName) {
        if (!isEnabled()) { toast("河岸凝视已关闭。"); return; }
        var existing = document.getElementById("tlg-anchor-modal");
        if (existing) existing.remove();

        var backdrop = document.createElement("div");
        backdrop.className = "tlg-modal-backdrop";
        backdrop.id = "tlg-anchor-modal";
        backdrop.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100dvh;background:rgba(0,0,0,0.82);z-index:2147483647;display:flex;align-items:flex-start;justify-content:center;padding:16px;padding-top:12vh;box-sizing:border-box;overflow-y:auto;";
        backdrop.innerHTML =
            '<div class="tlg-modal">' +
            '<div class="tlg-modal-title">⚓ 创建锚定点</div>' +
            '<div style="margin-bottom:12px">' +
            '<label class="tlg-label">节点名称</label>' +
            '<input class="tlg-input" id="tlg-anc-name" placeholder="例：决斗之前…" value="' + escHtml(prefillName || "") + '" />' +
            "</div><div>" +
            '<label class="tlg-label">简要描述</label>' +
            '<textarea class="tlg-textarea" id="tlg-anc-brief" placeholder="此时此刻的情况概述…"></textarea>' +
            '</div><div class="tlg-modal-actions">' +
            '<button type="button" class="tlg-btn" id="tlg-anc-cancel">取消</button>' +
            '<button type="button" class="tlg-btn tlg-btn-primary" id="tlg-anc-ok">⚓ 确认锚定</button>' +
            "</div></div>";
        document.body.appendChild(backdrop);

        var nameInput = backdrop.querySelector("#tlg-anc-name");
        backdrop.querySelector("#tlg-anc-cancel").onclick = function () { backdrop.remove(); };
        backdrop.querySelector("#tlg-anc-ok").onclick = function () {
            createAnchor(
                nameInput.value.trim() || ("节点 " + state.nodes.length),
                backdrop.querySelector("#tlg-anc-brief").value.trim()
            );
            backdrop.remove();
        };
        backdrop.addEventListener("click", function (e) {
            if (e.target === backdrop) backdrop.remove();
        });
        setTimeout(function () { nameInput.focus(); }, 80);
    }

    // ── 画布 ──
    function layoutTree() {
        var positions = {};
        var H_GAP = 180, V_GAP = 120;
        function subtreeWidth(nodeId) {
            var node = findNode(nodeId);
            if (!node || !node.children.length) return 1;
            return node.children.reduce(function (s, cid) { return s + subtreeWidth(cid); }, 0);
        }
        function assign(nodeId, depth, slotStart) {
            var node = findNode(nodeId);
            if (!node) return;
            var w = subtreeWidth(nodeId);
            positions[nodeId] = { x: (slotStart + w / 2) * H_GAP, y: depth * V_GAP + 60 };
            var childSlot = slotStart;
            for (var i = 0; i < node.children.length; i++) {
                var cid = node.children[i];
                var cw = subtreeWidth(cid);
                assign(cid, depth + 1, childSlot);
                childSlot += cw;
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
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = "#050508";
        ctx.fillRect(0, 0, rect.width, rect.height);
        ctx.save();
        ctx.translate(rect.width / 2 + camX, rect.height / 2 + camY);
        ctx.scale(camZoom, camZoom);

        var positions = layoutTree();
        var NODE_R = 22;
        var path = getPathToRoot(state.currentNodeId);
        var i, node, from, to, pos, isCurrent, isSelected, onPath, cy, label, grd;

        for (i = 0; i < state.nodes.length; i++) {
            node = state.nodes[i];
            if (!node.parentId) continue;
            from = positions[node.parentId];
            to = positions[node.id];
            if (!from || !to) continue;
            var isActive = path.indexOf(node.id) !== -1 && path.indexOf(node.parentId) !== -1;
            ctx.beginPath();
            ctx.moveTo(from.x, from.y + NODE_R);
            cy = (from.y + to.y) / 2;
            ctx.bezierCurveTo(from.x, cy, to.x, cy, to.x, to.y - NODE_R);
            ctx.strokeStyle = isActive ? "rgba(220,220,230,0.85)" : "rgba(192,192,210,0.18)";
            ctx.lineWidth = isActive ? 1.8 : 1;
            ctx.shadowBlur = isActive ? 8 : 0;
            ctx.shadowColor = "rgba(192,192,210,0.5)";
            ctx.stroke();
            ctx.shadowBlur = 0;
        }

        for (i = 0; i < state.nodes.length; i++) {
            node = state.nodes[i];
            pos = positions[node.id];
            if (!pos) continue;
            isCurrent = node.id === state.currentNodeId;
            isSelected = node.id === state.selectedNodeId;
            onPath = path.indexOf(node.id) !== -1;

            if (isCurrent) {
                ctx.beginPath();
                ctx.arc(pos.x, pos.y, NODE_R + 12, 0, Math.PI * 2);
                grd = ctx.createRadialGradient(pos.x, pos.y, NODE_R, pos.x, pos.y, NODE_R + 14);
                grd.addColorStop(0, "rgba(255,255,255,0.25)");
                grd.addColorStop(1, "rgba(255,255,255,0)");
                ctx.fillStyle = grd;
                ctx.fill();
            }

            ctx.beginPath();
            ctx.arc(pos.x, pos.y, NODE_R, 0, Math.PI * 2);
            if (isCurrent) {
                ctx.fillStyle = "rgba(255,255,255,0.15)";
                ctx.strokeStyle = "#fff";
                ctx.lineWidth = 2;
                ctx.shadowColor = "rgba(255,255,255,0.8)";
                ctx.shadowBlur = 18;
            } else if (isSelected) {
                ctx.fillStyle = "rgba(192,192,210,0.12)";
                ctx.strokeStyle = "#c0c0d0";
                ctx.lineWidth = 2;
                ctx.shadowBlur = 10;
            } else if (onPath) {
                ctx.fillStyle = "rgba(192,192,210,0.07)";
                ctx.strokeStyle = "rgba(192,192,210,0.55)";
                ctx.lineWidth = 1.2;
                ctx.shadowBlur = 0;
            } else {
                ctx.fillStyle = "rgba(192,192,210,0.04)";
                ctx.strokeStyle = "rgba(192,192,210,0.2)";
                ctx.lineWidth = 1;
                ctx.shadowBlur = 0;
            }
            ctx.fill();
            ctx.stroke();
            ctx.shadowBlur = 0;

            ctx.fillStyle = isCurrent ? "#fff" : onPath ? "rgba(220,220,230,0.85)" : "rgba(180,180,195,0.55)";
            ctx.font = isCurrent ? "bold 10px sans-serif" : "10px sans-serif";
            ctx.textAlign = "center";
            ctx.textBaseline = "top";
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
        var positions = layoutTree();
        var NODE_R = 22;
        var ids = Object.keys(positions);
        for (var i = 0; i < ids.length; i++) {
            var pos = positions[ids[i]];
            var dx = wx - pos.x, dy = wy - pos.y;
            if (dx * dx + dy * dy <= (NODE_R + 4) * (NODE_R + 4)) return ids[i];
        }
        return null;
    }

    // ── 简介 / 档案 / 总结 ──
    function openBriefPanel(nodeId) {
        var node = findNode(nodeId);
        if (!node) return;
        state.selectedNodeId = nodeId;
        var panel = document.getElementById("tlg-brief-panel");
        if (!panel) return;
        panel.classList.add("open");
        panel.querySelector(".tlg-brief-header span").textContent = node.name;
        var body = panel.querySelector(".tlg-brief-body");
        body.innerHTML =
            '<div style="margin-bottom:8px;font-size:11px;color:#6a6a78">' +
            new Date(node.timestamp).toLocaleString() + "</div>" +
            '<div style="margin-bottom:8px;font-size:11px;color:#6a6a78">' +
            "消息索引: " + node.msgIdx + " | " + (node.statData ? "MVU快照 ✓" : "无MVU快照") + "</div>" +
            '<div style="white-space:pre-wrap;word-break:break-word">' +
            (node.brief ? escHtml(node.brief) : "<em style='color:#6a6a78'>暂无描述。</em>") + "</div>" +
            '<div style="margin-top:12px"><label class="tlg-label">编辑描述</label>' +
            '<textarea class="tlg-textarea" id="tlg-brief-edit" style="min-height:100px">' + escHtml(node.brief || "") + "</textarea>" +
            '<button type="button" class="tlg-btn tlg-btn-primary" id="tlg-brief-save" style="margin-top:6px;width:100%!important">保存描述</button></div>';
        body.querySelector("#tlg-brief-save").onclick = function () {
            flashBtn(this);
            node.brief = body.querySelector("#tlg-brief-edit").value;
            saveToMetadata();
            toast("描述已保存。");
            refreshArchive();
        };
        panel.querySelector(".tlg-brief-footer").innerHTML =
            '<button type="button" class="tlg-btn tlg-btn-jump" id="tlg-brief-jump">↩ 确认跳转至此节点</button>';
        panel.querySelector("#tlg-brief-jump").onclick = function () { jumpToNode(nodeId); };
        renderCanvas();
    }

    function closeBriefPanel() {
        var panel = document.getElementById("tlg-brief-panel");
        if (panel) panel.classList.remove("open");
        state.selectedNodeId = null;
        renderCanvas();
    }

    function refreshArchive() {
        var container = document.getElementById("tlg-archive-list");
        if (!container) return;
        if (!state.nodes.length) {
            container.innerHTML = '<div style="color:#6a6a78;padding:20px">暂无节点。</div>';
            return;
        }
        var sorted = state.nodes.slice().sort(function (a, b) { return b.timestamp - a.timestamp; });
        container.innerHTML = sorted.map(function (node) {
            var isCurrent = node.id === state.currentNodeId;
            return (
                '<div class="tlg-archive-card ' + (isCurrent ? "current" : "") + '">' +
                '<div class="tlg-archive-title">' + escHtml(node.name) +
                (isCurrent ? " <span style='color:#6a6a78;font-size:11px'>(当前)</span>" : "") +
                "</div>" +
                '<div class="tlg-archive-meta">' + new Date(node.timestamp).toLocaleString() +
                " · 消息 " + node.msgIdx + "</div>" +
                '<div class="tlg-archive-brief">' + escHtml(node.brief || "") + "</div>" +
                '<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">' +
                '<button type="button" class="tlg-btn tlg-archive-view" data-nid="' + node.id + '">在树图中查看</button>' +
                '<button type="button" class="tlg-btn tlg-btn-primary tlg-archive-jump" data-nid="' + node.id + '">↩ 跳转至此</button>' +
                '<button type="button" class="tlg-btn tlg-btn-danger tlg-archive-del" data-nid="' + node.id + '" style="margin-left:auto">✕</button>' +
                "</div></div>"
            );
        }).join("");

        container.querySelectorAll(".tlg-archive-view").forEach(function (btn) {
            btn.onclick = function () { switchTab("tree"); openBriefPanel(btn.dataset.nid); };
        });
        container.querySelectorAll(".tlg-archive-jump").forEach(function (btn) {
            btn.onclick = function () { jumpToNode(btn.dataset.nid); };
        });
        container.querySelectorAll(".tlg-archive-del").forEach(function (btn) {
            btn.onclick = function () {
                var nid = btn.dataset.nid;
                if (nid === state.currentNodeId) { toast("无法删除当前所在节点。"); return; }
                var n = findNode(nid);
                if (!confirm("确定删除节点「" + (n ? n.name : "") + "」？")) return;
                deleteNode(nid);
            };
        });
    }

    function deleteNode(nodeId) {
        var node = findNode(nodeId);
        if (!node) return;
        var parent = findNode(node.parentId);
        if (parent) parent.children = parent.children.filter(function (id) { return id !== nodeId; });
        function removeRecursive(id) {
            var n = findNode(id);
            if (!n) return;
            n.children.slice().forEach(removeRecursive);
            state.nodes = state.nodes.filter(function (x) { return x.id !== id; });
        }
        removeRecursive(nodeId);
        saveToMetadata();
        renderCanvas();
        refreshArchive();
        toast("节点已删除。");
    }

    function refreshSummary() {
        var list = document.getElementById("tlg-summary-list");
        if (!list) return;
        if (!state.summaries || !state.summaries.length) {
            list.innerHTML = '<div style="color:#6a6a78">暂无总结记录。</div>';
            return;
        }
        list.innerHTML = state.summaries.slice().reverse().map(function (s, i) {
            var idx = state.summaries.length - 1 - i;
            return (
                '<div class="tlg-section">' +
                '<div style="font-size:11px;color:#6a6a78;margin-bottom:6px">' +
                new Date(s.timestamp).toLocaleString() + "</div>" +
                '<div style="font-size:13px;white-space:pre-wrap">' + escHtml(s.text) + "</div>" +
                '<button type="button" class="tlg-btn tlg-btn-danger" style="margin-top:8px;font-size:11px" data-idx="' + idx + '">删除</button></div>'
            );
        }).join("");
        list.querySelectorAll("[data-idx]").forEach(function (btn) {
            btn.onclick = function () {
                state.summaries.splice(Number(btn.dataset.idx), 1);
                saveToMetadata();
                refreshSummary();
            };
        });
    }

    // ── 诸世界标签 ──
    function refreshWorlds() {
        var container = document.getElementById("tlg-worlds-list");
        if (!container) return;

        var dir = getWorldsDir();
        var currentWorldId = getCurrentWorldId();
        var currentChatId = getCurrentChatId();
        var ids = Object.keys(dir).sort(function (a, b) {
            return (dir[b].updatedAt || 0) - (dir[a].updatedAt || 0);
        });

        // 当前聊天是否已关联
        var isLinked = !!currentWorldId;
        var statusHtml = "";
        if (!isLinked) {
            statusHtml = '<div class="tlg-worlds-status unlinked">' +
                '当前聊天尚未关联任何世界。' +
                '<div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">' +
                '<button type="button" class="tlg-btn tlg-btn-primary" id="tlg-worlds-create-new">+ 新建世界并关联</button>' +
                '</div></div>';
        } else {
            var w = dir[currentWorldId];
            statusHtml = '<div class="tlg-worlds-status linked">' +
                '当前关联：<strong>' + escHtml(w ? w.name : "未知") + '</strong>' +
                '</div>';
        }

        var listHtml = ids.length === 0
            ? '<div style="color:#6a6a78;padding:20px 0">暂无记录。在下方创建第一个世界。</div>'
            : ids.map(function (wid) {
                var w = dir[wid];
                var isCurrent = wid === currentWorldId;
                var data = getWorldData(wid);
                var nodeCount = data && data.nodes ? data.nodes.length : 0;
                var summaryCount = data && data.summaries ? data.summaries.length : 0;
                return (
                    '<div class="tlg-world-card' + (isCurrent ? " current" : "") + '" data-wid="' + wid + '">' +
                    '<div class="tlg-world-card-header">' +
                    '<div class="tlg-world-name">' + escHtml(w.name) + (isCurrent ? ' <span class="tlg-badge">当前</span>' : '') + '</div>' +
                    '<div class="tlg-world-meta">' +
                    nodeCount + ' 个节点 · ' + summaryCount + ' 条总结' +
                    ' · ' + new Date(w.updatedAt || w.createdAt).toLocaleDateString() +
                    '</div></div>' +
                    '<div class="tlg-world-card-actions">' +
                    (isCurrent ? '' : '<button type="button" class="tlg-btn tlg-btn-primary tlg-world-link" data-wid="' + wid + '">关联至此聊天</button> ') +
                    '<button type="button" class="tlg-btn tlg-world-rename" data-wid="' + wid + '">重命名</button>' +
                    '<button type="button" class="tlg-btn tlg-world-export" data-wid="' + wid + '">导出</button>' +
                    '<button type="button" class="tlg-btn tlg-btn-danger tlg-world-delete" data-wid="' + wid + '" style="margin-left:auto">删除</button>' +
                    '</div></div>'
                );
            }).join("");

        container.innerHTML =
            statusHtml +
            '<div class="tlg-section" style="margin-top:12px">' +
            '<div class="tlg-section-title">全部观测世界</div>' +
            listHtml +
            '</div>' +
            '<div class="tlg-section">' +
            '<div class="tlg-section-title">操作</div>' +
            '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
            '<button type="button" class="tlg-btn tlg-btn-primary" id="tlg-worlds-new">+ 新建空白世界</button>' +
            '<button type="button" class="tlg-btn" id="tlg-worlds-import">↑ 导入世界文件</button>' +
            '</div>' +
            '<input type="file" id="tlg-worlds-import-file" accept=".json" style="display:none" />' +
            '</div>';

        // 绑定事件
        var createNewBtn = document.getElementById("tlg-worlds-create-new");
        if (createNewBtn) createNewBtn.onclick = function () { showCreateWorldModal(true); };

        document.getElementById("tlg-worlds-new").onclick = function () { showCreateWorldModal(false); };

        document.getElementById("tlg-worlds-import").onclick = function () {
            document.getElementById("tlg-worlds-import-file").click();
        };
        document.getElementById("tlg-worlds-import-file").onchange = function (e) {
            var file = e.target.files && e.target.files[0];
            if (!file) return;
            var reader = new FileReader();
            reader.onload = function (ev) {
                try {
                    var obj = JSON.parse(ev.target.result);
                    importWorld(obj);
                } catch (err) {
                    toast("导入失败：文件格式不正确。");
                }
            };
            reader.readAsText(file);
            e.target.value = "";
        };

        container.querySelectorAll(".tlg-world-link").forEach(function (btn) {
            btn.onclick = function () { linkWorldToCurrentChat(btn.dataset.wid); };
        });
        container.querySelectorAll(".tlg-world-rename").forEach(function (btn) {
            btn.onclick = function () { showRenameWorldModal(btn.dataset.wid); };
        });
        container.querySelectorAll(".tlg-world-export").forEach(function (btn) {
            btn.onclick = function () { exportWorld(btn.dataset.wid); };
        });
        container.querySelectorAll(".tlg-world-delete").forEach(function (btn) {
            btn.onclick = function () {
                var wid = btn.dataset.wid;
                var w = dir[wid];
                if (!confirm("确定永久删除世界「" + (w ? w.name : "") + "」？此操作不可撤销。")) return;
                deleteWorld(wid);
            };
        });
    }

    function showCreateWorldModal(linkToCurrent) {
        var backdrop = document.createElement("div");
        backdrop.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100dvh;background:rgba(0,0,0,0.82);z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;";
        backdrop.innerHTML =
            '<div class="tlg-modal">' +
            '<div class="tlg-modal-title">' + (linkToCurrent ? "⊕ 新建世界并关联当前聊天" : "⊕ 新建空白世界") + '</div>' +
            '<div style="margin-bottom:12px">' +
            '<label class="tlg-label">世界名称</label>' +
            '<input class="tlg-input" id="tlg-world-new-name" placeholder="例：黄昏河岸·甲" />' +
            '</div>' +
            (linkToCurrent ? '<div style="font-size:12px;color:#6a6a78;margin-bottom:12px">建立后将自动关联到当前打开的聊天，并初始化因果树。</div>' : '') +
            '<div class="tlg-modal-actions">' +
            '<button type="button" class="tlg-btn" id="tlg-world-new-cancel">取消</button>' +
            '<button type="button" class="tlg-btn tlg-btn-primary" id="tlg-world-new-ok">建立</button>' +
            '</div></div>';
        document.body.appendChild(backdrop);

        var nameInput = backdrop.querySelector("#tlg-world-new-name");
        backdrop.querySelector("#tlg-world-new-cancel").onclick = function () { backdrop.remove(); };
        backdrop.querySelector("#tlg-world-new-ok").onclick = function () {
            var name = nameInput.value.trim() || "未命名世界";
            var chatId = linkToCurrent ? getCurrentChatId() : null;
            var worldId = createWorldEntry(name, chatId);
            resetState();
            saveWorldState(worldId);
            if (linkToCurrent) {
                setCurrentWorldId(worldId);
                loadWorldState(worldId);
            }
            backdrop.remove();
            refreshWorlds();
            toast("世界「" + name + "」已建立。");
        };
        backdrop.addEventListener("click", function (e) { if (e.target === backdrop) backdrop.remove(); });
        setTimeout(function () { nameInput.focus(); }, 80);
    }

    function showRenameWorldModal(worldId) {
        var dir = getWorldsDir();
        var w = dir[worldId];
        if (!w) return;
        var backdrop = document.createElement("div");
        backdrop.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100dvh;background:rgba(0,0,0,0.82);z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;";
        backdrop.innerHTML =
            '<div class="tlg-modal">' +
            '<div class="tlg-modal-title">✎ 重命名世界</div>' +
            '<label class="tlg-label">新名称</label>' +
            '<input class="tlg-input" id="tlg-rename-input" value="' + escHtml(w.name) + '" />' +
            '<div class="tlg-modal-actions">' +
            '<button type="button" class="tlg-btn" id="tlg-rename-cancel">取消</button>' +
            '<button type="button" class="tlg-btn tlg-btn-primary" id="tlg-rename-ok">确认</button>' +
            '</div></div>';
        document.body.appendChild(backdrop);
        var inp = backdrop.querySelector("#tlg-rename-input");
        backdrop.querySelector("#tlg-rename-cancel").onclick = function () { backdrop.remove(); };
        backdrop.querySelector("#tlg-rename-ok").onclick = function () {
            var newName = inp.value.trim();
            if (!newName) return;
            w.name = newName;
            saveExtSettings();
            backdrop.remove();
            refreshWorlds();
            toast("已重命名为「" + newName + "」");
        };
        backdrop.addEventListener("click", function (e) { if (e.target === backdrop) backdrop.remove(); });
        setTimeout(function () { inp.focus(); inp.select(); }, 80);
    }

    function linkWorldToCurrentChat(worldId) {
        var dir = getWorldsDir();
        var w = dir[worldId];
        if (!w) return;
        var chatId = getCurrentChatId();
        // 更新世界目录里的chatId
        w.chatId = chatId;
        saveExtSettings();
        // 把指针写入当前聊天的 chat_metadata
        setCurrentWorldId(worldId);
        // 把这个世界的数据加载进 state
        loadWorldState(worldId);
        refreshWorlds();
        renderCanvas();
        toast("已关联世界「" + w.name + "」至当前聊天。");
    }

    function exportWorld(worldId) {
        var dir = getWorldsDir();
        var w = dir[worldId];
        var data = getWorldData(worldId);
        var pkg = {
            _version: "3.0",
            _exported: new Date().toISOString(),
            meta: w ? JSON.parse(JSON.stringify(w)) : {},
            data: data ? JSON.parse(JSON.stringify(data)) : {}
        };
        var blob = new Blob([JSON.stringify(pkg, null, 2)], { type: "application/json" });
        var url = URL.createObjectURL(blob);
        var a = document.createElement("a");
        a.href = url;
        a.download = "world_" + (w ? w.name.replace(/[\\/:*?"<>|]/g, "_") : worldId) + "_" + Date.now() + ".json";
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { a.remove(); URL.revokeObjectURL(url); }, 1000);
        toast("已导出世界文件。");
    }

    function importWorld(obj) {
        if (!obj || !obj._version || !obj.data) {
            toast("导入失败：不是有效的河岸凝视世界文件。");
            return;
        }
        var meta = obj.meta || {};
        var baseName = meta.name || "导入世界";
        // 避免重名：加时间戳后缀
        var dir = getWorldsDir();
        var existingNames = Object.values(dir).map(function (w) { return w.name; });
        var name = baseName;
        var suffix = 2;
        while (existingNames.indexOf(name) !== -1) { name = baseName + " (" + suffix + ")"; suffix++; }

        var worldId = createWorldEntry(name, null); // 不自动关联chatId，让用户手动关联
        setWorldData(worldId, obj.data);
        saveExtSettings();
        refreshWorlds();
        toast("已导入世界「" + name + "」。如需关联当前聊天，点击「关联至此聊天」。");
    }

    function deleteWorld(worldId) {
        var es = getExtSettings();
        if (es.worlds) delete es.worlds[worldId];
        if (es.worldData) delete es.worldData[worldId];
        // 如果当前聊天正在用这个世界，清除关联
        if (getCurrentWorldId() === worldId) {
            var st = getST();
            if (st && st.chat_metadata) {
                delete st.chat_metadata.tlg_worldId;
                if (typeof st.saveMetadata === "function") st.saveMetadata();
            }
            resetState();
        }
        saveExtSettings();
        refreshWorlds();
        renderCanvas();
        toast("世界已删除。");
    }

    // ── API端点 ──
    function buildEndpoint(base, path) {
        var url = (base || "").trim().replace(/\/+$/, "");
        if (path === "/chat/completions" && /\/chat\/completions$/.test(url)) return url;
        if (path === "/models" && /\/models$/.test(url)) return url;
        if (!/\/v\d+/.test(url)) url += "/v1";
        return url + path;
    }

    // ── 总结 ──
    function runSummary() {
        var apiUrl = (state.settings.apiUrl || "").trim();
        var apiKey = (state.settings.apiKey || "").trim();
        var model = (state.settings.model || "").trim();
        if (!apiUrl) { toast("请先在引擎标签页设置 API 地址。"); return; }
        var st = getST();
        var recentChat = ((st && st.chat) || []).slice(-20).map(function (m) {
            return (m.name || m.role) + ": " + m.mes;
        }).join("\n");
        var prompt = (state.settings.summaryPrompt || "").replace("{{context}}", recentChat);
        var btn = document.getElementById("tlg-summary-run");
        if (btn) btn.disabled = true;
        toast("正在生成总结…");
        fetch(buildEndpoint(apiUrl, "/chat/completions"), {
            method: "POST",
            headers: Object.assign(
                { "Content-Type": "application/json" },
                apiKey ? { Authorization: "Bearer " + apiKey } : {}
            ),
            body: JSON.stringify({
                model: model || undefined,
                messages: [{ role: "user", content: prompt }],
                max_tokens: 512
            })
        }).then(function (res) {
            if (!res.ok) throw new Error("HTTP " + res.status);
            return res.json();
        }).then(function (data) {
            var text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
            if (!state.summaries) state.summaries = [];
            state.summaries.push({ timestamp: Date.now(), text: text });
            saveToMetadata();
            refreshSummary();
            toast("总结已生成。");
        }).catch(function (e) {
            toast("总结失败: " + e.message);
        }).then(function () {
            if (btn) btn.disabled = false;
        });
    }

    // ── 拉取模型 ──
    function fetchModelList() {
        var apiUrl = (state.settings.apiUrl || "").trim();
        var apiKey = (state.settings.apiKey || "").trim();
        if (!apiUrl) { toast("请先设置 API 地址。"); return; }
        var btn = document.getElementById("tlg-fetch-models");
        if (btn) btn.disabled = true;
        toast("正在拉取模型列表…");
        fetch(buildEndpoint(apiUrl, "/models"), {
            headers: apiKey ? { Authorization: "Bearer " + apiKey } : {}
        }).then(function (res) {
            if (!res.ok) throw new Error("HTTP " + res.status);
            return res.json();
        }).then(function (data) {
            var models = (data.data || data.models || []).map(function (m) {
                return typeof m === "string" ? m : (m.id || m.name || "");
            }).filter(Boolean);
            state.settings.modelList = models;
            saveGlobalApi();
            populateModelSelect();
            toast("已加载 " + models.length + " 个模型。");
        }).catch(function (e) {
            toast("拉取模型失败: " + e.message);
        }).then(function () {
            if (btn) btn.disabled = false;
        });
    }

    function fetchVectorModelList() {
        var apiUrl = (state.settings.vectorUrl || "").trim();
        var apiKey = (state.settings.vectorKey || "").trim();
        if (!apiUrl) { toast("请先设置向量 API 地址。"); return; }
        var btn = document.getElementById("tlg-fetch-vec-models");
        if (btn) btn.disabled = true;
        toast("正在拉取向量模型列表…");
        fetch(buildEndpoint(apiUrl, "/models"), {
            headers: apiKey ? { Authorization: "Bearer " + apiKey } : {}
        }).then(function (res) {
            if (!res.ok) throw new Error("HTTP " + res.status);
            return res.json();
        }).then(function (data) {
            var models = (data.data || data.models || []).map(function (m) {
                return typeof m === "string" ? m : (m.id || m.name || "");
            }).filter(Boolean);
            state.settings.vectorModelList = models;
            saveGlobalApi();
            populateVectorModelSelect();
            toast("已加载 " + models.length + " 个向量模型。");
        }).catch(function (e) {
            toast("拉取向量模型失败: " + e.message);
        }).then(function () {
            if (btn) btn.disabled = false;
        });
    }

    function populateModelSelect() {
        var sel = document.getElementById("tlg-model-select");
        if (!sel) return;
        var list = state.settings.modelList || [];
        sel.innerHTML = '<option value="">-- 选择模型 --</option>' +
            list.map(function (m) {
                return '<option value="' + escHtml(m) + '"' +
                    (m === state.settings.model ? " selected" : "") + ">" + escHtml(m) + "</option>";
            }).join("");
    }

    function populateVectorModelSelect() {
        var sel = document.getElementById("tlg-vec-model-select");
        if (!sel) return;
        var list = state.settings.vectorModelList || [];
        sel.innerHTML = '<option value="">-- 选择模型 --</option>' +
            list.map(function (m) {
                return '<option value="' + escHtml(m) + '"' +
                    (m === state.settings.vectorModel ? " selected" : "") + ">" + escHtml(m) + "</option>";
            }).join("");
    }

    // ── CSS ──
    function injectCSS() {
        if (document.getElementById("tlg-css")) return;
        var style = document.createElement("style");
        style.id = "tlg-css";
        style.textContent = [
            "#tlg-panel *{box-sizing:border-box;margin:0;padding:0}",
            "#tlg-tabs{display:flex;align-items:center;border-bottom:1px solid #1e1e2a;background:#08080e;padding:0 8px;flex-shrink:0;overflow-x:auto;-webkit-overflow-scrolling:touch}",
            ".tlg-tab{padding:12px 14px;font-size:13px;color:#6a6a78;cursor:pointer;white-space:nowrap;border-bottom:2px solid transparent;transition:color .15s,border-color .15s}",
            ".tlg-tab.active{color:#e8e8f0;border-bottom-color:#c0c0d0}",
            ".tlg-tab:hover{color:#c0c0d0}",
            "#tlg-close{margin-left:auto;padding:10px 14px;cursor:pointer;color:#6a6a78;font-size:16px;flex-shrink:0}",
            "#tlg-close:hover{color:#e8e8f0}",
            "#tlg-body{flex:1;overflow:hidden;position:relative}",
            ".tlg-view{display:none;flex-direction:column;height:100%;width:100%;position:absolute;top:0;left:0}",
            ".tlg-view.active{display:flex}",
            ".tlg-scroll-panel{flex:1;overflow-y:auto;padding:16px;-webkit-overflow-scrolling:touch}",
            // canvas view
            "#tlg-view-tree{flex-direction:row}",
            "#tlg-canvas-wrap{flex:1;position:relative;overflow:hidden;background:#050508}",
            "#tlg-tree-canvas{width:100%;height:100%;display:block}",
            "#tlg-canvas-toolbar{position:absolute;bottom:12px;left:12px;display:flex;gap:8px;flex-wrap:wrap}",
            "#tlg-brief-panel{width:260px;flex-shrink:0;background:#080810;border-left:1px solid #1e1e2a;display:flex;flex-direction:column;transform:translateX(100%);transition:transform .25s;position:absolute;right:0;top:0;height:100%;z-index:2}",
            "#tlg-brief-panel.open{transform:translateX(0)}",
            ".tlg-brief-header{display:flex;align-items:center;justify-content:space-between;padding:12px;border-bottom:1px solid #1e1e2a;font-weight:600;font-size:14px;color:#e8e8f0;flex-shrink:0}",
            ".tlg-brief-body{flex:1;overflow-y:auto;padding:12px;font-size:13px;color:#c0c0c8}",
            ".tlg-brief-footer{padding:12px;border-top:1px solid #1e1e2a;flex-shrink:0}",
            // common controls
            ".tlg-label{display:block;font-size:12px;color:#6a6a78;margin-bottom:4px;margin-top:10px}",
            ".tlg-input{width:100%;background:#0e0e18;border:1px solid #2a2a3a;border-radius:6px;color:#e8e8f0;padding:8px 10px;font-size:14px;outline:none}",
            ".tlg-input:focus{border-color:#5a5a7a}",
            ".tlg-textarea{width:100%;background:#0e0e18;border:1px solid #2a2a3a;border-radius:6px;color:#e8e8f0;padding:8px 10px;font-size:13px;min-height:80px;resize:vertical;outline:none;font-family:inherit}",
            ".tlg-textarea:focus{border-color:#5a5a7a}",
            ".tlg-select{background:#0e0e18;border:1px solid #2a2a3a;border-radius:6px;color:#e8e8f0;padding:8px 10px;font-size:13px;outline:none}",
            ".tlg-btn{background:#1a1a28;border:1px solid #2a2a3a;border-radius:6px;color:#c0c0d0;padding:7px 14px;font-size:13px;cursor:pointer;transition:background .15s,color .15s;white-space:nowrap}",
            ".tlg-btn:hover{background:#252535;color:#e8e8f0}",
            ".tlg-btn:disabled{opacity:.4;cursor:default}",
            ".tlg-btn-primary{background:#1e2a3a;border-color:#3a5a7a;color:#90c0e0}",
            ".tlg-btn-primary:hover{background:#243244}",
            ".tlg-btn-danger{background:#2a1a1a;border-color:#5a2a2a;color:#e07070}",
            ".tlg-btn-danger:hover{background:#3a1a1a}",
            ".tlg-btn-jump{width:100%;background:#1a2a1a;border-color:#3a6a3a;color:#80c080}",
            ".tlg-btn-jump:hover{background:#1e331e}",
            ".tlg-row{display:flex;gap:8px;align-items:center;margin-top:8px}",
            ".tlg-toggle{width:40px;height:22px;background:#1a1a28;border:1px solid #2a2a3a;border-radius:11px;cursor:pointer;position:relative;transition:background .2s,border-color .2s;flex-shrink:0}",
            ".tlg-toggle::after{content:'';position:absolute;top:3px;left:3px;width:14px;height:14px;border-radius:50%;background:#6a6a78;transition:left .2s,background .2s}",
            ".tlg-toggle.on{background:#1e2a3a;border-color:#3a5a7a}",
            ".tlg-toggle.on::after{left:21px;background:#90c0e0}",
            ".tlg-section{background:#0a0a14;border:1px solid #1e1e2a;border-radius:8px;padding:14px;margin-bottom:12px}",
            ".tlg-section-title{font-size:12px;color:#6a6a78;text-transform:uppercase;letter-spacing:.08em;margin-bottom:10px;font-weight:600}",
            // archive
            ".tlg-archive-card{background:#0a0a14;border:1px solid #1e1e2a;border-radius:8px;padding:12px;margin-bottom:10px}",
            ".tlg-archive-card.current{border-color:#3a5a7a}",
            ".tlg-archive-title{font-size:14px;font-weight:600;color:#e8e8f0;margin-bottom:4px}",
            ".tlg-archive-meta{font-size:11px;color:#6a6a78;margin-bottom:6px}",
            ".tlg-archive-brief{font-size:12px;color:#9a9aaa;white-space:pre-wrap;word-break:break-word}",
            // worlds
            ".tlg-worlds-status{padding:12px;border-radius:8px;margin-bottom:12px;font-size:13px}",
            ".tlg-worlds-status.linked{background:#0a1a0a;border:1px solid #2a4a2a;color:#80c080}",
            ".tlg-worlds-status.unlinked{background:#1a1a0a;border:1px solid #4a4a2a;color:#c0c080}",
            ".tlg-world-card{background:#0a0a14;border:1px solid #1e1e2a;border-radius:8px;padding:12px;margin-bottom:10px}",
            ".tlg-world-card.current{border-color:#3a5a7a}",
            ".tlg-world-card-header{margin-bottom:10px}",
            ".tlg-world-name{font-size:14px;font-weight:600;color:#e8e8f0;margin-bottom:3px}",
            ".tlg-world-meta{font-size:11px;color:#6a6a78}",
            ".tlg-world-card-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}",
            ".tlg-badge{font-size:10px;background:#1e2a3a;border:1px solid #3a5a7a;color:#90c0e0;padding:1px 6px;border-radius:4px;font-weight:400;vertical-align:middle;margin-left:4px}",
            // modal
            ".tlg-modal{background:#0e0e18;border:1px solid #2a2a3a;border-radius:12px;padding:20px;width:100%;max-width:420px;box-shadow:0 8px 40px rgba(0,0,0,0.8)}",
            ".tlg-modal-title{font-size:16px;font-weight:600;color:#e8e8f0;margin-bottom:16px}",
            ".tlg-modal-actions{display:flex;gap:10px;justify-content:flex-end;margin-top:16px}",
        ].join("\n");
        document.head.appendChild(style);
    }

    // ── 打开面板 ──
    function ensurePanelBuilt() {
        if (document.getElementById("tlg-panel")) return;

        var s = state.settings || {};
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
            '<div id="tlg-canvas-toolbar">' +
            '<button type="button" class="tlg-btn" id="tlg-canvas-anchor">⚓ 在此锚定</button>' +
            '<button type="button" class="tlg-btn" id="tlg-canvas-reset-view">重置视图</button></div></div>' +
            '<div id="tlg-brief-panel">' +
            '<div class="tlg-brief-header"><span>节点</span>' +
            '<button type="button" class="tlg-btn" id="tlg-brief-close" style="padding:2px 8px">✕</button></div>' +
            '<div class="tlg-brief-body"></div><div class="tlg-brief-footer"></div></div></div>' +
            // archive
            '<div class="tlg-view" data-view="archive">' +
            '<div class="tlg-scroll-panel">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;gap:8px;flex-wrap:wrap">' +
            '<div style="font-size:15px;font-weight:600;color:#e8e8f0">全部节点</div>' +
            '<button type="button" class="tlg-btn tlg-btn-primary" id="tlg-archive-new">⚓ 新建锚定</button></div>' +
            '<div id="tlg-archive-list"></div></div></div>' +
            // summary
            '<div class="tlg-view" data-view="summary">' +
            '<div class="tlg-scroll-panel">' +
            '<div class="tlg-section"><div class="tlg-section-title">自动总结模式</div>' +
            '<div class="tlg-row"><span class="tlg-label" style="margin:0">自动模式</span>' +
            '<div class="tlg-toggle ' + (s.autoMode ? "on" : "") + '" id="tlg-auto-toggle"></div></div>' +
            '<div class="tlg-row"><label class="tlg-label" style="margin:0;flex:1">每 ' +
            '<input class="tlg-input" id="tlg-auto-interval" type="number" min="1" value="' + (s.autoInterval || 10) +
            '" style="width:70px;display:inline-block;padding:4px 8px;margin:0 6px;font-size:14px"> 轮提醒</label></div>' +
            '<div class="tlg-row"><label class="tlg-label" style="margin:0;flex:1">跳转后显示最后 ' +
            '<input class="tlg-input" id="tlg-last-n" type="number" min="1" value="' + (s.lastNMessages || 5) +
            '" style="width:70px;display:inline-block;padding:4px 8px;margin:0 6px;font-size:14px"> 条消息</label></div></div>' +
            '<div class="tlg-section"><div class="tlg-section-title">总结提示词</div>' +
            '<label class="tlg-label">提示词模板（{{context}}）</label>' +
            '<textarea class="tlg-textarea" id="tlg-summary-prompt" style="min-height:120px">' + escHtml(s.summaryPrompt || "") + "</textarea>" +
            '<button type="button" class="tlg-btn tlg-btn-primary" id="tlg-summary-run" style="margin-top:10px">▶ 立即生成总结</button></div>' +
            '<div class="tlg-section"><div class="tlg-section-title">总结历史</div><div id="tlg-summary-list"></div></div></div></div>' +
            // worlds
            '<div class="tlg-view" data-view="worlds">' +
            '<div class="tlg-scroll-panel" id="tlg-worlds-list"></div></div>' +
            // engine
            '<div class="tlg-view" data-view="engine">' +
            '<div class="tlg-scroll-panel">' +
            '<div class="tlg-section"><div class="tlg-section-title">API 配置（全局，所有世界共用）</div>' +
            '<label class="tlg-label">API 基础地址</label><div class="tlg-row">' +
            '<input class="tlg-input" id="tlg-api-url" placeholder="https://api.openai.com" value="' + escHtml(s.apiUrl || "") + '" />' +
            '<button type="button" class="tlg-btn" id="tlg-test-api">测试</button></div>' +
            '<label class="tlg-label">API 密钥</label>' +
            '<input class="tlg-input" id="tlg-api-key" type="password" value="' + escHtml(s.apiKey || "") + '" style="margin-bottom:12px" />' +
            '<label class="tlg-label">模型</label><div class="tlg-row">' +
            '<select class="tlg-select" id="tlg-model-select" style="flex:1"></select>' +
            '<button type="button" class="tlg-btn" id="tlg-fetch-models">拉取列表</button></div>' +
            '<label class="tlg-label">或手动输入模型名称</label>' +
            '<input class="tlg-input" id="tlg-model-manual" value="' + escHtml(s.model || "") + '" /></div>' +
            '<div class="tlg-section"><div class="tlg-section-title">向量 API（可选）</div>' +
            '<label class="tlg-label">向量 API 地址</label><div class="tlg-row">' +
            '<input class="tlg-input" id="tlg-vec-url" value="' + escHtml(s.vectorUrl || "") + '" />' +
            '<button type="button" class="tlg-btn" id="tlg-test-vec-api">测试</button></div>' +
            '<label class="tlg-label">向量 API 密钥</label>' +
            '<input class="tlg-input" id="tlg-vec-key" type="password" value="' + escHtml(s.vectorKey || "") + '" style="margin-bottom:12px" />' +
            '<label class="tlg-label">向量模型</label><div class="tlg-row">' +
            '<select class="tlg-select" id="tlg-vec-model-select" style="flex:1"></select>' +
            '<button type="button" class="tlg-btn" id="tlg-fetch-vec-models">拉取列表</button></div>' +
            '<label class="tlg-label">或手动输入模型名称</label>' +
            '<input class="tlg-input" id="tlg-vec-model" value="' + escHtml(s.vectorModel || "") + '" style="margin-bottom:8px" />' +
            '<label class="tlg-label">检索提示词模板</label>' +
            '<textarea class="tlg-textarea" id="tlg-vec-prompt">' + escHtml(s.vectorPrompt || "") + "</textarea></div>" +
            '<button type="button" class="tlg-btn tlg-btn-primary" id="tlg-engine-save" style="width:100%!important">保存引擎设置</button>' +
            "</div></div></div>";

        document.body.appendChild(panel);
        bindPanelEvents(panel);
    }

    function openPanel() {
        if (!isEnabled()) {
            toast("河岸凝视已关闭，请到「扩展」设置中开启。");
            return;
        }

        var existingPanel = document.getElementById("tlg-panel");
        if (existingPanel) existingPanel.remove();

        migrateFromOldFormat();
        loadFromMetadata();
        injectCSS();
        ensurePanelBuilt();

        var panel = document.getElementById("tlg-panel");
        if (!panel) return;
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
        var panel = document.getElementById("tlg-panel");
        if (!panel) return;
        panel.querySelectorAll(".tlg-tab").forEach(function (t) {
            t.classList.toggle("active", t.getAttribute("data-tab") === name);
        });
        panel.querySelectorAll(".tlg-view").forEach(function (v) {
            var on = v.getAttribute("data-view") === name;
            v.classList.toggle("active", on);
            v.style.display = on ? "flex" : "none";
        });
        if (name === "tree") setTimeout(function () { renderCanvas(); }, 50);
        else if (name === "archive") refreshArchive();
        else if (name === "summary") refreshSummary();
        else if (name === "worlds") refreshWorlds();
        else if (name === "engine") { populateModelSelect(); populateVectorModelSelect(); }
    }

    function bindPanelEvents(panel) {
        document.getElementById("tlg-close").onclick = function () { closePanel(); };

        panel.querySelectorAll(".tlg-tab").forEach(function (tab) {
            tab.onclick = function () { switchTab(tab.getAttribute("data-tab")); };
        });

        document.getElementById("tlg-brief-close").onclick = function () { closeBriefPanel(); };
        document.getElementById("tlg-canvas-anchor").onclick = function () { showAnchorModal(); };
        document.getElementById("tlg-canvas-reset-view").onclick = function () {
            camX = 0; camY = 0; camZoom = 1; renderCanvas();
        };
        document.getElementById("tlg-archive-new").onclick = function () { showAnchorModal(); };

        document.getElementById("tlg-auto-toggle").addEventListener("click", function () {
            state.settings.autoMode = !state.settings.autoMode;
            this.classList.toggle("on", state.settings.autoMode);
            saveGlobalApi();
        });
        document.getElementById("tlg-auto-interval").addEventListener("change", function () {
            state.settings.autoInterval = Math.max(1, parseInt(this.value, 10) || 10);
            saveGlobalApi();
        });
        document.getElementById("tlg-last-n").addEventListener("change", function () {
            state.settings.lastNMessages = Math.max(1, parseInt(this.value, 10) || 5);
            saveGlobalApi();
        });
        document.getElementById("tlg-summary-prompt").addEventListener("change", function () {
            state.settings.summaryPrompt = this.value;
            saveGlobalApi();
        });
        document.getElementById("tlg-summary-run").addEventListener("click", function () {
            flashBtn(this);
            runSummary();
        });

        document.getElementById("tlg-engine-save").addEventListener("click", function () {
            flashBtn(this);
            state.settings.apiUrl = document.getElementById("tlg-api-url").value.trim();
            state.settings.apiKey = document.getElementById("tlg-api-key").value.trim();
            state.settings.vectorUrl = document.getElementById("tlg-vec-url").value.trim();
            state.settings.vectorKey = document.getElementById("tlg-vec-key").value.trim();
            var vecManual = document.getElementById("tlg-vec-model").value.trim();
            var vecSel = document.getElementById("tlg-vec-model-select").value;
            state.settings.vectorModel = vecManual || vecSel;
            state.settings.vectorPrompt = document.getElementById("tlg-vec-prompt").value;
            var manual = document.getElementById("tlg-model-manual").value.trim();
            var sel = document.getElementById("tlg-model-select").value;
            state.settings.model = manual || sel;
            saveGlobalApi();
            toast("引擎设置已保存（全局生效）。");
        });

        document.getElementById("tlg-fetch-models").addEventListener("click", function () {
            flashBtn(this);
            state.settings.apiUrl = document.getElementById("tlg-api-url").value.trim();
            state.settings.apiKey = document.getElementById("tlg-api-key").value.trim();
            saveGlobalApi();
            fetchModelList();
        });
        document.getElementById("tlg-model-select").addEventListener("change", function () {
            if (this.value) document.getElementById("tlg-model-manual").value = this.value;
        });

        document.getElementById("tlg-fetch-vec-models").addEventListener("click", function () {
            flashBtn(this);
            state.settings.vectorUrl = document.getElementById("tlg-vec-url").value.trim();
            state.settings.vectorKey = document.getElementById("tlg-vec-key").value.trim();
            saveGlobalApi();
            fetchVectorModelList();
        });
        document.getElementById("tlg-vec-model-select").addEventListener("change", function () {
            if (this.value) document.getElementById("tlg-vec-model").value = this.value;
        });

        document.getElementById("tlg-test-vec-api").addEventListener("click", function () {
            var url = document.getElementById("tlg-vec-url").value.trim();
            var key = document.getElementById("tlg-vec-key").value.trim();
            if (!url) { toast("请先输入向量 API 地址。"); return; }
            flashBtn(this);
            toast("正在测试…");
            fetch(buildEndpoint(url, "/models"), {
                headers: key ? { Authorization: "Bearer " + key } : {}
            }).then(function (res) {
                toast(res.ok ? "✓ 向量 API 可达。" : ("✗ HTTP " + res.status));
            }).catch(function (e) { toast("✗ " + e.message); });
        });

        document.getElementById("tlg-test-api").addEventListener("click", function () {
            var url = document.getElementById("tlg-api-url").value.trim();
            var key = document.getElementById("tlg-api-key").value.trim();
            if (!url) { toast("请先输入地址。"); return; }
            flashBtn(this);
            toast("正在测试…");
            fetch(buildEndpoint(url, "/models"), {
                headers: key ? { Authorization: "Bearer " + key } : {}
            }).then(function (res) {
                toast(res.ok ? "✓ API 可达。" : ("✗ HTTP " + res.status));
            }).catch(function (e) { toast("✗ " + e.message); });
        });

        initCanvasEvents();
    }

    function initCanvasEvents() {
        var wrap = document.getElementById("tlg-canvas-wrap");
        if (!wrap) return;
        canvas = document.getElementById("tlg-tree-canvas");
        ctx = canvas.getContext("2d");
        if (typeof ResizeObserver !== "undefined") {
            new ResizeObserver(function () { renderCanvas(); }).observe(wrap);
        }

        canvas.addEventListener("mousedown", function (e) {
            if (e.button !== 0) return;
            var hit = canvasHitTest(e.clientX, e.clientY);
            if (hit) { openBriefPanel(hit); return; }
            isPanning = true;
            panStartX = e.clientX - camX;
            panStartY = e.clientY - camY;
        });
        canvas.addEventListener("mousemove", function (e) {
            if (!isPanning) return;
            camX = e.clientX - panStartX;
            camY = e.clientY - panStartY;
            renderCanvas();
        });
        function endPan() { isPanning = false; }
        canvas.addEventListener("mouseup", endPan);
        canvas.addEventListener("mouseleave", endPan);
        canvas.addEventListener("wheel", function (e) {
            e.preventDefault();
            camZoom = Math.max(0.2, Math.min(4, camZoom * (e.deltaY < 0 ? 1.1 : 0.91)));
            renderCanvas();
        }, { passive: false });

        var lastTouchDist = 0, touchStartHit = null, touchMoved = false;
        canvas.addEventListener("touchstart", function (e) {
            touchMoved = false;
            if (e.touches.length === 1) {
                isPanning = true;
                panStartX = e.touches[0].clientX - camX;
                panStartY = e.touches[0].clientY - camY;
                touchStartHit = canvasHitTest(e.touches[0].clientX, e.touches[0].clientY);
            } else if (e.touches.length === 2) {
                isPanning = false;
                lastTouchDist = Math.hypot(
                    e.touches[0].clientX - e.touches[1].clientX,
                    e.touches[0].clientY - e.touches[1].clientY
                );
            }
        }, { passive: true });
        canvas.addEventListener("touchmove", function (e) {
            touchMoved = true;
            if (e.touches.length === 1 && isPanning) {
                camX = e.touches[0].clientX - panStartX;
                camY = e.touches[0].clientY - panStartY;
                renderCanvas();
            } else if (e.touches.length === 2) {
                var dist = Math.hypot(
                    e.touches[0].clientX - e.touches[1].clientX,
                    e.touches[0].clientY - e.touches[1].clientY
                );
                if (lastTouchDist > 0) {
                    camZoom = Math.max(0.2, Math.min(4, camZoom * (dist / lastTouchDist)));
                    renderCanvas();
                }
                lastTouchDist = dist;
            }
        }, { passive: true });
        canvas.addEventListener("touchend", function () {
            if (!touchMoved && touchStartHit) openBriefPanel(touchStartHit);
            isPanning = false;
            touchStartHit = null;
        }, { passive: true });
    }

    // ── 入口 ──
    function injectMenuButton() {
        var menu = document.getElementById("extensionsMenu");
        if (!menu) return;
        if (document.getElementById("tlg-menu-btn")) return;
        if (!isEnabled()) return;

        var btn = document.createElement("div");
        btn.id = "tlg-menu-btn";
        btn.className = "list-group-item flex-container flexGap5 interactable";
        btn.style.cursor = "pointer";
        btn.innerHTML = '<i class="fa-solid fa-water"></i><span>河岸凝视</span>';
        btn.addEventListener("click", function (e) {
            e.preventDefault();
            e.stopPropagation();
            var p = document.getElementById("tlg-panel");
            if (p && p.style.display === "flex") closePanel();
            else openPanel();
        });
        menu.appendChild(btn);
    }

    function injectSettingsPanel() {
        if (document.getElementById("tlg_settings_block")) return;
        var host =
            document.querySelector("#extensions_settings2") ||
            document.querySelector("#extensions_settings") ||
            document.querySelector("#extensions_settings1");
        if (!host) return;

        var enabled = isEnabled();
        var block = document.createElement("div");
        block.id = "tlg_settings_block";
        block.className = "extension_container";
        block.innerHTML =
            '<div class="inline-drawer">' +
            '<div class="inline-drawer-toggle inline-drawer-header">' +
            "<b>🌊 河岸凝视</b>" +
            '<div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>' +
            '<div class="inline-drawer-content">' +
            '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin:8px 0;">' +
            "<span>启用插件</span>" +
            '<div class="tlg-toggle ' + (enabled ? "on" : "") + '" id="tlg_enable_toggle"></div></div>' +
            '<div style="font-size:12px;opacity:.75;margin-bottom:10px;">关闭后隐藏菜单入口并停止全屏面板。</div>' +
            '<button type="button" class="tlg-btn tlg-btn-primary" id="tlg_settings_open">打开河岸凝视面板</button>' +
            '<div style="font-size:11px;opacity:.55;margin-top:10px;">斜杠命令：/tlg_anchor</div>' +
            "</div></div>";
        host.appendChild(block);
        injectCSS();

        document.getElementById("tlg_enable_toggle").onclick = function () {
            var next = !this.classList.contains("on");
            this.classList.toggle("on", next);
            setEnabled(next);
            toast(next ? "河岸凝视已启用" : "河岸凝视已关闭");
        };
        document.getElementById("tlg_settings_open").onclick = function () { openPanel(); };
    }

    function registerSlashCommand() {
        function wrap(value) {
            if (!isEnabled()) { toast("河岸凝视已关闭。"); return ""; }
            loadFromMetadata();
            showAnchorModal(String(value || ""));
            return "";
        }
        var st = getST();
        if (st && st.registerSlashCommand) {
            st.registerSlashCommand("tlg_anchor", function (a, v) { return wrap(v); }, [], "创建河岸凝视锚定点", true, true);
        }
        if (window.SillyTavern && window.SillyTavern.SlashCommandParser) {
            try {
                window.SillyTavern.SlashCommandParser.addCommandObject(
                    window.SillyTavern.SlashCommand.fromProps({
                        name: "tlg_anchor",
                        callback: function (a, v) { return wrap(v); },
                        helpString: "创建河岸凝视因果锚定点。"
                    })
                );
            } catch (e) {}
        }
    }

    function boot() {
        injectCSS();
        injectMenuButton();
        injectSettingsPanel();
        new MutationObserver(function () {
            injectMenuButton();
            injectSettingsPanel();
        }).observe(document.body, { childList: true, subtree: true });
        setInterval(injectMenuButton, 2000);
        registerSlashCommand();

        try {
            var ctx0 = getST();
            if (ctx0 && ctx0.eventSource && ctx0.eventTypes) {
                ctx0.eventSource.on(ctx0.eventTypes.CHAT_CHANGED, function () {
                    var p = document.getElementById("tlg-panel");
                    if (p) p.remove();
                    canvas = null; ctx = null;
                    document.body.style.overflow = "";
                });
            }
        } catch (e) {}

        console.log("[TLG] 河岸凝视 v3.0 已加载");
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", boot);
    } else {
        setTimeout(boot, 300);
    }
})();
