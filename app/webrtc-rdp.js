// @ts-check
'use strict';

// Please replace with your id and signalingKey!
const signalingUrl = 'wss://ayame-labo.shiguredo.app/signaling';
const signalingKey = 'VV69g7Ngx-vNwNknLhxJPHs9FpRWWNWeUzJ9FUyylkD_yc_F';
const roomIdPrefix = 'binzume@rdp-room-';
const roomIdPinPrefix = 'binzume@rdp-pin-';

class Settings {
    static settingsKey = 'webrtc-rdp-settings';
    /** @type {((devices:DeviceSettings[])=>any)|null} */
    static onsettingsupdate = null;

    /**
     * @param {DeviceSettings} deviceInfo 
     */
    static addPeerDevice(deviceInfo) {
        let devices = this.getPeerDevices();
        let idx = devices.findIndex(d => d.roomId == deviceInfo.roomId);
        if (idx < 0) {
            devices.push(deviceInfo);
        } else {
            devices[idx] = deviceInfo;
        }
        this._save(devices);
    }

    /**
     * @returns {DeviceSettings[]}
     */
    static getPeerDevices() {
        try {
            let s = localStorage.getItem(this.settingsKey);
            if (!s) { return []; }
            let settings = JSON.parse(s);
            return settings.version == 2 ? (settings.devices || []) : [settings];
        } catch (e) {
            console.log(e);
            return [];
        }
    }

    /**
     * @param {DeviceSettings} deviceInfo 
     */
    static removePeerDevice(deviceInfo) {
        let devices = this.getPeerDevices();
        let filtered = devices.filter(d => d.roomId != deviceInfo.roomId);
        if (filtered.length != devices.length) {
            this._save(filtered);
        }
    }

    static clear() {
        this._save([]);
    }

    static _save(devices) {
        if (devices.length == 0) {
            localStorage.removeItem(this.settingsKey);
        } else if (devices.length == 1) {
            localStorage.setItem(this.settingsKey, JSON.stringify(devices[0])); // compat
        } else {
            localStorage.setItem(this.settingsKey, JSON.stringify({ devices: devices, version: 2 }));
        }
        this.onsettingsupdate && this.onsettingsupdate(devices);
    }
}

class BaseConnection {
    /**
     * @param {string} signalingUrl 
     * @param {string|undefined} signalingKey 
     * @param {string} roomId 
     */
    constructor(signalingUrl, signalingKey, roomId) {
        this.signalingUrl = signalingUrl;
        this.roomId = roomId;
        this.conn = null;
        /** @type {MediaStream|null} */
        this.mediaStream = null;
        this.stopTracksOnDisposed = true;
        /** @type {Record<string, DataChannelInfo>} */
        this.dataChannels = {};
        this.onstatechange = null;
        /** @type {'disconnected' | 'connecting' | 'waiting' | 'disposed' | 'connected'} */
        this.state = 'disconnected';
        this.options = Object.assign({}, Ayame.defaultOptions);
        this.options.video = Object.assign({}, this.options.video);
        this.options.audio = Object.assign({}, this.options.audio);
        this.options.signalingKey = signalingKey;
        this.reconnectWaitMs = -1;
        this.connectTimeoutMs = -1;
    }
    async connect() {
        if (this.conn || this.state == 'disposed') {
            throw 'invalid operation';
        }
        await this.setupConnection().connect(this.mediaStream, null);
    }
    setupConnection() {
        console.log("connecting..." + this.signalingUrl + " " + this.roomId);
        this.updateState('connecting');
        clearTimeout(this._connectTimer);
        if (this.connectTimeoutMs > 0) {
            this._connectTimer = setTimeout(() => this.disconnect(), this.connectTimeoutMs);
        }

        let conn = this.conn = Ayame.connection(this.signalingUrl, this.roomId, this.options, false);
        conn.on('open', async (e) => {
            for (let c of Object.keys(this.dataChannels)) {
                this._handleDataChannel(await conn.createDataChannel(c));
            }
            this.updateState('waiting');
        });
        conn.on('connect', (e) => {
            clearTimeout(this._connectTimer);
            this.updateState('connected');
        });
        conn.on('datachannel', (channel) => {
            this._handleDataChannel(channel);
        });
        conn.on('disconnect', (e) => {
            this.conn = null;
            this.disconnect(e.reason);
        });
        return conn;
    }
    /**
     * @param {string|null} reason 
     */
    disconnect(reason = null) {
        console.log('disconnect', reason);
        clearTimeout(this._connectTimer);
        if (this.conn) {
            this.conn.on('disconnect', () => { });
            this.conn.disconnect();
            this.conn.stream = null;
            this.conn = null;
        }
        if (reason != 'dispose' && this.state != 'disconnected' && this.reconnectWaitMs >= 0) {
            this._connectTimer = setTimeout(() => this.connect(), this.reconnectWaitMs);
        }
        for (let c of Object.values(this.dataChannels)) {
            c.ch = null;
        }
        this.updateState('disconnected', reason);
    }
    dispose() {
        this.disconnect('dispose');
        this.updateState('disposed');
        this.stopTracksOnDisposed && this.mediaStream?.getTracks().forEach(t => t.stop());
        this.mediaStream = null;
    }
    /**
     * @param {'disconnected' | 'connecting' | 'waiting' | 'disposed' | 'connected'} s
     * @param {string|null} reason 
     */
    updateState(s, reason = null) {
        if (s != this.state && this.state != 'disposed') {
            console.log(this.roomId, s);
            let oldState = this.state;
            this.state = s;
            this.onstatechange && this.onstatechange(s, oldState, reason);
        }
    }
    /**
     * @param {RTCDataChannel|null} ch
     */
    _handleDataChannel(ch) {
        if (!ch) return;
        let c = this.dataChannels[ch.label];
        if (c && !c.ch) {
            console.log('datachannel', ch.label);
            c.ch = ch;
            ch.onmessage = (ev) => c.onmessage?.(ch, ev);
            // NOTE: dataChannel.onclose = null in Ayame web sdk.
            ch.addEventListener('open', (ev) => c.onopen?.(ch, ev));
            ch.addEventListener('close', (ev) => c.onclose?.(ch, ev));
        }
    }
    getFingerprint(remote = false) {
        let pc = this.conn._pc;
        let m = pc && (remote ? pc.currentRemoteDescription : pc.currentLocalDescription).sdp.match(/a=fingerprint:\s*([\w-]+ [a-f0-9:]+)/i);
        return m && m[1];
    }
    async hmacSha256(password, fingerprint) {
        let enc = new TextEncoder();
        let key = await crypto.subtle.importKey('raw', enc.encode(password),
            { name: 'HMAC', hash: { name: 'SHA-256' } }, false, ['sign']);
        let sign = await crypto.subtle.sign('HMAC', key, enc.encode(fingerprint));
        return btoa(String.fromCharCode(...new Uint8Array(sign)));
    }
}

