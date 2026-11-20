import {isPacket, newId, packet, validId} from './wire.js';
import {createStorage, selectHostStore} from './storage.js';
import {createWindow} from './window.js';
import {watchGenerations} from './generation.js';

const gameURL = new URL('https://persephonesgarden.guanchi.workers.dev/');
const frameId = 'pocket-familiar-host';
const registration = Symbol.for('pocket-familiar.extension');
const installReload = Symbol.for('pocket-familiar.install-reload');

export function reloadAfterInstall() {
    if (window[installReload]) return;
    window[installReload] = true;
    setTimeout(() => window.location.reload(), 0);
}

if (!window[registration]) {
    window[registration] = true;
    const observer = new MutationObserver(register);
    observer.observe(document, {childList: true, subtree: true});
    register();

    function register() {
        const mount = document.querySelector('#extensions_settings') ?? document.querySelector('#extensions_settings2');
        if (!mount) return;
        observer.disconnect();
        if (!document.getElementById('pf-tt-settings')) start(mount);
    }
}

function start(mount) {
    const settings = document.createElement('div');
    settings.id = 'pf-tt-settings';
    settings.className = 'extension_container';
    settings.innerHTML = `<div class="inline-drawer">
        <button type="button" class="inline-drawer-toggle inline-drawer-header" aria-expanded="false" aria-controls="pf-tt-controls">
            <strong>口袋使魔</strong>
            <i class="inline-drawer-icon fa-solid fa-circle-chevron-down down" aria-hidden="true"></i>
        </button>
        <div id="pf-tt-controls" class="inline-drawer-content">
            <button type="button" class="menu_button" disabled>显示悬浮窗</button>
        </div>
    </div>`;
    mount.append(settings);
    const header = settings.querySelector('.inline-drawer-header');
    const icon = header.querySelector('.inline-drawer-icon');
    const toggle = settings.querySelector('.menu_button');
    header.addEventListener('click', () => requestAnimationFrame(() => {
        header.setAttribute('aria-expanded', String(icon.classList.contains('up')));
    }));
    const report = message => window.toastr?.warning(message, '口袋使魔');
    const getTavern = () => window.SillyTavern?.getContext?.();
    let hostStore;
    const getStore = () => hostStore ??= selectHostStore(getTavern).catch(error => {
        hostStore = null;
        throw error;
    });
    const storage = createStorage(getStore);
    const token = newId();
    const frame = document.createElement('iframe');
    frame.id = frameId;
    frame.className = 'pf-tt-frame';
    frame.title = '口袋使魔';
    frame.hidden = true;
    frame.referrerPolicy = 'no-referrer';
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-downloads');
    frame.setAttribute('allowtransparency', 'true');
    frame.allow = 'fullscreen';
    let wanted = false, ready = false, port = null, view = null;
    let bootTimer = null, bootFailed = false, viewTimer = null, latestGeneration = null;
    const send = data => port?.postMessage(packet('control', {data}));
    const controller = createWindow(frame, send, state => {
        view = JSON.parse(JSON.stringify(state));
        clearTimeout(viewTimer);
        viewTimer = setTimeout(() => {
            void storage.write('window', view).catch(() => report('窗口位置无法保存。'));
        }, 300);
    });
    let connection = null;
    const generationQueue = [];
    let counting = false, generationTimer = null, generationError = false;
    const sendGeneration = () => {
        if (latestGeneration) send({type: 'generation', id: latestGeneration.id, total: latestGeneration.total});
    };
    async function drainGenerations() {
        if (counting || !generationQueue.length) return;
        clearTimeout(generationTimer);
        counting = true;
        try {
            while (generationQueue.length) {
                latestGeneration = await storage.countGeneration(generationQueue[0]);
                generationQueue.shift();
                sendGeneration();
            }
            generationError = false;
        } catch {
            if (!generationError) report('生成计数暂未写入酒馆存档，将自动重试。');
            generationError = true;
            generationTimer = setTimeout(drainGenerations, 5000);
        } finally {
            counting = false;
        }
    }
    function ordinaryFrame() {
        return [...document.querySelectorAll('#' + frameId)].some(element => element !== frame);
    }
    function checkDuplicate() {
        if (!ordinaryFrame()) return false;
        if (wanted) send({type: 'flush'});
        wanted = false;
        frame.hidden = true;
        toggle.textContent = '显示悬浮窗';
        return true;
    }
    new MutationObserver(checkDuplicate).observe(document.body, {childList: true});

    function loadFrame() {
        gameURL.searchParams.set('embed', '1');
        // Legacy game builds must enter their bridge path while the new build is deployed.
        gameURL.searchParams.set('saveBridge', '1');
        gameURL.searchParams.set('parentOrigin', 'https://pocket-familiar-tt.invalid');
        gameURL.searchParams.set('ttOrigin', window.origin);
        gameURL.hash = 'tt=' + token;
        bootFailed = false;
        frame.src = gameURL.href;
        if (!frame.isConnected) document.body.append(frame);
        clearTimeout(bootTimer);
        bootTimer = setTimeout(() => {
            if (!ready) {
                bootFailed = !port;
                if (wanted) report('游戏连接超时。请检查网络，再隐藏并重新显示悬浮窗。');
            }
        }, 15000);
    }
    function setVisible(visible, persist = true) {
        if (visible && checkDuplicate()) {
            wanted = false;
            report('已检测到角色卡脚本打开的悬浮窗。关闭该脚本窗口后可显示扩展窗口。');
            return;
        }
        wanted = visible;
        toggle.textContent = visible ? '隐藏悬浮窗' : '显示悬浮窗';
        if (visible) {
            if (!frame.isConnected || bootFailed) loadFrame();
            frame.hidden = !ready;
            controller.reportViewport();
            send({type: 'retry'});
            if (generationError) void refreshGeneration().catch(() => {});
            void drainGenerations();
        } else {
            frame.hidden = true;
            send({type: 'flush'});
        }
        if (persist) void storage.write('settings', {visible}).catch(() => {
            if (wanted === visible) report('悬浮窗状态暂未保存。');
        });
    }

    function connected(event) {
        const data = event.data;
        if (event.origin !== gameURL.origin || event.source !== frame.contentWindow
            || !isPacket(data) || data.type !== 'hello' || data.token !== token
            || !validId(data.requestId) || connection === data.requestId || checkDuplicate()) return;
        connection = data.requestId;
        port?.close();
        const channel = new MessageChannel();
        port = channel.port1;
        let initialized = false;
        port.onmessage = async event => {
            const message = event.data;
            if (!isPacket(message)) return;
            if (message.type === 'control') {
                if (!initialized || !message.data || checkDuplicate()) return;
                if (message.data.type === 'ready') {
                    ready = true;
                    frame.hidden = !wanted;
                    sendGeneration();
                }
                if (message.data.type === 'hide') setVisible(false);
                if (message.data.type === 'generation-request') sendGeneration();
                controller.receive(message.data);
                return;
            }
            if (message.type === 'status') {
                const messages = {
                    recovered: '当前进度已从有效备份恢复。',
                    unavailable: '无法读写酒馆存档。请尝试隐藏并重新显示悬浮窗。',
                    corrupt: '游戏存档损坏，找不到可恢复的进度。',
                    incompatible: '本地存档来自较新的游戏版本。请更新游戏网站后重试。',
                    conflict: '本地存档已被另一窗口更新，请导出当前进度后重新打开酒馆。',
                    invalid: '当前进度校验失败，请导出当前进度留存。',
                    limit: '存档超出桥接容量，请导出当前进度留存。',
                    timeout: '酒馆存档尚未确认。'
                };
                clearTimeout(bootTimer);
                if (Object.hasOwn(messages, message.status) && wanted && message.status !== lastStatus) report(messages[message.status]);
                lastStatus = message.status;
                return;
            }
            if (!validId(message.requestId) || !['load', 'save'].includes(message.type)) return;
            const replyPort = channel.port1;
            let response;
            try {
                if (message.type === 'load') {
                    const loaded = await storage.load();
                    initialized = loaded.status !== 'corrupt';
                    response = {type: 'loaded', ...loaded, view};
                } else {
                    const status = initialized && !ordinaryFrame() ? await storage.commit(message) : 'unavailable';
                    response = {type: 'committed', status, id: message.record?.id};
                }
            } catch {
                response = {type: message.type === 'load' ? 'loaded' : 'committed', status: 'unavailable'};
            }
            const {type, ...fields} = response;
            replyPort.postMessage(packet(type, {requestId: message.requestId, ...fields}));
        };
        event.source.postMessage(packet('connect', {token, requestId: connection}), gameURL.origin, [channel.port2]);
    }
    let lastStatus = null;
    window.addEventListener('message', connected);
    async function refreshGeneration() {
        const ledger = await storage.generation();
        if (ledger && (!latestGeneration || latestGeneration.total <= ledger.total)) {
            latestGeneration = ledger;
            sendGeneration();
        }
        generationError = false;
    }
    toggle.addEventListener('click', () => setVisible(!wanted));
    void (async () => {
        await (window.__TAURITAVERN__?.ready ?? window.__TAURITAVERN_MAIN_READY__);
        if (!watchGenerations(getTavern, id => {
            generationQueue.push(id);
            void drainGenerations();
        }, () => report('酒馆生成结果校验失败，未记录该次生成。'))) {
            report('当前酒馆未提供生成事件。');
        }
        const [preference, windowState, ledger] = await Promise.allSettled([
            storage.read('settings'), storage.read('window'), refreshGeneration()
        ]);
        if (windowState.status === 'fulfilled' && windowState.value.found) {
            view = windowState.value.value;
            controller.restore(view);
        }
        if ([preference, windowState, ledger].some(result => result.status === 'rejected')) {
            generationError = ledger.status === 'rejected';
            report('部分酒馆存档暂时无法读取。');
        }
        const saved = preference.value?.value;
        const visible = typeof saved?.visible === 'boolean' ? saved.visible : saved?.autoShow !== false;
        setVisible(visible, false);
    })().catch(() => report('口袋使魔初始化失败。')).finally(() => { toggle.disabled = false; });
}
