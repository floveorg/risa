# Risa v2-d1 · Cloudflare D1 + Workers

Rama de desarrollo **`v2-d1`** (no sigue plan-v2.md). Enciende una capa
**aditiva** sobre el circuito v1: la web sigue leyendo `risa.json`, el bot
sigue corriendo en el cron de Actions y R2 sigue sirviendo los audios. Lo que
añade v2-d1 es un **SQL local gestionado (D1) + endpoints (Workers)** para lo
que un feed estático no puede: cuentas, búsqueda, actividad y edición.

> **Estado de la infra (native settings):** `worker/wrangler.toml` con binding
> D1 (`DB`), `worker/migrations/0001_initial.sql` (esquema + seed marcflove
> simple · maria avanzada), `worker/api.mjs` (API D1 + fallback al Worker de
> subdominios) y `worker/README.md` (pasos nativos: d1 create, execute, secrets,
> deploy). La web (`index.html`) mantiene su navegación y suma, en v2-d1,
> búsqueda fina vía `/api/search` y favoritos a un feed real vía `/api/fav`
> (fail-silent cuando la API no está).

Regla de oro heredada de v1: **`risa.json` es la verdad de lectura de la web;**
D1 es el nuevo canónico de escritura y `risa.json` queda como read-model que el
Workers regenera. Si D1/Workers se apaga, v1 sigue sirviendo (base de
recuperación).

> **Pendiente de plan:** alineación de reacciones/respuestas en clips sin
> hilo (§6d) — necesita exponer el grafo de hilos desde D1 antes de unificar
> el render de clips.

---

## 1. Arquitectura

```
Telegram bot (cron Actions, v1) ──▶ R2 (audios) ──▶ risa.json (read-model)
        │                                                │
        ▼                                                ▼
  Workers API (v2-d1) ◀───────────────▶ D1 (canónico)  GitHub Pages (web)
        │                                                      │
        └──── addons: búsqueda · actividad · perfiles ────────▶ fetch risa.json
```

- **Workers** publican `/api/*` en `risa.liberada.net` (mismo dominio que la
  web → sin CORS).
- **D1** guarda lo que `risa.json` no puede: claims de identidad, favoritos
  por clave, actividad por app, búsqueda FTS, borradores de edición.
- El bot (v1) sigue escribiendo `risa.json` como hoy; un Workers opcional lo
  **replica a D1** (idempotente) para que los addons no dependan del feed.

## 2. Esquema D1 (mínimo, por tablas)

```sql
-- Identidad: la key (hash salado) es el id de autor, nunca en claro.
CREATE TABLE identities (
  key        TEXT PRIMARY KEY,      -- hash salado (v1) o id futuro
  username   TEXT UNIQUE,           -- subdominio <user>.liberada.net
  name       TEXT,                  -- nombre público
  bio        TEXT DEFAULT '',
  email      TEXT,                  -- vía de recuperación (opt-in)
  socials    TEXT DEFAULT '[]',     -- JSON [{net,url}]
  recover    TEXT DEFAULT '[]',     -- vías: bot · email
  claimed_at TEXT,
  updated_at TEXT
);

-- Actividad: una fila por pieza publicada en cualquier app de liberada.
CREATE TABLE activity (
  key     TEXT,                     -- autor (hash)
  app     TEXT,                     -- risa | ama | lovy | ...
  item_id TEXT,                     -- id en el feed de la app
  at      TEXT,
  PRIMARY KEY (app, item_id)
);
CREATE INDEX idx_act_key ON activity(key, at DESC);

-- Favoritos (multi-app) y actividad local sincronizada.
CREATE TABLE favs (
  key     TEXT,
  app     TEXT,
  item_id TEXT,
  at      TEXT,
  PRIMARY KEY (key, app, item_id)
);

-- Búsqueda full-text (addon f1SS).
CREATE VIRTUAL TABLE search_fts USING fts5(
  item_id, app, title, tags, name, content='activity'
);
```

