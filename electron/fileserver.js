
// @ts-check

// @ts-ignore
/** @typedef {FileSystemHandleArray} FileSystemHandle2 */

class FileSystemHandleArray {
    constructor(name = '') {
        /** @type {Record<string,FileSystemHandle2>} */
        this._entries = {};
        this.name = name;
        /** @type {FileSystemHandleKind} */
        this.kind = 'directory';
    }

    /**
     * @param {FileSystemHandle2} ent 
     * @param {string} name 
     */
    addEntry(ent, name = null) { this._entries[name || ent.name] = ent; }

    // FileSystemDirectoryHandle
    /**
     * @returns { {[Symbol.asyncIterator](): AsyncGenerator<FileSystemHandle2, void, unknown>}}
     */
    values() { return this._asyncIterator(Object.values(this._entries)); }
    keys() { return this._asyncIterator(Object.keys(this._entries)); }
    entries() { return this._asyncIterator(Object.entries(this._entries)); }
    async getFileHandle(name, _options = null) { return this._entries[name]; }
    async getDirectoryHandle(name, _options = null) { return this._entries[name]; }
    async removeEntry(name) { delete this._entries[name]; }
    async resolve(possibleDescendant) { return []; }

    // FileSystemHandle
    isSameEntry(ent) { return Promise.resolve(ent === this); }
    queryPermission(_options = null) { return Promise.resolve('granted'); }
    /**
     * @param {{mode: string}} _options 
     * @returns {Promise<string>}
     */
    async requestPermission(_options = null) {
        let ok = true;
        for (let handle of Object.values(this._entries)) {
            ok = (await handle.requestPermission({ mode: 'readwrite' }) == 'granted') && ok;
        }
        return ok ? 'granted' : 'denied';
    }
    _asyncIterator(array) {
        return {
            async *[Symbol.asyncIterator]() { for (let ent of array) { yield ent; } }
        }
    }
    /**  @return {Promise<File>}     */
    async getFile() { throw "not a file"; }
    /**  @return {Promise<WritableStream&{seek:any, write:any, truncate:any}>}     */
    async createWritable(_options) { throw "not a file"; }
}

class FileSystemWrapper {
    /**
     * @param {FileSystemHandle2} handle 
     */
    constructor(handle) {
        this.writable = false;
        this.handle = handle;
    }

    async setWritable(writable) {
        this.writable = writable;
        if (writable) {
            return await this.handle.requestPermission({ mode: 'readwrite' }) === 'granted';
        }
    }
    async stat(path) {
        return await this.statInternal(await this.resolvePath(path));
    }
    async files(path, offset = 0, limit = -1) {
        let h = await this.resolvePath(path, 'directory');
        if (limit == 0) { return []; }
        let fileTasks = [];
        let pos = 0;
        for await (let ent of h.values()) {
            if (pos++ < offset) { continue; }
            fileTasks.push(this.statInternal(ent));
            if (limit > 0 && fileTasks.length >= limit) { break; }
        }
        return Promise.all(fileTasks);
    }
    async read(path, offset, len) {
        if (path.endsWith("/#thumbnail.jpeg")) {
            path = path.split('/#')[0];
            let file = await this.resolveFile(path);
            let blob = await this.createThumbnail(file);
            return blob.slice(offset);
        }
        let file = await this.resolveFile(path);
        return file.slice(offset, offset + len);
    }
    async write(path, offset, data) {
        if (!this.writable) { throw 'readonly'; }
        let handle = await this.resolvePath(path, 'file');
        let writer = await handle.createWritable({ keepExistingData: true });
        await writer.seek(offset);
        await writer.write(offset, data);
        await writer.close();
        return data.length;
    }
    async remove(path) {
        if (!this.writable) { throw 'readonly'; }
        // TODO
        return false;
    }

    /**
     * @param {string} path
     * @return {Promise<FileSystemHandle2>}
     */
    async resolvePath(path, kind = null) {
        let p = path.split('/');
        let h = this.handle;
        let wrap = async (/** @type {Promise<FileSystemHandle2>} */ t) => { try { return await t; } catch { } };
        for (let i = 0; i < p.length; i++) {
            if (p[i] == '' || p[i] == '.') { continue; }
            let c = await ((i == p.length - 1 && kind == 'file') ? wrap(h.getFileHandle(p[i])) : wrap(h.getDirectoryHandle(p[i])));
            if (!c && kind == null) { c = await wrap(h.getFileHandle(p[i])); }
            if (!c) throw 'noent';
            h = c;
        }
        return h;
    }
    /**
     * @param {string} path
     * @return {Promise<File>}
     */
    async resolveFile(path) {
        return await (await this.resolvePath(path, 'file')).getFile();
    }

    /**
     * @param {FileSystemHandle2} handle 
     */
    async statInternal(handle) {
        if (handle.kind == 'file') {
            let f = await handle.getFile();
            let stat = { type: f.type || 'file', name: f.name, size: f.size, updatedTime: f.lastModified }
            if (["image/jpeg", "image/png", "image/gif", "image/webp", "image/bmp"].includes(f.type)) {
                stat.metadata = { thumbnail: "#thumbnail.jpeg" };
            }
            return stat;
        } else {
            return { type: 'directory', size: 0, name: handle.name, updatedTime: null }
        }
    }

