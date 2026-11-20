export const CHANNEL = 'pocket-familiar-tt';
export const VERSION = 1;
export const MAX_LENGTH = 8 * 1024 * 1024;
export const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
export const validId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
export const counter = value => Number.isSafeInteger(value) && value >= 0;
export const packet = (type, fields = {}) => ({channel: CHANNEL, version: VERSION, type, ...fields});
export const isPacket = value => value?.channel === CHANNEL && value.version === VERSION && typeof value.type === 'string';

// Hash the exact string so the native JSON serializer cannot change key order.
function checksum(json) {
    let hash = 2166136261;
    for (let i = 0; i < json.length; i++) hash = Math.imul(hash ^ json.charCodeAt(i), 16777619);
    return (hash >>> 0).toString(16).padStart(8, '0');
}

export function makeRecord(save) {
    const json = JSON.stringify(save);
    return {id: newId(), revision: save.revision, json, checksum: checksum(json)};
}

export function readRecord(record) {
    if (!validId(record?.id) || !counter(record.revision) || typeof record.json !== 'string'
        || record.json.length > MAX_LENGTH || checksum(record.json) !== record.checksum) return null;
    try {
        const save = JSON.parse(record.json);
        if (!save || Array.isArray(save) || save.revision !== record.revision || !counter(save.version) || save.version < 1) return null;
        return save;
    } catch {
        return null;
    }
}