class PairingConnection extends BaseConnection {
    /**
     * @param {string} signalingUrl 
     * @param {*} signalingKey 
     */
    constructor(signalingUrl, signalingKey = undefined) {
        super(signalingUrl, signalingKey, '');
        this.pinLength = 6;
        this.userAgent = navigator.userAgent;
        this.localServices = null;
        this.pinTimeoutMs = 3600000;
        this.version = 1;
    }

    validatePin(pin) {
        return pin && pin.length == this.pinLength;
    }

    async startPairing() {
        this.disconnect();
        this.connectTimeoutMs = this.pinTimeoutMs;
        let localRoomId = roomIdPrefix + this._generateSecret(16);
        let localToken = this._generateSecret(16);
        let pin = this._generatePin();

        this.dataChannels['secretExchange'] = {
            onopen: (ch, ev) => {
                ch.send(JSON.stringify(this._getPairingInfo('hello', localRoomId, localToken)));
            },
            onmessage: (_ch, ev) => {
                console.log('pairing event', ev.data);
                let msg = JSON.parse(ev.data);
                if (msg.type == 'credential') {
                    this._finishPairing(msg, localRoomId, localToken);
                }
            },
        };
        this.roomId = roomIdPinPrefix + pin;
        await this.connect();
        return pin;
    }

    async sendPin(pin) {
        if (!this.validatePin(pin)) {
            throw "invalid pin";
        }
        this.disconnect();
        this.connectTimeoutMs = 10000;
        let localRoomId = roomIdPrefix + this._generateSecret(16);
        let localToken = this._generateSecret(16);

        this.dataChannels['secretExchange'] = {
            onmessage: (ch, ev) => {
                console.log('pairing event', ev.data);
                let msg = JSON.parse(ev.data);
                if (msg.type == 'hello') {
                    if (msg.version && msg.version != this.version) {
                        console.log('Unsupported version: ' + msg.version);
                        this.disconnect();
                    }
                    ch.send(JSON.stringify(this._getPairingInfo('credential', localRoomId, localToken)));
                    this._finishPairing(msg, localRoomId, localToken);
                }
            },
        };
        this.roomId = roomIdPinPrefix + pin;
        await this.connect();
    }

    _getPairingInfo(type, localRoomId, localToken) {
        let isGuest = this.localServices?.length == 0;
        return {
            type: type,
            roomId: localRoomId,
            token: isGuest ? null : localToken,
            signalingKey: isGuest ? null : signalingKey,
            services: this.localServices,
            userAgent: this.userAgent,
            version: this.version,
        };
    }

    _finishPairing(msg, localRoomId, localToken) {
        let isGuest = this.localServices?.length == 0;
        let isHost = this.localServices?.includes('no-client');
        Settings.addPeerDevice({
            roomId: msg.roomId || localRoomId,
            publishRoomId: localRoomId,
            localToken: localToken,
            token: msg.token,
            signalingKey: msg.signalingKey,
            services: msg.services || (isGuest ? ['no-client', 'screen', 'file'] : isHost ? [] : null),
            userAgent: msg.userAgent,
            name: msg.name,
        });
        this.disconnect();
    }

    _generatePin() {
        return (Math.floor(Math.random() * 1000000) + "000000").substring(0, this.pinLength);
    }

    _generateSecret(n) {
        const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
        return Array.from(crypto.getRandomValues(new Uint8Array(n))).map((c) => chars[c % chars.length]).join('');
    }
}

class PublisherConnection extends BaseConnection {
    /**
     * @param {string} signalingUrl 
     * @param {string} roomId 
     * @param {MediaStream} mediaStream 
     * @param {DataChannelInfo|null} messageHandler 
     */
    constructor(signalingUrl, signalingKey, roomId, mediaStream, messageHandler = null) {
        super(signalingUrl, signalingKey, roomId);
        if (mediaStream) {
            this.options.video.direction = 'sendonly';
            this.options.audio.direction = 'sendonly';
            this.mediaStream = mediaStream;
        }
        this.reconnectWaitMs = 3000;
        this.dataChannels['controlEvent'] = messageHandler || {};
        this.onauth = null;
        this._originalWidth = 0;
        this._originalHeight = 0;
    }
    async auth(msg, ch, password, reply = false) {
        let result = false;
        if (msg.hmac) {
            let hmac = await this.hmacSha256(password, this.getFingerprint(true));
            result = msg.hmac == hmac;
        } else {
            result = msg.token == password;
        }
        console.log('Auth result', result);
        result && this.onauth?.();
        reply && ch.send(JSON.stringify({ type: 'authResult', result: result }));
        return result;
    }
    async updateVideoResolution(preferredWidth) {
        let video = this.mediaStream.getTracks().find(t => t.kind == 'video');
        if (video == null) {
            return false;
        }
        if (this._originalWidth <= 0 || this._originalHeight <= 0) {
            let settings = video.getSettings();
            this._originalWidth = settings.width;
            this._originalHeight = settings.height;
            if (this._originalWidth <= 0 || this._originalHeight <= 0) {
                return false;
            }
        }
        let scale2 = Math.round(Math.log2(preferredWidth / this._originalWidth));
        let scale = Math.pow(2, scale2);
        console.log('video scale: ', scale);
        await video.applyConstraints({
            width: this._originalWidth * scale,
            height: this._originalHeight * scale,
        });
        return true;
    }
}

