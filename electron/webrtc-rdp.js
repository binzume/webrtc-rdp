// @ts-check
'use strict';

// Please replace with your id and signalingKey!
const signalingUrl = 'wss://ayame-labo.shiguredo.jp/signaling';
const sendSignalingKey = (location.host.includes("binzume.") || globalThis.RDP);
const signalingKey = sendSignalingKey ? 'VV69g7Ngx-vNwNknLhxJPHs9FpRWWNWeUzJ9FUyylkD_yc_F' : null;
const roomIdPrefix = sendSignalingKey ? "binzume@rdp-room-" : "binzume-rdp-room-";
const roomIdPinPrefix = sendSignalingKey ? "binzume@rdp-pin-" : "binzume-rdp-pin-";
const enableStreamSelectScreen = true;

/** 
 * @typedef {{onmessage?: ((ch:RTCDataChannel,ev:any) => void), onopen?: ((ch:RTCDataChannel, ev:Event) => void), onclose?: ((ch:RTCDataChannel, ev:Event) => void), ch?:RTCDataChannel }} DataChannelInfo
 * @typedef {{name?: string, roomId: string, userAgent: string, token:string, signalingKey:string, version?:number}} DeviceSettings
 * @typedef {{id: string, name: string, hasAudio?: boolean}} StreamSpec
 * @typedef {{conn:PublisherConnection, name: string, id:number, opaque: any, permanent: boolean}} ConnectionInfo
 * @typedef {{startStream:((cm:ConnectionManager, spec:StreamSpec, permanent:boolean)=>Promise<ConnectionInfo>), getStreams?:(()=>Promise<StreamSpec[]>)}} StreamProvider
 */

class Settings {
    static settingsKey = 'webrtc-rdp-settings';
    static onsettingsupdate = null;
    static settingsVersion = 1;

    /**
     * @param {DeviceSettings} deviceInfo 
     */
    static addPeerDevice(deviceInfo) {
        // TODO: multiple devices
        deviceInfo.version = this.settingsVersion;
        localStorage.setItem(this.settingsKey, JSON.stringify(deviceInfo));
        this.onsettingsupdate && this.onsettingsupdate([deviceInfo]);
    }

    /**
     * @returns {DeviceSettings[]}
     */
    static getPeerDevices() {
        let s = localStorage.getItem(this.settingsKey);
        return s ? [JSON.parse(s)] : [];
    }

    /**
     * @param {DeviceSettings} deviceInfo 
     */
    static removePeerDevice(deviceInfo) {
        this.clear();
    }

    static clear() {
        localStorage.removeItem(this.settingsKey);
        this.onsettingsupdate && this.onsettingsupdate([]);
    }
}

class BaseConnection {
    /**
     * @param {string} signalingUrl 
     * @param {string} roomId 
     */
    constructor(signalingUrl, roomId) {
        this.signalingUrl = signalingUrl;
        this.roomId = roomId;
        this.conn = null;
        /** @type {MediaStream} */
        this.mediaStream = null;
        /** @type {Record<string, DataChannelInfo>} */
        this.dataChannels = {};
        this.onstatechange = null;
        this.state = "disconnected";
        this.options = Object.assign({}, Ayame.defaultOptions);
        this.options.video = Object.assign({}, this.options.video);
        this.options.audio = Object.assign({}, this.options.audio);
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
        this.updateState("connecting");
        if (this.connectTimeoutMs > 0) {
            this._connectTimer = setTimeout(() => this.disconnect(), this.connectTimeoutMs);
        }

        let conn = this.conn = Ayame.connection(this.signalingUrl, this.roomId, this.options, false);
        conn.on('open', async (e) => {
            for (let c of Object.keys(this.dataChannels)) {
                console.log("add dataChannel: " + c);
                this.handleDataChannel(await conn.createDataChannel(c));
            }
            this.updateState("waiting");
        });
        conn.on('connect', (e) => {
            clearTimeout(this._connectTimer);
            this.updateState("connected");
        });
        conn.on('datachannel', (channel) => {
            console.log('datachannel', channel?.label);
            this.handleDataChannel(channel);
        });
        conn.on('disconnect', (e) => {
            let oldState = this.state;
            this.conn = null;
            this.disconnect(e.reason);
            if ((oldState == "connected" || oldState == "waiting") && this.reconnectWaitMs >= 0) {
                setTimeout(() => this.connect(), this.reconnectWaitMs);
            }
        });
        return conn;
    }
    disconnect(reason = null) {
        console.log('disconnect', reason);
        clearTimeout(this._connectTimer);
        this.updateState("disconnected");
        if (this.conn) {
            this.conn.on('disconnect', () => { });
            this.conn.disconnect();
            this.conn.stream = null;
            this.conn = null;
        }
        for (let c of Object.values(this.dataChannels)) {
            c.ch = null;
        }
    }
    dispose() {
        this.disconnect();
        this.updateState("disposed");
        this.mediaStream?.getTracks().forEach(t => t.stop());
        this.mediaStream = null;
    }
    /**
     * @param {string} s
     */
    updateState(s) {
        if (s != this.state) {
            console.log(this.roomId, s);
            let oldState = this.state;
            this.state = s;
            this.onstatechange && this.onstatechange(s, oldState);
        }
    }
    /**
     * @param {RTCDataChannel} ch
     */
    handleDataChannel(ch) {
        if (!ch) return;
        let c = this.dataChannels[ch.label];
        if (c && !c.ch) {
            c.ch = ch;
            ch.onmessage = c.onmessage?.bind(ch, ch);
            // NOTE: dataChannel.onclose = null in Ayame.
            ch.addEventListener('open', c.onopen?.bind(ch, ch));
            ch.addEventListener('close', c.onclose?.bind(ch, ch));
        }
    }
}

