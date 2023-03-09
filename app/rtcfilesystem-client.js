// @ts-check

/** @typedef {{name: string, type: string, size: number, updatedTime: number, [k:string]: any}} RTCFileSystemFileStat */

class RTCFileSystemClient {
    constructor() {
        /** @type {(WebSocket | RTCDataChannel)[]} */
        this.sockets = [];
        this.available = false;
        this._onAvailable = null;
        this.disconnectDelayMs = 5000;
        this.ondisconnected = null;
        this._disconnectTimer = null;
        this._seq = 0;
        /** @type {Record<string, {resolve:any, reject:any}>} */
        this._req = {};
        this.setAvailable(false);
    }
    /** @returns {Promise<RTCFileSystemFileStat>} */
    async stat(path) {
        return await this._request({ op: 'stat', path: path });
    }
    /** @returns {Promise<RTCFileSystemFileStat[]>} */
    async files(path, offset = 0, limit = -1, options = null) {
        return await this._request({ op: 'files', path: path, p: offset, l: limit, options: options });
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

    addSocket(socket, ready = true) {
        socket.binaryType = 'arraybuffer';
        clearTimeout(this._disconnectTimer);
        this._disconnectTimer = 0;
        this.sockets.push(socket);
        ready && this.setAvailable(true);
    }
    setAvailable(available) {
        this.available = available;
        if (available) {
            this._onAvailable && this._onAvailable(0);
        } else {
            this._waitSocket = new Promise(r => this._onAvailable = r);
        }
    }
    async wait() {
        this.available || await this._waitSocket;
    }
    removeSocket(socket) {
        this.sockets = this.sockets.filter(s => s != socket);
        if (this.sockets.length == 0) {
            this.reset();
            this._disconnectTimer = setTimeout(() => {
                this.setAvailable(false);
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

/**
 * @implements {Folder}
 */
class RTCFileSystemClientFolder {
    /**
     * @param {RTCFileSystemClient} client 
     * @param {string} path 
     * @param {string} prefix
     */
    constructor(client, path, prefix) {
        this._client = client;
        this.path = path;
        this._pathPrefix = prefix || '';
        this.size = -1; // unknown size
        this.onupdate = null;
    }

    /** @returns {Promise<{items: FileInfo[], next: number}>} */
    async getFiles(offset, limit = 100, options = null, signal = null) {
        let filesopt = options && options.sortField ? { sort: (options.sortOrder == 'd' ? '-' : '') + options.sortField } : null;
        let client = this._client;
        await client.wait();
        signal?.throwIfAborted();
        let files = await client.files(this.path, offset, limit, filesopt);
        let dir = this.path != '' ? this.path + '/' : '';
        let items = files.map(f => ({
            name: f.name,
            type: f.type == 'directory' ? 'folder' : f.type,
            size: f.size,
            updatedTime: f.updatedTime,
            tags: f.metadata?.tags || [],
            path: this._pathPrefix + dir + f.name,
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
        let sz = offset + items.length + (items.length >= limit ? 1 : 0);
        if (sz > this.size) {
            this.size = sz;
            this.onupdate?.();
        }
        return {
            items: items,
            next: items.length >= limit ? offset + limit : null,
        };
    }

    /**
     * @returns {string}
     */
    getParentPath() {
        if (this.path == '' || this.path == '/') {
            return null;
        }
        return this._pathPrefix + this.path.substring(0, this.path.lastIndexOf('/'));
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
                            getFolder: (path, prefix) => new RTCFileSystemClientFolder(this._clients[id], path, prefix),
                            parsePath: (path) => path ? path.split('/').map(p => [p]) : [],
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