class PlayerConnection extends BaseConnection {
    /**
     * @param {string} signalingUrl 
     * @param {string} roomId 
     * @param {HTMLVideoElement|null} videoEl
     */
    constructor(signalingUrl, signalingKey, roomId, videoEl) {
        super(signalingUrl, signalingKey, roomId);
        if (videoEl) {
            this.options.video.direction = 'recvonly';
            this.options.audio.direction = 'recvonly';
        }
        this.videoEl = videoEl;
        this._rpcResultHandler = {};
        this.authToken = null;
        this.services = null;
        this.onauth = null;
        this.dataChannels['controlEvent'] = {
            onopen: async (ch, ev) => {
                if (window.crypto?.subtle) {
                    let localFingerprint = this.getFingerprint(false);
                    if (!localFingerprint) {
                        console.log("Failed to get DTLS cert fingerprint");
                        return;
                    }
                    console.log("local fingerprint:", localFingerprint);
                    let hmac = this.authToken && await this.hmacSha256(this.authToken, localFingerprint);
                    ch.send(JSON.stringify({
                        type: "auth",
                        requestServices: videoEl ? ['screen', 'file'] : ['file'],
                        fingerprint: localFingerprint,
                        hmac: hmac
                    }));
                } else {
                    ch.send(JSON.stringify({ type: "auth", token: this.authToken }));
                }
            },
            onmessage: (ch, ev) => {
                let msg = JSON.parse(ev.data);
                if (msg.type == 'redirect' && msg.roomId) {
                    this.disconnect('redirect');
                    this.roomId = msg.roomId;
                    this.connect();
                } else if (msg.type == 'auth') {
                    // player and player error
                    this.disconnect();
                } else if (msg.type == 'authResult') {
                    this.services = msg.services;
                    this.onauth?.(msg.result);
                } else if (msg.type == 'rpcResult') {
                    this._rpcResultHandler[msg.reqId]?.(msg);
                }
            }
        };
    }
    setupConnection() {
        let conn = super.setupConnection();
        conn.on('addstream', (ev) => {
            this.mediaStream = ev.stream;
            if (this.videoEl) {
                this.videoEl.srcObject = ev.stream;
            }
        });
        return conn;
    }
    /**
     * @param {string|null} reason 
     */
    disconnect(reason = null) {
        if (this.videoEl && this.videoEl.srcObject == this.mediaStream) {
            this.videoEl.srcObject = null;
        }
        super.disconnect(reason);
    }
    sendRpcAsync(name, params, timeoutMs = 10000) {
        let reqId = Date.now(); // TODO: monotonic
        this.dataChannels['controlEvent'].ch?.send(JSON.stringify({ type: 'rpc', name: name, reqId: reqId, params: params }));
        return new Promise((resolve, reject) => {
            let timer = setTimeout(() => {
                delete this._rpcResultHandler[reqId];
                reject('timeout');
            }, timeoutMs);
            this._rpcResultHandler[reqId] = (res) => {
                clearTimeout(timer);
                delete this._rpcResultHandler[reqId];
                resolve(res.value);
            };
        });
    }
    sendMouseEvent(action, x, y, button) {
        if (this.state == 'connected') {
            this.dataChannels['controlEvent'].ch?.send(JSON.stringify({ type: 'mouse', action: action, x: x, y: y, button: button }));
        }
    }
    sendKeyEvent(action, key, code, shift = false, ctrl = false, alt = false) {
        if (this.state == 'connected') {
            this.dataChannels['controlEvent'].ch?.send(JSON.stringify({ type: 'key', action: action, key: key, code: code, shift: shift, ctrl: ctrl, alt: alt }));
        }
    }
}

class ConnectionManager {
    /**
     * @param {DeviceSettings} settings 
     */
    constructor(settings) {
        this.settings = settings;
        this.onadded = null;
        this.disableAuth = !settings.localToken;
        /**  @type {ConnectionInfo[]} */
        this._connections = [];
    }

    /**
     * @param {MediaStream} mediaStream 
     * @param {string|null} name 
     * @param {DataChannelInfo|null} messageHandler 
     * @param {boolean} connect 
     * @param {boolean} permanent 
     * @returns {ConnectionInfo}
     */
    addStream(mediaStream, messageHandler = null, name = null, connect = true, permanent = true) {
        let id = this._genId();
        let roomId = this.settings.publishRoomId || this.settings.roomId;
        name = name || mediaStream.getVideoTracks()[0]?.label || mediaStream.id;
        let conn = new PublisherConnection(signalingUrl, signalingKey, roomId + (id != 1 ? '.' + id : ''), mediaStream, messageHandler);
        conn.connectTimeoutMs = permanent ? -1 : 30000;
        conn.reconnectWaitMs = permanent ? 2000 : -1;

        let info = { conn: conn, id: id, name: name, permanent: permanent };
        this._connections.push(info);
        this.onadded?.(info);
        if (connect) {
            conn.connect();
        }
        return info;
    }

    removeStream(id) {
        let index = this._connections.findIndex(c => c.id == id);
        if (index >= 0) {
            this._connections[index].conn.dispose();
            this._connections.splice(index, 1);
        }
    }
    async auth(msg, ch, reply = false) {
        let c = this._connections.find(c => c.conn.dataChannels['controlEvent']?.ch == ch);
        return await c?.conn.auth(msg, ch, this.settings.localToken, reply);
    }
    _genId() {
        let n = 1;
        while (this._connections.some(c => c.id == n)) n++;
        return n;
    }
    dispose() {
        this._connections.forEach((c) => c.conn.dispose());
        this._connections = [];
    }
}

