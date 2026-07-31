// index.js - 时间线记忆管理扩展
import { extension_settings, getContext, saveMetadataDebounced } from "../../../extensions.js";

const MODULE_NAME = "st-timeline-memory";

// ============================================
// 数据结构
// ============================================

function getDefaultTree() {
    return {
        nodes: {},
        rootId: null,
        currentNodeId: null,
        settings: {
            autoSummarize: false,
            summarizeInterval: 8,
            messagesSinceLastNode: 0
        }
    };
}

function getTree() {
    const context = getContext();
    const chatId = context.chatId;
    if (!chatId) return getDefaultTree();

    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = {};
    }
    if (!extension_settings[MODULE_NAME][chatId]) {
        extension_settings[MODULE_NAME][chatId] = getDefaultTree();
    }
    return extension_settings[MODULE_NAME][chatId];
}

function saveTree() {
    saveMetadataDebounced();
}

function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 6);
}

// ============================================
// MVU 变量操作
// ============================================

function captureVariables() {
    try {
        if (typeof window.getAllVariables === 'function') {
            const all = window.getAllVariables();
            const sd = _.get(all, 'stat_data', null);
            return sd ? JSON.parse(JSON.stringify(sd)) : null;
        }
        const iframe = document.querySelector('#MVU_iframe');
        if (iframe && iframe.contentWindow && typeof iframe.contentWindow.getAllVariables === 'function') {
            const all = iframe.contentWindow.getAllVariables();
            const sd = _.get(all, 'stat_data', null);
            return sd ? JSON.parse(JSON.stringify(sd)) : null;
        }
    } catch (e) {
        console.error(`[${MODULE_NAME}] 捕获变量失败:`, e);
    }
    return null;
}

function restoreVariables(statData) {
    if (!statData) return false;
    try {
        if (typeof window.setVariable === 'function') {
            window.setVariable('stat_data', statData);
            return true;
        }
        const iframe = document.querySelector('#MVU_iframe');
        if (iframe && iframe.contentWindow && typeof iframe.contentWindow.setVariable === 'function') {
            iframe.contentWindow.setVariable('stat_data', statData);
            return true;
        }
    } catch (e) {
        console.error(`[${MODULE_NAME}] 恢复变量失败:`, e);
    }
    return false;
}

// ============================================
// 消息隐藏/显示
// ============================================

function getActivePath(tree) {
    const path = [];
    let nodeId = tree.currentNodeId;
    while (nodeId) {
        path.unshift(nodeId);
        const node = tree.nodes[nodeId];
        nodeId = node ? node.parentId : null;
    }
    return path;
}

function getMessageRangeForPath(tree, path) {
    const visibleRanges = [];
    path.forEach(nodeId => {
        const node = tree.nodes[nodeId];
        if (node && node.messageStartIdx !== undefined) {
            visibleRanges.push({
                start: node.messageStartIdx,
                end: node.messageEndIdx
            });
        }
    });
    return visibleRanges;
}

function applyMessageVisibility(tree) {
    const context = getContext();
    const chat = context.chat;
    if (!chat || chat.length === 0) return;

    const path = getActivePath(tree);
    const visibleRanges = getMessageRangeForPath(tree, path);

    if (visibleRanges.length === 0) return;

    const maxTracked = Math.max(...visibleRanges.map(r => r.end));

    for (let i = 0; i < chat.length; i++) {
        if (i > maxTracked) {
            chat[i].is_hidden = false;
        } else {
            const isVisible = visibleRanges.some(r => i >= r.start && i <= r.end);
            chat[i].is_hidden = !isVisible;
        }
    }

    if (typeof context.saveChat === 'function') {
        context.saveChat();
    }
}

// ============================================
// 摘要链构建
// ============================================

function buildSummaryChain(tree) {
    const path = getActivePath(tree);
    const summaries = [];
    path.forEach(nodeId => {
        const node = tree.nodes[nodeId];
        if (node && node.summary) {
            summaries.push(`[${node.name}] ${node.summary}`);
        }
    });
    return summaries.join('\n---\n');
}

// ============================================
// 核心操作
// ============================================

