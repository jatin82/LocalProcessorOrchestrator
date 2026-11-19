const { createServer } = require('node:http');

const server = createServer((req, res) => {
  console.log(`${req.method} ${req.url}`);
  res.writeHead(200, { 'Content-Type': 'text/plain' }).end('Hello from Orchestrator!\n');
});
server.listen(0, '127.0.0.1', () => {
  console.log(`Example server listening at http://127.0.0.1:${server.address().port}`);
});
