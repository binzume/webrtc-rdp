# WebRTC + WebXR RDP Demo

WebRTCとWebXRでPCのデスクトップをWebVR内で表示するためのデモ．

Demo URL: https://binzume.github.io/webrtc-rdp/

## Usage

1. https://binzume.github.io/webrtc-rdp/ にアクセスします
2. 接続したいブラウザ間でペアリングします．片方のブラウザでPINを生成し，もう一方のブラウザでそのPINを入力してください
3. Publish(スクリーンをシェア) するか Play(シェアされたスクリーンに接続) するか選択してください
4. Publishする場合はデスクトップのキャプチャを許可してください．また，あとからストリームを追加できます．
5. Play時に `WebXR` リンクから VR モードに入れます (Oculus Quest用)

最低限の動作確認のためのデモなので，本格利用する場合は色々いじってください．

## Mouse/Keyboard

マウスやキーボードの操作はブラウザからはできないので，ワイヤレスキーボード等の別の手段を用意してください．
(ホスト側でマウスやキーボードをコントロールするプログラムを起動しておけば操作できるようにする予定です)

## WebRTC

- WebRTC Signaling Serverは[OpenAyame/ayame](https://github.com/OpenAyame/ayame)を使います
- デモの実装では[Ayame Labo](https://ayame-labo.shiguredo.jp/)に接続します．本格利用する場合は自分でAyameを動かしたほうが良いです．

## VR

- [A-Frame](https://aframe.io/)を使っています．
- Oculus Quest 2 で動作確認しています
- [binzume/vr-workspace](https://github.com/binzume/vr-workspace)からアプリとして呼び出す前提の作りになっています

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
