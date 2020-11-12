/* eslint-disable no-console */

// eslint-disable-next-line @typescript-eslint/no-var-requires
require('source-map-support').install();

import {SidRoomRouting, SqsSocketIoAdapterFactory, SqsSocketIoAdapterOptions} from '.';
import io, { Socket } from 'socket.io';
import ioclient from 'socket.io-client';
import { randomString, delay } from './util';
import getPort from 'get-port';

let options: SqsSocketIoAdapterOptions;
let shutdownCallback: () => Promise<void>;
let readyPromise: Promise<void>;

beforeEach(() => {
    const testName = randomString();
    const endpointName = randomString();

    readyPromise = new Promise(res => {
        options = {
            accountId: '723207552760',
            defaultSnsName: `socketio-test-${testName}-default`,
            defaultSqsName: `socketio-test-${testName}-${endpointName}-default`,
            roomSnsNameOrPrefix: `socketio-test-${testName}-`,
            roomSqsNameOrPrefix: `socketio-test-${testName}-${endpointName}-`,
            snsClient: {
                region: 'us-east-1',
            },
            sqsClient: {region: 'us-east-1'},
            region: 'us-east-1',
            sidRoomRouting: SidRoomRouting.local,
            shutdownCallbackCallback: cb => shutdownCallback = cb,
            readyCallback: res
        };

        console.info('using options', options);
    });
});

let socket: io.Server;
let client: ioclient.Socket;

afterEach(async () => {
    const closePromise = new Promise(res => socket?.close(res));
    client?.close();
    await closePromise;
    await shutdownCallback();
});

it('should forward a room-based message', async () => {
    const port = await getPort({});
    socket = new io.Server(port, { adapter: SqsSocketIoAdapterFactory(options) as any });
    socket.on('connect', async (clientsock: Socket) => {
        await clientsock.join('newroom');
        socket.to('newroom').emit('testevent', 'asdf');
    });
    await readyPromise;
    client = ioclient.io(`http://localhost:${port}`, {autoConnect: true, transports: ['websocket']});
    const promise = new Promise((res, rej) => client.on('testevent', (value: string) => res(value)));
    await promise;
    const res = await promise;
    expect(res).toBe('asdf');
});

it('should forward a non-room message', async () => {
    const port = await getPort({});
    socket = new io.Server(port, { adapter: SqsSocketIoAdapterFactory(options) as any });
    socket.on('connect', async (clientsock: Socket) => {
        socket.emit('testevent', 'asdf');
    });
    await readyPromise;
    client = ioclient.io(`http://localhost:${port}`, {autoConnect: true, transports: ['websocket']});
    const promise = new Promise((res, rej) => client.on('testevent', (value: string) => res(value)));
    await promise;
    const res = await promise;
    expect(res).toBe('asdf');
});

it('should forward a direct-to-sid message', async () => {
    const port = await getPort({});
    socket = new io.Server(port, { adapter: SqsSocketIoAdapterFactory(options) as any });
    socket.on('connect', async clientsock => {
        clientsock.emit('testevent', 'asdf');
    });
    await readyPromise;
    client = ioclient.io(`http://localhost:${port}`, {autoConnect: true, transports: ['websocket']});
    const promise = new Promise((res, rej) => client.on('testevent', (value: string) => res(value)));
    const res = await promise;
    expect(res).toBe('asdf');
});

// todo: this needs to be implemented
// it('should forward a binary message', async () => {
//     const port = await getPort({});
//     socket = new io.Server(port, { adapter: SqsSocketIoAdapterFactory(options) as any });
//     const sourceArr = [1, 234, -19];
//     const payload = {
//         stringPart: 'asdf',
//         binaryPart: new Uint16Array(sourceArr)
//     };
//     socket.on('connect', async clientsock => {
//         socket.emit('testbinevent', payload);
//     });
//     await readyPromise;
//     client = ioclient.io(`http://localhost:${port}`, {autoConnect: true, transports: ['websocket']});
//     const promise = new Promise((res, rej) => client.on('testbinevent', (value: string) => res(value)));
//     const res = await promise;
//     expect(res).toEqual(payload);
// });