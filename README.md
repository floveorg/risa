# Risa Liberada — bot

Serverless Telegram moderation bot for [Risa Liberada](https://flove.org). People DM their
laugh to **@RisaLiberadaBot**; a fixed welcome message greets them («Comparte tu risa con todos
aquí. Graba tu risa (y dale a enviar), elige visibilidad y descríbela, envía, (moderación),
recibe notificación de publicación en @risaliberada y risa.liberada.net»), and every audio opens a *draft*
card: **✏️ Título** + **🏷️ Tags** in one row, attribution (**👤 Usuario telegram** and
**🙂 Autor** are multi-select, **🙈 Anónimo** overrides both) in another, and **✅ Enviar** in
a third. Tags are free text (comma-separated). Files are capped at 10 MB / 1000 s.
Once sent, moderators approve/reject in the private group *Risas Nuevas* — the mod message
carries the title + tags as hashtags (searchable in Telegram). Approved clips are uploaded
to **Cloudflare R2** and indexed in `risa.json` (`src` = R2 URL, plus `t` title and `tags`),
and posted to the public channel [t.me/risaliberada](https://t.me/risaliberada) with the clip
title attached. On approval the bot tells the uploader what they submitted (title, tags,
name) — no media link. Clips wait for a moderator decision (no auto-publish).
Runs on a GitHub Actions cron — no server.

Audio — the community-uploaded laugh clips **and** the seed laugh library — lives on Cloudflare
R2, never in git; the repo holds only the metadata (`risa.json`, each entry's `src` is an R2 URL)
and the bot code. The seed clips play straight from their R2 seed path.

Paquete descargable: **`risa2.zip`** (regenerable con `./build-risa-zip.sh`).

---

## Índice

1. [Arquitectura del repo](#1-arquitectura-del-repo)
2. [Web app](#2-web-app)
3. [Manual de uso — el entorno real](#3-manual-de-uso--el-entorno-real)
4. [Versionado y releases](#4-versionado-y-releases)
5. [Changelog](#5-changelog)

---

## 1. Arquitectura del repo

- `bot/logic.mjs` — pure update->actions logic (tested)
- `bot/telegram.mjs` — thin Bot API client
- `bot/r2.mjs` — zero-dep SigV4 signed upload (audio → Cloudflare R2)
- `bot/poll.mjs` — orchestrator run each cron tick
- `.github/workflows/poll.yml` — the cron
- Data: `risa.json` (published clips, newest-first), `state/` (offset + queue + drafts)
- `worker/` — Cloudflare Workers: subdominios + API D1 (v2-d1; ver [el plan](#4-versionado-y-releases) y `worker/README.md`)

### Secretos (GitHub Actions repository secrets, nunca commiteados)

- `TELEGRAM_BOT_TOKEN` — the @RisaLiberadaBot token
- `TG_ID_SECRET` — salt for the obfuscated Telegram-id hash (sha256) stored in `state/queue.json`; the id itself is never committed in the clear. DM ids in `state/drafts.json` and `state/.uploaders.json` are persisted **obfuscated** (`encChatId`: XOR with a key derived from `TG_ID_SECRET`, reversible only with the secret) so the cron keeps draft state between runs without leaking ids.
- `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT`, `R2_BUCKET`, `R2_PUBLIC_BASE` — Cloudflare R2 upload

Note: free-tier scheduled workflows are best-effort (5–15 min latency; they pause after
60 days of no repo activity — any push resets that).

License of published clips: **CC BY-SA 4.0**.

## 2. Web app

The risa web app (`index.html` + the rishaman demos) lives at the repo root. Its media — the app
photos (`media/`, including the logo family under `media/logos`) and the personal
gallery (`categorias/`) — is synced to Cloudflare R2 under `risa/…` by `bot/sync-media.mjs`
(.github/workflows/sync-media.yml), and the pages reference those absolute R2 URLs. The app is
served at https://risa.liberada.net (GitHub Pages of this repo) and fetches
this repo's `risa.json` feed as its published-risas data.

---

## 3. Manual de uso — el entorno real

**Versión del paquete:** v1.0.0 · **nombre interno:** *Nick as tag* — tu nickname
se convierte en tu etiqueta (tag-url `#/u/<key>`) y, con permiso, en tu
subdominio `<username>.liberada.net`.

Este manual cubre el entorno real: la web (`risa.liberada.net`), el circuito
Telegram (subir → moderar → publicar) y la miniapp de perfil. Para montar una
réplica desde cero ver las secciones [Arquitectura del repo](#1-arquitectura-del-repo)
y [Versionado y releases](#4-versionado-y-releases).

### 3.1 La web — risa.liberada.net

- **Playlists.** «Risas del mundo» (biblioteca libre de Commons) y «Risas de la
  gente» (lo que la comunidad sube). Un reproductor comparte play/pausa,
  anterior/siguiente y lista de pistas.
- **Chips de etiquetas.** Pulsa un chip para filtrar la playlist; el botón `+`
  revela más etiquetas flotantes (hasta 60). Busca por título, etiqueta o
  nombre en el campo de búsqueda.
- **Favoritos.** La estrella ⭐ guarda tus risas en tu navegador (filtro local).
- **Página de autor `#/u/<key>`.** Cada clip publica enlaza a la página del
  autor con todas sus risas. Si el autor activó su subdominio, el botón
  «Username →» lleva a `<username>.liberada.net`.

### 3.2 El bot — @RisaLiberadaBot

En un chat privado con el bot:

| Comando | Qué hace |
|---|---|
| `/start` | Bienvenida con las reglas (1 min · 10 MB · 5/día) |
| `/entrar` | Abre tu perfil (miniapp) o pide un código para la web |
| `/mejorar` | Novedades del proyecto |
| `/usuario <nombre>` | Tu subdominio `<nombre>.liberada.net` |
| `/name <nombre>` | Tu nombre público |
| `/pub` | Mostrar u ocultar tu @ de Telegram en la web |
| `/me` · `/stats` · `/status` | Tu página, stats y estado del circuito |
| `/latest` · `/random` · `/trending` | Explorar el feed |
| `/play` | Reproducir el feed |

#### Subir una risa

1. Graba una **nota de voz** o un **vídeo** de máx. 1 min (10 MB).
2. El bot abre una tarjeta de borrador: edita **título** y **etiquetas**, elige
   la visibilidad (**👤 Usuario telegram**, **🙂 Autor**, **🙈 Anónimo**) y
   pulsa **✅ Enviar**.
3. Un moderador la revisa; si entra, se publica en @risaliberada y en la web.
   Recibirás el aviso con el enlace a tu página y la oferta de subdominio:
   **Sí, quiero / No sé / No, seguro** (opt-in, nunca automático).

#### Moderación (grupo privado)

- **✅ Publicar** / **🗑 Borrar** / **✏️ Editar** (propuesta con visto bueno del
  autor). También por palabra en una respuesta: «ok», «sí», «no», «borrar»…

### 3.3 Miniapp de perfil — risa.liberada.net/#/entrar

- Pide un **código de 6 dígitos** con `/entrar` en el bot («Código por el bot»).
- El código se liga a tu identidad (hash, nunca tu id en claro) y caduca al
  final del día.
- Con el código ves tu perfil: nombre público, subdominio y el panel
  **«Activa tu perfil en <tu>.liberada.net»** (Editar · bio extendida · juega y
  filtra). El enlace redirige a tus últimas risas en tu nuevo perfil.
- Editar se aplica desde el bot (`/name`, `/usuario`); el email como vía de
  recuperación llega pronto.

### 3.4 Datos y privacidad

- El feed es `risa.json` (repo público): `id · t · name · tags · src · when ·
  tg · key`. Nunca contiene ids de Telegram en claro.
- El id real queda tras un **hash salado** (`TG_ID_SECRET`); la identidad
  pública es tu nombre/palabra más la `key`.
- Licencia de cada pieza: **CC BY-SA 4.0** («Enviar = consentir»).
- Audios y vídeos viven en **Cloudflare R2** con URL pública; el repo solo
  guarda el metadato.

### 3.5 Mantenimiento y fallos

- El circuito corre con un **cron de GitHub Actions** (5–10 min); si se para,
  cualquier push al repo lo reactiva.
- `state/` guarda offset y cola; `state/drafts.json` y `state/.uploaders.json`
  son locales y no se publican.
- Secretos (nunca en el repo): `TELEGRAM_BOT_TOKEN`, `TG_ID_SECRET`, `R2_*`.

---

## 4. Versionado y releases

Política de versiones del repo `floveorg/risa`: **v1 = producción**, **v2 = desarrollo**.

> **Estado actual: v1.0.3 cortada y CONGELADA como pack v1** (2026-08-18,
> «Nick as tag»). El paquete descargable `risa103.zip` es el
> snapshot definitivo de v1 (incluye versión, ciclo de release, manual y todo
> el circuito). **Espíritu v1 congelado**: un solo perfil como tag
> (`#/u/<key>`); identidad/claims/perfiles avanzados viven en la rama de
> desarrollo `v2-d1` (Cloudflare D1 + Workers), que evoluciona aparte.
> Futuras actualizaciones de la descarga v1 = fixes o mejoras no
> fundamentales, cada una como `v1.0.x` (changelog + bump + tag + `./build-risa-zip.sh`).

### 4.1 Dos versiones, un solo repo de producción

| | v1 | v2 |
|---|---|---|
| Qué es | **Producción estable** — lo que sirve `risa.liberada.net` y el circuito Telegram (subir·moderar·publicar). | **Desarrollo** — flove central: authy completo, `central/users/<key>/`, lovy, Railway/libSQL. |
| Dónde vive | Este repo (`floveorg/risa`), rama `main`. | Plan `…/risaliberada/plan-v2.md` (D20). **No se corta aquí.** |
| Estado | Congelado salvo **fixes** + adelantos v1.x (D21): Mini App, favoritos por aprobación, edición de lo propio. | En curso; risa migra a v2 cuando **lovy** pruebe estabilidad. |

### 4.2 Esquema de versiones

`v1.x.y` (semántico):

- **MAJOR (1)**: fijo en producción. Un `v2` es otra línea de vida (flove central),
  no un bump de MAJOR en este repo.
- **MINOR (x)**: adelantos v1.x (D21) — p. ej. v1.1.0 (Mini App + favoritos), v1.2.0 (edición de lo propio). Cada adelanto corta su propia release.
- **PATCH (y)**: cada **fix** de producción. **Cada fix corta su propia release**:
  entrada en la [sección Changelog](#5-changelog) + bump en `config.json` + tag `v1.x.y`.

### 4.3 Contrato de retrocompatibilidad

La regla que hace seguro publicar sin romper nada:

- **`risa.json` es el contrato de datos hacia la web.** La web **nunca exige**
  campos nuevos: `clipsOf`/`flagsOf` aceptan array u objeto `{schema, clips}`
  (y `{flag, clips}`); `buildRisaTracks` rellena defaults
  (`tags → 'risa libre'`, `tg/key → ''`, título derivado). Un clip viejo sin
  `key`/`tg`/`authy` se sigue renderizando.
- **Formato del feed: `{ "schema": "risa-feed/1", "clips": […] }`** (v1.0.2).
  Migración explícita y retrocompatible: la web y el bot leen con `clipsOf`
  (array u objeto) y el bot escribe siempre el objeto con `schema`. El campo
  `schema` es informativo (la web lo ignora); `clips` es la lista newest-first.
- El bot **no quita** campos que la web usa: `name`, `src`, `tags`, `when`, `t`.
  Los campos authy (`key`, `tg`, …) son aditivos y opcionales.
- `state/` (`offset.txt`, `queue.json`) y `risa.json` viven en el repo: cualquier
  cambio de **formato** es una migración explícita (no silenciosa) y entra como fix
  con su changelog.
- Bot API de Telegram: la versión del runtime del workflow queda pined; cambios de
  API = fix + changelog.

### 4.4 Release logics (cómo se corta una release v1)

1. **Entrada en la [sección Changelog](#5-changelog)** bajo `## [v1.x.y]` (solo si no existe) y el fix
   documentado en su sección.
2. **Bump `version` en `config.json`** (misma cadena que el tag).
3. **Commit + tag `v1.x.y`** en `floveorg/risa` (el tag y el push también reactivan
   el cron si llevara >60 días parado).
4. **Actualizar `risaliberada.md`** (estándar): `Versión` = el tag nuevo.
5. **Push** (quien corta la release): subir rama + tag a GitHub — GitHub Pages
   sirve `risa.liberada.net` y el `risa.json`; el pointer del submodule en el repo
   fuente de flove se sincroniza aparte (toca solo `updaty-web`/publish si hiciera).

#### Qué NO es una release
- Un cambio de v2 en el plan **no** toca este repo ni su versionado.
- Cambios de `risa.json` (clips reales) **no** son releases: son contenido.

### 4.5 Verificación antes de una release

- `node --test` verde (funciones puras del bot + web + authy).
- `npx html-validate index.html` (si se tocó la web) o al menos el flujo de
  etiquetas/feed sano en el navegador.
- La web tolera un `risa.json` sin campos nuevos (contrato §4.3).
- **CI en el workflow de release (tag)** (questy Q003): `node --test` + `html-validate`
  corren en el tag antes de publicar — no dependen de la memoria del mantenedor.

---

## 5. Changelog

Registro de cambios de **Risa Liberada** (repo `floveorg/risa`).
Formato [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) ·
versionado `v1.x.y` · política de versiones y retrocompatibilidad en la
sección [Versionado y releases](#4-versionado-y-releases).

> **v1.0.0 cortada.** «Nick as tag»: tu nickname se convierte en tu etiqueta
> (tag-url `#/u/<key>`) y, con permiso, en tu subdominio `<username>.liberada.net`.
> El paquete descargable incluye versión, ciclo de release y el manual de uso.

### [Unreleased] — hito: Abstracting the bot

**El formulario de detalles ya no se pierde (crítico).** Antes, mandar una
risa con otra aún en borrador solo decía «termínala o cancélala» — sin
botones y sin guardar la nueva; y si la ficha se había borrado del chat, el
formulario desaparecía para siempre. Ahora:

- La risa nueva **se guarda** y el bot pregunta con botones: «✏️ Abrir mi
  borrador» (reabre la ficha con título/tags/Enviar), «🆕 Usar esta nueva»
  (cambia el borrador a la risa recién mandada) o «✖️ Cancelar borrador».
- Si editar la ficha falla porque el mensaje ya no existe («message to edit
  not found»), el bot **la reenvía como mensaje nuevo** automáticamente — el
  error 404 se autorepara y el formulario siempre vuelve.
- /welcome ofrece «✏️ Abrir mi borrador» cuando tienes uno abierto.

**Bot más rápido.** El cron pasa de cada 10 a cada 5 minutos (el retardo que
veías era la cadencia del cron de GitHub Actions, no el bot en sí).

**Barra Encima.** El botón muestra ⏸ mientras suena (un clic pausa) y ▶️ en
pausa; ⏹ para y rebobina el clip al principio.

**Encima: el guía baja al 66%.** Al mezclar, el micrófono graba también el
original que suena en el dispositivo; el guía se reproduce al 66% de volumen
para que tu voz quede por encima sin saturar. Un solo ajuste: lo que oyes es
lo que se graba (bajar el guía, no el micro).

**UI pulida.** Barra superior fija al hacer scroll; buscador centrado con
botón ↻ de recarga a su lado (mismo diseño, mitad de tamaño); la búsqueda
filtra de verdad por título · autor · etiquetas (nuevo `player.search()` en
el player central); las sugerencias solo proponen etiquetas que existen en el
feed y teclean 3× más lento (sin «→ #etiqueta»); pestañas Liberada v1 / v2 /
Flove v3 funcionales; «Quiero» despliega el contacto (`risa@liberada.net`);
tarjetas técnicas reordenadas (Node+Telegram primero) y a igual altura.

**Encima sin fricción: barra acoplada + bot honesto.** El modal de remix
desaparece: un clic en «Encima» pone el clip a sonar **en bucle**, abre el bot
a la vez (`?start=remix_<id>`) y deja una **barra acoplada** que sobrevive al
salto al bot y a recargar la página (vuelve pausada, lista para reanudar).
⏹ la quita; 🤖 reabre el bot; ▶️/🔊 pausa. El guía **sigue sonando** mientras
grabs en el bot: la idea es grabar tu risa *encima* del original (en iPhone
el sistema pausa al salir de la página).

Tres bugs del bot arreglados (con regresión en `bot/test/poll.test.mjs`):

- **El deep link remix mentía con borrador abierto**: `remix-start` /
  reenvío apuntaban `pendingParent` sobre un borrador ya abierto y «Enviar»
  publicaba con el padre VIEJO. Ahora el intent se aplica al borrador abierto
  (se re-renderiza su ficha) y, como red de seguridad, `draft-send` honra
  cualquier `pendingParent` pendiente.
- **«↳ Responde a: q_823…»**: la ficha del borrador mostraba el id crudo;
  ahora lleva el título del clip (`parentTitle`) en todas las vías.
- **«✖️ Cancelar» no cancelaba**: solo limpiaba flags y el borrador seguía
  bloqueando nuevas subidas; ahora borra el borrador de verdad.

Arreglado también el icono de volumen truncado (error de consola SVG).

**Hito: poll.mjs se divide en módulos responsables.** El monolito de 1248 líneas
se separa en cuatro archivos con responsabilidades claras:

- **bot/publish.mjs** — subida a R2, feed RSS, publicación en canal, commit git.
- **bot/drafts.mjs** — helpers de UI, teclados, textos, gestión de aliases.
- **bot/ingest.mjs** — loop de polling de Telegram, carga/guardado de estado.
- **bot/poll.mjs** — orquestador fino que importa de los tres módulos.

Migraciones D1 reestructuradas: `0001_schema.sql` (puro esquema) separado de
los seeds (`worker/seed/dev/`). Los archivos 0001-0006 originales marcados
SUPERSEDED. `wrangler.toml` con instrucciones de setup. Admin ban anotado
como pendiente para v2-D1 en `plans/PLAN-V2-D1.md`.

### [v2.1.0] — 2026-08-19 · hito: Calling libs (rama `v2-central`)

**Hito: risa/index deja el monolito y se construye sobre `central/shared/code`**
(`flove-feed` · `flove-tags` · `flove-player` · `flove-bottom-nav` ·
`flove-sound` · `flove-app`). La versión anterior queda congelada como **v2.0.0**;
la descarga canónica es **`risa2.zip`** (siempre la última Risa 2.x.x, cortadas
futuras `risa2.0.1`, `risa2.1.3`, …).

- **Index nuevo sobre las libs centrales**: el driver `FloveApp` (antes
  `risa-app.js`) vive ahora en `central/shared/code/js/flove-app.js`; GENTE y
  RISAS DEL MUNDO llaman al mismo código.
- **Menú del logo reparado**: el dropdown `#brand-dd` abría/cerraba `hidden`
  pero el CSS solo reacciona a `.open`; ahora `setDD()` conmuta `.open` +
  `aria-expanded`.
- **Media toggle acumulativo**: audio y vídeo son checks independientes (ambos →
  todo, ninguno → todo); y arreglado el bug que vaciaba la playlist: `select()`
  alimenta `allTracks` para que el filtro media trabaje sobre lo seleccionado.
- **Risas del mundo vuelve a la playlist curada**: se readjunta el scrapped de
  Wikimedia Commons (contagiosa · carcajada · pícara · risita · mundo) tal cual
  estaba en liberada v1, vía `sc.clips` (fuente propia de la sección); fuera de
  ahí los clips subidos por el bot.
- **Tags contenidas**: las chips flotantes ya no derivan hacia el borde de la
  playlist (rango de deriva acotado en `flove-tags`).
- **En las listas, el enlace «original»** aparece tras las etiquetas y lleva a
  la url del clip.
- **Descarga `risa2.zip`**: empaqueta la última Risa 2.x.x con las libs
  centrales incluidas (rutas relativas `central/shared/code/…`), lista para
  abrir sin checkout de flove.

### [v2.0.0] — 2026-08-19 · versión anterior congelada

La versión previa al hito Calling libs: `index.html` monolítico (todo inline,
sin libs centrales), playlists scrapped de Commons, menú de logo presente.
Congelada como punto de partida del changelog 2.x (véase la sección
[Web app](#2-web-app)).

### [v1.1.0] — 2026-08-19 · hito: navegación de contenidos en la web

**Hito de frontend: la web es ahora un navegador de contenidos** (hilos,
vídeo, deep links y tabs), no una lista plana de audios.

- **Hilos como sección de comentarios**: respuestas anidadas con profundidad,
  colapsadas por defecto con contador, flecha `↳` grande que expande/colapsa, y
  reproducción en profundidad (una respuesta suena antes que su hermano).
- **Vídeo de primera clase**: `Aahh` (mp4) se muestra y reproduce en su zona del
  clip, con enlace «Video/Cerrar», proporción natural (sin barras), abierto por
  defecto sin autoplay, y al terminar la playlist continúa con el siguiente clip.
  Los sub-clips se comportan igual que los padres (título→etiquetas, autor→perfil).
- **Deep links por clip** `#/c/<id>` con resaltado en el hilo; las tarjetas de
  «Cadenas» de los perfiles enlazan al clip original.
- **Tabs planos** (Ohm · Común · Cultura · Ciencia · Tech) sin scroll lateral;
  Tech recuperada como pestaña; idioma/tema en el menú.
- **Bot**: pie de canal «en respuesta a» con enlace al original; `/perfil` y
  `/notify on|off`; confirmación de subida en un solo mensaje.
- **Comunidad nativa D1** (0007): follows · reacciones · plays · avisos ·
  respuestas rápidas (endpoints `/api/*` listos para desplegar).

### [v1.0.7] — 2026-08-18 · usuarios reales (imaginarios) + cadenas + subdominios

- **Cinco usuarios de la comunidad (demos con nombre español)** sustituyen a los
  demos de juguete (`contagiosa` · `carcajada` · `mundo`): **Ana Pérez**, **Carlos
  Ruiz**, **Laura Díaz**, **Pedro López** y **Sofía Torres**. Cada uno tiene perfil
  agregador propio (`liberada.net/usa/<user>/`), bio, redes y aliases públicos.
  Se retira la etiqueta «Demo 😄» de esos perfiles.
- **Clips de «Risas del mundo» subidos como respuestas en cadenas del feed.**
  14 clips de Commons se añaden a `risa.json` con `parent` sobre clips reales
  (Risa Maliciosa · Aahh · Surreal · Nosnormal), formando 4 hilos anidados de
  hasta 3 niveles. El feed las muestra indentadas y la pestaña Cadenas de cada
  perfil pinta el hilo completo en el que participa (los ajenos se ven atenuados).
- **Audio de las playlists reparado**: los ficheros `risa/seed/audio/*` nunca se
  subieron a R2 (404). Todas las playlists (contagiosa · carcajada · pícara ·
  risita · mundo) y el perfil de maria ahora apuntan a las fuentes con licencia
  en Wikimedia Commons (`Special:FilePath/…`), reproducibles sin espejo R2.
- **Subdominios automáticos**: la plantilla de perfil resuelve el usuario desde
  el `Host` (`<user>.liberada.net`) además del path, y el Worker sirve la
  plantilla genérica para cualquier username de `usernames.json` sin carpeta
  propia — el opt-in del bot (Sí al subdominio) ya activa el enlace de autor.
- **maria/marcflove**: se quita el salto forzoso a `<user>.liberada.net` (que
  caía en página de error sin DNS); el `index.html` raíz de liberada.net
  redirige ahora cualquier subdominio CNAMEado al perfil del usuario.
- `risa.json` + `risa.xml`/`atom.xml` regenerados (28 clips).

### [v1.0.6] — 2026-08-18 · fix: vídeo-notas circulares no reconocidas

- **Los vídeo-notas («mantener pulsado», círculo) se ignoraban en silencio.**
  `parseUpdates` solo miraba `msg.voice | msg.audio | msg.video`; un
  `msg.video_note` caía fuera y el bot no creaba borrador. Ahora se tratan como
  vídeo (`video: true`), se comprimen a MP4 al publicar y entran en el circuito.
- Test añadido; `risa103.zip` regenerado.

### [v1.0.5] — 2026-08-18 · fix: flujo de borrador (título/tags/autor/enviar)

- **El borrador se perdía entre corridas del cron.** `state/drafts.json` y
  `state/.uploaders.json` estaban en `.gitignore`: cada ejecución de Actions
  arrancaba sin borradores, así que al pulsar «Enviar», «Autor»… no se
  encontraba el borrador (botones muertos) y los textos de título/tags caían en
  la bienvenida.
- **Fix**: esos dos ficheros se persisten ahora en el repo con los **ids de
  chat ofuscados** (`encChatId`/`decChatId`: XOR con clave derivada de
  `TG_ID_SECRET`, reversible solo con el secret — nunca en claro), y el cron
  los conserva entre corridas. El flujo completo subir→editar→enviar funciona.
- Tests `encChatId/decChatId` añadidos; `risa103.zip` regenerado.

### [v1.0.4] — 2026-08-18 · fix crítico: el bot no respondía

- **El bot @RisaLiberadaBot no procesaba mensajes.** Desde v1.0.2,
  `bot/poll.mjs` importaba `clipsOf` de `./logic.mjs`, que **no lo exportaba**
  (vive en `risa.js`) → el bot moría al arrancar (`SyntaxError`) y el cron de
  Actions fallaba en cada tick: nadie respondía y las updates quedaban
  pendientes.
- **Fix**: `clipsOf` (extracción array u `{schema,clips}` del feed) añadido a
  `logic.mjs` con su test. El bot vuelve a procesar: verificado localmente
  (procesó la update pendiente y avanzó el offset).
- `risa103.zip` regenerado con el fix.

### [v1.0.3] — 2026-08-18 · **pack v1 congelado**

- **Pack descargable congelado**: `risa103.zip` es el paquete
  definitivo de v1 — todo el circuito «Nick as tag» tal como está en `main`
  (web single-file con **i18n es/en** y tema, miniapp, subdominios opt-in,
  RSS/Atom, CI, a11y axe 0, schema `risa-feed/1`). A partir de aquí, **v1 no
  cambia su espíritu**: un solo perfil como tag (`#/u/<key>`), nada de
  identidad/claims — eso vive en `v2-d1`.
- Las actualizaciones futuras de la descarga v1 serán **fixes o mejoras no
  fundamentales** (texto, UX, a11y, accesibilidad) que no toquen el núcleo;
  cada una corta su propia release `v1.0.x` y regenera el pack con
  `./build-risa-zip.sh`.

### [v1.0.2] — 2026-08-18 · a11y · feeds · CI · schema

- **Auditoría axe completa: 0 violaciones** (antes 69). `<h1>` sr-only,
  `aria-label` en las 10 secciones (regiones), y `--persimmon` oscurecido a
  `#c03610` por contraste WCAG AA.
- **RSS/Atom del feed**: `build-rss.mjs` genera `risa.xml` + `atom.xml`
  (RSS 2.0 y Atom 1.0); el bot los regenera al publicar y se enlazan en el
  `<head>` de la web.
- **og:image PNG real**: `media/logos/15-guino.png` (512×512, renderizado del
  mark SVG) en vez del SVG que varía según plataforma.
- **CI de tests en cada push/PR**: `.github/workflows/test.yml` corre
  `node --test`, `node --check` y `html-validate` (gate automático, no solo en
  release).
- **Schema explícito en `risa.json`**: formato `{ "schema": "risa-feed/1",
  "clips": […] }`, retrocompatible (la web y el bot leen con `clipsOf`; el bot
  escribe siempre el objeto). Migración documentada en la sección
  [Versionado](#4-versionado-y-releases).

### [v1.0.1] — 2026-08-18 · pulido de la release

- **Paquete descargable** ahora incluye las imágenes locales que la web
  referencia por ruta relativa (diagramas, QR y fotos de réplica) y el
  `.htmlvalidate.json` — la web se ve completa offline.
- **html-validate limpio**: `.htmlvalidate.json` (regla `prefer-native-element`
  off, igual que solo) + `aria-label` en los enlaces del modal Mejorar
  (`unique-landmark`).
- **Copy actualizada**: subdominio «opt-in (Sí quiero)» en lugar de
  «automático · sin_claim»; comandos de perfil (`/entrar`, `/mejorar`,
  `/usuario`, `/pub`) en la lista de features; suite de tests «91 verdes».
- **README** referencia el manual y el paquete descargable.

### [v1.0.0] — 2026-08-18 · «Nick as tag»

#### v1 · producción (release v1.0.0)

##### Añadido

- **Circuito serverless completo**: subir (DM @RisaLiberadaBot) → moderar
  (grupo privado ✅ Publicar / 🗑 Borrar / ✏️ Editar) → publicar (ffmpeg →
  Cloudflare R2 → `risa.json` newest-first → canal público) · cron GitHub Actions.
- **Subida identificada**: palabra + hash salado (`idHash`) u id directo
  (`idDirect`), o anónima. El id en claro jamás viaja en el repo
  (`state/.uploaders.json` gitignored; `queue.json` solo lleva hash/id).
- **Clips con `key` (presencia L2)** → el nombre enlaza a `#/u/<key>` y una
  **mini-página de autor** agrega todas sus risas.
- **Opt-in C19**: enlace a `t.me` solo si el autor lo elige (`tg_public`), nunca
  automático. `/name` en DM para la palabra reclamada.
- **Inline mode** (`@RisaLiberadaBot <query>`): búsqueda de clips por título,
  tags y nombre de autor; compartir en cualquier chat como audio. Requiere
  webhook para funcionar de forma fiable (v2).
- **Vídeo**: soporte para notas de vídeo ≤ 1 min (mismos límites que audio).
- **Páginas de autor**: `#/u/<key>` agrega todos los clips de un autor.
- **Anti-abuso**: máx 60 s · 10 MB · 5 en cola y 5/día por remitente (hash);
  tope de feed en la web.
- **`/pub`** en DM: re-preguntar visibilidad del enlace a Telegram.
- **`/name`** en DM: establecer o cambiar la palabra de display.
- **Moderação mejorada**: botón ✏️ Editar para cambiar título/tags antes de
  publicar.
- **Subdominio de autor opt-in**: tras la primera publicación el bot ofrece
  `<usuario>.liberada.net` con «Sí, quiero / No sé / No, seguro»; el alta solo
  ocurre con «Sí, quiero» (ya no se auto-crea). «No sé» vuelve a preguntar en
  la siguiente publicación; «No, seguro» lo calla para siempre. En el aviso de
  publicación: «Puedes encontrar todas tus risas juntas en este enlace: …» +
  «Activa gratis: <usuario>.liberada.net (Editar)».
- **`/usuario <nombre>`** en DM: cambiar el nombre del subdominio.
- **`/entrar`** en DM y menú web «Entrar»: acceso a la miniapp de perfil
  (`#/entrar`) con opciones de código (por el bot ahora, por email próximamente).
- **`/mejorar`** en DM y menú web «Mejorar» (modal): novedades — subdominio,
  editar perfil, más apps; «tu perfil redirigirá a tus risas allí».
- **Miniapp `#/entrar`**: código de 6 dígitos que da el bot (ligado a la key,
  caduca al final del día) para identificar quién eres y ver tu perfil con tus
  risas juntas.
- **Bienvenida del bot** empieza con «Comparte tu risa con todos aquí.»
- **Título y descripción web** renombrados a «Risa liberada · Respira, escucha,
  disfruta» / «Playlists de risas, cultura y comunidad.» (preview al compartir).
- **Subdominios seedeados**: `usernames.json` con `marcflove` y `maria`, de modo
  que `marcflove.liberada.net` / `maria.liberada.net` redirigen ya al perfil
  agregador; los nuevos usuarios se registran solos con el opt-in.
- **Presencia estable del bot**: `setMyDescription`/`setMyShortDescription`/
  `setMyCommands` y `setChatDescription` de canal y grupo de moderación — el
  enlace a la miniapp (`#/entrar`) queda fijo en las descripciones.
- **Miniapp terminada**: tras autenticar con el código, muestra el panel «Activa
  tu perfil en <tu>.liberada.net» con (Activar), la nota de redirección a tus
  últimas risas y el acceso a tus risas en risa.liberada.net.

##### Corregido

- **Etiquetas sin fluir (chips flotantes muertos)**: el refactor de identidad
  authy reintrodujo la declaración duplicada de `floveOn`/`floveAllowed` en
  `index.html`; el `SyntaxError` tumbaba el bloque de script entero (playlist,
  chips, fetch y mini-página nunca se inicializaban). Se elimina la duplicación
  y las etiquetas vuelven a fluir.
- **Espacio de etiquetas nunca vacío en silencio**: si `risa.json` no llega
  (sin servidor, `file://`, offline), `buildTagChips()` se ejecuta igual y se
  muestra un aviso claro en vez de un espacio en blanco (el fallo ya no parece
  un script muerto).
- **Tests sincronizados al esquema authy** (`key` en `buildRisaTracks`) + test
  dedicado de la key L2.

##### Eliminado

- **`authy.js`**: eliminado; la identidad v1 se resuelve con `key` + hash salado
  en `logic.mjs`. La capa completa authy (claim L2→L3, niveles L3–L5) queda
  para v2 (plan-v2.md).

##### Seguridad

- La identidad de Telegram **nunca** se renderiza en la web: solo la palabra/`key`.
  El claim (L2→L3) es v2 y se resuelve por DM con verificación de id.

#### v2 · desarrollo

- flove central: authy completo (claim L2→L3, filespace `central/users/<key>/`,
  perfiles de autor), lovy, y Railway + libSQL. Plan:
  `development/standards/risaliberada/plan-v2.md`
  (D20: risa NO migra a v2 hasta que lovy pruebe estabilidad).
- **No** se corta en este repo: aquí solo entran fixes de producción.

#### v3 · desarrollo

- Pendiente (ver estándar `development/standards/risaliberada/risaliberada.md`,
  sección «Réplica del sistema»: versiones *Agentes*, *Introducción* y
  *Desarrollo*).