## 3. Endpoints Workers (`/api/*`)

| Método y ruta | Qué hace | Quién |
|---|---|---|
| `GET  /api/users/<username>` | perfil agregado (identity + actividad + socials) | web / agregador |
| `POST /api/claim` | claim de identidad (código del bot, 1 solo uso) | miniapp |
| `POST /api/profile` | editar nombre, bio, socials (requiere claim válido) | miniapp / bot |
| `POST /api/recover` | añadir email / vías de recuperación | miniapp |
| `POST /api/fav` · `GET /api/favs/<key>` | favoritos en la nube (sincronizan las playlists) | web |
| `GET  /api/search?q=` | f1SS: búsqueda full-text sobre `search_fts` | web / bot |
| `GET  /api/activity/<key>` | actividad cruzada de apps (juega y filtra) | perfiles |
| `POST /api/ingest` | replica `risa.json` → D1 (idempotente, llama el cron) | bot |

## 4. Addons propuestos

- **f1SS search** — búsqueda full-text (FTS5) sobre títulos, tags y nombres;
  la web mantiene su buscador actual como fallback sin red.
- **Favoritos en la nube** — la estrella ⭐ deja de ser solo local: con claim,
  se sincroniza entre dispositivos y se comparte por URL.
- **Actividad cruzada** — «juega y filtra»: el perfil agrega risas + amas + lo
  que juegues en otras apps liberada (powered by `activity`).
- **Perfiles editables** — nombre, bio extendida y redes desde la miniapp con
  claim de identidad (código del bot / email), no solo con comandos.
- **Cadenas enriquecidas** — hilos con contexto en D1 (el `parent` de v1 queda
  intacto; D1 añade conteo y vista).
- **Webhooks reales** — Workers con webhook de Telegram en vez de solo cron:
  avisos al autor al instante, rate-limit y cola gestionada.

## 5. Tunings para el HTML y el flujo actuales

La v1 es **un solo HTML sin build + git como base de datos**. v2-d1 debe
respetar eso, no romperlo:

1. **La web sigue siendo estática y sin build.** Los addons se activan por
   fetch condicional a `/api/*` con timeout y fail-silent (mismo patrón que
   `flove.json`): si el Workers calla, la página queda idéntica.
2. **`risa.json` = read-model garantizado.** El Workers regenera `risa.json`
   desde D1 tras cada escritura (o el cron lo hace); nunca al revés.
3. **Claim sin tocar el bot.** El flujo de código que ya tiene el bot
   (`codes.json` → key) se mantiene; Workers valida el código y emite un
   token de corta vida para `/api/*`.
4. **Una tabla `activity` por app.** Cada app (risa, ama, lovy) replica su feed
   a D1 con `POST /api/ingest`; el perfil agregador las mezcla sin tocar sus
   HTML.
5. **Favoritos: primero local, luego nube.** Sin claim la estrella sigue
   funcionando local (como hoy); con claim se sincroniza. No exige nada nuevo
   en el HTML hasta que el usuario se autentique.
6. **Búsqueda con dos niveles.** `GET /api/search` cuando hay red; el filtro
   local actual cuando no la hay. La UI no cambia: un solo input.
7. **R2 sigue siendo el almacén de medios**; D1 nunca guarda blobs, solo
   metadatos e índices. Misma política de coste cero (D1 gratis hasta
   ~5 M lecturas/mes; Workers gratis 100k peticiones/día).
8. **Moderación intacta en v1.** El grupo de moderadores y el bot no cambian;
   D1 solo añade auditoría opcional (quién aprobó, cuándo).
9. **Ban de usuarios (pendiente v2-D1).** El admin del grupo de moderación
   podría banear usuarios via `/ban @username` — nueva tabla `banned_users`
   en D1 + check en el bot antes de aceptar uploads. No en v1.

## 6b. Hilos y navegación profunda (v2-d1)

