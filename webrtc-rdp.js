'use strict';

const signalingUrl = 'wss://ayame-labo.shiguredo.jp/signaling';
const signalingKey = null;
const roomIdPrefix = "binzume-rdp-room-";
const roomIdPinPrefix = "binzume-rdp-pin-";
const debugLog = true;
const settingsVersion = 1;


class BaseConnection {
    constructor(roomId) {
        this.roomId = roomId;
        this.conn = null;
        this.dataChannel = null;
        this.onstatechange = null;
        this.state = "disconnected";
        this.options = Object.assign({}, Ayame.defaultOptions);
        this.options.video = Object.assign({}, this.options.video);
        this.options.audio = Object.assign({}, this.options.audio);
    }
    async connect() {
    }
    disconnect() {
        this.updateStaet("disconnected");
        this.conn && this.conn.disconnect();
        this.conn = null;
        this.dataChannel = null;
    }
    updateStaet(s) {
        console.log(this.roomId, s);
        this.onstatechange && this.onstatechange(s);
        this.state = s;
    }
}

class PairingManager extends BaseConnection {
    constructor(pin = null) {
        super(null);
        this.pinLength = 6;
        this.pin = pin || this._generatePin();
        this.onsettingsupdate = null;
        this.userAgent = navigator.userAgent;
        this.settingsKey = 'webrtc-rdp-settings';
    }

    async startPairing() {
        console.log("PIN:" + this.pin);

        await this.connect((ev) => {
            console.log('ch open', ev);
            this.dataChannel.send(JSON.stringify({ type: "hello", userAgent: this.userAgent }));
        }, (ev) => {
            console.log('ch msg', ev.data);
            let msg = JSON.parse(ev.data);
            if (msg.type == 'credential') {
                this.setPeerSettings({ roomId: msg.roomId, signalingKey: msg.signalingKey, token: msg.token, userAgent: msg.userAgent });
            }
        });
    }

    async sendPin(pin) {
        if (!pin || pin.length < this.pinLength) {
            throw "invalid pin";
        }
        this.pin = pin;

        await this.connect((ev) => {
            console.log('ch open', ev);
        }, (ev) => {
            console.log('ch msg', ev.data);
            let msg = JSON.parse(ev.data);
            if (msg.type == 'hello') {
                let roomId = roomIdPrefix + this._generateSecret(16);
                let token = this._generateSecret(16);
                this.dataChannel.send(JSON.stringify({ type: "credential", roomId: roomId, signalingKey: signalingKey, token: token, userAgent: this.userAgent }));
                this.setPeerSettings({ roomId: roomId, signalingKey: signalingKey, token: token, userAgent: msg.userAgent });
            }
        });
    }

    async connect(onopen, onmessage) {
        this.disconnect();
        this.roomId = roomIdPinPrefix + this.pin;
        const conn = Ayame.connection(signalingUrl, this.roomId, Ayame.defaultOptions, debugLog);
        this.conn = conn;
        let initDataChannel = (ch) => {
            if (ch && this.dataChannel == null) {
                this.dataChannel = ch;
                this.dataChannel.onmessage = onmessage;
                this.dataChannel.onopen = onopen;
            }
        }
        conn.on('open', async (e) => {
            console.log('open', e);
            initDataChannel(await conn.createDataChannel('secretExchange'));
        });
        conn.on('connect', (e) => {
            console.log('connect', e);
        });
        conn.on('datachannel', (channel) => {
            console.log('datachannel', channel);
            initDataChannel(channel);
        });
        conn.on('disconnect', (e) => {
            console.log('disconnect', e);
            this.dataChannel = null;
            this.conn = null;
        });
        await conn.connect(null);
        console.log("connected");
        return conn;
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
        return (Math.floor(Math.random() * 1000000) + "000000").substring(0, 6);
    }

    _generateSecret(n) {
        const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
        return Array.from(crypto.getRandomValues(new Uint8Array(n))).map((c) => chars[c % chars.length]).join('');
    }
}

