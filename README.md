# Reader

Una lista **diaria** de lectura curada por Claude: cada mañana, entre 10 y 20 noticias
que merece la pena leer enteras. Tech, ciencia y long-form, en **español de España**.

Es una página **HTML estática** servida por **GitHub Pages** y curada por un cron de
**GitHub Actions**. No hay servidor.

## Cómo funciona

```
scripts/feeds.json   ─► lista de fuentes (RSS/Atom)
scripts/curate.mjs   ─► descarga feeds, Claude selecciona/traduce/resume
                        └─► escribe data/latest.json y data/archive/AAAA-MM-DD.json
index.html           ─► lee data/latest.json y lo presenta
.github/workflows/   ─► cron diario que ejecuta la curación y hace commit
```

1. El workflow descarga todos los feeds y reúne los candidatos de las últimas ~48 h.
2. Envía título + extracto de cada candidato a Claude, que actúa de **editor**:
   descarta clickbait y refritos, elige las mejores piezas, las traduce al castellano
   y escribe para cada una un titular, un resumen de tarjeta y un *digest* de varios
   párrafos.
3. Completa las imágenes que falten leyendo el `og:image` del artículo.
4. Escribe `data/latest.json`, hace commit y push. GitHub Pages publica el cambio.

## Interfaz

- **iPhone-first**, vertical. Funciona en escritorio, pero el objetivo es el móvil.
- **Home = deck horizontal**: una tarjeta a pantalla completa por noticia, con
  `scroll-snap` horizontal. Swipe izquierda/derecha. Nada de scroll vertical infinito.
- **Tarjeta**: imagen a sangre + overlay con gradiente, fuente en color de acento,
  fecha, titular grande y 2–3 líneas de resumen. Toca para abrir.
- **Vista de artículo**: fondo claro, cuerpo en serif, paginado horizontal con CSS
  columns (se pasa como páginas). Botón flotante de volver e indicador de página.
- **Imágenes**: se cargan con `referrerpolicy="no-referrer"`. Si una falla, la tarjeta
  queda oscura y el texto sigue siendo legible.

## Puesta en marcha

1. **Secret**: en *Settings → Secrets and variables → Actions*, añade
   `ANTHROPIC_API_KEY` con tu clave de la API de Anthropic.
2. **GitHub Pages**: en *Settings → Pages*, sirve desde la rama que prefieras
   (raíz `/`). El sitio es esta carpeta tal cual; `.nojekyll` evita el procesado Jekyll.
3. **Primer disparo**: ve a la pestaña *Actions → Curación diaria → Run workflow*
   para generar la primera lista sin esperar al cron.

El cron corre a las **06:10 UTC** (`.github/workflows/curate.yml`). Ajusta el horario
o el modelo (`CLAUDE_MODEL`, por defecto `claude-sonnet-4-6`) a tu gusto.

> `data/latest.json` viene con datos de muestra para que la interfaz se vea desde el
> primer momento; la primera ejecución de la Action los reemplaza por noticias reales.

## Personalizar

- **Fuentes**: edita `scripts/feeds.json`. Cada entrada lleva `source`, `topic`
  (`tech` | `ciencia` | `long-form`), `lang` y `url`. Los feeds que fallen se omiten
  sin romper la ejecución; pon `"disabled": true` para desactivar uno.
- **Criterio editorial / tono**: ajusta `SYSTEM_PROMPT` en `scripts/curate.mjs`.
- **Ventana temporal y volumen**: variables de entorno `MAX_AGE_HOURS`,
  `MAX_CANDIDATES`, o las constantes `MIN_ITEMS` / `MAX_ITEMS`.

## Probar en local

```bash
npm install
ANTHROPIC_API_KEY=sk-... npm run curate     # genera data/latest.json real
python3 -m http.server 8000                 # y abre http://localhost:8000
```
