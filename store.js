// Safa Shipping Console — storage layer
// PostgreSQL when DATABASE_URL is set (production), JSON files otherwise (local development).
//
// Each "bucket" (auth, erp) is an in-memory state object. Arrays whose items all carry a numeric id are
// stored row-by-row in `records`; everything else is stored per key in `kv`. save() writes only what changed,
// inside one transaction, and saves are serialised so they never interleave.
const fs = require('fs');
const path = require('path');

// rows only when every item has a numeric id and ids are unique (otherwise the array is stored whole, never merged)
const isRecordArray = (v) => { if (!Array.isArray(v)) return false; const seen = new Set();
  for (const x of v) { if (!x || typeof x !== 'object' || !Number.isInteger(x.id) || seen.has(x.id)) return false; seen.add(x.id); } return true; };

module.exports = function createStore({ dataDir, databaseUrl, log = console }) {
  const kind = databaseUrl ? 'postgres' : 'json';
  let pool = null;

  async function init() {
    fs.mkdirSync(dataDir, { recursive: true });
    if (kind !== 'postgres') return;
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: databaseUrl, max: 10, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000,
      ssl: /sslmode=require/.test(databaseUrl) ? { rejectUnauthorized: false } : undefined });
    pool.on('error', (e) => log.error('[db] idle client error:', e.message));
    // retry: the database container may still be starting
    for (let i = 1; ; i++) {
      try { await pool.query('SELECT 1'); break; } catch (e) {
        if (i >= 30) throw new Error('Cannot connect to PostgreSQL: ' + e.message);
        log.log(`[db] waiting for PostgreSQL (${i}/30)…`); await new Promise((r) => setTimeout(r, 2000));
      }
    }
    await pool.query(`
      CREATE TABLE IF NOT EXISTS records (
        bucket text NOT NULL, coll text NOT NULL, id bigint NOT NULL, data jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (bucket, coll, id));
      CREATE TABLE IF NOT EXISTS kv (
        bucket text NOT NULL, key text NOT NULL, data jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (bucket, key));
      CREATE TABLE IF NOT EXISTS schema_info (key text PRIMARY KEY, value text NOT NULL);
      INSERT INTO schema_info VALUES ('version', '1') ON CONFLICT (key) DO NOTHING;`);
    log.log('[db] PostgreSQL ready');
  }

  async function readPg(bucket) {
    const st = {};
    const rec = await pool.query('SELECT coll, data FROM records WHERE bucket = $1 ORDER BY coll, id', [bucket]);
    for (const r of rec.rows) (st[r.coll] || (st[r.coll] = [])).push(r.data);
    const kv = await pool.query('SELECT key, data FROM kv WHERE bucket = $1', [bucket]);
    for (const r of kv.rows) st[r.key] = r.data;
    return { st, empty: !rec.rows.length && !kv.rows.length };
  }

  async function open(bucket, { file, defaults = {} }) {
    const state = {};
    let snap = new Map(); // "r|coll|id" or "k|key" -> JSON string last persisted
    const filePath = file || path.join(dataDir, bucket + '.db');

    const fill = (obj) => { for (const k of Object.keys(state)) delete state[k]; Object.assign(state, JSON.parse(JSON.stringify(defaults)), obj); };
    const snapshot = () => {
      const m = new Map();
      for (const [k, v] of Object.entries(state)) {
        if (isRecordArray(v) && v.length) for (const it of v) m.set(`r|${k}|${it.id}`, JSON.stringify(it));
        else m.set(`k|${k}`, JSON.stringify(v));
      }
      return m;
    };

    async function load() {
      if (kind === 'postgres') {
        const { st, empty } = await readPg(bucket);
        if (empty && fs.existsSync(filePath)) {
          // first start on PostgreSQL: import the existing JSON data file once
          fill(JSON.parse(fs.readFileSync(filePath, 'utf8')));
          snap = new Map();
          await persist(true);
          fs.renameSync(filePath, filePath + '.imported-' + Date.now());
          log.log(`[db] imported ${bucket} data from ${path.basename(filePath)} into PostgreSQL`);
          return;
        }
        fill(st);
      } else {
        let obj = {};
        try { obj = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw new Error(`Corrupt data file ${filePath}: ${e.message}`); }
        fill(obj);
      }
      snap = snapshot();
    }

    // Rebuild memory from the last successfully persisted snapshot (works even when the database is down)
    function revert() {
      const obj = {};
      for (const [key, json] of snap) {
        if (key[0] === 'r') { const coll = key.split('|')[1]; (obj[coll] || (obj[coll] = [])).push(JSON.parse(json)); }
        else obj[key.slice(2)] = JSON.parse(json);
      }
      for (const v of Object.values(obj)) if (isRecordArray(v)) v.sort((a, b) => a.id - b.id);
      fill(obj);
    }

    let chain = Promise.resolve();
    function persist(force) {
      const run = async () => {
        const cur = snapshot();
        const up = [], del = [], kvUp = [], kvDel = [];
        for (const [key, json] of cur) if (force || snap.get(key) !== json) (key[0] === 'r' ? up : kvUp).push([key, json]);
        for (const key of snap.keys()) if (!cur.has(key)) (key[0] === 'r' ? del : kvDel).push(key);
        if (!up.length && !del.length && !kvUp.length && !kvDel.length) return 0;
        if (kind === 'postgres') {
          const c = await pool.connect();
          try {
            await c.query('BEGIN');
            for (let i = 0; i < up.length; i += 400) {
              const part = up.slice(i, i + 400), vals = [], args = [];
              part.forEach(([key, json], j) => { const [, coll, id] = key.split('|'); vals.push(`($1,$${j * 3 + 2},$${j * 3 + 3},$${j * 3 + 4}::jsonb,now())`); args.push(coll, +id, json); });
              await c.query(`INSERT INTO records (bucket,coll,id,data,updated_at) VALUES ${vals.join(',')}
                ON CONFLICT (bucket,coll,id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`, [bucket, ...args]);
            }
            for (const key of del) { const [, coll, id] = key.split('|'); await c.query('DELETE FROM records WHERE bucket=$1 AND coll=$2 AND id=$3', [bucket, coll, +id]); }
            for (const [key, json] of kvUp) await c.query(`INSERT INTO kv (bucket,key,data,updated_at) VALUES ($1,$2,$3::jsonb,now())
              ON CONFLICT (bucket,key) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`, [bucket, key.slice(2), json]);
            for (const key of kvDel) await c.query('DELETE FROM kv WHERE bucket=$1 AND key=$2', [bucket, key.slice(2)]);
            await c.query('COMMIT');
          } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
        } else {
          const tmp = filePath + '.tmp';
          fs.writeFileSync(tmp, JSON.stringify(state));
          fs.renameSync(tmp, filePath);
          const bkDir = path.join(dataDir, 'backups'); fs.mkdirSync(bkDir, { recursive: true });
          const bk = path.join(bkDir, `${bucket}-${new Date().toISOString().slice(0, 10)}.bak`);
          if (!fs.existsSync(bk)) {
            fs.copyFileSync(filePath, bk);
            fs.readdirSync(bkDir).filter((f) => f.startsWith(bucket + '-') && f.endsWith('.bak')).sort().slice(0, -14).forEach((f) => fs.unlinkSync(path.join(bkDir, f)));
          }
        }
        snap = cur;
        return up.length + del.length + kvUp.length + kvDel.length;
      };
      const guarded = async () => { try { return await run(); } catch (e) { revert(); throw e; } };
      const p = chain.then(guarded, guarded);
      chain = p.catch(() => {});
      return p;
    }

    await load();
    return {
      state,
      save: () => persist(false),
      reload: async () => { await chain; await load(); },
    };
  }

  async function health() {
    if (kind !== 'postgres') return { db: 'json', ok: true };
    try { await pool.query('SELECT 1'); return { db: 'postgres', ok: true }; } catch (e) { return { db: 'postgres', ok: false, error: e.message }; }
  }
  async function close() { if (pool) await pool.end(); }
  return { kind, init, open, health, close };
};
