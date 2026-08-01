/**
 * ═══════════════════════════════════════════════════════════════
 *  The Riparian Gaze — 河岸凝视 v2.1
 *  中文界面 · 全屏移动端 · 扩展设置开关
 *  No imports — window.SillyTavern.getContext()
 * ═══════════════════════════════════════════════════════════════
 */
(function () {
    "use strict";

    const EXT_NAME = "RiparianGaze";
    const METADATA_KEY = "tlg_data";

    let state = {
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
            vectorPrompt: "根据以下上下文：\n{{context}}\n\n请简洁总结关键事件。",
            summaryPrompt: "请简洁总结近期对话中的关键事件。",
        },
        summaries: [],
        turnsSinceAnchor: 0,
        _lastChatLen: 0,
    };

    let canvas = null, ctx = null;
    let camX = 0, camY = 0, camZoom = 1;
    let isPanning = false, panStartX = 0, panStartY = 0;
    let selectedNodeForBrief = null;

    // ─────────────────────────────────────────────
    // Core helpers
    // ─────────────────────────────────────────────
    function getST() {
        return window.SillyTavern?.getContext?.() || null;
    }

    function generateId() {
        return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    }

    function saveToMetadata() {
        const st = getST();
        if (!st) return;
        if (!st.chat_metadata) st.chat_metadata = {};
        st.chat_metadata[METADATA_KEY] = JSON.parse(JSON.stringify(state));
        if (typeof st.saveMetadata === "function") st.saveMetadata();
        else if (typeof window.saveMetadataDebounced === "function") window.saveMetadataDebounced();
    }

    function loadFromMetadata() {
        const st = getST();
        if (!st) return;
        const saved = st.chat_metadata?.[METADATA_KEY];
        if (saved) {
            state = JSON.parse(JSON.stringify(saved));
            if (!state.settings) state.settings = {};
            if (state._lastChatLen == null) state._lastChatLen = 0;
        } else {
            resetState();
            saveToMetadata();
        }
    }

    function resetState() {
        const rootId = generateId();
        state.nodes = [{
            id: rootId,
            name: "起源点",
            brief: "时间线起源。",
            parentId: null,
            msgIdx: 0,
            statData: null,
            timestamp: Date.now(),
            children: [],
        }];
        state.currentNodeId = rootId;
        state.selectedNodeId = null;
        state.summaries = [];
        state.turnsSinceAnchor = 0;
        state._lastChatLen = 0;
    }

    function findNode(id) {
        return state.nodes.find(n => n.id === id) || null;
    }

    function getPathToRoot(nodeId) {
        const path = [];
        let cur = findNode(nodeId);
        while (cur) {
            path.unshift(cur.id);
            cur = findNode(cur.parentId);
        }
        return path;
    }

    function toast(msg, duration) {
        duration = duration || 2800;
        const el = document.createElement("div");
        el.className = "tlg-toast";
        el.textContent = msg;
        document.body.appendChild(el);
        setTimeout(function () {
            el.style.opacity = "0";
            el.style.transition = "opacity 0.4s";
            setTimeout(function () { el.remove(); }, 400);
        }, duration);
    }

    function escHtml(str) {
        return String(str || "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    // ─────────────────────────────────────────────
    // Extension enable switch
    // ─────────────────────────────────────────────
    function getExtSettings() {
        const st = getST();
        const es = (st && st.extensionSettings) || window.extension_settings || {};
        if (!es[EXT_NAME]) es[EXT_NAME] = { enabled: true };
        if (typeof es[EXT_NAME].enabled !== "boolean") es[EXT_NAME].enabled = true;
        return es[EXT_NAME];
    }

    function isEnabled() {
        try { return getExtSettings().enabled !== false; }
        catch (_) { return true; }
    }

    function setEnabled(on) {
        try {
            const st = getST();
            const s = getExtSettings();
            s.enabled = !!on;
            if (st && typeof st.saveSettingsDebounced === "function") st.saveSettingsDebounced();
            else if (typeof window.saveSettingsDebounced === "function") window.saveSettingsDebounced();
            updateEntryVisibility();
            if (!on) closeOverlay();
        } catch (e) {
            console.warn("[TLG] setEnabled:", e);
        }
    }

    // ─────────────────────────────────────────────
    // MVU
    // ─────────────────────────────────────────────
    function getMVUStatData() {
        try {
            const st = getST();
            if (st && st.chat_metadata && st.chat_metadata.stat_data != null) {
                return JSON.parse(JSON.stringify(st.chat_metadata.stat_data));
            }
            if (typeof window.getAllVariables === "function") {
                const all = window.getAllVariables();
                if (all && all.stat_data != null) return JSON.parse(JSON.stringify(all.stat_data));
            }
            const iframe = document.querySelector("#MVU_iframe");
            if (iframe && iframe.contentWindow && iframe.contentWindow.getAllVariables) {
                const all = iframe.contentWindow.getAllVariables();
                if (all && all.stat_data != null) return JSON.parse(JSON.stringify(all.stat_data));
            }
        } catch (e) {
            console.warn("[TLG] getMVUStatData:", e);
        }
        return null;
    }

    function setMVUStatData(data) {
        if (data == null) return;
        try {
            const st = getST();
            if (st && st.chat_metadata) {
                st.chat_metadata.stat_data = JSON.parse(JSON.stringify(data));
                if (typeof st.saveMetadata === "function") st.saveMetadata();
            }
            if (typeof window.setVariable === "function") {
                window.setVariable("stat_data", data);
            }
            const iframe = document.querySelector("#MVU_iframe");
            if (iframe && iframe.contentWindow && iframe.contentWindow.setVariable) {
                iframe.contentWindow.setVariable("stat_data", data);
            }
        } catch (e) {
            console.warn("[TLG] setMVUStatData:", e);
        }
    }

    // ─────────────────────────────────────────────
    // Visibility
    // ─────────────────────────────────────────────
    function applyVisibility(targetNodeId) {
        const st = getST();
        if (!st || !st.chat) return;

        const pathIds = getPathToRoot(targetNodeId);
        const pathNodes = pathIds.map(function (id) { return findNode(id); }).filter(Boolean);
        const visible = new Set();

        for (let i = 0; i < pathNodes.length; i++) {
            const node = pathNodes[i];
            const nextNode = pathNodes[i + 1] || null;
            const start = node.msgIdx;
            const end = nextNode ? nextNode.msgIdx - 1 : node.msgIdx;
            for (let m = start; m <= end; m++) visible.add(m);
        }

        const targetNode = findNode(targetNodeId);
        const lastN = Math.max(0, (state.settings && state.settings.lastNMessages) || 5);
        const endIdx = targetNode ? targetNode.msgIdx : st.chat.length - 1;
        for (let m = Math.max(0, endIdx - lastN + 1); m <= endIdx; m++) visible.add(m);

        for (let i = 0; i < st.chat.length; i++) {
            if (visible.has(i)) delete st.chat[i].is_hidden;
            else st.chat[i].is_hidden = true;
        }

        if (typeof st.saveChat === "function") st.saveChat();
        document.dispatchEvent(new CustomEvent("tlg_visibility_changed"));
    }

    // ─────────────────────────────────────────────
    // Anchor / Jump
    // ─────────────────────────────────────────────
    function createAnchor(name, brief) {
        const st = getST();
        if (!st) return;

        const msgIdx = st.chat ? Math.max(0, st.chat.length - 1) : 0;
        const statData = getMVUStatData();
        const parentId = state.currentNodeId;
        const newId = generateId();

        const newNode = {
            id: newId,
            name: name || ("节点 " + state.nodes.length),
            brief: brief || "",
            parentId: parentId,
            msgIdx: msgIdx,
            statData: statData,
            timestamp: Date.now(),
            children: [],
        };

        const parent = findNode(parentId);
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
        const node = findNode(nodeId);
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
        const existing = document.getElementById("tlg-anchor-modal");
        if (existing) existing.remove();

        const backdrop = document.createElement("div");
        backdrop.className = "tlg-modal-backdrop";
        backdrop.id = "tlg-anchor-modal";
        backdrop.innerHTML =
            '<div class="tlg-modal">' +
            '<div class="tlg-modal-title">⚓ 创建锚定点</div>' +
            '<div style="margin-bottom:12px">' +
            '<label class="tlg-label">节点名称</label>' +
            '<input class="tlg-input" id="tlg-anc-name" placeholder="例：决斗之前…" value="' + escHtml(prefillName || "") + '" />' +
            "</div>" +
            "<div>" +
            '<label class="tlg-label">简要描述</label>' +
            '<textarea class="tlg-textarea" id="tlg-anc-brief" placeholder="此时此刻的情况概述…"></textarea>' +
            "</div>" +
            '<div class="tlg-modal-actions">' +
            '<button class="tlg-btn" id="tlg-anc-cancel">取消</button>' +
            '<button class="tlg-btn tlg-btn-primary" id="tlg-anc-ok">⚓ 确认锚定</button>' +
            "</div></div>";
        document.body.appendChild(backdrop);

        const nameInput = backdrop.querySelector("#tlg-anc-name");
        backdrop.querySelector("#tlg-anc-cancel").onclick = function () { backdrop.remove(); };
        backdrop.querySelector("#tlg-anc-ok").onclick = function () {
            const name = nameInput.value.trim() || ("节点 " + state.nodes.length);
            const brief = backdrop.querySelector("#tlg-anc-brief").value.trim();
            createAnchor(name, brief);
            backdrop.remove();
        };
        backdrop.addEventListener("click", function (e) {
            if (e.target === backdrop) backdrop.remove();
        });
        setTimeout(function () { nameInput.focus(); }, 80);
    }

    // ─────────────────────────────────────────────
    // Tree layout + canvas
    // ─────────────────────────────────────────────
    function layoutTree() {
        const positions = {};
        const H_GAP = 180;
        const V_GAP = 120;

        function subtreeWidth(nodeId) {
            const node = findNode(nodeId);
            if (!node || node.children.length === 0) return 1;
            return node.children.reduce(function (s, cid) { return s + subtreeWidth(cid); }, 0);
        }

        function assign(nodeId, depth, slotStart) {
            const node = findNode(nodeId);
            if (!node) return;
            const w = subtreeWidth(nodeId);
            positions[nodeId] = {
                x: (slotStart + w / 2) * H_GAP,
                y: depth * V_GAP + 60,
            };
            let childSlot = slotStart;
            for (let i = 0; i < node.children.length; i++) {
                const cid = node.children[i];
                const cw = subtreeWidth(cid);
                assign(cid, depth + 1, childSlot);
                childSlot += cw;
            }
        }

        const root = state.nodes.find(function (n) { return n.parentId === null; });
        if (root) assign(root.id, 0, 0);
        return positions;
    }

    function renderCanvas() {
        if (!canvas || !ctx) return;
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;

        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        ctx.fillStyle = "#050508";
        ctx.fillRect(0, 0, rect.width, rect.height);

        ctx.save();
        ctx.translate(rect.width / 2 + camX, rect.height / 2 + camY);
        ctx.scale(camZoom, camZoom);

        const positions = layoutTree();
        const NODE_R = 22;
        const path = getPathToRoot(state.currentNodeId);

        for (let i = 0; i < state.nodes.length; i++) {
            const node = state.nodes[i];
            if (!node.parentId) continue;
            const from = positions[node.parentId];
            const to = positions[node.id];
            if (!from || !to) continue;
            const isActive = path.indexOf(node.id) !== -1 && path.indexOf(node.parentId) !== -1;

            ctx.beginPath();
            ctx.moveTo(from.x, from.y + NODE_R);
            const cy = (from.y + to.y) / 2;
            ctx.bezierCurveTo(from.x, cy, to.x, cy, to.x, to.y - NODE_R);
            if (isActive) {
                ctx.strokeStyle = "rgba(220,220,230,0.85)";
                ctx.lineWidth = 1.8;
                ctx.shadowColor = "rgba(192,192,210,0.5)";
                ctx.shadowBlur = 8;
            } else {
                ctx.strokeStyle = "rgba(192,192,210,0.18)";
                ctx.lineWidth = 1;
                ctx.shadowBlur = 0;
            }
            ctx.stroke();
            ctx.shadowBlur = 0;
        }

        for (let i = 0; i < state.nodes.length; i++) {
            const node = state.nodes[i];
            const pos = positions[node.id];
            if (!pos) continue;
            const isCurrent = node.id === state.currentNodeId;
            const isSelected = node.id === state.selectedNodeId;
            const onPath = path.indexOf(node.id) !== -1;

            if (isCurrent) {
                ctx.beginPath();
                ctx.arc(pos.x, pos.y, NODE_R + 12, 0, Math.PI * 2);
                const grd = ctx.createRadialGradient(pos.x, pos.y, NODE_R, pos.x, pos.y, NODE_R + 14);
                grd.addColorStop(0, "rgba(255,255,255,0.25)");
                grd.addColorStop(1, "rgba(255,255,255,0)");
                ctx.fillStyle = grd;
                ctx.fill();
            }

            ctx.beginPath();
            ctx.arc(pos.x, pos.y, NODE_R, 0, Math.PI * 2);
            if (isCurrent) {
                ctx.fillStyle = "rgba(255,255,255,0.15)";
                ctx.strokeStyle = "#ffffff";
                ctx.lineWidth = 2;
                ctx.shadowColor = "rgba(255,255,255,0.8)";
                ctx.shadowBlur = 18;
            } else if (isSelected) {
                ctx.fillStyle = "rgba(192,192,210,0.12)";
                ctx.strokeStyle = "#c0c0d0";
                ctx.lineWidth = 2;
                ctx.shadowColor = "rgba(192,192,210,0.5)";
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

            if (isSelected && !isCurrent) {
                ctx.beginPath();
                ctx.arc(pos.x, pos.y, NODE_R + 5, 0, Math.PI * 2);
                ctx.strokeStyle = "rgba(192,192,210,0.35)";
                ctx.lineWidth = 1;
                ctx.setLineDash([4, 3]);
                ctx.stroke();
                ctx.setLineDash([]);
            }

            ctx.fillStyle = isCurrent ? "#ffffff" : onPath ? "rgba(220,220,230,0.85)" : "rgba(180,180,195,0.55)";
            ctx.font = isCurrent ? "bold 10px sans-serif" : "10px sans-serif";
            ctx.textAlign = "center";
            ctx.textBaseline = "top";
            const label = node.name.length > 12 ? node.name.slice(0, 11) + "…" : node.name;
            ctx.fillText(label, pos.x, pos.y + NODE_R + 5);
        }
        ctx.restore();
    }

    function canvasHitTest(clientX, clientY) {
        if (!canvas) return null;
        const rect = canvas.getBoundingClientRect();
        const mx = clientX - rect.left;
        const my = clientY - rect.top;
        const wx = (mx - rect.width / 2 - camX) / camZoom;
        const wy = (my - rect.height / 2 - camY) / camZoom;
        const positions = layoutTree();
        const NODE_R = 22;
        const ids = Object.keys(positions);
        for (let i = 0; i < ids.length; i++) {
            const id = ids[i];
            const pos = positions[id];
            const dx = wx - pos.x, dy = wy - pos.y;
            if (dx * dx + dy * dy <= (NODE_R + 4) * (NODE_R + 4)) return id;
        }
        return null;
    }

    // ─────────────────────────────────────────────
    // Brief / Archive / Summary
    // ─────────────────────────────────────────────
    function openBriefPanel(nodeId) {
        const node = findNode(nodeId);
        if (!node) return;
        state.selectedNodeId = nodeId;
        selectedNodeForBrief = nodeId;

        const panel = document.getElementById("tlg-brief-panel");
        if (!panel) return;
        panel.classList.add("open");
        panel.querySelector(".tlg-brief-header span").textContent = node.name;

        const body = panel.querySelector(".tlg-brief-body");
        body.innerHTML =
            '<div style="margin-bottom:8px;font-size:11px;color:var(--tlg-silver-dim)">' +
            new Date(node.timestamp).toLocaleString() + "</div>" +
            '<div style="margin-bottom:8px;font-size:11px;color:var(--tlg-silver-dim)">' +
            "消息索引: " + node.msgIdx + " &nbsp;|&nbsp; " +
            (node.statData ? "MVU快照 ✓" : "无MVU快照") + "</div>" +
            '<div class="tlg-brief-text" style="white-space:pre-wrap;word-break:break-word">' +
            (node.brief || "<em style='color:var(--tlg-silver-dim)'>暂无描述。</em>") + "</div>" +
            '<div style="margin-top:12px">' +
            '<label class="tlg-label">编辑描述</label>' +
            '<textarea class="tlg-textarea" id="tlg-brief-edit" style="min-height:100px">' +
            escHtml(node.brief || "") + "</textarea>" +
            '<button class="tlg-btn tlg-btn-primary" id="tlg-brief-save" style="margin-top:6px;width:100%">保存描述</button>' +
            "</div>";

        body.querySelector("#tlg-brief-save").onclick = function () {
            node.brief = body.querySelector("#tlg-brief-edit").value;
            saveToMetadata();
            toast("描述已保存。");
            refreshArchive();
        };

        const footer = panel.querySelector(".tlg-brief-footer");
        footer.innerHTML = '<button class="tlg-btn tlg-btn-jump" id="tlg-brief-jump">↩ 确认跳转至此节点</button>';
        footer.querySelector("#tlg-brief-jump").onclick = function () { jumpToNode(nodeId); };
        renderCanvas();
    }

    function closeBriefPanel() {
        const panel = document.getElementById("tlg-brief-panel");
        if (panel) panel.classList.remove("open");
        state.selectedNodeId = null;
        selectedNodeForBrief = null;
        renderCanvas();
    }

    function refreshArchive() {
        const container = document.getElementById("tlg-archive-list");
        if (!container) return;
        if (!state.nodes.length) {
            container.innerHTML = '<div style="color:var(--tlg-silver-dim);padding:20px">暂无节点。</div>';
            return;
        }
        const sorted = state.nodes.slice().sort(function (a, b) { return b.timestamp - a.timestamp; });
        container.innerHTML = sorted.map(function (node) {
            const isCurrent = node.id === state.currentNodeId;
            return (
                '<div class="tlg-archive-card ' + (isCurrent ? "current" : "") + '" data-nid="' + node.id + '">' +
                '<div class="tlg-archive-title">' + escHtml(node.name) +
                (isCurrent ? " <span style='color:var(--tlg-silver-dim);font-size:11px'>(当前)</span>" : "") +
                "</div>" +
                '<div class="tlg-archive-meta">' + new Date(node.timestamp).toLocaleString() +
                " · 消息 " + node.msgIdx + "</div>" +
                '<div class="tlg-archive-brief">' + escHtml(node.brief || "") + "</div>" +
                '<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">' +
                '<button class="tlg-btn tlg-archive-view" data-nid="' + node.id + '">在树图中查看</button>' +
                '<button class="tlg-btn tlg-btn-primary tlg-archive-jump" data-nid="' + node.id + '">↩ 跳转至此</button>' +
                '<button class="tlg-btn tlg-btn-danger tlg-archive-del" data-nid="' + node.id + '" style="margin-left:auto">✕</button>' +
                "</div></div>"
            );
        }).join("");

        container.querySelectorAll(".tlg-archive-view").forEach(function (btn) {
            btn.onclick = function () {
                switchTab("tree");
                openBriefPanel(btn.dataset.nid);
            };
        });
        container.querySelectorAll(".tlg-archive-jump").forEach(function (btn) {
            btn.onclick = function () { jumpToNode(btn.dataset.nid); };
        });
        container.querySelectorAll(".tlg-archive-del").forEach(function (btn) {
            btn.onclick = function () {
                const nid = btn.dataset.nid;
                if (nid === state.currentNodeId) { toast("无法删除当前所在节点。"); return; }
                const n = findNode(nid);
                if (!confirm("确定删除节点「" + (n ? n.name : "") + "」？")) return;
                deleteNode(nid);
            };
        });
    }

    function deleteNode(nodeId) {
        const node = findNode(nodeId);
        if (!node) return;
        const parent = findNode(node.parentId);
        if (parent) parent.children = parent.children.filter(function (id) { return id !== nodeId; });
        function removeRecursive(id) {
            const n = findNode(id);
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
        const list = document.getElementById("tlg-summary-list");
        if (!list) return;
        if (!state.summaries || !state.summaries.length) {
            list.innerHTML = '<div style="color:var(--tlg-silver-dim)">暂无总结记录。</div>';
            return;
        }
        list.innerHTML = state.summaries.slice().reverse().map(function (s, i) {
            const idx = state.summaries.length - 1 - i;
            return (
                '<div class="tlg-section" style="margin-bottom:10px">' +
                '<div style="font-size:11px;color:var(--tlg-silver-dim);margin-bottom:6px">' +
                new Date(s.timestamp).toLocaleString() + "</div>" +
                '<div style="font-size:13px;white-space:pre-wrap">' + escHtml(s.text) + "</div>" +
                '<button class="tlg-btn tlg-btn-danger" style="margin-top:8px;font-size:11px" data-idx="' + idx + '">删除</button>' +
                "</div>"
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

    function buildEndpoint(base, path) {
        let url = (base || "").trim();
        if (!/\/v\d/.test(url) && !url.endsWith("/")) url += "/v1";
        else if (url.endsWith("/")) url = url.slice(0, -1);
        return url + path;
    }

    async function runSummary() {
        const apiUrl = (state.settings.apiUrl || "").trim();
        const apiKey = (state.settings.apiKey || "").trim();
        const model = (state.settings.model || "").trim();
        if (!apiUrl) { toast("请先在引擎标签页设置 API 地址。"); return; }

        const st = getST();
        const recentChat = (st && st.chat ? st.chat : []).slice(-20).map(function (m) {
            return (m.name || m.role) + ": " + m.mes;
        }).join("\n");
        const prompt = (state.settings.summaryPrompt || "").replace("{{context}}", recentChat);
        const btn = document.getElementById("tlg-summary-run");
        if (btn) btn.disabled = true;
        toast("正在生成总结…");

        try {
            const res = await fetch(buildEndpoint(apiUrl, "/chat/completions"), {
                method: "POST",
                headers: Object.assign(
                    { "Content-Type": "application/json" },
                    apiKey ? { Authorization: "Bearer " + apiKey } : {}
                ),
                body: JSON.stringify({
                    model: model || undefined,
                    messages: [{ role: "user", content: prompt }],
                    max_tokens: 512,
                }),
            });
            if (!res.ok) throw new Error("HTTP " + res.status);
            const data = await res.json();
            const text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
            if (!state.summaries) state.summaries = [];
            state.summaries.push({ timestamp: Date.now(), text: text });
            saveToMetadata();
            refreshSummary();
            toast("总结已生成。");
        } catch (e) {
            toast("总结失败: " + e.message);
            console.error("[TLG] Summary error:", e);
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    async function fetchModelList() {
        const apiUrl = (state.settings.apiUrl || "").trim();
        const apiKey = (state.settings.apiKey || "").trim();
        if (!apiUrl) { toast("请先设置 API 地址。"); return; }
        const btn = document.getElementById("tlg-fetch-models");
        if (btn) btn.disabled = true;
        toast("正在拉取模型列表…");
        try {
            const res = await fetch(buildEndpoint(apiUrl, "/models"), {
                headers: apiKey ? { Authorization: "Bearer " + apiKey } : {},
            });
            if (!res.ok) throw new Error("HTTP " + res.status);
            const data = await res.json();
            const models = (data.data || data.models || []).map(function (m) {
                return typeof m === "string" ? m : (m.id || m.name || "");
            }).filter(Boolean);
            state.settings.modelList = models;
            saveToMetadata();
            populateModelSelect();
            toast("已加载 " + models.length + " 个模型。");
        } catch (e) {
            toast("拉取模型失败: " + e.message);
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    function populateModelSelect() {
        const sel = document.getElementById("tlg-model-select");
        if (!sel) return;
        const list = state.settings.modelList || [];
        sel.innerHTML = '<option value="">-- 选择模型 --</option>' +
            list.map(function (m) {
                return '<option value="' + escHtml(m) + '"' +
                    (m === state.settings.model ? " selected" : "") + ">" + escHtml(m) + "</option>";
            }).join("");
        if (state.settings.model && list.indexOf(state.settings.model) === -1) {
            sel.innerHTML += '<option value="' + escHtml(state.settings.model) + '" selected>' +
                escHtml(state.settings.model) + "</option>";
        }
    }

    // ─────────────────────────────────────────────
    // UI
    // ─────────────────────────────────────────────
    function buildUI() {
        const existing = document.getElementById("tlg-overlay");
        if (existing) existing.remove();

        const s = state.settings || {};
        const overlay = document.createElement("div");
        overlay.id = "tlg-overlay";
        overlay.innerHTML =
            '<div class="tlg-tab-bar">' +
            '<div class="tlg-tab active" data-tab="tree"><span class="tlg-tab-icon">🌿</span><span class="tlg-tab-label">因果树</span></div>' +
            '<div class="tlg-tab" data-tab="archive"><span class="tlg-tab-icon">📁</span><span class="tlg-tab-label">档案库</span></div>' +
            '<div class="tlg-tab" data-tab="summary"><span class="tlg-tab-icon">📝</span><span class="tlg-tab-label">总结池</span></div>' +
            '<div class="tlg-tab" data-tab="engine"><span class="tlg-tab-icon">⚙️</span><span class="tlg-tab-label">引擎设置</span></div>' +
            '<div class="tlg-close-btn" id="tlg-close">✕</div>' +
            "</div>" +
            '<div class="tlg-tab-content">' +
            '<div class="tlg-panel active" id="tlg-panel-tree">' +
            '<div id="tlg-canvas-wrap">' +
            '<canvas id="tlg-tree-canvas"></canvas>' +
            '<div id="tlg-canvas-toolbar">' +
            '<button class="tlg-btn" id="tlg-canvas-anchor">⚓ 在此锚定</button>' +
            '<button class="tlg-btn" id="tlg-canvas-reset-view">重置视图</button>' +
            "</div></div>" +
            '<div id="tlg-brief-panel">' +
            '<div class="tlg-brief-header"><span>节点</span>' +
            '<button class="tlg-btn" id="tlg-brief-close" style="padding:2px 8px">✕</button></div>' +
            '<div class="tlg-brief-body"></div><div class="tlg-brief-footer"></div></div></div>' +
            '<div class="tlg-panel" id="tlg-panel-archive">' +
            '<div class="tlg-archive-panel" style="width:100%">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;gap:8px;flex-wrap:wrap">' +
            '<div style="font-size:15px;font-weight:600;color:var(--tlg-silver-bright)">全部节点</div>' +
            '<button class="tlg-btn tlg-btn-primary" id="tlg-archive-new">⚓ 新建锚定</button></div>' +
            '<div id="tlg-archive-list"></div></div></div>' +
            '<div class="tlg-panel" id="tlg-panel-summary">' +
            '<div class="tlg-summary-panel" style="width:100%">' +
            '<div class="tlg-section"><div class="tlg-section-title">自动总结模式</div>' +
            '<div class="tlg-row"><span class="tlg-label" style="margin:0">自动模式</span>' +
            '<div class="tlg-toggle ' + (s.autoMode ? "on" : "") + '" id="tlg-auto-toggle"></div></div>' +
            '<div class="tlg-row" style="margin-top:8px"><label class="tlg-label" style="margin:0;flex:1">每 ' +
            '<input class="tlg-input" id="tlg-auto-interval" type="number" min="1" max="100" value="' + (s.autoInterval || 10) +
            '" style="width:70px;display:inline-block;padding:4px 8px;margin:0 6px;font-size:14px"> 轮提醒</label></div>' +
            '<div class="tlg-row" style="margin-top:8px"><label class="tlg-label" style="margin:0;flex:1">跳转后显示最后 ' +
            '<input class="tlg-input" id="tlg-last-n" type="number" min="1" max="100" value="' + (s.lastNMessages || 5) +
            '" style="width:70px;display:inline-block;padding:4px 8px;margin:0 6px;font-size:14px"> 条消息</label></div></div>' +
            '<div class="tlg-section"><div class="tlg-section-title">总结提示词</div>' +
            '<label class="tlg-label">提示词模板（用 {{context}} 代入聊天记录）</label>' +
            '<textarea class="tlg-textarea" id="tlg-summary-prompt" style="min-height:120px">' +
            escHtml(s.summaryPrompt || "") + "</textarea>" +
            '<button class="tlg-btn tlg-btn-primary" id="tlg-summary-run" style="margin-top:10px">▶ 立即生成总结</button></div>' +
            '<div class="tlg-section"><div class="tlg-section-title">总结历史</div><div id="tlg-summary-list"></div></div></div></div>' +
            '<div class="tlg-panel" id="tlg-panel-engine">' +
            '<div class="tlg-engine-panel" style="width:100%">' +
            '<div class="tlg-section"><div class="tlg-section-title">API 配置</div>' +
            '<label class="tlg-label">API 基础地址</label><div class="tlg-row">' +
            '<input class="tlg-input" id="tlg-api-url" placeholder="https://api.openai.com" value="' + escHtml(s.apiUrl || "") + '" />' +
            '<button class="tlg-btn" id="tlg-test-api">测试</button></div>' +
            '<label class="tlg-label">API 密钥</label>' +
            '<input class="tlg-input" id="tlg-api-key" type="password" placeholder="sk-…" value="' + escHtml(s.apiKey || "") +
            '" style="margin-bottom:12px" />' +
            '<label class="tlg-label">模型</label><div class="tlg-row">' +
            '<select class="tlg-select" id="tlg-model-select" style="flex:1"></select>' +
            '<button class="tlg-btn" id="tlg-fetch-models">拉取列表</button></div>' +
            '<label class="tlg-label" style="margin-top:4px">或手动输入模型名称</label>' +
            '<input class="tlg-input" id="tlg-model-manual" placeholder="gpt-4o-mini" value="' + escHtml(s.model || "") +
            '" style="margin-bottom:4px" /></div>' +
            '<div class="tlg-section"><div class="tlg-section-title">向量 API（可选）</div>' +
            '<label class="tlg-label">向量 API 地址</label>' +
            '<input class="tlg-input" id="tlg-vec-url" value="' + escHtml(s.vectorUrl || "") + '" style="margin-bottom:8px" />' +
            '<label class="tlg-label">向量 API 密钥</label>' +
            '<input class="tlg-input" id="tlg-vec-key" type="password" value="' + escHtml(s.vectorKey || "") +
            '" style="margin-bottom:8px" />' +
            '<label class="tlg-label">检索提示词模板</label>' +
            '<textarea class="tlg-textarea" id="tlg-vec-prompt" style="min-height:80px">' +
            escHtml(s.vectorPrompt || "") + "</textarea></div>" +
            '<button class="tlg-btn tlg-btn-primary" id="tlg-engine-save" style="width:100%;margin-top:4px">保存引擎设置</button>' +
            "</div></div></div>";

        document.body.appendChild(overlay);
        bindUIEvents(overlay);
    }

    function bindUIEvents(overlay) {
        document.getElementById("tlg-close").onclick = function () { closeOverlay(); };
        overlay.querySelectorAll(".tlg-tab").forEach(function (tab) {
            tab.onclick = function () { switchTab(tab.dataset.tab); };
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
        document.getElementById("tlg-summary-run").onclick = function () { runSummary(); };

        document.getElementById("tlg-engine-save").onclick = function () {
            state.settings.apiUrl = document.getElementById("tlg-api-url").value.trim();
            state.settings.apiKey = document.getElementById("tlg-api-key").value.trim();
            state.settings.vectorUrl = document.getElementById("tlg-vec-url").value.trim();
            state.settings.vectorKey = document.getElementById("tlg-vec-key").value.trim();
            state.settings.vectorPrompt = document.getElementById("tlg-vec-prompt").value;
            const manual = document.getElementById("tlg-model-manual").value.trim();
            const sel = document.getElementById("tlg-model-select").value;
            state.settings.model = manual || sel;
            saveToMetadata();
            toast("引擎设置已保存。");
        };
        document.getElementById("tlg-fetch-models").onclick = function () { fetchModelList(); };
        document.getElementById("tlg-model-select").onchange = function () {
            if (this.value) document.getElementById("tlg-model-manual").value = this.value;
        };
        document.getElementById("tlg-test-api").onclick = async function () {
            const url = document.getElementById("tlg-api-url").value.trim();
            const key = document.getElementById("tlg-api-key").value.trim();
            if (!url) { toast("请先输入地址。"); return; }
            toast("正在测试…");
            try {
                const res = await fetch(buildEndpoint(url, "/models"), {
                    headers: key ? { Authorization: "Bearer " + key } : {},
                });
                if (res.ok) toast("✓ API 可达。");
                else toast("✗ HTTP " + res.status);
            } catch (e) {
                toast("✗ " + e.message);
            }
        };

        initCanvasEvents();
    }

    function initCanvasEvents() {
        const wrap = document.getElementById("tlg-canvas-wrap");
        if (!wrap) return;
        canvas = document.getElementById("tlg-tree-canvas");
        ctx = canvas.getContext("2d");

        if (typeof ResizeObserver !== "undefined") {
            new ResizeObserver(function () { renderCanvas(); }).observe(wrap);
        }

        canvas.addEventListener("mousedown", function (e) {
            if (e.button !== 0) return;
            const hit = canvasHitTest(e.clientX, e.clientY);
            if (hit) { openBriefPanel(hit); return; }
            isPanning = true;
            panStartX = e.clientX - camX;
            panStartY = e.clientY - camY;
            canvas.style.cursor = "grabbing";
        });
        canvas.addEventListener("mousemove", function (e) {
            if (!isPanning) return;
            camX = e.clientX - panStartX;
            camY = e.clientY - panStartY;
            renderCanvas();
        });
        function endPan() {
            isPanning = false;
            if (canvas) canvas.style.cursor = "grab";
        }
        canvas.addEventListener("mouseup", endPan);
        canvas.addEventListener("mouseleave", endPan);
        canvas.addEventListener("wheel", function (e) {
            e.preventDefault();
            const factor = e.deltaY < 0 ? 1.1 : 0.91;
            camZoom = Math.max(0.2, Math.min(4, camZoom * factor));
            renderCanvas();
        }, { passive: false });

        let lastTouchDist = 0;
        let touchStartHit = null;
        let touchMoved = false;

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
                const dist = Math.hypot(
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

    function switchTab(name) {
        document.querySelectorAll(".tlg-tab").forEach(function (t) {
            t.classList.toggle("active", t.dataset.tab === name);
        });
        document.querySelectorAll(".tlg-panel").forEach(function (p) {
            p.classList.remove("active");
        });
        const panel = document.getElementById("tlg-panel-" + name);
        if (panel) panel.classList.add("active");
        if (name === "tree") setTimeout(function () { renderCanvas(); }, 50);
        else if (name === "archive") refreshArchive();
        else if (name === "summary") refreshSummary();
        else if (name === "engine") populateModelSelect();
    }

    function openOverlay() {
        if (!isEnabled()) {
            toast("河岸凝视已关闭，请到「扩展」设置中开启。");
            return;
        }
        loadFromMetadata();
        buildUI();
        const overlay = document.getElementById("tlg-overlay");
        if (!overlay) return;
        if (overlay.parentElement !== document.body) document.body.appendChild(overlay);
        overlay.classList.add("tlg-active");
        document.body.style.overflow = "hidden";
        setTimeout(function () { renderCanvas(); }, 80);
    }

    function closeOverlay() {
        const overlay = document.getElementById("tlg-overlay");
        if (overlay) overlay.classList.remove("tlg-active");
        document.body.style.overflow = "";
    }

    // ─────────────────────────────────────────────
    // Entries: wand menu + settings drawer
    // ─────────────────────────────────────────────
    function makeOpenButton(id) {
        const btn = document.createElement("div");
        btn.id = id;
        btn.className = "list-group-item flex-container flexGap5 interactable tlg-open-entry";
        btn.title = "河岸凝视";
        btn.tabIndex = 0;
        btn.innerHTML =
            '<span style="font-size:15px;margin-right:6px">🌊</span>' +
            '<span>河岸凝视</span>';
        btn.style.cssText = "cursor:pointer;padding:8px 10px;display:flex;align-items:center;";
        btn.onclick = function (e) {
            e.preventDefault();
            e.stopPropagation();
            const ov = document.getElementById("tlg-overlay");
            if (ov && ov.classList.contains("tlg-active")) closeOverlay();
            else openOverlay();
        };
        return btn;
    }

    function injectMenuEntries() {
        if (!isEnabled()) {
            const a = document.getElementById("tlg-open-btn");
            const b = document.getElementById("tlg-open-btn-ext");
            if (a) a.remove();
            if (b) b.remove();
            return;
        }

        // 魔法棒 / 扩展菜单
        const wandHosts = [
            "#extensionsMenu",
            "#extensionsMenuButton + .list-group",
            "#extensionMenuItems",
            ".extensions_menu",
            "#extensions_menu",
        ];
        for (let i = 0; i < wandHosts.length; i++) {
            const el = document.querySelector(wandHosts[i]);
            if (el && !document.getElementById("tlg-open-btn")) {
                el.appendChild(makeOpenButton("tlg-open-btn"));
                break;
            }
        }

        // 扩展下拉（部分主题）
        const extMenu = document.querySelector("#rm_button_extensions") ||
            document.querySelector("#extensions-settings-button");
        // 主要入口在设置抽屉；这里再尝试常见列表容器
        const listHosts = [
            "#extensions_details",
            "#rm_extensions_block .list-group",
            "#extensions_list",
        ];
        for (let i = 0; i < listHosts.length; i++) {
            const el = document.querySelector(listHosts[i]);
            if (el && !document.getElementById("tlg-open-btn-ext")) {
                el.appendChild(makeOpenButton("tlg-open-btn-ext"));
                break;
            }
        }
        void extMenu;
    }

    function updateEntryVisibility() {
        const show = isEnabled();
        ["tlg-open-btn", "tlg-open-btn-ext"].forEach(function (id) {
            const el = document.getElementById(id);
            if (el) el.style.display = show ? "" : "none";
        });
        const toggle = document.getElementById("tlg_enable_toggle");
        if (toggle) toggle.classList.toggle("on", show);
    }

    function injectSettingsPanel() {
        if (document.getElementById("tlg_settings_block")) return;
        const host =
            document.querySelector("#extensions_settings2") ||
            document.querySelector("#extensions_settings") ||
            document.querySelector("#extensions_settings1");
        if (!host) return;

        const enabled = isEnabled();
        const block = document.createElement("div");
        block.id = "tlg_settings_block";
        block.className = "extension_container";
        block.innerHTML =
            '<div class="inline-drawer">' +
            '<div class="inline-drawer-toggle inline-drawer-header">' +
            "<b>🌊 河岸凝视</b>" +
            '<div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>' +
            "</div>" +
            '<div class="inline-drawer-content">' +
            '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin:8px 0;">' +
            "<span>启用插件</span>" +
            '<div class="tlg-toggle ' + (enabled ? "on" : "") + '" id="tlg_enable_toggle" title="启用/禁用"></div>' +
            "</div>" +
            '<div style="font-size:12px;opacity:.75;margin-bottom:8px;">关闭后隐藏菜单入口并停止全屏面板。</div>' +
            '<div class="tlg-settings-actions" style="display:flex;gap:8px;flex-wrap:wrap;">' +
            '<button class="menu_button" id="tlg_settings_open" type="button">打开河岸凝视面板</button>' +
            "</div>" +
            '<div style="font-size:11px;opacity:.55;margin-top:10px;">斜杠命令：/tlg_anchor · 数据存于当前聊天 metadata</div>' +
            "</div></div>";
        host.appendChild(block);

        const toggle = block.querySelector("#tlg_enable_toggle");
        toggle.onclick = function () {
            const next = !toggle.classList.contains("on");
            toggle.classList.toggle("on", next);
            setEnabled(next);
            toast(next ? "河岸凝视已启用" : "河岸凝视已关闭");
            injectMenuEntries();
        };
        block.querySelector("#tlg_settings_open").onclick = function () { openOverlay(); };
    }

    function registerSlashCommand() {
        function wrap(value) {
            if (!isEnabled()) { toast("河岸凝视已关闭。"); return ""; }
            loadFromMetadata();
            showAnchorModal(String(value || ""));
            return "";
        }
        const st = getST();
        if (st && st.registerSlashCommand) {
            st.registerSlashCommand("tlg_anchor", function (args, value) {
                return wrap(value);
            }, [], "创建河岸凝视锚定点", true, true);
        }
        if (window.SillyTavern && window.SillyTavern.SlashCommandParser) {
            try {
                window.SillyTavern.SlashCommandParser.addCommandObject(
                    window.SillyTavern.SlashCommand.fromProps({
                        name: "tlg_anchor",
                        callback: function (args, value) { return wrap(value); },
                        helpString: "创建河岸凝视因果锚定点。",
                    })
                );
            } catch (e) {
                console.warn("[TLG] SlashCommandParser:", e);
            }
        }
    }

    function watchChatChange() {
        let lastChatId = null;
        setInterval(function () {
            const st = getST();
            const chatId = (st && (st.chatId || (st.getCurrentChatId && st.getCurrentChatId()))) || null;
            if (chatId && chatId !== lastChatId) {
                lastChatId = chatId;
                loadFromMetadata();
                const overlay = document.getElementById("tlg-overlay");
                if (overlay && overlay.classList.contains("tlg-active")) {
                    renderCanvas();
                    refreshArchive();
                }
            }
            if (state.settings && state.settings.autoMode && isEnabled()) {
                const chat = st && st.chat;
                if (chat) {
                    const n = chat.length;
                    if (n > (state._lastChatLen || 0)) {
                        state.turnsSinceAnchor = (state.turnsSinceAnchor || 0) + (n - (state._lastChatLen || 0));
                        state._lastChatLen = n;
                        if (state.turnsSinceAnchor >= (state.settings.autoInterval || 10)) {
                            toast("⚓ 该锚定了！(距上次锚定已过 " + state.turnsSinceAnchor + " 轮)");
                            state.turnsSinceAnchor = 0;
                        }
                    }
                }
            }
        }, 2000);
    }

    function boot() {
        injectMenuEntries();
        injectSettingsPanel();
        const observer = new MutationObserver(function () {
            injectMenuEntries();
            injectSettingsPanel();
        });
        observer.observe(document.body, { childList: true, subtree: true });
        registerSlashCommand();
        watchChatChange();
        console.log("[TLG] 河岸凝视 v2.1 已加载。");
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", boot);
    } else {
        setTimeout(boot, 300);
    }
})();
