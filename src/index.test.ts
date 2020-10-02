import {SqsSocketIoAdapter, SqsSocketIoAdapterOptions} from '.';
import io from 'socket.io';
import ioclient from 'socket.io-client';
import { createServer } from 'http';
import { randomString } from './util';

const name = randomString();

const options: SqsSocketIoAdapterOptions = {
    accountId: '723207552760',
    defaultSnsName: 'socketio-test-',
    defaultSqsName: `socketio-test-${name}-`,
    roomSnsNameOrPrefix: 'socketio-test-',
    roomSqsNameOrPrefix: `socketio-test-${name}-`,
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
    socket.on('connect', clientsock => {
        // console.info('connection', clientsock);
        clientsock.join('newroom');
    });
    client = ioclient('http://localhost:12345', {autoConnect: true, transports: ['websocket']});
    const promise = new Promise((res, rej) => client.on('testevent', (value: string) => res(value)));
    socket.to('newroom').emit('testevent', 'asdf');
    await promise;
});