class PairingConnection extends BaseConnection {
    /**
     * @param {string} signalingUrl 
     */
    constructor(signalingUrl) {
        super(signalingUrl, null);
        this.pinLength = 6;
        this.pin = null;
        this.userAgent = navigator.userAgent;
        this.options.signalingKey = signalingKey;
        this.pinTimeoutSec = 3600;
    }

    validatePin(pin) {
        return pin && pin.length >= this.pinLength;
    }

    async startPairing() {
        console.log("PIN:" + this.pin);
        this.pin = this._generatePin();
        this.disconnect();
        this.connectTimeoutMs = this.pinTimeoutSec * 1000;

        this.dataChannels['secretExchange'] = {
            onopen: (ch, ev) => {
                ch.send(JSON.stringify({ type: "hello", userAgent: this.userAgent }));
            },
            onmessage: (_ch, ev) => {
                console.log('ch msg', ev.data);
                let msg = JSON.parse(ev.data);
                if (msg.type == 'credential') {
                    Settings.addPeerDevice({ roomId: msg.roomId, signalingKey: msg.signalingKey, token: msg.token, userAgent: msg.userAgent });
                    this.disconnect();
                }
            },
        };
        await this.connect();
    }

    async sendPin(pin) {
        if (!this.validatePin(pin)) {
            throw "invalid pin";
        }
        this.disconnect();
        this.pin = pin;
        this.connectTimeoutMs = 10000;

        this.dataChannels['secretExchange'] = {
            onmessage: (ch, ev) => {
                console.log('ch msg', ev.data);
                let msg = JSON.parse(ev.data);
                if (msg.type == 'hello') {
                    let roomId = roomIdPrefix + this._generateSecret(16);
                    let token = this._generateSecret(16);
                    ch.send(JSON.stringify({ type: "credential", roomId: roomId, signalingKey: signalingKey, token: token, userAgent: this.userAgent }));
                    Settings.addPeerDevice({ roomId: roomId, signalingKey: signalingKey, token: token, userAgent: msg.userAgent });
                    this.disconnect();
                }
            },
        };
        await this.connect();
    }

