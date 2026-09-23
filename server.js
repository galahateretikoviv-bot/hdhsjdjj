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
      const { playerId } = body;
      if (!playerId) return send(res, 400, { error: 'playerId required' });

      const player = getPlayer(playerId);
      const clan = getClan(clanId);
      if (!clan) return send(res, 404, { error: 'Клан не найден' });
      if (player.clanId) return send(res, 400, { error: 'Вы уже в клане' });

      const existing = Object.values(db.applications).find(
        a => a.clanId === clanId && a.playerId === playerId && a.status === 'pending'
      );
      if (existing) return send(res, 400, { error: 'Заявка уже отправлена' });

      const appId = uid();
      db.applications[appId] = {
        id: appId,
        clanId,
        playerId,
        playerName: player.name,
        status: 'pending',
        createdAt: Date.now()
      };
      saveDB(db);
      return send(res, 200, { ok: true, message: 'Заявка отправлена', applicationId: appId });
    }

    const appsMatch = pathname.match(/^\/api\/clans\/([^/]+)\/applications$/);
    if (method === 'GET' && appsMatch) {
      const clanId = appsMatch[1];
      const playerId = parsed.query.playerId;
      if (!playerId) return send(res, 400, { error: 'playerId required' });

      const clan = getClan(clanId);
      if (!clan) return send(res, 404, { error: 'Клан не найден' });
      if (clan.leaderId !== playerId) return send(res, 403, { error: 'Только лидер' });

      const apps = Object.values(db.applications)
        .filter(a => a.clanId === clanId && a.status === 'pending')
        .map(a => ({
          id: a.id,
          playerId: a.playerId,
          playerName: a.playerName,
          createdAt: a.createdAt
        }));
      return send(res, 200, { applications: apps });
    }

    const actionMatch = pathname.match(/^\/api\/applications\/([^/]+)\/(accept|reject)$/);
    if (method === 'POST' && actionMatch) {
      const appId = actionMatch[1];
      const action = actionMatch[2];
      const body = await parseBody(req);
      const { playerId } = body;
      if (!playerId) return send(res, 400, { error: 'playerId required' });

      const application = db.applications[appId];
      if (!application || application.status !== 'pending') {
        return send(res, 404, { error: 'Заявка не найдена' });
      }

      const clan = getClan(application.clanId);
      if (!clan) return send(res, 404, { error: 'Клан не найден' });
      if (clan.leaderId !== playerId) return send(res, 403, { error: 'Только лидер' });

      if (action === 'reject') {
        application.status = 'rejected';
        saveDB(db);
        return send(res, 200, { ok: true, message: 'Заявка отклонена' });
      }

      const target = getPlayer(application.playerId);
      if (target.clanId) {
        application.status = 'rejected';
        saveDB(db);
        return send(res, 400, { error: 'Игрок уже в другом клане' });
      }

      target.clanId = clan.id;
      if (!clan.members.includes(application.playerId)) {
        clan.members.push(application.playerId);
      }
      application.status = 'accepted';
      saveDB(db);

      return send(res, 200, {
        ok: true,
        message: 'Игрок принят',
        clan: { id: clan.id, name: clan.name, memberCount: clan.members.length }
      });
    }

    if (method === 'POST' && pathname === '/api/clans/leave') {
      const body = await parseBody(req);
      const { playerId } = body;
      if (!playerId) return send(res, 400, { error: 'playerId required' });

      const player = getPlayer(playerId);
      if (!player.clanId) return send(res, 400, { error: 'Вы не в клане' });

      const clan = getClan(player.clanId);
      if (clan) {
        clan.members = clan.members.filter(id => id !== playerId);
        if (clan.leaderId === playerId) {
          if (clan.members.length > 0) {
            clan.leaderId = clan.members[0];
          } else {
            delete db.clans[clan.id];
          }
        }
      }
      player.clanId = null;
      saveDB(db);
      return send(res, 200, { ok: true, message: 'Вы покинули клан' });
    }

    const upMatch = pathname.match(/^\/api\/clans\/([^/]+)\/upgrade-fan$/);
    if (method === 'POST' && upMatch) {
      const clanId = upMatch[1];
      const body = await parseBody(req);
      const { playerId } = body;
      if (!playerId) return send(res, 400, { error: 'playerId required' });

      const clan = getClan(clanId);
      if (!clan) return send(res, 404, { error: 'Клан не найден' });
      if (clan.leaderId !== playerId) return send(res, 403, { error: 'Только лидер' });

      clan.clanFanLevel = (clan.clanFanLevel || 1) + 1;
      saveDB(db);
      return send(res, 200, { ok: true, clanFanLevel: clan.clanFanLevel });
    }

    send(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error(err);
    send(res, 500, { error: 'Server error' });
  }
});

server.listen(PORT, () => {
  console.log('Fan Clicker Clans API → http://localhost:' + PORT);
});
