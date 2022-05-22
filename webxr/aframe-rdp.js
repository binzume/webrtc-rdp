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
	 * @param {string|null} signalingKey 
	 * @param {string} roomId 
	 */
	constructor(signalingUrl, signalingKey, roomId) {
		this.signalingUrl = signalingUrl;
		this.roomId = roomId;
		this.conn = null;
		/** @type {MediaStream} */
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
		if (this.connectTimeoutMs > 0) {
			this._connectTimer = setTimeout(() => this.disconnect(), this.connectTimeoutMs);
		}

		let conn = this.conn = Ayame.connection(this.signalingUrl, this.roomId, this.options, false);
		conn.on('open', async (e) => {
			for (let c of Object.keys(this.dataChannels)) {
				this.handleDataChannel(await conn.createDataChannel(c));
			}
			this.updateState('waiting');
		});
		conn.on('connect', (e) => {
			clearTimeout(this._connectTimer);
			this.updateState('connected');
		});
		conn.on('datachannel', (channel) => {
			this.handleDataChannel(channel);
		});
		conn.on('disconnect', (e) => {
			this.conn = null;
			this.disconnect(e.reason);
		});
		return conn;
	}
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
			setTimeout(() => this.connect(), this.reconnectWaitMs);
		}
		for (let c of Object.values(this.dataChannels)) {
			c.ch = null;
		}
		this.updateState('disconnected');
	}
	dispose() {
		this.disconnect('dispose');
		this.updateState('disposed');
		this.stopTracksOnDisposed && this.mediaStream?.getTracks().forEach(t => t.stop());
		this.mediaStream = null;
	}
	/**
	 * @param {'disconnected' | 'connecting' | 'waiting' | 'disposed' | 'connected'} s
	 */
	updateState(s) {
		if (s != this.state && this.state != 'disposed') {
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
			console.log('datachannel', ch.label);
			c.ch = ch;
			ch.onmessage = c.onmessage?.bind(ch, ch);
			// NOTE: dataChannel.onclose = null in Ayame web sdk.
			c.onopen && ch.addEventListener('open', c.onopen.bind(c, ch));
			c.onclose && ch.addEventListener('close', c.onclose.bind(c, ch));
		}
	}
}

