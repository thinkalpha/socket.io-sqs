/* eslint-disable no-console */
import {BroadcastOptions, Room, SocketId} from 'socket.io-adapter';
import {SNS, SNSClient, SNSClientConfig} from '@aws-sdk/client-sns';
import {SQS, SQSClient, SQSClientConfig} from '@aws-sdk/client-sqs';
import {Namespace, Adapter, Room as FormalRoom} from 'socket.io';
import { EventEmitter } from 'events';
import asyncLock from 'async-lock';
import { Message } from '@aws-sdk/client-sqs/types/models';
import {mapIter} from './util';
import { CreateTopicResponse } from '@aws-sdk/client-sns/types/models';
import AbortController from 'node-abort-controller';
import debugFactory from 'debug';

const debug = debugFactory('socket.io-sqs');

export interface SqsSocketIoAdapterOptions {
    roomSqsNameOrPrefix: string | ((room: string, nsp: Namespace) => string);
    roomSnsNameOrPrefix: string | ((room: string, nsp: Namespace) => string);
    defaultSqsName: string;
    defaultSnsName: string;
    snsClient: SNS | SNSClientConfig;
    sqsClient: SQS | SQSClientConfig;
    region: string;
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

        private async createQueueForRoom(room: string, topicReply: CreateTopicResponse): Promise<{arn: string, url: string}> {
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
                Attributes: {Policy: policy}
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

        private async createRoomSnsAndSqs(room: string): Promise<{queueUrl: string, subscriptionArn: string}> {
            const snsName = this.getRoomSnsName(room);
            const topicReply = await this.snsClient.createTopic({Name: snsName});
            
            const queue = await this.createQueueForRoom(room, topicReply);
            const subscription = await this.snsClient.subscribe({TopicArn: topicReply.TopicArn, Protocol: 'sqs', Endpoint: queue.arn});
            return {
                queueUrl: queue.url,
                subscriptionArn: subscription.SubscriptionArn!
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

        private createRoomListener(room: string, queueUrl: string, subscriptionArn: string): () => void {
            const abortController = new AbortController();

            (async () => {
                debug('Starting room listener for', room);
                while (!abortController.signal.aborted) {
                    try {
                        const res = await this.sqsClient.receiveMessage({
                            QueueUrl: queueUrl,
                            MaxNumberOfMessages: 10, // 10 is max
                            WaitTimeSeconds: 1 // 20 is max
                        }, {
                            abortSignal: abortController.signal as any
                        });
                        debug('Got', res.Messages?.length ?? 0, 'messages for room', room);
                        if (!res.Messages) continue;
                        for (const message of res.Messages) {
                            this.handleMessage(message, room);
                        }
                    } catch (e) {
                        if (e.name !== 'AbortError') {
                            console.warn('Failed to retrieve messages for room', room, e);
                        }
                    }
                }
            })();

            return async () => {
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

        addAll(id: string, rooms: string[], callback?: () => void): void {
            // eslint-disable-next-line prefer-rest-params
            debug('addAll', ...arguments);
            
            (async () => {
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

                await Promise.all([...mapIter(newRooms, async room => {
                    const {queueUrl, subscriptionArn} = await this.createRoomSnsAndSqs(room);
                    const unsub = this.createRoomListener(room, queueUrl, subscriptionArn);
                    this.roomListeners.set(room, unsub);
                })]);
            })().then(callback);
        }
        
        del(id: string, room: string, callback?: () => void): void {
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

            callback?.();
        }
        delAll(id: string, callback?: () => void): void {
            if (!this._sids.has(id)) {
                return;
            }
        
            for (const room of this._sids.get(id)!) {
                this.del(id, room); // todo: probably wrap this via promises
            }
        
            this._sids.delete(id);

            callback?.();
        }

        private constructTopicArn(topic: string) {
            const arn = `arn:aws:sns:${options.region}:${options.accountId}:${topic}`;
            return arn;
        }

        private constructQueueArn(queueName: string) {
            const arn = `arn:aws:sqs:${options.region}:${options.accountId}:${queueName}`;
            return arn;
        }

        broadcast(packet: any, opts: BroadcastOptions, callback?: () => void): void {
            debug('broadcast', packet, opts);
            if (!opts.flags?.local) {
                const envelope: Envelope = {
                    packet,
                    except: opts.except && [...opts.except]
                };
                (async () => {
                    await Promise.all([...mapIter(opts.rooms, async room => {
                        try {
                            const arn = this.constructTopicArn(this.getRoomSnsName(room));
                            debug('Publishing message for room', room, 'arn', arn, envelope);
                            await this.snsClient.publish({
                                TopicArn: arn,
                                Message: JSON.stringify(envelope),
                                MessageAttributes: {
                                    ['test']: {DataType: 'String', StringValue: 'asdf'}
                                }
                            });
                        } catch (e) {
                            if (e.Code !== 'NotFound') throw e;
                            console.warn('Room does not exist but tried to send to it', room);
                        }
                    })]);
                })().then(callback);
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

                callback?.();
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