class StreamSelectScreen {
    /**
     * @param {StreamProvider} streamProvider 
     */
    constructor(streamProvider) {
        let canvas = this.canvasEl = document.createElement('canvas');
        canvas.width = 640;
        canvas.height = 400;
        this.streamProvider = streamProvider;
        this.ctx = canvas.getContext('2d');
        /** @type {StreamSpec[]} */
        this._streams = [];
        this.buttonSpec = { width: 520, height: 20, font: 'bold 18px sans-serif', color: 'black' };
        this.buttonLayout = { top: 24, left: (canvas.width - this.buttonSpec.width) / 2, spacing: 6 };
        this._attachCount = 0;
        this._updateTimer = null;
    }
    async update() {
        let streams = await this.streamProvider.getStreams();
        this._streams = streams;
        let canvas = this.canvasEl;
        let ctx = this.ctx;
        ctx.fillStyle = 'white';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.font = 'normal 18px sans-serif';
        ctx.textBaseline = 'top';
        ctx.textAlign = 'center';
        ctx.fillStyle = 'black';
        ctx.fillText('Available screens (Click to select)', canvas.width / 2, 0);
        if (streams.length == 0) {
            ctx.fillStyle = 'red';
            ctx.fillText('No Available Screen', canvas.width / 2, canvas.height / 2);
        }

        let button = this.buttonSpec, layout = this.buttonLayout;
        ctx.font = button.font;
        streams.forEach((s, i) => {
            let x = layout.left, y = layout.top + i * (button.height + layout.spacing);
            ctx.strokeStyle = '#888';
            ctx.strokeRect(x, y, button.width, button.height);
            ctx.fillStyle = button.color;
            ctx.fillText(s.name, canvas.width / 2, y, button.width);
        });
    }

    /**
     * @param {ConnectionManager} cm
     * @param {StreamSpec} s 
     * @param {boolean} permanent 
     */
    async startStream(cm, s, permanent) {
        let self = this;
        let mediaStream = this.canvasEl.captureStream(1);
        let dataChannelInfo = {
            onopen(ch, _ev) { self._attach(cm, ch); },
            onclose(_ch, _ev) { self._detach(); },
            onmessage(ch, ev) { self._handleMessage(cm, ch, JSON.parse(ev.data)) },
        };
        return await cm.addStream(mediaStream, dataChannelInfo, s.name, true, permanent);
    }

    /**
     * @param {ConnectionManager} cm 
     * @param {RTCDataChannel} ch 
     * @param {object} msg 
     */
    async _handleMessage(cm, ch, msg) {
        if (msg.type == 'mouse' && (msg.action == 'click' || msg.action == 'up')) {
            let x = msg.x * this.canvasEl.width, y = msg.y * this.canvasEl.height;
            let layout = this.buttonLayout;
            if (x < layout.left || x > layout.left + this.buttonSpec.width || y < layout.top) {
                return;
            }
            let n = Math.floor((y - layout.top) / (this.buttonSpec.height + layout.spacing));
            if (this._streams[n]) {
                this._redirect(cm, ch, n);
            }
        } else if (msg.type == 'auth') {
            let authResult = await cm.auth(msg, ch);
            if (authResult && msg.requestServices && !msg.requestServices.includes('screen')) {
                let c = await cm.addStream(null, {
                    onmessage: async (ch, ev) => {
                        let msg = JSON.parse(ev.data);
                        if (msg.type == 'auth') {
                            await cm.auth(msg, ch, true);
                        }
                    },
                }, 'file server', true, false);
                if (c) {
                    ch.send(JSON.stringify({ type: 'redirect', 'roomId': c.conn.roomId }));
                }
            } else if (authResult) {
                if (this._attachCount == 1) {
                    await this.update();
                }
                this._streams.length == 1 && this._redirect(cm, ch, 0);
            }
        }
    }
    async _attach(cm, ch) {
        this._attachCount++;
        if (this._attachCount == 1) {
            this._updateTimer = setInterval(() => this.update(), 1000);
        }
    }
    _detach() {
        this._attachCount--;
        if (this._attachCount == 0) {
            clearInterval(this._updateTimer);
            this.ctx.fillRect(0, 0, this.canvasEl.width, this.canvasEl.height);
        }
    }
    async _redirect(cm, ch, n) {
        let c = await this.streamProvider.startStream(cm, this._streams[n], false);
        if (c) {
            ch.send(JSON.stringify({ type: 'redirect', 'roomId': c.conn.roomId }));
        }
    }
}

class StreamRedirector {
    /**
     * @param {StreamProvider} streamProvider 
     * @param {StreamSpec} target 
     */
    constructor(streamProvider, target) {
        this.streamProvider = streamProvider;
        this.target = target;
    }

    /**
     * @param {ConnectionManager} cm
     * @param {StreamSpec} s 
     * @param {boolean} permanent 
     */
    async startStream(cm, s, permanent) {
        let dataChannelInfo = {
            onopen: async (ch, ev) => {
                // TODO: timeout
                let c = await this.streamProvider.startStream(cm, this.target, false);
                ch.send(JSON.stringify({ type: 'redirect', 'roomId': c.conn.roomId }));
            }
        };
        return await cm.addStream(null, dataChannelInfo, s.name, true, permanent);
    }
}

class BrowserStreamProvider {
    constructor() {
        /** @type {((target: any, ev: Record<string,any>) => void)|null} */
        this.sendInputEvent = null;
        /** @type {Record<string, StreamProvider>} */
        this.pseudoStreams = {};
        /** @type {{spec:StreamSpec, isCamera: boolean, mediaStream: MediaStream}[]} */
        this._streams = [];
        this._idSeq = 0;
    }

    /**
     * @param {boolean} camera 
     * @param {boolean} registerStream
     * @returns {Promise<StreamSpec>}
     */
    async addMediaStream(camera = false, registerStream = true) {
        let mediaStream = await (camera ? navigator.mediaDevices.getUserMedia({ audio: true, video: true }) : navigator.mediaDevices.getDisplayMedia({ audio: true, video: true }));
        let name = mediaStream.getVideoTracks()[0]?.label || "?";
        let s = { spec: { id: 'BrowserStreamProvider_' + (++this._idSeq), name: name }, mediaStream: mediaStream, isCamera: camera };
        registerStream && this._streams.push(s);
        return s.spec;
    }

    async getStreams() {
        return this._streams.map(s => s.spec);
    }

    /**
     * @param {ConnectionManager} cm
     * @param {StreamSpec} s 
     * @param {boolean} permanent 
     */
    async startStream(cm, s, permanent = false) {
        if (this.pseudoStreams[s.id]) {
            return await this.pseudoStreams[s.id].startStream(cm, s, permanent);
        }
        let stream = this._streams.find(st => st.spec.id == s.id);
        if (!stream) {
            return null;
        }
        let target = stream.isCamera ? null : this._getTarget(stream.mediaStream);
        let authorized = cm.disableAuth;
        let c = cm.addStream(stream.mediaStream, {
            onmessage: async (ch, ev) => {
                let msg = JSON.parse(ev.data);
                if (msg.type == 'auth') {
                    authorized = await cm.auth(msg, ch, true);
                } else if (authorized && this.sendInputEvent) {
                    this.sendInputEvent(target, msg);
                }
            },
        }, null, true, permanent);
        c.conn.stopTracksOnDisposed = false; // Reuse media streams.
        return c;
    }

