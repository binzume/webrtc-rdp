// @ts-check
'use strict';

// Please replace with your id and signalingKey!
const signalingUrl = 'wss://ayame-labo.shiguredo.jp/signaling';
const signalingKey = location.host.includes("binzume.") ? 'VV69g7Ngx-vNwNknLhxJPHs9FpRWWNWeUzJ9FUyylkD_yc_F' : null;
const roomIdPrefix = signalingKey ? "binzume@rdp-room-" : "binzume-rdp-room-";
const roomIdPinPrefix = signalingKey ? "binzume@rdp-pin-" : "binzume-rdp-pin-";
const settingsVersion = 1;

/** 
 * @typedef {{onmessage?: ((ev:any) => void), onopen?: ((ev:any) => void), ch?:RTCDataChannel }} DataChannelInfo
 * @typedef {{send?: ((ev:any, conn:any) => void)}} InputProxy
 * @typedef {{name?: string, roomId: string, userAgent: string, token:string, signalingKey:string}} DeviceSettings
 */

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
    }
    setupConnection() {
        console.log("connecting..." + this.signalingUrl + " " + this.roomId);
        this.updateStaet("connecting");

        let conn = this.conn = Ayame.connection(this.signalingUrl, this.roomId, this.options, true);
        conn.on('open', async (e) => {
            console.log('open', e, this.dataChannels);
            for (let c of Object.keys(this.dataChannels)) {
                console.log("add dataChannel", c);
                this.handleDataChannel(await conn.createDataChannel(c));
            }
            this.updateStaet("ready");
        });
        conn.on('connect', (e) => {
            this.updateStaet("connected");
        });
        conn.on('datachannel', (channel) => {
            console.log('datachannel', channel);
            this.handleDataChannel(channel);
        });
        conn.on('disconnect', (e) => {
            let oldState = this.state;
            this.conn = null;
            this.disconnect(e);
            if ((oldState == "connected" || oldState == "ready") && this.reconnectWaitMs >= 0) {
                setTimeout(() => this.setupConnection().connect(this.mediaStream, null), this.reconnectWaitMs);
            }
        });
        this.initConnection(conn);
        return conn;
    }
    initConnection(conn) {
    }
    disconnect(reason = null) {
        console.log('disconnect', reason);
        this.updateStaet("disconnected");
        this.conn?.on('disconnect', () => { });
        this.conn?.disconnect();
        this.conn = null;
        for (let c of Object.values(this.dataChannels)) {
            c.ch = null;
        }
    }
    dispose() {
        this.disconnect();
        this.updateStaet("disposed");
    }
    updateStaet(s) {
        if (s != this.state) {
            console.log(this.roomId, s);
            let oldState = this.state;
            this.state = s;
            this.onstatechange && this.onstatechange(s, oldState);
        }
    }
    handleDataChannel(ch) {
        if (!ch) return;
        let c = this.dataChannels[ch.label];
        console.log(c);
        if (c && !c.ch) {
            c.ch = ch;
            ch.onmessage = c.onmessage;
            ch.onopen = c.onopen;
        }
    }
    sendData(chLabel, data) {
        this.dataChannels[chLabel].ch?.send(data);
    }
}

class PairingManager extends BaseConnection {
    /**
     * @param {string} signalingUrl 
     */
    constructor(signalingUrl) {
        super(signalingUrl, null);
        this.pinLength = 6;
        this.pin = null;
        this.onsettingsupdate = null;
        this.userAgent = navigator.userAgent;
        this.settingsKey = 'webrtc-rdp-settings';
        this.options.signalingKey = signalingKey;
        this.pinTimeoutSec = 3600;
        this.pinTimer = null;
    }

    validatePin(pin) {
        return pin && pin.length >= this.pinLength;
    }

