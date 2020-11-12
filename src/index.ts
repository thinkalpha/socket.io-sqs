/* eslint-disable no-console */
import {BroadcastOptions, Room, SocketId, Adapter} from 'socket.io-adapter';
import {CreateTopicCommand, SNS, SNSClient, SNSClientConfig} from '@aws-sdk/client-sns';
import {SQS, SQSClient, SQSClientConfig} from '@aws-sdk/client-sqs';
import {Namespace, Socket} from 'socket.io';
import { EventEmitter } from 'events';
import { Message, CreateQueueRequest } from '@aws-sdk/client-sqs/types/models';
import {mapIter} from './util';
import { CreateTopicInput, CreateTopicResponse } from '@aws-sdk/client-sns/types/models';
import AbortController from 'node-abort-controller';
import debugFactory from 'debug';

const debug = debugFactory('socket.io-sqs');

export enum SidRoomRouting {
    normal = 'normal',
    local = 'local',
    banned = 'banned'
}

export interface SqsSocketIoAdapterOptions {
    roomSqsNameOrPrefix: string | ((room: Room, nsp: Namespace) => string);
    roomSnsNameOrPrefix: string | ((room: Room, nsp: Namespace) => string);
    defaultSqsName?: string;
    defaultSnsName?: string;
    queueTags?: CreateQueueRequest['tags'];
    topicTags?: CreateTopicInput['Tags'];
    snsClient: SNS | SNSClientConfig;
    sqsClient: SQS | SQSClientConfig;
    region: string;
    accountId: string;
    sidRoomRouting?: SidRoomRouting;
    
    shutdownCallbackCallback?: (callback: () => Promise<void>) => void;
    readyCallback?: () => void;
}

interface Envelope {
    packet: any;
    except?: SocketId[];
}

interface SocketWithPacketOnly {
    /** see socket.io-adapter source code's broadcast function for where this is used */
    packet(packet: any, packetOpts: {preEncoded?: boolean, volatile?: boolean, compress?: boolean}): void;
}

type OmitFirstArg<F> = F extends (x: any, ...args: infer P) => infer R ? (...args: P) => R : never;

const nullSet = new Set<null>([null]);
Object.freeze(nullSet);