v1 ya tiene hilos reales: `parent` en `risa.json`, orden depth-first
(`threadOrder`), conectores visuales y el flujo «reenvía el clip → responde»
en el bot (`clipByChannelMsg` + `hasAncestor` contra ciclos). v2-d1 lo lleva a
una **navegación más interactiva y profunda visualmente** sin tocar el esquema:

- **Vista árbol de ramas.** En la página de autor y en la playlist, un clip con
  respuestas despliega un árbol colapsable: ramas por autor, profundidad visual
  (indentación + conector), y botón «seguir la rama» que filtra a esa línea.
- **Modo foco.** Clic en un clip → vista centrada con el contexto del padre
  (preview), sus respuestas y las de los siguientes: navegación por flechas
  entre nodos (arriba/abajo), sin salir de la página.
- **Previews de padre.** En el feed plano, las respuestas muestran un chip
  «↳ responde a <título>» que abre un mini-preview del padre en el propio
  reproductor (sin recargar la lista).
- **Contadores y reacciones en el árbol.** D1 (`activity` + tabla nueva
  `threads`) agrega cuántas respuestas tiene cada nodo, quién las dio y desde
  qué app — el árbol pasa a ser «actividad viva», no solo estructura.
- **Búsqueda dentro de hilos (f1SS).** `search_fts` indexa cada nodo; buscar
  un título devuelve también la **posición en su hilo** (subir/bajar).
- **Story / modo lector.** Un hilo completo como tarjeta continua (nodos
  encadenados con su audio), ideal para «leer» una conversación de risas de
  principio a fin y compartirla por URL (`#/t/<id-del-hilo>`).

Todo vive **encima** de v1: el feed sigue siendo `risa.json` y el esquema
`parent` no cambia; D1 solo añade la vista y los contadores.

## 6c. Webhook real (avisos al instante)

El v1 corre solo con cron (getUpdates cada 5–10 min). v2-d1 añade un **webhook**
de Telegram en el Workers para los avisos en tiempo real, con el cron como
**respaldo** (si el webhook falla, el cron sigue vaciando la cola):

- `POST /api/tg` (Webhook handler) — verifica `X-Telegram-Bot-Api-Secret-Token`
  (mismo secreto en `setWebhook`), procesa updates con la misma
  `parseUpdates` pura y devuelve acciones al bot que corresponda.
- `setWebhook` se configura una vez (script `bot/set-webhook.mjs`):
  `https://risa.liberada.net/api/tg?secret=<token>`; `drop_pending_updates`
  solo en el primer despliegue.
- **Avisos al instante**: al aprobarse una risa, el autor recibe el mensaje en
  segundos (no en el próximo tick); el canal y el grupo de moderación se
  actualizan igual de rápido.
- **Rate-limit y cola en D1**: tabla `updates` (update_id, status, at) para
  idempotencia compartida entre webhook y cron; `update_id` único evita
  duplicados si ambos procesan a la vez.
- **Fallback**: si `/api/tg` devuelve error, el cron sigue corriendo; el
  `offset` del cron y el del webhook comparten la misma cola (nunca procesan
  el mismo update dos veces).
- El bot v1 **no cambia**: solo se añade el handler Workers + el script de
  `setWebhook`. El webhook puede encenderse app a app (risa primero).

## 6d. Dificultad-bug: alineación de `.react-chip` / `.reply-btn` en clips SIN respuestas

> **Estado:** documentado para planificar — NO arreglado. Antes de tocar el
> frontend, hay que actualizar las tablas D1 (ver §6d.5) para que la reparación
> sea limpia y no parche a trozos.
> **Fecha:** 2026-08-20 · **Afecta:** risa (y maria vía `flove-media.css`).

### 6d.1 Síntoma (lo que ve el usuario)

En los clips de la lista que **tienen respuestas** (cadena), el chip de
reacciones (emoji) y el botón `+` (responder) quedan **pegados a la derecha**
de la tarjeta. En los clips **sin respuestas**, esos dos botones **no quedan
alineados a la derecha**: se quedan colgando a la izquierda de donde deberían,
como si el espacio flexible no se repartiera.

