
// @ts-check

/** @typedef {FileSystemHandleArray} FileSystemHandle2 */

class FileSystemHandleArray {
    constructor(name = '') {
        this.name = name;
        /** @type {FileSystemHandleKind} */
        this.kind = 'directory';
        /** @type {Record<string,FileSystemHandle2>} */
        this._entries = {};
    }

    /**
     * @param {FileSystemHandle2} ent 
     * @param {string} name 
     */
    addEntry(ent, name = null) { this._entries[name || ent.name] = ent; }

    // FileSystemHandle methods
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

    // FileSystemDirectoryHandle methods
    /** @returns { {[Symbol.asyncIterator](): AsyncGenerator<FileSystemHandle2, void, unknown>}} */
    values() { return this._asyncIterator(Object.values(this._entries)); }
    keys() { return this._asyncIterator(Object.keys(this._entries)); }
    entries() { return this._asyncIterator(Object.entries(this._entries)); }
    async getFileHandle(name, _options = null) { return this._entries[name]; }
    async getDirectoryHandle(name, _options = null) { return this._entries[name]; }
    async removeEntry(name) { delete this._entries[name]; }
    async resolve(possibleDescendant) { return []; }

    // FileSystemFileHandle methods
    /**  @return {Promise<File>}     */
    async getFile() { throw "not a file"; }
    /**  @return {Promise<WritableStream&{seek:any, write:any, truncate:any}>} */
    async createWritable(_options) { throw "not a file"; }

    _asyncIterator(array) {
        return { async *[Symbol.asyncIterator]() { for (let ent of array) { yield ent; } } }
    }
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
    async read(path, offset = 0, len) {
        if (path.endsWith('#thumbnail.jpeg')) {
            let file = await this.resolveFile(path.substring(0, path.lastIndexOf('#')));
            let blob = await this.createThumbnail(file);
            return blob.slice(offset, offset + len);
        }
        let file = await this.resolveFile(path);
        return file.slice(offset, offset + len);
    }
    async write(path, offset = 0, data) {
        if (!this.writable) { throw 'readonly'; }
        let handle = await this.resolvePath(path, 'file', true);
        let writer = await handle.createWritable({ keepExistingData: true });
        await writer.seek(offset);
        await writer.write(data);
        await writer.close();
        return data.length;
    }
    async truncate(path, size = 0) {
        if (!this.writable) { throw 'readonly'; }
        let handle = await this.resolvePath(path, 'file', true);
        let writer = await handle.createWritable({ keepExistingData: true });
        await writer.truncate(size);
        await writer.close();
        return true;
    }
    async mkdir(path) {
        if (!this.writable) { throw 'readonly'; }
        let handle = await this.resolvePath(path, 'directory', true);
        return handle != null;
    }
    async remove(path) {
        if (!this.writable) { throw 'readonly'; }
        let dir = '', name = path;
        let p = path.lastIndexOf('/');
        if (p > 0) {
            dir = path.substring(0, p);
            name = path.substring(p + 1);
        }
        let hdir = await this.resolvePath(dir);
        await hdir.removeEntry(name);
        return true;
    }
    async rename(path, path2) {
        if (!this.writable) { throw 'readonly'; }
        let handle = await this.resolvePath(path, 'file');
        // @ts-ignore
        if (handle && handle.move) {
            // @ts-ignore
            await handle.move(path2);
            return true;
        }
        return false;
    }

    /**
     * @param {string} path
     * @return {Promise<FileSystemHandle2>}
     */
    async resolvePath(path, kind = null, create = false) {
        let p = path.split('/');
        let h = this.handle;
        let wrap = async (/** @type {Promise<FileSystemHandle2>} */ t) => { try { return await t; } catch { } };
        for (let i = 0; i < p.length; i++) {
            if (p[i] == '' || p[i] == '.') { continue; }
            let c = await ((i == p.length - 1 && kind == 'file') ? wrap(h.getFileHandle(p[i], { create })) : wrap(h.getDirectoryHandle(p[i], { create })));
            if (!c && kind == null) { c = await wrap(h.getFileHandle(p[i], { create })); }
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
            let stat = { type: f.type || this._typeFromName(f.name), name: f.name, size: f.size, updatedTime: f.lastModified }
            if (["image/jpeg", "image/png", "image/gif", "image/webp", "image/bmp"].includes(f.type)) {
                stat.metadata = { thumbnail: "#thumbnail.jpeg" };
            }
            return stat;
        } else {
            return { type: 'directory', size: 0, name: handle.name, updatedTime: null }
        }
    }

