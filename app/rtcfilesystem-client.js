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
    /** @returns {Promise<number>} */
    async writeBytes(path, offset, data) {
        let b64 = btoa(String.fromCharCode(...data));
        return await this._request({ op: 'write', path: path, p: offset, b: b64 });
    }
    /** @returns {Promise<boolean>} */
    async truncate(path, pos) {
        return await this._request({ op: 'truncate', path: path, p: pos });
    }
    /** @returns {Promise<boolean>} */
    async remove(path) {
        return await this._request({ op: 'remove', path: path });
    }
    /** @returns {Promise<boolean>} */
    async rename(path, path2) {
        return await this._request({ op: 'rename', path: path, path2: path2 });
    }
    /** @returns {Promise<boolean>} */
    async mkdir(path) {
        return await this._request({ op: 'mkdir', path: path });
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

    writeStream(path, options = {}) {
        const blockSize = 32768 / 4 * 3; // BASE64
        let pos = options.start || 0;
        return new WritableStream({
            start: async (_controller) => {
                if (!options.keepExistingData) {
                    this.truncate(path, 0);
                }
            },
            write: async (/** @type {Uint8Array&{type: string, [key:string]:any}} */ chunk, _controller) => {
                if (chunk.type == 'seek') {
                    pos = chunk.position;
                    return;
                }
                let l = chunk.byteLength;
                for (let p = 0; p < l; p += blockSize) {
                    // TODO: prevent memcopy
                    await this.writeBytes(path, pos + p, chunk.slice(p, p + blockSize));
                }
                pos += l;
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
        let items = files.map(f => this._procFile(f));
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
    mkdir(name, options = {}) {
        return this._client.mkdir((this.path != '' ? this.path + '/' : '') + name);
    }
    async writeFile(name, blob, options = {}) {
        let path = (this.path != '' ? this.path + '/' : '') + name;
        await blob.stream().pipeTo(this._client.writeStream(path));
    }
    _procFile(f) {
        let client = this._client;
        let dir = this.path != '' ? this.path + '/' : '';
        return ({
            name: f.name,
            type: f.type == 'directory' ? 'folder' : f.type,
            size: f.size,
            lastModified: f.updatedTime,
            updatedTime: f.updatedTime,
            tags: f.metadata?.tags || [],
            path: this._pathPrefix + dir + f.name,
            stream(start = 0, end = -1) { return client.readStream(dir + f.name, start, end < 0 ? f.size : end); },
            async createWritable(options = {}) { return client.writeStream(dir + f.name, options); },
            async fetch(start = 0, end = -1) {
                return new Response(client.readStream(dir + f.name, start, end < 0 ? f.size : end), { headers: { 'Content-Type': f.type, 'Content-Length': '' + f.size } });
            },
            update(blob) { return blob.stream().pipeTo(client.writeStream(dir + f.name)); },
            remove() { return client.remove(dir + f.name); },
            rename(name) { return client.rename(dir + f.name, dir + name); },
            thumbnail: f.metadata?.thumbnail ? {
                type: 'image/jpeg',
                async fetch(start = 0, end = -1) {
                    return new Response(client.readStream(dir + f.name + f.metadata?.thumbnail, start, end < 0 ? 32768 : end), { headers: { 'Content-Type': 'image/jpeg' } });
                }
            } : null,
        });
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
    static _registered = {};
    registerAll(connectionFactory, roomIdPrefix = '') {
        globalThis.storageAccessors ||= {};
        function add(roomId, signalingKey, password, name) {
            if (RTCFileSystemManager._registered[roomId]) {
                return;
            }
            RTCFileSystemManager._registered[roomId] = true;
            let client = new RTCFileSystemClient();
            /** @type {PlayerConnection|null} */
            let player = null;
            let id = roomId.startsWith(roomIdPrefix) ? roomId.substring(roomIdPrefix.length) : roomId;
            globalThis.storageAccessors[id] = {
                name: name,
                detach: () => player && player.dispose(),
                getFolder(path, prefix) {
                    if (player == null) {
                        player = connectionFactory(signalingKey, roomId);
                        player.authToken = password;
                        player.dataChannels['fileServer'] = {
                            onopen: (ch, _ev) => client.addSocket(ch, false),
                            onclose: (ch, _ev) => client.removeSocket(ch),
                            onmessage: (_ch, ev) => client.handleEvent(ev),
                        };
                        player.onauth = (ok) => {
                            if (!ok) {
                                player.disconnect();
                                return;
                            }
                            client.setAvailable(true);
                        };
                        player.onstatechange = (state, oldState, reason) => {
                            if (state == 'disconnected' && reason != 'redirect') {
                                player = null;
                            }
                        };
                        player.connect();
                    }
                    return new RTCFileSystemClientFolder(client, path, prefix);
                },
                parsePath: (path) => path ? path.split('/').map(p => [p]) : [],
            };
        }

        // see https://github.com/binzume/webrtc-rdp
        let config = JSON.parse(localStorage.getItem('webrtc-rdp-settings') || 'null') || { devices: [] };
        let devices = config.devices != null ? config.devices : [config];
        for (let device of devices) {
            let name = (device.name || device.userAgent || device.roomId).substring(0, 64);
            add(device.roomId, device.signalingKey, device.token, name);
        }
    }
}

// Install storage accessor for WebXR client storage.
// player.dataChannels['fileServer'] = rtcFileSystemManager.getRtcChannelSpec(roomId, name);
globalThis.rtcFileSystemManager = new RTCFileSystemManager();
