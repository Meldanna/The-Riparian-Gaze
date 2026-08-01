/**
 * 河岸凝视 v2.3
 * 外壳完全沿用已验证的 max 框架
 */
(function () {
    console.log('[TLG] 河岸凝视启动');

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
            vectorPrompt: "根据以下上下文：\n{{context}}\n\n请简洁总结关键事件。",
            summaryPrompt: "请简洁总结近期对话中的关键事件。"
        },
        summaries: [],
        turnsSinceAnchor: 0,
        _lastChatLen: 0
    };

    var tlgCanvas = null, tlgCtx = null;
    var camX = 0, camY = 0, camZoom = 1;
    var isPanning = false, panStartX = 0, panStartY = 0;

    // ── 基础工具 ──
    function getCtx() {
        return window.SillyTavern.getContext();
    }

    function generateId() {
        return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    }

    function toast(msg) {
        var el = document.createElement('div');
        el.textContent = msg;
        el.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:30px;background:#0a0a10;border:1px solid #1a1a28;border-radius:8px;padding:12px 18px;color:#c0c0c8;font-size:13px;z-index:2147483647;text-align:center;max-width:80vw;';
        document.body.appendChild(el);
        setTimeout(function () { el.remove(); }, 2800);
    }

    function escHtml(str) {
        return String(str || '')
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // ── 元数据 ──
    function saveState() {
        var ctx = getCtx();
        if (!ctx.chat_metadata) ctx.chat_metadata = {};
        ctx.chat_metadata[METADATA_KEY] = JSON.parse(JSON.stringify(state));
        ctx.saveMetadata();
    }

    function loadState() {
        var ctx = getCtx();
        var saved = ctx.chat_metadata && ctx.chat_metadata[METADATA_KEY];
        if (saved) {
            state = JSON.parse(JSON.stringify(saved));
            if (!state.settings) state.settings = {};
            if (!state._lastChatLen) state._lastChatLen = 0;
        } else {
            resetState();
            saveState();
        }
    }

    function resetState() {
        var rootId = generateId();
        state.nodes = [{
            id: rootId, name: '起源点', brief: '时间线起源。',
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
        for (var i = 0; i < state.nodes.length; i++) {
            if (state.nodes[i].id === id) return state.nodes[i];
        }
        return null;
    }

    function getPathToRoot(nodeId) {
        var path = [];
        var cur = findNode(nodeId);
        while (cur) { path.unshift(cur.id); cur = findNode(cur.parentId); }
        return path;
    }

    // ── MVU ──
    function getMVU() {
        try {
            var ctx = getCtx();
            if (ctx.chat_metadata && ctx.chat_metadata.stat_data != null)
                return JSON.parse(JSON.stringify(ctx.chat_metadata.stat_data));
            if (typeof window.getAllVariables === 'function') {
                var all = window.getAllVariables();
                if (all && all.stat_data != null) return JSON.parse(JSON.stringify(all.stat_data));
            }
        } catch (e) {}
        return null;
    }

    function setMVU(data) {
        if (!data) return;
        try {
            var ctx = getCtx();
            if (ctx.chat_metadata) { ctx.chat_metadata.stat_data = JSON.parse(JSON.stringify(data)); ctx.saveMetadata(); }
            if (typeof window.setVariable === 'function') window.setVariable('stat_data', data);
        } catch (e) {}
    }

    function applyVisibility(targetNodeId) {
        var ctx = getCtx();
        if (!ctx.chat) return;
        var pathIds = getPathToRoot(targetNodeId);
        var visible = {};
        var i, m, node, next;
        for (i = 0; i < pathIds.length; i++) {
            node = findNode(pathIds[i]);
            next = i + 1 < pathIds.length ? findNode(pathIds[i + 1]) : null;
            if (!node) continue;
            var start = node.msgIdx;
            var end = next ? next.msgIdx - 1 : node.msgIdx;
            for (m = start; m <= end; m++) visible[m] = true;
        }
        var target = findNode(targetNodeId);
        var lastN = (state.settings && state.settings.lastNMessages) || 5;
        var endIdx = target ? target.msgIdx : ctx.chat.length - 1;
        for (m = Math.max(0, endIdx - lastN + 1); m <= endIdx; m++) visible[m] = true;
        for (i = 0; i < ctx.chat.length; i++) {
            if (visible[i]) delete ctx.chat[i].is_hidden;
            else ctx.chat[i].is_hidden = true;
        }
        if (typeof ctx.saveChat === 'function') ctx.saveChat();
    }

    // ── 锚定 / 跳转 ──
    function createAnchor(name, brief) {
        var ctx = getCtx();
        var msgIdx = ctx.chat ? Math.max(0, ctx.chat.length - 1) : 0;
        var newId = generateId();
        var parentId = state.currentNodeId;
        var node = {
            id: newId,
            name: name || ('节点 ' + state.nodes.length),
            brief: brief || '',
            parentId: parentId,
            msgIdx: msgIdx,
            statData: getMVU(),
            timestamp: Date.now(),
            children: []
        };
        var parent = findNode(parentId);
        if (parent) parent.children.push(newId);
        state.nodes.push(node);
        state.currentNodeId = newId;
        state.turnsSinceAnchor = 0;
        saveState();
        toast('⚓ 已锚定: ' + node.name);
        renderCanvas();
        refreshArchive();
    }

    function jumpToNode(nodeId) {
        var node = findNode(nodeId);
        if (!node) { toast('节点不存在'); return; }
        if (node.statData) setMVU(node.statData);
        applyVisibility(nodeId);
        state.currentNodeId = nodeId;
        state.turnsSinceAnchor = 0;
        saveState();
        toast('↩ 已跳转至: ' + node.name);
        renderCanvas();
        refreshArchive();
        closeBriefPanel();
    }

    // ── 锚定弹窗（完全内联样式，不依赖CSS文件）──
    function showAnchorModal(prefill) {
        var old = document.getElementById('tlg-modal');
        if (old) old.remove();

        var wrap = document.createElement('div');
        wrap.id = 'tlg-modal';
        wrap.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.82);z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;';

        var box = document.createElement('div');
        box.style.cssText = 'background:#0a0a10;border:1px solid #2a2a3a;border-radius:10px;padding:20px;width:100%;max-width:420px;color:#c0c0c8;box-sizing:border-box;';
        box.innerHTML =
            '<div style="font-size:16px;font-weight:600;color:#e8e8f0;margin-bottom:14px;">⚓ 创建锚定点</div>' +
            '<div style="margin-bottom:12px;">' +
            '<div style="font-size:12px;color:#6a6a78;margin-bottom:6px;">节点名称</div>' +
            '<input id="tlg-anc-name" value="' + escHtml(prefill || '') + '" placeholder="例：决斗之前…" style="width:100%;padding:10px 12px;background:#0e0e18;border:1px solid #1a1a28;border-radius:4px;color:#c0c0c8;font-size:16px;box-sizing:border-box;">' +
            '</div>' +
            '<div style="margin-bottom:16px;">' +
            '<div style="font-size:12px;color:#6a6a78;margin-bottom:6px;">简要描述</div>' +
            '<textarea id="tlg-anc-brief" placeholder="此时此刻的情况概述…" style="width:100%;padding:10px 12px;background:#0e0e18;border:1px solid #1a1a28;border-radius:4px;color:#c0c0c8;font-size:14px;min-height:90px;box-sizing:border-box;resize:vertical;"></textarea>' +
            '</div>' +
            '<div style="display:flex;justify-content:flex-end;gap:10px;">' +
            '<button id="tlg-anc-cancel" style="padding:8px 16px;background:#0e0e18;border:1px solid #1a1a28;border-radius:4px;color:#c0c0c8;font-size:13px;cursor:pointer;">取消</button>' +
            '<button id="tlg-anc-ok" style="padding:8px 16px;background:rgba(192,192,200,0.12);border:1px solid #6a6a78;border-radius:4px;color:#e8e8f0;font-size:13px;cursor:pointer;">⚓ 确认锚定</button>' +
            '</div>';

        wrap.appendChild(box);
        document.body.appendChild(wrap);

        wrap.addEventListener('click', function (e) { if (e.target === wrap) wrap.remove(); });
        document.getElementById('tlg-anc-cancel').onclick = function () { wrap.remove(); };
        document.getElementById('tlg-anc-ok').onclick = function () {
            var name = document.getElementById('tlg-anc-name').value.trim() || ('节点 ' + state.nodes.length);
            var brief = document.getElementById('tlg-anc-brief').value.trim();
            createAnchor(name, brief);
            wrap.remove();
        };
        setTimeout(function () { document.getElementById('tlg-anc-name').focus(); }, 80);
    }

    // ── 画布 ──
    function layoutTree() {
        var pos = {}, H = 180, V = 120;
        function w(id) {
            var n = findNode(id);
            if (!n || !n.children.length) return 1;
            return n.children.reduce(function (s, c) { return s + w(c); }, 0);
        }
        function assign(id, depth, slot) {
            var n = findNode(id); if (!n) return;
            var nw = w(id);
            pos[id] = { x: (slot + nw / 2) * H, y: depth * V + 60 };
            var cs = slot;
            for (var i = 0; i < n.children.length; i++) {
                var cw = w(n.children[i]);
                assign(n.children[i], depth + 1, cs);
                cs += cw;
            }
        }
        var root = null;
        for (var i = 0; i < state.nodes.length; i++) {
            if (!state.nodes[i].parentId) { root = state.nodes[i]; break; }
        }
        if (root) assign(root.id, 0, 0);
        return pos;
    }

    function renderCanvas() {
        if (!tlgCanvas || !tlgCtx) return;
        var dpr = window.devicePixelRatio || 1;
        var rect = tlgCanvas.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        tlgCanvas.width = rect.width * dpr;
        tlgCanvas.height = rect.height * dpr;
        tlgCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
        tlgCtx.fillStyle = '#050508';
        tlgCtx.fillRect(0, 0, rect.width, rect.height);
        tlgCtx.save();
        tlgCtx.translate(rect.width / 2 + camX, rect.height / 2 + camY);
        tlgCtx.scale(camZoom, camZoom);

        var pos = layoutTree();
        var R = 22;
        var path = getPathToRoot(state.currentNodeId);
        var i, n, f, t, cy, grd;

        for (i = 0; i < state.nodes.length; i++) {
            n = state.nodes[i];
            if (!n.parentId) continue;
            f = pos[n.parentId]; t = pos[n.id];
            if (!f || !t) continue;
            var active = path.indexOf(n.id) !== -1 && path.indexOf(n.parentId) !== -1;
            cy = (f.y + t.y) / 2;
            tlgCtx.beginPath();
            tlgCtx.moveTo(f.x, f.y + R);
            tlgCtx.bezierCurveTo(f.x, cy, t.x, cy, t.x, t.y - R);
            tlgCtx.strokeStyle = active ? 'rgba(220,220,230,0.85)' : 'rgba(192,192,210,0.18)';
            tlgCtx.lineWidth = active ? 1.8 : 1;
            tlgCtx.shadowBlur = active ? 8 : 0;
            tlgCtx.shadowColor = 'rgba(192,192,210,0.5)';
            tlgCtx.stroke();
            tlgCtx.shadowBlur = 0;
        }

        for (i = 0; i < state.nodes.length; i++) {
            n = state.nodes[i];
            var p = pos[n.id]; if (!p) continue;
            var isCur = n.id === state.currentNodeId;
            var isSel = n.id === state.selectedNodeId;
            var onPath = path.indexOf(n.id) !== -1;

            if (isCur) {
                tlgCtx.beginPath();
                tlgCtx.arc(p.x, p.y, R + 12, 0, Math.PI * 2);
                grd = tlgCtx.createRadialGradient(p.x, p.y, R, p.x, p.y, R + 14);
                grd.addColorStop(0, 'rgba(255,255,255,0.25)');
                grd.addColorStop(1, 'rgba(255,255,255,0)');
                tlgCtx.fillStyle = grd;
                tlgCtx.fill();
            }
            tlgCtx.beginPath();
            tlgCtx.arc(p.x, p.y, R, 0, Math.PI * 2);
            if (isCur) {
                tlgCtx.fillStyle = 'rgba(255,255,255,0.15)';
                tlgCtx.strokeStyle = '#fff';
                tlgCtx.lineWidth = 2;
                tlgCtx.shadowColor = 'rgba(255,255,255,0.8)';
                tlgCtx.shadowBlur = 18;
            } else if (isSel) {
                tlgCtx.fillStyle = 'rgba(192,192,210,0.12)';
                tlgCtx.strokeStyle = '#c0c0d0';
                tlgCtx.lineWidth = 2;
                tlgCtx.shadowBlur = 10;
            } else if (onPath) {
                tlgCtx.fillStyle = 'rgba(192,192,210,0.07)';
                tlgCtx.strokeStyle = 'rgba(192,192,210,0.55)';
                tlgCtx.lineWidth = 1.2;
                tlgCtx.shadowBlur = 0;
            } else {
                tlgCtx.fillStyle = 'rgba(192,192,210,0.04)';
                tlgCtx.strokeStyle = 'rgba(192,192,210,0.2)';
                tlgCtx.lineWidth = 1;
                tlgCtx.shadowBlur = 0;
            }
            tlgCtx.fill(); tlgCtx.stroke(); tlgCtx.shadowBlur = 0;

            tlgCtx.fillStyle = isCur ? '#fff' : onPath ? 'rgba(220,220,230,0.85)' : 'rgba(180,180,195,0.55)';
            tlgCtx.font = (isCur ? 'bold ' : '') + '10px sans-serif';
            tlgCtx.textAlign = 'center';
            tlgCtx.textBaseline = 'top';
            var label = n.name.length > 12 ? n.name.slice(0, 11) + '…' : n.name;
            tlgCtx.fillText(label, p.x, p.y + R + 5);
        }
        tlgCtx.restore();
    }

    function hitTest(clientX, clientY) {
        if (!tlgCanvas) return null;
        var rect = tlgCanvas.getBoundingClientRect();
        var wx = (clientX - rect.left - rect.width / 2 - camX) / camZoom;
        var wy = (clientY - rect.top - rect.height / 2 - camY) / camZoom;
        var pos = layoutTree(), R = 22;
        var ids = Object.keys(pos);
        for (var i = 0; i < ids.length; i++) {
            var p = pos[ids[i]];
            var dx = wx - p.x, dy = wy - p.y;
            if (dx * dx + dy * dy <= (R + 4) * (R + 4)) return ids[i];
        }
        return null;
    }

    // ── 简介面板（内联样式）──
    function openBriefPanel(nodeId) {
        var node = findNode(nodeId);
        if (!node) return;
        state.selectedNodeId = nodeId;

        var panel = document.getElementById('tlg-brief-panel');
        if (!panel) return;
        panel.style.display = 'flex';

        document.getElementById('tlg-brief-title').textContent = node.name;

        var body = document.getElementById('tlg-brief-body');
        body.innerHTML =
            '<div style="margin-bottom:8px;font-size:11px;color:#6a6a78">' + new Date(node.timestamp).toLocaleString() + '</div>' +
            '<div style="margin-bottom:8px;font-size:11px;color:#6a6a78">消息索引: ' + node.msgIdx + ' | ' + (node.statData ? 'MVU快照 ✓' : '无MVU快照') + '</div>' +
            '<div style="white-space:pre-wrap;word-break:break-word;margin-bottom:12px">' + (node.brief ? escHtml(node.brief) : '<em style="color:#6a6a78">暂无描述。</em>') + '</div>' +
            '<div style="font-size:12px;color:#6a6a78;margin-bottom:6px;">编辑描述</div>' +
            '<textarea id="tlg-brief-edit" style="width:100%;padding:10px;background:#0e0e18;border:1px solid #1a1a28;border-radius:4px;color:#c0c0c8;font-size:14px;min-height:100px;box-sizing:border-box;resize:vertical;">' + escHtml(node.brief || '') + '</textarea>' +
            '<button id="tlg-brief-save" style="margin-top:8px;width:100%;padding:10px;background:rgba(192,192,200,0.12);border:1px solid #6a6a78;border-radius:4px;color:#e8e8f0;font-size:13px;cursor:pointer;">保存描述</button>';

        document.getElementById('tlg-brief-save').onclick = function () {
            node.brief = document.getElementById('tlg-brief-edit').value;
            saveState();
            toast('描述已保存。');
            refreshArchive();
        };

        var footer = document.getElementById('tlg-brief-footer');
        footer.innerHTML = '<button id="tlg-brief-jump" style="width:100%;padding:12px;background:rgba(192,192,200,0.1);border:1px solid #6a6a78;border-radius:4px;color:#e8e8f0;font-size:13px;cursor:pointer;">↩ 确认跳转至此节点</button>';
        document.getElementById('tlg-brief-jump').onclick = function () { jumpToNode(nodeId); };

        renderCanvas();
    }

    function closeBriefPanel() {
        var panel = document.getElementById('tlg-brief-panel');
        if (panel) panel.style.display = 'none';
        state.selectedNodeId = null;
        renderCanvas();
    }

    // ── 档案库 ──
    function refreshArchive() {
        var container = document.getElementById('tlg-archive-list');
        if (!container) return;
        if (!state.nodes.length) {
            container.innerHTML = '<div style="color:#6a6a78;padding:20px">暂无节点。</div>';
            return;
        }
        var sorted = state.nodes.slice().sort(function (a, b) { return b.timestamp - a.timestamp; });
        container.innerHTML = sorted.map(function (node) {
            var isCur = node.id === state.currentNodeId;
            return '<div style="background:#0a0a10;border:1px solid ' + (isCur ? '#c0c0c8' : '#1a1a28') + ';border-radius:6px;padding:12px;margin-bottom:10px;">' +
                '<div style="font-size:14px;font-weight:600;color:#e8e8f0;">' + escHtml(node.name) + (isCur ? ' <span style="color:#6a6a78;font-size:11px">(当前)</span>' : '') + '</div>' +
                '<div style="font-size:11px;color:#6a6a78;margin-top:4px;">' + new Date(node.timestamp).toLocaleString() + ' · 消息 ' + node.msgIdx + '</div>' +
                '<div style="font-size:12px;margin-top:8px;">' + escHtml(node.brief || '') + '</div>' +
                '<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;">' +
                '<button style="padding:6px 12px;background:#0e0e18;border:1px solid #1a1a28;border-radius:4px;color:#c0c0c8;font-size:12px;cursor:pointer;" class="tlg-arc-view" data-nid="' + node.id + '">在树图中查看</button>' +
                '<button style="padding:6px 12px;background:rgba(192,192,200,0.12);border:1px solid #6a6a78;border-radius:4px;color:#e8e8f0;font-size:12px;cursor:pointer;" class="tlg-arc-jump" data-nid="' + node.id + '">↩ 跳转至此</button>' +
                '<button style="padding:6px 12px;border:1px solid #aa4444;border-radius:4px;color:#aa4444;font-size:12px;cursor:pointer;background:transparent;margin-left:auto;" class="tlg-arc-del" data-nid="' + node.id + '">✕</button>' +
                '</div></div>';
        }).join('');

        container.querySelectorAll('.tlg-arc-view').forEach(function (b) {
            b.onclick = function () { switchTab('tree'); openBriefPanel(b.dataset.nid); };
        });
        container.querySelectorAll('.tlg-arc-jump').forEach(function (b) {
            b.onclick = function () { jumpToNode(b.dataset.nid); };
        });
        container.querySelectorAll('.tlg-arc-del').forEach(function (b) {
            b.onclick = function () {
                if (b.dataset.nid === state.currentNodeId) { toast('无法删除当前节点'); return; }
                var n = findNode(b.dataset.nid);
                if (!confirm('确定删除「' + (n ? n.name : '') + '」？')) return;
                deleteNode(b.dataset.nid);
            };
        });
    }

    function deleteNode(nodeId) {
        var node = findNode(nodeId);
        if (!node) return;
        var parent = findNode(node.parentId);
        if (parent) parent.children = parent.children.filter(function (id) { return id !== nodeId; });
        function rm(id) {
            var n = findNode(id); if (!n) return;
            n.children.slice().forEach(rm);
            state.nodes = state.nodes.filter(function (x) { return x.id !== id; });
        }
        rm(nodeId);
        saveState(); renderCanvas(); refreshArchive();
        toast('节点已删除。');
    }

    // ── 总结 ──
    function refreshSummary() {
        var list = document.getElementById('tlg-summary-list');
        if (!list) return;
        if (!state.summaries || !state.summaries.length) {
            list.innerHTML = '<div style="color:#6a6a78">暂无总结记录。</div>';
            return;
        }
        list.innerHTML = state.summaries.slice().reverse().map(function (s, i) {
            var idx = state.summaries.length - 1 - i;
            return '<div style="background:#0a0a10;border:1px solid #1a1a28;border-radius:6px;padding:12px;margin-bottom:10px;">' +
                '<div style="font-size:11px;color:#6a6a78;margin-bottom:6px;">' + new Date(s.timestamp).toLocaleString() + '</div>' +
                '<div style="font-size:13px;white-space:pre-wrap;">' + escHtml(s.text) + '</div>' +
                '<button style="margin-top:8px;padding:4px 10px;border:1px solid #aa4444;color:#aa4444;background:transparent;border-radius:4px;font-size:11px;cursor:pointer;" data-idx="' + idx + '">删除</button></div>';
        }).join('');
        list.querySelectorAll('[data-idx]').forEach(function (b) {
            b.onclick = function () {
                state.summaries.splice(Number(b.dataset.idx), 1);
                saveState(); refreshSummary();
            };
        });
    }

    function buildEndpoint(base, path) {
        var url = (base || '').trim();
        if (!/\/v\d/.test(url)) url = url.replace(/\/?$/, '/v1');
        return url + path;
    }

    async function runSummary() {
        var apiUrl = (state.settings.apiUrl || '').trim();
        if (!apiUrl) { toast('请先设置 API 地址。'); return; }
        var ctx = getCtx();
        var chat = ((ctx && ctx.chat) || []).slice(-20).map(function (m) { return (m.name || m.role) + ': ' + m.mes; }).join('\n');
        var prompt = (state.settings.summaryPrompt || '').replace('{{context}}', chat);
        toast('正在生成总结…');
        try {
            var res = await fetch(buildEndpoint(apiUrl, '/chat/completions'), {
                method: 'POST',
                headers: Object.assign({ 'Content-Type': 'application/json' },
                    state.settings.apiKey ? { Authorization: 'Bearer ' + state.settings.apiKey } : {}),
                body: JSON.stringify({ model: state.settings.model || undefined, messages: [{ role: 'user', content: prompt }], max_tokens: 512 })
            });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            var data = await res.json();
            var text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '';
            state.summaries.push({ timestamp: Date.now(), text: text });
            saveState(); refreshSummary(); toast('总结已生成。');
        } catch (e) { toast('总结失败: ' + e.message); }
    }

    async function fetchModels() {
        var apiUrl = (state.settings.apiUrl || '').trim();
        if (!apiUrl) { toast('请先设置 API 地址。'); return; }
        toast('正在拉取模型列表…');
        try {
            var res = await fetch(buildEndpoint(apiUrl, '/models'), {
                headers: state.settings.apiKey ? { Authorization: 'Bearer ' + state.settings.apiKey } : {}
            });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            var data = await res.json();
            var models = (data.data || data.models || []).map(function (m) { return typeof m === 'string' ? m : (m.id || ''); }).filter(Boolean);
            state.settings.modelList = models;
            saveState();
            var sel = document.getElementById('tlg-model-select');
            if (sel) {
                sel.innerHTML = '<option value="">-- 选择模型 --</option>' +
                    models.map(function (m) { return '<option value="' + escHtml(m) + '"' + (m === state.settings.model ? ' selected' : '') + '>' + escHtml(m) + '</option>'; }).join('');
            }
            toast('已加载 ' + models.length + ' 个模型。');
        } catch (e) { toast('拉取失败: ' + e.message); }
    }

    // ── ★ 核心：完全照抄 max 框架的 openPanel ──
    function openPanel() {
        var exist = document.getElementById('tlg-panel');
        if (exist) { exist.style.display = 'flex'; return; }

        var panel = document.createElement('div');
        panel.id = 'tlg-panel';
        // ★ 全部内联 style，不依赖任何外部 CSS
        panel.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:#050508;color:#c0c0c8;z-index:2147483647;display:flex;flex-direction:column;font-family:-apple-system,"Segoe UI",sans-serif;overflow:hidden;box-sizing:border-box;';

        panel.innerHTML =
            '<div id="tlg-tabs" style="display:flex;height:48px;min-height:48px;border-bottom:1px solid #1a1a28;background:#0a0a10;flex-shrink:0;overflow-x:auto;">' +
            '<div class="tlg-tab" data-tab="tree" style="padding:0 14px;height:100%;display:flex;align-items:center;cursor:pointer;font-size:13px;color:#e8e8f0;border-bottom:2px solid #c0c0c8;background:#18182a;white-space:nowrap;flex-shrink:0;">因果树</div>' +
            '<div class="tlg-tab" data-tab="archive" style="padding:0 14px;height:100%;display:flex;align-items:center;cursor:pointer;font-size:13px;color:#6a6a78;border-bottom:2px solid transparent;white-space:nowrap;flex-shrink:0;">档案库</div>' +
            '<div class="tlg-tab" data-tab="summary" style="padding:0 14px;height:100%;display:flex;align-items:center;cursor:pointer;font-size:13px;color:#6a6a78;border-bottom:2px solid transparent;white-space:nowrap;flex-shrink:0;">总结池</div>' +
            '<div class="tlg-tab" data-tab="engine" style="padding:0 14px;height:100%;display:flex;align-items:center;cursor:pointer;font-size:13px;color:#6a6a78;border-bottom:2px solid transparent;white-space:nowrap;flex-shrink:0;">引擎设置</div>' +
            '<div id="tlg-close" style="margin-left:auto;padding:0 16px;display:flex;align-items:center;cursor:pointer;color:#6a6a78;font-size:20px;flex-shrink:0;">✕</div>' +
            '</div>' +
            '<div id="tlg-body" style="flex:1;min-height:0;overflow:hidden;position:relative;">' +

            // 因果树
            '<div class="tlg-view" data-view="tree" style="display:flex;position:absolute;inset:0;">' +
            '<div id="tlg-canvas-wrap" style="flex:1;position:relative;overflow:hidden;">' +
            '<canvas id="tlg-tree-canvas" style="position:absolute;inset:0;width:100%;height:100%;touch-action:none;"></canvas>' +
            '<div style="position:absolute;top:10px;left:10px;display:flex;gap:8px;flex-wrap:wrap;z-index:2;">' +
            '<button id="tlg-btn-anchor" style="padding:8px 12px;background:#0e0e18;border:1px solid #1a1a28;border-radius:4px;color:#c0c0c8;font-size:12px;cursor:pointer;">⚓ 在此锚定</button>' +
            '<button id="tlg-btn-reset" style="padding:8px 12px;background:#0e0e18;border:1px solid #1a1a28;border-radius:4px;color:#c0c0c8;font-size:12px;cursor:pointer;">重置视图</button>' +
            '</div></div>' +
            '<div id="tlg-brief-panel" style="display:none;width:100%;flex-direction:column;background:#0a0a10;border-top:1px solid #1a1a28;">' +
            '<div style="padding:12px 14px;border-bottom:1px solid #1a1a28;display:flex;justify-content:space-between;align-items:center;flex-shrink:0;">' +
            '<span id="tlg-brief-title" style="font-size:13px;font-weight:600;color:#e8e8f0;">节点</span>' +
            '<button id="tlg-brief-close" style="padding:2px 8px;background:#0e0e18;border:1px solid #1a1a28;border-radius:4px;color:#c0c0c8;font-size:12px;cursor:pointer;">✕</button>' +
            '</div>' +
            '<div id="tlg-brief-body" style="flex:1;overflow-y:auto;padding:12px 14px;font-size:13px;line-height:1.65;-webkit-overflow-scrolling:touch;"></div>' +
            '<div id="tlg-brief-footer" style="padding:10px 14px;border-top:1px solid #1a1a28;flex-shrink:0;"></div>' +
            '</div></div>' +

            // 档案库
            '<div class="tlg-view" data-view="archive" style="display:none;position:absolute;inset:0;flex-direction:column;overflow-y:auto;padding:12px;-webkit-overflow-scrolling:touch;">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">' +
            '<div style="font-size:15px;font-weight:600;color:#e8e8f0;">全部节点</div>' +
            '<button id="tlg-archive-new" style="padding:8px 14px;background:rgba(192,192,200,0.12);border:1px solid #6a6a78;border-radius:4px;color:#e8e8f0;font-size:12px;cursor:pointer;">⚓ 新建锚定</button>' +
            '</div><div id="tlg-archive-list"></div></div>' +

            // 总结池
            '<div class="tlg-view" data-view="summary" style="display:none;position:absolute;inset:0;flex-direction:column;overflow-y:auto;padding:12px;-webkit-overflow-scrolling:touch;">' +
            '<div style="background:#0a0a10;border:1px solid #1a1a28;border-radius:6px;padding:12px;margin-bottom:12px;">' +
            '<div style="font-size:13px;font-weight:600;color:#e8e8f0;margin-bottom:10px;">自动总结模式</div>' +
            '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;"><span style="font-size:13px;">自动模式</span>' +
            '<div id="tlg-auto-toggle" style="position:relative;width:40px;height:22px;background:#1a1a28;border-radius:11px;cursor:pointer;flex-shrink:0;"></div></div>' +
            '<div style="margin-bottom:8px;font-size:13px;">每 <input id="tlg-auto-interval" type="number" min="1" value="10" style="width:60px;padding:4px 8px;background:#0e0e18;border:1px solid #1a1a28;border-radius:4px;color:#c0c0c8;font-size:14px;"> 轮提醒</div>' +
            '<div style="font-size:13px;">跳转后显示最后 <input id="tlg-last-n" type="number" min="1" value="5" style="width:60px;padding:4px 8px;background:#0e0e18;border:1px solid #1a1a28;border-radius:4px;color:#c0c0c8;font-size:14px;"> 条消息</div>' +
            '</div>' +
            '<div style="background:#0a0a10;border:1px solid #1a1a28;border-radius:6px;padding:12px;margin-bottom:12px;">' +
            '<div style="font-size:13px;font-weight:600;color:#e8e8f0;margin-bottom:10px;">总结提示词</div>' +
            '<textarea id="tlg-summary-prompt" style="width:100%;padding:10px;background:#0e0e18;border:1px solid #1a1a28;border-radius:4px;color:#c0c0c8;font-size:14px;min-height:120px;box-sizing:border-box;resize:vertical;"></textarea>' +
            '<button id="tlg-summary-run" style="margin-top:10px;width:100%;padding:10px;background:rgba(192,192,200,0.12);border:1px solid #6a6a78;border-radius:4px;color:#e8e8f0;font-size:13px;cursor:pointer;">▶ 立即生成总结</button>' +
            '</div>' +
            '<div style="background:#0a0a10;border:1px solid #1a1a28;border-radius:6px;padding:12px;">' +
            '<div style="font-size:13px;font-weight:600;color:#e8e8f0;margin-bottom:10px;">总结历史</div>' +
            '<div id="tlg-summary-list"></div></div></div>' +

            // 引擎设置
            '<div class="tlg-view" data-view="engine" style="display:none;position:absolute;inset:0;flex-direction:column;overflow-y:auto;padding:12px;-webkit-overflow-scrolling:touch;">' +
            '<div style="background:#0a0a10;border:1px solid #1a1a28;border-radius:6px;padding:12px;margin-bottom:12px;">' +
            '<div style="font-size:13px;font-weight:600;color:#e8e8f0;margin-bottom:10px;">API 配置</div>' +
            '<div style="font-size:12px;color:#6a6a78;margin-bottom:6px;">API 基础地址</div>' +
            '<div style="display:flex;gap:8px;margin-bottom:12px;">' +
            '<input id="tlg-api-url" style="flex:1;padding:10px 12px;background:#0e0e18;border:1px solid #1a1a28;border-radius:4px;color:#c0c0c8;font-size:16px;min-width:0;" />' +
            '<button id="tlg-test-api" style="padding:8px 12px;background:#0e0e18;border:1px solid #1a1a28;border-radius:4px;color:#c0c0c8;font-size:12px;cursor:pointer;white-space:nowrap;">测试</button></div>' +
            '<div style="font-size:12px;color:#6a6a78;margin-bottom:6px;">API 密钥</div>' +
            '<input id="tlg-api-key" type="password" style="width:100%;padding:10px 12px;background:#0e0e18;border:1px solid #1a1a28;border-radius:4px;color:#c0c0c8;font-size:16px;box-sizing:border-box;margin-bottom:12px;" />' +
            '<div style="font-size:12px;color:#6a6a78;margin-bottom:6px;">模型</div>' +
            '<div style="display:flex;gap:8px;margin-bottom:8px;">' +
            '<select id="tlg-model-select" style="flex:1;padding:10px;background:#0e0e18;border:1px solid #1a1a28;border-radius:4px;color:#c0c0c8;font-size:14px;min-width:0;"><option value="">-- 选择模型 --</option></select>' +
            '<button id="tlg-fetch-models" style="padding:8px 12px;background:#0e0e18;border:1px solid #1a1a28;border-radius:4px;color:#c0c0c8;font-size:12px;cursor:pointer;white-space:nowrap;">拉取列表</button></div>' +
            '<div style="font-size:12px;color:#6a6a78;margin-bottom:6px;">或手动输入模型名称</div>' +
            '<input id="tlg-model-manual" style="width:100%;padding:10px 12px;background:#0e0e18;border:1px solid #1a1a28;border-radius:4px;color:#c0c0c8;font-size:16px;box-sizing:border-box;" />' +
            '</div>' +
            '<button id="tlg-engine-save" style="width:100%;padding:12px;background:rgba(192,192,200,0.12);border:1px solid #6a6a78;border-radius:4px;color:#e8e8f0;font-size:13px;cursor:pointer;box-sizing:border-box;">保存引擎设置</button>' +
            '</div></div>';

        document.body.appendChild(panel);

        // 填入已有设置
        var s = state.settings || {};
        var aiEl = document.getElementById('tlg-auto-interval');
        if (aiEl) aiEl.value = s.autoInterval || 10;
        var lnEl = document.getElementById('tlg-last-n');
        if (lnEl) lnEl.value = s.lastNMessages || 5;
        var spEl = document.getElementById('tlg-summary-prompt');
        if (spEl) spEl.value = s.summaryPrompt || '';
        var auEl = document.getElementById('tlg-api-url');
        if (auEl) auEl.value = s.apiUrl || '';
        var akEl = document.getElementById('tlg-api-key');
        if (akEl) akEl.value = s.apiKey || '';
        var mmEl = document.getElementById('tlg-model-manual');
        if (mmEl) mmEl.value = s.model || '';

        // 绑定事件
        document.getElementById('tlg-close').onclick = function () {
            panel.style.display = 'none';
            document.body.style.overflow = '';
        };

        panel.querySelectorAll('.tlg-tab').forEach(function (tab) {
            tab.onclick = function () { switchTab(tab.getAttribute('data-tab')); };
        });

        document.getElementById('tlg-brief-close').onclick = closeBriefPanel;
        document.getElementById('tlg-btn-anchor').onclick = function () { showAnchorModal(); };
        document.getElementById('tlg-btn-reset').onclick = function () { camX = 0; camY = 0; camZoom = 1; renderCanvas(); };
        document.getElementById('tlg-archive-new').onclick = function () { showAnchorModal(); };
        document.getElementById('tlg-summary-run').onclick = runSummary;
        document.getElementById('tlg-fetch-models').onclick = fetchModels;

        document.getElementById('tlg-auto-toggle').onclick = function () {
            state.settings.autoMode = !state.settings.autoMode;
            this.style.background = state.settings.autoMode ? '#8888aa' : '#1a1a28';
            saveState();
        };
        if (s.autoMode) {
            var tog = document.getElementById('tlg-auto-toggle');
            if (tog) tog.style.background = '#8888aa';
        }

        document.getElementById('tlg-model-select').onchange = function () {
            if (this.value) document.getElementById('tlg-model-manual').value = this.value;
        };

        document.getElementById('tlg-engine-save').onclick = function () {
            state.settings.apiUrl = document.getElementById('tlg-api-url').value.trim();
            state.settings.apiKey = document.getElementById('tlg-api-key').value.trim();
            state.settings.model = document.getElementById('tlg-model-manual').value.trim() || document.getElementById('tlg-model-select').value;
            state.settings.autoInterval = Math.max(1, parseInt(document.getElementById('tlg-auto-interval').value, 10) || 10);
            state.settings.lastNMessages = Math.max(1, parseInt(document.getElementById('tlg-last-n').value, 10) || 5);
            state.settings.summaryPrompt = document.getElementById('tlg-summary-prompt').value;
            saveState();
            toast('引擎设置已保存。');
        };

        document.getElementById('tlg-test-api').onclick = async function () {
            var url = document.getElementById('tlg-api-url').value.trim();
            if (!url) { toast('请先输入地址。'); return; }
            toast('正在测试…');
            try {
                var res = await fetch(buildEndpoint(url, '/models'), {
                    headers: state.settings.apiKey ? { Authorization: 'Bearer ' + state.settings.apiKey } : {}
                });
                toast(res.ok ? '✓ API 可达。' : ('✗ HTTP ' + res.status));
            } catch (e) { toast('✗ ' + e.message); }
        };

        initCanvas();
        document.body.style.overflow = 'hidden';
        setTimeout(renderCanvas, 80);
    }

    function switchTab(name) {
        document.querySelectorAll('.tlg-tab').forEach(function (t) {
            var on = t.getAttribute('data-tab') === name;
            t.style.color = on ? '#e8e8f0' : '#6a6a78';
            t.style.borderBottom = on ? '2px solid #c0c0c8' : '2px solid transparent';
            t.style.background = on ? '#18182a' : 'transparent';
        });
        document.querySelectorAll('.tlg-view').forEach(function (v) {
            var on = v.getAttribute('data-view') === name;
            v.style.display = on ? 'flex' : 'none';
        });
        if (name === 'tree') setTimeout(renderCanvas, 50);
        else if (name === 'archive') refreshArchive();
        else if (name === 'summary') refreshSummary();
    }

    function initCanvas() {
        var wrap = document.getElementById('tlg-canvas-wrap');
        if (!wrap) return;
        tlgCanvas = document.getElementById('tlg-tree-canvas');
        tlgCtx = tlgCanvas.getContext('2d');
        if (typeof ResizeObserver !== 'undefined') {
            new ResizeObserver(renderCanvas).observe(wrap);
        }

        tlgCanvas.addEventListener('mousedown', function (e) {
            if (e.button !== 0) return;
            var hit = hitTest(e.clientX, e.clientY);
            if (hit) { openBriefPanel(hit); return; }
            isPanning = true; panStartX = e.clientX - camX; panStartY = e.clientY - camY;
        });
        tlgCanvas.addEventListener('mousemove', function (e) {
            if (!isPanning) return;
            camX = e.clientX - panStartX; camY = e.clientY - panStartY; renderCanvas();
        });
        tlgCanvas.addEventListener('mouseup', function () { isPanning = false; });
        tlgCanvas.addEventListener('mouseleave', function () { isPanning = false; });
        tlgCanvas.addEventListener('wheel', function (e) {
            e.preventDefault();
            camZoom = Math.max(0.2, Math.min(4, camZoom * (e.deltaY < 0 ? 1.1 : 0.91)));
            renderCanvas();
        }, { passive: false });

        var ltd = 0, tsh = null, tm = false;
        tlgCanvas.addEventListener('touchstart', function (e) {
            tm = false;
            if (e.touches.length === 1) {
                isPanning = true; panStartX = e.touches[0].clientX - camX; panStartY = e.touches[0].clientY - camY;
                tsh = hitTest(e.touches[0].clientX, e.touches[0].clientY);
            } else if (e.touches.length === 2) {
                isPanning = false;
                ltd = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
            }
        }, { passive: true });
        tlgCanvas.addEventListener('touchmove', function (e) {
            tm = true;
            if (e.touches.length === 1 && isPanning) {
                camX = e.touches[0].clientX - panStartX; camY = e.touches[0].clientY - panStartY; renderCanvas();
            } else if (e.touches.length === 2) {
                var d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
                if (ltd > 0) { camZoom = Math.max(0.2, Math.min(4, camZoom * (d / ltd))); renderCanvas(); }
                ltd = d;
            }
        }, { passive: true });
        tlgCanvas.addEventListener('touchend', function () {
            if (!tm && tsh) openBriefPanel(tsh);
            isPanning = false; tsh = null;
        }, { passive: true });
    }

    // ── 简介面板移动端：高度限制 ──
    function openBriefPanelMobile() {
        var bp = document.getElementById('tlg-brief-panel');
        if (!bp) return;
        bp.style.display = 'flex';
        bp.style.height = Math.min(window.innerHeight * 0.52, 420) + 'px';
        bp.style.flexShrink = '0';
    }

    // 覆盖 openBriefPanel 加移动端高度
    var _openBrief = openBriefPanel;
    openBriefPanel = function (nodeId) {
        _openBrief(nodeId);
        if (window.innerWidth <= 700) openBriefPanelMobile();
    };

    // ── 扩展设置 ──
    function isEnabled() {
        try {
            var ctx = getCtx();
            var es = (ctx && ctx.extensionSettings) || window.extension_settings || {};
            if (!es[EXT_NAME]) return true;
            return es[EXT_NAME].enabled !== false;
        } catch (e) { return true; }
    }

    function setEnabled(on) {
        try {
            var ctx = getCtx();
            var es = (ctx && ctx.extensionSettings) || window.extension_settings || {};
            if (!es[EXT_NAME]) es[EXT_NAME] = {};
            es[EXT_NAME].enabled = !!on;
            if (ctx && typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
            else if (typeof window.saveSettingsDebounced === 'function') window.saveSettingsDebounced();
            if (!on) {
                var p = document.getElementById('tlg-panel');
                if (p) p.style.display = 'none';
                document.body.style.overflow = '';
            }
            var btn = document.getElementById('tlg-menu-btn');
            if (btn) btn.style.display = on ? '' : 'none';
        } catch (e) {}
    }

    function injectSettingsPanel() {
        if (document.getElementById('tlg_settings_block')) return;
        var host = document.querySelector('#extensions_settings2') ||
            document.querySelector('#extensions_settings') ||
            document.querySelector('#extensions_settings1');
        if (!host) return;

        var enabled = isEnabled();
        var block = document.createElement('div');
        block.id = 'tlg_settings_block';
        block.className = 'extension_container';
        block.innerHTML =
            '<div class="inline-drawer">' +
            '<div class="inline-drawer-toggle inline-drawer-header"><b>🌊 河岸凝视</b>' +
            '<div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>' +
            '<div class="inline-drawer-content">' +
            '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin:8px 0;">' +
            '<span>启用插件</span>' +
            '<div id="tlg_enable_toggle" style="position:relative;width:40px;height:22px;background:' + (enabled ? '#8888aa' : '#1a1a28') + ';border-radius:11px;cursor:pointer;flex-shrink:0;"></div>' +
            '</div>' +
            '<div style="font-size:12px;opacity:.75;margin-bottom:10px;">关闭后隐藏菜单入口并停止全屏面板。</div>' +
            '<button id="tlg_settings_open" style="display:inline-flex;align-items:center;padding:8px 16px;background:#0e0e18;border:1px solid #6a6a78;border-radius:4px;color:#c0c0c8;font-size:13px;cursor:pointer;white-space:nowrap;writing-mode:horizontal-tb;">打开河岸凝视面板</button>' +
            '<div style="font-size:11px;opacity:.55;margin-top:10px;">斜杠命令：/tlg_anchor</div>' +
            '</div></div>';
        host.appendChild(block);

        document.getElementById('tlg_enable_toggle').onclick = function () {
            var next = this.style.background !== 'rgb(136, 136, 170)';
            this.style.background = next ? '#8888aa' : '#1a1a28';
            setEnabled(next);
            toast(next ? '河岸凝视已启用' : '河岸凝视已关闭');
        };
        document.getElementById('tlg_settings_open').onclick = function () {
            loadState();
            openPanel();
        };
    }

    // ── 魔法棒入口（完全照抄 max 框架）──
    function injectButton() {
        var menu = document.getElementById('extensionsMenu');
        if (!menu) return;
        if (document.getElementById('tlg-menu-btn')) return;
        var btn = document.createElement('div');
        btn.id = 'tlg-menu-btn';
        btn.className = 'list-group-item flex-container flexGap5 interactable';
        btn.style.cursor = 'pointer';
        btn.innerHTML = '<i class="fa-solid fa-water"></i><span>河岸凝视</span>';
        btn.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            var p = document.getElementById('tlg-panel');
            if (p && p.style.display === 'flex') {
                p.style.display = 'none';
                document.body.style.overflow = '';
            } else {
                loadState();
                openPanel();
            }
        });
        menu.appendChild(btn);
        console.log('[TLG] 按钮已注入');
    }

    function registerSlashCommand() {
        try {
            var ctx = getCtx();
            if (ctx && ctx.registerSlashCommand) {
                ctx.registerSlashCommand('tlg_anchor', function (args, value) {
                    loadState(); showAnchorModal(String(value || '')); return '';
                }, [], '创建河岸凝视锚定点', true, true);
            }
            if (window.SillyTavern && window.SillyTavern.SlashCommandParser) {
                window.SillyTavern.SlashCommandParser.addCommandObject(
                    window.SillyTavern.SlashCommand.fromProps({
                        name: 'tlg_anchor',
                        callback: function (a, v) { loadState(); showAnchorModal(String(v || '')); return ''; },
                        helpString: '创建河岸凝视因果锚定点。'
                    })
                );
            }
        } catch (e) {}
    }

    // ── 启动（完全照抄 max 框架）──
    injectButton();
    new MutationObserver(function () {
        injectButton();
        injectSettingsPanel();
    }).observe(document.body, { childList: true, subtree: true });
    setInterval(injectButton, 2000);
    injectSettingsPanel();
    registerSlashCommand();

    try {
        var ctx0 = getCtx();
        ctx0.eventSource.on(ctx0.eventTypes.CHAT_CHANGED, function () {
            var p = document.getElementById('tlg-panel');
            if (p) p.style.display = 'none';
            document.body.style.overflow = '';
        });
    } catch (e) { console.warn('[TLG] 事件绑定稍后重试', e); }

    console.log('[TLG] 河岸凝视 v2.3 已加载');
})();