    /**
     * @param {Blob} file 
     * @returns {Promise<Blob>}
     */
    async createThumbnail(file, maxWidth = 200, maxHeight = 200) {
        let canvas = document.createElement("canvas");
        let drawThumbnail = (image, w, h) => {
            if (w > maxWidth) {
                h = h * maxWidth / w;
                w = maxWidth;
            }
            if (h > maxHeight) {
                w = w * maxHeight / h;
                h = maxHeight;
            }
            canvas.width = w;
            canvas.height = h;
            let ctx = canvas.getContext("2d");
            ctx.drawImage(image, 0, 0, w, h);
        };
        let objectUrl = URL.createObjectURL(file);
        let media;
        try {
            if (file.type.startsWith("video")) {
                // TODO detect background tab
                media = document.createElement('video');
                media.muted = true;
                media.autoplay = true;
                await new Promise((resolve, reject) => {
                    media.onloadeddata = resolve;
                    media.onerror = reject;
                    media.src = objectUrl;
                    setTimeout(reject, 3000);
                });
                await new Promise((resolve, reject) => {
                    media.onseeked = resolve;
                    media.currentTime = 3;
                    setTimeout(resolve, 500);
                });
                drawThumbnail(media, media.videoWidth, media.videoHeight);
            } else {
                media = new Image();
                await new Promise((resolve, reject) => {
                    media.onload = resolve;
                    media.onerror = reject;
                    media.src = objectUrl;
                });
                drawThumbnail(media, media.naturalWidth, media.naturalHeight);
            }
        } finally {
            URL.revokeObjectURL(objectUrl);
        }
        if (media) {
            media.src = "";
        }
        return await new Promise((resolve, _) => canvas.toBlob(resolve, "image/jpeg", 0.8));
    }
}

class FileServer {
    constructor(handle) {
        this.fs = new FileSystemWrapper(handle);
    }
    /**
     * @param {*} cmd 
     * @param {RTCDataChannel} socket 
     */
    async handleCommand(cmd, socket) {
        let fs = this.fs;
        try {
            switch (cmd.op) {
                case "stat":
                    let st = await fs.stat(cmd.path);
                    socket.send(JSON.stringify({ rid: cmd.rid, data: st }));
                    break;
                case "files":
                    socket.send(JSON.stringify({ rid: cmd.rid, data: await fs.files(cmd.path, cmd.p, cmd.l) }));
                    break;
                case "read":
                    let data = await fs.read(cmd.path, cmd.p, cmd.l);
                    socket.send(await new Blob([Uint32Array.from([0, cmd.rid]), data]).arrayBuffer()); //TODO: endian
                    break;
                case "write":
                    let l = await fs.write(cmd.path, cmd.p, cmd.b);
                    socket.send(JSON.stringify({ rid: cmd.rid, data: l }));
                    break;
                case "remove":
                    socket.send(JSON.stringify({ rid: cmd.rid, data: await fs.remove(cmd.path) }));
                    break;
                default:
                    throw 'invalid_operation';
            }
        } catch (e) {
            if (cmd.rid) {
                socket.send(JSON.stringify({ rid: cmd.rid, error: (typeof e == 'string') ? e : 'internal_error' }));
            }
            if (typeof e != 'string') { throw e; }
        }
    }

    getRtcChannelSpec() {
        return {
            /**
             * @param {RTCDataChannel} ch 
             * @param {MessageEvent} ev
             */
            onmessage: (ch, ev) => this.handleCommand(JSON.parse(ev.data), ch)
        };
    }
}

class FileSystemClient {
    constructor() {
        this.socket = null;
        this._seq = 0;
        this._req = {};
    }
    async stat(path) {
        return await this._request({ op: 'stat', path: path });
    }
    async files(path, offset = 0, limit = -1) {
        return await this._request({ op: 'files', path: path, p: offset, l: limit });
    }
    async read(path, offset, len) {
        return await this._request({ op: 'read', path: path, p: offset, l: len });
    }
    async write(path, offset, data) {
        return await this._request({ op: 'write', path: path, p: offset, b: data });
    }
    async remove(path) {
        return await this._request({ op: 'remove', path: path });
    }
    async _request(req) {
        let rid = ++this._seq;
        req.rid = rid;
        if (!this.socket) {
            throw 'disconnected';
        }
        return new Promise((resolve, reject) => {
            this._req[rid] = { resolve, reject };
            this.socket.send(JSON.stringify(req));
        });
    }

    /**
     * @param {ArrayBuffer} buf
     */
    async handleMessageBinary(buf) {
        if (buf.byteLength < 8) {
            return;
        }
        let v = new DataView(buf);
        this.handleMessage({ rid: v.getUint32(4, true), data: buf.slice(8) });
    }

    async handleMessage(msg) {
        let req = this._req[msg.rid];
        if (req) {
            delete this._req[msg.rid];
            msg.error ? req.reject(msg.error) : req.resolve(msg.data);
        }
    }

