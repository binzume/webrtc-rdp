# WIP: WebRTC + WebXR RDP Demo

WebRTCとWebXRでPCのデスクトップをWebVR内で表示するためのデモ．作りかけです．

Demo URL: https://binzume.github.io/webrtc-rdp/

## WebRTC

- WebRTC Signaling Serverは[OpenAyame/ayame](https://github.com/OpenAyame/ayame)を使います
- デモの実装では[Ayame Labo](https://ayame-labo.shiguredo.jp/)に接続します．本格利用する場合は自分でAyameを動かしたほうが良いです．

## VR

- [A-Frame](https://aframe.io/)を使っています．
- Oculus Quest 2 で動作確認しています
- [binzume/vr-workspace](https://github.com/binzume/vr-workspace)に追加する前提の実装です

## TODO

- 見た目をまともにする
- マウス＆キー入力をデータチャネルに乗せる＆PC上でデーモンとして動かす

## License

MIT