    /**
     * @param {StreamSpec} s 
     */
    remove(s) {
        this._streams.filter(ss => ss.spec.id == s.id).forEach(ss => ss.mediaStream.getTracks().forEach(t => t.stop()));
        this._streams = this._streams.filter(ss => ss.spec.id != s.id);
    }

    _getTarget(mediaStream) {
        let surface = mediaStream.getVideoTracks()[0]?.getSettings().displaySurface;
        let label = mediaStream.getVideoTracks()[0]?.label;
        if (surface == null || label == null) {
            // TODO: Firefox
            return { type: 'monitor', id: 0 };
        }
        if (surface == 'monitor') {
            let m = label.match(/^screen:(\d+):\d+/);
            if (m) {
                return { type: surface, id: m[1] | 0 };
            }
        } else if (surface == 'window') {
            let m = label.match(/^window:(\d+):\d+/);
            if (m) {
                return { type: surface, id: m[1] | 0 };
            }
        }
        return null;
    }
}

class ElectronStreamProvider {
    constructor(types = ['screen', 'window']) {
        this._lastMouseMoveTime = 0;
        this.streamTypes = types;
        /** @type {Record<string, StreamProvider>} */
        this.pseudoStreams = {};
    }
    /**
     * @returns {Promise<StreamSpec[]>}
     */
    async getStreams(all = false) {
        return await RDP.getDisplayStreams(all ? ['screen', 'window'] : this.streamTypes);
    }
    /**
     * @param {StreamSpec} s 
     */
    async getMediaStream(s) {
        return await navigator.mediaDevices.getUserMedia({
            video: {
                // @ts-ignore
                mandatory: {
                    chromeMediaSource: 'desktop',
                    chromeMediaSourceId: s.id,
                    maxWidth: 1920,
                    maxHeight: 1080,
                }
            },
            audio: s.hasAudio ? {
                // @ts-ignore
                mandatory: {
                    chromeMediaSource: 'desktop',
                }
            } : false
        });
    }
    /**
     * @param {ConnectionManager} cm
     * @param {StreamSpec} s 
     * @param {boolean} permanent 
     */
    async startStream(cm, s, permanent = false) {
        try {
            if (this.pseudoStreams[s.id]) {
                return await this.pseudoStreams[s.id].startStream(cm, s, permanent);
            }
            let mediaStream = await this.getMediaStream(s);
            let authorized = cm.disableAuth;
            let c = cm.addStream(mediaStream, {
                onmessage: async (ch, ev) => {
                    let msg = JSON.parse(ev.data);
                    if (msg.type == 'auth') {
                        authorized = await cm.auth(msg, ch, true);
                        if (s.name && s.name != 'unknown' && authorized) {
                            ch.send(JSON.stringify({ type: 'streamInfo', title: s.name }));
                        }
                    } else if (authorized) {
                        this._handleMessage(cm, s, ch, msg, c)
                    }
                }
            }, s.name, true, permanent);
            return c;
        } catch (e) {
            console.log(e);
            return null;
        }
    }
    /**
     * @param {ConnectionManager} cm 
     * @param {StreamSpec} s 
     * @param {RTCDataChannel} ch 
     * @param {ConnectionInfo} c
     * @param {object} msg 
     */
    async _handleMessage(cm, s, ch, msg, c) {
        if (msg.type == 'mouse') {
            let now = Date.now();
            if (now - this._lastMouseMoveTime < 10 && msg.action == 'move') {
                return;
            }
            this._lastMouseMoveTime = now;
            await RDP.sendMouse({ target: s, action: msg.action, button: msg.button, x: msg.x, y: msg.y });
        } else if (msg.type == 'key') {
            let modifiers = msg.modifiers || [];
            msg.ctrl && modifiers.push('Control');
            msg.alt && modifiers.push('Alt');
            msg.shift && modifiers.push('Shift');
            await RDP.sendKey({ target: s, action: msg.action, key: msg.key, modifiers: modifiers });
        } else if (msg.type == 'rpc' && msg.name == 'getStreams') {
            let streams = await this.getStreams();
            ch.send(JSON.stringify({ type: 'rpcResult', name: msg.name, reqId: msg.reqId, value: streams.map(s => ({ id: s.id, name: s.name })) }));
        } else if (msg.type == 'rpc' && msg.name == 'streamFromPoint') {
            let si = await RDP.streamFromPoint({ target: s, x: msg.params.x, y: msg.params.y });
            ch.send(JSON.stringify({ type: 'rpcResult', name: msg.name, reqId: msg.reqId, value: si }));
        } else if (msg.type == 'rpc' && msg.name == 'play') {
            let streams = await this.getStreams(true);
            let s = streams.find(s => s.id == msg.params.streamId) || { id: msg.params.streamId, name: 'unknown' };
            let c = await this.startStream(cm, s);
            if (msg.params.redirect) {
                ch.send(JSON.stringify({ type: 'redirect', reqId: msg.reqId, roomId: c?.conn.roomId }));
            }
            ch.send(JSON.stringify({ type: 'rpcResult', name: msg.name, reqId: msg.reqId, value: { roomId: c?.conn.roomId } }));
        } else if (msg.type == 'rpc' && msg.name == 'setResolution') {
            let r = await c.conn.updateVideoResolution(msg.params.preferredWidth);
            ch.send(JSON.stringify({ type: 'rpcResult', name: msg.name, reqId: msg.reqId, value: r }));
        } else {
            console.log("drop:", msg);
        }
    }
}


