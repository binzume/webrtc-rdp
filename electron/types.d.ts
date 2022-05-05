
declare var Ayame: import('@open-ayame/ayame-web-sdk')

type KeyAction = { target: object, action: string, key: string, modifiers: string[] };
type MouseAction = { target: object, action: string, button: Numver, x: Number, y: Number };

declare var RDP : {
    getDisplayStreams(types: string[]): Promise<{ id: string, name: string, dispaly_id: string }[]>
    sendMouse(mouse: MouseAction): Primise<void>
    sendKey(key: KeyAction): Primise<void>
    streamFromPoint(params: { target: any, x: Number, y: Number }): Promise<any>
}

declare interface StreamSpec {
    id: string
    name: string
    hasAudio?: boolean
}

declare interface ConnectionInfo {
    id: number
    name: string
    conn: PublisherConnection
    permanent: boolean
}

declare interface StreamProvider {
    startStream: ((cm: ConnectionManager, spec: StreamSpec, permanent: boolean) => Promise<ConnectionInfo>)
    getStreams?: (() => Promise<StreamSpec[]>)
}

declare interface DataChannelInfo {
    onmessage?: ((ch: RTCDataChannel, ev: any) => void)
    onopen?: ((ch: RTCDataChannel, ev: Event) => void)
    onclose?: ((ch: RTCDataChannel, ev: Event) => void)
    ch?: RTCDataChannel
}

declare interface DeviceSettings {
    name?: string
    roomId: string
    publishRoomId?: string
    signalingKey: string | null
    userAgent: string
    token: string
}
