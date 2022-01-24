'use strict';

// Please replace with your id and signalingKey!
const signalingUrl = 'wss://ayame-labo.shiguredo.jp/signaling';
const useSignalingKey = location.host.includes("binzume.");
const signalingKey = useSignalingKey ? 'VV69g7Ngx-vNwNknLhxJPHs9FpRWWNWeUzJ9FUyylkD_yc_F' : null;
const roomIdPrefix = useSignalingKey ? "binzume@rdp-room-" : "binzume-rdp-pin-";
const roomIdPinPrefix = useSignalingKey ? "binzume@rdp-pin-" : "binzume-rdp-pin-";
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
        if (s != this.state) {
            console.log(this.roomId, s);
            this.onstatechange && this.onstatechange(s);
            this.state = s;
        }
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
        this.options.signalingKey = signalingKey;
        // TODO pinTimeoutSec = 3600;
    }

    validatePin(pin) {
        return pin && pin.length >= this.pinLength;
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
        if (!this.validatePin(pin)) {
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
        const conn = Ayame.connection(signalingUrl, this.roomId, this.options, debugLog);
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
            this.updateStaet("connected");
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
        this.updateStaet("ready");
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
        this.mediaStream = null;
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

        conn.on('open', ({ authzMetadata }) => console.log(authzMetadata));
        conn.on('connect', async (e) => {
            this.updateStaet("connected");
        });
        conn.on('addstream', (ev) => {
            this.mediaStream = ev.stream;
            this.videoEl.srcObject = ev.stream;
        });
        conn.on('disconnect', async (e) => {
            console.log(e);
            this.updateStaet("disconnected");
            this.conn = null;
            if (this.videoEl.srcObject == this.mediaStream) {
                this.videoEl.srcObject = null;
            }
        });
        await conn.connect(this.mediaStream, null);
        this.updateStaet("ready");
    }
}


class StreamManager {
    constructor(settings, onupdate) {
        this.settings = settings;
        this.mediaConnections = [];
        this.onupdate = onupdate;
    }

    async addStream() {
        let roomId = this.settings.roomId + "." + (this.mediaConnections.length + 1);
        let mediaStream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true }); // mediaDevices.getUserMedia()
        let conn = new MediaConnection(roomId, mediaStream);
        conn.options.signalingKey = this.settings.signalingKey;
        this.mediaConnections.push(conn);
        conn.connect();
        this.update();
    }
    connectAll() {
        this.mediaConnections.forEach((c) => c.connect());
        this.update();
    }
    disconnectAll() {
        this.mediaConnections.forEach((c) => c.disconnect());
        this.update();
    }
    update() {
        this.onupdate && this.onupdate();
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
        if (settings) {
            pairing.disconnect();
        }
        document.querySelector('#pairng').style.display = settings ? "none" : "block";
        document.querySelector('#publishOrPlay').style.display = settings ? "block" : "none";
    };
    updateButtonState();
    pairing.onsettingsupdate = updateButtonState;

    let addStream = () => {
        let settings = pairing.getPeerSettings();
        if (settings) {
            manager = manager || new StreamManager(settings, () => {
                let el = document.querySelector('#streams');
                el.innerText = "";
                manager.mediaConnections.forEach((c, i) => {
                    // TODO: add disconnect/remove button.
                    el.innerText += "stream" + (i + 1) + ":" + c.mediaStream.id + "\n";
                });

            });
            manager.addStream();
        }
    };

    let playStream = (n) => {
        player?.disconnect();
        let settings = pairing.getPeerSettings();
        let videoEl = document.querySelector('#screen');
        videoEl.style.display = "none";
        document.querySelector('#connectingBox').style.display = "block";
        if (settings) {
            player = new PlayerConnection(settings.roomId + "." + n, videoEl);
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
                document.querySelector("#pin").innerText =  "......";
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
        addStream();
    });
    document.querySelector('#startPlayerButton').addEventListener('click', (ev) => {
        document.querySelector("#select").style.display = "none";
        document.querySelector("#player").style.display = "block";
        document.querySelector("#publisher").style.display = "none";
        playStream(stream);
    });
    document.querySelector('#clearSettingsButton').addEventListener('click', (ev) => {
        pairing.setPeerSettings(null);
    });


    // Publisher
    document.querySelector('#addStreamButton').addEventListener('click', (ev) => {
        addStream();
    });

    // Player
    document.querySelector('#playButton').addEventListener('click', (ev) => {
        playStream(stream);
    });
    document.querySelector('#streamSelect').addEventListener('change', (ev) => {
        stream = document.querySelector('#streamSelect').value;
        console.log(stream);
        if (player) {
            playStream(stream);
        }
    });

}, { once: true });
