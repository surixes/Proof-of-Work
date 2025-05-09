'use strict';
const CryptoJS = require("crypto-js");
const express = require("express");
const bodyParser = require('body-parser');
const WebSocket = require("ws");

const http_port = process.env.HTTP_PORT || 3001;
const p2p_port  = process.env.P2P_PORT  || 6001;
const initialPeers = process.env.PEERS
  ? process.env.PEERS.split(',')
  : [];

const DIFFICULTY = 4;

class Block {
  constructor(index, previousHash, timestamp, data, hash, nonce) {
    this.index        = index;
    this.previousHash = previousHash.toString();
    this.timestamp    = timestamp;
    this.data         = data;
    this.hash         = hash.toString();
    this.nonce        = nonce;
  }
}

class MatrixPow {
  static createMatrix(hash) {
    const size = Math.floor(Math.sqrt(hash.length));
    let m = [], idx = 0;
    for (let i = 0; i < size; i++) {
      m[i] = [];
      for (let j = 0; j < size; j++) {
        m[i][j] = hash.charCodeAt(idx++) % 2;
      }
    }
    return m;
  }

  static checkMatrixPattern(matrix, difficulty) {
    let main = 0, anti = 0, n = matrix.length;
    for (let i = 0; i < n; i++) {
      main += matrix[i][i];
      anti += matrix[i][n - 1 - i];
    }
    return main === anti && main >= difficulty;
  }
}

const getGenesisBlock = () => new Block(
  0,
  "0",
  1682839690,
  "RUT-MIIT first block",
  "8d9d5a7ff4a78042ea6737bf59c772f8ed27ef3c9b576eac1976c91aaf48d2de",
  0
);

let blockchain = [getGenesisBlock()];
let sockets = [];

const calculateHash = (index, previousHash, timestamp, data, nonce) =>
  CryptoJS.SHA256(index + previousHash + timestamp + data + nonce).toString();

const getLatestBlock = () => blockchain[blockchain.length - 1];

const mineBlock = (data) => {
  const prev = getLatestBlock();
  const index = prev.index + 1;
  const previousHash = prev.hash;
  const timestamp = Math.round(Date.now() / 1000);
  const prefix = '0'.repeat(DIFFICULTY);

  let nonce = 0, hash, matrix;
  console.log(`Mining block #${index}…`);
  const start = Date.now();
  do {
    hash = calculateHash(index, previousHash, timestamp, data, nonce);
    matrix = MatrixPow.createMatrix(hash);
    nonce++;
  } while(
    !hash.startsWith(prefix) ||
    !MatrixPow.checkMatrixPattern(matrix, DIFFICULTY)
  );
  console.log(`Mined in ${(Date.now() - start)/1000}s (nonce=${nonce-1})`);
  return new Block(index, previousHash, timestamp, data, hash, nonce - 1);
};

const isValidNewBlock = (newB, prevB) => {
  if (prevB.index + 1 !== newB.index)         return false;
  if (prevB.hash !== newB.previousHash)        return false;
  if (calculateHashForBlock(newB) !== newB.hash) return false;
  const m = MatrixPow.createMatrix(newB.hash);
  if (!MatrixPow.checkMatrixPattern(m, DIFFICULTY)) return false;
  return true;
};

const addBlock = (b) => {
  if (isValidNewBlock(b, getLatestBlock())) blockchain.push(b);
};

const initHttpServer = () => {
  const app = express();
  app.use(bodyParser.json());

  app.get('/blocks',    (_, res) => res.json(blockchain));
  app.post('/mineBlock',(req, res) => {
    const b = mineBlock(req.body.data);
    addBlock(b);
    broadcastLatest();
    console.log('Added:', b);
    res.sendStatus(200);
  });
  app.get('/peers',     (_, res) => res.json(
    sockets.map(s => s._socket.remoteAddress + ':' + s._socket.remotePort)
  ));
  app.post('/addPeer',  (req, res) => {
    connectToPeers([req.body.peer]);
    res.sendStatus(200);
  });
  app.listen(http_port, () =>
    console.log('HTTP on port', http_port)
  );
};

const initP2PServer = () => {
  const server = new WebSocket.Server({ port: p2p_port });
  server.on('connection', initConnection);
  console.log('P2P on port', p2p_port);
};

const JSONResponse = (type, data) => JSON.stringify({ type, data });

const initConnection = (ws) => {
  sockets.push(ws);
  ws.on('message', msg => handleMessage(ws, JSON.parse(msg)));
  ws.on('close',  () => sockets = sockets.filter(s => s !== ws));
  ws.on('error',  () => sockets = sockets.filter(s => s !== ws));
  ws.send(JSONResponse(1));
};

const broadcast = msg => sockets.forEach(s => s.send(msg));
const broadcastLatest = () => broadcast(
  JSONResponse(2, JSON.stringify([getLatestBlock()]))
);

const connectToPeers = peers =>
  peers.forEach(url => {
    const ws = new WebSocket(url);
    ws.on('open', () => initConnection(ws));
    ws.on('error',() => console.log('Peer connect failed:', url));
  });

connectToPeers(initialPeers);
initHttpServer();
initP2PServer();