function anchorNode(name, summary = '') {
    const tree = getTree();
    const context = getContext();
    const chat = context.chat;
    const currentMsgIdx = chat.length - 1;

    const newId = generateId();
    const parentId = tree.currentNodeId;

    let messageStartIdx = 0;
    if (parentId && tree.nodes[parentId]) {
        messageStartIdx = tree.nodes[parentId].messageEndIdx + 1;
    }

    const node = {
        id: newId,
        parentId: parentId,
        name: name,
        timestamp: new Date().toLocaleString('zh-CN'),
        summary: summary,
        statData: captureVariables(),
        messageStartIdx: messageStartIdx,
        messageEndIdx: currentMsgIdx,
        children: [],
        isActive: true
    };

    tree.nodes[newId] = node;

    if (parentId && tree.nodes[parentId]) {
        tree.nodes[parentId].children.push(newId);
    }

    if (!tree.rootId) {
        tree.rootId = newId;
    }

    tree.currentNodeId = newId;
    tree.settings.messagesSinceLastNode = 0;

    saveTree();
    renderTreeCanvas();
    toastr.success(`已锚定节点: ${name}`);
    return newId;
}

function jumpToNode(targetNodeId) {
    const tree = getTree();
    const targetNode = tree.nodes[targetNodeId];
    if (!targetNode) {
        toastr.error('目标节点不存在');
        return;
    }

    if (targetNode.statData) {
        const restored = restoreVariables(targetNode.statData);
        if (!restored) {
            toastr.warning('变量恢复失败，但消息视图已切换');
        }
    }

    tree.currentNodeId = targetNodeId;
    applyMessageVisibility(tree);
    saveTree();
    renderTreeCanvas();
    injectSummaryToContext(tree);
    toastr.success(`已跳转至: ${targetNode.name}`);
}

function injectSummaryToContext(tree) {
    const summaryChain = buildSummaryChain(tree);
    if (!summaryChain) return;
    if (!extension_settings[MODULE_NAME]) extension_settings[MODULE_NAME] = {};
    extension_settings[MODULE_NAME]._activeSummary = summaryChain;
    saveTree();
}

// ============================================
// Canvas 树状图渲染
// ============================================

let canvasState = {
    offsetX: 0,
    offsetY: 0,
    scale: 1,
    isDragging: false,
    dragStartX: 0,
    dragStartY: 0,
    nodePositions: {}
};

function calculateTreeLayout(tree) {
    if (!tree.rootId || !tree.nodes[tree.rootId]) return {};

    const positions = {};
    const NODE_WIDTH = 140;
    const NODE_HEIGHT = 50;
    const H_GAP = 40;
    const V_GAP = 70;

    function getSubtreeWidth(nodeId) {
        const node = tree.nodes[nodeId];
        if (!node || node.children.length === 0) return NODE_WIDTH;
        let totalWidth = 0;
        node.children.forEach((childId, i) => {
            if (i > 0) totalWidth += H_GAP;
            totalWidth += getSubtreeWidth(childId);
        });
        return Math.max(NODE_WIDTH, totalWidth);
    }

    function layoutNode(nodeId, x, y) {
        const node = tree.nodes[nodeId];
        if (!node) return;

        const subtreeWidth = getSubtreeWidth(nodeId);
        const nodeX = x + subtreeWidth / 2 - NODE_WIDTH / 2;

        positions[nodeId] = {
            x: nodeX,
            y: y,
            width: NODE_WIDTH,
            height: NODE_HEIGHT
        };

        if (node.children.length > 0) {
            let childX = x;
            node.children.forEach((childId) => {
                const childWidth = getSubtreeWidth(childId);
                layoutNode(childId, childX, y + NODE_HEIGHT + V_GAP);
                childX += childWidth + H_GAP;
            });
        }
    }

    layoutNode(tree.rootId, 50, 50);
    return positions;
}