```
✓ con respuestas:     [▶]  Título ……………        [🤣] [+]
✗ sin respuestas:     [▶]  Título ……………  [🤣] [+]        ← hueco a la derecha
```

### 6d.2 Por qué es una "dificultad" (y no un bug de una línea)

El renderizador **no produce la misma estructura** según si el clip tiene o no
respuestas, y el CSS depende de esa diferencia estructural. Los dos caminos
viven en `central/shared/code/js/flove-player.js` → `buildLi()`:

#### Camino A — clip CON respuestas (`toggleLine` presente)

```
<li class="tgl">
  <div class="clip-card">            ← caja flexible con padding
    <div class="thread-item">        ← flex fila; .ti{flex:1} empuja a la derecha
      <span class="tag dl">▶</span>
      <span class="ti">Título …</span>
      … react-chip + reply-btn        ← pegados a la derecha ✓
    </div>
  </div>
  <div class="thread-toggle-line">…</div>
</li>
```

#### Camino B — clip SIN respuestas (sin `toggleLine`)

```
<li>                                 ← el propio <li> es la caja (sin .clip-card)
  <div class="thread-item">          ← flex fila; .ti{flex:1} empuja a la derecha
    <span class="tag dl">▶</span>
    <span class="ti">Título …</span>
    … react-chip + reply-btn          ← NO empujan: .ti no ocupa todo el ancho ✗
  </div>
</li>
```

El **`li` base** de risa tiene su propio `display:flex; align-items:center;
gap:10px; padding:5px 12px` (línea 200 de `index.html`), y `.thread-item`
tiene `width:100%` (línea 600). Pero en el camino B el `li` es a la vez
contenedor flex **y** borde/padding de la tarjeta: el `.thread-item` (único
hijo) con `width:100%` debería llenarlo, y sin embargo el `flex:1` del `.ti`
no estira hasta el borde derecho porque el contexto flex de risa deja el
`thread-item` con `gap` interno que no se compensa con el `padding` del `li`.

En el camino A, el `.clip-card` **sí** tiene `display:flex; align-items:center;
gap:10px; padding:5px 12px; width:100%` (línea 374), y el `thread-item` con
`width:100%` queda dentro de ese flex con `padding` resuelto — por eso ahí
funciona.

**Conclusión del diagnóstico:** el alineado correcto en B depende de que
`li` no sea el contenedor estético + el flex del `thread-item` a la vez. Son
dos roles que chocan. La solución "parche" sería añadir `margin-left:auto` al
`.react-chip`/`.reply-btn` en el camino B o forzar `.ti{flex:1}` con un fix
de especificidad — todo eso es exactamente el tipo de parche que luego rompe
otra vista (maria, el feed, las páginas de autor).

### 6d.3 Evidencia de medición (headless, 2026-08-20)

Render local de `risa/index.html` con Chrome headless (`--dump-dom`) y feed
inyectado. Medidas de `getBoundingClientRect()` sobre los clips del camino B:

```
tiRight:       100px   (distancia del borde derecho del <li> al borde del .ti)
reactRight:     51px   (el chip de emoji NO llega al borde: 51px de hueco)
replyRight:     14px   (el botón + sí llega: 14px = padding 12 + borde 2)
```

Es decir: **el `+` sí se pega a la derecha, el emoji chip no.** Ese hueco de
~37px entre `.react-chip` y `.reply-btn` es el `gap` + el ancho mal
repartido del `flex:1` del `.ti` en el contexto B. En el camino A ese hueco
no existe porque `.clip-card` media el layout.

### 6d.4 Por qué arreglarlo bien exige tocar la base de datos primero

El frontend decide **qué camino** usa según `tree.children.get(cid)` →
`kids.length` (`flove-player.js:201-223`), y `cid` viene de `t.clip.id`. Esa
información de "¿tiene respuestas?" se deriva hoy de:

- `risa.json` (feed estático): **no** lleva `parent`/`depth` de forma fiable
  para todas las piezas (solo algunas filas de demo tienen `threads`).
