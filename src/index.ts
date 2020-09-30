import {BroadcastOptions, Room, SocketId} from 'socket.io-adapter';
import {SNS, SNSClient, SNSClientConfig} from '@aws-sdk/client-sns';
import {SQS, SQSClient, SQSClientConfig} from '@aws-sdk/client-sqs';
import {Namespace, Adapter, Room as FormalRoom} from 'socket.io';
import { EventEmitter } from 'events';
import asyncLock from 'async-lock';
import { Message } from '@aws-sdk/client-sqs/types/models';

export interface SqsSocketIoAdapterOptions {
    roomSqsNameOrPrefix: string | ((room: string, nsp: Namespace) => string);
    roomSnsNameOrPrefix: string | ((room: string, nsp: Namespace) => string);
    defaultSqsName: string;
    defaultSnsName: string;
    snsClient: SNS | SNSClientConfig;
    sqsClient: SQS | SQSClientConfig;
    accountId: string;
}

interface Envelope {
    packet: any;
    except?: SocketId[];
}

declare module 'socket.io' {
    interface Socket {
        /** see socket.io-adapter source code's broadcast function for where this is used */
        packet(packet: any, packetOpts: {preEncoded?: boolean, volatile?: boolean, compress?: boolean}): void;
    }
}

type OmitFirstArg<F> = F extends (x: any, ...args: infer P) => infer R ? (...args: P) => R : never;

