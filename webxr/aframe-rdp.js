// @ts-check
'use strict';


AFRAME.registerComponent('webrtc-rdp', {
	schema: {
		signalingUrl: { default: "wss://ayame-labo.shiguredo.jp/signaling" },
		roomIdPrefix: { default: "binzume-rdp-room-" },
		loadingSrc: { default: "#rdp-loading" },
		mediaController: { default: "media-controller" },
		maxWidth: { default: 16 },
		maxHeight: { default: 16 },
	},
	init() {
		// @ts-ignore
		this.screenEl = this._byName("screen");
		this.videoEl = null;
		this.width = 0;
		this.height = 0;
		this.roomIdSuffix = "1";
		this.conn = null;

		// @ts-ignore
		this.screenEl.addEventListener('click', (ev) => console.log("click", ev));

		this._byName("connectButton").addEventListener('click', ev => this.connect());
		this._byName("roomSelect").addEventListener('change', ev => { this.roomIdSuffix = ev.detail.value; console.log("room:", ev.detail); });

		let showControls = visible => {
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
		let signalingUrl = this.data.signalingUrl;
		let roomId = this.data.roomIdPrefix + localStorage.getItem('binzume-webrtc-secret') + "." + this.roomIdSuffix;
		let clientId = null;
		let signalingKey = null;
		let Ayame = globalThis.Ayame;

		console.log("connecting... " + signalingUrl + " " + roomId);
		if (this.el.components.xywindow && roomId) {
			this.el.setAttribute("xywindow", "title", "RDP: " + roomId);
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
		const options = Ayame.defaultOptions;
		options.clientId = clientId ? clientId : options.clientId;
		if (signalingKey) {
			options.signalingKey = signalingKey;
		}
		options.video.direction = 'recvonly';
		options.audio.direction = 'recvonly';
		let conn = Ayame.connection(signalingUrl, roomId, options, true);
		this.conn = conn;

		const start = async () => {
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

		start();
	},
	disconnect() {
		this.conn && this.conn.disconnect();
		this.conn = null;
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
