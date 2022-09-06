// @ts-check

/** @typedef {{name: string, type: string, size: number, updatedTime: number, [k:string]: any}} RTCFileSystemFileStat */

class RTCFileSystemClient {
    constructor() {
        /** @type {(WebSocket | RTCDataChannel)[]} */
        this.sockets = [];
        this.available = false;
        this.disconnectDelayMs = 5000;
        this.ondisconnected = null;
        this._disconnectTimer = null;
        this._seq = 0;
        /** @type {Record<string, {resolve:any, reject:any}>} */
        this._req = {};
    }
    /** @returns {Promise<RTCFileSystemFileStat>} */
    async stat(path) {
        return await this._request({ op: 'stat', path: path });
    }
    /** @returns {Promise<RTCFileSystemFileStat[]>} */
    async files(path, offset = 0, limit = -1) {
        return await this._request({ op: 'files', path: path, p: offset, l: limit });
    }
    /** @returns {Promise<ArrayBuffer>} */
    async read(path, offset, len) {
        return await this._request({ op: 'read', path: path, p: offset, l: len });
    }
    /** @returns {Promise<number>} */
    async write(path, offset, data) {
        return await this._request({ op: 'write', path: path, p: offset, b: data });
    }
    /** @returns {Promise<boolean>} */
    async remove(path) {
        return await this._request({ op: 'remove', path: path });
    }

    readStream(path, pos, end) {
        const blockSize = 32768;
        let queue = [];
        let prefetch = () => {
            if (pos < end) {
                let sz = Math.min(end - pos, blockSize);
                queue.push(this.read(path, pos, sz));
                pos += sz;
            }
        };
        return new ReadableStream({
            // @ts-ignore
            type: 'bytes',
            start: (_controller) => {
                for (let i = 0; i < 16; i++) {
                    prefetch();
                }
            },
            pull: async (controller) => {
                let buf = await queue.shift();
                if (buf.byteLength > 0) {
                    controller.enqueue(new DataView(buf));
                    prefetch();
                }
                if (queue.length == 0) {
                    controller.close();
                }
            }
        });
    }

    async _request(req) {
        if (this.sockets.length == 0) { throw 'no_connection'; }
        let rid = ++this._seq;
        req.rid = rid;
        return new Promise((resolve, reject) => {
            this._req[rid] = { resolve, reject };
            this.sockets[0].send(JSON.stringify(req));
        });
    }

    /**
     * @param {MessageEvent} ev
     */
    async handleEvent(ev) {
        if (typeof ev.data === "string") {
            await this._handleResponse(JSON.parse(ev.data));
        } else {
            /** @type {ArrayBuffer} */
            let buf = ev.data;
            if (buf.byteLength >= 8) {
                let v = new DataView(buf);
                await this._handleResponse({ rid: v.getUint32(4, true), data: buf.slice(8) });
            }
        }
    }

    async _handleResponse(msg) {
        let req = this._req[msg.rid];
        if (req) {
            delete this._req[msg.rid];
            msg.error ? req.reject(msg.error) : req.resolve(msg.data);
        }
    }

    addSocket(socket) {
        clearTimeout(this._disconnectTimer);
        this._disconnectTimer = null;
        this.sockets.push(socket);
        this.available = true;
    }
    removeSocket(socket) {
        this.sockets = this.sockets.filter(s => s != socket);
        if (this.sockets.length == 0) {
            this.reset();
            this._disconnectTimer = setTimeout(() => {
                this.available = false;
                this.ondisconnected?.();
            }, this.disconnectDelayMs);
        }
    }
    reset() {
        for (let r of Object.values(this._req)) { r.reject('reset'); }
        this._req = {};
        this.sockets = [];
    }
}

/** @typedef {{name: string, type: string, size: number, updatedTime: number, tags: string[], path:string, thumbnail:any, [k:string]: any}} RTCFileSystemClientFile */

class RTCFileSystemClientFolder {
    /**
     * @param {RTCFileSystemClient} client 
     * @param {string} name
     * @param {string} path 
     * @param {Record<string, any>} options 
     */
    constructor(client, path, name, options = {}) {
        this.name = name;
        this.path = path;
        this.size = -1; // unknown size
        this._client = client;
        this._options = options;
        this._pageSize = 100;
        this._pageCacheMax = 5;
        /** @type {Map<number, {value?: RTCFileSystemClientFile[], task?: Promise<RTCFileSystemClientFile[]>, ac?: AbortController}>} */
        this._pageCache = new Map();
        this.onupdate = null;
    }

    async init() {
        await this.get(0)
    }