class PlayerConnection extends BaseConnection {
	/**
	 * @param {string} signalingUrl 
	 * @param {string} roomId 
	 * @param {HTMLVideoElement} videoEl 
	 */
	constructor(signalingUrl, signalingKey, roomId, videoEl) {
		super(signalingUrl, signalingKey, roomId);
		this.options.video.direction = 'recvonly';
		this.options.audio.direction = 'recvonly';
		this.videoEl = videoEl;
		this._rpcResultHandler = {};
		this.dataChannels['controlEvent'] = {
			onmessage: (ch, ev) => {
				let msg = JSON.parse(ev.data);
				if (msg.type == 'redirect' && msg.roomId) {
					this.disconnect();
					this.roomId = msg.roomId;
					this.connect();
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
	/** @type {PlayerConnection} */
	playerConn: null,
	/** @type {HTMLVideoElement} */
	videoEl: null,
	roomIdSuffix: '.1',
	width: 0,
	height: 0,
	init() {
		// @ts-ignore
		let screenEl = this.screenEl = this._byName("screen");

		let dragging = false;
		let dragTimer = null;
		let mouseMoveTimer = null;
		screenEl.setAttribute('tabindex', 0); // allow focus
		screenEl.focus();

		// EXPERIMENT
		let dragMode = false;
		let draggingStream = null;
		/** @type {THREE.Object3D} */
		let rectObj = null;
		let rectOffset = new THREE.Vector3();
		let prepareDrag = () => dragMode = true;
		let startDrag = async (/** @type {THREE.Raycaster} */ raycaster, intersection) => {
			let x = intersection.uv.x, y = 1 - intersection.uv.y, distance = intersection.distance;
			dragMode = true;
			draggingStream = await this.playerConn?.sendRpcAsync('streamFromPoint', { x: x, y: y });
			if (!draggingStream || !dragMode) {
				return;
			}
			let sw = screenEl.getAttribute('width') || 1, sh = screenEl.getAttribute('height') || 1;
			let rect = draggingStream.rect;
			rectOffset.set((rect.x + rect.width / 2 - x) * sw, -(rect.y + rect.height / 2 - y) * sh, 0);

			if (!rectObj) {
				const material = new THREE.LineBasicMaterial({ color: 0x8888ff, depthTest: false });
				const points = [
					new THREE.Vector3(-0.5, -0.5, 0),
					new THREE.Vector3(-0.5, 0.5, 0),
					new THREE.Vector3(0.5, 0.5, 0),
					new THREE.Vector3(0.5, -0.5, 0),
				];
				rectObj = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(points), material);
				rectObj.scale.set(rect.width * sw, rect.height * sh, 1);
				this.el.setObject3D('draggingrect', rectObj);
			}
			let update = () => {
				let v = raycaster.ray.origin.clone().addScaledVector(raycaster.ray.direction, distance);
				rectObj.position.copy(rectObj.parent.worldToLocal(v).add(rectOffset));
			};
			clearTimeout(dragTimer);
			dragTimer = setInterval(update, 50);
			update();
		};
		let stopDrag = async () => {
			dragMode = false;
			if (!rectObj) { return; }
			clearTimeout(dragTimer);
			let position = rectObj.getWorldPosition(new THREE.Vector3());
			let scale = rectObj.scale.clone();
			this.el.removeObject3D('draggingrect');
			rectObj.geometry.dispose();
			if (rectObj.material instanceof THREE.Material) {
				rectObj.material.dispose();
			}
			rectObj = null;
			let stream = draggingStream;
			if (!screenEl.is('cursor-hovered') && stream != null) {
				let vrapp = this.el.components.vrapp;
				let r = await this.playerConn.sendRpcAsync('play', { streamId: stream.id, redirect: vrapp == null });
				if (r && vrapp) {
					let app = await vrapp.appManager.launch(vrapp.app.id, null, { disableWindowLocator: true });
					app.object3D.quaternion.copy(this.el.object3D.quaternion);
					app.setAttribute('position', app.object3D.parent.worldToLocal(position));
					app.setAttribute('webrtc-rdp', { roomId: r.roomId, settingIndex: this.data.settingIndex, maxWidth: Math.max(scale.x, 1.5), maxHeight: Math.max(scale.y, 1.5) });
					app.addEventListener('loaded', (_) => app.components['webrtc-rdp']?.resize(scale.x, scale.y), { once: true });
				}
			}
		};
		// Grip
		this._ongripdown = (ev) => {
			let raycaster = ev.target.components.raycaster;
			let intersection = raycaster.intersectedEls[0] == screenEl && raycaster.getIntersection(screenEl);
			if (intersection) {
				startDrag(raycaster.raycaster, intersection);
			}
		};
		this._ongripup = (_) => stopDrag();
		this._onbuttondown = (ev) => {
			let raycaster = ev.target.components.raycaster;
			let intersection = raycaster.intersectedEls[0] == screenEl && raycaster.getIntersection(screenEl);
			if (intersection) {
				this.playerConn?.sendMouseEvent("click", intersection.uv.x, 1 - intersection.uv.y, ev.type == 'abuttondown' ? 1 : 2);
				screenEl.focus();
				ev.stopPropagation();
			}
		};
		for (let el of this.el.sceneEl.querySelectorAll('[laser-controls]')) {
			el.addEventListener('gripdown', this._ongripdown);
			el.addEventListener('gripup', this._ongripup);
			el.addEventListener('bbuttondown', this._onbuttondown);
			el.addEventListener('abuttondown', this._onbuttondown);
		}
		// Right ALT
		this._onkeydown = (ev) => ev.code == 'AltRight' && prepareDrag();
		this._onkeyup = (ev) => ev.code == 'AltRight' && stopDrag();
		window.addEventListener('keydown', this._onkeydown);
		window.addEventListener('keyup', this._onkeyup);

		let mousePos = new THREE.Vector2();
		screenEl.addEventListener('mousedown', (ev) => {
			screenEl.focus();
			let intersection = ev.detail.intersection;
			if (dragMode) {
				startDrag(ev.detail.cursorEl.components.raycaster.raycaster, intersection);
				return;
			}
			if (intersection) {
				clearTimeout(dragTimer);
				mousePos.copy(intersection.uv);
				dragTimer = setTimeout(() => {
					dragging = true;
					this.playerConn?.sendMouseEvent("down", mousePos.x, 1 - mousePos.y, 0);
				}, 200);
			}
		});
		this.el.sceneEl.addEventListener('mouseup', (ev) => {
			clearTimeout(dragTimer);
			if (dragging) {
				let intersection = ev.detail.cursorEl?.components.raycaster?.getIntersection(screenEl);
				intersection && mousePos.copy(intersection.uv);
				this.playerConn?.sendMouseEvent("up", mousePos.x, 1 - mousePos.y, 0);
				let cancelClick = ev => ev.stopPropagation();
				window.addEventListener('click', cancelClick, true);
				setTimeout(() => window.removeEventListener('click', cancelClick, true), 0);
				dragging = false;
			}
			stopDrag();
		});
		screenEl.addEventListener('click', (ev) => {
			let intersection = ev.detail.intersection;
			intersection && this.playerConn?.sendMouseEvent("click", intersection.uv.x, 1 - intersection.uv.y, 0);
		});
		screenEl.addEventListener('materialtextureloaded', (ev) => {
			/** @type {THREE.Texture} */
			let map = ev.detail.texture;
			map.anisotropy = Math.min(16, this.el.sceneEl.renderer.capabilities.getMaxAnisotropy());
			map.magFilter = THREE.LinearFilter;
			map.minFilter = THREE.LinearFilter;
			map.needsUpdate = true;
		});
		screenEl.addEventListener('keydown', (ev) => {
			let modkey = ev.key == "Control" || ev.key == "Alt" || ev.key == "Shift";
			let k = ev.key;
			if (!modkey && !ev.shiftKey && k.length == 1 && ev.getModifierState("CapsLock")) {
				k = k.toLowerCase();
			}
			this.playerConn?.sendKeyEvent(modkey ? 'down' : 'press', k, ev.code, ev.shiftKey, ev.ctrlKey, ev.altKey);
			ev.preventDefault();
		});
		screenEl.addEventListener('keyup', (ev) => {
			let modkey = ev.key == "Control" || ev.key == "Alt" || ev.key == "Shift";
			if (modkey) {
				this.playerConn?.sendKeyEvent('up', ev.key, ev.code, ev.shiftKey, ev.ctrlKey, ev.altKey);
			}
			ev.preventDefault();
		});
		screenEl.addEventListener('mouseenter', (ev) => {
			let raycaster = ev.detail.cursorEl.components.raycaster;
			clearTimeout(mouseMoveTimer);
			mouseMoveTimer = setInterval(() => {
				let intersection = raycaster.getIntersection(screenEl);
				if (intersection && mousePos.distanceToSquared(intersection.uv) > 0 && !rectObj) {
					mousePos.copy(intersection.uv);
					this.playerConn?.sendMouseEvent("move", mousePos.x, 1 - mousePos.y, 0);
				}
			}, 100);
		});
		screenEl.addEventListener('mouseleave', (ev) => clearTimeout(mouseMoveTimer));
		screenEl.focus();

		this._byName("connectButton").addEventListener('click', ev => {
			this.el.setAttribute('webrtc-rdp', { roomId: '' }); // default room
			this.connect();
		});
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
			visible = visible || (this.playerConn == null && this.data.roomId == '');
			this.el.querySelectorAll(".control")
				.forEach(el => el.setAttribute("visible", visible));
			if (this.el.components.xywindow) {
				this.el.components.xywindow.controls.setAttribute("visible", visible);
			}
		}
		showControls(false);
		this.el.addEventListener('mouseenter', ev => { ev.target != screenEl && setTimeout(() => showControls(true), 0) });
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

		this._byName('kbdButton').addEventListener('click', ev => {
			this.el.emit('xykeyboard-request', '');
		});
	},
	update(oldData) {
		let d = Settings.getPeerDevices()[this.data.settingIndex];
		if (d) {
			this._byName("roomName").setAttribute('value', this._settingName(d));
		}
		if (oldData.roomId != this.data.roomId && this.data.roomId) {
			this.connect();
		} else if (oldData.settingIndex != this.data.settingIndex) {
			this.disconnect();
		}
	},
	connect() {
		this.disconnect();
		this._updateScreen(this.data.loadingSrc);
		let data = this.data;
		let settings = { signalingKey: null, roomId: data.roomId, userAgent: 'default' };
		if (data.settingIndex >= 0) {
			settings = Settings.getPeerDevices()[data.settingIndex];
			if (!settings) {
				this.el.sceneEl.exitVR();
				window.open(data.settingUrl, '_blank');
				return;
			}
		}
		let roomId = data.roomId || settings.roomId + this.roomIdSuffix;

		if (this.el.components.xywindow) {
			this.el.setAttribute("xywindow", "title", this._settingName(settings));
		}

		// video element
		let videoElId = "webrtc-rdp-" + new Date().getTime().toString(16) + Math.floor(Math.random() * 65536).toString(16);

		let videoEl =/** @type {HTMLVideoElement}} */ (Object.assign(document.createElement("video"), {
			autoplay: true, controls: false, loop: false, id: videoElId, crossOrigin: "", volume: 0.5
		}));
		videoEl.addEventListener('loadeddata', ev => {
			if (videoEl != this.videoEl) { return; }
			this._updateScreen("#" + videoEl.id);
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
		let player = this.playerConn = new PlayerConnection(data.signalingUrl, settings.signalingKey, roomId, videoEl);
		if (globalThis.rtcFileSystemManager) {
			// defined in ../electron/rtcfilesystem-client.js
			player.dataChannels['fileServer'] = globalThis.rtcFileSystemManager.getRtcChannelSpec('RDP-' + settings.roomId, 'RDP-' + data.settingIndex);
		}
		player.onstatechange = (state) => {
			if (state == 'disconnected') {
				this._updateScreen(null);
			}
		};
		this.playerConn.connect();
	},
	disconnect() {
		this.playerConn?.dispose();
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
	_settingName(d, limit = 32) {
		return d.name || d.userAgent.replace(/^Mozilla\/[\d\.]+\s*/, '').replace(/[\s\(\)]+/g, ' ').substring(0, limit) + '...';
	},
	_updateScreen(src) {
		this.screenEl.removeAttribute("material"); // to avoid texture leaks.
		this.screenEl.setAttribute('material', { shader: "flat", src: src });
	},
	_byName(name) {
		return /** @type {import("aframe").Entity} */ (this.el.querySelector("[name=" + name + "]"));
	},
	remove: function () {
		for (let el of this.el.sceneEl.querySelectorAll('[laser-controls]')) {
			el.removeEventListener('gripdown', this._ongripdown);
			el.removeEventListener('gripup', this._ongripup);
			el.removeEventListener('bbuttondown', this._onbuttondown);
			el.removeEventListener('abuttondown', this._onbuttondown);
		}
		window.removeEventListener('keydown', this._onkeydown);
		window.removeEventListener('keyup', this._onkeyup);
		this.disconnect();
		// @ts-ignore
		this.screenEl.removeAttribute("material"); // to avoid texture leaks.
		if (this.videoEl) this.videoEl.parentNode.removeChild(this.videoEl);
	},
});
