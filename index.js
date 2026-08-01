/**
 * ═══════════════════════════════════════════════════════════════
 *  The Riparian Gaze — 河岸凝视 v2.0
 *  A causal-timeline manager for SillyTavern
 *  No imports — uses window.SillyTavern.getContext() globally
 * ═══════════════════════════════════════════════════════════════
 */
(function () {
    "use strict";

    const EXT_NAME = "RiparianGaze";
    const METADATA_KEY = "tlg_data";

    // ─────────────────────────────────────────────
    //  State
    // ─────────────────────────────────────────────
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
            vectorPrompt: "Based on the following context:\n{{context}}\n\nSummarize the key events.",
            summaryPrompt: "Summarize the recent conversation events concisely.",
        },
        summaries: [],
        turnsSinceAnchor: 0,
    };

    // ─────────────────────────────────────────────
    //  Canvas camera
    // ─────────────────────────────────────────────
    let canvas = null, ctx = null;
    let camX = 0, camY = 0, camZoom = 1;
    let isPanning = false, panStartX = 0, panStartY = 0;
    let selectedNodeForBrief = null;

    // ─────────────────────────────────────────────
    //  Core helpers
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
        } else {
            resetState();
            saveToMetadata();
        }
    }

    function resetState() {
        const rootId = generateId();
        state.nodes = [{
            id: rootId,
            name: "Origin",
            brief: "Timeline origin point.",
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

    function toast(msg, duration = 2800) {
        const el = document.createElement("div");
        el.className = "tlg-toast";
        el.textContent = msg;
        document.body.appendChild(el);
        setTimeout(() => {
            el.style.opacity = "0";
            el.style.transition = "opacity 0.4s";
            setTimeout(() => el.remove(), 400);
        }, duration);
    }

    // ─────────────────────────────────────────────
    //  MVU variable interaction
    // ─────────────────────────────────────────────
    function getMVUStatData() {
        try {
            const st = getST();
            // Try chat_metadata first (MVU v2+)
            if (st?.chat_metadata?.stat_data != null) {
                return JSON.parse(JSON.stringify(st.chat_metadata.stat_data));
            }
            // Try window globals (MVU v1)
            if (typeof window.getAllVariables === "function") {
                const all = window.getAllVariables();
                if (all?.stat_data != null) return JSON.parse(JSON.stringify(all.stat_data));
            }
            // Try iframe
            const iframe = document.querySelector("#MVU_iframe");
            if (iframe?.contentWindow?.getAllVariables) {
                const all = iframe.contentWindow.getAllVariables();
                if (all?.stat_data != null) return JSON.parse(JSON.stringify(all.stat_data));
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
            // Write to chat_metadata
            if (st?.chat_metadata) {
                st.chat_metadata.stat_data = JSON.parse(JSON.stringify(data));
                if (typeof st.saveMetadata === "function") st.saveMetadata();
            }
            // Try window.setVariable
            if (typeof window.setVariable === "function") {
                window.setVariable("stat_data", data);
            }
            // Try iframe
            const iframe = document.querySelector("#MVU_iframe");
            if (iframe?.contentWindow?.setVariable) {
                iframe.contentWindow.setVariable("stat_data", data);
            }
        } catch (e) {
            console.warn("[TLG] setMVUStatData:", e);
        }
    }

    // ─────────────────────────────────────────────
    //  Message visibility
    // ─────────────────────────────────────────────
    function applyVisibility(targetNodeId) {
        const st = getST();
        if (!st?.chat) return;

        const pathIds = getPathToRoot(targetNodeId);
        const pathNodes = pathIds.map(id => findNode(id)).filter(Boolean);

        // Collect visible message indices from the causal path
        const visible = new Set();
        for (let i = 0; i < pathNodes.length; i++) {
            const node = pathNodes[i];
            const nextNode = pathNodes[i + 1] || null;
            const start = node.msgIdx;
            const end = nextNode ? nextNode.msgIdx - 1 : node.msgIdx;
            for (let m = start; m <= end; m++) visible.add(m);
        }

        // Also keep last N messages before target node's msgIdx
        const targetNode = findNode(targetNodeId);
        const lastN = Math.max(0, state.settings.lastNMessages || 5);
        const endIdx = targetNode ? targetNode.msgIdx : st.chat.length - 1;
        for (let m = Math.max(0, endIdx - lastN + 1); m <= endIdx; m++) {
            visible.add(m);
        }

        // Apply
        for (let i = 0; i < st.chat.length; i++) {
            if (visible.has(i)) {
                delete st.chat[i].is_hidden;
            } else {
                st.chat[i].is_hidden = true;
            }
        }

        if (typeof st.saveChat === "function") st.saveChat();
        // Trigger UI refresh
        const event = new CustomEvent("tlg_visibility_changed");
        document.dispatchEvent(event);
    }

    // ─────────────────────────────────────────────
    //  Anchoring
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
            name: name || `Node ${state.nodes.length}`,
            brief: brief || "",
            parentId: parentId,
            msgIdx: msgIdx,
            statData: statData,
            timestamp: Date.now(),
            children: [],
        };

        const parent = findNode(parentId);
        if (parent && !parent.children.includes(newId)) {
            parent.children.push(newId);
        }

        state.nodes.push(newNode);
        state.currentNodeId = newId;
        state.selectedNodeId = newId;
        state.turnsSinceAnchor = 0;
        saveToMetadata();
        toast(`⚓ Anchored: ${newNode.name}`);
        renderCanvas();
        refreshArchive();
        return newId;
    }

    // ─────────────────────────────────────────────
    //  Jump to node
    // ─────────────────────────────────────────────
    function jumpToNode(nodeId) {
        const node = findNode(nodeId);
        if (!node) { toast("Node not found."); return; }

        // 1. Restore MVU variables
        if (node.statData != null) {
            setMVUStatData(node.statData);
        }

        // 2. Apply message visibility
        applyVisibility(nodeId);

        // 3. Update state
        state.currentNodeId = nodeId;
        state.turnsSinceAnchor = 0;
        saveToMetadata();

        toast(`↩ Jumped to: ${node.name}`);
        renderCanvas();
        refreshArchive();
        closeBriefPanel();
    }

    // ─────────────────────────────────────────────
    //  Anchor modal
    // ─────────────────────────────────────────────
    function showAnchorModal(prefillName) {
        const existing = document.getElementById("tlg-anchor-modal");
        if (existing) existing.remove();

        const backdrop = document.createElement("div");
        backdrop.className = "tlg-modal-backdrop";
        backdrop.id = "tlg-anchor-modal";
        backdrop.innerHTML = `
            <div class="tlg-modal">
                <div class="tlg-modal-title">⚓ Create Anchor Point</div>
                <div style="margin-bottom:12px">
                    <label class="tlg-label">Node Name</label>
                    <input class="tlg-input" id="tlg-anc-name" placeholder="e.g. Before the duel…" value="${prefillName || ""}" />
                </div>
                <div>
                    <label class="tlg-label">Brief Description</label>
                    <textarea class="tlg-textarea" id="tlg-anc-brief" placeholder="What is the situation at this point…"></textarea>
                </div>
                <div class="tlg-modal-actions">
                    <button class="tlg-btn" id="tlg-anc-cancel">Cancel</button>
                    <button class="tlg-btn tlg-btn-primary" id="tlg-anc-ok">⚓ Confirm Anchor</button>
                </div>
            </div>
        `;
        document.body.appendChild(backdrop);

        const nameInput = backdrop.querySelector("#tlg-anc-name");
        const briefInput = backdrop.querySelector("#tlg-anc-brief");

        backdrop.querySelector("#tlg-anc-cancel").onclick = () => backdrop.remove();
        backdrop.querySelector("#tlg-anc-ok").onclick = () => {
            const name = nameInput.value.trim() || `Node ${state.nodes.length}`;
            const brief = briefInput.value.trim();
            createAnchor(name, brief);
            backdrop.remove();
        };
        backdrop.addEventListener("click", e => { if (e.target === backdrop) backdrop.remove(); });
        setTimeout(() => nameInput.focus(), 80);
    }

    // ─────────────────────────────────────────────
    //  Tree layout
    // ─────────────────────────────────────────────
    function layoutTree() {
        const positions = {};
        const H_GAP = 180;
        const V_GAP = 120;

        function subtreeWidth(nodeId) {
            const node = findNode(nodeId);
            if (!node || node.children.length === 0) return 1;
            return node.children.reduce((s, cid) => s + subtreeWidth(cid), 0);
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
            for (const cid of node.children) {
                const cw = subtreeWidth(cid);
                assign(cid, depth + 1, childSlot);
                childSlot += cw;
            }
        }

        const root = state.nodes.find(n => n.parentId === null);
        if (root) assign(root.id, 0, 0);
        return positions;
    }

    // ─────────────────────────────────────────────
    //  Canvas rendering
    // ─────────────────────────────────────────────
    function renderCanvas() {
        if (!canvas || !ctx) return;

        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;

        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        // Background
        ctx.fillStyle = "#050508";
        ctx.fillRect(0, 0, rect.width, rect.height);

        ctx.save();
        ctx.translate(rect.width / 2 + camX, rect.height / 2 + camY);
        ctx.scale(camZoom, camZoom);

        const positions = layoutTree();
        const NODE_R = 22;

        // ── Edges ──
        for (const node of state.nodes) {
            if (!node.parentId) continue;
            const from = positions[node.parentId];
            const to = positions[node.id];
            if (!from || !to) continue;

            const isActive = getPathToRoot(state.currentNodeId).includes(node.id) &&
                             getPathToRoot(state.currentNodeId).includes(node.parentId);

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

        // ── Nodes ──
        for (const node of state.nodes) {
            const pos = positions[node.id];
            if (!pos) continue;

            const isCurrent = node.id === state.currentNodeId;
            const isSelected = node.id === state.selectedNodeId;
            const onPath = getPathToRoot(state.currentNodeId).includes(node.id);

            // Glow for current node
            if (isCurrent) {
                ctx.beginPath();
                ctx.arc(pos.x, pos.y, NODE_R + 12, 0, Math.PI * 2);
                const grd = ctx.createRadialGradient(pos.x, pos.y, NODE_R, pos.x, pos.y, NODE_R + 14);
                grd.addColorStop(0, "rgba(255,255,255,0.25)");
                grd.addColorStop(1, "rgba(255,255,255,0)");
                ctx.fillStyle = grd;
                ctx.fill();
            }

            // Node circle
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

            // Selection ring
            if (isSelected && !isCurrent) {
                ctx.beginPath();
                ctx.arc(pos.x, pos.y, NODE_R + 5, 0, Math.PI * 2);
                ctx.strokeStyle = "rgba(192,192,210,0.35)";
                ctx.lineWidth = 1;
                ctx.setLineDash([4, 3]);
                ctx.stroke();
                ctx.setLineDash([]);
            }

            // Label
            ctx.fillStyle = isCurrent ? "#ffffff" : onPath ? "rgba(220,220,230,0.85)" : "rgba(180,180,195,0.55)";
            ctx.font = isCurrent ? "bold 10px 'Segoe UI', sans-serif" : "10px 'Segoe UI', sans-serif";
            ctx.textAlign = "center";
            ctx.textBaseline = "top";
            const label = node.name.length > 12 ? node.name.slice(0, 11) + "…" : node.name;
            ctx.fillText(label, pos.x, pos.y + NODE_R + 5);
        }

        ctx.restore();
    }

    // ─────────────────────────────────────────────
    //  Canvas hit-test
    // ─────────────────────────────────────────────
    function canvasHitTest(clientX, clientY) {
        if (!canvas) return null;
        const rect = canvas.getBoundingClientRect();
        const mx = clientX - rect.left;
        const my = clientY - rect.top;
        const wx = (mx - rect.width / 2 - camX) / camZoom;
        const wy = (my - rect.height / 2 - camY) / camZoom;

        const positions = layoutTree();
        const NODE_R = 22;

        for (const [id, pos] of Object.entries(positions)) {
            const dx = wx - pos.x, dy = wy - pos.y;
            if (dx * dx + dy * dy <= (NODE_R + 4) * (NODE_R + 4)) return id;
        }
        return null;
    }

    // ─────────────────────────────────────────────
    //  Brief side panel
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
        body.innerHTML = `
            <div style="margin-bottom:8px;font-size:11px;color:var(--tlg-silver-dim)">
                ${new Date(node.timestamp).toLocaleString()}
            </div>
            <div style="margin-bottom:8px;font-size:11px;color:var(--tlg-silver-dim)">
                Msg index: ${node.msgIdx} &nbsp;|&nbsp; 
                ${node.statData ? "MVU snapshot ✓" : "No MVU snapshot"}
            </div>
            <div class="tlg-brief-text" style="white-space:pre-wrap;word-break:break-word">${node.brief || "<em style='color:var(--tlg-silver-dim)'>No description.</em>"}</div>
            <div style="margin-top:12px">
                <label class="tlg-label">Edit brief</label>
                <textarea class="tlg-textarea" id="tlg-brief-edit" style="min-height:100px">${node.brief || ""}</textarea>
                <button class="tlg-btn tlg-btn-primary" id="tlg-brief-save" style="margin-top:6px;width:100%">Save Description</button>
            </div>
        `;

        body.querySelector("#tlg-brief-save").onclick = () => {
            node.brief = body.querySelector("#tlg-brief-edit").value;
            saveToMetadata();
            toast("Description saved.");
            refreshArchive();
        };

        const footer = panel.querySelector(".tlg-brief-footer");
        footer.innerHTML = `
            <button class="tlg-btn tlg-btn-jump" id="tlg-brief-jump">↩ Confirm Jump to This Node</button>
        `;
        footer.querySelector("#tlg-brief-jump").onclick = () => jumpToNode(nodeId);

        renderCanvas();
    }

    function closeBriefPanel() {
        const panel = document.getElementById("tlg-brief-panel");
        if (panel) panel.classList.remove("open");
        state.selectedNodeId = null;
        selectedNodeForBrief = null;
        renderCanvas();
    }

    // ─────────────────────────────────────────────
    //  Archive tab
    // ─────────────────────────────────────────────
    function refreshArchive() {
        const container = document.getElementById("tlg-archive-list");
        if (!container) return;

        if (state.nodes.length === 0) {
            container.innerHTML = `<div style="color:var(--tlg-silver-dim);padding:20px">No nodes yet.</div>`;
            return;
        }

        const sorted = [...state.nodes].sort((a, b) => b.timestamp - a.timestamp);
        container.innerHTML = sorted.map(node => {
            const isCurrent = node.id === state.currentNodeId;
            return `
                <div class="tlg-archive-card ${isCurrent ? "current" : ""}" data-nid="${node.id}">
                    <div class="tlg-archive-title">${escHtml(node.name)}${isCurrent ? " <span style='color:var(--tlg-silver-dim);font-size:11px'>(current)</span>" : ""}</div>
                    <div class="tlg-archive-meta">${new Date(node.timestamp).toLocaleString()} &nbsp;·&nbsp; Msg ${node.msgIdx}</div>
                    <div class="tlg-archive-brief">${escHtml(node.brief || "")}</div>
                    <div style="margin-top:10px;display:flex;gap:8px">
                        <button class="tlg-btn tlg-archive-view" data-nid="${node.id}">View in Tree</button>
                        <button class="tlg-btn tlg-btn-primary tlg-archive-jump" data-nid="${node.id}">↩ Jump Here</button>
                        <button class="tlg-btn tlg-btn-danger tlg-archive-del" data-nid="${node.id}" style="margin-left:auto">✕</button>
                    </div>
                </div>
            `;
        }).join("");

        container.querySelectorAll(".tlg-archive-view").forEach(btn => {
            btn.onclick = () => {
                const nid = btn.dataset.nid;
                switchTab("tree");
                openBriefPanel(nid);
            };
        });
        container.querySelectorAll(".tlg-archive-jump").forEach(btn => {
            btn.onclick = () => jumpToNode(btn.dataset.nid);
        });
        container.querySelectorAll(".tlg-archive-del").forEach(btn => {
            btn.onclick = () => {
                const nid = btn.dataset.nid;
                if (nid === state.currentNodeId) { toast("Cannot delete current node."); return; }
                if (!confirm(`Delete node "${findNode(nid)?.name}"?`)) return;
                deleteNode(nid);
            };
        });
    }

    function deleteNode(nodeId) {
        const node = findNode(nodeId);
        if (!node) return;
        const parent = findNode(node.parentId);
        if (parent) {
            parent.children = parent.children.filter(id => id !== nodeId);
        }
        // Recursively remove children
        function removeRecursive(id) {
            const n = findNode(id);
            if (!n) return;
            for (const cid of n.children) removeRecursive(cid);
            state.nodes = state.nodes.filter(x => x.id !== id);
        }
        removeRecursive(nodeId);
        saveToMetadata();
        renderCanvas();
        refreshArchive();
        toast("Node deleted.");
    }

    // ─────────────────────────────────────────────
    //  Summary tab
    // ─────────────────────────────────────────────
    function refreshSummary() {
        const list = document.getElementById("tlg-summary-list");
        if (!list) return;
        if (state.summaries.length === 0) {
            list.innerHTML = `<div style="color:var(--tlg-silver-dim)">No summaries yet.</div>`;
            return;
        }
        list.innerHTML = state.summaries.slice().reverse().map((s, i) => `
            <div class="tlg-section" style="margin-bottom:10px">
                <div style="font-size:11px;color:var(--tlg-silver-dim);margin-bottom:6px">${new Date(s.timestamp).toLocaleString()}</div>
                <div style="font-size:13px;white-space:pre-wrap">${escHtml(s.text)}</div>
                <button class="tlg-btn tlg-btn-danger" style="margin-top:8px;font-size:11px" data-idx="${state.summaries.length - 1 - i}">Delete</button>
            </div>
        `).join("");
        list.querySelectorAll("[data-idx]").forEach(btn => {
            btn.onclick = () => {
                state.summaries.splice(Number(btn.dataset.idx), 1);
                saveToMetadata();
                refreshSummary();
            };
        });
    }

    async function runSummary() {
        const apiUrl = (state.settings.apiUrl || "").trim();
        const apiKey = (state.settings.apiKey || "").trim();
        const model = (state.settings.model || "").trim();
        if (!apiUrl) { toast("Please set API URL in Engine tab."); return; }

        const st = getST();
        const recentChat = (st?.chat || []).slice(-20).map(m => `${m.name || m.role}: ${m.mes}`).join("\n");
        const prompt = state.settings.summaryPrompt.replace("{{context}}", recentChat);

        const btn = document.getElementById("tlg-summary-run");
        if (btn) btn.disabled = true;
        toast("Generating summary…");

        try {
            const endpoint = buildEndpoint(apiUrl, "/chat/completions");
            const res = await fetch(endpoint, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    ...(apiKey ? { "Authorization": `Bearer ${apiKey}` } : {}),
                },
                body: JSON.stringify({
                    model: model || undefined,
                    messages: [{ role: "user", content: prompt }],
                    max_tokens: 512,
                }),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            const text = data.choices?.[0]?.message?.content || "";
            state.summaries.push({ timestamp: Date.now(), text });
            saveToMetadata();
            refreshSummary();
            toast("Summary generated.");
        } catch (e) {
            toast("Summary failed: " + e.message);
            console.error("[TLG] Summary error:", e);
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    // ─────────────────────────────────────────────
    //  Engine tab — API helpers
    // ─────────────────────────────────────────────
    function buildEndpoint(base, path) {
        let url = base.trim();
        // Auto-append /v1 if missing api-style suffix
        if (!/\/v\d/.test(url) && !url.endsWith("/")) url += "/v1";
        else if (url.endsWith("/")) url = url.slice(0, -1);
        return url + path;
    }

    async function fetchModelList() {
        const apiUrl = (state.settings.apiUrl || "").trim();
        const apiKey = (state.settings.apiKey || "").trim();
        if (!apiUrl) { toast("Please set API URL first."); return; }

        const btn = document.getElementById("tlg-fetch-models");
        if (btn) btn.disabled = true;
        toast("Fetching models…");

        try {
            const endpoint = buildEndpoint(apiUrl, "/models");
            const res = await fetch(endpoint, {
                headers: apiKey ? { "Authorization": `Bearer ${apiKey}` } : {},
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            const models = (data.data || data.models || []).map(m => typeof m === "string" ? m : (m.id || m.name || ""));
            state.settings.modelList = models.filter(Boolean);
            saveToMetadata();
            populateModelSelect();
            toast(`Loaded ${models.length} model(s).`);
        } catch (e) {
            toast("Failed to fetch models: " + e.message);
            console.error("[TLG] fetchModelList:", e);
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    function populateModelSelect() {
        const sel = document.getElementById("tlg-model-select");
        if (!sel) return;
        const list = state.settings.modelList || [];
        sel.innerHTML = `<option value="">-- select model --</option>` +
            list.map(m => `<option value="${escHtml(m)}" ${m === state.settings.model ? "selected" : ""}>${escHtml(m)}</option>`).join("");
        if (state.settings.model && !list.includes(state.settings.model)) {
            sel.innerHTML += `<option value="${escHtml(state.settings.model)}" selected>${escHtml(state.settings.model)}</option>`;
        }
    }

    // ─────────────────────────────────────────────
    //  UI construction
    // ─────────────────────────────────────────────
    function buildUI() {
        const existing = document.getElementById("tlg-overlay");
        if (existing) existing.remove();

        const overlay = document.createElement("div");
        overlay.id = "tlg-overlay";
        overlay.innerHTML = `
            <!-- Tab bar -->
            <div class="tlg-tab-bar">
                <div class="tlg-tab active" data-tab="tree"><span class="tlg-tab-icon">🌿</span>Tree View</div>
                <div class="tlg-tab" data-tab="archive"><span class="tlg-tab-icon">📁</span>Archive</div>
                <div class="tlg-tab" data-tab="summary"><span class="tlg-tab-icon">📝</span>Summary Pool</div>
                <div class="tlg-tab" data-tab="engine"><span class="tlg-tab-icon">⚙️</span>Engine</div>
                <div class="tlg-close-btn" id="tlg-close">✕</div>
            </div>

            <!-- Tab content -->
            <div class="tlg-tab-content">

                <!-- TREE VIEW -->
                <div class="tlg-panel active" id="tlg-panel-tree">
                    <div id="tlg-canvas-wrap">
                        <canvas id="tlg-tree-canvas"></canvas>
                        <div id="tlg-canvas-toolbar">
                            <button class="tlg-btn" id="tlg-canvas-anchor">⚓ Anchor Here</button>
                            <button class="tlg-btn" id="tlg-canvas-reset-view">Reset View</button>
                        </div>
                    </div>
                    <div id="tlg-brief-panel">
                        <div class="tlg-brief-header">
                            <span>Node</span>
                            <button class="tlg-btn" id="tlg-brief-close" style="padding:2px 8px">✕</button>
                        </div>
                        <div class="tlg-brief-body"></div>
                        <div class="tlg-brief-footer"></div>
                    </div>
                </div>

                <!-- ARCHIVE -->
                <div class="tlg-panel" id="tlg-panel-archive">
                    <div class="tlg-archive-panel" style="width:100%">
                        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
                            <div style="font-size:15px;font-weight:600;color:var(--tlg-silver-bright)">All Nodes</div>
                            <button class="tlg-btn tlg-btn-primary" id="tlg-archive-new">⚓ New Anchor</button>
                        </div>
                        <div id="tlg-archive-list"></div>
                    </div>
                </div>

                <!-- SUMMARY -->
                <div class="tlg-panel" id="tlg-panel-summary">
                    <div class="tlg-summary-panel" style="width:100%">
                        <div class="tlg-section">
                            <div class="tlg-section-title">Auto Summary Mode</div>
                            <div class="tlg-row">
                                <span class="tlg-label" style="margin:0">Auto mode</span>
                                <div class="tlg-toggle ${state.settings.autoMode ? "on" : ""}" id="tlg-auto-toggle"></div>
                            </div>
                            <div class="tlg-row" style="margin-top:8px">
                                <label class="tlg-label" style="margin:0;flex:1">Remind every <input class="tlg-input" id="tlg-auto-interval" type="number" min="1" max="100" value="${state.settings.autoInterval}" style="width:60px;display:inline-block;padding:4px 8px;margin:0 6px"> turns</label>
                            </div>
                            <div class="tlg-row" style="margin-top:8px">
                                <label class="tlg-label" style="margin:0;flex:1">Show last <input class="tlg-input" id="tlg-last-n" type="number" min="1" max="100" value="${state.settings.lastNMessages}" style="width:60px;display:inline-block;padding:4px 8px;margin:0 6px"> messages after jump</label>
                            </div>
                        </div>
                        <div class="tlg-section">
                            <div class="tlg-section-title">Summary Prompt</div>
                            <label class="tlg-label">Prompt template (use {{context}} for chat history)</label>
                            <textarea class="tlg-textarea" id="tlg-summary-prompt" style="min-height:120px">${escHtml(state.settings.summaryPrompt)}</textarea>
                            <button class="tlg-btn tlg-btn-primary" id="tlg-summary-run" style="margin-top:10px">▶ Generate Summary Now</button>
                        </div>
                        <div class="tlg-section">
                            <div class="tlg-section-title">Summary History</div>
                            <div id="tlg-summary-list"></div>
                        </div>
                    </div>
                </div>

                <!-- ENGINE -->
                <div class="tlg-panel" id="tlg-panel-engine">
                    <div class="tlg-engine-panel" style="width:100%">
                        <div class="tlg-section">
                            <div class="tlg-section-title">API Configuration</div>
                            <label class="tlg-label">API Base URL</label>
                            <div class="tlg-row">
                                <input class="tlg-input" id="tlg-api-url" placeholder="https://api.openai.com" value="${escHtml(state.settings.apiUrl)}" />
                                <button class="tlg-btn" id="tlg-test-api">Test</button>
                            </div>
                            <label class="tlg-label">API Key</label>
                            <input class="tlg-input" id="tlg-api-key" type="password" placeholder="sk-…" value="${escHtml(state.settings.apiKey)}" style="margin-bottom:12px" />
                            <label class="tlg-label">Model</label>
                            <div class="tlg-row">
                                <select class="tlg-select" id="tlg-model-select" style="flex:1"></select>
                                <button class="tlg-btn" id="tlg-fetch-models">Fetch List</button>
                            </div>
                            <label class="tlg-label" style="margin-top:4px">Or type model name manually</label>
                            <input class="tlg-input" id="tlg-model-manual" placeholder="gpt-4o-mini" value="${escHtml(state.settings.model)}" style="margin-bottom:4px" />
                        </div>
                        <div class="tlg-section">
                            <div class="tlg-section-title">Vector API (optional)</div>
                            <label class="tlg-label">Vector API URL</label>
                            <input class="tlg-input" id="tlg-vec-url" placeholder="https://…" value="${escHtml(state.settings.vectorUrl)}" style="margin-bottom:8px" />
                            <label class="tlg-label">Vector API Key</label>
                            <input class="tlg-input" id="tlg-vec-key" type="password" value="${escHtml(state.settings.vectorKey)}" style="margin-bottom:8px" />
                            <label class="tlg-label">Retrieval Prompt Template</label>
                            <textarea class="tlg-textarea" id="tlg-vec-prompt" style="min-height:80px">${escHtml(state.settings.vectorPrompt)}</textarea>
                        </div>
                        <button class="tlg-btn tlg-btn-primary" id="tlg-engine-save" style="width:100%;margin-top:4px">Save Engine Settings</button>
                    </div>
                </div>

            </div><!-- /tab-content -->
        `;
        document.body.appendChild(overlay);

        // Extra CSS for canvas toolbar
        const toolbarStyle = document.createElement("style");
        toolbarStyle.textContent = `
            #tlg-canvas-wrap { position: relative; flex: 1; overflow: hidden; }
            #tlg-tree-canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
            #tlg-canvas-toolbar {
                position: absolute; top: 14px; left: 14px; display: flex; gap: 8px; z-index: 2;
            }
        `;
        document.head.appendChild(toolbarStyle);

        bindUIEvents(overlay);
    }

    // ─────────────────────────────────────────────
    //  Event bindings
    // ─────────────────────────────────────────────
    function bindUIEvents(overlay) {
        // Close
        document.getElementById("tlg-close").onclick = () => closeOverlay();

        // Tabs
        overlay.querySelectorAll(".tlg-tab").forEach(tab => {
            tab.onclick = () => switchTab(tab.dataset.tab);
        });

        // Brief panel close
        document.getElementById("tlg-brief-close").onclick = () => closeBriefPanel();

        // Canvas anchor button
        document.getElementById("tlg-canvas-anchor").onclick = () => showAnchorModal();

        // Reset view
        document.getElementById("tlg-canvas-reset-view").onclick = () => {
            camX = 0; camY = 0; camZoom = 1; renderCanvas();
        };

        // Archive new
        document.getElementById("tlg-archive-new").onclick = () => showAnchorModal();

        // Auto toggle
        document.getElementById("tlg-auto-toggle").onclick = function () {
            state.settings.autoMode = !state.settings.autoMode;
            this.classList.toggle("on", state.settings.autoMode);
            saveToMetadata();
        };

        // Auto interval
        document.getElementById("tlg-auto-interval").onchange = function () {
            state.settings.autoInterval = Math.max(1, parseInt(this.value) || 10);
            saveToMetadata();
        };

        // Last N
        document.getElementById("tlg-last-n").onchange = function () {
            state.settings.lastNMessages = Math.max(1, parseInt(this.value) || 5);
            saveToMetadata();
        };

        // Summary prompt
        document.getElementById("tlg-summary-prompt").onchange = function () {
            state.settings.summaryPrompt = this.value;
            saveToMetadata();
        };

        // Run summary
        document.getElementById("tlg-summary-run").onclick = () => runSummary();

        // Engine save
        document.getElementById("tlg-engine-save").onclick = () => {
            state.settings.apiUrl = document.getElementById("tlg-api-url").value.trim();
            state.settings.apiKey = document.getElementById("tlg-api-key").value.trim();
            state.settings.vectorUrl = document.getElementById("tlg-vec-url").value.trim();
            state.settings.vectorKey = document.getElementById("tlg-vec-key").value.trim();
            state.settings.vectorPrompt = document.getElementById("tlg-vec-prompt").value;
            // Model: prefer manual input
            const manual = document.getElementById("tlg-model-manual").value.trim();
            const sel = document.getElementById("tlg-model-select").value;
            state.settings.model = manual || sel;
            saveToMetadata();
            toast("Engine settings saved.");
        };

        // Fetch models
        document.getElementById("tlg-fetch-models").onclick = () => fetchModelList();

        // Model select sync to manual field
        document.getElementById("tlg-model-select").onchange = function () {
            if (this.value) document.getElementById("tlg-model-manual").value = this.value;
        };

        // Test API
        document.getElementById("tlg-test-api").onclick = async () => {
            const url = document.getElementById("tlg-api-url").value.trim();
            const key = document.getElementById("tlg-api-key").value.trim();
            if (!url) { toast("Enter URL first."); return; }
            toast("Testing…");
            try {
                const res = await fetch(buildEndpoint(url, "/models"), {
                    headers: key ? { Authorization: `Bearer ${key}` } : {},
                });
                if (res.ok) toast("✓ API reachable.");
                else toast(`✗ HTTP ${res.status}`);
            } catch (e) {
                toast("✗ " + e.message);
            }
        };

        // Canvas events
        initCanvasEvents();
    }

    // ─────────────────────────────────────────────
    //  Canvas interaction
    // ─────────────────────────────────────────────
    function initCanvasEvents() {
        const wrap = document.getElementById("tlg-canvas-wrap");
        if (!wrap) return;

        canvas = document.getElementById("tlg-tree-canvas");
        ctx = canvas.getContext("2d");

        // Resize observer
        const ro = new ResizeObserver(() => renderCanvas());
        ro.observe(wrap);

        // Mouse pan
        canvas.addEventListener("mousedown", e => {
            if (e.button !== 0) return;
            const hit = canvasHitTest(e.clientX, e.clientY);
            if (hit) {
                openBriefPanel(hit);
                return;
            }
            isPanning = true;
            panStartX = e.clientX - camX;
            panStartY = e.clientY - camY;
            canvas.style.cursor = "grabbing";
        });

        canvas.addEventListener("mousemove", e => {
            if (!isPanning) return;
            camX = e.clientX - panStartX;
            camY = e.clientY - panStartY;
            renderCanvas();
        });

        canvas.addEventListener("mouseup", () => {
            isPanning = false;
            canvas.style.cursor = "grab";
        });

        canvas.addEventListener("mouseleave", () => {
            isPanning = false;
            canvas.style.cursor = "grab";
        });

        // Zoom
        canvas.addEventListener("wheel", e => {
            e.preventDefault();
            const factor = e.deltaY < 0 ? 1.1 : 0.91;
            camZoom = Math.max(0.2, Math.min(4, camZoom * factor));
            renderCanvas();
        }, { passive: false });

        // Touch pan/zoom
        let lastTouchDist = 0;
        canvas.addEventListener("touchstart", e => {
            if (e.touches.length === 1) {
                isPanning = true;
                panStartX = e.touches[0].clientX - camX;
                panStartY = e.touches[0].clientY - camY;
            } else if (e.touches.length === 2) {
                isPanning = false;
                lastTouchDist = Math.hypot(
                    e.touches[0].clientX - e.touches[1].clientX,
                    e.touches[0].clientY - e.touches[1].clientY
                );
            }
        }, { passive: true });

        canvas.addEventListener("touchmove", e => {
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
                    const factor = dist / lastTouchDist;
                    camZoom = Math.max(0.2, Math.min(4, camZoom * factor));
                    renderCanvas();
                }
                lastTouchDist = dist;
            }
        }, { passive: true });

        canvas.addEventListener("touchend", () => { isPanning = false; }, { passive: true });
    }

    // ─────────────────────────────────────────────
    //  Tab switching
    // ─────────────────────────────────────────────
    function switchTab(name) {
        document.querySelectorAll(".tlg-tab").forEach(t => t.classList.toggle("active", t.dataset.tab === name));
        document.querySelectorAll(".tlg-panel").forEach(p => p.classList.remove("active"));
        const panel = document.getElementById(`tlg-panel-${name}`);
        if (panel) panel.classList.add("active");

        if (name === "tree") {
            setTimeout(() => renderCanvas(), 50);
        } else if (name === "archive") {
            refreshArchive();
        } else if (name === "summary") {
            refreshSummary();
        } else if (name === "engine") {
            populateModelSelect();
        }
    }

    // ─────────────────────────────────────────────
    //  Open / Close overlay
    // ─────────────────────────────────────────────
    function openOverlay() {
        loadFromMetadata();
        buildUI();
        const overlay = document.getElementById("tlg-overlay");
        overlay.classList.add("tlg-active");
        setTimeout(() => renderCanvas(), 80);
    }

    function closeOverlay() {
        const overlay = document.getElementById("tlg-overlay");
        if (overlay) overlay.classList.remove("tlg-active");
    }

    // ─────────────────────────────────────────────
    //  Slash command: /tlg_anchor
    // ─────────────────────────────────────────────
    function registerSlashCommand() {
        // Try SillyTavern slash command API
        const st = getST();
        if (st?.registerSlashCommand) {
            st.registerSlashCommand("tlg_anchor", (args, value) => {
                loadFromMetadata();
                showAnchorModal(value || "");
                return "";
            }, [], "Create a Riparian Gaze anchor point", true, true);
        }

        // Fallback: intercept via event
        if (window.SillyTavern?.SlashCommandParser) {
            try {
                window.SillyTavern.SlashCommandParser.addCommandObject(
                    window.SillyTavern.SlashCommand.fromProps({
                        name: "tlg_anchor",
                        callback: (args, value) => {
                            loadFromMetadata();
                            showAnchorModal(String(value || ""));
                            return "";
                        },
                        helpString: "Create a Riparian Gaze causal anchor point.",
                    })
                );
            } catch (e) {
                console.warn("[TLG] SlashCommandParser registration:", e);
            }
        }
    }

    // ─────────────────────────────────────────────
    //  Toolbar button injection (MutationObserver)
    // ─────────────────────────────────────────────
    function injectToolbarButton() {
        const BTN_ID = "tlg-open-btn";
        if (document.getElementById(BTN_ID)) return;

        // Try extensions menu (magic wand area)
        const targets = [
            "#extensionsMenu",
            "#extensionMenuItems",
            "#extension_menu",
            ".extension_menu",
            "#top-bar",
        ];

        for (const sel of targets) {
            const el = document.querySelector(sel);
            if (el) {
                const btn = document.createElement("div");
                btn.id = BTN_ID;
                btn.title = "The Riparian Gaze";
                btn.style.cssText = `
                    cursor:pointer; padding:4px 8px; font-size:13px;
                    color:#c0c0c8; display:flex; align-items:center; gap:6px;
                    white-space:nowrap;
                `;
                btn.innerHTML = `<span style="font-size:16px">🌊</span> Riparian Gaze`;
                btn.onclick = () => {
                    const overlay = document.getElementById("tlg-overlay");
                    if (overlay && overlay.classList.contains("tlg-active")) {
                        closeOverlay();
                    } else {
                        openOverlay();
                    }
                };
                el.appendChild(btn);
                return;
            }
        }
    }

    // ─────────────────────────────────────────────
    //  Chat-change listener — reload per chat
    // ─────────────────────────────────────────────
    function watchChatChange() {
        let lastChatId = null;

        setInterval(() => {
            const st = getST();
            const chatId = st?.chatId || st?.getCurrentChatId?.();
            if (chatId && chatId !== lastChatId) {
                lastChatId = chatId;
                loadFromMetadata();
                const overlay = document.getElementById("tlg-overlay");
                if (overlay?.classList.contains("tlg-active")) {
                    renderCanvas();
                    refreshArchive();
                }
            }

            // Auto-mode turn counter
            if (state.settings.autoMode) {
                const chat = st?.chat;
                if (chat) {
                    const n = chat.length;
                    if (n > (state._lastChatLen || 0)) {
                        state.turnsSinceAnchor += n - (state._lastChatLen || 0);
                        state._lastChatLen = n;
                        if (state.turnsSinceAnchor >= state.settings.autoInterval) {
                            toast(`⚓ Time to anchor! (${state.turnsSinceAnchor} turns since last anchor)`);
                            state.turnsSinceAnchor = 0;
                        }
                    }
                }
            }
        }, 2000);
    }

    // ─────────────────────────────────────────────
    //  Utility
    // ─────────────────────────────────────────────
    function escHtml(str) {
        return String(str || "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    // ─────────────────────────────────────────────
    //  Boot
    // ─────────────────────────────────────────────
    function boot() {
        // Inject button when DOM is ready
        injectToolbarButton();

        // MutationObserver for dynamic menus
        const observer = new MutationObserver(() => {
            injectToolbarButton();
        });
        observer.observe(document.body, { childList: true, subtree: true });

        // Register slash command
        registerSlashCommand();

        // Watch for chat changes & auto-mode
        watchChatChange();

        console.log("[TLG] The Riparian Gaze loaded.");
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", boot);
    } else {
        boot();
    }

})();