function initPairing() {
    let pairing = new PairingConnection(signalingUrl, signalingKey);
    document.getElementById('addDeviceButton').addEventListener('click', (ev) => {
        pairing.disconnect();
        document.getElementById("pairing").style.display =
            document.getElementById("pairing").style.display == 'none' ? 'block' : 'none';
        document.getElementById("pinDisplayBox").style.display = "none";
        document.getElementById("pinInputBox").style.display = "block";
    });
    document.getElementById('inputPin').addEventListener('click', (ev) => {
        document.getElementById("pinDisplayBox").style.display = "none";
        document.getElementById("pinInputBox").style.display = "block";
    });
    document.getElementById('pinInputBox').addEventListener('submit', (ev) => {
        let inputEl = /** @type {HTMLInputElement} */(document.getElementById("pinInput"));
        let pin = inputEl.value.trim();
        if (pairing.validatePin(pin)) {
            document.getElementById("pinInputBox").style.display = "none";
            inputEl.value = '';
            pairing.localServices = null;
            pairing.sendPin(pin);
        }
        ev.preventDefault();
    });
    document.getElementById('generatePin').addEventListener('click', async (ev) => {
        document.getElementById("pinDisplayBox").style.display = "block";
        document.getElementById("pinInputBox").style.display = "none";
        let pinEl = document.getElementById("pin");
        pinEl.innerText = "......";
        pinEl.innerText = await pairing.startPairing();
        pairing.onstatechange = (state) => {
            let mode = /** @type {HTMLSelectElement} */(document.getElementById('modeSelect')).value;
            pairing.localServices = mode == 'guest' ? [] :
                mode == 'host' ? ['no-client', 'screen', 'file'] : ['screen', 'file'];
            if (state == "disconnected") {
                pinEl.innerText = "......";
            }
        };
    });
}

function initPlayer() {
    // Player
    /** @type {PlayerConnection|null} */
    let player = null;
    /** @type {HTMLVideoElement} */
    let videoEl = document.querySelector('#screen');
    /** @type {DeviceSettings} */
    let currentDevice = null;
    let playStream = (/** @type {DeviceSettings} */ d) => {
        currentDevice = d;
        player?.disconnect();
        videoEl.style.display = "none";
        if (currentDevice) {
            document.getElementById('connectingBox').style.display = "block";
            document.body.classList.add('player');
            let roomId = currentDevice.roomId;
            player = new PlayerConnection(signalingUrl, currentDevice.signalingKey, roomId, videoEl);
            player.authToken = currentDevice.token;
            if (globalThis.rtcFileSystemManager) {
                globalThis.storageAccessors ??= {};
                // defined in ../app/rtcfilesystem-client.js
                player.dataChannels['fileServer'] = globalThis.rtcFileSystemManager.getRtcChannelSpec('RDP-' + roomId, 'files');
            }
            player.onstatechange = (state) => {
                if (state == "connected") {
                    document.getElementById('connectingBox').style.display = "none";
                    videoEl.style.display = "block";
                }
            };
            player.connect();
        }
    };
    let dragging = false;
    let dragTimer = null;
    let mousePos = { x: 0, y: 0 };
    let updateMousePos = (ev) => {
        let rect = videoEl.getBoundingClientRect();
        let vw = Math.min(rect.width, rect.height * videoEl.videoWidth / videoEl.videoHeight);
        let vh = Math.min(rect.height, rect.width * videoEl.videoHeight / videoEl.videoWidth);
        let x = (ev.clientX - rect.left - (rect.width - vw) / 2) / vw, y = (ev.clientY - rect.top - (rect.height - vh) / 2) / vh;
        mousePos = { x: x, y: y };
    };
    let sendMouse = (action, ev) => {
        if (player?.state == 'connected') {
            updateMousePos(ev);
            if (action == 'click' && cancelSelect) {
                (async () => {
                    let stream = await player.sendRpcAsync('streamFromPoint', { x: mousePos.x, y: mousePos.y });
                    if (stream && cancelSelect) {
                        player.sendRpcAsync('play', { streamId: stream.id, redirect: true });
                    }
                    cancelSelect?.();
                })();
                return;
            }
            let x = mousePos.x, y = mousePos.y;
            if (action != 'up' && (x > 1 || x < 0 || y > 1 || y < 0)) action = 'move';
            if (action == 'click' && dragging) action = 'up';
            player.sendMouseEvent(action, x, y, ev.button);
            ev.preventDefault();
        }
    };
    videoEl.addEventListener('click', (ev) => sendMouse('click', ev));
    videoEl.addEventListener('auxclick', (ev) => sendMouse('click', ev));
    videoEl.addEventListener('mousemove', (ev) => updateMousePos(ev));
    videoEl.addEventListener('pointerdown', (ev) => {
        videoEl.setPointerCapture(ev.pointerId);
        dragTimer = setTimeout(() => {
            dragging = true;
            sendMouse('down', ev);
        }, 200);
    });
    videoEl.addEventListener('pointermove', (ev) => dragging && sendMouse('move', ev));
    videoEl.addEventListener('pointerup', (ev) => {
        videoEl.releasePointerCapture(ev.pointerId);
        clearTimeout(dragTimer);
        if (dragging) {
            dragging = false;
            sendMouse('up', ev);
            let cancelClick = ev => ev.stopPropagation();
            window.addEventListener('click', cancelClick, true);
            setTimeout(() => window.removeEventListener('click', cancelClick, true), 10);
        }
    });
    videoEl.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        if (!dragging && ev.button === -1) {
            // Oculus Quest B button fires contextmenu event w/o pointerdown/up.
            sendMouse('click', { button: 2, clientX: ev.clientX, clientY: ev.clientY, preventDefault: () => { } });
        }
    });

    let modKeyState = {};
    let updateModKeyState = (key, state) => {
        let modkey = ['Shift', 'Control', 'Alt'].includes(key);
        if (modkey) {
            modKeyState[key] = state;
            let el = document.getElementById('toggle' + key + 'Button');
            state ? el?.classList.add('active') : el?.classList.remove('active');
        }
        return modkey;
    };
    document.addEventListener('keydown', (ev) => {
        let modkey = updateModKeyState(ev.key, true);
        player?.sendKeyEvent(modkey ? 'down' : 'press', ev.key, ev.code, modKeyState['Shift'], modKeyState['Control'], modKeyState['Alt']);
        if (player) {
            ev.preventDefault();
        }
    });
    document.addEventListener('keyup', (ev) => {
        if (updateModKeyState(ev.key, false)) {
            player?.sendKeyEvent('up', ev.key, ev.code, modKeyState['Shift'], modKeyState['Control'], modKeyState['Alt']);
            if (player) {
                ev.preventDefault();
            }
        }
    });
    document.getElementById('playButton')?.addEventListener('click', (ev) => playStream(currentDevice));
    let fullscreenButtonEl = document.getElementById('fullscreenButton');
    fullscreenButtonEl?.addEventListener('click', (ev) =>
        document.fullscreenElement ?
            document.exitFullscreen() :
            document.getElementById('player').requestFullscreen());
    document.addEventListener('fullscreenchange', (ev) => {
        document.fullscreenElement ?
            fullscreenButtonEl.classList.add('active') :
            fullscreenButtonEl.classList.remove('active');
    });
    for (let key of ['Shift', 'Control', 'Alt']) {
        let el = document.getElementById('toggle' + key + 'Button');
        el?.addEventListener('click', (ev) => {
            let down = !el.classList.contains('active');
            updateModKeyState(key, down);
            player?.sendKeyEvent(down ? 'down' : 'up', key, key + 'Left', modKeyState['Shift'], modKeyState['Control'], modKeyState['Alt']);
        });
    }
    document.getElementById('closePlayerButton')?.addEventListener('click', (ev) => {
        player?.disconnect();
        document.body.classList.remove('player');
    });
    let muteEl = document.getElementById('muteButton');
    if (muteEl) {
        videoEl.muted ? muteEl.classList.add('active') : muteEl.classList.remove('active');
        muteEl.addEventListener('click', (ev) => {
            videoEl.muted = muteEl.classList.toggle('active');
        });
    }
    let cancelSelect = null;
    document.getElementById('selectWindowButton')?.addEventListener('click', (ev) => {
        if (cancelSelect) {
            cancelSelect();
        } else {
            document.getElementById('selectWindowButton').classList.add('active');
            let boxEl = document.createElement('div');
            boxEl.className = 'streamrect';
            videoEl.parentElement.append(boxEl);
            let selectWindowTimer = setInterval(async () => {
                if (player?.state != 'connected') {
                    cancelSelect?.();
                    return;
                }
                let stream = await player.sendRpcAsync('streamFromPoint', { x: mousePos.x, y: mousePos.y });
                if (!cancelSelect || !stream) {
                    return;
                }
                let rect = videoEl.getBoundingClientRect();
                let vw = Math.min(rect.width, rect.height * videoEl.videoWidth / videoEl.videoHeight);
                let vh = Math.min(rect.height, rect.width * videoEl.videoHeight / videoEl.videoWidth);
                boxEl.style.width = (vw * stream.rect.width) + 'px';
                boxEl.style.height = (vh * stream.rect.height) + 'px';
                boxEl.style.left = (vw * stream.rect.x + rect.left + (rect.width - vw) / 2) + 'px';
                boxEl.style.top = (vh * stream.rect.y + rect.top + (rect.height - vh) / 2) + 'px';
                boxEl.textContent = stream.id;
            }, 500);
            cancelSelect = () => {
                clearInterval(selectWindowTimer);
                boxEl.parentElement.removeChild(boxEl);
                cancelSelect = null;
                document.getElementById('selectWindowButton').classList.remove('active');
            };
        }
    });
    return playStream;
}

