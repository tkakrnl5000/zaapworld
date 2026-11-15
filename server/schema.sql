-- ZAAPworld PostgreSQL Schema (Phase 2 Co-op, Monster Capture, Base Building)

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(32) NOT NULL UNIQUE,
    email VARCHAR(255) UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS coop_rooms (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_code VARCHAR(12) NOT NULL UNIQUE,
    host_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    max_players SMALLINT NOT NULL DEFAULT 3 CHECK (max_players BETWEEN 1 AND 3),
    world_seed INTEGER NOT NULL DEFAULT 42019,
    status VARCHAR(16) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'full', 'closed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS player_profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    display_name VARCHAR(32) NOT NULL,
    last_pos_x REAL NOT NULL DEFAULT 0,
    last_pos_y REAL NOT NULL DEFAULT 2.5,
    last_pos_z REAL NOT NULL DEFAULT 12,
    last_yaw_deg REAL NOT NULL DEFAULT 180,
    crystals_collected INTEGER NOT NULL DEFAULT 0 CHECK (crystals_collected >= 0),
    stamina_max REAL NOT NULL DEFAULT 100,
    preferred_quality VARCHAR(10) NOT NULL DEFAULT 'auto' CHECK (preferred_quality IN ('auto', 'low', 'medium', 'high')),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS captured_monsters (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    species_id VARCHAR(48) NOT NULL,
    nickname VARCHAR(32),
    level SMALLINT NOT NULL DEFAULT 1 CHECK (level >= 1),
    hp_current INTEGER NOT NULL CHECK (hp_current >= 0),
    hp_max INTEGER NOT NULL CHECK (hp_max > 0),
    caught_in_room_id UUID REFERENCES coop_rooms(id) ON DELETE SET NULL,
    captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS world_structures (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id UUID NOT NULL REFERENCES coop_rooms(id) ON DELETE CASCADE,
    owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE SET NULL,
    recipe_id VARCHAR(48) NOT NULL,
    grid_x INTEGER NOT NULL,
    grid_z INTEGER NOT NULL,
    pos_x REAL NOT NULL,
    pos_y REAL NOT NULL,
    pos_z REAL NOT NULL,
    rotation_yaw_deg REAL NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_world_structures_room_grid UNIQUE (room_id, grid_x, grid_z)
);

CREATE INDEX IF NOT EXISTS idx_coop_rooms_code ON coop_rooms(room_code);
CREATE INDEX IF NOT EXISTS idx_captured_monsters_owner ON captured_monsters(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_world_structures_room ON world_structures(room_id);

-- ============================================================================
-- Phase 4 Durable Survival, Building, Base Worker & Co-op Room Persistence
-- ============================================================================

CREATE TABLE IF NOT EXISTS zaap_rooms (
    room_code VARCHAR(12) PRIMARY KEY,
    world_seed INTEGER NOT NULL DEFAULT 42019,
    shared_resources JSONB NOT NULL DEFAULT '{"wood":4,"stone":2,"ore":0,"berry":3,"aether_shard":0,"cooked_berry":1}'::jsonb,
    collected_crystals JSONB NOT NULL DEFAULT '[]'::jsonb,
    resource_nodes JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at_ms BIGINT NOT NULL,
    updated_at_ms BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS zaap_players (
    room_code VARCHAR(12) NOT NULL REFERENCES zaap_rooms(room_code) ON DELETE CASCADE,
    player_id VARCHAR(64) NOT NULL,
    session_token VARCHAR(128) NOT NULL,
    display_name VARCHAR(32) NOT NULL,
    slot_index SMALLINT NOT NULL DEFAULT 0,
    pos_x REAL NOT NULL DEFAULT 0,
    pos_y REAL NOT NULL DEFAULT 2.5,
    pos_z REAL NOT NULL DEFAULT 12,
    yaw_deg REAL NOT NULL DEFAULT 0,
    hp INTEGER NOT NULL DEFAULT 100,
    max_hp INTEGER NOT NULL DEFAULT 100,
    hunger REAL NOT NULL DEFAULT 100,
    max_hunger REAL NOT NULL DEFAULT 100,
    stamina REAL NOT NULL DEFAULT 100,
    equipped_tool VARCHAR(32) NOT NULL DEFAULT 'hands',
    unlocked_tools JSONB NOT NULL DEFAULT '["hands"]'::jsonb,
    capture_spheres INTEGER NOT NULL DEFAULT 12,
    loot_count INTEGER NOT NULL DEFAULT 0,
    crystals_collected INTEGER NOT NULL DEFAULT 0,
    captured_roster JSONB NOT NULL DEFAULT '[]'::jsonb,
    updated_at_ms BIGINT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (room_code, player_id)
);

CREATE TABLE IF NOT EXISTS zaap_structures (
    id VARCHAR(96) PRIMARY KEY,
    room_code VARCHAR(12) NOT NULL REFERENCES zaap_rooms(room_code) ON DELETE CASCADE,
    recipe_id VARCHAR(48) NOT NULL,
    grid_x INTEGER NOT NULL,
    grid_z INTEGER NOT NULL,
    layer SMALLINT NOT NULL DEFAULT 1 CHECK (layer BETWEEN 0 AND 2),
    pos_x REAL NOT NULL,
    pos_y REAL NOT NULL,
    pos_z REAL NOT NULL,
    rotation_yaw_deg REAL NOT NULL DEFAULT 0,
    owner_player_id VARCHAR(64) NOT NULL,
    owner_name VARCHAR(32) NOT NULL DEFAULT 'Explorer',
    created_at_ms BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_zaap_structures_room_cell UNIQUE (room_code, grid_x, grid_z, layer)
);

CREATE TABLE IF NOT EXISTS zaap_base_workers (
    uid VARCHAR(64) NOT NULL,
    room_code VARCHAR(12) NOT NULL REFERENCES zaap_rooms(room_code) ON DELETE CASCADE,
    owner_player_id VARCHAR(64) NOT NULL,
    species VARCHAR(32) NOT NULL,
    nickname VARCHAR(32) NOT NULL,
    level SMALLINT NOT NULL DEFAULT 1,
    pos_x REAL NOT NULL DEFAULT 0,
    pos_y REAL NOT NULL DEFAULT 2.2,
    pos_z REAL NOT NULL DEFAULT 12,
    yaw REAL NOT NULL DEFAULT 0,
    ai_state VARCHAR(24) NOT NULL DEFAULT 'idle',
    active_work VARCHAR(24),
    carrying_kind VARCHAR(32),
    carrying_amount INTEGER NOT NULL DEFAULT 0,
    energy REAL NOT NULL DEFAULT 100,
    max_energy REAL NOT NULL DEFAULT 100,
    target_node_id VARCHAR(64),
    target_structure_id VARCHAR(96),
    updated_at_ms BIGINT NOT NULL,
    PRIMARY KEY (room_code, uid)
);

CREATE INDEX IF NOT EXISTS idx_zaap_rooms_updated ON zaap_rooms(updated_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_zaap_players_room ON zaap_players(room_code);
CREATE INDEX IF NOT EXISTS idx_zaap_players_token ON zaap_players(room_code, session_token);
CREATE INDEX IF NOT EXISTS idx_zaap_players_name ON zaap_players(room_code, LOWER(display_name));
CREATE INDEX IF NOT EXISTS idx_zaap_structures_room ON zaap_structures(room_code);
CREATE INDEX IF NOT EXISTS idx_zaap_base_workers_room ON zaap_base_workers(room_code);
