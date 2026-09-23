const http = require('http');
const crypto = require('crypto');
const url = require('url');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('DATABASE_URL is not set!');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
}

function send(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(data));
}

function sendHtml(res, filePath) {
  try {
    const html = fs.readFileSync(filePath, 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache'
    });
    res.end(html);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('index.html not found on server');
  }
}

function parseBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', c => { data += c; });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
    });
  });
}

async function getPlayer(playerId) {
  const r = await pool.query('SELECT * FROM players WHERE player_id = $1', [playerId]);
  if (r.rows.length > 0) return r.rows[0];
  await pool.query(
    'INSERT INTO players (player_id, name, has_created_clan, created_at) VALUES ($1, $2, FALSE, $3)',
    [playerId, 'Игрок', Date.now()]
  );
  const r2 = await pool.query('SELECT * FROM players WHERE player_id = $1', [playerId]);
  return r2.rows[0];
}

async function getClanFull(clanId) {
  const r = await pool.query('SELECT * FROM clans WHERE id = $1', [clanId]);
  if (r.rows.length === 0) return null;
  const clan = r.rows[0];
  const m = await pool.query('SELECT player_id FROM clan_members WHERE clan_id = $1', [clanId]);
  clan.members = m.rows.map(x => x.player_id);
  return clan;
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

  // === Отдаём index.html на главной ===
  if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    return sendHtml(res, path.join(__dirname, 'index.html'));
  }

  // favicon — заглушка
  if (method === 'GET' && pathname === '/favicon.ico') {
    res.writeHead(204);
    return res.end();
  }

  try {
    if (method === 'GET' && pathname === '/api') {
      return send(res, 200, { ok: true, service: 'Fan Clicker Clans API', version: '3.0-ws-members' });
    }

    if (method === 'POST' && pathname === '/api/player') {
      const body = await parseBody(req);
      const { playerId, name } = body;
      if (!playerId) return send(res, 400, { error: 'playerId required' });

      const player = await getPlayer(playerId);
      if (name && name.trim()) {
        await pool.query('UPDATE players SET name = $1 WHERE player_id = $2', [name.trim().slice(0, 24), playerId]);
        player.name = name.trim().slice(0, 24);
      }

      let clan = null;
      if (player.clan_id) {
        const c = await getClanFull(player.clan_id);
        if (c) clan = {
          id: c.id,
          name: c.name,
          leaderId: c.leader_id,
          memberCount: c.members.length,
          clanFanLevel: c.clan_fan_level || 1,
          clanPoints: c.clan_points || 0,
          isLeader: c.leader_id === playerId
        };
      }

      return send(res, 200, {
        player: {
          id: player.player_id,
          name: player.name,
          clanId: player.clan_id,
          hasCreatedClan: player.has_created_clan,
          clanPoints: clan ? clan.clanPoints : 0
        },
        clan
      });
    }

    if (method === 'GET' && pathname === '/api/clans') {
      const r = await pool.query(`
        SELECT c.id, c.name, c.leader_id, c.clan_fan_level, c.clan_points, c.created_at,
               (SELECT COUNT(*) FROM clan_members WHERE clan_id = c.id) AS member_count
        FROM clans c
        ORDER BY member_count DESC, c.created_at ASC
      `);
      const list = r.rows.map(c => ({
        id: c.id,
        name: c.name,
        leaderId: c.leader_id,
        memberCount: parseInt(c.member_count),
        clanFanLevel: c.clan_fan_level || 1,
        clanPoints: c.clan_points || 0,
        createdAt: c.created_at
      }));
      return send(res, 200, { clans: list });
    }

    const membersMatch = pathname.match(/^\/api\/clans\/([^/]+)\/members$/);
    if (method === 'GET' && membersMatch) {
      const clanId = membersMatch[1];

      const clan = await getClanFull(clanId);
      if (!clan) return send(res, 404, { error: 'Клан не найден' });

      const r = await pool.query(
        `SELECT p.player_id, p.name, c.leader_id
         FROM clan_members cm
         JOIN players p ON p.player_id = cm.player_id
         JOIN clans c ON c.id = cm.clan_id
         WHERE cm.clan_id = $1
         ORDER BY (p.player_id = c.leader_id) DESC, p.name ASC`,
        [clanId]
      );

      return send(res, 200, {
        clan: {
          id: clan.id,
          name: clan.name,
          memberCount: clan.members.length,
          clanFanLevel: clan.clan_fan_level || 1,
          clanPoints: clan.clan_points || 0
        },
        members: r.rows.map(m => ({
          playerId: m.player_id,
          name: m.name || 'Игрок',
          isLeader: m.player_id === m.leader_id
        }))
      });
    }

    if (method === 'POST' && pathname === '/api/clans') {
      const body = await parseBody(req);
      const { playerId, name } = body;
      if (!playerId || !name) return send(res, 400, { error: 'playerId and name required' });

      const player = await getPlayer(playerId);
      if (player.has_created_clan) return send(res, 400, { error: 'Вы уже создавали клан' });
      if (player.clan_id) return send(res, 400, { error: 'Вы уже состоите в клане' });

      const cleanName = name.trim().slice(0, 16);
      if (cleanName.length < 2) return send(res, 400, { error: 'Название слишком короткое' });

      const exists = await pool.query('SELECT 1 FROM clans WHERE LOWER(name) = LOWER($1)', [cleanName]);
      if (exists.rows.length > 0) return send(res, 400, { error: 'Клан с таким названием уже есть' });

      const clanId = uid();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          'INSERT INTO clans (id, name, leader_id, clan_fan_level, clan_points, created_at) VALUES ($1, $2, $3, 1, 0, $4)',
          [clanId, cleanName, playerId, Date.now()]
        );
        await client.query(
          'INSERT INTO clan_members (clan_id, player_id) VALUES ($1, $2)',
          [clanId, playerId]
        );
        await client.query(
          'UPDATE players SET clan_id = $1, has_created_clan = TRUE WHERE player_id = $2',
          [clanId, playerId]
        );
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }

      return send(res, 200, {
        ok: true,
        clan: { id: clanId, name: cleanName, leaderId: playerId, memberCount: 1, clanFanLevel: 1, clanPoints: 0, isLeader: true }
      });
    }

    const applyMatch = pathname.match(/^\/api\/clans\/([^/]+)\/apply$/);
    if (method === 'POST' && applyMatch) {
      const clanId = applyMatch[1];
      const body = await parseBody(req);
      const { playerId } = body;
      if (!playerId) return send(res, 400, { error: 'playerId required' });

      const player = await getPlayer(playerId);
      if (player.clan_id) return send(res, 400, { error: 'Вы уже в клане' });

      const clan = await getClanFull(clanId);
      if (!clan) return send(res, 404, { error: 'Клан не найден' });

      const ex = await pool.query(
        'SELECT 1 FROM applications WHERE clan_id = $1 AND player_id = $2 AND status = $3',
        [clanId, playerId, 'pending']
      );
      if (ex.rows.length > 0) return send(res, 400, { error: 'Заявка уже отправлена' });

      const appId = uid();
      await pool.query(
        'INSERT INTO applications (id, clan_id, player_id, player_name, status, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
        [appId, clanId, playerId, player.name, 'pending', Date.now()]
      );

      notifyClan(clanId, { type: 'newApplication', playerName: player.name });

      return send(res, 200, { ok: true, message: 'Заявка отправлена', applicationId: appId });
    }

    const appsMatch = pathname.match(/^\/api\/clans\/([^/]+)\/applications$/);
    if (method === 'GET' && appsMatch) {
      const clanId = appsMatch[1];
      const playerId = parsed.query.playerId;
      if (!playerId) return send(res, 400, { error: 'playerId required' });

      const clan = await getClanFull(clanId);
      if (!clan) return send(res, 404, { error: 'Клан не найден' });
      if (clan.leader_id !== playerId) return send(res, 403, { error: 'Только лидер' });

      const r = await pool.query(
        'SELECT id, player_id, player_name, created_at FROM applications WHERE clan_id = $1 AND status = $2',
        [clanId, 'pending']
      );
      return send(res, 200, {
        applications: r.rows.map(a => ({
          id: a.id,
          playerId: a.player_id,
          playerName: a.player_name,
          createdAt: a.created_at
        }))
      });
    }

    const actionMatch = pathname.match(/^\/api\/applications\/([^/]+)\/(accept|reject)$/);
    if (method === 'POST' && actionMatch) {
      const appId = actionMatch[1];
      const action = actionMatch[2];
      const body = await parseBody(req);
      const { playerId } = body;
      if (!playerId) return send(res, 400, { error: 'playerId required' });

      const ar = await pool.query('SELECT * FROM applications WHERE id = $1', [appId]);
      if (ar.rows.length === 0 || ar.rows[0].status !== 'pending') {
        return send(res, 404, { error: 'Заявка не найдена' });
      }
      const application = ar.rows[0];

      const clan = await getClanFull(application.clan_id);
      if (!clan) return send(res, 404, { error: 'Клан не найден' });
      if (clan.leader_id !== playerId) return send(res, 403, { error: 'Только лидер' });

      if (action === 'reject') {
        await pool.query('UPDATE applications SET status = $1 WHERE id = $2', ['rejected', appId]);
        return send(res, 200, { ok: true, message: 'Заявка отклонена' });
      }

      const tr = await pool.query('SELECT * FROM players WHERE player_id = $1', [application.player_id]);
      if (tr.rows.length === 0) return send(res, 400, { error: 'Игрок не найден' });
      const target = tr.rows[0];
      if (target.clan_id) {
        await pool.query('UPDATE applications SET status = $1 WHERE id = $2', ['rejected', appId]);
        return send(res, 400, { error: 'Игрок уже в другом клане' });
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('UPDATE players SET clan_id = $1 WHERE player_id = $2', [clan.id, application.player_id]);
        await client.query(
          'INSERT INTO clan_members (clan_id, player_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [clan.id, application.player_id]
        );
        await client.query('UPDATE applications SET status = $1 WHERE id = $2', ['accepted', appId]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }

      const cnt = await pool.query('SELECT COUNT(*) FROM clan_members WHERE clan_id = $1', [clan.id]);

      notifyClan(clan.id, { type: 'memberUpdate', memberCount: parseInt(cnt.rows[0].count) });

      return send(res, 200, {
        ok: true,
        message: 'Игрок принят',
        clan: { id: clan.id, name: clan.name, memberCount: parseInt(cnt.rows[0].count) }
      });
    }

    if (method === 'POST' && pathname === '/api/clans/leave') {
      const body = await parseBody(req);
      const { playerId } = body;
      if (!playerId) return send(res, 400, { error: 'playerId required' });

      const player = await getPlayer(playerId);
      if (!player.clan_id) return send(res, 400, { error: 'Вы не в клане' });

      const clan = await getClanFull(player.clan_id);
      if (clan) {
        await pool.query('DELETE FROM clan_members WHERE clan_id = $1 AND player_id = $2', [clan.id, playerId]);
        const remaining = await pool.query('SELECT player_id FROM clan_members WHERE clan_id = $1', [clan.id]);
        if (clan.leader_id === playerId) {
          if (remaining.rows.length > 0) {
            await pool.query('UPDATE clans SET leader_id = $1 WHERE id = $2', [remaining.rows[0].player_id, clan.id]);
          } else {
            await pool.query('DELETE FROM clans WHERE id = $1', [clan.id]);
          }
        }
        notifyClan(clan.id, { type: 'memberUpdate', memberCount: remaining.rows.length });
      }
      await pool.query('UPDATE players SET clan_id = NULL WHERE player_id = $1', [playerId]);
      return send(res, 200, { ok: true, message: 'Вы покинули клан' });
    }

    const tapMatch = pathname.match(/^\/api\/clans\/([^/]+)\/tap-fan$/);
    if (method === 'POST' && tapMatch) {
      const clanId = tapMatch[1];
      const body = await parseBody(req);
      const { playerId, amount } = body;
      if (!playerId) return send(res, 400, { error: 'playerId required' });

      const clan = await getClanFull(clanId);
      if (!clan) return send(res, 404, { error: 'Клан не найден' });
      if (!clan.members.includes(playerId)) return send(res, 403, { error: 'Вы не в этом клане' });

      const add = Math.max(1, Math.min(1000000, parseInt(amount) || 1));
      await pool.query('UPDATE clans SET clan_points = clan_points + $1 WHERE id = $2', [add, clanId]);

      const r = await pool.query('SELECT clan_points FROM clans WHERE id = $1', [clanId]);
      const newPoints = r.rows[0].clan_points;

      notifyClan(clanId, { type: 'clanPoints', points: newPoints });

      return send(res, 200, { ok: true, clanPoints: newPoints });
    }

    const upMatch = pathname.match(/^\/api\/clans\/([^/]+)\/upgrade-fan$/);
    if (method === 'POST' && upMatch) {
      const clanId = upMatch[1];
      const body = await parseBody(req);
      const { playerId } = body;
      if (!playerId) return send(res, 400, { error: 'playerId required' });

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const r = await client.query('SELECT * FROM clans WHERE id = $1 FOR UPDATE', [clanId]);
        if (r.rows.length === 0) {
          await client.query('ROLLBACK');
          return send(res, 404, { error: 'Клан не найден' });
        }
        const clan = r.rows[0];
        if (clan.leader_id !== playerId) {
          await client.query('ROLLBACK');
          return send(res, 403, { error: 'Только лидер' });
        }

        const cost = Math.floor(500 * Math.pow(1.55, clan.clan_fan_level || 1));
        if ((clan.clan_points || 0) < cost) {
          await client.query('ROLLBACK');
          return send(res, 400, { error: 'Нужно ' + cost + ' клановых ветров' });
        }

        const newLevel = (clan.clan_fan_level || 1) + 1;
        const newPoints = (clan.clan_points || 0) - cost;
        await client.query(
          'UPDATE clans SET clan_fan_level = $1, clan_points = $2 WHERE id = $3',
          [newLevel, newPoints, clanId]
        );
        await client.query('COMMIT');

        notifyClan(clanId, { type: 'clanFanLevel', level: newLevel });
        notifyClan(clanId, { type: 'clanPoints', points: newPoints });

        return send(res, 200, { ok: true, clanFanLevel: newLevel, clanPoints: newPoints });
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    }

    send(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error(err);
    send(res, 500, { error: 'Server error: ' + err.message });
  }
});

const wss = new WebSocket.Server({ server });

const clanSockets = new Map();

wss.on('connection', (ws, req) => {
  try {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const clanId = params.get('clanId');
    const playerId = params.get('playerId');

    if (!clanId || !playerId) {
      ws.close();
      return;
    }

    if (!clanSockets.has(clanId)) clanSockets.set(clanId, new Set());
    clanSockets.get(clanId).add(ws);

    ws.clanId = clanId;
    ws.playerId = playerId;

    ws.on('close', () => {
      const set = clanSockets.get(clanId);
      if (set) {
        set.delete(ws);
        if (set.size === 0) clanSockets.delete(clanId);
      }
    });

    ws.on('error', () => {});
  } catch (e) {
    ws.close();
  }
});

function notifyClan(clanId, message) {
  const set = clanSockets.get(clanId);
  if (!set || set.size === 0) return;
  const payload = JSON.stringify(message);
  for (const ws of set) {
    if (ws.readyState === 1) {
      try { ws.send(payload); } catch (e) {}
    }
  }
}

server.listen(PORT, () => {
  console.log('Fan Clicker Clans API + Web (Neon + WS + Members) → http://localhost:' + PORT);
});