function renderTreeCanvas() {
    const canvas = document.getElementById('tl-tree-canvas');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const tree = getTree();
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.translate(canvasState.offsetX, canvasState.offsetY);
    ctx.scale(canvasState.scale, canvasState.scale);

    if (!tree.rootId) {
        ctx.fillStyle = 'rgba(210,225,240,0.4)';
        ctx.font = '14px serif';
        ctx.textAlign = 'center';
        ctx.fillText('尚无时间线节点', canvas.width / 2 / canvasState.scale, canvas.height / 2 / canvasState.scale);
        ctx.restore();
        return;
    }

    const positions = calculateTreeLayout(tree);
    canvasState.nodePositions = positions;
    const activePath = getActivePath(tree);

    // 画连线
    Object.entries(positions).forEach(([nodeId, pos]) => {
        const node = tree.nodes[nodeId];
        if (!node || !node.parentId) return;
        const parentPos = positions[node.parentId];
        if (!parentPos) return;

        const isOnActivePath = activePath.includes(nodeId) && activePath.includes(node.parentId);

        ctx.beginPath();
        ctx.moveTo(parentPos.x + parentPos.width / 2, parentPos.y + parentPos.height);
        ctx.lineTo(pos.x + pos.width / 2, pos.y);
        ctx.strokeStyle = isOnActivePath ? 'rgba(140,180,250,0.8)' : 'rgba(192,210,230,0.15)';
        ctx.lineWidth = isOnActivePath ? 2 : 1;
        ctx.stroke();
    });

    // 画节点
    Object.entries(positions).forEach(([nodeId, pos]) => {
        const node = tree.nodes[nodeId];
        if (!node) return;

        const isCurrent = nodeId === tree.currentNodeId;
        const isOnPath = activePath.includes(nodeId);

        ctx.fillStyle = isCurrent
            ? 'rgba(80,120,200,0.4)'
            : isOnPath
                ? 'rgba(60,90,150,0.25)'
                : 'rgba(40,50,70,0.6)';
        ctx.strokeStyle = isCurrent
            ? 'rgba(140,180,250,0.9)'
            : isOnPath
                ? 'rgba(140,180,250,0.4)'
                : 'rgba(192,210,230,0.12)';
        ctx.lineWidth = isCurrent ? 2 : 1;

        roundRect(ctx, pos.x, pos.y, pos.width, pos.height, 6);
        ctx.fill();
        ctx.stroke();

        if (isCurrent) {
            ctx.shadowColor = 'rgba(140,180,250,0.6)';
            ctx.shadowBlur = 12;
            roundRect(ctx, pos.x, pos.y, pos.width, pos.height, 6);
            ctx.stroke();
            ctx.shadowBlur = 0;
        }

        ctx.fillStyle = isCurrent ? '#fff' : 'rgba(210,225,240,0.8)';
        ctx.font = isCurrent ? 'bold 11px sans-serif' : '11px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        const displayName = node.name.length > 10 ? node.name.slice(0, 10) + '...' : node.name;
        ctx.fillText(displayName, pos.x + pos.width / 2, pos.y + pos.height / 2 - 6);

        ctx.fillStyle = 'rgba(180,200,220,0.4)';
        ctx.font = '9px sans-serif';
        ctx.fillText(node.timestamp.split(' ')[0] || '', pos.x + pos.width / 2, pos.y + pos.height / 2 + 10);
    });

    ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
}

function getClickedNode(mouseX, mouseY) {
    const positions = canvasState.nodePositions;
    const x = (mouseX - canvasState.offsetX) / canvasState.scale;
    const y = (mouseY - canvasState.offsetY) / canvasState.scale;

    for (const [nodeId, pos] of Object.entries(positions)) {
        if (x >= pos.x && x <= pos.x + pos.width &&
            y >= pos.y && y <= pos.y + pos.height) {
            return nodeId;
        }
    }
    return null;
}

// ============================================
// UI 面板
// ============================================

function createPanel() {
    if ($('#tl-memory-panel').length > 0) return;

    const panelHtml = `
        <div id="tl-memory-panel" style="display:none;">
            <div class="tl-panel-header">
                <h4>⟡ 时间线管理</h4>
                <div class="tl-header-controls">
                    <button id="tl-btn-settings" class="tl-icon-btn" title="设置">⚙</button>
                    <button id="tl-btn-close" class="tl-icon-btn" title="关闭">×</button>
                </div>
            </div>

            <div class="tl-panel-body">
                <div class="tl-tree-container">
                    <canvas id="tl-tree-canvas"></canvas>
                </div>

                <div class="tl-action-bar">
                    <input type="text" id="tl-node-name-input" placeholder="节点名称（如：王都潜入·第三夜）">
                    <button id="tl-btn-anchor" class="tl-btn-primary">锚定</button>
                </div>

                <div id="tl-summary-editor" style="display:none;">
                    <textarea id="tl-summary-text" placeholder="事件摘要（可手动编辑或等待AI总结）"></textarea>
                    <div class="tl-summary-actions">
                        <button id="tl-btn-save-summary" class="tl-btn-secondary">保存摘要</button>
                        <button id="tl-btn-cancel-summary" class="tl-btn-secondary">取消</button>
                    </div>
                </div>

                <div id="tl-node-detail" style="display:none;">
                    <div class="tl-detail-header">
                        <span id="tl-detail-name"></span>
                        <button id="tl-btn-close-detail" class="tl-icon-btn">×</button>
                    </div>
                    <div id="tl-detail-content"></div>
                    <div class="tl-detail-actions">
                        <button id="tl-btn-jump" class="tl-btn-primary">跳转至此</button>
                        <button id="tl-btn-edit-summary" class="tl-btn-secondary">编辑摘要</button>
                        <button id="tl-btn-delete-node" class="tl-btn-danger">删除</button>
                    </div>
                </div>

                <div id="tl-settings-panel" style="display:none;">
                    <div class="tl-setting-item">
                        <label>
                            <input type="checkbox" id="tl-auto-summarize">
                            自动总结（每N轮提醒锚定）
                        </label>
                    </div>
                    <div class="tl-setting-item">
                        <label>总结间隔（轮数）：</label>
                        <input type="number" id="tl-summarize-interval" min="3" max="30" value="8">
                    </div>
                    <div class="tl-setting-item">
                        <button id="tl-btn-export" class="tl-btn-secondary">导出时间线</button>
                        <button id="tl-btn-import" class="tl-btn-secondary">导入时间线</button>
                    </div>
                </div>
            </div>
        </div>
    `;

    $('body').append(panelHtml);
}

