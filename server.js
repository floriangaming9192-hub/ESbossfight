const express = require("express");
const path = require("path");
const Database = require("better-sqlite3");

const app = express();
const PORT = process.env.PORT || 3000;

const db = new Database("bossfight.db");

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

db.exec(`
CREATE TABLE IF NOT EXISTS game (
  id INTEGER PRIMARY KEY,
  boss_name TEXT NOT NULL,
  boss_hp INTEGER NOT NULL,
  max_boss_hp INTEGER NOT NULL,
  boss_photo TEXT DEFAULT '',
  florian_sales INTEGER DEFAULT 0,
  julie_sales INTEGER DEFAULT 0,
  thomas_sales INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  sales INTEGER DEFAULT 0,
  es_goal INTEGER DEFAULT 6,
  photo TEXT DEFAULT '',
  boss_photo TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player TEXT,
  action TEXT,
  hp_change INTEGER,
  boss_name TEXT,
  boss_hp INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY,
  reglages_code TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL DEFAULT '#ffc400'
);
`);

function addColumnIfMissing(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();

  if (!columns.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

addColumnIfMissing("history", "player_id", "INTEGER");
addColumnIfMissing("history", "previous_player_sales", "INTEGER");
addColumnIfMissing("history", "previous_boss_name", "TEXT");
addColumnIfMissing("history", "previous_boss_hp", "INTEGER");
addColumnIfMissing("history", "undone", "INTEGER DEFAULT 0");
addColumnIfMissing("history", "action_type", "TEXT");
addColumnIfMissing("history", "previous_boss_shield", "INTEGER DEFAULT 0");

addColumnIfMissing("players", "es_goal", "INTEGER DEFAULT 6");
addColumnIfMissing("players", "photo", "TEXT DEFAULT ''");
addColumnIfMissing("players", "boss_photo", "TEXT DEFAULT ''");
addColumnIfMissing("players", "special_used", "INTEGER DEFAULT 0");
addColumnIfMissing("players", "team_id", "INTEGER");

addColumnIfMissing("game", "boss_photo", "TEXT DEFAULT ''");
addColumnIfMissing("game", "boss_shield", "INTEGER DEFAULT 0");
addColumnIfMissing("game", "battle_goal", "INTEGER DEFAULT 100");

// Migration : renomme l'ancienne colonne admin_code en reglages_code
const settingsColumns = db.prepare("PRAGMA table_info(settings)").all();

if (
  settingsColumns.some(c => c.name === "admin_code") &&
  !settingsColumns.some(c => c.name === "reglages_code")
) {
  db.exec("ALTER TABLE settings RENAME COLUMN admin_code TO reglages_code");
}

const gameExists = db.prepare("SELECT * FROM game WHERE id = 1").get();

if (!gameExists) {
  db.prepare(`
    INSERT INTO game
    (
      id,
      boss_name,
      boss_hp,
      max_boss_hp,
      boss_photo,
      florian_sales,
      julie_sales,
      thomas_sales
    )
    VALUES (
      1,
      'Kevin',
      10,
      10,
      '/images/kevin.png',
      0,
      0,
      0
    )
  `).run();
}

// Florian et Thomas ne sont plus créés automatiquement au lancement.
const defaultPlayers = [
  ["Julie", "/images/julie.png"]
];

for (const [name, photo] of defaultPlayers) {
  const exists = db.prepare(`
    SELECT *
    FROM players
    WHERE name = ?
  `).get(name);

  if (!exists) {
    db.prepare(`
      INSERT INTO players
      (
        name,
        sales,
        es_goal,
        photo,
        boss_photo
      )
      VALUES (?, 0, 6, ?, '')
    `).run(name, photo);
  }
}

const settingsExists = db.prepare(`
  SELECT *
  FROM settings
  WHERE id = 1
`).get();

if (!settingsExists) {
  db.prepare(`
    INSERT INTO settings
    (
      id,
      reglages_code
    )
    VALUES (1, '1234')
  `).run();
}

function getGame() {
  return db.prepare(`
    SELECT *
    FROM game
    WHERE id = 1
  `).get();
}

function getPlayers() {
  return db.prepare(`
    SELECT
      id,
      name,
      sales,
      es_goal,
      photo,
      boss_photo,
      special_used,
      team_id,
      CASE
        WHEN sales >= es_goal AND special_used = 0 THEN 1
        ELSE 0
      END AS special_available
    FROM players
    ORDER BY id
  `).all();
}

function getTeams() {
  return db.prepare(`
    SELECT id, name, color
    FROM teams
    ORDER BY id
  `).all();
}

function isValidColor(color) {
  return typeof color === "string" && /^#[0-9a-fA-F]{6}$/.test(color);
}

function reglagesCodeIsValid(code) {
  const settings = db.prepare(`
    SELECT reglages_code
    FROM settings
    WHERE id = 1
  `).get();

  return !!settings && code === settings.reglages_code;
}

function getPlayerPhoto(name) {
  const player = db.prepare(`
    SELECT photo
    FROM players
    WHERE name = ?
  `).get(name);

  return player?.photo || "";
}

function getBossPhoto(name) {
  if (name === "Kevin") {
    return "/images/kevin.png";
  }

  const player = db.prepare(`
    SELECT boss_photo
    FROM players
    WHERE name = ?
  `).get(name);

  return player?.boss_photo || "";
}

function syncBossPhoto() {
  const game = getGame();
  const bossPhoto = getBossPhoto(game.boss_name);

  db.prepare(`
    UPDATE game
    SET boss_photo = ?
    WHERE id = 1
  `).run(bossPhoto);
}

// Points ajoutés au compteur ES d'un joueur selon l'attaque :
// Simple (1 dégât) = +1, Double (3 dégâts) = +2, Triple (6 dégâts) = +3
function salesPointsFor(amount) {
  const points = { 1: 1, 3: 2, 6: 3 };

  return points[amount] || Math.max(1, Math.round(amount / 2));
}

app.get("/api/game", (req, res) => {
  const game = getGame();

  res.json({
    ...game,
    boss_photo: getBossPhoto(game.boss_name)
  });
});

app.get("/api/players", (req, res) => {
  res.json(getPlayers());
});

app.get("/api/teams", (req, res) => {
  res.json(getTeams());
});

app.post("/api/attack", (req, res) => {
  const {
    player,
    damage,
    attackType
  } = req.body;

  if (!player || !damage || !attackType) {
    return res.status(400).json({
      success: false,
      message: "Données manquantes"
    });
  }

  const currentGame = getGame();

  const attacker = db.prepare(`
    SELECT *
    FROM players
    WHERE name = ?
  `).get(player);

  if (!attacker) {
    return res.status(404).json({
      success: false,
      message: "Joueur introuvable"
    });
  }

  const amount = Number(damage);

  const labels = {
    1: "Simple",
    3: "Double",
    6: "Triple"
  };

  const label = labels[amount] || attackType;

  if (player === currentGame.boss_name) {
    // Le soin remplit les PV manquants, et ce qui dépasse est perdu.
    // Le bouclier n'est gagné que si les PV sont DÉJÀ au maximum
    // (Simple +1, Double +2, Triple +3).
    // Le bouclier est plafonné aux PV max.
    const shieldValues = { 1: 1, 3: 2, 6: 3 };

    const previousShield =
      currentGame.boss_shield || 0;

    const missingHp = Math.max(
      0,
      currentGame.max_boss_hp - currentGame.boss_hp
    );

    const healed = Math.min(amount, missingHp);

    const overflow = amount - healed;

    const newHp = currentGame.boss_hp + healed;

    const shieldPoints =
      shieldValues[amount] ||
      Math.max(1, Math.round(amount / 2));

    const newShield = (overflow > 0 && healed === 0)
      ? Math.min(
          previousShield + Math.min(overflow, shieldPoints),
          currentGame.max_boss_hp
        )
      : previousShield;

    const shieldGain = newShield - previousShield;

    let healAction =
      `${player} met une ${label} (${amount} PV)`;

    if (shieldGain > 0) {
      healAction = healed > 0
        ? `${player} met une ${label} (${healed} PV + ${shieldGain} bouclier 🛡️)`
        : `${player} met une ${label} (+${shieldGain} bouclier 🛡️)`;
    } else if (overflow > 0) {
      healAction = healed > 0
        ? `${player} met une ${label} (${healed} PV)`
        : `${player} met une ${label} (bouclier déjà au maximum)`;
    }

    db.prepare(`
      UPDATE game
      SET boss_hp = ?,
          boss_shield = ?
      WHERE id = 1
    `).run(newHp, newShield);

    db.prepare(`
      UPDATE players
      SET sales = sales + ?
      WHERE id = ?
    `).run(salesPointsFor(amount), attacker.id);

    db.prepare(`
      INSERT INTO history
      (
        player,
        action,
        hp_change,
        boss_name,
        boss_hp,
        player_id,
        previous_player_sales,
        previous_boss_name,
        previous_boss_hp,
        undone,
        action_type
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `).run(
      player,
      healAction,
      amount,
      currentGame.boss_name,
      newHp,
      attacker.id,
      attacker.sales,
      currentGame.boss_name,
      currentGame.boss_hp,
      "heal"
    );

    // Dernière ligne d'historique = le soin qu'on vient d'insérer
    db.prepare(`
      UPDATE history
      SET previous_boss_shield = ?
      WHERE id = (SELECT MAX(id) FROM history)
    `).run(previousShield);

    syncBossPhoto();

    return res.json({
      success: true,
      game: getGame(),
      players: getPlayers()
    });
  }

  const previousBossName = currentGame.boss_name;
  const previousBossHp = currentGame.boss_hp;
  const previousPlayerSales = attacker.sales;
  const previousBossShield = currentGame.boss_shield || 0;

  // Le bouclier absorbe les dégâts en premier
  let remainingDamage = amount;
  let newBossShield = previousBossShield;

  if (newBossShield > 0) {
    const absorbed = Math.min(newBossShield, remainingDamage);
    newBossShield -= absorbed;
    remainingDamage -= absorbed;
  }

  let newBossHp = currentGame.boss_hp - remainingDamage;

  if (newBossHp < 0) {
    newBossHp = 0;
  }

  const newPlayerSales = attacker.sales + salesPointsFor(amount);

  db.prepare(`
    UPDATE players
    SET sales = ?
    WHERE id = ?
  `).run(newPlayerSales, attacker.id);

  let action;

  if (newBossHp <= 0) {
    db.prepare(`
      UPDATE game
      SET boss_name = ?,
          boss_hp = max_boss_hp,
          boss_shield = 0
      WHERE id = 1
    `).run(player);

    action =
      `${player} met une ${label} (${amount} dégât${amount > 1 ? "s" : ""}) et devient le nouveau Boss`;

    db.prepare(`
      INSERT INTO history
      (
        player,
        action,
        hp_change,
        boss_name,
        boss_hp,
        player_id,
        previous_player_sales,
        previous_boss_name,
        previous_boss_hp,
        undone,
        action_type
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `).run(
      player,
      action,
      -amount,
      player,
      currentGame.max_boss_hp,
      attacker.id,
      previousPlayerSales,
      previousBossName,
      previousBossHp,
      "attack"
    );
  } else {
    db.prepare(`
      UPDATE game
      SET boss_hp = ?,
          boss_shield = ?
      WHERE id = 1
    `).run(newBossHp, newBossShield);

    action =
      `${player} met une ${label} (${amount} dégât${amount > 1 ? "s" : ""})`;

    db.prepare(`
      INSERT INTO history
      (
        player,
        action,
        hp_change,
        boss_name,
        boss_hp,
        player_id,
        previous_player_sales,
        previous_boss_name,
        previous_boss_hp,
        undone,
        action_type
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `).run(
      player,
      action,
      -amount,
      currentGame.boss_name,
      newBossHp,
      attacker.id,
      previousPlayerSales,
      previousBossName,
      previousBossHp,
      "attack"
    );
  }

  // Dernière ligne d'historique = l'attaque qu'on vient d'insérer
  db.prepare(`
    UPDATE history
    SET previous_boss_shield = ?
    WHERE id = (SELECT MAX(id) FROM history)
  `).run(previousBossShield);

  syncBossPhoto();

  res.json({
    success: true,
    game: getGame(),
    players: getPlayers()
  });
});

app.post("/api/special", (req, res) => {
  const { player } = req.body;

  if (!player) {
    return res.status(400).json({
      success: false,
      message: "Joueur manquant"
    });
  }

  const currentGame = getGame();

  const attacker = db.prepare(`
    SELECT *
    FROM players
    WHERE name = ?
  `).get(player);

  if (!attacker) {
    return res.status(404).json({
      success: false,
      message: "Joueur introuvable"
    });
  }

  if (player === currentGame.boss_name) {
    return res.status(400).json({
      success: false,
      message: "Le Boss ne peut pas utiliser le One Shot"
    });
  }

  if (attacker.sales < attacker.es_goal) {
    return res.status(400).json({
      success: false,
      message: "Objectif ES non atteint"
    });
  }

  if (attacker.special_used) {
    return res.status(400).json({
      success: false,
      message: "Pouvoir spécial déjà utilisé"
    });
  }

  const previousBossName = currentGame.boss_name;
  const previousBossHp = currentGame.boss_hp;
  const previousPlayerSales = attacker.sales;

  db.prepare(`
    UPDATE players
    SET special_used = 1
    WHERE id = ?
  `).run(attacker.id);

  db.prepare(`
    UPDATE game
    SET boss_name = ?,
        boss_hp = max_boss_hp,
        boss_shield = 0
    WHERE id = 1
  `).run(player);

  const action =
    `${player} utilise ☠️ ONE SHOT et devient le nouveau Boss`;

  db.prepare(`
    INSERT INTO history
    (
      player,
      action,
      hp_change,
      boss_name,
      boss_hp,
      player_id,
      previous_player_sales,
      previous_boss_name,
      previous_boss_hp,
      undone,
      action_type
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
  `).run(
    player,
    action,
    -currentGame.boss_hp,
    player,
    currentGame.max_boss_hp,
    attacker.id,
    previousPlayerSales,
    previousBossName,
    previousBossHp,
    "special"
  );

  // Dernière ligne d'historique = le One Shot qu'on vient d'insérer
  db.prepare(`
    UPDATE history
    SET previous_boss_shield = ?
    WHERE id = (SELECT MAX(id) FROM history)
  `).run(currentGame.boss_shield || 0);

  syncBossPhoto();

  res.json({
    success: true,
    game: getGame(),
    players: getPlayers()
  });
});
app.post("/api/sell", (req, res) => {
  const { player } = req.body;

  if (!player) {
    return res.status(400).json({
      success: false,
      message: "Joueur manquant"
    });
  }

  const currentGame = getGame();

  if (player === currentGame.boss_name) {
    return res.status(400).json({
      success: false,
      message: "Le Boss ne peut pas attaquer avec ce bouton"
    });
  }

  const attacker = db.prepare(`
    SELECT *
    FROM players
    WHERE name = ?
  `).get(player);

  if (!attacker) {
    return res.status(404).json({
      success: false,
      message: "Joueur introuvable"
    });
  }

  const previousPlayerSales = attacker.sales;
  const previousBossName = currentGame.boss_name;
  const previousBossHp = currentGame.boss_hp;

  const newSales = attacker.sales + 1;
  let newHp = currentGame.boss_hp - 1;

  db.prepare(`
    UPDATE players
    SET sales = ?
    WHERE id = ?
  `).run(newSales, attacker.id);

  let action;

  if (newHp <= 0) {
    db.prepare(`
      UPDATE game
      SET boss_name = ?,
          boss_hp = max_boss_hp,
          boss_shield = 0
      WHERE id = 1
    `).run(player);

    action =
      `${player} met une Simple (1 dégât) et devient le nouveau Boss`;
  } else {
    db.prepare(`
      UPDATE game
      SET boss_hp = ?
      WHERE id = 1
    `).run(newHp);

    action =
      `${player} met une Simple (1 dégât)`;
  }

  db.prepare(`
    INSERT INTO history
    (
      player,
      action,
      hp_change,
      boss_name,
      boss_hp,
      player_id,
      previous_player_sales,
      previous_boss_name,
      previous_boss_hp,
      undone,
      action_type
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
  `).run(
    player,
    action,
    -1,
    previousBossName,
    newHp,
    attacker.id,
    previousPlayerSales,
    previousBossName,
    previousBossHp,
    "attack"
  );

  syncBossPhoto();

  res.json({
    success: true,
    game: getGame(),
    players: getPlayers()
  });
});

app.post("/api/boss-sell", (req, res) => {
  const { player } = req.body;

  if (!player) {
    return res.status(400).json({
      success: false,
      message: "Joueur manquant"
    });
  }

  const currentGame = getGame();

  if (player !== currentGame.boss_name) {
    return res.status(400).json({
      success: false,
      message: "Ce joueur n'est pas le Boss"
    });
  }

  const newHp = Math.min(
    currentGame.boss_hp + 1,
    currentGame.max_boss_hp
  );

  db.prepare(`
    UPDATE game
    SET boss_hp = ?
    WHERE id = 1
  `).run(newHp);

  db.prepare(`
    UPDATE players
    SET sales = sales + 1
    WHERE name = ?
  `).run(player);

  db.prepare(`
    INSERT INTO history
    (
      player,
      action,
      hp_change,
      boss_name,
      boss_hp,
      action_type
    )
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    player,
    `${player} met une Simple (1 PV)`,
    1,
    player,
    newHp,
    "heal"
  );

  syncBossPhoto();

  res.json({
    success: true,
    game: getGame(),
    players: getPlayers()
  });
});

app.get("/api/history", (req, res) => {
  const history = db.prepare(`
    SELECT *
    FROM history
    WHERE COALESCE(undone, 0) = 0
    ORDER BY id DESC
    LIMIT 100
  `).all();

  res.json(history);
});

// Annule la DERNIÈRE action de la partie (attaque, soin, bouclier, One Shot)
// et remet tout dans l'état d'avant : Boss, PV, bouclier, compteur ES
// du joueur et pouvoir One Shot. Seul l'auteur de la dernière action peut
// l'annuler ; on peut annuler plusieurs fois de suite pour remonter
// dans l'historique.
app.post("/api/undo-my-last-sale", (req, res) => {
  const { player } = req.body;

  if (!player) {
    return res.status(400).json({
      success: false,
      message: "Joueur manquant"
    });
  }

  const last = db.prepare(`
    SELECT *
    FROM history
    WHERE COALESCE(undone, 0) = 0
    ORDER BY id DESC
    LIMIT 1
  `).get();

  if (!last) {
    return res.status(400).json({
      success: false,
      message: "Aucune action à annuler"
    });
  }

  if (last.player !== player) {
    return res.status(400).json({
      success: false,
      message: `La dernière action est celle de ${last.player}`
    });
  }

  if (
    !last.player_id ||
    last.previous_boss_name == null ||
    last.previous_boss_hp == null ||
    last.previous_player_sales == null
  ) {
    return res.status(400).json({
      success: false,
      message: "Cette action ne peut pas être annulée"
    });
  }

  const currentGame = getGame();

  // Sécurité : si les réglages ont modifié le Boss ou ses PV depuis,
  // on n'écrase pas son changement.
  if (
    currentGame.boss_name !== last.boss_name ||
    currentGame.boss_hp !== last.boss_hp
  ) {
    return res.status(409).json({
      success: false,
      message: "L'état du jeu a changé depuis cette action, impossible de l'annuler"
    });
  }

  const attacker = db.prepare(`
    SELECT *
    FROM players
    WHERE id = ?
  `).get(last.player_id);

  if (!attacker) {
    return res.status(404).json({
      success: false,
      message: "Joueur introuvable"
    });
  }

  const undo = db.transaction(() => {
    db.prepare(`
      UPDATE players
      SET sales = ?,
          special_used = CASE
            WHEN ? = 'special' THEN 0
            ELSE special_used
          END
      WHERE id = ?
    `).run(
      last.previous_player_sales,
      last.action_type,
      attacker.id
    );

    db.prepare(`
      UPDATE game
      SET boss_name = ?,
          boss_hp = ?,
          boss_shield = ?
      WHERE id = 1
    `).run(
      last.previous_boss_name,
      last.previous_boss_hp,
      last.previous_boss_shield || 0
    );

    db.prepare(`
      UPDATE history
      SET undone = 1
      WHERE id = ?
    `).run(last.id);
  });

  undo();

  syncBossPhoto();

  res.json({
    success: true,
    game: getGame(),
    players: getPlayers()
  });
});

app.post("/api/reglages/login", (req, res) => {
  const { code } = req.body;

  const settings = db.prepare(`
    SELECT reglages_code
    FROM settings
    WHERE id = 1
  `).get();

  if (!settings || code !== settings.reglages_code) {
    return res.status(401).json({
      success: false,
      message: "Code incorrect"
    });
  }

  res.json({
    success: true
  });
});

app.post("/api/reglages/add-player", (req, res) => {
  const {
    code,
    name
  } = req.body;

  const settings = db.prepare(`
    SELECT reglages_code
    FROM settings
    WHERE id = 1
  `).get();

  if (code !== settings.reglages_code) {
    return res.status(401).json({
      success: false,
      message: "Code incorrect"
    });
  }

  if (!name || !name.trim()) {
    return res.status(400).json({
      success: false,
      message: "Nom manquant"
    });
  }

  const cleanName = name.trim();

  try {
    db.prepare(`
      INSERT INTO players
      (
        name,
        sales,
        es_goal,
        photo,
        boss_photo
      )
      VALUES (?, 0, 6, '', '')
    `).run(cleanName);

    res.json({
      success: true,
      players: getPlayers()
    });

  } catch (error) {
    res.status(400).json({
      success: false,
      message: "Ce joueur existe déjà"
    });
  }
});

app.post("/api/reglages/delete-player", (req, res) => {
  const {
    code,
    playerId,
    name
  } = req.body;

  const settings = db.prepare(`
    SELECT reglages_code
    FROM settings
    WHERE id = 1
  `).get();

  if (!settings || code !== settings.reglages_code) {
    return res.status(401).json({
      success: false,
      message: "Code incorrect"
    });
  }

  let player;

  if (playerId) {
    player = db.prepare(`
      SELECT *
      FROM players
      WHERE id = ?
    `).get(playerId);
  } else if (name) {
    player = db.prepare(`
      SELECT *
      FROM players
      WHERE name = ?
    `).get(name);
  }

  if (!player) {
    return res.status(404).json({
      success: false,
      message: "Joueur introuvable"
    });
  }

  const currentGame = getGame();

  if (player.name === currentGame.boss_name) {
    return res.status(400).json({
      success: false,
      message: "Impossible de supprimer le Boss actuel"
    });
  }

  db.prepare(`
    DELETE FROM players
    WHERE id = ?
  `).run(player.id);

  res.json({
    success: true,
    players: getPlayers()
  });
});

app.post("/api/reglages/player-goal", (req, res) => {
  const {
    code,
    playerId,
    esGoal
  } = req.body;

  const settings = db.prepare(`
    SELECT reglages_code
    FROM settings
    WHERE id = 1
  `).get();

  if (!settings || code !== settings.reglages_code) {
    return res.status(401).json({
      success: false,
      message: "Code incorrect"
    });
  }

  const goal = Number(esGoal);

  if (!Number.isInteger(goal) || goal < 1) {
    return res.status(400).json({
      success: false,
      message: "Objectif ES incorrect"
    });
  }

  const player = db.prepare(`
    SELECT *
    FROM players
    WHERE id = ?
  `).get(playerId);

  if (!player) {
    return res.status(404).json({
      success: false,
      message: "Joueur introuvable"
    });
  }

  db.prepare(`
    UPDATE players
    SET es_goal = ?
    WHERE id = ?
  `).run(goal, playerId);

  res.json({
    success: true,
    players: getPlayers()
  });
});

/* =====================================================
   ÉQUIPES
===================================================== */

app.post("/api/reglages/add-team", (req, res) => {
  const { code, name, color } = req.body;

  if (!reglagesCodeIsValid(code)) {
    return res.status(401).json({
      success: false,
      message: "Code incorrect"
    });
  }

  const cleanName = (name || "").trim();

  if (!cleanName) {
    return res.status(400).json({
      success: false,
      message: "Nom d'équipe manquant"
    });
  }

  const cleanColor = isValidColor(color) ? color : "#ffc400";

  try {
    db.prepare(`
      INSERT INTO teams (name, color)
      VALUES (?, ?)
    `).run(cleanName, cleanColor);
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: "Cette équipe existe déjà"
    });
  }

  res.json({
    success: true,
    teams: getTeams(),
    players: getPlayers()
  });
});

app.post("/api/reglages/update-team", (req, res) => {
  const { code, teamId, name, color } = req.body;

  if (!reglagesCodeIsValid(code)) {
    return res.status(401).json({
      success: false,
      message: "Code incorrect"
    });
  }

  const team = db.prepare(`
    SELECT *
    FROM teams
    WHERE id = ?
  `).get(teamId);

  if (!team) {
    return res.status(404).json({
      success: false,
      message: "Équipe introuvable"
    });
  }

  const cleanName = (name || "").trim();

  if (!cleanName) {
    return res.status(400).json({
      success: false,
      message: "Nom d'équipe manquant"
    });
  }

  const cleanColor = isValidColor(color) ? color : team.color;

  try {
    db.prepare(`
      UPDATE teams
      SET name = ?,
          color = ?
      WHERE id = ?
    `).run(cleanName, cleanColor, team.id);
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: "Ce nom d'équipe est déjà utilisé"
    });
  }

  res.json({
    success: true,
    teams: getTeams(),
    players: getPlayers()
  });
});

app.post("/api/reglages/delete-team", (req, res) => {
  const { code, teamId } = req.body;

  if (!reglagesCodeIsValid(code)) {
    return res.status(401).json({
      success: false,
      message: "Code incorrect"
    });
  }

  const team = db.prepare(`
    SELECT *
    FROM teams
    WHERE id = ?
  `).get(teamId);

  if (!team) {
    return res.status(404).json({
      success: false,
      message: "Équipe introuvable"
    });
  }

  // Les joueurs de l'équipe ne sont pas supprimés : ils repassent « sans équipe »
  const remove = db.transaction(() => {
    db.prepare(`
      UPDATE players
      SET team_id = NULL
      WHERE team_id = ?
    `).run(team.id);

    db.prepare(`
      DELETE FROM teams
      WHERE id = ?
    `).run(team.id);
  });

  remove();

  res.json({
    success: true,
    teams: getTeams(),
    players: getPlayers()
  });
});

app.post("/api/reglages/player-team", (req, res) => {
  const { code, playerId, teamId } = req.body;

  if (!reglagesCodeIsValid(code)) {
    return res.status(401).json({
      success: false,
      message: "Code incorrect"
    });
  }

  const player = db.prepare(`
    SELECT *
    FROM players
    WHERE id = ?
  `).get(playerId);

  if (!player) {
    return res.status(404).json({
      success: false,
      message: "Joueur introuvable"
    });
  }

  let newTeamId = null;

  if (teamId !== null && teamId !== undefined && teamId !== "") {
    const team = db.prepare(`
      SELECT id
      FROM teams
      WHERE id = ?
    `).get(teamId);

    if (!team) {
      return res.status(404).json({
        success: false,
        message: "Équipe introuvable"
      });
    }

    newTeamId = team.id;
  }

  db.prepare(`
    UPDATE players
    SET team_id = ?
    WHERE id = ?
  `).run(newTeamId, player.id);

  res.json({
    success: true,
    teams: getTeams(),
    players: getPlayers()
  });
});

app.post("/api/reglages/battle-goal", (req, res) => {
  const { code, goal } = req.body;

  if (!reglagesCodeIsValid(code)) {
    return res.status(401).json({
      success: false,
      message: "Code incorrect"
    });
  }

  const battleGoal = Number(goal);

  if (!Number.isInteger(battleGoal) || battleGoal < 1) {
    return res.status(400).json({
      success: false,
      message: "L'objectif de bataille doit être un nombre entier supérieur ou égal à 1"
    });
  }

  db.prepare(`
    UPDATE game
    SET battle_goal = ?
    WHERE id = 1
  `).run(battleGoal);

  res.json({
    success: true,
    game: getGame()
  });
});

app.post("/api/reglages/change-code", (req, res) => {
  const {
    oldCode,
    newCode
  } = req.body;

  const settings = db.prepare(`
    SELECT reglages_code
    FROM settings
    WHERE id = 1
  `).get();

  if (oldCode !== settings.reglages_code) {
    return res.status(401).json({
      success: false,
      message: "Ancien code incorrect"
    });
  }

  if (!newCode || !newCode.trim()) {
    return res.status(400).json({
      success: false,
      message: "Nouveau code manquant"
    });
  }

  db.prepare(`
    UPDATE settings
    SET reglages_code = ?
    WHERE id = 1
  `).run(newCode.trim());

  res.json({
    success: true
  });
});

app.post("/api/reglages/max-hp", (req, res) => {
  const {
    code,
    maxHp
  } = req.body;

  const settings = db.prepare(`
    SELECT reglages_code
    FROM settings
    WHERE id = 1
  `).get();

  if (code !== settings.reglages_code) {
    return res.status(401).json({
      success: false,
      message: "Code incorrect"
    });
  }

  const hp = Number(maxHp);

  if (!Number.isFinite(hp) || hp <= 0) {
    return res.status(400).json({
      success: false,
      message: "Valeur incorrecte"
    });
  }

  db.prepare(`
    UPDATE game
    SET max_boss_hp = ?,
        boss_hp = ?,
        boss_shield = 0
    WHERE id = 1
  `).run(hp, hp);

  res.json({
    success: true,
    game: getGame()
  });
});

app.post("/api/reglages/heal-boss", (req, res) => {
  const { code } = req.body;

  const settings = db.prepare(`
    SELECT reglages_code
    FROM settings
    WHERE id = 1
  `).get();

  if (code !== settings.reglages_code) {
    return res.status(401).json({
      success: false,
      message: "Code incorrect"
    });
  }

  db.prepare(`
    UPDATE game
    SET boss_hp = max_boss_hp
    WHERE id = 1
  `).run();

  res.json({
    success: true,
    game: getGame()
  });
});

app.post("/api/reglages/change-boss", (req, res) => {
  const {
    code,
    player
  } = req.body;

  const settings = db.prepare(`
    SELECT reglages_code
    FROM settings
    WHERE id = 1
  `).get();

  if (code !== settings.reglages_code) {
    return res.status(401).json({
      success: false,
      message: "Code incorrect"
    });
  }

  const target = db.prepare(`
    SELECT *
    FROM players
    WHERE name = ?
  `).get(player);

  if (!target) {
    return res.status(404).json({
      success: false,
      message: "Joueur introuvable"
    });
  }

  db.prepare(`
    UPDATE game
    SET boss_name = ?,
        boss_hp = max_boss_hp,
        boss_shield = 0
    WHERE id = 1
  `).run(player);

  syncBossPhoto();

  res.json({
    success: true,
    game: getGame(),
    players: getPlayers()
  });
});

app.post("/api/reglages/reset", (req, res) => {
  const { code } = req.body;

  const settings = db.prepare(`
    SELECT reglages_code
    FROM settings
    WHERE id = 1
  `).get();

  if (code !== settings.reglages_code) {
    return res.status(401).json({
      success: false,
      message: "Code incorrect"
    });
  }

  db.prepare(`
    UPDATE game
    SET boss_hp = max_boss_hp,
        boss_shield = 0
    WHERE id = 1
  `).run();

  db.prepare(`
  UPDATE players
  SET sales = 0
`).run();

db.prepare(`
  UPDATE players
  SET special_used = 0
`).run();

  db.prepare(`
    DELETE FROM history
  `).run();

  syncBossPhoto();

  res.json({
    success: true,
    game: getGame(),
    players: getPlayers()
  });
});

app.post("/api/reglages/player-photo", (req, res) => {
  const {
    code,
    playerId,
    photo
  } = req.body;

  const settings = db.prepare(`
    SELECT reglages_code
    FROM settings
    WHERE id = 1
  `).get();

  if (code !== settings.reglages_code) {
    return res.status(401).json({
      success: false,
      message: "Code incorrect"
    });
  }

  const player = db.prepare(`
    SELECT *
    FROM players
    WHERE id = ?
  `).get(playerId);

  if (!player) {
    return res.status(404).json({
      success: false,
      message: "Joueur introuvable"
    });
  }

  db.prepare(`
    UPDATE players
    SET photo = ?
    WHERE id = ?
  `).run(photo || "", playerId);

  syncBossPhoto();

  res.json({
    success: true,
    players: getPlayers(),
    game: getGame()
  });
});

app.post("/api/reglages/boss-photo", (req, res) => {
  const {
    code,
    playerId,
    photo
  } = req.body;

  const settings = db.prepare(`
    SELECT reglages_code
    FROM settings
    WHERE id = 1
  `).get();

  if (code !== settings.reglages_code) {
    return res.status(401).json({
      success: false,
      message: "Code incorrect"
    });
  }

  const player = db.prepare(`
    SELECT *
    FROM players
    WHERE id = ?
  `).get(playerId);

  if (!player) {
    return res.status(404).json({
      success: false,
      message: "Joueur introuvable"
    });
  }

  db.prepare(`
    UPDATE players
    SET boss_photo = ?
    WHERE id = ?
  `).run(photo || "", playerId);

  syncBossPhoto();

  res.json({
    success: true,
    players: getPlayers(),
    game: getGame()
  });
});

app.listen(PORT, () => {
  console.log(`ES Boss Fight lancé sur http://localhost:${PORT}`);
});