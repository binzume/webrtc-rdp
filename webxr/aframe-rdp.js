// @ts-check
'use strict';

class Settings {
	static settingsKey = 'webrtc-rdp-settings';
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
		} catch {
			// ignore
		}
		return [];
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
			// compat
			devices[0].version = 1;
			localStorage.setItem(this.settingsKey, JSON.stringify(devices[0]));
		} else {
			localStorage.setItem(this.settingsKey, JSON.stringify({ devices: devices, version: 2 }));
		}
		this.onsettingsupdate && this.onsettingsupdate(devices);
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
		this.stopTracksOnDisposed = true;
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
		this.stopTracksOnDisposed && this.mediaStream?.getTracks().forEach(t => t.stop());
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
			// NOTE: dataChannel.onclose = null in Ayame web sdk.
			ch.addEventListener('open', c.onopen?.bind(ch, ch));
			ch.addEventListener('close', c.onclose?.bind(ch, ch));
		}
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

AFRAME.registerComponent('webrtc-rdp', {
	schema: {
		signalingUrl: { default: "wss://ayame-labo.shiguredo.app/signaling" },
		settingIndex: { default: -1 },
		roomId: { default: "" },
		settingUrl: { default: "/webrtc-rdp/" },
		loadingSrc: { default: "#rdp-loading" },
		maxWidth: { default: 8 },
		maxHeight: { default: 6 },
	},
	init() {
		// @ts-ignore
		let screenEl = this.screenEl = this._byName("screen");
		this.videoEl = null;
		this.width = 0;
		this.height = 0;
		this.roomIdSuffix = "1";
		this.playerConn = null;

		let dragging = false;
		let dragTimer = null;
		screenEl.setAttribute('tabindex', 0);
		screenEl.addEventListener('mousedown', (ev) => {
			dragTimer = setTimeout(() => {
				dragging = true;
				ev.detail.intersection && this.playerConn?.sendMouseEvent("mousedown", ev.detail.intersection.uv.x, 1 - ev.detail.intersection.uv.y, 0);
				let raycaster = ev.detail.cursorEl.components.raycaster;
				if (raycaster && screenEl.is('cursor-hovered')) {
					dragTimer = setInterval(() => {
						let intersection = raycaster.intersections.find(i => i.object.el === screenEl);
						intersection && this.playerConn?.sendMouseEvent("mousemove", intersection.uv.x, 1 - intersection.uv.y, 0);
					}, 100);
				}
			}, 200);
		});
		screenEl.addEventListener('mouseup', (ev) => {
			clearTimeout(dragTimer);
			if (dragging) {
				ev.detail.intersection && this.playerConn?.sendMouseEvent("mouseup", ev.detail.intersection.uv.x, 1 - ev.detail.intersection.uv.y, 0);
				let cancelClick = ev => ev.stopPropagation();
				window.addEventListener('click', cancelClick, true);
				setTimeout(() => window.removeEventListener('click', cancelClick, true), 0);
			}
			dragging = false;
		});
		screenEl.addEventListener('click', (ev) => {
			ev.detail.intersection && this.playerConn?.sendMouseEvent("click", ev.detail.intersection.uv.x, 1 - ev.detail.intersection.uv.y, 0);
			screenEl.focus();
		});
		screenEl.addEventListener('materialtextureloaded', (ev) => {
			/**
			 * @type {THREE.Texture}
			 */
			let map = ev.detail.texture;
			map.anisotropy = Math.min(16, this.el.sceneEl.renderer.capabilities.getMaxAnisotropy());
			map.magFilter = THREE.LinearFilter;
			map.minFilter = THREE.LinearFilter;
			map.needsUpdate = true;
		});
		screenEl.addEventListener('keydown', (ev) => {
			if (this.playerConn?.state == "connected") {
				let modkey = ev.key == "Control" || ev.key == "Alt" || ev.key == "Shift";
				let k = ev.key;
				if (!modkey && !ev.shiftKey && k.length == 1 && ev.getModifierState("CapsLock")) {
					k = k.toLowerCase();
				}
				this.playerConn.sendKeyEvent(modkey ? 'down' : 'press', k, ev.code, ev.shiftKey, ev.ctrlKey, ev.altKey);
				ev.preventDefault();
			}
		});
		screenEl.addEventListener('keyup', (ev) => {
			if (this.playerConn?.state == "connected") {
				let modkey = ev.key == "Control" || ev.key == "Alt" || ev.key == "Shift";
				if (modkey) {
					this.playerConn.sendKeyEvent('up', ev.key, ev.code, ev.shiftKey, ev.ctrlKey, ev.altKey);
				}
				ev.preventDefault();
			}
		});
		screenEl.focus();

		this._byName("connectButton").addEventListener('click', ev => this.connect());
		this._byName("roomNext").addEventListener('click', ev => {
			let n = this.data.settingIndex + 1;
			if (Settings.getPeerDevices()[n]) {
				this.el.setAttribute('webrtc-rdp', { settingIndex: n });
			}
		});
		this._byName("roomPrev").addEventListener('click', ev => {
			let n = this.data.settingIndex - 1;
			if (Settings.getPeerDevices()[n]) {
				this.el.setAttribute('webrtc-rdp', { settingIndex: n });
			}
		});

		let showControls = visible => {
			visible = visible || this.playerConn == null;
			this.el.querySelectorAll(".control")
				.forEach(el => el.setAttribute("visible", visible));
			if (this.el.components.xywindow) {
				this.el.components.xywindow.controls.setAttribute("visible", visible);
			}
		}
		showControls(false);
		this.el.addEventListener('mouseenter', ev => { showControls(true); setTimeout(() => showControls(true), 0) });
		this.el.addEventListener('mouseleave', ev => showControls(false));
		this.el.addEventListener('xyresize', ev => {
			let r = ev.detail.xyrect;
			if (r.width != this.width || r.height != this.height) {
				if (this.videoEl) {
					this.el.setAttribute('webrtc-rdp', { maxWidth: r.width, maxHeight: r.height });
					this.resize(this.videoEl.naturalWidth || this.videoEl.videoWidth, this.videoEl.naturalHeight || this.videoEl.videoHeight);
				}
			}
		});
	},
	update() {
		let d = Settings.getPeerDevices()[this.data.settingIndex];
		if (d) {
            let name = d.name || d.userAgent.replace(/^Mozilla\/[\d\.]+\s*/, '').replace(/[\s\(\)]+/g, ' ').substring(0, 50) + '...';
			this._byName("roomName").setAttribute('value', name);
		}
	},
	connect() {
		this.disconnect();
		this._updateScreen(this.data.loadingSrc, false);
		let data = this.data;
		let settings = { signalingKey: null, roomId: data.roomId };
		if (data.settingIndex >= 0) {
			settings = Settings.getPeerDevices()[data.settingIndex];
			if (!settings) {
				this.el.sceneEl.exitVR();
				window.open(data.settingUrl, '_blank');
				return;
			}
		}
		let roomId = settings.roomId + "." + this.roomIdSuffix;

		if (this.el.components.xywindow) {
			this.el.setAttribute("xywindow", "title", "RDP: " + this.roomIdSuffix);
		}

		// video element
		let videoElId = "webrtc-rdp-" + new Date().getTime().toString(16) + Math.floor(Math.random() * 65536).toString(16);

		let videoEl =/** @type {HTMLVideoElement}} */ (Object.assign(document.createElement("video"), {
			autoplay: true, controls: false, loop: false, id: videoElId, crossOrigin: "", volume: 0.5
		}));
		videoEl.addEventListener('loadeddata', ev => {
			if (videoEl != this.videoEl) { return; }
			this._updateScreen("#" + videoEl.id, false);
			this.resize(videoEl.videoWidth, videoEl.videoHeight);
			this.el.dispatchEvent(new CustomEvent('webrtc-rdp-connected', { detail: { roomId: roomId, event: ev } }));
		});
		videoEl.addEventListener('ended', ev => {
			this.el.dispatchEvent(new CustomEvent('webrtc-rdp-ended', { detail: { roomId: roomId, event: ev } }));
		});

		// replace
		var parent = (this.videoEl || document.querySelector(data.loadingSrc)).parentNode;
		if (this.videoEl) this.videoEl.parentNode.removeChild(this.videoEl);
		parent.appendChild(videoEl);
		this.videoEl = videoEl;

		// connect
		this.playerConn = new PlayerConnection(data.signalingUrl, roomId, videoEl);
		this.playerConn.options.signalingKey = settings.signalingKey;
		this.playerConn.connect();
	},
	disconnect() {
		this.playerConn?.disconnect();
		this.playerConn = null;
	},
	resize(width, height) {
		console.log("media size: " + width + "x" + height);
		let w = this.data.maxWidth;
		let h = height / width * w;
		if (h > this.data.maxHeight) {
			h = this.data.maxHeight;
			w = width / height * h;
		}
		if (isNaN(h)) {
			h = 3;
			w = 10;
		}

		this.width = w;
		this.height = h;
		this.screenEl.setAttribute("width", w);
		this.screenEl.setAttribute("height", h);
		setTimeout(() => {
			this.el.setAttribute("xyrect", { width: w, height: h });
		}, 0);
	},
	_updateScreen(src, transparent) {
		this.screenEl.removeAttribute("material"); // to avoid texture leaks.
		this.screenEl.setAttribute('material', { shader: "flat", src: src, transparent: transparent });
	},
	_byName(name) {
		return /** @type {import("aframe").Entity} */ (this.el.querySelector("[name=" + name + "]"));
	},
	remove: function () {
		this.disconnect();
		// @ts-ignore
		this.screenEl.removeAttribute("material"); // to avoid texture leaks.
		if (this.videoEl) this.videoEl.parentNode.removeChild(this.videoEl);
	},
});