    async connect() {
        this.roomId = roomIdPinPrefix + this.pin;
        await this.setupConnection().connect(null);
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
     * @param {DataChannelInfo} messageHandler 
     */
    constructor(signalingUrl, roomId, mediaStream, messageHandler = null) {
        super(signalingUrl, roomId);
        this.options.video.direction = 'sendonly';
        this.options.audio.direction = 'sendonly';
        this.mediaStream = mediaStream;
        this.reconnectWaitMs = 3000;
        this.dataChannels['controlEvent'] = messageHandler || {};
    }
}

class PlayerConnection extends BaseConnection {
    /**
     * @param {string} signalingUrl 
     * @param {string} roomId 
     * @param {HTMLVideoElement} videoEl 
     */
    constructor(signalingUrl, roomId, videoEl) {
        super(signalingUrl, roomId);
        this.options.video.direction = 'recvonly';
        this.options.audio.direction = 'recvonly';
        this.videoEl = videoEl;
        this.dataChannels['controlEvent'] = {
            onmessage: (ch, ev) => {
                let msg = JSON.parse(ev.data);
                if (msg.type == 'redirect') {
                    if (msg.roomId) {
                        this.disconnect();
                        this.roomId = msg.roomId;
                        this.connect();
                    }
                }
            }
        };
    }
    setupConnection() {
        let conn = super.setupConnection();
        conn.on('addstream', (ev) => {
            this.mediaStream = ev.stream;
            this.videoEl.srcObject = ev.stream;
        });
        return conn;
    }
    disconnect(reason = null) {
        if (this.videoEl.srcObject == this.mediaStream) {
            this.videoEl.srcObject = null;
        }
        super.disconnect(reason);
    }
    sendMouseEvent(action, x, y, button) {
        this.dataChannels['controlEvent'].ch?.send(JSON.stringify({ type: 'mouse', action: action, x: x, y: y, button: button }));
    }
    sendKeyEvent(action, key, code, shift = false, ctrl = false, alt = false) {
        this.dataChannels['controlEvent'].ch?.send(JSON.stringify({ type: 'key', action: action, key: key, code: code, shift: shift, ctrl: ctrl, alt: alt }));
    }
}

class ConnectionManager {
    constructor(settings) {
        this.settings = settings;
        this.onadded = null;
        /**  @type {ConnectionInfo[]} */
        this._connections = [];
    }

