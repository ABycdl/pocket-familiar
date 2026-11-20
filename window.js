const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const finite = (...values) => values.every(Number.isFinite);

export function createWindow(frame, send, saveView) {
    let x = 20, y = 70, width = 330, height = 410, mode = 'expanded';
    let positioned = false, settledPosition = null;
    const positions = {expanded: {x, y}, collapsed: {x, y}};
    function viewport() {
        const v = window.visualViewport;
        if (v?.width && v?.height) return {left: v.offsetLeft, top: v.offsetTop, width: v.width, height: v.height};
        return {left: 0, top: 0, width: innerWidth, height: innerHeight};
    }
    function layout() {
        const v = viewport();
        const w = Math.min(v.width, width), h = Math.min(v.height, height);
        Object.assign(frame.style, {
            width: w + 'px', height: h + 'px',
            left: clamp(x, v.left, v.left + v.width - w) + 'px',
            top: clamp(y, v.top, v.top + v.height - h) + 'px'
        });
    }
    function reportViewport() {
        layout();
        const {width, height} = viewport();
        send({type: 'viewport', width, height});
    }
    function restore(view) {
        for (const name of Object.keys(positions)) {
            const p = view?.positions?.[name];
            if (p && finite(p.x, p.y)) positions[name] = {x: p.x, y: p.y};
        }
        ({x, y} = positions[mode]);
        layout();
    }
    function receive(data) {
        if (data.type === 'ready') reportViewport();
        if (data.type === 'layout' && finite(data.width, data.height) && data.width > 0 && data.height > 0
            && Array.isArray(data.regions) && data.regions.length <= 2
            && data.regions.every(r => Array.isArray(r) && r.length === 4 && finite(...r) && r.every(v => Math.abs(v) < 10_000))) {
            const next = data.collapsed ? 'collapsed' : 'expanded';
            if (!positioned || mode !== next) {
                if (positioned) positions[mode] = settledPosition ?? {x, y};
                mode = next;
                ({x, y} = positions[mode]);
                settledPosition = null;
                positioned = true;
            }
            if (data.expandedPanel && !settledPosition) settledPosition = {x, y};
            if (!data.expandedPanel && settledPosition) {
                ({x, y} = settledPosition);
                settledPosition = null;
            }
            width = data.width;
            height = data.height;
            layout();
            const path = data.regions.map(([rx, ry, rw, rh]) => `M${rx} ${ry}H${rx + rw}V${ry + rh}H${rx}Z`).join(' ');
            frame.style.clipPath = path ? `path("${path}")` : '';
        }
        if (data.type === 'drag' && finite(data.dx, data.dy)) {
            const before = {x: parseFloat(frame.style.left), y: parseFloat(frame.style.top)};
            x = before.x + clamp(data.dx, -200, 200);
            y = before.y + clamp(data.dy, -200, 200);
            layout();
            x = parseFloat(frame.style.left);
            y = parseFloat(frame.style.top);
            if (settledPosition) {
                settledPosition.x += x - before.x;
                settledPosition.y += y - before.y;
            }
            positions[mode] = settledPosition ?? {x, y};
        }
        if (data.type === 'view' && finite(data.scale) && typeof data.collapsed === 'boolean') {
            positions[mode] = settledPosition ?? {x, y};
            saveView({scale: clamp(data.scale, .48, 1.7), collapsed: data.collapsed, positions});
        }
    }
    window.addEventListener('resize', reportViewport);
    window.visualViewport?.addEventListener('resize', reportViewport);
    window.visualViewport?.addEventListener('scroll', reportViewport);
    document.addEventListener('pointerdown', event => {
        if (!frame.hidden && settledPosition && event.target !== frame) send({type: 'outside-dismiss'});
    }, true);
    return {restore, receive, reportViewport};
}
