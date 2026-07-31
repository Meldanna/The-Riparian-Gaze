(async function () {
    const MAX_WAIT = 30;
    let count = 0;
    const timer = setInterval(() => {
        const menu = document.getElementById('extensionsMenu');
        count++;
        if (menu && !document.getElementById('tl-memory-button')) {
            const btn = document.createElement('div');
            btn.id = 'tl-memory-button';
            btn.className = 'list-group-item flex-container flexGap5 interactable';
            btn.title = '时间线记忆管理';
            btn.innerHTML = '<i class="fa-solid fa-code-branch"></i><span>时间线</span>';
            btn.addEventListener('click', function() { alert('按钮生效！'); });
            menu.appendChild(btn);
            clearInterval(timer);
        }
        if (count >= MAX_WAIT) clearInterval(timer);
    }, 1000);
})();
