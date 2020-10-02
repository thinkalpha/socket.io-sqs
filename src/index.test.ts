/* eslint-disable no-console */

// eslint-disable-next-line @typescript-eslint/no-var-requires
require('source-map-support').install();

import {SqsSocketIoAdapter, SqsSocketIoAdapterOptions} from '.';
import io from 'socket.io';
import ioclient from 'socket.io-client';
import { createServer } from 'http';
import { randomString } from './util';

const testName = randomString();
const endpointName = randomString();

const options: SqsSocketIoAdapterOptions = {
    accountId: '723207552760',
    defaultSnsName: `socketio-test-${testName}-`,
    defaultSqsName: `socketio-test-${testName}-${endpointName}-`,
    roomSnsNameOrPrefix: `socketio-test-${testName}-`,
    roomSqsNameOrPrefix: `socketio-test-${testName}-${endpointName}-`,
    snsClient: {
        region: 'us-east-1', 
    },
    sqsClient: {region: 'us-east-1'},
    region: 'us-east-1'
};

let socket: io.Server;
let client: SocketIOClient.Socket;

afterEach(async () => {
    console.info('closing sockets');
    const closePromise = new Promise(res => socket?.close(res));
    await closePromise;
    // (socket as any)?.httpServer?.close();
    client?.close();
});

it('should forward a basic message', async () => {
    socket = io(12345, {adapter: SqsSocketIoAdapter(options) as any});
    socket.on('connect', async clientsock => {
        // console.info('connection', clientsock);
        await new Promise((res, rej) => clientsock.join('newroom', err => err ? rej(err) : res()));
        socket.to('newroom').emit('testevent', 'asdf');
    });
    client = ioclient('http://localhost:12345', {autoConnect: true, transports: ['websocket']});
    const promise = new Promise((res, rej) => client.on('testevent', (value: string) => res(value)));
    await promise;
});