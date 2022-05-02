
declare var Ayame: import('@open-ayame/ayame-web-sdk')

type KeyAction = { target: object, action: string, key: string, modifiers: string[] };
type MouseAction = { target: object, action: string, button: Numver, x: Number, y: Number };

interface IPCHandler {
    getDisplayStreams(types: string[]): Promise<{ id: string, name: string, dispaly_id: string }[]>
    sendMouse(mouse: MouseAction): Primise<void>
    sendKey(key: KeyAction): Primise<void>
    streamFromPoint(params: { target: any, x: Number, y: Number }): Promise<any>
}

declare var RDP: IPCHandler