function showNodeDetail(nodeId) {
    const tree = getTree();
    const node = tree.nodes[nodeId];
    if (!node) return;

    const $panel = $('#tl-memory-panel');
    $panel.data('selected-node-id', nodeId);

    const isCurrent = nodeId === tree.currentNodeId;
    const summary = node.summary || '（无摘要）';
    const statData = node.statData || {};

    let html = `<div class="tl-detail-time">${node.timestamp}</div>`;
    html += `<div class="tl-detail-summary">${summary}</div>`;

    const sit = _.get(statData, '当前处境', {});
    if (Object.keys(sit).length > 0) {
        html += `<div class="tl-detail-section">环境</div>`;
        html += `<div class="tl-detail-info">地点: ${sit.地理位置 || '?'}</div>`;
        html += `<div class="tl-detail-info">天气: ${sit.局部天气 || '?'}</div>`;
        html += `<div class="tl-detail-info">因果震荡: ${sit.因果震荡等级 || 0}</div>`;
    }

    const slots = _.get(statData, '命运分支池.槽位', {});
    const activeSlots = Object.entries(slots).filter(([k, v]) => v && v.状态 && v.状态 !== '枯萎态');
    if (activeSlots.length > 0) {
        html += `<div class="tl-detail-section">分支池</div>`;
        activeSlots.forEach(([k, v]) => {
            html += `<div class="tl-detail-branch">${v.状态} · ${k} · ${v.因果描述 || ''}</div>`;
        });
    }

    $('#tl-detail-name').text(node.name + (isCurrent ? ' ◀ 当前' : ''));
    $('#tl-detail-content').html(html);
    $('#tl-btn-jump').prop('disabled', isCurrent).text(isCurrent ? '已在此处' : '跳转至此');
    $('#tl-node-detail').show();
}

// ============================================
// 事件绑定
// ============================================

