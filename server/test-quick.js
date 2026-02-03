const WebSocket = require('ws');

async function test() {
  const tables = await fetch('http://localhost:3000/api/tables').then(r => r.json());
  const tableId = tables.tables[0]?.id;
  console.log('Table:', tableId);

  const ws1 = new WebSocket('ws://localhost:3000');
  const ws2 = new WebSocket('ws://localhost:3000');

  let rakeTotal = 0;
  let handsPlayed = 0;

  ws1.on('open', () => {
    console.log('[Alfred] Connected');
    ws1.send(JSON.stringify({
      type: 'join', tableId, agentId: 'Alfred',
      agentPubkey: '4x4K6PPans54ijuFprLfdQ4ZbbMMQ7h1DorQviN348xB',
      humanPubkey: 'human1', buyIn: 100
    }));
  });

  ws2.on('open', () => {
    console.log('[Bot] Connected');
    ws2.send(JSON.stringify({
      type: 'join', tableId, agentId: 'Bot',
      agentPubkey: 'bot123', humanPubkey: 'human2', buyIn: 100
    }));
  });

  function handleMsg(name, ws, msg) {
    const d = JSON.parse(msg);
    if (d.type === 'state' && d.currentTurn === name) {
      const action = Math.random() < 0.7 ? 'call' : 'fold';
      ws.send(JSON.stringify({ type: 'action', action }));
    }
    if (d.type === 'action' || d.type === 'street_complete') {
      ws.send(JSON.stringify({ type: 'state' }));
    }
    if (d.type === 'pot_awarded') {
      handsPlayed++;
      rakeTotal += d.data.rake;
      console.log(`Hand ${handsPlayed}: Pot=${d.data.pot}, Rake=${d.data.rake}, Total Rake=${rakeTotal}`);
    }
    if (d.type === 'hand_started') {
      console.log(`--- Hand #${d.data.handNumber} ---`);
    }
  }

  ws1.on('message', (m) => handleMsg('Alfred', ws1, m));
  ws2.on('message', (m) => handleMsg('Bot', ws2, m));

  setTimeout(() => {
    console.log('\n=== RESULTS ===');
    console.log(`Hands played: ${handsPlayed}`);
    console.log(`Total rake collected: ${rakeTotal}`);
    console.log('Rake goes to: 4x4K6PPans54ijuFprLfdQ4ZbbMMQ7h1DorQviN348xB');
    ws1.close();
    ws2.close();
    process.exit(0);
  }, 20000);
}

test();
