// The Riparian Gaze - 基于官方文档的稳定版本
(function () {
    var tries = 0;
    var timer = setInterval(function () {
        tries++;
        if (tries > 40) { clearInterval(timer); return; }

        // 等待全局 SillyTavern 对象就绪（官方推荐方式，不 import）
        if (!window.SillyTavern || !window.SillyTavern.getContext) return;

        clearInterval(timer);

        var context = window.SillyTavern.getContext();
        var eventSource = context.eventSource;
        var event_types = context.event_types;

        function addButton() {
            var menu = document.getElementById('extensionsMenu');
            if (!menu || document.getElementById('tl-memory-button')) return;

            var btn = document.createElement('div');
            btn.id = 'tl-memory-button';
            btn.className = 'list-group-item flex-container flexGap5 interactable';
            btn.innerHTML = '<i class="fa-solid fa-code-branch"></i><span>Timeline</span>';
            btn.addEventListener('click', function () { alert('OK'); });
            menu.appendChild(btn);
        }

        // APP_READY 会补触发，绝对可靠
        eventSource.on(event_types.APP_READY, addButton);
    }, 500);
})();
