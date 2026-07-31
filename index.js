import { extension_settings, getContext } from "../../../extensions.js";
import { event_types, eventSource } from "../../../../script.js";

const extensionName = "The-Riparian-Gaze";
const MODULE_NAME = "the-riparian-gaze";

console.log(`[${MODULE_NAME}] 脚本开始加载`);

function addButton() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu) return false;
    if (document.getElementById('tl-memory-button')) return true;

    const btn = document.createElement('div');
    btn.id = 'tl-memory-button';
    btn.className = 'list-group-item flex-container flexGap5 interactable';
    btn.title = '时间线记忆管理';
    btn.innerHTML = '<i class="fa-solid fa-code-branch"></i><span>时间线</span>';
    btn.addEventListener('click', function() {
        alert('按钮生效！');
    });
    menu.appendChild(btn);
    console.log(`[${MODULE_NAME}] 按钮注入成功`);
    return true;
}

// 等待酒馆UI就绪后注入
eventSource.on(event_types.APP_READY, function() {
    console.log(`[${MODULE_NAME}] APP_READY 事件触发`);
    const success = addButton();
    if (!success) {
        setTimeout(addButton, 2000);
    }
});
