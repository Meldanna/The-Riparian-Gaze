// 诊断版：加载成功会改页面标题
document.title = document.title + ' [TLG]';

(function () {
    var tries = 0;
    var timer = setInterval(function () {
        tries++;
        var menu = document.getElementById('extensionsMenu');
        if (menu && !document.getElementById('tl-memory-button')) {
            var btn = document.createElement('div');
            btn.id = 'tl-memory-button';
            btn.className = 'list-group-item flex-container flexGap5 interactable';
            btn.innerHTML = '<i class="fa-solid fa-code-branch"></i><span>Timeline</span>';
            btn.addEventListener('click', function () { alert('OK'); });
            menu.appendChild(btn);
            document.title = document.title + ' [BTN]';
            clearInterval(timer);
            return;
        }
        if (tries > 60) {
            document.title = document.title + ' [NO MENU]';
            clearInterval(timer);
        }
    }, 1000);
})();
