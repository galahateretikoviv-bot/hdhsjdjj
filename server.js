const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const url = require('url');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'db.json');

function loadDB() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Load error', e.message);
  }
  return { clans: {}, players: {}, applications: {} };
}

function saveDB(db) {
  try {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
  } catch (e) {
    console.error('Save error', e.message);
  }
}

let db = loadDB();
if (!db.clans) db.clans = {};
if (!db.players) db.players = {};
if (!db.applications) db.applications = {};

function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
}

function getPlayer(playerId) {
  if (!db.players[playerId]) {
    db.players[playerId] = {
      id: playerId,
      name: 'Игрок',
      clanId: null,
      hasCreatedClan: false,
      createdAt: Date.now()
    };
    saveDB(db);
  }
  return db.players[playerId];
}

function getClan(clanId) {
  return db.clans[clanId] || null;
}

function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(body);
}

function parseBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const method = req.method;

  try {
    if (method === 'GET' && (pathname === '/' || pathname === '/api')) {
      return send(res, 200, { ok: true, service: 'Fan Clicker Clans API', version: '1.0' });
    }

    if (method === 'POST' && pathname === '/api/player') {
      const body = await parseBody(req);
      const { playerId, name } = body;
      if (!playerId) return send(res, 400, { error: 'playerId required' });

      const player = getPlayer(playerId);
      if (name && name.trim()) player.name = name.trim().slice(0, 24);
      saveDB(db);

      const clan = player.clanId ? getClan(player.clanId) : null;
      return send(res, 200, {
        player: {
          id: player.id,
          name: player.name,
          clanId: player.clanId,
          hasCreatedClan: player.hasCreatedClan
        },
        clan: clan ? {
          id: clan.id,
          name: clan.name,
          leaderId: clan.leaderId,
          memberCount: clan.members.length,
          clanFanLevel: clan.clanFanLevel || 1,
          isLeader: clan.leaderId === playerId
        } : null
      });
    }

    if (method === 'GET' && pathname === '/api/clans') {
      const list = Object.values(db.clans).map(c => ({
        id: c.id,
        name: c.name,
        leaderId: c.leaderId,
        memberCount: c.members.length,
        clanFanLevel: c.clanFanLevel || 1,
        createdAt: c.createdAt
      }));
      list.sort((a, b) => b.memberCount - a.memberCount);
      return send(res, 200, { clans: list });
    }

    if (method === 'POST' && pathname === '/api/clans') {
      const body = await parseBody(req);
      const { playerId, name } = body;
      if (!playerId || !name) return send(res, 400, { error: 'playerId and name required' });

      const player = getPlayer(playerId);
      if (player.hasCreatedClan) return send(res, 400, { error: 'Вы уже создавали клан' });
      if (player.clanId) return send(res, 400, { error: 'Вы уже состоите в клане' });

      const cleanName = name.trim().slice(0, 16);
      if (cleanName.length < 2) return send(res, 400, { error: 'Название слишком короткое' });

      const exists = Object.values(db.clans).some(c => c.name.toLowerCase() === cleanName.toLowerCase());
      if (exists) return send(res, 400, { error: 'Клан с таким названием уже есть' });

      const clanId = uid();
      const clan = {
        id: clanId,
        name: cleanName,
        leaderId: playerId,
        members: [playerId],
        clanFanLevel: 1,
        createdAt: Date.now()
      };
      db.clans[clanId] = clan;
      player.clanId = clanId;
      player.hasCreatedClan = true;
      saveDB(db);

      return send(res, 200, {
        ok: true,
        clan: {
          id: clan.id,
          name: clan.name,
          leaderId: clan.leaderId,
          memberCount: 1,
          clanFanLevel: 1,
          isLeader: true
        }
      });
    }

    const applyMatch = pathname.match(/^\/api\/clans\/([^/]+)\/apply$/);
    if (method === 'POST' && applyMatch) {
      const clanId = applyMatch[1];
      const body = await parseBody(req);
