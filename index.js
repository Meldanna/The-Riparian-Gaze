(function () {
    // 调试标记
    console.log('[TLG] 强力注入模式启动');
    document.title = document.title.replace(/ \[.*\]/g, '') + ' [TLG-READY]';

    function injectButton() {
        var menu = document.getElementById('extensionsMenu');
        if (!menu) return;
        
        // 如果按钮已经存在，就不重复添加
        if (document.getElementById('tl-memory-button')) return;

        var btn = document.createElement('div');
        btn.id = 'tl-memory-button';
        btn.className = 'list-group-item flex-container flexGap5 interactable';
        btn.style.cursor = 'pointer';
        btn.innerHTML = '<i class="fa-solid fa-code-branch"></i><span>时间线(观测者)</span>';
        
        btn.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            alert('时间线系统：节点记录功能即将上线');
        });

        menu.appendChild(btn);
        console.log('[TLG] 按钮已强力注入');
    }

    // 1. 初始尝试注入
    injectButton();

    // 2. 使用观察者模式：盯着 extensionsMenu 及其父元素
    // 只要菜单内容发生变化（被酒馆重绘），就重新注入
    var observer = new MutationObserver(function(mutations) {
        injectButton();
    });

    // 开始观察整个文档的变动，因为菜单可能是动态生成的
    observer.observe(document.body, {
        childList: true,
        subtree: true
    });

    // 3. 兜底定时器（双重保险）
    setInterval(injectButton, 2000);
})();