class MediaConnection extends BaseConnection {
    constructor(roomId, mediaStream) {
        super(roomId);
        this.options.video.direction = 'sendonly';
        this.options.audio.direction = 'sendonly';
        this.mediaStream = mediaStream;
    }
    async connect() {
        if (this.conn) {
            return;
        }
        let roomId = this.roomId;
        let options = this.options;
        console.log("connecting..." + signalingUrl + " " + roomId, options);
        this.updateStaet("connecting");

        let conn = this.conn = Ayame.connection(signalingUrl, roomId, options, debugLog);

        conn.on('connect', async (e) => {
            this.updateStaet("connected");
        });

        conn.on('disconnect', async (e) => {
            console.log(e, this.state);
            this.conn = null;
            if (this.state == "connected" || this.state == "ready") {
                await new Promise(resolve => setTimeout(resolve, 3000));
                this.connect();
            } else {
                this.disconnect();
            }
        });
        await conn.connect(this.mediaStream, null);
        this.updateStaet("ready");
    }
}

class PlayerConnection extends BaseConnection {
    constructor(roomId, videoEl) {
        super(roomId);
        this.options.video.direction = 'recvonly';
        this.options.audio.direction = 'recvonly';
        this.videoEl = videoEl;
    }

    async connect() {
        if (this.conn) {
            return;
        }
        let roomId = this.roomId;
        let options = this.options;
        console.log("connecting..." + signalingUrl + " " + roomId, options);
        this.updateStaet("connecting");

        let conn = this.conn = Ayame.connection(signalingUrl, roomId, options, debugLog);

        this.videoEl.style.display = "block";

        conn.on('open', ({ authzMetadata }) => console.log(authzMetadata));
        conn.on('connect', async (e) => {
            this.updateStaet("connected");
        });
        conn.on('addstream', (ev) => {
            this.videoEl.srcObject = ev.stream;
        });
        conn.on('disconnect', async (e) => {
            console.log(e);
            this.updateStaet("disconnected");
            this.conn = null;
            this.videoEl.srcObject = null;
        });
        await conn.connect(this.mediaStream, null);
        this.updateStaet("ready");
    }
}


class StreamManager {
    constructor(settings) {
        this.settings = settings;
        this.mediaConnections = [];
    }

    async addStream() {
        let roomId = this.settings.roomId + "." + (this.mediaConnections.length + 1);
        let mediaStream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true }); // mediaDevices.getUserMedia()
        let conn = new MediaConnection(roomId, mediaStream);
        conn.options.signalingKey = this.settings.signalingKey;
        this.mediaConnections.push(conn);
        conn.connect();
    }
    connectAll() {
        this.mediaConnections.forEach((c) => c.connect());
    }
    disconnectAll() {
        this.mediaConnections.forEach((c) => c.disconnect());
    }
    dispose() {
        this.disconnectAll();
        this.mediaConnections = [];
    }
}


window.addEventListener('DOMContentLoaded', (ev) => {
    let pairing = new PairingManager();
    let manager = null;
    let player = null;

    let updateButtonState = () => {
        let settings = pairing.getPeerSettings();
        document.querySelector('#paring').style.display = settings ? "none" : "block";
        document.querySelector('#rdp').style.display = settings ? "block" : "none";
    };
    updateButtonState();
    pairing.onsettingsupdate = updateButtonState;

    document.querySelector('#inputPin').addEventListener('click', (ev) => {
        let pin = prompt("Input PIN");
        pairing.sendPin(pin);
    });
    document.querySelector('#generatePin').addEventListener('click', (ev) => {
        pairing.startPairing();
        document.querySelector("#pinDisplay").style.display = "block";
        document.querySelector("#pin").innerText = pairing.pin;
    });
    document.querySelector('#clearButton').addEventListener('click', (ev) => {
        pairing.setPeerSettings(null);
    });

    document.querySelector('#publishButton').addEventListener('click', (ev) => {
        let settings = pairing.getPeerSettings();
        if (settings) {
            manager = manager || new StreamManager(settings);
            manager.addStream();
        }
    });

    document.querySelector('#openButton').addEventListener('click', (ev) => {
        player?.disconnect();
        let settings = pairing.getPeerSettings();
        if (settings) {
            let videoEl = document.querySelector('#screen');
            player = new PlayerConnection(settings.roomId + ".1", videoEl);
            player.options.signalingKey = settings.signalingKey;
            player.connect();
        }

    });

}, { once: true });
