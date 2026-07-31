// The Riparian Gaze - debug test version
(function () {
    var debugDiv = document.createElement('div');
    debugDiv.id = 'tlg-debug';
    debugDiv.style.cssText = 'position:fixed;bottom:10px;right:10px;z-index:99999;background:#c00;color:#fff;padding:10px 14px;font-size:13px;border-radius:4px;';
    debugDiv.textContent = 'SCRIPT LOADED';
    document.body.appendChild(debugDiv);

    var tries = 0;
    var timer = setInterval(function () {
        tries++;
        var menu = document.getElementById('extensionsMenu');
        if (tries === 1) {
            debugDiv.textContent = 'tick ' + tries + ' menu=' + (menu ? 'FOUND' : 'missing');
        }
        if (menu && !document.getElementById('tl-memory-button')) {
            var btn = document.createElement('div');
            btn.id = 'tl-memory-button';
            btn.className = 'list-group-item flex-container flexGap5 interactable';
            btn.innerHTML = '<i class="fa-solid fa-code-branch"></i><span>Timeline</span>';
            btn.addEventListener('click', function () { alert('OK'); });
            menu.appendChild(btn);
            debugDiv.textContent = 'BUTTON ADDED';
            clearInterval(timer);
            return;
        }
        if (tries > 30) {
            debugDiv.textContent = 'TIMEOUT';
            clearInterval(timer);
        }
    }, 1000);
})();
