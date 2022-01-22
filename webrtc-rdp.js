'use strict';

const signalingUrl = 'wss://ayame-labo.shiguredo.jp/signaling';
const roomIdPrefix = "binzume-rdp-room-";
const roomIdPinPrefix = "binzume-rdp-pin-";
const debugLog = true;

class PairingManager {
    constructor() {
        this.conn = null;
        this.dataChannel = null;
        this.pin = this._generatePin();
        this.pinLength = 6;
        this.onupdate = null;
    }

    async startPairing() {
        console.log("PIN:" + this.pin);

        await this.connect((ev) => {
            console.log('ch open', ev);
        }, (ev) => {
            console.log('ch msg', ev.data);
            let msg = JSON.parse(ev.data);
            if (msg.type == 'credential') {
                this.setSharedSecret(msg.roomIdSecret);
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
            let roomIdSecret = this._generateSecret(16);
            let token = this._generateSecret(16);
            this.dataChannel.send(JSON.stringify({ type: "credential", roomIdSecret: roomIdSecret, token: token }));
            this.setSharedSecret(roomIdSecret);
        }, (ev) => {
            console.log('ch msg', ev);
        });
    }

    async connect(onopen, onmessage) {
        this.disconnect();
        const conn = Ayame.connection(signalingUrl, roomIdPinPrefix + this.pin, Ayame.defaultOptions, debugLog);
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

    setSharedSecret(secret) {
        if (!secret) {
            localStorage.removeItem('binzume-webrtc-secret');
        } else {
            localStorage.setItem('binzume-webrtc-secret', secret);
        }
        this.onupdate && this.onupdate();
    }

    getSharedSecret() {
        return localStorage.getItem('binzume-webrtc-secret');
    }

    disconnect() {
        this.conn && this.conn.disconnect();
        this.conn = null;
        this.dataChannel = null;
    }

    _generatePin() {
        return (Math.floor(Math.random() * 1000000) + "000000").substring(0, 6);
    }

    _generateSecret(n) {
        const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
        return Array.from(crypto.getRandomValues(new Uint8Array(n))).map((c) => chars[c % chars.length]).join('');
    }
}

class MediaConnection {
    constructor(roomId, mediaStream) {
        this.roomId = roomId;
        this.mediaStream = mediaStream;
        this.conn = null;
        this.dataChannel = null;
        this.state = "disconnected";
        this.options = Object.assign({}, Ayame.defaultOptions);
        this.options.video = Object.assign({}, this.options.video);
        this.options.audio = Object.assign({}, this.options.audio);
        this.options.video.direction = 'sendonly';
        this.options.audio.direction = 'sendonly';
        this.onstatechange = null;
    }
    async connect() {
        let roomId = this.roomId;
        let options = this.options;
        console.log("connecting..." + signalingUrl + " " + roomId, options);
        this.updateStaet("connecting");

        let conn = this.conn = Ayame.connection(signalingUrl, roomId, options, debugLog);

        conn.on('connect', async (e) => {
            this.updateStaet("connected");
        });

        conn.on('disconnect', async (e) => {
            console.log(e);
            if (this.state == "connected" || this.state == "ready") {
                await new Promise(resolve => setTimeout(resolve, 3000));
                this.connect();
            } else {
                this.updateStaet("disconnected");
                this.conn = null;
            }
        });
        await conn.connect(this.mediaStream, null);
        this.updateStaet("ready");
        console.log(roomId);
    }
    disconnect() {
        this.updateStaet("disconnected");
        this.conn && this.conn.disconnect();
        this.conn = null;
    }
    updateStaet(s) {
        console.log(this.roomId, s);
        this.onstatechange && this.onstatechange(s);
        this.state = s;
    }
}


class PlayerConnection {
    constructor(roomId, videoEl) {
        this.roomId = roomId;
        this.videoEl = videoEl;
        this.conn = null;
        this.dataChannel = null;
        this.state = "disconnected";
        this.options = Object.assign({}, Ayame.defaultOptions);
        this.options.video = Object.assign({}, this.options.video);
        this.options.audio = Object.assign({}, this.options.audio);
        this.options.video.direction = 'recvonly';
        this.options.audio.direction = 'recvonly';
        this.onstatechange = null;
    }

    async connect() {
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
        console.log(roomId);
    }

    disconnect() {
        this.updateStaet("disconnected");
        this.conn && this.conn.disconnect();
        this.conn = null;
    }
    updateStaet(s) {
        console.log(this.roomId, s);
        this.onstatechange && this.onstatechange(s);
        this.state = s;
    }
}


class StreamManager {
    constructor(secret) {
        this.secret = secret;
        this.mediaConnections = [];
    }

    async addStream() {
        let roomId = roomIdPrefix + this.secret + "." + (this.mediaConnections.length + 1);
        let mediaStream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true }); // mediaDevices.getUserMedia()
        let conn = new MediaConnection(roomId, mediaStream);
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


function play(roomId) {
    let options = Object.assign({}, Ayame.defaultOptions);
    options.video = Object.assign({}, options.video);
    options.audio = Object.assign({}, options.audio);

    options.video.direction = 'recvonly';
    options.audio.direction = 'recvonly';
    videoEl.style.display = "block";
    let conn;
    const startConn = async () => {
        // options.video.codec = videoCodec;
        conn = Ayame.connection(signalingUrl, roomId, options, debugLog);
        await conn.connect(null);
        conn.on('open', ({ authzMetadata }) => console.log(authzMetadata));
        conn.on('disconnect', (e) => {
            console.log(e);
            videoEl.srcObject = null;
        });
        conn.on('addstream', (e) => {
            videoEl.srcObject = e.stream;
        });
    };
    startConn();
    console.log(roomId);
}

window.addEventListener('DOMContentLoaded', (ev) => {
    let pairing = new PairingManager();
    let manager = null;
    let player = null;

    let updateButtonState = () => {
        let secret = pairing.getSharedSecret();
        document.querySelector('#paring').style.display = secret ? "none" : "block";
        document.querySelector('#rdp').style.display = secret ? "block" : "none";
    };
    updateButtonState();
    pairing.onupdate = updateButtonState;

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
        pairing.setSharedSecret(null);
    });

    document.querySelector('#publishButton').addEventListener('click', (ev) => {
        manager = manager || new StreamManager(pairing.getSharedSecret());
        manager.addStream();
    });

    document.querySelector('#openButton').addEventListener('click', (ev) => {
        player?.disconnect();
        let roomId = roomIdPrefix + pairing.getSharedSecret() + "." + 1;
        let videoEl = document.querySelector('#screen');
        player = new PlayerConnection(roomId, videoEl);
        player.connect();
    });

}, { once: true });
