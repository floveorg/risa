// v2-d1 · API Worker sobre D1 — identidad, actividad, favoritos, búsqueda (f1SS)
// y webhook de Telegram. Enruta `/api/*` a D1 y delega el resto al Worker de
// subdominios (worker.mjs), que sigue igual.
//
// Despliegue (ver worker/README.md):
//   npx wrangler d1 create risa-d1
//   npx wrangler d1 execute risa-d1 --remote --file=worker/migrations/0001_initial.sql
//   npx wrangler secret put CLAIM_SECRET
//   npx wrangler deploy

import subdomainWorker from './worker.mjs';

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
});
const err = (msg, status = 400) => json({ ok: false, error: msg }, status);

// Dev-auth: en modo desarrollo (sin CLAIM_SECRET) el bearer 'devris' vale,
// para que el demo de marcflove funcione sin configurar secretos. En
// producción exige el CLAIM_SECRET real.
const authed = (env, request) =>
  request.headers.get('authorization') === 'Bearer ' + (env.CLAIM_SECRET || '')
  || (!env.CLAIM_SECRET && request.headers.get('authorization') === 'Bearer devris');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ── API ──────────────────────────────────────────────────────────────
    if (url.pathname.startsWith('/api/')) {
      const db = env.DB;
      const [base, ...rest] = url.pathname.slice(5).split('/');
      const method = request.method;

      // GET /api/users/:username — perfil agregado (marcflove simple · maria avanzada)
      if (base === 'users' && rest[0] && method === 'GET') {
        const user = await db.prepare(
          'SELECT * FROM identities WHERE username = ?').bind(rest[0]).first();
        if (!user) return err('usuario no encontrado', 404);
        const act = await db.prepare(
          'SELECT app, item_id, title, tags, kind, at FROM activity WHERE key = ? ORDER BY at DESC')
          .bind(user.key).all();
        const favs = await db.prepare(
          'SELECT app, item_id, at FROM favs WHERE key = ? ORDER BY at DESC').bind(user.key).all();
        return json({
          ok: true, key: user.key, username: user.username, name: user.name,
          bio: user.bio, email: user.email, socials: JSON.parse(user.socials || '[]'),
          recover: JSON.parse(user.recover || '[]'), tier: user.tier, claimed_at: user.claimed_at,
          activity: act.results, favorites: favs.results
        });
      }

      // GET /api/search?q= — búsqueda full-text (f1SS) sobre search_fts
      if (base === 'search' && method === 'GET') {
        const q = (url.searchParams.get('q') || '').trim();
        if (q.length < 2) return json({ ok: true, results: [] });
        const like = '%' + q.toLowerCase() + '%';
        // FTS5 + fallback LIKE (FTS5 necesita tokenización; LIKE es universal).
        const rows = await db.prepare(
          `SELECT s.item_id, s.app, s.title, s.tags, s.name, a.key
           FROM search_fts s LEFT JOIN activity a ON a.app = s.app AND a.item_id = s.item_id
           WHERE lower(s.title) LIKE ? OR lower(s.tags) LIKE ? OR lower(s.name) LIKE ?
           ORDER BY s.name LIMIT 20`).bind(like, like, like).all();
        return json({ ok: true, q, results: rows.results });
      }

      // GET /api/activity/:key — actividad cruzada de un autor
      if (base === 'activity' && rest[0] && method === 'GET') {
        const rows = await db.prepare(
          'SELECT app, item_id, title, tags, kind, at FROM activity WHERE key = ? ORDER BY at DESC')
          .bind(rest[0]).all();
        return json({ ok: true, key: rest[0], activity: rows.results });
      }

      // GET /api/favs/:key — favoritos en la nube (feed real)
      if (base === 'favs' && rest[0] && method === 'GET') {
        const rows = await db.prepare(
          'SELECT app, item_id, at FROM favs WHERE key = ? ORDER BY at DESC').bind(rest[0]).all();
        return json({ ok: true, key: rest[0], favorites: rows.results });
      }

      // POST /api/fav — añadir favorito { key, app, item_id } (dev: Bearer claim-secret)
      if (base === 'fav' && method === 'POST') {
        if (!authed(env, request)) return err('no autorizado', 401);
        const b = await request.json().catch(() => ({}));
        if (!b.key || !b.app || !b.item_id) return err('faltan key/app/item_id');
        await db.prepare('INSERT OR REPLACE INTO favs (key, app, item_id, at) VALUES (?,?,?,?)')
          .bind(b.key, b.app, b.item_id, new Date().toISOString().slice(0, 10)).run();
        return json({ ok: true });
      }

      // GET /api/aliases/:key — aliases públicos (+ privados solo si auth).
      if (base === 'aliases' && rest[0] && method === 'GET') {
        const rows = await db.prepare('SELECT alias, private FROM aliases WHERE key = ? ORDER BY created_at')
          .bind(rest[0]).all();
        const ok = authed(env, request);
        const aliases = rows.results
          .filter((a) => !a.private || ok)
          .map((a) => ({ alias: a.alias, private: !!a.private }));
        return json({ ok: true, key: rest[0], aliases });
      }

      // POST /api/aliases — crear alias { key, alias, private? }
      if (base === 'aliases' && method === 'POST') {
        if (!authed(env, request)) return err('no autorizado', 401);
        const b = await request.json().catch(() => ({}));
        if (!b.key || !b.alias) return err('faltan key/alias');
        await db.prepare('INSERT OR IGNORE INTO aliases (key, alias, private, created_at) VALUES (?,?,?,?)')
          .bind(b.key, String(b.alias).slice(0, 40), b.private ? 1 : 0,
                new Date().toISOString().slice(0, 10)).run();
        return json({ ok: true });
      }

      // POST /api/profile — editar { username, name?, bio?, socials?, email? }
      if (base === 'profile' && method === 'POST') {
        if (!authed(env, request)) return err('no autorizado', 401);
        const b = await request.json().catch(() => ({}));
        const user = await db.prepare('SELECT * FROM identities WHERE username = ?')
          .bind(b.username || '').first();
        if (!user) return err('usuario no encontrado', 404);
        await db.prepare(
          'UPDATE identities SET name=?, bio=?, email=?, socials=?, updated_at=? WHERE key=?')
          .bind(b.name != null ? b.name : user.name,
                b.bio != null ? b.bio : user.bio,
                b.email != null ? b.email : user.email,
                b.socials != null ? JSON.stringify(b.socials) : user.socials,
                new Date().toISOString().slice(0, 10), user.key).run();
        return json({ ok: true, username: user.username });
      }

      // POST /api/ingest — replica clips → activity + search_fts (llama el cron/bot)
      if (base === 'ingest' && method === 'POST') {
        const b = await request.json().catch(() => ({}));
        const clips = Array.isArray(b) ? b : (b.clips || []);
        if (!clips.length) return err('sin clips');
        for (const c of clips) {
          if (!c.id || !c.app || !c.key) continue;
          await db.prepare(
            'INSERT OR REPLACE INTO activity (key, app, item_id, title, tags, kind, src, at) VALUES (?,?,?,?,?,?,?,?)')
            .bind(c.key, c.app, c.id, c.t || '', c.tags || '', c.kind || 'audio',
                  c.src || null, c.when || new Date().toISOString().slice(0, 10)).run();
          await db.prepare(
            'INSERT OR REPLACE INTO search_fts (item_id, app, title, tags, name) VALUES (?,?,?,?,?)')
            .bind(c.id, c.app, c.t || '', String(c.tags || '').replace(/[;,]/g, ' '), c.name || '').run();
        }
        return json({ ok: true, ingested: clips.length });
      }

      // POST /api/tg — webhook de Telegram (avisos al instante, §6c)
      if (base === 'tg' && method === 'POST') {
        const secret = env.TG_WEBHOOK_SECRET || '';
        if (!secret || url.searchParams.get('secret') !== secret) return err('unauthorized', 401);
        const body = await request.json().catch(() => ({}));
        const updateId = body.update_id;
        if (updateId != null) {
          const existing = await db.prepare('SELECT update_id FROM updates WHERE update_id = ?')
            .bind(updateId).first();
          if (existing) return json({ ok: true, dup: true });
          await db.prepare('INSERT OR IGNORE INTO updates (update_id, status, at) VALUES (?,?,?)')
            .bind(updateId, 'received', new Date().toISOString()).run();
        }
        await db.prepare('INSERT INTO pending_updates (update_id, payload, at) VALUES (?,?,?)')
          .bind(updateId ?? 'unknown', JSON.stringify(body), new Date().toISOString()).run();
        return json({ ok: true, queued: true });
      }

      // GET /api/follows/:key — siguiendo y seguidores de un perfil
      if (base === 'follows' && rest[0] && method === 'GET') {
        const following = await db.prepare(
          'SELECT target, at FROM follows WHERE follower = ? ORDER BY at DESC').bind(rest[0]).all();
        const followers = await db.prepare(
          'SELECT follower, at FROM follows WHERE target = ? ORDER BY at DESC').bind(rest[0]).all();
        return json({ ok: true, key: rest[0], following: following.results, followers: followers.results });
      }

      // POST /api/follows — { key, target } seguir/dejar de seguir (toggle)
      if (base === 'follows' && method === 'POST') {
        if (!authed(env, request)) return err('no autorizado', 401);
        const b = await request.json().catch(() => ({}));
        if (!b.key || !b.target || b.key === b.target) return err('faltan key/target');
        const existing = await db.prepare(
          'SELECT 1 FROM follows WHERE follower = ? AND target = ?').bind(b.key, b.target).first();
        if (existing) {
          await db.prepare('DELETE FROM follows WHERE follower = ? AND target = ?')
            .bind(b.key, b.target).run();
          return json({ ok: true, following: false });
        }
        await db.prepare('INSERT OR IGNORE INTO follows (follower, target, at) VALUES (?,?,?)')
          .bind(b.key, b.target, new Date().toISOString().slice(0, 10)).run();
        return json({ ok: true, following: true });
      }

      // POST /api/reactions — { app, item_id, reaction } emoji rápido (público, best-effort)
      if (base === 'reactions' && method === 'POST') {
        const b = await request.json().catch(() => ({}));
        if (!b.app || !b.item_id || !b.reaction) return err('faltan app/item_id/reaction');
        await db.prepare('INSERT OR IGNORE INTO reactions (app, item_id, reaction, at) VALUES (?,?,?,?)')
          .bind(b.app, b.item_id, String(b.reaction).slice(0, 8),
                new Date().toISOString().slice(0, 10)).run();
        return json({ ok: true });
      }

      // POST /api/plays — { app, item_id } reproducción (público, best-effort)
      if (base === 'plays' && method === 'POST') {
        const b = await request.json().catch(() => ({}));
        if (!b.app || !b.item_id) return err('faltan app/item_id');
        const at = new Date().toISOString().slice(0, 10);
        await db.prepare('INSERT OR IGNORE INTO plays (app, item_id, at) VALUES (?,?,?)')
          .bind(b.app, b.item_id, at).run();
        return json({ ok: true });
      }

      // GET /api/notifications/:key — avisos sin leer (respuestas, seguidores)
      if (base === 'notifications' && rest[0] && method === 'GET') {
        const rows = await db.prepare(
          'SELECT id, kind, ref, at FROM notifications WHERE key = ? ORDER BY at DESC LIMIT 20')
          .bind(rest[0]).all();
        return json({ ok: true, key: rest[0], notifications: rows.results });
      }

      // POST /api/notify-pref — { key, replies: 0|1 } activar/desactivar avisos
      if (base === 'notify-pref' && method === 'POST') {
        if (!authed(env, request)) return err('no autorizado', 401);
        const b = await request.json().catch(() => ({}));
        if (!b.key) return err('falta key');
        await db.prepare('INSERT OR REPLACE INTO notify_prefs (key, replies) VALUES (?,?)')
          .bind(b.key, b.replies ? 1 : 0).run();
        return json({ ok: true, replies: !!b.replies });
      }

      // POST /api/replies — { app, parent, content, name? } respuesta rápida de la web
      if (base === 'replies' && method === 'POST') {
        const b = await request.json().catch(() => ({}));
        if (!b.app || !b.parent || !b.content) return err('faltan app/parent/content');
        const itemId = 'rq_' + Math.random().toString(36).slice(2, 10);
        await db.prepare(
          'INSERT OR IGNORE INTO replies (app, parent, item_id, kind, content, name, at) VALUES (?,?,?,?,?,?,?)')
          .bind(b.app, b.parent, itemId, 'quick', String(b.content).slice(0, 80),
                String(b.name || 'Anónima').slice(0, 40), new Date().toISOString().slice(0, 10)).run();
        return json({ ok: true, item_id: itemId });
      }

      return err('ruta no encontrada', 404);
    }

    // ── Fuera de /api: el Worker de subdominios de siempre ───────────────
    return subdomainWorker.fetch(request);
  }
};
