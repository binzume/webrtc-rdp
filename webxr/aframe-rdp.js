// @ts-check
'use strict';

const debugLog = true;

class BaseConnection {
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

		let conn = this.conn = Ayame.connection(this.signalingUrl, this.roomId, this.options, debugLog);
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

class PlayerConnection extends BaseConnection {
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


AFRAME.registerComponent('webrtc-rdp', {
	schema: {
		signalingUrl: { default: "wss://ayame-labo.shiguredo.jp/signaling" },
		settingName: { default: "" },
		roomId: { default: "" },
		loadingSrc: { default: "#rdp-loading" },
		maxWidth: { default: 12 },
		maxHeight: { default: 8 },
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
		});
		screenEl.addEventListener('materialtextureloaded', (ev) => {
			let map = ev.detail.texture;
			map.anisotropy = Math.min(16, this.el.sceneEl.renderer.capabilities.getMaxAnisotropy());
			map.needsUpdate = true;
		});

		this._byName("connectButton").addEventListener('click', ev => this.connect());
		this._byName("roomSelect").addEventListener('change', ev => { this.roomIdSuffix = ev.detail.value; console.log("room:", ev.detail); });

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
	connect() {
		this.disconnect();
		let settings = { signalingKey: null, roomId: this.data.roomId };
		if (this.data.settingName) {
			let s = localStorage.getItem(this.data.settingName);
			settings = null;
			if (s) {
				try { settings = JSON.parse(s); } catch { }
			}
			if (!settings || settings.version != 1) {
				this.el.sceneEl.exitVR();
				window.open("https://binzume.github.io/webrtc-rdp/", '_blank');
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
		var parent = (this.videoEl || document.querySelector(this.data.loadingSrc)).parentNode;
		if (this.videoEl) this.videoEl.parentNode.removeChild(this.videoEl);
		parent.appendChild(videoEl);
		this.videoEl = videoEl;

		// connect
		this.playerConn = new PlayerConnection(this.data.signalingUrl, roomId, videoEl);
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
		clearTimeout(this.loadingTimer);
		this.loadingTimer = null;
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
