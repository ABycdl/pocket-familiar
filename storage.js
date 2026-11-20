import {counter, newId, readRecord, validId} from './wire.js';

const namespace = 'pocket-familiar';
const slots = ['save-a', 'save-b'];
const keys = [...slots, 'generations', 'settings', 'window'];
const migrationKey = 'migration';
const recordFields = ({id, revision, json, checksum}) => ({id, revision, json, checksum});
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

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
    let migration = null;
    const filename = key => `${namespace}-${key}.json`;
    const path = key => '/user/files/' + filename(key);
    async function request(url, options) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 6000);
        try {
            const response = await fetch(url, {...options, cache: 'no-store', credentials: 'same-origin', signal: controller.signal});
            if (response.status === 404 && !options) return {found: false};
            if (!response.ok) throw Error(`SillyTavern storage request failed (${response.status})`);
            return {found: true, value: await response.json()};
        } finally {
            clearTimeout(timeout);
        }
    }
    function post(url, data) {
        const tavern = getTavern();
        if (typeof tavern?.getRequestHeaders !== 'function') throw Error('SillyTavern request headers unavailable');
        return request(url, {method: 'POST', headers: tavern.getRequestHeaders(), body: JSON.stringify(data)});
    }
    async function upload(key, value) {
        const bytes = new TextEncoder().encode(JSON.stringify(value));
        let binary = '';
        for (let i = 0; i < bytes.length; i += 32768) {
            binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
        }
        const result = await post('/api/files/upload', {name: filename(key), data: btoa(binary)});
        if (result.value?.path !== path(key)) throw Error('SillyTavern file write not confirmed');
        const saved = await request(path(key));
        if (!saved.found || !same(saved.value, value)) throw Error('SillyTavern file changed during save');
    }
    async function migrate() {
        const marker = await request(path(migrationKey));
        if (marker.found) {
            if (marker.value?.version !== 1) throw Error('Unknown Pocket Familiar storage version');
            return;
        }
        const {value: data} = await post('/api/settings/get', {});
        const settings = typeof data?.settings === 'string' ? JSON.parse(data.settings) : data?.settings;
        if (!isObject(settings)) throw Error('Invalid SillyTavern settings response');
        const legacy = settings.extension_settings?.[namespace];
        if (legacy !== undefined && !isObject(legacy)) throw Error('Invalid Pocket Familiar settings');
        // A previous migration may have stopped halfway through. Keep files
        // already copied and write the marker only when every key is migrated.
        await Promise.all(keys.filter(key => legacy && Object.hasOwn(legacy, key)).map(async key => {
            if (!(await request(path(key))).found) await upload(key, legacy[key]);
        }));
        await upload(migrationKey, {version: 1});
    }
    function ensureMigrated() {
        migration ??= migrate().catch(error => {
            migration = null;
            throw error;
        });
        return migration;
    }
    function checkKey(key) {
        if (!keys.includes(key)) throw Error('Unknown Pocket Familiar storage key');
    }
    return {
        async tryGetJson({key}) {
            checkKey(key);
            await ensureMigrated();
            try {
                return await request(path(key));
            } catch (error) {
                if (error instanceof SyntaxError) throw Error('Invalid Pocket Familiar file', {cause: error});
                throw error;
            }
        },
        async setJson({key, value}) {
            checkKey(key);
            await ensureMigrated();
            await upload(key, value);
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
