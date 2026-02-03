const WebSocket = require('ws');

const SERVER = 'ws://localhost:3000';

class TestAgent {
  constructor(name, tableId) {
    this.name = name;
    this.tableId = tableId;
    this.ws = null;
    this.myTurn = false;
    this.rakeCollected = 0;
  }

  connect() {
    return new Promise((resolve) => {
      this.ws = new WebSocket(SERVER);
      
      this.ws.on('open', () => {
        console.log(`[${this.name}] Connected`);
        this.ws.send(JSON.stringify({
          type: 'join',
          tableId: this.tableId,
          agentId: this.name,
          agentPubkey: 'test' + this.name,
          humanPubkey: 'test' + this.name,
          buyIn: 100
        }));
        resolve();
      });

      this.ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        this.handleMessage(msg);
      });
    });
  }

  handleMessage(msg) {
    switch(msg.type) {
      case 'joined':
        console.log(`[${this.name}] Joined table`);
        break;
      case 'hand_started':
        console.log(`[${this.name}] Hand #${msg.data.handNumber} started`);
        break;
      case 'cards_dealt':
        if (msg.data.agentId === this.name) {
          console.log(`[${this.name}] Got cards: ${msg.data.holeCards.join(' ')}`);
        }
        break;
      case 'state':
        if (msg.currentTurn === this.name) {
          this.act();
        }
        break;
      case 'action':
        if (msg.data.agentId !== this.name) {
          console.log(`[${this.name}] ${msg.data.agentId} did ${msg.data.action}`);
        }
        // Check if it's my turn after their action
        setTimeout(() => {
          this.ws.send(JSON.stringify({ type: 'state' }));
        }, 100);
        break;
      case 'pot_awarded':
        console.log(`[${this.name}] 🏆 Pot: ${msg.data.pot}, Rake: ${msg.data.rake}`);
        this.rakeCollected += msg.data.rake;
        console.log(`[${this.name}] Total rake collected: ${this.rakeCollected}`);
        break;
      case 'street_complete':
        console.log(`[${this.name}] ${msg.data.street}: ${msg.data.communityCards.join(' ')}`);
        setTimeout(() => {
          this.ws.send(JSON.stringify({ type: 'state' }));
        }, 100);
        break;
    }
  }

  act() {
    const actions = ['call', 'raise', 'check'];
    const action = actions[Math.floor(Math.random() * actions.length)];
    let amount;
    if (action === 'raise') amount = 10;
    
    console.log(`[${this.name}] Action: ${action}${amount ? ' ' + amount : ''}`);
    this.ws.send(JSON.stringify({ type: 'action', action, amount }));
  }
}

async function test() {
  // Get table ID
  const res = await fetch('http://localhost:3000/api/tables');
  const { tables } = await res.json();
  const tableId = tables[0]?.id;
  
  if (!tableId) {
    // Create table
    const createRes = await fetch('http://localhost:3000/api/tables', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ smallBlind: 1, bigBlind: 2, minBuyIn: 40, maxBuyIn: 200, maxPlayers: 6 })
    });
    const { tableId: newTableId } = await createRes.json();
    console.log('Created table:', newTableId);
    tableId = newTableId;
  }

  console.log('Using table:', tableId);

  const agent1 = new TestAgent('Alfred', tableId);
  const agent2 = new TestAgent('Opponent', tableId);

  await agent1.connect();
  await new Promise(r => setTimeout(r, 500));
  await agent2.connect();

  console.log('\n=== Battle started! Running for 30 seconds ===\n');
  
  setTimeout(() => {
    console.log('\n=== Test complete ===');
    console.log(`Total rake collected: ${agent1.rakeCollected + agent2.rakeCollected}`);
    process.exit(0);
  }, 30000);
}

test().catch(console.error);
