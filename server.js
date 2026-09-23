CREATE TABLE IF NOT EXISTS players (
    player_id TEXT PRIMARY KEY,
    name TEXT DEFAULT 'Игрок',
    clan_id TEXT,
    has_created_clan BOOLEAN DEFAULT FALSE,
    created_at BIGINT
);

CREATE TABLE IF NOT EXISTS clans (
    id TEXT PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    leader_id TEXT NOT NULL,
    clan_fan_level INTEGER DEFAULT 1,
    clan_points INTEGER DEFAULT 0,
    created_at BIGINT
);

CREATE TABLE IF NOT EXISTS clan_members (
    clan_id TEXT REFERENCES clans(id) ON DELETE CASCADE,
    player_id TEXT REFERENCES players(player_id) ON DELETE CASCADE,
    PRIMARY KEY (clan_id, player_id)
);

CREATE TABLE IF NOT EXISTS applications (
    id TEXT PRIMARY KEY,
    clan_id TEXT REFERENCES clans(id) ON DELETE CASCADE,
    player_id TEXT NOT NULL,
    player_name TEXT,
    status TEXT DEFAULT 'pending',
    created_at BIGINT
);