export function SqsSocketIoAdapterFactory(options: SqsSocketIoAdapterOptions): Adapter {
    return class SqsSocketIoAdapterClass /* extends EventEmitter implements Adapter */ {
        private _rooms: Map<Room, Set<SocketId>> = new Map();
        private _sids: Map<SocketId, Set<Room>> = new Map();

        get rooms() {
            const retval: Adapter['rooms'] = new Map();
            this._rooms.forEach((sids, room) => {
                const sidsSet: Set<string> = new Set();
                this._sids.forEach((_, sid) => {
                    if (sids.has(sid)) sidsSet.add(sid);
                });
                retval.set(room, sidsSet);
            });
            return retval;
        }

        get sids() {
            const retval: Adapter['sids'] = new Map();
            this._sids.forEach((_, sid) => {
                const roomsSet: Set<Room> = new Set();
                this._rooms.forEach((sids, room) => {
                    if (sids.has(sid)) roomsSet.add(room);
                });
                retval.set(sid, roomsSet);
            });
            return retval;
        }

        private roomListeners: Map<Room | null, () => Promise<void>> = new Map();

        private localRouting: Set<string> = new Set();

        private readonly snsClient: SNS;
        private readonly sqsClient: SQS;

        constructor(public nsp: Namespace) {
            // super(nsp);
            // super();
            this.snsClient = options.snsClient instanceof SNS ? options.snsClient : new SNS(options.snsClient);
            this.sqsClient = options.sqsClient instanceof SQS ? options.sqsClient : new SQS(options.sqsClient);

            (async () => {
                const {queueUrl, subscriptionArn} = await this.createRoomSnsAndSqs(null);
                const unsub = this.createRoomListener(null, queueUrl, subscriptionArn);
                this.roomListeners.set(null, unsub);
                options.readyCallback?.();
            })();

            options.shutdownCallbackCallback?.(async () => { await Promise.all(mapIter(this.roomListeners.values(), unsub => unsub())); });
        }

        private getRoomSnsName(room: string | null): string {
            if (!room) return options.defaultSnsName ?? this.getRoomSnsName('default');
            switch (typeof options.roomSnsNameOrPrefix) {
                case 'string':
                    return `${options.roomSnsNameOrPrefix}${room}`;
                case 'function':
                    return options.roomSnsNameOrPrefix(room, this.nsp);
            }
        }

        private getRoomSqsName(room: string | null): string {
            if (!room) return options.defaultSqsName ?? this.getRoomSqsName('default');
            switch (typeof options.roomSqsNameOrPrefix) {
                case 'string':
                    return `${options.roomSqsNameOrPrefix}${room}`;
                case 'function':
                    return options.roomSqsNameOrPrefix(room, this.nsp);
            }
        }

        private async createQueueForRoom(room: string | null, topicReply: CreateTopicResponse): Promise<{arn: string, url: string}> {
            const sqsName = this.getRoomSqsName(room);
            const sqsArn = this.constructQueueArn(sqsName);
            /* eslint-disable quotes */
            const policy = JSON.stringify({
                "Version": "2012-10-17",
                "Id": "__default_policy_ID",
                "Statement": [
                    {
                        "Sid": "__owner_statement", // "Sid" + new Date().getTime(),
                        "Effect": "Allow",
                        "Principal": "*",
                        "Action": "SQS:SendMessage",
                        "Resource": sqsArn,
                        "Condition": {
                            "ArnEquals": {
                                "aws:SourceArn": topicReply.TopicArn!
                            }
                        }
                    }
                ]
            });
            /* eslint-enable quotes */
            const createQueueReply = await this.sqsClient.createQueue({
                QueueName: sqsName,
                tags: {
                    ...options.queueTags,
                    ...(room ? {room, default: 'false'} : {default: 'true'})
                },
                Attributes: {
                    Policy: policy,

                }
            });
            const attrs = await this.sqsClient.getQueueAttributes({
                QueueUrl: createQueueReply.QueueUrl,
                AttributeNames: ['QueueArn']
            });
            debug('queue url', createQueueReply.QueueUrl, 'queue arn', attrs.Attributes!['QueueArn']);
            return {
                arn: attrs.Attributes!['QueueArn'],
                url: createQueueReply.QueueUrl!
            };
        }

        private async createRoomSnsAndSqs(room: string | null): Promise<{queueUrl: string, subscriptionArn: string}> {
            const snsName = this.getRoomSnsName(room);
            const topicReply = await this.snsClient.createTopic({
                Name: snsName,
                Tags: options.topicTags
            });
            
            const queue = await this.createQueueForRoom(room, topicReply);
            const subscription = await this.snsClient.subscribe({TopicArn: topicReply.TopicArn, Protocol: 'sqs', Endpoint: queue.arn, Attributes: {'RawMessageDelivery': 'true'}});
            return {
                queueUrl: queue.url,
                subscriptionArn: subscription.SubscriptionArn!
            };
        }

        private handleMessage(msg: Message, room: string | null) {
            const sids = room ? this._rooms.get(room)! : this.nsp.sockets.keys();
            const envelope: Envelope = JSON.parse(msg.Body!);
            const excepts = new Set(envelope.except);
            const packet = envelope.packet;
            for (const sid of sids) {
                if (excepts.has(sid)) continue;

                (this.nsp.sockets.get(sid) as unknown as SocketWithPacketOnly)?.packet(packet, {
                    preEncoded: false,

                });
            }
        }

        private createRoomListener(room: string | null, queueUrl: string, subscriptionArn: string): () => Promise<void> {
            const abortController = new AbortController();

            (async () => {
                debug('Starting room listener for', room);
                while (!abortController.signal.aborted) {
                    try {
                        debug('Retrieving messages for room', room);
                        const res = await this.sqsClient.receiveMessage({
                            QueueUrl: queueUrl,
                            MaxNumberOfMessages: 10, // 10 is max
                            WaitTimeSeconds: 5, // 20 is max
                            VisibilityTimeout: 1,
                            MessageAttributeNames: [
                                'All'
                            ],
                            AttributeNames: [
                                'SentTimestamp'
                            ],
                        }, {
                            abortSignal: abortController.signal as any
                        });
                        debug('Got', res.Messages?.length ?? 0, 'messages for room', room);
                        if (!res.Messages) continue;
                        await Promise.all(res.Messages.map(message => {
                            this.handleMessage(message, room);
                            return this.sqsClient.deleteMessage({
                                QueueUrl: queueUrl,
                                ReceiptHandle: message.ReceiptHandle
                            });
                        }));
                    } catch (e) {
                        if (e.name !== 'AbortError' && e.code !== 'ECONNRESET') {
                            console.warn('Failed to retrieve messages for room', room, e);
                        }
                    }
                }
            })();

            return async () => {
                if (abortController.signal.aborted) return;

                abortController.abort();
                await Promise.all([
                    this.sqsClient.deleteQueue({QueueUrl: queueUrl})
                        .then(() => debug('Deleted queue for room', room))
                        .catch(err => console.warn('Failed to delete queue for room', room, err)),
                    this.snsClient.unsubscribe({SubscriptionArn: subscriptionArn})
                        .then(() => debug('Deleted subscription for room', room))
                        .catch(err => console.warn('Failed to unsubscribe queue for room', room, 'w/ subscription arn', subscriptionArn, err)),
                ]);
            };
        }

        async addAll(id: string, rooms: string[]): Promise<void> {
            // eslint-disable-next-line prefer-rest-params
            debug('addAll', ...arguments);
            
            const newRooms = new Set<string>();
            for (const room of rooms) {
                if (room === id) {
                    if (options.sidRoomRouting === SidRoomRouting.banned) continue;
                    if (options.sidRoomRouting === SidRoomRouting.local) {
                        this.localRouting.add(room);
                        continue;
                    }
                }
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

            await Promise.all([...mapIter(newRooms, async room => {
                const {queueUrl, subscriptionArn} = await this.createRoomSnsAndSqs(room);
                const unsub = this.createRoomListener(room, queueUrl, subscriptionArn);
                this.roomListeners.set(room, unsub);
            })]);
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
                    this.roomListeners.get(room)?.();
                    this.roomListeners.delete(room);
                }
            }
        }
        delAll(id: string): void {
            this.localRouting.delete(id);
            
            if (!this._sids.has(id)) {
                return;
            }
        
            for (const room of this._sids.get(id)!) {
                this.del(id, room); // todo: probably wrap this via promises
            }
        
            this._sids.delete(id);
        }

        private constructTopicArn(topic: string) {
            const arn = `arn:aws:sns:${options.region}:${options.accountId}:${topic}`;
            return arn;
        }

        private constructQueueArn(queueName: string) {
            const arn = `arn:aws:sqs:${options.region}:${options.accountId}:${queueName}`;
            return arn;
        }

        async broadcast(packet: any, opts: BroadcastOptions): Promise<void> {
            debug('broadcast', packet, opts);
            if (!opts.flags?.local) {
                const envelope: Envelope = {
                    packet,
                    except: opts.except && [...opts.except]
                };
                const rooms = opts.rooms && opts.rooms.size ? opts.rooms : nullSet;
                await Promise.all([...mapIter(rooms, async room => {
                    if (this.localRouting.has(room!)) {
                        await this.broadcast(packet, {...opts, rooms: new Set([room!]), flags: {...opts.flags, local: true}});
                    } else {
                        try {
                            const snsName = room ? this.getRoomSnsName(room) : (options.defaultSnsName ?? this.getRoomSnsName(''));
                            const arn = this.constructTopicArn(snsName);
                            debug('Publishing message for room', room, 'arn', arn, envelope);
                            await this.snsClient.publish({
                                TopicArn: arn,
                                Message: JSON.stringify(envelope),
                                MessageAttributes: {
                                    ['test']: {DataType: 'String', StringValue: 'asdf'}
                                },
                            });
                        } catch (e) {
                            if (e.Code !== 'NotFound') throw e;
                            console.warn('Room does not exist but tried to send to it', room);
                        }
                    }
                })]);
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
                            const socket = this.nsp.sockets.get(id);
                            if (socket) {
                                (socket as unknown as SocketWithPacketOnly).packet(packet, packetOpts);
                                ids.add(id);
                            }
                        }
                    }
                } else {
                    for (const [id] of this._sids) {
                        if (except.has(id)) continue;
                        const socket = this.nsp.sockets.get(id);
                        if (socket) (socket as unknown as SocketWithPacketOnly).packet(packet, packetOpts);
                    }
                }
            }
        }
        sockets(rooms: Set<Room>, callback?: (sockets: Set<SocketId>) => void): Promise<Set<SocketId>> {
            const sids = new Set<SocketId>();

            if (rooms.size) {
                for (const room of rooms) {
                    if (!this._rooms.has(room)) continue;

                    for (const id of this._rooms.get(room)!) {
                        if (id in this.nsp.sockets) {
                            sids.add(id);
                        }
                    }
                }
            } else {
                for (const [id] of this._sids) {
                    if (id in this.nsp.sockets) sids.add(id);
                }
            }

            callback?.(sids);
            return Promise.resolve(sids);
        }

        socketRooms(id: string): Set<Room> | undefined {
            return this._sids.get(id);
        }
    } as any as Adapter;
}

export default SqsSocketIoAdapterFactory;
