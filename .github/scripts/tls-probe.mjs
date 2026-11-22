import https from 'node:https'
const host = process.argv[2]
for (const curve of ['X25519MLKEM768:X25519', 'X25519']) {
  const t = Date.now()
  await new Promise((done) => {
    const req = https.request({ host, path: '/mcp', method: 'POST', ecdhCurve: curve, timeout: 15000, headers: { 'content-type': 'application/json' } }, (res) => {
      res.resume(); res.on('end', () => { console.log(curve, res.statusCode, res.socket?.getProtocol?.(), Date.now() - t, 'ms'); done() })
    })
    req.on('timeout', () => { console.log(curve, 'TIMEOUT', Date.now() - t); req.destroy(); done() })
    req.on('error', (e) => { console.log(curve, 'ERR', e.code ?? e.message, Date.now() - t); done() })
    req.end('{}')
  })
}
