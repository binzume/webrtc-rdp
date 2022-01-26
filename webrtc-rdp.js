'use strict';

// Please replace with your id and signalingKey!
const signalingUrl = 'wss://ayame-labo.shiguredo.jp/signaling';
const signalingKey = location.host.includes("binzume.") ? 'VV69g7Ngx-vNwNknLhxJPHs9FpRWWNWeUzJ9FUyylkD_yc_F' : null;
const roomIdPrefix = signalingKey ? "binzume@rdp-room-" : "binzume-rdp-room-";
const roomIdPinPrefix = signalingKey ? "binzume@rdp-pin-" : "binzume-rdp-pin-";
const settingsVersion = 1;

class BaseConnection {
    /**
     * @param {string} signalingUrl 
     * @param {string} roomId 
     */
    constructor(signalingUrl, roomId) {
        this.signalingUrl = signalingUrl;
        this.roomId = roomId;
        this.conn = null;
        this.dataChannels = {};
        this.onstatechange = null;
        this.state = "disconnected";
        this.options = Object.assign({}, Ayame.defaultOptions);
        this.options.video = Object.assign({}, this.options.video);
        this.options.audio = Object.assign({}, this.options.audio);
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
            this.conn = null;
            console.log(e);
            this.disconnect();
        });
        return conn;
    }
    disconnect() {
        this.updateStaet("disconnected");
        this.conn?.on('disconnect', () => { });
        this.conn?.disconnect();
        this.conn = null;
        this.dataChannels = {};
    }
    updateStaet(s) {
        if (s != this.state) {
            console.log(this.roomId, s);
            this.onstatechange && this.onstatechange(s);
            this.state = s;
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
        // TODO pinTimeoutSec = 3600;
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
        this.onsettingsupdate && this.onsettingsupdate();
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

class PublisherConnection extends BaseConnection {
    /**
     * @param {string} signalingUrl 
     * @param {string} roomId 
     * @param {MediaStream} mediaStream 
     * @param {WebSocket} inputSoc 
     */
    constructor(signalingUrl, roomId, mediaStream, inputSoc = null) {
        super(signalingUrl, roomId);
        this.options.video.direction = 'sendonly';
        this.options.audio.direction = 'sendonly';
        this.mediaStream = mediaStream;
        this.inputSoc = inputSoc;
        this.reconnectWaitMs = 3000;
        this.displaySurface = mediaStream.getVideoTracks()[0]?.getSettings().displaySurface || 'monitor';
    }
    async connect() {
        if (this.conn) {
            return;
        }

        this.dataChannels['controlEvent'] = {
            onmessage: (ev) => {
                let msg = JSON.parse(ev.data);
                if (this.displaySurface == 'monitor') {
                    if (this.inputSoc?.readyState == 1 && (msg.type == 'mouse' || msg.type == 'key')) {
                        this.inputSoc.send(ev.data);
                    } else {
                        console.log("TODO:", msg);
                    }
                }
            }
        };

        const conn = this.setupConnection();
        conn.on('disconnect', async (e) => {
            console.log(e, this.state);
            this.conn = null;
            if (this.state == "connected" || this.state == "ready") {
                await new Promise(resolve => setTimeout(resolve, this.reconnectWaitMs));
                this.connect();
            } else {
                this.disconnect();
            }
        });
        await conn.connect(this.mediaStream, null);
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
        if (this.conn) {
            return;
        }

        this.dataChannels['controlEvent'] = {};

        const conn = this.setupConnection();
        conn.on('addstream', (ev) => {
            this.mediaStream = ev.stream;
            this.videoEl.srcObject = ev.stream;
        });
        conn.on('disconnect', async (e) => {
            console.log(e);
            this.conn = null;
            this.disconnect();
            if (this.videoEl.srcObject == this.mediaStream) {
                this.videoEl.srcObject = null;
            }
        });
        await conn.connect(this.mediaStream, null);
    }
    sendMouseEvent(action, x, y, button) {
        this.sendData('controlEvent', JSON.stringify({ type: 'mouse', action: action, x: x, y: y, button: button }));
    }
}

class ConnectionManager {
    constructor(settings, onupdate) {
        this.settings = settings;
        /**
         * @type {{conn:PublisherConnection, name: string, id:number}[]}
         */
        this.mediaConnections = [];
        this.onupdate = onupdate;
    }

    addStream(mediaStream, inputSoc = null) {
        let id = this._genId();
        let name = mediaStream.getVideoTracks()[0]?.label || mediaStream.id;
        let conn = new PublisherConnection(signalingUrl, this.settings.roomId + "." + id, mediaStream, inputSoc);
        this.mediaConnections.push({ conn: conn, id: id, name: name });
        conn.options.signalingKey = this.settings.signalingKey;
        conn.connect();
        this.update();
    }
    removeStream(id) {
        let i = this.mediaConnections.findIndex(c => c.id == id);
        if (i >= 0) {
            this.mediaConnections[index].conn.disconnect();
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
    let pairing = new PairingManager();
    /**
     * @type {ConnectionManager}
     */
    let manager = null;
    /**
     * @type {PlayerConnection}
     */
    let player = null;
    /**
     * @type {WebSocket}
     */
    let inputSoc = null;

    let updateButtonState = () => {
        let settings = pairing.getPeerSettings();
        if (settings) {
            pairing.disconnect();
        }
        document.querySelector('#pairng').style.display = settings ? "none" : "block";
        document.querySelector('#publishOrPlay').style.display = settings ? "block" : "none";
    };
    updateButtonState();
    pairing.onsettingsupdate = updateButtonState;

    let addStream = async (camera = false) => {
        let mediaStream = await (camera ? navigator.mediaDevices.getUserMedia({ audio: true, video: true }) : navigator.mediaDevices.getDisplayMedia({ audio: true, video: true }));
        manager.addStream(mediaStream, inputSoc);
    };
    let connectInputProxy = () => {
        inputSoc?.close();
        /**
         * @type {HTMLInputElement}
         */
        let inputProxyUrlEl = document.querySelector("#inputProxyUrl");
        if (inputProxyUrlEl?.value) {
            inputSoc = new WebSocket(inputProxyUrlEl.value);
            manager.mediaConnections.forEach((c) => c.conn.inputSoc = inputSoc);
        }
    };

    /**
     * @type {HTMLVideoElement}
     */
    let videoEl = document.querySelector('#screen');
    let playStream = (n) => {
        player?.disconnect();
        let settings = pairing.getPeerSettings();
        videoEl.style.display = "none";
        document.querySelector('#connectingBox').style.display = "block";
        if (settings) {
            player = new PlayerConnection(signalingUrl, settings.roomId + "." + n, videoEl);
            player.onstatechange = (state) => {
                if (state == "connected") {
                    videoEl.style.display = "block";
                    document.querySelector('#connectingBox').style.display = "none";
                }
            };
            player.options.signalingKey = settings.signalingKey;
            player.connect();
        }
    };
    let onclick = (ev) => {
        if (player?.state == "connected") {
            let rect = videoEl.getBoundingClientRect();
            let vw = Math.min(rect.width, rect.height * videoEl.videoWidth / videoEl.videoHeight);
            let vh = Math.min(rect.height, rect.width * videoEl.videoHeight / videoEl.videoWidth);
            player.sendMouseEvent('click', (ev.clientX - rect.left - (rect.width - vw) / 2) / vw, (ev.clientY - rect.top - (rect.height - vh) / 2) / vh, ev.button);
            ev.preventDefault();
        }
    };
    videoEl.addEventListener('click', onclick);
    videoEl.addEventListener('auxclick', onclick);

    // Pairing
    document.querySelector('#inputPin').addEventListener('click', (ev) => {
        document.querySelector("#pinDisplayBox").style.display = "none";
        document.querySelector("#pinInputBox").style.display = "block";
    });
    document.querySelector('#sendPinButton').addEventListener('click', (ev) => {
        let pin = document.querySelector("#pinInput").value.trim();
        if (pairing.validatePin(pin)) {
            pairing.sendPin(pin);
            document.querySelector("#pinInputBox").style.display = "none";
        }
    });
    document.querySelector('#generatePin').addEventListener('click', async (ev) => {
        document.querySelector("#pinDisplayBox").style.display = "block";
        document.querySelector("#pinInputBox").style.display = "none";
        pairing.onstatechange = (state) => {
            if (state == "connected" || state == "ready") {
                document.querySelector("#pin").innerText = pairing.pin;
            } else {
                document.querySelector("#pin").innerText = "......";
            }
        };
        pairing.startPairing();
    });

    // Publish or Play?
    let stream = "1";
    document.querySelector('#startPublisherButton').addEventListener('click', (ev) => {
        document.querySelector("#select").style.display = "none";
        document.querySelector("#player").style.display = "none";
        document.querySelector("#publisher").style.display = "block";
        manager = new ConnectionManager(pairing.getPeerSettings(), () => {
            let el = document.querySelector('#streams');
            el.innerText = "";
            manager.mediaConnections.forEach((c, i) => {
                // TODO: add disconnect/remove button.
                el.innerText += "stream" + c.id + ":" + c.name + "\n";
            });
        });
        connectInputProxy();
        addStream();
    });
    document.querySelector('#startPlayerButton').addEventListener('click', (ev) => {
        document.querySelector("#select").style.display = "none";
        document.querySelector("#player").style.display = "block";
        document.querySelector("#publisher").style.display = "none";
        playStream(stream);
    });
    (async () => {
        if ((await navigator.mediaDevices.enumerateDevices()).length == 0) {
            console.log("no devices");
            document.querySelector('#startPublisherButton').style.display = "none";
        }
    })();

    // Publisher
    document.querySelector('#addScreenStreamButton')?.addEventListener('click', (ev) => addStream(false));
    document.querySelector('#addCameraStreamButton')?.addEventListener('click', (ev) => addStream(true));
    document.querySelector('#connectInputButton')?.addEventListener('click', (ev) => connectInputProxy());

    // Player
    document.querySelector('#playButton').addEventListener('click', (ev) => playStream(stream));
    document.querySelector('#streamSelect').addEventListener('change', (ev) => {
        stream = document.querySelector('#streamSelect').value;
        if (player) {
            playStream(stream);
        }
    });

}, { once: true });
