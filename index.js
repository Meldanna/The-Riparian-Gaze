/**
 * 河岸凝视 v2.3
 * 修复：按钮反馈 / API兼容 / async移除 / 弹窗居中 / 数据持久化
 */
(function () {
    "use strict";

    var EXT_NAME = "RiparianGaze";
    var METADATA_KEY = "tlg_data";

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
            vectorPrompt: "以下为因果档案库中与当前观测焦点相关的历史切片：\n\n{{context}}\n\n处理规则：\n- 这些是已铭刻的因果事实，不可篡改\n- 当前叙事必须与这些记录在逻辑上连续\n- 若当前事件是某条历史线的后果，自然呈现因果关系\n- 不要直接引用或复述这些档案内容",
            summaryPrompt: "你是因果记录仪。对以下对话执行状态切片，提取并压缩为因果档案。\n\n【因果事件链】本段发生的事件，按因果顺序（A导致B导致C），每条一句\n【样本状态变动】主角的生理、心理、物品、关系的变化\n【NPC状态变动】在场NPC的行为、立场、情绪变化\n【悬置因果线】未完成的选择、未触发的后果、埋下的伏笔\n【环境快照】地点·天气·时间·在场实体\n\n对话内容：\n{{context}}\n\n要求：纯事实记录，无评论，无修辞。每条尽量压缩至15字以内。"
        },
        summaries: [],
        turnsSinceAnchor: 0,
        _lastChatLen: 0
    };

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

    // ── Toast（内联样式，不依赖CSS）──
    function toast(msg, duration) {
        duration = duration || 2800;
        var el = document.createElement("div");
        el.textContent = msg;
        el.style.cssText = "position:fixed;left:50%;bottom:30px;transform:translateX(-50%);max-width:80vw;padding:12px 18px;background:#0a0a10;border:1px solid #2a2a3a;border-radius:8px;color:#c0c0c8;font-size:13px;z-index:2147483647;text-align:center;pointer-events:none;opacity:1;transition:opacity 0.4s;";
        document.body.appendChild(el);
        setTimeout(function () {
            el.style.opacity = "0";
            setTimeout(function () { el.remove(); }, 400);
        }, duration);
    }

    // ── 按钮点击光效 ──
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

    // ── 开关 ──
    function getExtSettings() {
        var st = getST();
        var es = (st && st.extensionSettings) || window.extension_settings || {};
        if (!es[EXT_NAME]) es[EXT_NAME] = { enabled: true };
        if (typeof es[EXT_NAME].enabled !== "boolean") es[EXT_NAME].enabled = true;
        return es[EXT_NAME];
    }
    function isEnabled() {
        try { return getExtSettings().enabled !== false; } catch (e) { return true; }
    }
    function setEnabled(on) {
        try {
            var st = getST();
            getExtSettings().enabled = !!on;
            if (st && typeof st.saveSettingsDebounced === "function") st.saveSettingsDebounced();
            else if (typeof window.saveSettingsDebounced === "function") window.saveSettingsDebounced();
            if (!on) closePanel();
            injectMenuButton();
            var toggle = document.getElementById("tlg_enable_toggle");
            if (toggle) toggle.classList.toggle("on", !!on);
        } catch (e) { console.warn("[TLG] setEnabled", e); }
    }

    // ── 元数据 ──
    function saveToMetadata() {
        var st = getST();
        if (!st) return;
        if (!st.chat_metadata) st.chat_metadata = {};
        st.chat_metadata[METADATA_KEY] = JSON.parse(JSON.stringify(state));
        if (typeof st.saveMetadata === "function") st.saveMetadata();
        else if (typeof window.saveMetadataDebounced === "function") window.saveMetadataDebounced();
        // ★ 备份到 localStorage
        try {
            var chatId = st.chatId || (st.getCurrentChatId && st.getCurrentChatId()) || "unknown";
            localStorage.setItem("tlg_backup_" + chatId, JSON.stringify(state));
        } catch (e) { console.warn("[TLG] localStorage backup failed:", e); }
    }

    function loadFromMetadata() {
        var st = getST();
        if (!st) return;
        var saved = st.chat_metadata && st.chat_metadata[METADATA_KEY];
        if (saved) {
            state = JSON.parse(JSON.stringify(saved));
            if (!state.settings) state.settings = {};
            if (state._lastChatLen == null) state._lastChatLen = 0;
        } else {
            // ★ 尝试从 localStorage 恢复
            try {
                var chatId = st.chatId || (st.getCurrentChatId && st.getCurrentChatId()) || "";
                var backup = chatId && localStorage.getItem("tlg_backup_" + chatId);
                if (backup) {
                    state = JSON.parse(backup);
                    toast("已从本地备份恢复时间线数据。");
                    saveToMetadata();
                    return;
                }
            } catch (e) {}
            resetState();
            saveToMetadata();
        }
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

    // ── MVU ──
    function getMVUStatData() {
        try {
            var st = getST();
            if (st && st.chat_metadata && st.chat_metadata.stat_data != null)
                return JSON.parse(JSON.stringify(st.chat_metadata.stat_data));
            if (typeof window.getAllVariables === "function") {
                var all = window.getAllVariables();
                if (all && all.stat_data != null) return JSON.parse(JSON.stringify(all.stat_data));
            }
        } catch (e) { console.warn("[TLG] getMVUStatData", e); }
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
        } catch (e) { console.warn("[TLG] setMVUStatData", e); }
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

    // ── 锚定 / 跳转 ──
    function createAnchor(name, brief) {
        var st = getST();
        if (!st) return;
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
        backdrop.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.82);z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;overflow-y:auto;-webkit-overflow-scrolling:touch;";
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

        // ★ 动态检查：弹窗比屏幕高时改为顶对齐
        setTimeout(function () {
            var modal = backdrop.querySelector(".tlg-modal");
            if (!modal) return;
            var vh = window.innerHeight || document.documentElement.clientHeight;
            var mh = modal.offsetHeight || 300;
            if (mh >= vh - 32) {
                backdrop.style.alignItems = "flex-start";
                backdrop.style.paddingTop = "16px";
            }
        }, 30);

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
        var i, node, from, to, pos, isCurrent, isSelected, onPath, isActive, cy, label, grd;

        for (i = 0; i < state.nodes.length; i++) {
            node = state.nodes[i];
            if (!node.parentId) continue;
            from = positions[node.parentId];
            to = positions[node.id];
            if (!from || !to) continue;
            isActive = path.indexOf(node.id) !== -1 && path.indexOf(node.parentId) !== -1;
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

    // ── API端点（参考桌宠逻辑）──
    function buildEndpoint(base, path) {
        var url = (base || "").trim().replace(/\/+$/, "");
        // 如果已经包含完整路径就直接用
        if (path === "/chat/completions" && /\/chat\/completions$/.test(url)) return url;
        if (path === "/models" && /\/models$/.test(url)) return url;
        // 自动补 /v1
        if (!/\/v\d+/.test(url)) url += "/v1";
        return url + path;
    }

    // ── 总结（.then链，无async）──
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
        if (btn) { btn.disabled = true; flashBtn(btn); }
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

    // ── 拉取模型（.then链，无async）──
    function fetchModelList() {
        var apiUrl = (state.settings.apiUrl || "").trim();
        var apiKey = (state.settings.apiKey || "").trim();
        if (!apiUrl) { toast("请先设置 API 地址。"); return; }
        var btn = document.getElementById("tlg-fetch-models");
        if (btn) { btn.disabled = true; flashBtn(btn); }
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
            saveToMetadata();
            populateModelSelect();
            toast("已加载 " + models.length + " 个模型。");
        }).catch(function (e) {
            toast("拉取模型失败: " + e.message);
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

    // ── ★ 打开面板 ──
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
            // engine
            '<div class="tlg-view" data-view="engine">' +
            '<div class="tlg-scroll-panel">' +
            '<div class="tlg-section"><div class="tlg-section-title">API 配置</div>' +
            '<label class="tlg-label">API 基础地址（填基址即可，自动补全路径）</label><div class="tlg-row">' +
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
            '<label class="tlg-label">向量 API 地址</label>' +
            '<input class="tlg-input" id="tlg-vec-url" value="' + escHtml(s.vectorUrl || "") + '" style="margin-bottom:8px" />' +
            '<label class="tlg-label">向量 API 密钥</label>' +
            '<input class="tlg-input" id="tlg-vec-key" type="password" value="' + escHtml(s.vectorKey || "") + '" style="margin-bottom:8px" />' +
            '<label class="tlg-label">向量模型</label>' +
            '<input class="tlg-input" id="tlg-vec-model" placeholder="text-embedding-3-small" value="' + escHtml(s.vectorModel || "") + '" style="margin-bottom:8px" />' +
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
        loadFromMetadata();

        // ★ 如果面板已存在，先销毁再重建（确保数据刷新）
        var existingPanel = document.getElementById("tlg-panel");
        if (existingPanel) existingPanel.remove();

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
            if (!on) v.style.display = "none";
            else v.style.display = "flex";
        });
        if (name === "tree") setTimeout(function () { renderCanvas(); }, 50);
        else if (name === "archive") refreshArchive();
        else if (name === "summary") refreshSummary();
        else if (name === "engine") populateModelSelect();
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

        document.getElementById("tlg-auto-toggle").onclick = function () {
            state.settings.autoMode = !state.settings.autoMode;
            this.classList.toggle("on", state.settings.autoMode);
            saveToMetadata();
        };
        document.getElementById("tlg-auto-interval").onchange = function () {
            state.settings.autoInterval = Math.max(1, parseInt(this.value, 10) || 10);
            saveToMetadata();
        };
        document.getElementById("tlg-last-n").onchange = function () {
            state.settings.lastNMessages = Math.max(1, parseInt(this.value, 10) || 5);
            saveToMetadata();
        };
        document.getElementById("tlg-summary-prompt").onchange = function () {
            state.settings.summaryPrompt = this.value;
            saveToMetadata();
        };
        document.getElementById("tlg-summary-run").addEventListener("click", function () {
            flashBtn(this);
            runSummary();
        });

        // 引擎保存
        document.getElementById("tlg-engine-save").addEventListener("click", function () {
            flashBtn(this);
            state.settings.apiUrl = document.getElementById("tlg-api-url").value.trim();
            state.settings.apiKey = document.getElementById("tlg-api-key").value.trim();
            state.settings.vectorUrl = document.getElementById("tlg-vec-url").value.trim();
            state.settings.vectorKey = document.getElementById("tlg-vec-key").value.trim();
            state.settings.vectorModel = document.getElementById("tlg-vec-model").value.trim();
            state.settings.vectorPrompt = document.getElementById("tlg-vec-prompt").value;
            var manual = document.getElementById("tlg-model-manual").value.trim();
            var sel = document.getElementById("tlg-model-select").value;
            state.settings.model = manual || sel;
            saveToMetadata();
            toast("引擎设置已保存。");
        });

        // 拉取模型
        document.getElementById("tlg-fetch-models").addEventListener("click", function () {
            flashBtn(this);
            state.settings.apiUrl = document.getElementById("tlg-api-url").value.trim();
            state.settings.apiKey = document.getElementById("tlg-api-key").value.trim();
            saveToMetadata();
            fetchModelList();
        });

        // 模型选择
        document.getElementById("tlg-model-select").addEventListener("change", function () {
            if (this.value) document.getElementById("tlg-model-manual").value = this.value;
        });

        // 测试API（.then链，无async）
        document.getElementById("tlg-test-api").addEventListener("click", function () {
            var self = this;
            var url = document.getElementById("tlg-api-url").value.trim();
            var key = document.getElementById("tlg-api-key").value.trim();
            if (!url) { toast("请先输入地址。"); return; }
            flashBtn(self);
            state.settings.apiUrl = url;
            state.settings.apiKey = key;
            saveToMetadata();
            toast("正在测试…");
            fetch(buildEndpoint(url, "/models"), {
                headers: key ? { Authorization: "Bearer " + key } : {}
            }).then(function (res) {
                toast(res.ok ? "✓ API 可达。" : ("✗ HTTP " + res.status));
            }).catch(function (e) {
                toast("✗ " + e.message);
            });
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
        if (!isEnabled()) {
            var old = document.getElementById("tlg-menu-btn");
            if (old) old.remove();
            return;
        }
        var menu = document.getElementById("extensionsMenu");
        if (!menu) return;
        if (document.getElementById("tlg-menu-btn")) return;

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
                    document.body.style.overflow = "";
                });
            }
        } catch (e) {}

        console.log("[TLG] 河岸凝视 v2.3 已加载");
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", boot);
    } else {
        setTimeout(boot, 300);
    }
})();


