# WebRTC + WebXR Remote Desktop

WebRTCとWebXRを使ったブラウザ上で動くリモートデスクトップです．WebXRではない通常表示も可能です．

![Screenshot](screenshot-xr.png)

最近の Chrome や Edge で動くはずです．VRモードは Oculus Quest 2 の Oculus Browser で動作確認しています．

Demo URL:
- https://binzume.github.io/webrtc-rdp/
- https://binzume.github.io/vr-workspace/#app:app-webrtc-rdp (WebXR)

## Usage

1. https://binzume.github.io/webrtc-rdp/ にアクセスします
2. (初回のみ)接続したいブラウザ間でペアリングします．片方のブラウザでPINを生成し，もう一方のブラウザでそのPINを入力してください
3. 「Share Desktop」または「Share Camera」ボタンで共有したいストリームを追加してください．
4. 「Open Remote Desktop」ボタンをクリックすると，相手側のデスクトップに接続します．複数のストリームがある場合は選択画面が表示されます．

- [WebXR](https://binzume.github.io/vr-workspace/#app:app-webrtc-rdp) リンクから VR モードでPCのデスクトップに接続できます (Oculus Quest用)
- 最低限の動作確認のためのデモなので，本格利用する場合は色々いじってください．

## Mouse/Keyboard

ブラウザ上からは，マウスやキーボードの制御はできないので，ワイヤレスキーボード・マウス等の手段を用意するか，下のElectron App版を使ってください．

どうしてもブラウザ経由でマウスを動かしたい場合は，ホスト側のPCで https://github.com/binzume/inputproxy を起動してください．
以下のような構成です．(キー入力は実装途中です)

```
クライアントブラウザ → (WebRTC DataChannel) → ホストブラウザ → (WebSocket) → inputproxy → マウス/キーボード
```

## Electron App

Chromeを起動していなくても単体で動くアプリケーションです．マウスやキーボードも使えます．

```
cd electron
npm install
npx electron-rebuild
npm start
```

毎回コマンドラインから起動するのが面倒な場合は， `npm run build-win` で実行ファイルをビルドできます．
MacOSでも動く気がしますが，Windowsでのみで動作確認しています．

# Design

![Design](design.png)

## WebRTC

- WebRTC Signaling Serverは[OpenAyame/ayame](https://github.com/OpenAyame/ayame)を使います
- デモの実装では[Ayame Labo](https://ayame-labo.shiguredo.jp/)に接続します．本格利用する場合は自分でAyameを動かしたほうが良いです

## VR

- [A-Frame](https://aframe.io/)を使っています．
- [単体](https://binzume.github.io/webrtc-rdp/webxr/)でも使えますが，[binzume/vr-workspace](https://github.com/binzume/vr-workspace)内のアプリとして読み込む前提の作りになっています

## Security

- P2Pなので，同じネットワーク内で使う場合は共有している映像や音声などはインターネットを経由しません．
- デモの実装ではAyame Laboを使って接続します．セキュアな接続が必要な場合は自分の環境でAyameを起動して使ってください．
- 接続にAyame Laboを使っている場合，何らかの理由でRoomIdが漏れると他者が接続できる可能性があるので，接続を待機した状態で放置しないでください．
- RoomIdはPINの交換時にランダムな文字列から生成して共有します．

## TODO

- WebXR時にレンダリング面積に合わせて元のvideo解像度を変える
- UIをまともにする
- クリップボード・ファイル共有機能

## License

MIT