    /**
     * @param {MediaStream} mediaStream 
     * @param {DataChannelInfo} messageHandler 
     * @param {string} name 
     * @param {boolean} connect 
     * @param {boolean} permanent 
     * @param {any} opaque 
     * @returns {ConnectionInfo}
     */
    addStream(mediaStream, messageHandler = null, name = null, connect = true, permanent = true, opaque = null) {
        let id = this._genId();
        name = name || mediaStream.getVideoTracks()[0]?.label || mediaStream.id;
        let conn = new PublisherConnection(signalingUrl, this.settings.roomId + "." + id, mediaStream, messageHandler);
        conn.options.signalingKey = this.settings.signalingKey;
        conn.connectTimeoutMs = permanent ? -1 : 30000;
        conn.reconnectWaitMs = permanent ? 2000 : -1;

        let info = { conn: conn, id: id, name: name, opaque: opaque, permanent: permanent };
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
    _genId() {
        let n = 1;
        while (this._connections.some(c => c.id == n)) n++;
        return n;
    }
    connectAll() {
        this._connections.forEach((c) => c.conn.connect());
    }
    disconnectAll() {
        this._connections.forEach((c) => c.conn.disconnect());
    }
    clear() {
        this.disconnectAll();
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
        this.streams = [];
        this.buttonSpec = { width: 520, height: 20, font: 'bold 18px sans-serif', color: 'black' };
        this.buttonLayout = { top: 24, left: (canvas.width - this.buttonSpec.width) / 2, spacing: 6 };
        this._attachCount = 0;
        this._updateTimer = null;
    }
    async update() {
        let streams = await this.streamProvider.getStreams();
        this.streams = streams;
        let canvas = this.canvasEl;
        let ctx = this.ctx;
        ctx.fillStyle = 'white';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = 'black';
        ctx.font = 'normal 18px sans-serif';
        ctx.textBaseline = 'top';
        ctx.textAlign = 'center';
        if (streams.length == 0) {
            ctx.fillText('No Available Screen', canvas.width / 2, 100);
        }
        ctx.fillText('Available streams (Click to select)', canvas.width / 2, 0);

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
            onopen(_ch, _ev) { self.attach(); },
            onclose(_ch, _ev) { self.detach(); },
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
        if (msg.type == 'mouse' && msg.action == 'click') {
            this.update();
            let x = msg.x * this.canvasEl.width, y = msg.y * this.canvasEl.height;
            let layout = this.buttonLayout;
            if (x < layout.left || x > layout.left + this.buttonSpec.width || y < layout.top) {
                return;
            }
            let n = Math.floor((y - layout.top) / (this.buttonSpec.height + layout.spacing));
            if (this.streams[n]) {
                let c = await this.streamProvider.startStream(cm, this.streams[n], false);
                if (c) {
                    ch.send(JSON.stringify({ type: 'redirect', 'roomId': c.conn.roomId }));
                }
            }
        }
    }
    attach() {
        if (this._attachCount == 0) {
            this._updateTimer = setInterval(() => this.update(), 1000);
            this.update();
        }
        this._attachCount++;
    }
    detach() {
        this._attachCount--;
        if (this._attachCount == 0) {
            clearInterval(this._updateTimer);
            this.ctx.fillRect(0, 0, this.canvasEl.width, this.canvasEl.height);
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
        let self = this;
        let dataChannelInfo = {
            ch: null,
            async onopen(ch, ev) {
                // TODO: timeout
                let c = await self.streamProvider.startStream(cm, self.target, false);
                ch.send(JSON.stringify({ type: 'redirect', 'roomId': c.conn.roomId }));
            }
        };
        return await cm.addStream(null, dataChannelInfo, s.name, true, permanent);
    }
}

class BrowserStreamProvider {
    constructor() {
        /** @type {WebSocket} */
        this.inputProxySoc = null;
        /** @type {Record<string, StreamProvider>} */
        this.pseudoStreams = {};
        /** @type {{spec:StreamSpec, isCamera: boolean, mediaStream: MediaStream}[]} */
        this._streams = [];
        this._idSeq = 0;
    }

    /**
     * @param {boolean} camera 
     * @returns {Promise<StreamSpec>}
     */
    async addMediaStream(camera = false) {
        let mediaStream = await (camera ? navigator.mediaDevices.getUserMedia({ audio: true, video: true }) : navigator.mediaDevices.getDisplayMedia({ audio: true, video: true }));
        let name = mediaStream.getVideoTracks()[0]?.label || "?";
        let s = { spec: { id: 'BrowserStreamProvider_' + (++this._idSeq), name: name }, mediaStream: mediaStream, isCamera: camera };
        this._streams.push(s);
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
        let messageHandler = {
            onmessage(_ch, ev) {
                let msg = JSON.parse(ev.data);
                if (this.inputProxySoc?.readyState == 1 && (msg.type == 'mouse' || msg.type == 'key') && target) {
                    msg.target = target;
                    this.inputProxySoc.send(JSON.stringify(msg));
                } else {
                    console.log("drop:", msg);
                }
            },
        };
        return cm.addStream(stream.mediaStream, messageHandler, null, true, permanent);
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
    constructor() {
        this.lastMouseMoveTime = 0;
        this.streamTypes = ['screen', 'window'];
        /** @type {Record<string, StreamProvider>} */
        this.pseudoStreams = {};
    }
    /**
     * @returns {Promise<StreamSpec[]>}
     */
    async getStreams() {
        return await RDP.getDisplayStreams(this.streamTypes);
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
            return cm.addStream(mediaStream, {
                onmessage: (ch, ev) => this._handleMessage(cm, s, ch, JSON.parse(ev.data))
            }, s.name, true, permanent);
        } catch (e) {
            console.log(e);
            return null;
        }
    }
    /**
     * @param {ConnectionManager} cm 
     * @param {StreamSpec} s 
     * @param {RTCDataChannel} ch 
     * @param {object} msg 
     */
    async _handleMessage(cm, s, ch, msg) {
        if (msg.type == 'mouse') {
            let now = Date.now();
            if (now - this.lastMouseMoveTime < 10 && msg.action == 'move') {
                return;
            }
            this.lastMouseMoveTime = now;
            await RDP.sendMouse({ target: s, action: msg.action, button: msg.button, x: msg.x, y: msg.y });
        } else if (msg.type == 'key') {
            let modifiers = [];
            msg.ctrl && modifiers.push('control');
            msg.alt && modifiers.push('alt');
            msg.shift && modifiers.push('shift');
            await RDP.sendKey({ target: s, action: msg.action, key: msg.key, modifiers: modifiers });
        } else if (msg.type == 'getstreamlist') {
            let streams = await this.getStreams();
            ch.send(JSON.stringify({ 'type': 'streams', 'streams': streams.map(s => ({ id: s.id, name: s.name })) }));
        } else if (msg.type == 'play') {
            let streams = await this.getStreams();
            let s = streams.find(s => s.id == msg.streamId);
            if (!s) {
                return;
            }
            let c = await this.startStream(cm, s);
            ch.send(JSON.stringify({ type: 'redirect', 'roomId': c?.conn.roomId }));
        } else {
            console.log("drop:", msg);
        }
    }
}


window.addEventListener('DOMContentLoaded', (ev) => {
    /**
     * @param {string} tag 
     * @param {string[] | string | Node[] | any} children 
     * @param {object | function} attrs
     * @returns {Element}
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
    document.querySelector('#clearSettingsButton').addEventListener('click', (ev) => confirm('CLear all settiungs?') && Settings.clear());


    // Publisher
    let updateConnectionState = (manager, c, el) => {
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
            mkEl('span', "stream" + c.id + " : " + c.name, { className: 'streamName', title: c.conn.roomId }),
            mkEl('span', c.conn.state, { className: 'connectionstate connectionstate_' + c.conn.state }),
            mkEl('button', 'x', (btn) =>
                btn.addEventListener('click', (ev) => manager.removeStream(c.id))
            ),
        );
    };

    let browserStreamProvider = isElectronApp ? null : new BrowserStreamProvider();
    let connectInputProxy = () => {
        browserStreamProvider.inputProxySoc?.close();
        /** @type {HTMLInputElement} */
        let inputProxyUrlEl = document.querySelector("#inputProxyUrl");
        if (inputProxyUrlEl?.value) {
            browserStreamProvider.inputProxySoc = new WebSocket(inputProxyUrlEl.value);
        }
    };
    let addStream = async (cm, camera) => {
        let spec = await browserStreamProvider.addMediaStream(camera);
        await browserStreamProvider.startStream(cm, spec);
    };
    document.querySelector('#connectInputButton')?.addEventListener('click', (ev) => connectInputProxy());

    let addInitStreams = async ( /** @type {ConnectionManager} */cm) => {
        if (!isElectronApp) {
            return;
        }
        let streamProvider = new ElectronStreamProvider();
        if (enableStreamSelectScreen) {
            streamProvider.pseudoStreams['_selector'] = new StreamSelectScreen(streamProvider);
            streamProvider.pseudoStreams['_redirector'] = new StreamRedirector(streamProvider, { id: '_selector', name: 'selector' });
            // await streamProvider.startStream(cm, { id: '_redirector', name: 'redirector' }, true);
            await streamProvider.startStream(cm, { id: '_selector', name: 'selector' }, true);
        } else {
            streamProvider.streamTypes = ['screen'];
            for (let stream of await streamProvider.getStreams()) {
                await streamProvider.startStream(cm, stream, true);
            }
        }
    };

    let devices = {};
    let updateDeviceList = (/** @type {DeviceSettings[]} */ deviceSettings) => {
        let parentEl = document.getElementById('devices');
        let exstings = Object.keys(devices);
        let current = deviceSettings.map(d => d.roomId);
        for (let d of exstings) {
            if (!current.includes(d)) {
                devices[d].manager.clear();
                devices[d].el.parentNode.removeChild(devices[d].el);
            }
            delete devices[d];
        }
        for (let d of deviceSettings) {
            if (exstings.includes(d.roomId)) {
                continue;
            }
            let name = d.name || d.userAgent.replace(/^Mozilla\/[\d\.]+\s*/, '').replace(/[\s\(\)]+/g, ' ').substring(0, 50) + '...';
            let cm = new ConnectionManager(d);
            let listEl = mkEl('ul', [], { className: 'streamlist' });
            let removeButtonEl = mkEl('button', 'x', (el) =>
                el.addEventListener('click', (ev) => {
                    confirm(`Remove ${name} ?`) && Settings.removePeerDevice(d);
                })
            );
            cm.onadded = (c) => {
                let el = mkEl('li');
                listEl.appendChild(el);
                c.conn.onstatechange = () => updateConnectionState(cm, c, el);
            };
            let el = mkEl('div', [mkEl('span', [name, removeButtonEl], { title: d.userAgent }), listEl]);
            if (browserStreamProvider) {
                el.append(
                    mkEl('button', 'Share Desktop', (el) =>
                        el.addEventListener('click', (ev) => addStream(cm, false))),
                    mkEl('button', 'Share Camera', (el) =>
                        el.addEventListener('click', (ev) => addStream(cm, true))),
                    mkEl('button', 'Player', (el) =>
                        el.addEventListener('click', (ev) => {
                            document.body.classList.add('player');
                            currentDevice = d;
                            playStream();
                        })),
                );
            }
            parentEl.append(el);
            devices[d.roomId] = { el: el, manager: cm };
            addInitStreams(cm);
        }
        if (deviceSettings.length == 0) {
            parentEl.classList.add('nodevices');
        } else {
            parentEl.classList.remove('nodevices');
        }
    };

    let onSettingUpdated = (settings) => {
        document.getElementById('pairng').style.display = settings[0] ? "none" : "block";
        document.getElementById('publishOrPlay').style.display = settings[0] ? "block" : "none";
        updateDeviceList(settings);
    };
    onSettingUpdated(Settings.getPeerDevices());
    Settings.onsettingsupdate = onSettingUpdated;


    // Player
    /** @type {PlayerConnection} */
    let player = null;
    /** @type {HTMLVideoElement} */
    let videoEl = document.querySelector('#screen');
    let currentStreamId = "1";
    /** @type {DeviceSettings} */
    let currentDevice = null;
    let playStream = () => {
        player?.disconnect();
        videoEl.style.display = "none";
        document.getElementById('connectingBox').style.display = "block";
        if (currentDevice) {
            player = new PlayerConnection(signalingUrl, currentDevice.roomId + "." + currentStreamId, videoEl);
            player.onstatechange = (state) => {
                if (state == "connected") {
                    videoEl.style.display = "block";
                    document.getElementById('connectingBox').style.display = "none";
                }
            };
            player.options.signalingKey = currentDevice.signalingKey;
            player.connect();
        }
    };
    let dragging = false;
    let dragTimer = null;
    let sendMouse = (action, ev) => {
        if (player?.state == "connected") {
            let rect = videoEl.getBoundingClientRect();
            let vw = Math.min(rect.width, rect.height * videoEl.videoWidth / videoEl.videoHeight);
            let vh = Math.min(rect.height, rect.width * videoEl.videoHeight / videoEl.videoWidth);
            let x = (ev.clientX - rect.left - (rect.width - vw) / 2) / vw, y = (ev.clientY - rect.top - (rect.height - vh) / 2) / vh;
            if (action != 'up' && (x > 1 || x < 0 || y > 1 || y < 0)) action = "move";
            if (action == 'click' && dragging) action = "up";
            player.sendMouseEvent(action, x, y, ev.button);
            ev.preventDefault();
        }
    };
    videoEl.addEventListener('click', (ev) => sendMouse('click', ev));
    videoEl.addEventListener('auxclick', (ev) => sendMouse('click', ev));
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
        console.log('pointerup', dragging);
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
    window.addEventListener('keydown', (ev) => {
        if (player?.state == "connected") {
            player.sendKeyEvent('press', ev.key, ev.code, ev.shiftKey, ev.ctrlKey, ev.altKey);
            ev.preventDefault();
        }
    });
    document.querySelector('#playButton').addEventListener('click', (ev) => playStream());
    document.querySelector('#fullscreenButton').addEventListener('click', (ev) => videoEl.requestFullscreen());

    // Pairing
    document.getElementById('addDeviceButton').addEventListener('click', (ev) => {
        document.getElementById("pairng").style.display = "block";
        document.getElementById("pinDisplayBox").style.display = "none";
        document.getElementById("pinInputBox").style.display = "block";
    });

    let pairing = new PairingConnection(signalingUrl);
    document.getElementById('inputPin').addEventListener('click', (ev) => {
        document.getElementById("pinDisplayBox").style.display = "none";
        document.getElementById("pinInputBox").style.display = "block";
    });
    document.getElementById('sendPinButton').addEventListener('click', (ev) => {
        let pin = /** @type {HTMLInputElement} */(document.getElementById("pinInput")).value.trim();
        if (pairing.validatePin(pin)) {
            document.getElementById("pinInputBox").style.display = "none";
            pairing.sendPin(pin);
        }
    });
    document.querySelector('#generatePin').addEventListener('click', async (ev) => {
        document.getElementById("pinDisplayBox").style.display = "block";
        document.getElementById("pinInputBox").style.display = "none";
        pairing.onstatechange = (state) => {
            if (state == "connected" || state == "waiting") {
                document.getElementById("pin").innerText = pairing.pin;
            } else {
                document.getElementById("pin").innerText = "......";
            }
        };
        pairing.startPairing();
    });

}, { once: true });