- `threads` (tabla D1, `0001_initial.sql:48-54`): guarda `item_id, parent,
  app, depth`, pero **no** se sirve a la web en el render (la web lee
  `risa.json`; el Workers la replica, no la expone).
- `reactions` / `replies` (D1 `0007_community.sql:16-22, 50-59`): existen en
  la API (`/api/reactions`, `/api/replies`) pero **no** hay un endpoint que
  devuelva, para cada clip, "tiene respuestas / es respuesta de / depth".

Sin ese dato consistente por clip, el render no puede elegir el camino A/B de
forma fiable y se queda en el parche estético.

### 6d.5 Trabajo previo en D1 (tablas) para desbloquear la reparación

1. **Exponer el grafo de hilos a la web** — nuevo endpoint `GET /api/threads?app=risa`
   (o ampliar `/api/search`) que devuelva `[{item_id, parent, depth}]` a partir de
   `threads` (+ `replies` como hojas `kind='quick'`), para que el frontend
   construya `tree.children` con datos reales y no con el feed estático.
2. **Normalizar `threads`** — añadir `kind` (`audio|video|quick|text`) y
   `src` opcional, para que un hilo mezcle respuestas de audio y quick-replies
   sin duplicar lógica. Añadir `parent_id` nullable en `replies` para
   anidamiento > 1 nivel.
3. **Relleno** — backfill de `threads` desde `replies` existentes
   (una `replies` sin `threads` = hoja de hilo huérfana hoy).
4. **Seed de demo** — ampliar `0001_initial.sql` (y/o `0007`) con un par de
   cadenas completas (padre + 1-2 respuestas) en `risa` para que el render
   A/B sea comprobable sin producción.

Una vez D1 da `parent/depth` por clip, `buildLi` puede renderizar **una sola
estructura** (camino A con `.clip-card` siempre, o el nuevo contrato único) y
eliminar el camino B divergente — ahí la alineación se arregla de una vez,
para risa y para maria, sin selectores de rescate.

### 6d.6 Archivos y líneas implicadas

| Archivo | Línea | Qué es |
|---|---|---|
| `central/shared/code/js/flove-player.js` | 201-224 | Elección camino A/B en `buildLi` (`toggleLine`/`clip-card`) |
| `central/shared/code/js/flove-feed.js` | 69-119 | `threadOrder` / `buildTree` (derivan hijos por `clip.parent`) |
| `risa/index.html` | 200 | `li` base: flex + padding (contexto del camino B) |
| `risa/index.html` | 217 | `.ti{flex:1}` (el estiramiento que no llega en B) |
| `risa/index.html` | 298-308 | `.reply-btn` y `.react-chip` |
| `risa/index.html` | 374-375 | `.clip-card` (el contexto que funciona en A) |
| `risa/index.html` | 600 | `.thread-item{width:100%}` |
| `central/shared/code/css/flove-media.css` | 68-69, 107 | `.thread-item` compartido + `.thread-item.clip-remix` |
| `risa/worker/migrations/0001_initial.sql` | 48-54 | tabla `threads` |
| `risa/worker/migrations/0007_community.sql` | 16-22, 50-59 | `reactions`, `replies` |
| `risa/worker/api.mjs` | 212-257 | `POST /api/reactions`, `POST /api/replies` (no hay GET de hilos) |
| `maria/index.html` | 13, 38, 159-162 | importa `flove-media.css` + aliases de tokens (blasst radius) |

### 6d.7 Notas para el arreglo final (post-D1)

- **Unificar el render**: siempre `.clip-card` como caja (camino A), con el
  `li` solo como contenedor de grid. Borrar el `li`-como-tarjeta del camino B.
- **`.ti` con `min-width:0`** ya está; asegurar `flex:1 1 0` no `1` a secas
  cuando el contenedor sea el `li` pelado.
