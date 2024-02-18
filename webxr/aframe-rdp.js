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
	static findPeerDevice(roomId) {
		return this.getPeerDevices().find(d => d.roomId == roomId);
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
	 * @param {string|undefined} signalingKey 
	 * @param {string} roomId 
	 */
	constructor(signalingUrl, signalingKey, roomId) {
		this.signalingUrl = signalingUrl;
		this.roomId = roomId;
		this.conn = null;
		/** @type {MediaStream|null} */
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
		clearTimeout(this._connectTimer);
		if (this.connectTimeoutMs > 0) {
			this._connectTimer = setTimeout(() => this.disconnect(), this.connectTimeoutMs);
		}

		let conn = this.conn = Ayame.connection(this.signalingUrl, this.roomId, this.options, false);
		conn.on('open', async (e) => {
			for (let c of Object.keys(this.dataChannels)) {
				this._handleDataChannel(await conn.createDataChannel(c));
			}
			this.updateState('waiting');
		});
		conn.on('connect', (e) => {
			clearTimeout(this._connectTimer);
			this.updateState('connected');
		});
		conn.on('datachannel', (channel) => {
			this._handleDataChannel(channel);
		});
		conn.on('disconnect', (e) => {
			this.conn = null;
			this.disconnect(e.reason);
		});
		return conn;
	}
	/**
	 * @param {string|null} reason 
	 */
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
			this._connectTimer = setTimeout(() => this.connect(), this.reconnectWaitMs);
		}
		for (let c of Object.values(this.dataChannels)) {
			c.ch = null;
		}
		this.updateState('disconnected', reason);
	}
	dispose() {
		this.disconnect('dispose');
		this.updateState('disposed');
		this.stopTracksOnDisposed && this.mediaStream?.getTracks().forEach(t => t.stop());
		this.mediaStream = null;
	}
	/**
	 * @param {'disconnected' | 'connecting' | 'waiting' | 'disposed' | 'connected'} s
	 * @param {string|null} reason 
	 */
	updateState(s, reason = null) {
		if (s != this.state && this.state != 'disposed') {
			console.log(this.roomId, s);
			let oldState = this.state;
			this.state = s;
			this.onstatechange && this.onstatechange(s, oldState, reason);
		}
	}
	/**
	 * @param {RTCDataChannel|null} ch
	 */
	_handleDataChannel(ch) {
		if (!ch) return;
		let c = this.dataChannels[ch.label];
		if (c && !c.ch) {
			console.log('datachannel', ch.label);
			c.ch = ch;
			ch.onmessage = (ev) => c.onmessage?.(ch, ev);
			// NOTE: dataChannel.onclose = null in Ayame web sdk.
			ch.addEventListener('open', (ev) => c.onopen?.(ch, ev));
			ch.addEventListener('close', (ev) => c.onclose?.(ch, ev));
		}
	}
	getFingerprint(remote = false) {
		let pc = this.conn._pc;
		let m = pc && (remote ? pc.currentRemoteDescription : pc.currentLocalDescription).sdp.match(/a=fingerprint:\s*([\w-]+ [a-f0-9:]+)/i);
		return m && m[1];
	}
	async hmacSha256(password, fingerprint) {
		let enc = new TextEncoder();
		let key = await crypto.subtle.importKey('raw', enc.encode(password),
			{ name: 'HMAC', hash: { name: 'SHA-256' } }, false, ['sign']);
		let sign = await crypto.subtle.sign('HMAC', key, enc.encode(fingerprint));
		return btoa(String.fromCharCode(...new Uint8Array(sign)));
	}
}

