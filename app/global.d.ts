
declare var Ayame: typeof import('@open-ayame/ayame-web-sdk')

declare type KeyAction = { target: { id: string, name?: string, dispaly_id?: string }, action: string, key: string, modifiers: string[] };
declare type MouseAction = { target: { id: string, name?: string, dispaly_id?: string }, action: string, button: number, x: number, y: number };

declare var RDP: {
    getDisplayStreams(types: string[]): Promise<{ id: string, name: string, dispaly_id: string }[]>
    sendMouse(mouse: MouseAction): Promise<void>
    sendKey(key: KeyAction): Promise<void>
    streamFromPoint(params: { target: any, x: number, y: number }): Promise<any>
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
    onmessage?: ((ch: RTCDataChannel, ev: MessageEvent) => void)
    onopen?: ((ch: RTCDataChannel, ev: Event) => void)
    onclose?: ((ch: RTCDataChannel, ev: Event) => void)
    ch?: RTCDataChannel | null
}

declare interface DeviceSettings {
    name?: string
    roomId: string
    publishRoomId?: string | null
    localToken?: string,
    signalingKey: string | null
    userAgent: string
    token: string
    services?: string[]
}


declare interface FileInfo {
    type: string;
    name: string;
    size: number;
    path: string;
    updatedTime: number;
    tags?: string[];
    thumbnail?: { [k: string]: any };
    remove?(): any;
    [k: string]: any;
}

declare interface FilesResult {
    name?: string;
    items: FileInfo[];
    next: any;
    more?: boolean;
}

declare interface Folder {
    getFiles(offset: any, limit: number, options: object, signal: AbortSignal): Promise<FilesResult>;
}

declare interface FolderResolver {
    getFolder(path: string, prefix?: string): Folder;
    parsePath(path: string): string[][];
}

declare var storageAccessors: Record<string, FolderResolver & { name: string, [k: string]: any; }> | undefined;