    /**
     * @returns {Promise<RTCFileSystemClientFile>}
     */
    async get(position) {
        if (position < 0 || this.size >= 0 && position >= this.size) throw "out of range";
        if (!this._client.available) {
            return null;
        }
        let item = this._getOrNull(position);
        if (item != null) {
            return item;
        }
        let result = await this._load(position / this._pageSize | 0);
        return result && result[position % this._pageSize];
    }
    /**
     * @returns {string}
     */
    getParentPath() {
        if (this.path == '' || this.path == '/') {
            return null;
        }
        return this.path.substring(0, this.path.lastIndexOf('/'));
    }
    _getOrNull(position) {
        let page = position / this._pageSize | 0;
        let cache = this._pageCache.get(page);
        if (cache) {
            this._pageCache.delete(page);
            this._pageCache.set(page, cache);
            return cache.value?.[position - this._pageSize * page];
        }
        return null;
    }

    /** @returns {Promise<RTCFileSystemClientFile[]>} */
    async _load(page) {
        let cache = this._pageCache.get(page);
        if (cache != null) {
            return (cache.task) ? await cache.task : cache.value;;
        }
        for (const [p, c] of this._pageCache) {
            if (this._pageCache.size < this._pageCacheMax) {
                break;
            }
            console.log("invalidate: " + p, c.task != null);
            this._pageCache.delete(p);
            c.ac?.abort();
        }

        let ac = new AbortController();
        let task = (async (signal) => {
            await new Promise((resolve) => setTimeout(resolve, this._pageCache.size));
            console.log("fetch page:", page, signal.aborted);
            if (signal.aborted) { throw 'abort'; }
            let offset = page * this._pageSize;
            let files = await this._client.files(this.path, offset, this._pageSize);

            let dir = this.path != '' ? this.path + '/' : '';
            let client = this._client;
            let items = files.map(f => ({
                name: f.name,
                type: f.type == 'directory' ? 'folder' : f.type,
                size: f.size,
                updatedTime: f.updatedTime,
                tags: f.metadata?.tags || [],
                path: dir + f.name,
                async fetch(start = 0, end = -1) {
                    return new Response(client.readStream(dir + f.name, start, end < 0 ? f.size : end), { headers: { 'Content-Type': f.type, 'Content-Length': '' + f.size } });
                },
                update(blob) { return client.write(dir + f.name, 0, blob); },
                remove() { return client.remove(dir + f.name); },
                thumbnail: f.metadata?.thumbnail ? {
                    type: 'image/jpeg',
                    async fetch(start = 0, end = -1) {
                        return new Response(client.readStream(dir + f.name + f.metadata?.thumbnail, start, end < 0 ? 32768 : end), { headers: { 'Content-Type': 'image/jpeg' } });
                    }
                } : null,
            }));
            return items;
        })(ac.signal);
        try {
            this._pageCache.set(page, { task, ac });
            let result = await task;
            if (result.length > 0) {
                let sz = page * this._pageSize + result.length + (result.length >= this._pageSize ? 1 : 0);
                if (sz > this.size) {
                    this.size = sz;
                    this.onupdate?.();
                }
            }
            if (this._pageCache.has(page)) {
                this._pageCache.set(page, { value: result });
            }
            return result;
        } catch (e) {
            this._pageCache.delete(page);
        }
    }
}

class RTCFileSystemManager {
    constructor() {
        /** @type {Record<string,RTCFileSystemClient>} */
        this._clients = {};
    }

    /**
     * @param {string} id host unique string (roomId)
     * @param {string} name volume name
     * @returns 
     */
    getRtcChannelSpec(id, name) {
        return {
            onopen: (ch, _ev) => {
                ch.binaryType = 'arraybuffer';
                if (!this._clients[id]) {
                    this._clients[id] = new RTCFileSystemClient();
                    console.log('FileSystemClient: connected ' + id);
                    if (globalThis.storageAccessors) {
                        globalThis.storageAccessors[id] = {
                            name: name,
                            root: '',
                            shortcuts: {},
                            getList: (folder, options) => new RTCFileSystemClientFolder(this._clients[id], folder, folder || name, options)
                        };
                    }
                    this._clients[id].ondisconnected = () => {
                        console.log('FileSystemClient: disconnected ' + id);
                        this._clients[id].ondisconnected = null;
                        delete this._clients[id];
                        if (globalThis.storageAccessors) {
                            delete globalThis.storageAccessors[id];
                        }
                    };
                }
                this._clients[id].addSocket(ch);
            },
            onclose: (ch, _ev) => {
                this._clients[id]?.removeSocket(ch);
            },
            onmessage: (_ch, ev) => this._clients[id].handleEvent(ev)
        };
    }
}

// Install storage accessor for WebXR client storage.
// player.dataChannels['fileServer'] = rtcFileSystemManager.getRtcChannelSpec(roomId, name);
globalThis.rtcFileSystemManager = new RTCFileSystemManager();