function bindEvents() {
    const $panel = $('#tl-memory-panel');

    $(document).on('click', '#tl-memory-button', () => {
        if ($panel.is(':visible')) {
            $panel.hide();
        } else {
            $panel.show();
            renderTreeCanvas();
        }
    });

    $panel.on('click', '#tl-btn-close', () => $panel.hide());

    $panel.on('click', '#tl-btn-anchor', () => {
        const name = $('#tl-node-name-input').val().trim();
        if (!name) {
            toastr.warning('请输入节点名称');
            return;
        }
        $('#tl-summary-editor').show();
        $('#tl-summary-text').val('').focus();
        $panel.data('pending-name', name);
    });

    $panel.on('click', '#tl-btn-save-summary', () => {
        const name = $panel.data('pending-name');
        const summary = $('#tl-summary-text').val().trim();
        anchorNode(name, summary);
        $('#tl-node-name-input').val('');
        $('#tl-summary-editor').hide();
    });

    $panel.on('click', '#tl-btn-cancel-summary', () => {
        const name = $panel.data('pending-name');
        anchorNode(name, '');
        $('#tl-node-name-input').val('');
        $('#tl-summary-editor').hide();
    });

    // Canvas 交互
    const canvas = document.getElementById('tl-tree-canvas');
    if (canvas) {
        let dragMoved = false;

        canvas.addEventListener('mousedown', (e) => {
            canvasState.isDragging = true;
            dragMoved = false;
            canvasState.dragStartX = e.clientX - canvasState.offsetX;
            canvasState.dragStartY = e.clientY - canvasState.offsetY;
        });

        canvas.addEventListener('mousemove', (e) => {
            if (!canvasState.isDragging) return;
            dragMoved = true;
            canvasState.offsetX = e.clientX - canvasState.dragStartX;
            canvasState.offsetY = e.clientY - canvasState.dragStartY;
            renderTreeCanvas();
        });

        canvas.addEventListener('mouseup', (e) => {
            canvasState.isDragging = false;
            if (!dragMoved) {
                const rect = canvas.getBoundingClientRect();
                const mouseX = e.clientX - rect.left;
                const mouseY = e.clientY - rect.top;
                const clickedNodeId = getClickedNode(mouseX, mouseY);
                if (clickedNodeId) {
                    showNodeDetail(clickedNodeId);
                }
            }
        });

        canvas.addEventListener('mouseleave', () => {
            canvasState.isDragging = false;
        });

        canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            const delta = e.deltaY > 0 ? 0.9 : 1.1;
            canvasState.scale = Math.max(0.3, Math.min(3, canvasState.scale * delta));
            renderTreeCanvas();
        });

        // 触摸
        let touchStartX, touchStartY, lastTouchDist, touchMoved;

        canvas.addEventListener('touchstart', (e) => {
            if (e.touches.length === 1) {
                canvasState.isDragging = true;
                touchMoved = false;
                touchStartX = e.touches[0].clientX - canvasState.offsetX;
                touchStartY = e.touches[0].clientY - canvasState.offsetY;
            } else if (e.touches.length === 2) {
                lastTouchDist = Math.hypot(
                    e.touches[0].clientX - e.touches[1].clientX,
                    e.touches[0].clientY - e.touches[1].clientY
                );
            }
        });

        canvas.addEventListener('touchmove', (e) => {
            e.preventDefault();
            if (e.touches.length === 1 && canvasState.isDragging) {
                touchMoved = true;
                canvasState.offsetX = e.touches[0].clientX - touchStartX;
                canvasState.offsetY = e.touches[0].clientY - touchStartY;
                renderTreeCanvas();
            } else if (e.touches.length === 2) {
                const dist = Math.hypot(
                    e.touches[0].clientX - e.touches[1].clientX,
                    e.touches[0].clientY - e.touches[1].clientY
                );
                const delta = dist / lastTouchDist;
                canvasState.scale = Math.max(0.3, Math.min(3, canvasState.scale * delta));
                lastTouchDist = dist;
                renderTreeCanvas();
            }
        });

        canvas.addEventListener('touchend', (e) => {
            canvasState.isDragging = false;
            if (!touchMoved && e.changedTouches.length === 1) {
                const rect = canvas.getBoundingClientRect();
                const mouseX = e.changedTouches[0].clientX - rect.left;
                const mouseY = e.changedTouches[0].clientY - rect.top;
                const clickedNodeId = getClickedNode(mouseX, mouseY);
                if (clickedNodeId) {
                    showNodeDetail(clickedNodeId);
                }
            }
        });
    }

    // 节点详情
    $panel.on('click', '#tl-btn-close-detail', () => {
        $('#tl-node-detail').hide();
    });

    $panel.on('click', '#tl-btn-jump', () => {
        const nodeId = $panel.data('selected-node-id');
        if (nodeId) {
            jumpToNode(nodeId);
            $('#tl-node-detail').hide();
        }
    });

    $panel.on('click', '#tl-btn-delete-node', () => {
        const nodeId = $panel.data('selected-node-id');
        if (!nodeId) return;
        const tree = getTree();
        const node = tree.nodes[nodeId];
        if (!node) return;

        if (node.children.length > 0) {
            toastr.error('不能删除有子节点的节点，请先删除子节点');
            return;
        }

        if (!confirm(`确定删除节点 [${node.name}]？`)) return;

        if (node.parentId && tree.nodes[node.parentId]) {
            const parent = tree.nodes[node.parentId];
            parent.children = parent.children.filter(id => id !== nodeId);
        }

        if (tree.currentNodeId === nodeId) {
            tree.currentNodeId = node.parentId;
        }

        if (tree.rootId === nodeId) {
            tree.rootId = null;
            tree.currentNodeId = null;
        }

        delete tree.nodes[nodeId];
        saveTree();
        renderTreeCanvas();
        $('#tl-node-detail').hide();
        toastr.success('节点已删除');
    });

    $panel.on('click', '#tl-btn-edit-summary', () => {
        const nodeId = $panel.data('selected-node-id');
        if (!nodeId) return;
        const tree = getTree();
        const node = tree.nodes[nodeId];
        if (!node) return;

        const newSummary = prompt('编辑摘要：', node.summary || '');
        if (newSummary !== null) {
            node.summary = newSummary;
            saveTree();
            showNodeDetail(nodeId);
        }
    });

    // 设置
    $panel.on('click', '#tl-btn-settings', () => {
        $('#tl-settings-panel').toggle();
    });

    $panel.on('change', '#tl-auto-summarize', function () {
        const tree = getTree();
        tree.settings.autoSummarize = $(this).is(':checked');
        saveTree();
    });

    $panel.on('change', '#tl-summarize-interval', function () {
        const tree = getTree();
        tree.settings.summarizeInterval = parseInt($(this).val()) || 8;
        saveTree();
    });

    // 导出
    $panel.on('click', '#tl-btn-export', () => {
        const tree = getTree();
        const blob = new Blob([JSON.stringify(tree, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `timeline_${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(url);
        toastr.success('时间线已导出');
    });

    // 导入
    $panel.on('click', '#tl-btn-import', () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.onchange = (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (ev) => {
                try {
                    const imported = JSON.parse(ev.target.result);
                    if (!imported.nodes || !imported.rootId) {
                        toastr.error('无效的时间线文件');
                        return;
                    }
                    const context = getContext();
                    const chatId = context.chatId;
                    if (!chatId) return;
                    extension_settings[MODULE_NAME][chatId] = imported;
                    saveTree();
                    renderTreeCanvas();
                    toastr.success('时间线已导入');
                } catch (err) {
                    toastr.error('导入失败：文件格式错误');
                }
            };
            reader.readAsText(file);
        };
        input.click();
    });

    // 点击面板外关闭
    $(document).on('click', (e) => {
        if ($panel.is(':visible') &&
            !$(e.target).closest('#tl-memory-panel').length &&
            !$(e.target).closest('#tl-memory-button').length) {
            $panel.hide();
        }
    });
}

// ============================================
// 自动提醒逻辑
// ============================================

function onMessageReceived() {
    const tree = getTree();
    if (!tree.settings.autoSummarize) return;

    tree.settings.messagesSinceLastNode++;
    saveTree();

    if (tree.settings.messagesSinceLastNode >= tree.settings.summarizeInterval) {
        toastr.info('已达到设定轮数，建议锚定一个新的时间线节点', '时间线提醒', {
            timeOut: 5000,
            onclick: () => {
                $('#tl-memory-panel').show();
                $('#tl-node-name-input').focus();
            }
        });
    }
}

// ============================================
// 初始化
// ============================================

async function waitForElement(selector, timeout = 15000) {
    if ($(selector).length) return $(selector);
    return new Promise((resolve, reject) => {
        const observer = new MutationObserver(() => {
            if ($(selector).length) {
                observer.disconnect();
                resolve($(selector));
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        setTimeout(() => {
            observer.disconnect();
            reject(new Error(`[${MODULE_NAME}] 未找到元素: ${selector}`));
        }, timeout);
    });
}

jQuery(async () => {
    console.log(`[${MODULE_NAME}] 正在初始化...`);

    try {
        const $menu = await waitForElement('#extensionsMenu');
        console.log(`[${MODULE_NAME}] 找到 extensionsMenu，注入按钮`);

        if ($('#tl-memory-button').length === 0) {
            const buttonHtml = `
                <div id="tl-memory-button" class="list-group-item flex-container flexGap5 interactable" title="时间线记忆管理">
                    <i class="fa-solid fa-code-branch"></i>
                    <span>时间线</span>
                </div>
            `;
            $menu.append(buttonHtml);
            console.log(`[${MODULE_NAME}] 按钮已添加`);
        }

        createPanel();
        bindEvents();

        const context = getContext();
        if (context.eventSource) {
            context.eventSource.on('message_received', onMessageReceived);
            context.eventSource.on('chatLoaded', () => {
                canvasState = { offsetX: 0, offsetY: 0, scale: 1, isDragging: false, dragStartX: 0, dragStartY: 0, nodePositions: {} };
                renderTreeCanvas();
            });
        }

        const tree = getTree();
        $('#tl-auto-summarize').prop('checked', tree.settings.autoSummarize);
        $('#tl-summarize-interval').val(tree.settings.summarizeInterval);

        console.log(`[${MODULE_NAME}] 初始化完成`);

    } catch (e) {
        console.error(`[${MODULE_NAME}] 初始化失败:`, e);
    }
});
