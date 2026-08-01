/**
 * 河岸凝视 v2.4
 * - 打开方式严格对齐已验证 max 框架
 * - 启动清理残留，避免顶栏被顶
 * - 弹窗 translate 居中
 * - 样式仅 #tlg-* 作用域
 */
(function () {
    'use strict';
    console.log('[TLG] 河岸凝视 v2.4 启动');

    var EXT_NAME = 'RiparianGaze';
    var METADATA_KEY = 'tlg_data';

    var state = {
        nodes: [],
        currentNodeId: null,
        selectedNodeId: null,
        settings: {
            autoMode: false,
            autoInterval: 10,
            lastNMessages: 5,
            apiUrl: '',
            apiKey: '',
            model: '',
            modelList: [],
            summaryPrompt: '请简洁总结近期对话中的关键事件。'
        },
        summaries: [],
        turnsSinceAnchor: 0,
        _lastChatLen: 0
    };

    var tlgCanvas = null, tlgCtx = null;
    var camX = 0, camY = 0, camZoom = 1;
    var isPanning = false, panStartX = 0, panStartY = 0;

    function getCtx() {
        return window.SillyTavern.getContext();
    }

    function generateId() {
        return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    }

    function toast(msg) {
        var el = document.createElement('div');
        el.textContent = msg;
        el.setAttribute('style',
            'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);' +
            'background:#0a0a10;border:1px solid #1a1a28;border-radius:8px;' +
            'padding:12px 16px;color:#c0c0c8;font-size:13px;z-index:100002;' +
            'max-width:80vw;text-align:center;pointer-events:none;'
        );
        document.body.appendChild(el);
        setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 2600);
    }

    function escHtml(str) {
        return String(str || '')
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    /** 启动时清掉旧版残留，防止黑条/顶栏下移 */
    function cleanupLeftovers() {
        ['tlg-panel', 'tlg-overlay', 'tlg-modal', 'tlg-modal-box', 'tlg-anchor-modal'].forEach(function (id) {
            var el = document.getElementById(id);
            if (el && el.parentNode) el.parentNode.removeChild(el);
        });
        // 绝不在未打开时改 body 布局
        try {
            if (document.body && document.body.style) {
                // 只清我们可能写过的 overflow，不碰 padding/margin
                if (document.body.getAttribute('data-tlg-lock') === '1') {
                    document.body.style.overflow = '';
                    document.body.removeAttribute('data-tlg-lock');
                }
            }
        } catch (e) {}
    }

    function saveState() {
        var ctx = getCtx();
        if (!ctx.chatMetadata && !ctx.chat_metadata) return;
        var meta = ctx.chatMetadata || ctx.chat_metadata;
        meta[METADATA_KEY] = JSON.parse(JSON.stringify(state));
        if (typeof ctx.saveMetadata === 'function') ctx.saveMetadata();
    }

    function loadState() {
        var ctx = getCtx();
        var meta = (ctx.chatMetadata || ctx.chat_metadata) || {};
        var saved = meta[METADATA_KEY];
        if (saved) {
            state = JSON.parse(JSON.stringify(saved));
            if (!state.settings) state.settings = {};
            if (!state.nodes) state.nodes = [];
            if (!state.summaries) state.summaries = [];
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
        while (cur) {
            path.unshift(cur.id);
            cur = findNode(cur.parentId);
        }
        return path;
    }

    function getMVU() {
        try {
            var ctx = getCtx();
            var meta = ctx.chatMetadata || ctx.chat_metadata || {};
            if (meta.stat_data != null) return JSON.parse(JSON.stringify(meta.stat_data));
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
            var meta = ctx.chatMetadata || ctx.chat_metadata;
            if (meta) {
                meta.stat_data = JSON.parse(JSON.stringify(data));
                if (typeof ctx.saveMetadata === 'function') ctx.saveMetadata();
            }
            if (typeof window.setVariable === 'function') window.setVariable('stat_data', data);
        } catch (e) {}
    }

    function applyVisibility(targetNodeId) {
        var ctx = getCtx();
        if (!ctx.chat) return;
        var pathIds = getPathToRoot(targetNodeId);
        var visible = {};
        var i, m, node, next, start, end;
        for (i = 0; i < pathIds.length; i++) {
            node = findNode(pathIds[i]);
            next = i + 1 < pathIds.length ? findNode(pathIds[i + 1]) : null;
            if (!node) continue;
            start = node.msgIdx;
            end = next ? next.msgIdx - 1 : node.msgIdx;
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
        if (parent && parent.children.indexOf(newId) === -1) parent.children.push(newId);
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

    /** 锚定弹窗：遮罩 + 正中盒子，不碰 body */
    function showAnchorModal(prefill) {
    closeModal();

    // 遮罩：铺满全屏，拦截所有触摸
    var mask = document.createElement('div');
    mask.id = 'tlg-modal';
    mask.setAttribute('style',
        'position:fixed;top:0;left:0;width:100%;height:100%;' +
        'background:rgba(0,0,0,0.75);z-index:2147483646;' +
        'touch-action:none;overscroll-behavior:none;'
    );

    // 弹窗本体：用 flex 居中，不用 transform（避免某些手机偏移）
    var wrap = document.createElement('div');
    wrap.setAttribute('style',
        'position:fixed;top:0;left:0;width:100%;height:100%;' +
        'z-index:2147483647;display:flex;align-items:center;justify-content:center;' +
        'padding:16px;box-sizing:border-box;' +
        'touch-action:none;overscroll-behavior:none;'
    );

    var box = document.createElement('div');
    box.id = 'tlg-modal-box';
    box.setAttribute('style',
        'background:#0a0a10;border:1px solid #2a2a3a;border-radius:10px;' +
        'padding:20px;width:100%;max-width:420px;color:#c0c0c8;box-sizing:border-box;' +
        'max-height:80vh;overflow-y:auto;'
    );
    box.innerHTML =
        '<div style="font-size:16px;font-weight:600;color:#e8e8f0;margin-bottom:14px;">⚓ 创建锚定点</div>' +
        '<div style="margin-bottom:12px;">' +
        '<div style="font-size:12px;color:#6a6a78;margin-bottom:6px;">节点名称</div>' +
        '<input id="tlg-anc-name" value="' + escHtml(prefill || '') + '" placeholder="例：决斗之前…" ' +
        'style="width:100%;padding:10px 12px;background:#0e0e18;border:1px solid #1a1a28;border-radius:4px;color:#c0c0c8;font-size:16px;box-sizing:border-box;">' +
        '</div>' +
        '<div style="margin-bottom:16px;">' +
        '<div style="font-size:12px;color:#6a6a78;margin-bottom:6px;">简要描述</div>' +
        '<textarea id="tlg-anc-brief" placeholder="此时此刻的情况概述…" ' +
        'style="width:100%;padding:10px 12px;background:#0e0e18;border:1px solid #1a1a28;border-radius:4px;color:#c0c0c8;font-size:14px;min-height:90px;box-sizing:border-box;resize:vertical;"></textarea>' +
        '</div>' +
        '<div style="display:flex;justify-content:flex-end;gap:10px;">' +
        '<button type="button" id="tlg-anc-cancel" style="padding:8px 16px;background:#0e0e18;border:1px solid #1a1a28;border-radius:4px;color:#c0c0c8;font-size:13px;cursor:pointer;">取消</button>' +
        '<button type="button" id="tlg-anc-ok" style="padding:8px 16px;background:rgba(192,192,200,0.12);border:1px solid #6a6a78;border-radius:4px;color:#e8e8f0;font-size:13px;cursor:pointer;">⚓ 确认锚定</button>' +
        '</div>';

    wrap.appendChild(box);
    document.body.appendChild(mask);
    document.body.appendChild(wrap);
    wrap.id = 'tlg-modal-wrap';

    // 点遮罩关闭
    mask.addEventListener('click', closeModal);
    // 拦截遮罩上的滑动，不传给聊天区
    mask.addEventListener('touchmove', function(e){ e.preventDefault(); }, { passive: false });
    wrap.addEventListener('touchmove', function(e){
        // 仅允许 box 内部滚动，wrap 本身不传透
        if (!box.contains(e.target)) e.preventDefault();
    }, { passive: false });

    document.getElementById('tlg-anc-cancel').onclick = closeModal;
    document.getElementById('tlg-anc-ok').onclick = function () {
        var name = document.getElementById('tlg-anc-name').value.trim() || ('节点 ' + state.nodes.length);
        var brief = document.getElementById('tlg-anc-brief').value.trim();
        createAnchor(name, brief);
        closeModal();
    };
    setTimeout(function () {
        var inp = document.getElementById('tlg-anc-name');
        if (inp) inp.focus();
    }, 50);
}

function closeModal() {
    ['tlg-modal', 'tlg-modal-wrap', 'tlg-modal-box'].forEach(function(id){
        var el = document.getElementById(id);
        if (el && el.parentNode) el.parentNode.removeChild(el);
    });
}


    function closeModal() {
        var m = document.getElementById('tlg-modal');
        var b = document.getElementById('tlg-modal-box');
        if (m && m.parentNode) m.parentNode.removeChild(m);
        if (b && b.parentNode) b.parentNode.removeChild(b);
    }

    // ── 画布 ──
    function layoutTree() {
        var pos = {}, H = 180, V = 120;
        function w(id) {
            var n = findNode(id);
            if (!n || !n.children.length) return 1;
            var s = 0;
            for (var i = 0; i < n.children.length; i++) s += w(n.children[i]);
            return s;
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
        var i, n, f, t, cy, p, isCur, onPath;

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
            tlgCtx.stroke();
        }

        for (i = 0; i < state.nodes.length; i++) {
            n = state.nodes[i];
            p = pos[n.id]; if (!p) continue;
            isCur = n.id === state.currentNodeId;
            onPath = path.indexOf(n.id) !== -1;
            tlgCtx.beginPath();
            tlgCtx.arc(p.x, p.y, R, 0, Math.PI * 2);
            if (isCur) {
                tlgCtx.fillStyle = 'rgba(255,255,255,0.15)';
                tlgCtx.strokeStyle = '#fff';
                tlgCtx.lineWidth = 2;
            } else if (onPath) {
                tlgCtx.fillStyle = 'rgba(192,192,210,0.07)';
                tlgCtx.strokeStyle = 'rgba(192,192,210,0.55)';
                tlgCtx.lineWidth = 1.2;
            } else {
                tlgCtx.fillStyle = 'rgba(192,192,210,0.04)';
                tlgCtx.strokeStyle = 'rgba(192,192,210,0.2)';
                tlgCtx.lineWidth = 1;
            }
            tlgCtx.fill();
            tlgCtx.stroke();
            tlgCtx.fillStyle = isCur ? '#fff' : 'rgba(220,220,230,0.8)';
            tlgCtx.font = '10px sans-serif';
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
        var pos = layoutTree(), R = 22, ids = Object.keys(pos);
        for (var i = 0; i < ids.length; i++) {
            var p = pos[ids[i]];
            var dx = wx - p.x, dy = wy - p.y;
            if (dx * dx + dy * dy <= (R + 4) * (R + 4)) return ids[i];
        }
        return null;
    }

    function openBriefPanel(nodeId) {
        var node = findNode(nodeId);
        if (!node) return;
        state.selectedNodeId = nodeId;
        var panel = document.getElementById('tlg-brief-panel');
        if (!panel) return;
        panel.classList.add('open');
        panel.style.display = 'flex';
        document.getElementById('tlg-brief-title').textContent = node.name;
        var body = document.getElementById('tlg-brief-body');
        body.innerHTML =
            '<div style="margin-bottom:8px;font-size:11px;color:#6a6a78">' + new Date(node.timestamp).toLocaleString() + '</div>' +
            '<div style="margin-bottom:8px;font-size:11px;color:#6a6a78">消息 ' + node.msgIdx + ' | ' + (node.statData ? 'MVU✓' : '无快照') + '</div>' +
            '<div style="white-space:pre-wrap;margin-bottom:12px">' + (node.brief ? escHtml(node.brief) : '<em style="color:#6a6a78">暂无描述</em>') + '</div>' +
            '<textarea id="tlg-brief-edit" style="width:100%;min-height:90px;padding:10px;background:#0e0e18;border:1px solid #1a1a28;border-radius:4px;color:#c0c0c8;font-size:14px;box-sizing:border-box;">' + escHtml(node.brief || '') + '</textarea>' +
            '<button type="button" id="tlg-brief-save" class="tlg-btn tlg-btn-primary" style="margin-top:8px;width:100%;padding:10px;">保存描述</button>';
        document.getElementById('tlg-brief-save').onclick = function () {
            node.brief = document.getElementById('tlg-brief-edit').value;
            saveState(); toast('描述已保存'); refreshArchive();
        };
        document.getElementById('tlg-brief-footer').innerHTML =
            '<button type="button" id="tlg-brief-jump" class="tlg-btn tlg-btn-primary" style="width:100%;padding:12px;">↩ 确认跳转至此节点</button>';
        document.getElementById('tlg-brief-jump').onclick = function () { jumpToNode(nodeId); };
        renderCanvas();
    }

    function closeBriefPanel() {
        var panel = document.getElementById('tlg-brief-panel');
        if (panel) {
            panel.classList.remove('open');
            panel.style.display = 'none';
        }
        state.selectedNodeId = null;
        renderCanvas();
    }

    function refreshArchive() {
        var container = document.getElementById('tlg-archive-list');
        if (!container) return;
        if (!state.nodes.length) {
            container.innerHTML = '<div style="color:#6a6a78;padding:20px">暂无节点</div>';
            return;
        }
        var sorted = state.nodes.slice().sort(function (a, b) { return b.timestamp - a.timestamp; });
        container.innerHTML = sorted.map(function (node) {
            var isCur = node.id === state.currentNodeId;
            return '<div style="background:#0a0a10;border:1px solid ' + (isCur ? '#c0c0c8' : '#1a1a28') + ';border-radius:6px;padding:12px;margin-bottom:10px;">' +
                '<div style="font-weight:600;color:#e8e8f0">' + escHtml(node.name) + (isCur ? ' <span style="color:#6a6a78;font-size:11px">(当前)</span>' : '') + '</div>' +
                '<div style="font-size:11px;color:#6a6a78;margin-top:4px">' + new Date(node.timestamp).toLocaleString() + ' · 消息 ' + node.msgIdx + '</div>' +
                '<div style="font-size:12px;margin-top:8px">' + escHtml(node.brief || '') + '</div>' +
                '<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">' +
                '<button type="button" class="tlg-btn tlg-arc-view" data-nid="' + node.id + '">在树图中查看</button>' +
                '<button type="button" class="tlg-btn tlg-btn-primary tlg-arc-jump" data-nid="' + node.id + '">↩ 跳转</button>' +
                '<button type="button" class="tlg-btn tlg-arc-del" data-nid="' + node.id + '" style="margin-left:auto;border-color:#aa4444;color:#aa4444">✕</button>' +
                '</div></div>';
        }).join('');
        container.querySelectorAll('.tlg-arc-view').forEach(function (b) {
            b.onclick = function () { switchTab('tree'); openBriefPanel(b.getAttribute('data-nid')); };
        });
        container.querySelectorAll('.tlg-arc-jump').forEach(function (b) {
            b.onclick = function () { jumpToNode(b.getAttribute('data-nid')); };
        });
        container.querySelectorAll('.tlg-arc-del').forEach(function (b) {
            b.onclick = function () {
                var nid = b.getAttribute('data-nid');
                if (nid === state.currentNodeId) { toast('无法删除当前节点'); return; }
                var n = findNode(nid);
                if (!confirm('删除「' + (n ? n.name : '') + '」？')) return;
                deleteNode(nid);
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
        toast('节点已删除');
    }

    function refreshSummary() {
        var list = document.getElementById('tlg-summary-list');
        if (!list) return;
        if (!state.summaries || !state.summaries.length) {
            list.innerHTML = '<div style="color:#6a6a78">暂无总结</div>';
            return;
        }
        list.innerHTML = state.summaries.slice().reverse().map(function (s, i) {
            var idx = state.summaries.length - 1 - i;
            return '<div style="border:1px solid #1a1a28;border-radius:6px;padding:12px;margin-bottom:10px;background:#0a0a10">' +
                '<div style="font-size:11px;color:#6a6a78;margin-bottom:6px">' + new Date(s.timestamp).toLocaleString() + '</div>' +
                '<div style="white-space:pre-wrap;font-size:13px">' + escHtml(s.text) + '</div>' +
                '<button type="button" data-idx="' + idx + '" style="margin-top:8px;border:1px solid #aa4444;color:#aa4444;background:transparent;border-radius:4px;padding:4px 10px;cursor:pointer">删除</button></div>';
        }).join('');
        list.querySelectorAll('[data-idx]').forEach(function (b) {
            b.onclick = function () {
                state.summaries.splice(Number(b.getAttribute('data-idx')), 1);
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
        if (!apiUrl) { toast('请先设置 API'); return; }
        var ctx = getCtx();
        var chat = ((ctx && ctx.chat) || []).slice(-20).map(function (m) {
            return (m.name || m.role) + ': ' + m.mes;
        }).join('\n');
        var prompt = (state.settings.summaryPrompt || '').replace('{{context}}', chat);
        toast('正在生成…');
        try {
            var res = await fetch(buildEndpoint(apiUrl, '/chat/completions'), {
                method: 'POST',
                headers: Object.assign(
                    { 'Content-Type': 'application/json' },
                    state.settings.apiKey ? { Authorization: 'Bearer ' + state.settings.apiKey } : {}
                ),
                body: JSON.stringify({
                    model: state.settings.model || undefined,
                    messages: [{ role: 'user', content: prompt }],
                    max_tokens: 512
                })
            });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            var data = await res.json();
            var text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
            state.summaries.push({ timestamp: Date.now(), text: text });
            saveState(); refreshSummary(); toast('总结已生成');
        } catch (e) {
            toast('失败: ' + e.message);
        }
    }

    // ═══════════════════════════════════════
    // ★ openPanel：严格 max 框架写法
    // ═══════════════════════════════════════
    function openPanel() {
        try {
            loadState();

            var exist = document.getElementById('tlg-panel');
            if (exist) {
                exist.style.display = 'flex';
                document.body.setAttribute('data-tlg-lock', '1');
                document.body.style.overflow = 'hidden';
                setTimeout(renderCanvas, 60);
                return;
            }

            var panel = document.createElement('div');
            panel.id = 'tlg-panel';
            // 关键：只设 display，其余交给 style.css（和 max 一样）
            // 但补一条 inline background，防止主题把背景冲掉
            panel.style.display = 'flex';
            panel.style.background = '#050508';

            panel.innerHTML =
                '<div id="tlg-tabs">' +
                '<div class="tlg-tab active" data-tab="tree">因果树</div>' +
                '<div class="tlg-tab" data-tab="archive">档案库</div>' +
                '<div class="tlg-tab" data-tab="summary">总结池</div>' +
                '<div class="tlg-tab" data-tab="engine">引擎设置</div>' +
                '<div id="tlg-close">✕</div>' +
                '</div>' +
                '<div id="tlg-body">' +
                // tree
                '<div class="tlg-view active" data-view="tree" style="flex-direction:column">' +
                '<div id="tlg-canvas-wrap" style="flex:1;position:relative;min-height:0">' +
                '<canvas id="tlg-tree-canvas"></canvas>' +
                '<div id="tlg-canvas-toolbar">' +
                '<button type="button" class="tlg-btn" id="tlg-btn-anchor">⚓ 在此锚定</button>' +
                '<button type="button" class="tlg-btn" id="tlg-btn-reset">重置视图</button>' +
                '</div></div>' +
                '<div id="tlg-brief-panel">' +
                '<div id="tlg-brief-header"><span id="tlg-brief-title">节点</span>' +
                '<button type="button" class="tlg-btn" id="tlg-brief-close">✕</button></div>' +
                '<div id="tlg-brief-body"></div><div id="tlg-brief-footer"></div></div></div>' +
                // archive
                '<div class="tlg-view" data-view="archive"><div class="tlg-scroll">' +
                '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">' +
                '<div style="font-weight:600;color:#e8e8f0">全部节点</div>' +
                '<button type="button" class="tlg-btn tlg-btn-primary" id="tlg-archive-new">⚓ 新建锚定</button></div>' +
                '<div id="tlg-archive-list"></div></div></div>' +
                // summary
                '<div class="tlg-view" data-view="summary"><div class="tlg-scroll">' +
                '<div style="background:#0a0a10;border:1px solid #1a1a28;border-radius:6px;padding:12px;margin-bottom:12px">' +
                '<div style="font-weight:600;color:#e8e8f0;margin-bottom:8px">总结设置</div>' +
                '<div style="margin-bottom:8px;font-size:13px">每 <input id="tlg-auto-interval" type="number" min="1" value="' + (state.settings.autoInterval || 10) + '" style="width:60px;padding:4px;background:#0e0e18;border:1px solid #1a1a28;color:#c0c0c8;border-radius:4px"> 轮提醒</div>' +
                '<div style="margin-bottom:8px;font-size:13px">跳转后显示最后 <input id="tlg-last-n" type="number" min="1" value="' + (state.settings.lastNMessages || 5) + '" style="width:60px;padding:4px;background:#0e0e18;border:1px solid #1a1a28;color:#c0c0c8;border-radius:4px"> 条</div>' +
                '<textarea id="tlg-summary-prompt" style="width:100%;min-height:100px;padding:10px;background:#0e0e18;border:1px solid #1a1a28;color:#c0c0c8;border-radius:4px;font-size:14px;box-sizing:border-box">' + escHtml(state.settings.summaryPrompt || '') + '</textarea>' +
                '<button type="button" class="tlg-btn tlg-btn-primary" id="tlg-summary-run" style="margin-top:10px;width:100%;padding:10px">▶ 立即生成总结</button></div>' +
                '<div id="tlg-summary-list"></div></div></div>' +
                // engine
                '<div class="tlg-view" data-view="engine"><div class="tlg-scroll">' +
                '<div style="background:#0a0a10;border:1px solid #1a1a28;border-radius:6px;padding:12px">' +
                '<div style="font-weight:600;color:#e8e8f0;margin-bottom:10px">API 配置</div>' +
                '<div style="font-size:12px;color:#6a6a78;margin-bottom:6px">API 地址</div>' +
                '<input id="tlg-api-url" value="' + escHtml(state.settings.apiUrl || '') + '" style="width:100%;padding:10px;background:#0e0e18;border:1px solid #1a1a28;color:#c0c0c8;border-radius:4px;font-size:16px;box-sizing:border-box;margin-bottom:10px">' +
                '<div style="font-size:12px;color:#6a6a78;margin-bottom:6px">API 密钥</div>' +
                '<input id="tlg-api-key" type="password" value="' + escHtml(state.settings.apiKey || '') + '" style="width:100%;padding:10px;background:#0e0e18;border:1px solid #1a1a28;color:#c0c0c8;border-radius:4px;font-size:16px;box-sizing:border-box;margin-bottom:10px">' +
                '<div style="font-size:12px;color:#6a6a78;margin-bottom:6px">模型名</div>' +
                '<input id="tlg-model-manual" value="' + escHtml(state.settings.model || '') + '" style="width:100%;padding:10px;background:#0e0e18;border:1px solid #1a1a28;color:#c0c0c8;border-radius:4px;font-size:16px;box-sizing:border-box;margin-bottom:12px">' +
                '<button type="button" class="tlg-btn tlg-btn-primary" id="tlg-engine-save" style="width:100%;padding:12px">保存引擎设置</button>' +
                '</div></div></div>' +
                '</div>';

            document.body.appendChild(panel);
            document.body.setAttribute('data-tlg-lock', '1');
            document.body.style.overflow = 'hidden';

            document.getElementById('tlg-close').onclick = closePanel;

            var tabs = panel.querySelectorAll('.tlg-tab');
            for (var i = 0; i < tabs.length; i++) {
                tabs[i].addEventListener('click', function () {
                    switchTab(this.getAttribute('data-tab'));
                });
            }

            document.getElementById('tlg-btn-anchor').onclick = function () { showAnchorModal(); };
            document.getElementById('tlg-btn-reset').onclick = function () {
                camX = 0; camY = 0; camZoom = 1; renderCanvas();
            };
            document.getElementById('tlg-brief-close').onclick = closeBriefPanel;
            document.getElementById('tlg-archive-new').onclick = function () { showAnchorModal(); };
            document.getElementById('tlg-summary-run').onclick = runSummary;
            document.getElementById('tlg-engine-save').onclick = function () {
                state.settings.apiUrl = document.getElementById('tlg-api-url').value.trim();
                state.settings.apiKey = document.getElementById('tlg-api-key').value.trim();
                state.settings.model = document.getElementById('tlg-model-manual').value.trim();
                state.settings.autoInterval = Math.max(1, parseInt(document.getElementById('tlg-auto-interval').value, 10) || 10);
                state.settings.lastNMessages = Math.max(1, parseInt(document.getElementById('tlg-last-n').value, 10) || 5);
                state.settings.summaryPrompt = document.getElementById('tlg-summary-prompt').value;
                saveState();
                toast('引擎设置已保存');
            };

            initCanvas();
            setTimeout(renderCanvas, 60);
            console.log('[TLG] 面板已打开');
        } catch (err) {
            console.error('[TLG] openPanel 错误', err);
            toast('打开失败: ' + err.message);
        }
    }

    function closePanel() {
        var panel = document.getElementById('tlg-panel');
        if (panel) panel.style.display = 'none';
        if (document.body.getAttribute('data-tlg-lock') === '1') {
            document.body.style.overflow = '';
            document.body.removeAttribute('data-tlg-lock');
        }
        closeModal();
    }

    function switchTab(name) {
        var panel = document.getElementById('tlg-panel');
        if (!panel) return;
        var tabs = panel.querySelectorAll('.tlg-tab');
        for (var i = 0; i < tabs.length; i++) {
            if (tabs[i].getAttribute('data-tab') === name) tabs[i].classList.add('active');
            else tabs[i].classList.remove('active');
        }
        var views = panel.querySelectorAll('.tlg-view');
        for (var j = 0; j < views.length; j++) {
            if (views[j].getAttribute('data-view') === name) {
                views[j].classList.add('active');
                views[j].style.display = 'flex';
            } else {
                views[j].classList.remove('active');
                views[j].style.display = 'none';
            }
        }
        if (name === 'tree') setTimeout(renderCanvas, 50);
        else if (name === 'archive') refreshArchive();
        else if (name === 'summary') refreshSummary();
    }

    function initCanvas() {
        var wrap = document.getElementById('tlg-canvas-wrap');
        tlgCanvas = document.getElementById('tlg-tree-canvas');
        if (!wrap || !tlgCanvas) return;
        tlgCtx = tlgCanvas.getContext('2d');
        if (typeof ResizeObserver !== 'undefined') {
            new ResizeObserver(function () { renderCanvas(); }).observe(wrap);
        }

        tlgCanvas.addEventListener('mousedown', function (e) {
            if (e.button !== 0) return;
            var hit = hitTest(e.clientX, e.clientY);
            if (hit) { openBriefPanel(hit); return; }
            isPanning = true;
            panStartX = e.clientX - camX;
            panStartY = e.clientY - camY;
        });
        tlgCanvas.addEventListener('mousemove', function (e) {
            if (!isPanning) return;
            camX = e.clientX - panStartX;
            camY = e.clientY - panStartY;
            renderCanvas();
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
                isPanning = true;
                panStartX = e.touches[0].clientX - camX;
                panStartY = e.touches[0].clientY - camY;
                tsh = hitTest(e.touches[0].clientX, e.touches[0].clientY);
            } else if (e.touches.length === 2) {
                isPanning = false;
                ltd = Math.hypot(
                    e.touches[0].clientX - e.touches[1].clientX,
                    e.touches[0].clientY - e.touches[1].clientY
                );
            }
        }, { passive: true });
        tlgCanvas.addEventListener('touchmove', function (e) {
            tm = true;
            if (e.touches.length === 1 && isPanning) {
                camX = e.touches[0].clientX - panStartX;
                camY = e.touches[0].clientY - panStartY;
                renderCanvas();
            } else if (e.touches.length === 2) {
                var d = Math.hypot(
                    e.touches[0].clientX - e.touches[1].clientX,
                    e.touches[0].clientY - e.touches[1].clientY
                );
                if (ltd > 0) {
                    camZoom = Math.max(0.2, Math.min(4, camZoom * (d / ltd)));
                    renderCanvas();
                }
                ltd = d;
            }
        }, { passive: true });
        tlgCanvas.addEventListener('touchend', function () {
            if (!tm && tsh) openBriefPanel(tsh);
            isPanning = false;
            tsh = null;
        }, { passive: true });
    }

    // ── 入口 ──
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
            if (p && p.style.display === 'flex') closePanel();
            else openPanel();
        });
        menu.appendChild(btn);
        console.log('[TLG] 按钮已注入');
    }

    function injectSettingsPanel() {
        if (document.getElementById('tlg_settings_block')) return;
        var host = document.querySelector('#extensions_settings2') ||
            document.querySelector('#extensions_settings') ||
            document.querySelector('#extensions_settings1');
        if (!host) return;

        var block = document.createElement('div');
        block.id = 'tlg_settings_block';
        block.className = 'extension_container';
        block.innerHTML =
            '<div class="inline-drawer">' +
            '<div class="inline-drawer-toggle inline-drawer-header"><b>🌊 河岸凝视</b>' +
            '<div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>' +
            '<div class="inline-drawer-content">' +
            '<div style="font-size:12px;opacity:.75;margin:8px 0">因果时间线管理 · 数据存于当前聊天</div>' +
            '<button type="button" id="tlg_settings_open">打开河岸凝视面板</button>' +
            '<div style="font-size:11px;opacity:.55;margin-top:10px">斜杠命令：/tlg_anchor</div>' +
            '</div></div>';
        host.appendChild(block);
        document.getElementById('tlg_settings_open').onclick = function () { openPanel(); };
    }

    function registerSlash() {
        try {
            var ctx = getCtx();
            if (ctx && ctx.registerSlashCommand) {
                ctx.registerSlashCommand('tlg_anchor', function (a, v) {
                    loadState();
                    showAnchorModal(String(v || ''));
                    return '';
                }, [], '创建河岸凝视锚定点', true, true);
            }
        } catch (e) {}
    }

    // boot
    cleanupLeftovers();
    injectButton();
    injectSettingsPanel();
    new MutationObserver(function () {
        injectButton();
        injectSettingsPanel();
    }).observe(document.body, { childList: true, subtree: true });
    setInterval(injectButton, 2000);
    registerSlash();

    try {
        var ctx0 = getCtx();
        if (ctx0 && ctx0.eventSource && ctx0.eventTypes) {
            ctx0.eventSource.on(ctx0.eventTypes.CHAT_CHANGED, function () {
                closePanel();
            });
        }
    } catch (e) {}

    console.log('[TLG] 河岸凝视 v2.4 已加载');
})();
