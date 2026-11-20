import {counter, newId, readRecord, validId} from './wire.js';

const namespace = 'pocket-familiar';
const slots = ['save-a', 'save-b'];
const recordFields = ({id, revision, json, checksum}) => ({id, revision, json, checksum});
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function selectHostStore(getTavern) {
    const ready = window.__TAURITAVERN__?.ready ?? window.__TAURITAVERN_MAIN_READY__;
    await ready;
    const tt = window.__TAURITAVERN__;
    const store = tt?.api?.extension?.store;
    if (typeof store?.tryGetJson === 'function' && typeof store.setJson === 'function') return store;
    if (tt || ready) throw Error('TauriTavern extension store unavailable');
    return createSillyTavernStore(getTavern);
}

export function createSillyTavernStore(getTavern) {
    let reading = null;
    function context() {
        const tavern = getTavern();
        if (!isObject(tavern?.extensionSettings) || typeof tavern.getRequestHeaders !== 'function'
            || typeof tavern.saveSettingsDebounced !== 'function') throw Error('SillyTavern extension settings unavailable');
        return tavern;
    }
    async function readSettings(tavern) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 1500);
        try {
            const response = await fetch('/api/settings/get', {
                method: 'POST', headers: tavern.getRequestHeaders(), body: '{}',
                cache: 'no-store', credentials: 'same-origin', signal: controller.signal
            });
            if (!response.ok) throw Error('SillyTavern settings read failed');
            const data = await response.json();
            const settings = typeof data.settings === 'string' ? JSON.parse(data.settings) : data.settings;
            if (!isObject(settings)) throw Error('Invalid SillyTavern settings response');
            const extensions = settings.extension_settings;
            if (extensions === undefined || isObject(extensions) && !Object.hasOwn(extensions, namespace)) return undefined;
            if (!isObject(extensions?.[namespace])) throw Error('Invalid Pocket Familiar settings');
            return extensions[namespace];
        } finally {
            clearTimeout(timeout);
        }
    }
    function read(tavern) {
        reading ??= readSettings(tavern).finally(() => { reading = null; });
        return reading;
    }
    return {
        async tryGetJson({key}) {
            const stored = await read(context());
            return stored && Object.hasOwn(stored, key) ? {found: true, value: stored[key]} : {found: false};
        },
        async setJson({key, value}) {
            const tavern = context();
            const settings = tavern.extensionSettings;
            const before = await read(tavern);
            const candidate = {...before, [key]: value};
            let observed = before;
            settings[namespace] = candidate;
            try {
                if (same(candidate, before)) return;
                // The documented host debounce queues the write. It is only
                // acknowledged after the host's settings endpoint returns it.
                tavern.saveSettingsDebounced();
                for (const wait of [1100, 350, 700, 1100]) {
                    await delay(wait);
                    try { observed = await readSettings(tavern); } catch { continue; }
                    if (same(observed, candidate)) return;
                    if (!same(observed, before)) throw Error('SillyTavern settings changed during save');
                }
                throw Error('SillyTavern settings save unconfirmed');
            } finally {
                if (settings[namespace] === candidate && !same(observed, candidate)) {
                    if (observed === undefined) delete settings[namespace];
                    else settings[namespace] = observed;
                }
            }
        }
    };
}

export function createStorage(getStore) {
    let queue = Promise.resolve();
    const read = async key => {
        const store = await getStore();
        const result = await store.tryGetJson({namespace, key});
        if (result?.found === false) return {key, found: false};
        if (result?.found !== true) throw Error('Invalid host store response');
        return {key, found: true, value: result.value};
    };
    const write = async (key, value) => (await getStore()).setJson({namespace, key, value});

    // Share one queue even when the iframe reconnects. The Web Lock also covers
    // multiple instances on the same host origin when supported by the WebView.
    const run = work => {
        const request = queue.then(() => navigator.locks?.request
            ? navigator.locks.request(namespace, work) : work());
        queue = request.catch(() => {});
        return request;
    };

    async function snapshots() {
        const entries = await Promise.all(slots.map(async key => {
            try {
                return await read(key);
            } catch (error) {
                // TT v2.4.0 wraps JSON.parse errors with the original cause.
                if (error?.cause instanceof SyntaxError) return {key, found: true};
                throw error;
            }
        }));
        const good = entries.filter(entry => readRecord(entry.value))
            .sort((a, b) => b.value.revision - a.value.revision);
        if (good.length === 2 && good[0].value.revision === good[1].value.revision
            && good[0].value.id !== good[1].value.id) return {entries, good: [], status: 'corrupt'};
        const status = good.length ? entries.some(entry => entry.found && !good.includes(entry)) ? 'recovered' : 'ok'
            : entries.some(entry => entry.found) ? 'corrupt' : 'empty';
        return {entries, good, status};
    }

    function load() {
        return run(async () => {
            const {good, status} = await snapshots();
            return {status, records: good.map(entry => recordFields(entry.value))};
        });
    }

    function commit({base, keep, record}) {
        if (!(base === null || validId(base)) || !(keep === null || validId(keep)) || !readRecord(record)) {
            return Promise.resolve('invalid');
        }
        return run(async () => {
            const {entries, good, status} = await snapshots();
            if (status === 'corrupt') return 'corrupt';
            const latest = good[0]?.value;
            if (latest?.id === record.id) {
                return latest.json === record.json ? 'ok' : 'invalid';
            }
            if ((latest?.id ?? null) !== base || record.revision <= (latest?.revision ?? 0)) return 'conflict';
            const preserved = good.find(entry => entry.value.id === keep);
            if ((latest && !preserved) || (!latest && keep !== null) || good.some(entry => entry.value.id === record.id)) return 'invalid';
            const destination = entries.find(entry => entry !== preserved);
            // Only replace the other slot, leaving the validated snapshot intact.
            await write(destination.key, recordFields(record));
            return 'ok';
        });
    }

    async function generation() {
        const {found, value} = await read('generations');
        if (!found) return null;
        if (!validId(value?.id) || !counter(value.total) || !Array.isArray(value.recent)
            || value.recent.length > 128 || !value.recent.every(validId)) throw Error('Invalid generation ledger');
        return value;
    }

    function countGeneration(id) {
        return run(async () => {
            const previous = await generation() ?? {id: newId(), total: 0, recent: []};
            if (previous.recent.includes(id)) return previous;
            if (!counter(previous.total + 1)) throw Error('Generation total exceeds safe range');
            const next = {...previous, total: previous.total + 1, recent: [...previous.recent.slice(-127), id]};
            await write('generations', next);
            return next;
        });
    }

    return {load, commit, generation: () => run(generation), countGeneration, read,
        write: (key, value) => run(() => write(key, value))};
}