export function SqsSocketIoAdapter(options: SqsSocketIoAdapterOptions) {
    return class SqsSocketIoAdapter /* extends EventEmitter implements Adapter */ {
        private _rooms: Map<Room, Set<SocketId>> = new Map();
        private _sids: Map<SocketId, Set<Room>> = new Map();

        get rooms() {
            const retval: Adapter['rooms'] = {};
            this._rooms.forEach((sids, room) => {
                const sidsMap: FormalRoom['sockets'] = {};
                let len = 0;
                this._sids.forEach((_, sid) => {
                    sidsMap[sid] = sids.has(sid);
                    if (sids.has(sid)) len++;
                });
                retval[room] = {
                    sockets: sidsMap,
                    length: len
                };
            });
            return retval;
        }

        get sids() {
            const retval: Adapter['sids'] = {};
            this._sids.forEach((_, sid) => {
                const roomsMap: Adapter['sids'][''] = {};
                this._rooms.forEach((sids, room) => {
                    roomsMap[room] = sids.has(sid);
                });
                retval[sid] = roomsMap;
            });
            return retval;
        }

        private roomListeners: Map<Room, () => void> = new Map();

        private readonly snsClient: SNS;
        private readonly sqsClient: SQS;

        constructor(public nsp: Namespace) {
            // super(nsp);
            // super();
            this.snsClient = options.snsClient instanceof SNS ? options.snsClient : new SNS(options.snsClient);
            this.sqsClient = options.sqsClient instanceof SQS ? options.sqsClient : new SQS(options.sqsClient);
        }

        private getRoomSnsName(room: string) {
            switch (typeof options.roomSnsNameOrPrefix) {
                case 'string':
                    return `${options.roomSnsNameOrPrefix}${room}`;
                case 'function':
                    return options.roomSnsNameOrPrefix(room, this.nsp);
            }
        }

        private getRoomSqsName(room: string) {
            switch (typeof options.roomSqsNameOrPrefix) {
                case 'string':
                    return `${options.roomSqsNameOrPrefix}${room}`;
                case 'function':
                    return options.roomSqsNameOrPrefix(room, this.nsp);
            }
        }

        private async createQueueForRoom(room: string): Promise<{arn: string, url: string}> {
            const sqsName = this.getRoomSqsName(room);
            const createQueueReply = await this.sqsClient.createQueue({QueueName: sqsName});
            const attrs = await this.sqsClient.getQueueAttributes({QueueUrl: createQueueReply.QueueUrl, AttributeNames: ['QueueArn']});
            return {
                arn: attrs.Attributes!['QueueArn'],
                url: createQueueReply.QueueUrl!
            };
        }

        private async createRoomSnsAndSqs(room: string): Promise<{queueUrl: string}> {
            const snsName = this.getRoomSnsName(room);
            const createTopicPromise = this.snsClient.createTopic({Name: snsName});
            
            const [topicReply, queue] = await Promise.all([createTopicPromise, this.createQueueForRoom(room)]);
            /* eslint-disable quotes */
            const newQueueAttrs: any = {
                "Version": "2008-10-17",
                "Id": `${queue.arn}/SQSDefaultPolicy`,
                "Statement": [{
                    "Sid": "Sid" + new Date().getTime(),
                    "Effect": "Allow",
                    "Principal": {
                        "AWS": "*"
                    },
                    "Action": "SQS:SendMessage",
                    "Resource": queue.arn,
                    "Condition": {
                        "ArnEquals": {
                            "aws:SourceArn": topicReply.TopicArn!
                        }
                    }
                }]
            };
            /* eslint-enable quotes */
            await Promise.all([
                this.sqsClient.setQueueAttributes({QueueUrl: queue.url, Attributes: newQueueAttrs}),
                this.snsClient.subscribe({TopicArn: topicReply.TopicArn, Protocol: 'sqs', Endpoint: queue.arn})
            ]);
            return {
                queueUrl: queue.url
            };
        }

        private handleMessage(msg: Message, room: string) {
            const sids = this._rooms.get(room)!;
            const envelope: Envelope = JSON.parse(msg.Body!);
            const excepts = new Set(envelope.except);
            const packet = envelope.packet;
            for (const sid of sids) {
                if (excepts.has(sid)) continue;

                this.nsp.connected[sid]?.packet(packet, {
                    preEncoded: false,

                });
            }
        }

        private createRoomListener(room: string, queueUrl: string): () => void {
            let run = true;

            (async () => {
                while (run) {
                    const res = await this.sqsClient.receiveMessage({
                        QueueUrl: queueUrl,
                        MaxNumberOfMessages: 10,
                        WaitTimeSeconds: 100
                    });
                    if (!res.Messages) continue;
                    for (const message of res.Messages) {
                        this.handleMessage(message, room);
                    }
                }
            })();

            return () => {
                run = false;
                this.sqsClient.deleteQueue({QueueUrl: queueUrl});
            };
        }

        addAll(id: string, rooms: Set<string>): void {
            const newRooms = new Set<string>();
            for (const room of rooms) {
                if (!this._sids.has(id)) {
                    this._sids.set(id, new Set());
                }
                this._sids.get(id)!.add(room);
        
                if (!this._rooms.has(room)) {
                    this._rooms.set(room, new Set());
                    newRooms.add(room);
                }
                this._rooms.get(room)!.add(id);
            }

            newRooms.forEach(async room => {
                const {queueUrl} = await this.createRoomSnsAndSqs(room);
                const unsub = this.createRoomListener(room, queueUrl);
                this.roomListeners.set(room, unsub);
            });
        }
        
        del(id: string, room: string): void {
            if (this._sids.has(id)) {
                this._sids.get(id)!.delete(room);
            }
        
            if (this._rooms.has(room)) {
                this._rooms.get(room)!.delete(id);
                if (this._rooms.get(room)!.size === 0) {
                    this._rooms.delete(room);

                    // tear down the room listener
                    this.roomListeners.get(room)!();
                    this.roomListeners.delete(room);
                }
            }
        }
        delAll(id: string): void {
            if (!this._sids.has(id)) {
                return;
            }
        
            for (const room of this._sids.get(id)!) {
                this.del(id, room);
            }
        
            this._sids.delete(id);
        }

        private constructTopicArn(topic: string) {
            const arn = `arn:aws:sns:${this.snsClient.config.region}:${options.accountId}:${topic}`;
            return arn;
        }

        broadcast(packet: any, opts: BroadcastOptions): void {
            if (!opts.flags?.local) {
                const envelope: Envelope = {
                    packet,
                    except: opts.except && [...opts.except]
                };
                opts.rooms.forEach(room => 
                    this.snsClient.publish({
                        TopicArn: this.constructTopicArn(this.getRoomSnsName(room)),
                        Message: JSON.stringify(envelope)
                    })
                );
            } else {
                const rooms = opts.rooms;
                const except = opts.except ?? new Set();
                const flags = opts.flags ?? {};
                const packetOpts = {
                    preEncoded: false,
                    volatile: flags.volatile,
                    compress: flags.compress
                };
                const ids = new Set();

                packet.nsp = this.nsp.name;
                // const encodedPackets = this.encoder.encode(packet);

                if (rooms.size) {
                    for (const room of rooms) {
                        if (!this._rooms.has(room)) continue;

                        for (const id of this._rooms.get(room)!) {
                            if (ids.has(id) || except.has(id)) continue;
                            const socket = this.nsp.connected[id];
                            if (socket) {
                                socket.packet(packet, packetOpts);
                                ids.add(id);
                            }
                        }
                    }
                } else {
                    for (const [id] of this._sids) {
                        if (except.has(id)) continue;
                        const socket = this.nsp.connected[id];
                        if (socket) socket.packet(packet, packetOpts);
                    }
                }
            }
        }
        sockets(rooms: Set<Room>): Promise<Set<SocketId>> {
            const sids = new Set<SocketId>();

            if (rooms.size) {
                for (const room of rooms) {
                    if (!this._rooms.has(room)) continue;

                    for (const id of this._rooms.get(room)!) {
                        if (id in this.nsp.connected) {
                            sids.add(id);
                        }
                    }
                }
            } else {
                for (const [id] of this._sids) {
                    if (id in this.nsp.connected) sids.add(id);
                }
            }

            return Promise.resolve(sids);
        }
        socketRooms(id: string): Set<Room> | undefined {
            return this._sids.get(id);
        }
    };
}

export default SqsSocketIoAdapter;