    reset() {
        for (let r of Object.values(this._req)) { r.reject('reset'); }
    }
    getRtcChannelSpec() {
        return {
            onopen: (ch, _ev) => {
                console.log('FileSystemClient: connected');
                this.socket = ch; // TODO: multiple connections
            },
            onclose: (ch, _ev) => {
                if (this.socket == ch) { this.socket = null; }
            },
            /**
             * @param {RTCDataChannel} ch 
             * @param {MessageEvent} ev
             */
            onmessage: (ch, ev) => {
                if (typeof ev.data === "string") {
                    this.handleMessage(JSON.parse(ev.data));
                } else {
                    this.handleMessageBinary(ev.data);
                }
            }
        };
    }

    install(name) {
        if (globalThis.storageAccessors[name]) {
            return;
        }
        globalThis.storageAccessors[name] = {
            name: name,
            root: '',
            shortcuts: {},
            getList: (folder, options) => new FileSystemClientFileList(this, folder, options)
        };
    }
    uninstall(name) {
        delete globalThis.storageAccessors[name];
    }
}

class FileSystemClientFileList {
    constructor(client, path, options = {}) {
        this.client = client;
        this.itemPath = path;
        this.options = options;
        this.size = -1;
        this.name = "";
        this.thumbnailUrl = null;

        this._pageSize = 200;
        /** @type {Map<number, [page: any] | [Promise, AbortController]>} */
        this._pageCache = new Map();
        this._pageCacheMax = 10;
    }

    /**
     * @returns {Promise<void>}
     */
    async init() {
        await this.get(0)
    }

    /**
     * @returns {Promise<any>}
     */
    async get(position) {
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
        return this.itemPath.replace(/\/[^/]+$/, '');
    }
    _getOrNull(position) {
        let page = position / this._pageSize | 0;
        let cache = this._pageCache.get(page);
        if (cache) {
            this._pageCache.delete(page);
            this._pageCache.set(page, cache);
            return cache[0][position - this._pageSize * page];
        }
        return null;
    }

    async _load(page) {
        let cache = this._pageCache.get(page);
        if (cache != null) {
            return (cache.length == 2) ? await cache[0] : cache[0];
        }
        for (const [p, c] of this._pageCache) {
            if (this._pageCache.size < this._pageCacheMax) {
                break;
            }
            console.log("invalidate: " + p, c[1] != null);
            this._pageCache.delete(p);
            c[1] != null && c[1].abort();
        }


        let ac = new AbortController();
        let task = (async (signal) => {
            await new Promise((resolve) => setTimeout(resolve, this._pageCache.size));
            console.log("fetch page:", page, signal.aborted);
            if (signal.aborted) {
                return;
            }
            let offset = page * this._pageSize;
            let files = await this.client.files(this.itemPath, offset, this._pageSize);

            let dir = this.itemPath != '' ? this.itemPath + '/' : '';
            let client = this.client;
            /** @type {{name: string; type: string; url: string; fetch:((pos?:number)=>Promise<Response>)?; size: number?}[]} */
            let items = files.map(f => ({
                name: f.name,
                type: f.type,
                url: null, // use fetch()
                path: dir + f.name,
                size: f.size,
                tags: [this.itemPath],
                thumbnailUrl: null, // TODO load thumbnail?
                updatedTime: f.updatedTime,
                fetch(start, end) { return client.read(dir + f.name, start, end < 0 ? -1 : end - start); },
                update(blob) { return client.write(dir + f.name, 0, blob); },
                remove() { return client.remove(dir + f.name); }
            }));
            return items;
        })(ac.signal);
        try {
            this._pageCache.set(page, [task, ac]);
            let result = await task;
            if (this._pageCache.has(page)) {
                this._pageCache.set(page, [result]);
            }
            return result;
        } catch (e) {
            this._pageCache.delete(page);
        }
    }
}

class FileServerUI {
    /**
     * @param {HTMLElement} el 
     */
    constructor(el, dropAreaEl, server) {
        this.el = el;
        this.server = server;
        this.initDropArea(dropAreaEl);
    }

    initDropArea(el) {
        el.addEventListener('dragover', (ev) => ev.preventDefault());
        el.addEventListener('drop', async (ev) => {
            ev.preventDefault();
            for (const item of ev.dataTransfer.items) {
                console.log(item.kind, item.name);
                if (item.kind === 'file') {
                    // @ts-ignore
                    const entry = await item.getAsFileSystemHandle();
                    if (await entry.queryPermission({ mode: "read" }) != 'granted') {
                        continue;
                    }
                    this.server.fs.handle.addEntry(entry);
                    // TODO: add to list UI
                }
            }
        });
    }
}

// Install storage accessor for WebXR client storage.
// globalThis.rtcFileServerClient = new FileSystemClient();
// player.dataChannels['fileServer'] = rtcFileServerClient.getRtcChannelSpec();
// rtcFileServerClient.install('test');

globalThis.rtcFileServer = new FileServer(new FileSystemHandleArray()); // !! Global variable
window.addEventListener('DOMContentLoaded', (_ev) => {
    new FileServerUI(document.body, document.body, rtcFileServer);
}, { once: true });
