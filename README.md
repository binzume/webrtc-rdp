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

## Security

- P2Pなので，同じネットワーク内で使う場合は共有している映像や音声などはインターネットを経由しません．
- デモの実装ではAyame Laboを使って接続します．セキュアな接続が必要な場合は自分の環境でAyameを起動して使ってください．
- 接続にAyame Laboを使っている場合，何らかの理由でRoomIdが漏れると他者が接続できる可能性があるので，接続を待機した状態で放置しないでください．
- RoomIdはPINの交換時にランダムな文字列から生成して共有します．

## TODO

- 見た目をまともにする
- マウス＆キー入力をデータチャネルに乗せる＆PC上でデーモンとして動かす

## License

MIT
