import {SqsSocketIoAdapter, SqsSocketIoAdapterOptions} from '.';
import sio from 'socket.io';
import sioclient from 'socket.io-client';
import { createServer } from 'http';

const options: SqsSocketIoAdapterOptions = {
    accountId: 'asdf',
    defaultSnsName: 'socket.io-test-',
    defaultSqsName: 'socket.io-test-01-',
    roomSnsNameOrPrefix: 'socket.io-test-',
    roomSqsNameOrPrefix: 'socket.io-test-01-',
    snsClient: {region: 'us-east-1'},
    sqsClient: {region: 'us-east-1'},
};

it('should forward a basic message', async () => {
    const server = createServer({});
    await new Promise(res => server.listen(12345, () => res()));
    const socket = sio({adapter: SqsSocketIoAdapter(options) as any});
    sio(server);
    const client = sioclient('http://localhost:12345', {autoConnect: true, transports: ['websocket']});
    const promise = new Promise((res, rej) => client.on('testevent', (value: string) => res(value)));
    socket.to('newroom').emit('testevent', 'asdf');
    await promise;
    server.close();
});