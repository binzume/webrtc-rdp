
declare var Ayame: import('@open-ayame/ayame-web-sdk')

type KeyAction = { target: string, action: string, key: string, modifiers: string[] };
type MouseAction = { target: string, action: string, button: Numver, x: Number, y: Number };

interface IPCHandler {
    getDisplayStreams(types: string[]): Promise<{ id: string, name: string, dispaly_id: string}[]>
    sendMouse(mouse: MouseAction): Promise<void>
    sendKey(key: KeyAction): Promise<void>
}

declare var RDP: IPCHandler