class PlayerConnection extends BaseConnection {
	/**
	 * @param {string} signalingUrl 
	 * @param {string} roomId 
	 * @param {HTMLVideoElement|null} videoEl
	 */
	constructor(signalingUrl, signalingKey, roomId, videoEl) {
		super(signalingUrl, signalingKey, roomId);
		if (videoEl) {
			this.options.video.direction = 'recvonly';
			this.options.audio.direction = 'recvonly';
		}
		this.videoEl = videoEl;
		this._rpcResultHandler = {};
		this.authToken = null;
		this.services = null;
		this.onauth = null;
		this.onstreaminfo = null;
		this.dataChannels['controlEvent'] = {
			onopen: async (ch, ev) => {
				if (window.crypto?.subtle) {
					let localFingerprint = this.getFingerprint(false);
					if (!localFingerprint) {
						console.log("Failed to get DTLS cert fingerprint");
						return;
					}
					console.log("local fingerprint:", localFingerprint);
					let hmac = this.authToken && await this.hmacSha256(this.authToken, localFingerprint);
					ch.send(JSON.stringify({
						type: "auth",
						requestServices: videoEl ? ['screen', 'file'] : ['file'],
						fingerprint: localFingerprint,
						hmac: hmac
					}));
				} else {
					ch.send(JSON.stringify({ type: "auth", token: this.authToken }));
				}
			},
			onmessage: (ch, ev) => {
				let msg = JSON.parse(ev.data);
				if (msg.type == 'redirect' && msg.roomId) {
					this.disconnect('redirect');
					this.roomId = msg.roomId;
					this.connect();
				} else if (msg.type == 'auth') {
					// player and player error
					this.disconnect();
				} else if (msg.type == 'authResult') {
					this.services = msg.services;
					this.onauth?.(msg.result);
				} else if (msg.type == 'streamInfo') {
					this.onstreaminfo?.(msg);
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
			if (this.videoEl) {
				this.videoEl.srcObject = ev.stream;
			}
		});
		return conn;
	}
	/**
	 * @param {string|null} reason 
	 */
	disconnect(reason = null) {
		if (this.videoEl && this.videoEl.srcObject == this.mediaStream) {
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
		roomId: { default: "" },
		streamId: { default: "" },
		maxWidth: { default: 8 },
		maxHeight: { default: 6 },
		settingUrl: { default: "/webrtc-rdp/" },
		filesystem: { default: 'all', oneOf: ['none', 'connected', 'all'] },
		adaptiveResolution: { default: true },
	},
	/** @type {PlayerConnection} */
	playerConn: null,
	/** @type {HTMLVideoElement} */
	videoEl: null,
	width: 0,
	height: 0,
	/** @type {string|null} */
	tempRoomId: null,
	settingIndex: -1,
	timer: 0,
	init() {
		if (this.data.filesystem == 'all') {
			// defined in ../app/rtcfilesystem-client.js
			const roomIdPrefix = 'binzume@rdp-room-';
			globalThis.rtcFileSystemManager?.registerAll((key, id) => new PlayerConnection(this.data.signalingUrl, key, id, null), roomIdPrefix);
		}
		// @ts-ignore
		let screenEl = this.screenEl = this._byName("screen");

		let dragging = false;
		let dragTimer = null;
		let mouseMoveTimer = null;
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
					let app = await vrapp.appManager.start(vrapp.app.id, null, { disableWindowLocator: true });
					app.object3D.quaternion.copy(this.el.object3D.quaternion);
					app.setAttribute('position', app.object3D.parent.worldToLocal(position));
					app.addEventListener('loaded', (_) => {
						app.components['webrtc-rdp'].tempRoomId = r.roomId;
						app.setAttribute('webrtc-rdp', { roomId: this.data.roomId, streamId: stream.id, maxWidth: Math.max(scale.x, 1.5), maxHeight: Math.max(scale.y, 1.5) });
						app.components['webrtc-rdp']?.resize(scale.x, scale.y);
					}, { once: true });
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
			let settings = Settings.getPeerDevices()[this.settingIndex];
			if (settings) {
				this.el.setAttribute('webrtc-rdp', { roomId: settings.roomId });
			}
		});
		this._byName("addButton").addEventListener('click', ev => {
			this.el.sceneEl.exitVR();
			window.open(this.data.settingUrl, '_blank');
		});
		let selectSettings = (n) => {
			let d = Settings.getPeerDevices()[n];
			if (d) {
				this.settingIndex = n;
				this._byName("roomName").setAttribute('value', this._settingName(d));
			}
		};
		this._byName("roomNext").addEventListener('click', ev => selectSettings(this.settingIndex + 1));
		this._byName("roomPrev").addEventListener('click', ev => selectSettings(this.settingIndex - 1));

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
		if (oldData.roomId != this.data.roomId) {
			if (oldData.roomId) {
				this.tempRoomId = null;
			}
			this.data.roomId ? this.connect() : this.disconnect();
		}
	},
	connect() {
		this.disconnect();

		let data = this.data;
		this._updateScreen(null);
		this._byName('statusMessage').setAttribute('value', 'Connecting...');
		let settings = Settings.findPeerDevice(data.roomId) || { userAgent: '' };
		let roomId = this.tempRoomId || data.roomId;
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
			this._byName('statusMessage').setAttribute('value', '');
			this.resize(videoEl.videoWidth, videoEl.videoHeight);
			this.el.dispatchEvent(new CustomEvent('webrtc-rdp-connected', { detail: { roomId: roomId, event: ev } }));
		});
		videoEl.addEventListener('ended', ev => {
			this.el.dispatchEvent(new CustomEvent('webrtc-rdp-ended', { detail: { roomId: roomId, event: ev } }));
		});

		// replace
		if (this.videoEl) this.videoEl.parentNode.removeChild(this.videoEl);
		this.el.sceneEl.querySelector('a-assets').append(videoEl);
		this.videoEl = videoEl;

		// connect
		let player = this.playerConn = new PlayerConnection(data.signalingUrl, settings.signalingKey, roomId, videoEl);
		player.authToken = settings.token;
		player.reconnectWaitMs = 3000 + Math.random() * 5000;
		if (this.data.filesystem == 'connected' && globalThis.rtcFileSystemManager) {
			// defined in ../app/rtcfilesystem-client.js
			player.dataChannels['fileServer'] = globalThis.rtcFileSystemManager.getRtcChannelSpec('RDP-' + settings.roomId, 'RDP-' + this._settingName(settings, 12));
		}
		player.onstatechange = (state) => {
			if (state == 'disconnected') {
				this._byName('statusMessage').setAttribute('value', 'Disconnected');
				this._updateScreen(null);
			}
		};
		player.onauth = (ok) => {
			if (!ok) {
				this.disconnect();
				this._byName('statusMessage').setAttribute('value', 'Access denied');
				return;
			}
			if (this.tempRoomId == null && this.data.streamId) {
				this.tempRoomId = ""; // avoid ridirect loop. TODO
				this.playerConn.sendRpcAsync('play', { streamId: this.data.streamId, redirect: true });
			}
			if (player.services && player.services['RDP'] === undefined) {
				this._byName('statusMessage').setAttribute('value', 'No desktop');
			}
		};
		player.onstreaminfo = (info) => {
			if (info.title) {
				this.el.setAttribute("xywindow", "title", this._settingName(settings) + ' - ' + info.title);
			}
		};
		player.connect();
		if (data.adaptiveResolution) {
			this.timer = setInterval(() => this._checkResolution(), 1000);
		}
	},
	_checkResolution() {
		let sceneEl = this.el.sceneEl;
		let renderer = sceneEl?.renderer;
		if (!sceneEl || !renderer) { return; }
		let vp = renderer.xr.isPresenting ?
			renderer.xr.getCamera().cameras[0].viewport :
			renderer.getViewport(new THREE.Vector4());
		let vw = this.videoEl.videoWidth;
		if (vw > 0) {
			let camera = renderer.xr.isPresenting ? renderer.xr.getCamera() : sceneEl.camera;
			let w = this.screenEl.getAttribute('width') * 0.2;
			let d = this.el.object3D.getWorldPosition(new THREE.Vector3()).distanceTo(camera.getWorldPosition(new THREE.Vector3()));
			let preferredWidth = vp.width * w / d * 0.75; // TODO
			if (vw * 1.5 < preferredWidth || vw / 1.5 > preferredWidth) {
				this.playerConn.sendRpcAsync('setResolution', { preferredWidth: preferredWidth });
			}
		}
	},
	disconnect() {
		this.playerConn?.dispose();
		this.playerConn = null;
		clearTimeout(this.timer);
		this.timer = 0;
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
		this.screenEl.setAttribute('material', { shader: "flat", src: src, color: src ? '#fff' : '#000' });
	},
	_byName(name) {
		return /** @type {import("aframe").Entity} */ (this.el.querySelector("[name=" + name + "]"));
	},
	remove() {
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

AFRAME.registerComponent('webrtc-rdp-app', {
	schema: {},
	init() {
		this.el.addEventListener('app-start', async (ev) => {
			if (ev.detail.restoreState) {
				this.el.setAttribute('webrtc-rdp', ev.detail.restoreState);
			}
			this.el.addEventListener('app-save-state', async (ev) => {
				ev.detail.setState(this.el.getAttribute('webrtc-rdp'));
			});
		}, { once: true });
	}
});