    async startPairing() {
        console.log("PIN:" + this.pin);
        this.pin = this._generatePin();
        this.disconnect();

        this.dataChannels['secretExchange'] = {
            onopen: (ev) => {
                console.log('ch open', ev);
                ev.target.send(JSON.stringify({ type: "hello", userAgent: this.userAgent }));
            },
            onmessage: (ev) => {
                console.log('ch msg', ev.data);
                let msg = JSON.parse(ev.data);
                if (msg.type == 'credential') {
                    this.setPeerSettings({ roomId: msg.roomId, signalingKey: msg.signalingKey, token: msg.token, userAgent: msg.userAgent });
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

        this.dataChannels['secretExchange'] = {
            onopen: (ev) => {
                console.log('ch open', ev);
            },
            onmessage: (ev) => {
                console.log('ch msg', ev.data);
                let msg = JSON.parse(ev.data);
                if (msg.type == 'hello') {
                    let roomId = roomIdPrefix + this._generateSecret(16);
                    let token = this._generateSecret(16);
                    ev.target.send(JSON.stringify({ type: "credential", roomId: roomId, signalingKey: signalingKey, token: token, userAgent: this.userAgent }));
                    this.setPeerSettings({ roomId: roomId, signalingKey: signalingKey, token: token, userAgent: msg.userAgent });
                }
            },
        };
        await this.connect();
    }

    async connect() {
        clearTimeout(this.pinTimer);
        this.pinTimer = setTimeout(() => this.disconnect(), this.pinTimeoutSec * 1000);
        this.roomId = roomIdPinPrefix + this.pin;
        await this.setupConnection().connect(null);
    }

    setPeerSettings(settings) {
        if (!settings) {
            localStorage.removeItem(this.settingsKey);
        } else {
            settings.version = settingsVersion;
            localStorage.setItem(this.settingsKey, JSON.stringify(settings));
        }
        this.onsettingsupdate && this.onsettingsupdate(settings);
    }

    getPeerSettings() {
        let s = localStorage.getItem(this.settingsKey);
        return s ? JSON.parse(s) : null;
    }

    _generatePin() {
        return (Math.floor(Math.random() * 1000000) + "000000").substring(0, this.pinLength);
    }

    _generateSecret(n) {
        const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
        return Array.from(crypto.getRandomValues(new Uint8Array(n))).map((c) => chars[c % chars.length]).join('');
    }
}

class DataConnection extends BaseConnection {
    /**
     * @param {string} signalingUrl 
     * @param {string} roomId 
     */
    constructor(signalingUrl, roomId) {
        super(signalingUrl, roomId);
        this.options.video.enabled = false;
        this.options.audio.enabled = false;
        this.reconnectWaitMs = 3000;
    }

    async connect(ch) {
        if (this.conn) {
            return;
        }
        this.dataChannels['controlEvent'] = ch;
        await this.setupConnection().connect(null, null);
    }
}

class PublisherConnection extends BaseConnection {
    /**
     * @param {string} signalingUrl 
     * @param {string} roomId 
     * @param {MediaStream} mediaStream 
     * @param {InputProxy} inputProxy 
     */
    constructor(signalingUrl, roomId, mediaStream, inputProxy = null, isCamera = false) {
        super(signalingUrl, roomId);
        this.options.video.direction = 'sendonly';
        this.options.audio.direction = 'sendonly';
        this.mediaStream = mediaStream;
        this.inputProxy = inputProxy;
        this.isCamera = isCamera;
        this.reconnectWaitMs = 3000;
        this.target = this._getTarget(mediaStream);
    }
    async connect() {
        if (this.conn) {
            return;
        }

        this.dataChannels['controlEvent'] = {
            onmessage: (ev) => {
                this.inputProxy?.send(JSON.parse(ev.data), this);
            }
        };
        await this.setupConnection().connect(this.mediaStream, null);
    }
    /**
     * @returns {{type: string, id: number}}
     */
    _getTarget(mediaStream) {
        let surface = mediaStream.getVideoTracks()[0]?.getSettings().displaySurface;
        let label = mediaStream.getVideoTracks()[0]?.label;
        if (surface == null || label == null) {
            // TODO: Firefox
            return this.isCamera ? null : { type: 'monitor', id: 0 };
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
        this.mediaStream = null;
    }

    async connect() {
        if (this.conn || this.state == 'disposed') {
            return;
        }

        this.dataChannels['controlEvent'] = {
            onopen: (ev) => {
                console.log('ch open', ev);
                ev.target.send(JSON.stringify({ type: "play", stream: 'default' }));
            },
        };

        await this.setupConnection().connect(this.mediaStream, null);
    }
    initConnection(conn) {
        conn.on('addstream', (ev) => {
            this.mediaStream = ev.stream;
            this.videoEl.srcObject = ev.stream;
        });
        conn.on('disconnect', async (e) => {
            this.conn = null;
            this.disconnect(e);
            if (this.videoEl.srcObject == this.mediaStream) {
                this.videoEl.srcObject = null;
            }
        });
    }
    sendMouseEvent(action, x, y, button) {
        this.sendData('controlEvent', JSON.stringify({ type: 'mouse', action: action, x: x, y: y, button: button }));
    }
    sendKeyEvent(action, key, code, shift = false, ctrl = false, alt = false) {
        this.sendData('controlEvent', JSON.stringify({ type: 'key', action: action, key: key, code: code, shift: shift, ctrl: ctrl, alt: alt }));
    }
}

class ConnectionManager {
    constructor(settings, onupdate) {
        this.settings = settings;
        /**
         * @type {{conn:PublisherConnection, name: string, id:number, opaque: any}[]}
         */
        this.mediaConnections = [];
        this.onupdate = onupdate;
    }

    addStream(mediaStream, inputProxy = null, isCamera = false, name = null, connect = true) {
        let id = this._genId();
        name = name || mediaStream.getVideoTracks()[0]?.label || mediaStream.id;
        let conn = new PublisherConnection(signalingUrl, this.settings.roomId + "." + id, mediaStream, inputProxy, isCamera);
        conn.options.signalingKey = this.settings.signalingKey;
        if (connect) {
            conn.connect();
        }
        this.update();
        let info = { conn: conn, id: id, name: name, opaque: null };
        this.mediaConnections.push(info);
        return info;
    }
    removeStream(id) {
        let index = this.mediaConnections.findIndex(c => c.id == id);
        if (index >= 0) {
            this.mediaConnections[index].conn.dispose();
            this.mediaConnections[index].conn.mediaStream.getTracks().forEach(t => t.stop());
            this.mediaConnections.splice(index, 1);
        }
        this.update();
    }
    _genId() {
        let n = 1;
        while (this.mediaConnections.some(c => c.id == n)) n++;
        return n;
    }
    connectAll() {
        this.mediaConnections.forEach((c) => c.conn.connect());
        this.update();
    }
    disconnectAll() {
        this.mediaConnections.forEach((c) => c.conn.disconnect());
        this.update();
    }
    update() {
        this.onupdate && this.onupdate();
    }
    clear() {
        this.disconnectAll();
        this.mediaConnections = [];
    }
}


window.addEventListener('DOMContentLoaded', (ev) => {
    let pairing = new PairingManager(signalingUrl);
    /**
     * @type {ConnectionManager}
     */
    // let manager = null;
    /**
     * @type {PlayerConnection}
     */
    let player = null;
    /**
     * @type {WebSocket}
     */
    let inputProxySoc = null;
    let connectInputProxy = () => {
        inputProxySoc?.close();
        /** @type {HTMLInputElement} */
        let inputProxyUrlEl = document.querySelector("#inputProxyUrl");
        if (inputProxyUrlEl?.value) {
            inputProxySoc = new WebSocket(inputProxyUrlEl.value);
        }
    };

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


    let addDefaultStreams = (device) => {
        if (!globalThis.RDP) {
            return;
        }
        document.getElementById("select").style.display = "none";
        (async () => {
            console.log("Using window.RDP");
            let streams = await RDP.getDisplayStreams(['screen']); // 'window'
            for (let s of streams.slice(0, 5)) {
                try {
                    let mediaStream = await navigator.mediaDevices.getUserMedia({
                        video: {
                            // @ts-ignore
                            mandatory: {
                                chromeMediaSource: 'desktop',
                                chromeMediaSourceId: s.id,
                            }
                        },
                        audio: {
                            // @ts-ignore
                            mandatory: {
                                chromeMediaSource: 'desktop',
                            }
                        }
                    });
                    let lastMouseMoveTime = 0;
                    let c = await device.manager.addStream(mediaStream, {
                        async send(msg, conn) {
                            if (msg.type == 'mouse') {
                                let now = Date.now();
                                if (now - lastMouseMoveTime < 40 && msg.action == 'move') {
                                  return;
                                }
                                lastMouseMoveTime = now;                            
                                await RDP.sendMouse({ target: s, action: msg.action, button: msg.button, x: msg.x, y: msg.y });
                            } else if (msg.type == 'key') {
                                let modifiers = [];
                                msg.ctrl && modifiers.push('control');
                                msg.alt && modifiers.push('alt');
                                msg.shift && modifiers.push('shift');
                                await RDP.sendKey({ target: s, action: msg.action, key: msg.key, modifiers: modifiers });
                            } else if (msg.type == 'stream') {
                                await RDP.getDisplayStreams(['screen', 'window']);
                            } else {
                                console.log("drop:", msg);
                            }
                        }
                    }, false, s.name);
                    let el = document.querySelector('#streams');
                    c.opaque = mkEl('li');
                    updateStreamInfo(device.manager, c);
                    c.conn.onstatechange = () => updateStreamInfo(device.manager, c);
                    device.listEl.appendChild(c.opaque);
                } catch (e) {
                    console.log(e);
                }
            }
        })();
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
            let name = d.name || d.roomId;
            let cm = new ConnectionManager(d);
            let listEl = mkEl('ul', [], { className: 'streamlist' });
            let removeButtonEl = mkEl('button', 'x', (el) =>
                el.addEventListener('click', (ev) => {
                    confirm(`Remove ${name} ?`) && pairing.setPeerSettings(null);
                })
            );
            let el = mkEl('div', [mkEl('span', [name, removeButtonEl], { title: d.userAgent }), listEl]);
            if (!globalThis.RDP) {
                el.append(
                    mkEl('button', 'Add Screen Stream', (el) =>
                        el.addEventListener('click', (ev) => addStream(false))),
                    mkEl('button', 'Add Camera Stream', (el) =>
                        el.addEventListener('click', (ev) => addStream(true))),
                );
            }
            parentEl.append(el);
            devices[d.roomId] = { el: el, manager: cm, listEl: listEl };
            addDefaultStreams(devices[d.roomId]);
        }
        if (deviceSettings.length == 0) {
            parentEl.append(mkEl('span', 'No devices', { className: 'nodevices' }));
        }
    };

    let updateButtonState = (settings) => {
        if (settings) {
            pairing.disconnect();
        }
        document.getElementById('pairng').style.display = settings ? "none" : "block";
        document.getElementById('publishOrPlay').style.display = settings ? "block" : "none";
        updateDeviceList(settings ? [settings] : []); // TODO: multiple devices
    };
    updateButtonState(pairing.getPeerSettings());
    pairing.onsettingsupdate = updateButtonState;

    let updateStreamInfo = (manager, c) => {
        let el = c.opaque;
        el.innerText = '';
        el.append(
            mkEl('span', "stream" + c.id + " : " + c.name, { className: 'streamName' }),
            mkEl('span', c.conn.state, { className: 'connectionstate connectionstate_' + c.conn.state }),
            mkEl('button', 'x', (btn) =>
                btn.addEventListener('click', (ev) => {
                    manager.removeStream(c.id);
                    el.parentNode.removeChild(el);
                })
            ),
        );
    };

    let addStream = async (camera = false) => {
        let mediaStream = await (camera ? navigator.mediaDevices.getUserMedia({ audio: true, video: true }) : navigator.mediaDevices.getDisplayMedia({ audio: true, video: true }));
        let inputProxy = {
            send(msg, conn) {
                if (inputProxySoc?.readyState == 1 && (msg.type == 'mouse' || msg.type == 'key') && conn.target) {
                    msg.target = conn.target;
                    inputProxySoc.send(JSON.stringify(msg));
                } else {
                    console.log("drop:", msg);
                }
            }
        };
        let device = Object.values(devices)[0];
        let c = await device.manager.addStream(mediaStream, inputProxy, camera);
        c.opaque = mkEl('li');
        updateStreamInfo(device.manager, c);
        c.conn.onstatechange = () => updateStreamInfo(device.manager, c);
        device.listEl.appendChild(c.opaque);
    };


    /** @type {HTMLVideoElement} */
    let videoEl = document.querySelector('#screen');
    let playStream = (n) => {
        player?.disconnect();
        let settings = pairing.getPeerSettings();
        videoEl.style.display = "none";
        document.getElementById('connectingBox').style.display = "block";
        if (settings) {
            player = new PlayerConnection(signalingUrl, settings.roomId + "." + n, videoEl);
            player.onstatechange = (state) => {
                if (state == "connected") {
                    videoEl.style.display = "block";
                    document.getElementById('connectingBox').style.display = "none";
                }
            };
            player.options.signalingKey = settings.signalingKey;
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

    // Pairing
    document.getElementById('inputPin').addEventListener('click', (ev) => {
        document.getElementById("pinDisplayBox").style.display = "none";
        document.getElementById("pinInputBox").style.display = "block";
    });
    document.getElementById('sendPinButton').addEventListener('click', (ev) => {
        let pin = document.getElementById("pinInput").value.trim();
        if (pairing.validatePin(pin)) {
            pairing.sendPin(pin);
            document.getElementById("pinInputBox").style.display = "none";
        }
    });
    document.querySelector('#generatePin').addEventListener('click', async (ev) => {
        document.getElementById("pinDisplayBox").style.display = "block";
        document.getElementById("pinInputBox").style.display = "none";
        pairing.onstatechange = (state) => {
            if (state == "connected" || state == "ready") {
                document.getElementById("pin").innerText = pairing.pin;
            } else {
                document.getElementById("pin").innerText = "......";
            }
        };
        pairing.startPairing();
    });

    // Publish or Play?
    let stream = "1";
    document.querySelector('#startPublisherButton').addEventListener('click', (ev) => {
        document.getElementById("select").style.display = "none";
        document.getElementById("player").style.display = "none";
        document.getElementById("publisher").style.display = "block";
        // manager = new ConnectionManager(pairing.getPeerSettings());
        connectInputProxy();

        addStream();
    });
    document.querySelector('#startPlayerButton').addEventListener('click', (ev) => {
        document.getElementById("select").style.display = "none";
        document.getElementById("player").style.display = "block";
        document.getElementById("publisher").style.display = "none";
        playStream(stream);
    });
    document.querySelector('#clearSettingsButton').addEventListener('click', (ev) => pairing.setPeerSettings(null));
    (async () => {
        if ((await navigator.mediaDevices.enumerateDevices()).length == 0) {
            console.log("no devices");
            document.getElementById('startPublisherButton').style.display = "none";
        }
    })();

    // Publisher
    document.querySelector('#connectInputButton')?.addEventListener('click', (ev) => connectInputProxy());

    // Player
    document.querySelector('#playButton').addEventListener('click', (ev) => playStream(stream));
    document.querySelector('#fullscreenButton').addEventListener('click', (ev) => videoEl.requestFullscreen());
    document.querySelector('#streamSelect').addEventListener('change', (ev) => {
        stream = document.querySelector('#streamSelect').value;
        if (player) {
            playStream(stream);
        }
    });

}, { once: true });
