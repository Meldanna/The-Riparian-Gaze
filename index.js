(function () {
    console.log('[TLG] 时间线系统启动');

    function getCtx() {
        return window.SillyTavern.getContext();
    }

    function getTree() {
        var ctx = getCtx();
        if (!ctx.chatMetadata.tlg_tree) {
            var rootId = 'root';
            ctx.chatMetadata.tlg_tree = {
                rootId: rootId,
                currentNodeId: rootId,
                nodes: {}
            };
            ctx.chatMetadata.tlg_tree.nodes[rootId] = {
                id: rootId, parentId: null, children: [],
                name: '开局', brief: '', msgIndex: 0,
                createdAt: Date.now(), statData: null
            };
        }
        return ctx.chatMetadata.tlg_tree;
    }

    async function saveTree() {
        await getCtx().saveMetadata();
    }

    function createNode(name, brief) {
        var tree = getTree();
        var ctx = getCtx();
        var parentId = tree.currentNodeId;
        var id = 'node_' + Date.now();
        tree.nodes[id] = {
            id: id, parentId: parentId, children: [],
            name: name || '未命名节点', brief: brief || '',
            msgIndex: ctx.chat.length - 1,
            createdAt: Date.now(), statData: null
        };
        tree.nodes[parentId].children.push(id);
        tree.currentNodeId = id;
        saveTree();
        return id;
    }

    function openPanel() {
        var exist = document.getElementById('tlg-panel');
        if (exist) { exist.style.display = 'flex'; return; }

        var panel = document.createElement('div');
        panel.id = 'tlg-panel';
        panel.innerHTML =
            '<div id="tlg-tabs">' +
                '<div class="tlg-tab active" data-tab="tree">因果树</div>' +
                '<div class="tlg-tab" data-tab="archive">档案库</div>' +
                '<div class="tlg-tab" data-tab="summary">总结池</div>' +
                '<div class="tlg-tab" data-tab="engine">引擎设置</div>' +
                '<div id="tlg-close">✕</div>' +
            '</div>' +
            '<div id="tlg-body">' +
                '<div class="tlg-view" data-view="tree">因果树画布占位(第2步)</div>' +
                '<div class="tlg-view" data-view="archive" style="display:none">档案库占位(第4步)</div>' +
                '<div class="tlg-view" data-view="summary" style="display:none">总结池占位(第4步)</div>' +
                '<div class="tlg-view" data-view="engine" style="display:none">引擎设置占位(第4步)</div>' +
            '</div>';
        document.body.appendChild(panel);

        document.getElementById('tlg-close').addEventListener('click', function () {
            panel.style.display = 'none';
        });

        var tabs = panel.querySelectorAll('.tlg-tab');
        for (var i = 0; i < tabs.length; i++) {
            tabs[i].addEventListener('click', function () {
                var target = this.getAttribute('data-tab');
                panel.querySelectorAll('.tlg-tab').forEach(function (t) { t.classList.remove('active'); });
                this.classList.add('active');
                panel.querySelectorAll('.tlg-view').forEach(function (v) {
                    v.style.display = (v.getAttribute('data-view') === target) ? 'block' : 'none';
                });
            });
        }
    }

    function injectButton() {
        var menu = document.getElementById('extensionsMenu');
        if (!menu) return;
        if (document.getElementById('tl-memory-button')) return;
        var btn = document.createElement('div');
        btn.id = 'tl-memory-button';
        btn.className = 'list-group-item flex-container flexGap5 interactable';
        btn.style.cursor = 'pointer';
        btn.innerHTML = '<i class="fa-solid fa-code-branch"></i><span>时间线(观测者)</span>';
        btn.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            getTree();
            openPanel();
        });
        menu.appendChild(btn);
        console.log('[TLG] 按钮已注入');
    }

    injectButton();
    new MutationObserver(function () { injectButton(); }).observe(document.body, { childList: true, subtree: true });
    setInterval(injectButton, 2000);

    try {
        var ctx0 = getCtx();
        ctx0.eventSource.on(ctx0.eventTypes.CHAT_CHANGED, function () {
            var p = document.getElementById('tlg-panel');
            if (p) p.style.display = 'none';
        });
    } catch (e) { console.warn('[TLG] 事件绑定稍后重试', e); }
})();