    _typeFromName(name) {
        return {
            // video
            ".mp4": "video/mp4",
            ".m4v": "video/mp4",
            ".f4v": "video/mp4",
            ".mov": "video/mp4",
            ".webm": "video/webm",
            ".ogv": "video/ogv",
            // image
            ".jpeg": "image/jpeg",
            ".jpg": "image/jpeg",
            ".gif": "image/gif",
            ".png": "image/png",
            ".bmp": "image/bmp",
            ".webp": "image/webp",
            // audio
            ".aac": "audio/aac",
            ".mp3": "audio/mp3",
            ".ogg": "audio/ogg",
            ".mid": "audio/midi",
        }[name.split('.').pop()] || '';
    }

    /**
     * @param {Blob} file 
     * @returns {Promise<Blob>}
     */
    async createThumbnail(file, maxWidth = 200, maxHeight = 200) {
        let canvas = document.createElement('canvas');
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
            canvas.getContext('2d').drawImage(image, 0, 0, w, h);
        };
        let objectUrl = URL.createObjectURL(file);
        let media;
        try {
            if (file.type.startsWith('video')) {
                // TODO: detect background tab
                media = document.createElement('video');
                media.muted = true;
                media.autoplay = true;
                await new Promise((resolve, reject) => {
                    media.onloadeddata = resolve;
                    media.onerror = reject;
                    media.src = objectUrl;
                    setTimeout(reject, 3000);
                });
                await new Promise((resolve, _reject) => {
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
                    setTimeout(reject, 5000);
                });
                drawThumbnail(media, media.naturalWidth, media.naturalHeight);
            }
        } finally {
            if (media) { media.src = ''; }
            URL.revokeObjectURL(objectUrl);
        }
        return await new Promise((resolve, _) => canvas.toBlob(resolve, 'image/jpeg', 0.8));
    }
}

class FileServer {
    /**
     * @param {FileSystemHandle2} handle 
     */
    constructor(handle) {
        this.fs = new FileSystemWrapper(handle);
    }
    /**
     * @param {MessageEvent} ev 
     * @param {RTCDataChannel | WebSocket} socket 
     */
    async handleEvent(ev, socket) {
        let cmd = JSON.parse(ev.data);
        let fs = this.fs;
        try {
            switch (cmd.op) {
                case 'stat':
                    socket.send(JSON.stringify({ rid: cmd.rid, data: await fs.stat(cmd.path) }));
                    break;
                case 'files':
                    socket.send(JSON.stringify({ rid: cmd.rid, data: await fs.files(cmd.path, cmd.p, cmd.l) }));
                    break;
                case 'read':
                    let data = await fs.read(cmd.path, cmd.p, cmd.l);
                    socket.send(await new Blob([Uint32Array.from([0, cmd.rid]), data]).arrayBuffer()); //TODO: endian
                    break;
                case 'write':
                    let buf = new Uint8Array([...atob(cmd.b)].map(s => s.charCodeAt(0)));
                    let l = await fs.write(cmd.path, cmd.p, buf);
                    socket.send(JSON.stringify({ rid: cmd.rid, data: l }));
                    break;
                case 'truncate':
                    socket.send(JSON.stringify({ rid: cmd.rid, data: await fs.truncate(cmd.path, cmd.p) }));
                    break;
                case 'mkdir':
                    socket.send(JSON.stringify({ rid: cmd.rid, data: await fs.mkdir(cmd.path) }));
                    break;
                case 'remove':
                    socket.send(JSON.stringify({ rid: cmd.rid, data: await fs.remove(cmd.path) }));
                    break;
                case 'rename':
                    socket.send(JSON.stringify({ rid: cmd.rid, data: await fs.rename(cmd.path, cmd.path2) }));
                    break;
                default:
                    throw 'unknown_operation';
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
            onopen: (ch, _ev) => { ch.binaryType = 'arraybuffer'; },
            /**
             * @param {RTCDataChannel} ch 
             * @param {MessageEvent} ev
             */
            onmessage: (ch, ev) => this.handleEvent(ev, ch)
        };
    }
}