function initPublisher(playStream) {
    /**
     * @template {keyof HTMLElementTagNameMap} T
     * @param {T} tag 
     * @param {string[] | string | Node[] | any} children 
     * @param {object | function} [attrs]
     * @returns {HTMLElementTagNameMap[T]}
     */
    let mkEl = (tag, children, attrs) => {
        let el = document.createElement(tag);
        children && el.append(...[children].flat(999));
        attrs instanceof Function ? attrs(el) : (attrs && Object.assign(el, attrs));
        return el;
    };

    let isElectronApp = globalThis.RDP != null;
    if (isElectronApp) {
        document.body.classList.add('standalone');
    }
    document.querySelector('#clearSettingsButton').addEventListener('click', (ev) => confirm('CLear all settings?') && Settings.clear());

    // Publisher
    /** @typedef {{cm: ConnectionManager, streamProvider?: StreamProvider&Record<string,any>, el: HTMLElement}} DeviceState */
    /** @type {(ds: DeviceState)=>any} */
    let initStreams = (_) => { };
    /** @type {(ds: DeviceState, listEl: HTMLElement, isCamera:boolean)=>any} */
    let addStream = null;
    /** @type {FileServer} */
    let fileServer = null;
    if (typeof FileServer != 'undefined') {
        console.log('Starting fileServer');
        fileServer = new FileServer(new FileSystemHandleArray()); // !! Global variable
        let targetEl = document.body;
        let listEl = document.getElementById('files');
        targetEl.addEventListener('dragover', (ev) => ev.preventDefault());
        targetEl.addEventListener('drop', (ev) => {
            ev.preventDefault();
            for (const item of ev.dataTransfer.items) {
                if (item.kind != 'file') {
                    continue;
                }
                (async () => {
                    // @ts-ignore
                    const handle = await item.getAsFileSystemHandle();
                    if (await handle.queryPermission({ mode: "read" }) == 'granted') {
                        fileServer.fs.handle.addEntry(handle);
                        let el = mkEl('li', [
                            'File: ', mkEl('span', handle.name, { className: 'streamName', title: handle.kind }),
                            mkEl('button', 'x', { onclick: (_) => { fileServer.fs.handle.removeEntry(handle.name); el.parentElement.removeChild(el); }, title: 'Stop sharing' })
                        ]);
                        if (listEl.childElementCount == 0) {
                            let checkEl = mkEl('input', [], { type: 'checkbox', onchange: async (_) => checkEl.checked = await fileServer.fs.setWritable(checkEl.checked), title: 'Make files writable' });
                            listEl.append(mkEl('li', [mkEl('label', [checkEl, 'Writable']),]));
                        }
                        listEl.append(el);
                    }
                })();
            }
        });
    }

    if (isElectronApp) {
        initStreams = async (d) => {
            let streamProvider = d.streamProvider = new ElectronStreamProvider(['screen']);
            streamProvider.pseudoStreams['_selector'] = new StreamSelectScreen(streamProvider);
            // streamProvider.pseudoStreams['_redirector'] = new StreamRedirector(streamProvider, { id: '_selector', name: 'selector' });
            // await streamProvider.startStream(d.cm, { id: '_redirector', name: 'redirector' }, true);
            await streamProvider.startStream(d.cm, { id: '_selector', name: 'stream selector' }, true);
        };
    } else {
        /** @type {WebSocket} */
        let inputProxySoc = null;
        let initStreamProvider = async (d) => {
            let streamProvider = d.streamProvider = new BrowserStreamProvider();
            streamProvider.sendInputEvent = (target, msg) => {
                if (target && inputProxySoc?.readyState == 1) {
                    msg.target = target;
                    inputProxySoc.send(JSON.stringify(msg));
                }
            };
            d.streamProvider.pseudoStreams['_selector'] = new StreamSelectScreen(d.streamProvider);
            await d.streamProvider.startStream(d.cm, { id: '_selector', name: 'stream selector' }, true);
        };
        addStream = async (d, listEl, camera) => {
            if (!d.streamProvider) { initStreamProvider(d); }
            let stream = await d.streamProvider.addMediaStream(camera);
            let el = mkEl('li', [
                "(", mkEl('span', stream.name, { className: 'streamName', title: stream.id }), ")",
                mkEl('button', 'x', { onclick: (_) => { d.streamProvider.remove(stream); el.parentElement.removeChild(el); } })
            ]);
            listEl.append(el);
        };

        let connectInputProxy = () => {
            inputProxySoc?.close();
            /** @type {HTMLInputElement} */
            let inputProxyUrlEl = document.querySelector("#inputProxyUrl");
            if (inputProxyUrlEl?.value) {
                inputProxySoc = new WebSocket(inputProxyUrlEl.value);
            }
        };
        document.querySelector('#connectInputButton')?.addEventListener('click', (ev) => connectInputProxy());
    }

    /** @type {Record<string, DeviceState>} */
    let devices = {};
    let updateDeviceList = (/** @type {DeviceSettings[]} */ deviceSettings) => {
        let parentEl = document.getElementById('devices');
        let exstings = Object.keys(devices);
        let current = deviceSettings.map(d => d.roomId);
        for (let d of exstings) {
            if (!current.includes(d)) {
                devices[d].cm.dispose();
                devices[d].el.parentNode.removeChild(devices[d].el);
                delete devices[d];
            }
        }
        for (let d of deviceSettings) {
            if (exstings.includes(d.roomId)) {
                continue;
            }
            let name = d.name || d.userAgent.replace(/^Mozilla\/[\d\.]+\s*/, '').replace(/[\s\(\)]+/g, ' ');
            let cm = new ConnectionManager(d);
            let listEl = mkEl('ul', [], { className: 'streamlist' });
            let removeButtonEl = mkEl('button', 'x', {
                onclick: (ev) => confirm(`Remove ${name} ?`) && Settings.removePeerDevice(d)
            });
            cm.onadded = (c) => {
                if (fileServer) {
                    c.conn.dataChannels['fileServer'] = {};
                    c.conn.onauth = () => {
                        Object.assign(c.conn.dataChannels['fileServer'], fileServer.getRtcChannelSpec());
                    };
                }
                let el = mkEl('li');
                listEl.appendChild(el);
                c.conn.onstatechange = () => {
                    if (c.conn.state == 'disposed') {
                        el.parentNode?.removeChild(el);
                        return;
                    }
                    if (c.conn.state == 'disconnected' && !c.permanent) {
                        c.conn.dispose();
                        return;
                    }
                    el.innerText = '';
                    el.append(
                        mkEl('span', c.name, { className: 'streamName', title: c.conn.roomId }),
                        mkEl('span', c.conn.state, { className: 'connectionstate connectionstate_' + c.conn.state }),
                    );
                    if (c.conn.state == 'connected') {
                        el.append(mkEl('button', 'x', { onclick: (_) => c.conn.disconnect() }));
                    }
                };
            };
            let titleEl = mkEl('span', name, {
                title: d.userAgent,
                ondblclick: (_) => {
                    let n = prompt("Change name", name);
                    if (n) {
                        titleEl.innerText = d.name = name = n;
                        Settings.addPeerDevice(d);
                    }
                }
            });
            let el = mkEl('div', [mkEl('span', [titleEl, removeButtonEl]), listEl]);
            let ds = { el: el, cm: cm };
            if (!d.services?.includes('no-client') && addStream) {
                let streamListEl = mkEl('ul', [], { className: 'streamlist' });
                el.append(
                    streamListEl,
                    mkEl('button', 'Share Desktop', { onclick: (_) => addStream(ds, streamListEl, false) }),
                    mkEl('button', 'Share Camera', { onclick: (_) => addStream(ds, streamListEl, true) }),
                );
            }
            if (d.services?.includes('screen') ?? true) {
                // el.append(mkEl('button', 'Open Remote Desktop', { onclick: (_ev) => playStream(d) }));
                el.append(mkEl('a', 'Open Remote Desktop', { target: '_blank', href: '#room:' + d.roomId }));
            }
            parentEl.append(el);
            devices[d.roomId] = ds;
            initStreams(ds);
        }
        if (deviceSettings.length == 0) {
            parentEl.classList.add('nodevices');
        } else {
            parentEl.classList.remove('nodevices');
        }
    };

    let onSettingUpdated = (settings) => {
        document.getElementById('pairing').style.display = settings[0] ? "none" : "block";
        document.getElementById('publishOrPlay').style.display = settings[0] ? "block" : "none";
        updateDeviceList(settings);
    };
    onSettingUpdated(Settings.getPeerDevices());
    Settings.onsettingsupdate = onSettingUpdated;
}

window.addEventListener('DOMContentLoaded', (ev) => {
    let playStream = initPlayer();
    let m = decodeURI(location.hash).match(/[&#]room:([^&]+)/);
    if (m) {
        let d = Settings.getPeerDevices().find(d => d.roomId == m[1]);
        if (d) {
            let closeEl = document.getElementById('closePlayerButton');
            if (closeEl) { closeEl.style.display = "none"; }
            playStream(d);
            return;
        }
    }
    initPublisher(playStream);
    initPairing();
}, { once: true });