- **Verificar en maria** después de tocar `flove-media.css`/`flove-player.js`:
  comparte el render de clips y sus tokens (`--paper-card`, `--app-accent`)
  ya mapeados (maria `index.html:38`).
- **No** añadir `margin-left:auto` suelto: es el parche que este doc quiere
  evitar. El dato de hilos en D1 es el que permite la unificación limpia.

## 6. Hoja de ruta sugerida

1. `worker/` + `wrangler.toml` con rutas `/api/*` y D1 binding (worker ya
   existe para subdominios; se extiende).
2. Migración D1: crear tablas + seed (identities con marcflove y maria).
3. `POST /api/claim` + token; conectar la miniapp `#/entrar`.
4. `POST /api/profile` → el editor del perfil pasa a escribir en D1 (nombre,
   bio, socials) en vez de solo generar comandos.
5. f1SS: `search_fts` + `GET /api/search`; conectar el input de búsqueda.
6. `POST /api/ingest` llamado por el cron del bot tras cada publicación.
7. Favoritos en la nube y actividad cruzada en los perfiles agregadores.

## 7. Comunidad en D1 (0007) — seguir · reacciones · escuchas · avisos · respuestas

Migración `0007_community.sql` + endpoints `/api/*` (nativos en D1):

| Tabla | Uso | Endpoint |
|---|---|---|
| `follows(follower,target,at)` | seguir/dejar de seguir | `GET /api/follows/:key` · `POST /api/follows` |
| `reactions(app,item_id,reaction,at)` | reacción rápida con emoji (pública) | `POST /api/reactions` |
| `plays(app,item_id,at)` | 1 fila por reproducción → trending | `POST /api/plays` (fire-and-forget) |
| `notifications` + `notify_prefs` | avisos de respuestas/seguidores + preferencia | `GET /api/notifications/:key` · `POST /api/notify-pref` |
| `replies(parent,item_id,content)` | respuesta rápida de la web (quick) | `POST /api/replies` |

Principios:
- **Reacciones/escuchas son públicas y best-effort**: la web las manda con
  timeout corto y fail-silent; nunca bloquean la navegación. Sin identidad
  obligatoria (bajo riesgo de spam, mitigable con rate-limit de Cloudflare).
- **El feed sigue siendo estático** (`risa.json`): D1 nunca reemplaza la
  lectura del feed, solo añade la capa de comunidad.

## 8. Principios de bajo consumo (cuota crítica de Cloudflare)

La cuota gratuita de Workers es **100k peticiones/día** (y 10 ms de CPU por
request). Normas para no agotarla:

1. **El app nunca pasa por el Worker.** `risa.liberada.net` (HTML, `risa.js`,
   `risa.json`, media) se sirve en **grey (DNS-only)** desde GitHub Pages. El
   Worker solo ve `api.liberada.net/*` y los subdominios de usuario.
2. **API en subdominio propio**: `api.liberada.net` (proxied). Separar el API
   del sitio hace que navegar por la web = 0 peticiones de Worker.
3. **Perfiles baratos**: el Worker **302-redirige** `<user>.liberada.net` →
   `liberada.net/usa/<user>/` (µs de CPU) en vez de buscar+y servir el HTML.
   Solo hace fetch-and-serve para usuarios sin carpeta estática.
4. **Cache en el borde**: `Cache-Control` + Cache API en GETs de lectura
   (`/api/search`, `/api/users`, `/api/aliases`) y en los perfiles servidos.
   Reintentos idénticos se resuelven desde el edge.
5. **Menos round-trips del cliente**: un solo `GET /api/profile/:user`
   (identidad+actividad+aliases); leer `usernames.json`/`risa.json` estáticos
   primero y solo llamar al API para lo dinámico.
6. **D1 con cabeza**: cachear lecturas, agrupar escrituras; no duplicar el
   feed en `activity` (el feed vive en `risa.json`). D1 gratuito: 5M filas
   leídas/día, 100k escritas/día.
7. **Monitor**: revisar el gráfico de requests/día y poner una alerta de uso
   al ~80% de las 100k.
