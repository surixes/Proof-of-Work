'use strict';
var CryptoJS = require("crypto-js");
var express = require("express");
var bodyParser = require('body-parser');
var WebSocket = require("ws");
var http_port = process.env.HTTP_PORT || 3001;
var p2p_port = process.env.P2P_PORT || 6001;
var initialPeers = process.env.PEERS ? process.env.PEERS.split(',') : [];
var difficulty = 4;

class Block {
  constructor(index, previousHash, timestamp, data, hash, difficulty, nonce) {
    this.index = index;
    this.previousHash = previousHash.toString();
    this.timestamp = timestamp;
    this.data = data;
    this.hash = hash.toString();
    this.difficulty = difficulty;
    this.nonce = nonce;
  }
}

class MatrixPow {
  static createMatrix(hash) {
    const size = Math.floor(Math.sqrt(hash.length));
    let m = [], idx = 0;
    //console.log('Размер матрицы:', size);  // Логируем размер матрицы
    for (let i = 0; i < size; i++) {
        m[i] = [];
        for (let j = 0; j < size; j++) {
            const charCode = hash.charCodeAt(idx++);
            const value = charCode % 2;
            //console.log(`Индекс: ${idx-1}, Символ: '${hash[idx-1]}', Код: ${charCode}, Значение: ${value}`);
            m[i][j] = value;
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

function displayMatrix(matrix) {
  const table = document.getElementById("matrix");
  table.innerHTML = "";
  matrix.forEach(row => {
      const tr = document.createElement("tr");
      row.forEach(cell => {
          const td = document.createElement("td");
          td.textContent = cell;
          tr.appendChild(td);
      });
      table.appendChild(tr);
  });
}

function checkDiagonals(matrix) {
  let mainDiagonalSum = 0;
  let secondaryDiagonalSum = 0;
  const size = matrix.length;

  for (let i = 0; i < size; i++) {
      mainDiagonalSum += matrix[i][i];
      secondaryDiagonalSum += matrix[i][size - i - 1];
  }

  return { mainDiagonalSum, secondaryDiagonalSum };
}

function checkHash(hash, targetMatrix) {
  const matrix = createMatrix(hash);
  console.log(`Проверка хеша: '${hash}'`);

  console.log("Преобразование символов в матрицу:");
  let idx = 0;
  for (let i = 0; i < matrix.length; i++) {
      let row = '';
      for (let j = 0; j < matrix[i].length; j++) {
          const charCode = hash.charCodeAt(idx++);
          const value = charCode % 2;
          row += `$({String.fromCharCode(charCode)} (${charCode} -> ${value})` ;
      }
      console.log(`Строка ${i + 1}: ${row}`);
  }

  console.log("Полученная матрица:");
  displayMatrix(matrix);

  const { mainDiagonalSum, secondaryDiagonalSum } = checkDiagonals(matrix);
  console.log(`Сумма главной диагонали: ${mainDiagonalSum}`);
  console.log(`Сумма побочной диагонали: ${secondaryDiagonalSum}`);

  const isMatch = JSON.stringify(matrix) === JSON.stringify(targetMatrix);
  if (isMatch) {
    console.log(`Найден подходящий хеш: '${hash}'`);
      return true;
  } else {
    console.log(`Хеш '${hash}' не подходит.`);
      return false;
  }
}

var sockets = [];
var MessageType = {
  QUERY_LATEST: 0,
  QUERY_ALL: 1,
  RESPONSE_BLOCKCHAIN: 2
};

var getGenesisBlock = () => {
  return new Block(0, "0", 1682839690, "RUT-MIIT first block", "8d9d5a7ff4a78042ea6737bf59c772f8ed27ef3c9b576eac1976c91aaf48d2de", 0, 0);
};

var blockchain = [getGenesisBlock()];

var initHttpServer = () => {
  var app = express();
  app.use(bodyParser.json());
  app.get('/blocks', (req, res) => res.send(JSON.stringify(blockchain)));
  app.post('/mineBlock', (req, res) => {
    // var newBlock = generateNextBlock(req.body.data);
    var newBlock = mineBlock(req.body.data);
    addBlock(newBlock);
    broadcast(responseLatestMsg());
    //console.log(`block added: Nonce: ${newBlock.nonce} Index: ${newBlock.index} Hash: ${newBlock.hash} `);
    console.log('block added: ' + JSON.stringify(newBlock));
    res.send();
  });
  app.get('/peers', (req, res) => {
    res.send(sockets.map(s => s._socket.remoteAddress + ':' + s._socket.remotePort));
  });
  app.post('/addPeer', (req, res) => {
    connectToPeers([req.body.peer]);
    res.send();
  });
  app.listen(http_port, () => console.log('Listening http on port: ' + http_port));
};

var mineBlock = (blockData) => {
  var previousBlock = getLatestBlock();
  var nextIndex = previousBlock.index + 1;
  var nonce = 0;
  var nextTimestamp = new Date().getTime() / 1000;
  var nextHash = calculateHash(nextIndex, previousBlock.hash, nextTimestamp, blockData, nonce);
  var matrix;

  console.log(`Start mining block with index: ${nextIndex}`);

  while (nextHash.substring(0, difficulty) !== Array(difficulty + 1).join("0") || 
         !MatrixPow.checkMatrixPattern(MatrixPow.createMatrix(nextHash), difficulty)) {
    nonce++;
    nextTimestamp = new Date().getTime() / 1000;
    nextHash = calculateHash(nextIndex, previousBlock.hash, nextTimestamp, blockData, nonce);
    matrix = MatrixPow.createMatrix(nextHash);
    console.log(`Trying nonce=${nonce} with hash: ${nextHash}`);
  }

  console.log(`Mined block with index: ${nextIndex}, nonce=${nonce} and hash: ${nextHash}`);
  checkHash(nextHash, MatrixPow.createMatrix(nextHash));

  return new Block(nextIndex, previousBlock.hash, nextTimestamp, blockData, nextHash, difficulty, nonce);
}
  
var initP2PServer = () => {
  var server = new WebSocket.Server({port: p2p_port});
  server.on('connection', ws => initConnection(ws));
  console.log('listening websocket p2p port on: ' + p2p_port);
};
  
var initConnection = (ws) => {
  sockets.push(ws);
  initMessageHandler(ws);
  initErrorHandler(ws);
  write(ws, queryChainLengthMsg());
};
  
var initMessageHandler = (ws) => {
  ws.on('message', (data) => {
    var message = JSON.parse(data);
    console.log('Received message' + JSON.stringify(message));
    switch (message.type) {
      case MessageType.QUERY_LATEST:
        write(ws, responseLatestMsg());
        break;
      case MessageType.QUERY_ALL:
        write(ws, responseChainMsg());
        break;
      case MessageType.RESPONSE_BLOCKCHAIN:
        handleBlockchainResponse(message);
        break;
    }
  });
};

var initErrorHandler = (ws) => {
  var closeConnection = (ws) => {
    console.log('connection failed to peer: ' + ws.url);
    sockets.splice(sockets.indexOf(ws), 1);
  };
  ws.on('close', () => closeConnection(ws));
  ws.on('error', () => closeConnection(ws));
};
  
var connectToPeers = (newPeers) => {
    newPeers.forEach((peer) => {
      var ws = new WebSocket(peer);
      ws.on('open', () => initConnection(ws));
      ws.on('error', () => {
        console.log('connection failed')
      });
    });
};
  
var handleBlockchainResponse = (message) => {
  var receivedBlocks = JSON.parse(message.data).sort((b1, b2) => (b1.index - b2.index));
  var latestBlockReceived = receivedBlocks[receivedBlocks.length - 1];
  var latestBlockHeld = getLatestBlock();
  if (latestBlockReceived.index > latestBlockHeld.index) {
    console.log('blockchain possibly behind. We got: ' + latestBlockHeld.index + ' Peer got: ' + latestBlockReceived.index);
    if (latestBlockHeld.hash === latestBlockReceived.previousHash) {
      console.log("We can append the received block to our chain");
      blockchain.push(latestBlockReceived);
      broadcast(responseLatestMsg());
    } else if (receivedBlocks.length === 1) {
      console.log("We have to query the chain from our peer");
      broadcast(queryAllMsg());
    } else {
      console.log("Received blockchain is longer than current blockchain");
      replaceChain(receivedBlocks);
    }
  } else {
    console.log('received blockchain is not longer than current blockchain. Do nothing');
  }
};

var calculateHashForBlock = (block) => {
  return calculateHash(block.index, block.previousHash, block.timestamp, block.data, block.nonce);
};
  
var calculateHash = (index, previousHash, timestamp, data, nonce) => {
  return CryptoJS.SHA256(index + previousHash + timestamp + data + nonce).toString();
};

var addBlock = (newBlock) => {
  if (isValidNewBlock(newBlock, getLatestBlock())) {
    blockchain.push(newBlock);
  }
};

var isValidNewBlock = (newBlock, previousBlock) => {
  if (previousBlock.index + 1 !== newBlock.index) {
    console.log('invalid index');
    return false;
  } else if (previousBlock.hash !== newBlock.previousHash) {
    console.log('invalid previoushash');
    return false;
  } else if (calculateHashForBlock(newBlock) !== newBlock.hash) {
    console.log(typeof (newBlock.hash) + ' ' + typeof calculateHashForBlock(newBlock));
    console.log('invalid hash: ' + calculateHashForBlock(newBlock) + ' ' + newBlock.hash);
    return false;
  }

  const matrix = MatrixPow.createMatrix(newBlock.hash);
  if (!MatrixPow.checkMatrixPattern(matrix, newBlock.difficulty)) {
    console.log('invalid matrix pattern');
    return false;
  }

  return true;
};
  
var replaceChain = (newBlocks) => {
  if (isValidChain(newBlocks) && newBlocks.length > blockchain.length) {
    console.log('Received blockchain is valid. Replacing current blockchain with received blockchain');
    blockchain = newBlocks;
    broadcast(responseLatestMsg());
  } else {
    console.log('Received blockchain invalid');
  }
};

var isValidChain = (blockchainToValidate) => {
  if (JSON.stringify(blockchainToValidate[0]) !== JSON.stringify(getGenesisBlock())) {
    return false;
  }
  var tempBlocks = [blockchainToValidate[0]];
  for (var i = 1; i < blockchainToValidate.length; i++) {
    if (isValidNewBlock(blockchainToValidate[i], tempBlocks[i - 1])) {
      tempBlocks.push(blockchainToValidate[i]);
    } else {
      return false;
    }
  }
  return true;
};

var getLatestBlock = () => blockchain[blockchain.length - 1];
var queryChainLengthMsg = () => ({'type': MessageType.QUERY_LATEST});
var queryAllMsg = () => ({'type': MessageType.QUERY_ALL});
var responseChainMsg = () =>({
  'type': MessageType.RESPONSE_BLOCKCHAIN, 'data': JSON.stringify(blockchain)
});
var responseLatestMsg = () => ({
  'type': MessageType.RESPONSE_BLOCKCHAIN,
  'data': JSON.stringify([getLatestBlock()])
});

var write = (ws, message) => ws.send(JSON.stringify(message));
var broadcast = (message) => sockets.forEach(socket => write(socket, message));

connectToPeers(initialPeers);
initHttpServer();
initP2PServer();