#!/usr/bin/env node
/**
 * Reader — curación diaria.
 *
 * 1. Lee scripts/feeds.json y descarga todos los RSS/Atom.
 * 2. Reúne candidatos de las últimas ~48 h (título, fuente, fecha, extracto, imagen).
 * 3. Pide a Claude que seleccione 10–20 piezas según el perfil del lector,
 *    las traduzca al español de España y escriba tarjeta + digest para cada una.
 * 4. Completa imágenes que falten leyendo el og:image del artículo.
 * 5. Escribe data/latest.json y data/archive/AAAA-MM-DD.json.
 *
 * Requiere la variable de entorno ANTHROPIC_API_KEY.
 * Modelo configurable con CLAUDE_MODEL (por defecto claude-sonnet-4-6).
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Parser from "rss-parser";
import Anthropic from "@anthropic-ai/sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const ARCHIVE_DIR = path.join(DATA_DIR, "archive");

const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";
const MAX_AGE_HOURS = Number(process.env.MAX_AGE_HOURS || 48);
const MAX_CANDIDATES = Number(process.env.MAX_CANDIDATES || 130);
const MIN_ITEMS = 10;
const MAX_ITEMS = 20;
const UA = "ReaderCurator/1.0 (+https://github.com; daily reading list)";

// ───────────────────────── utilidades ─────────────────────────

const log = (...a) => console.log("·", ...a);
const warn = (...a) => console.warn("⚠", ...a);

function stripHtml(s = "") {
  return s
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${label}`)), ms)),
  ]);
}

async function fetchText(url, ms = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml" },
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

// ───────────────────────── RSS ─────────────────────────

const parser = new Parser({
  timeout: 15000,
  headers: { "user-agent": UA },
  customFields: {
    item: [
      ["media:content", "mediaContent", { keepArray: true }],
      ["media:thumbnail", "mediaThumb", { keepArray: true }],
      ["content:encoded", "contentEncoded"],
    ],
  },
});

function imageFromItem(item) {
  if (item.enclosure?.url && /^https?:/.test(item.enclosure.url) &&
      (item.enclosure.type || "").startsWith("image")) return item.enclosure.url;
  const mc = item.mediaContent;
  if (Array.isArray(mc)) {
    for (const m of mc) {
      const u = m?.$?.url;
      if (u && (!m.$.medium || m.$.medium === "image" || /\.(jpg|jpeg|png|webp|avif)/i.test(u))) return u;
    }
  } else if (mc?.$?.url) return mc.$.url;
  const mt = item.mediaThumb;
  if (Array.isArray(mt) && mt[0]?.$?.url) return mt[0].$.url;
  else if (mt?.$?.url) return mt.$.url;
  const html = item.contentEncoded || item["content:encoded"] || item.content || "";
  const m = String(html).match(/<img[^>]+src=["']([^"']+)["']/i);
  if (m) return m[1];
  return null;
}

async function collectCandidates(feeds) {
  const cutoff = Date.now() - MAX_AGE_HOURS * 3600 * 1000;
  const out = [];
  const results = await Promise.allSettled(
    feeds.map(async (feed) => {
      const parsed = await withTimeout(parser.parseURL(feed.url), 18000, feed.source);
      const picked = [];
      for (const item of parsed.items || []) {
        const url = (item.link || item.guid || "").trim();
        if (!url || !/^https?:/.test(url)) continue;
        const dateStr = item.isoDate || item.pubDate || "";
        const ts = dateStr ? Date.parse(dateStr) : NaN;
        // long-form puede ser algo más antiguo si es excepcional
        const grace = feed.topic === "long-form" ? 4 : 1;
        if (!isNaN(ts) && ts < cutoff - (grace - 1) * MAX_AGE_HOURS * 3600 * 1000) continue;
        const snippetRaw = item.contentSnippet || stripHtml(item.contentEncoded || item.content || item.summary || "");
        picked.push({
          source: feed.source,
          topic: feed.topic,
          lang: feed.lang || "en",
          url,
          title: stripHtml(item.title || "").slice(0, 240),
          author: item.creator || item.author || "",
          published: !isNaN(ts) ? new Date(ts).toISOString() : "",
          ts: isNaN(ts) ? 0 : ts,
          snippet: snippetRaw.slice(0, 1400),
          image: imageFromItem(item),
        });
      }
      // como mucho 12 por fuente, los más recientes
      picked.sort((a, b) => b.ts - a.ts);
      return picked.slice(0, 12);
    })
  );

  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      log(`${feeds[i].source}: ${r.value.length} candidatos`);
      out.push(...r.value);
    } else {
      warn(`${feeds[i].source}: ${r.reason?.message || r.reason}`);
    }
  });

  // dedup por url y por título normalizado
  const seen = new Set();
  const dedup = [];
  for (const c of out.sort((a, b) => b.ts - a.ts)) {
    const k1 = c.url.split(/[?#]/)[0];
    const k2 = c.title.toLowerCase().replace(/[^a-z0-9áéíóúüñ ]/gi, "").slice(0, 60);
    if (seen.has(k1) || seen.has(k2)) continue;
    seen.add(k1); seen.add(k2);
    dedup.push(c);
  }

  // límite global, manteniendo variedad por tema
  return capByTopic(dedup, MAX_CANDIDATES);
}

function capByTopic(list, cap) {
  if (list.length <= cap) return list;
  const buckets = { tech: [], ciencia: [], "long-form": [] };
  for (const c of list) (buckets[c.topic] || (buckets[c.topic] = [])).push(c);
  const order = ["tech", "ciencia", "long-form"];
  const out = [];
  let i = 0;
  while (out.length < cap) {
    let added = false;
    for (const t of order) {
      const b = buckets[t];
      if (b && b[i]) { out.push(b[i]); added = true; if (out.length >= cap) break; }
    }
    if (!added) break;
    i++;
  }
  return out;
}

// ───────────────────────── Claude ─────────────────────────

const SYSTEM_PROMPT = `Eres el editor de "Reader", una lista diaria de lectura personal. Tu lector es una persona curiosa e informada. Curas, no resumes prensa.

PERFIL DEL LECTOR
- Temas: tech (IA, software, cultura de internet), ciencia (física, biología, espacio, clima, neurociencia) y long-form (ensayo, ideas, libros, crítica).
- Mezcla orientativa: ~40 % tech, ~35 % ciencia, ~25 % long-form. Es una guía, no una cuota: prioriza SIEMPRE lo que de verdad merezca la pena hoy.
- Tono que busca: reportaje original, análisis profundo, ensayo bien escrito. Piezas para leer enteras.

QUÉ RECHAZAR sin contemplaciones
- Clickbait, sensacionalismo, titulares "X anuncia Y" sin análisis.
- Notas de agencia, refritos de notas de prensa, listicles, granjas de contenido generado por IA.
- Piezas vacías, promocionales o meramente noticiosas sin sustancia.

SELECCIÓN
- Elige entre ${MIN_ITEMS} y ${MAX_ITEMS} piezas, las MEJORES del lote. Si no hay suficiente calidad, elige menos: más vale corto y bueno.
- Evita dos piezas casi idénticas sobre el mismo hecho; quédate con la mejor.
- Ordena la lista de mayor a menor interés para abrir el día con lo más fuerte.

ESCRITURA (español de España, natural e idiomático)
- Traduce al castellano de España todo lo que esté en otro idioma. NO traduzcas nombres propios, nombres de producto ni citas que pierdan sentido al traducirse.
- "title": titular en español, claro y sin clickbait (máx. ~90 caracteres).
- "summary": 2–3 frases (máx. ~280 caracteres) que dan ganas de leer y dicen de qué va de verdad. Sin "en este artículo".
- "body": 3 a 6 párrafos breves que destilen la pieza: el qué, el porqué importa y el matiz o ángulo interesante. Es un digest original tuyo en español a partir del extracto disponible, NO una traducción literal ni una copia. No inventes datos que no estén respaldados por el extracto; si el extracto es escaso, sé más conciso.
- "topic": uno de exactamente "tech", "ciencia" o "long-form".

SALIDA
Devuelve EXCLUSIVAMENTE un objeto JSON válido, sin texto antes ni después, sin markdown, con esta forma:
{"items":[{"id":<número del candidato>,"topic":"tech|ciencia|long-form","title":"…","summary":"…","body":["párrafo 1","párrafo 2","…"]}]}`;

function buildUserPrompt(cands) {
  const today = new Date().toISOString().slice(0, 10);
  const lines = cands.map((c, i) => {
    const when = c.published ? c.published.slice(0, 16).replace("T", " ") : "fecha?";
    return `[${i}] (${c.topic}, ${c.lang}) ${c.source} · ${when}
TÍTULO: ${c.title}
EXTRACTO: ${c.snippet || "(sin extracto)"}`;
  });
  return `Fecha de hoy: ${today}. A continuación, ${cands.length} candidatos de los feeds de hoy. Cada uno tiene un id entre corchetes. Selecciona y escribe la lista siguiendo tus instrucciones. Usa el id exacto de cada candidato que elijas.

${lines.join("\n\n")}`;
}

function extractJson(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  let raw = fence ? fence[1] : text;
  const s = raw.indexOf("{");
  const e = raw.lastIndexOf("}");
  if (s === -1 || e === -1) throw new Error("no se encontró JSON en la respuesta");
  return JSON.parse(raw.slice(s, e + 1));
}

async function curateWithClaude(cands) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 8000,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildUserPrompt(cands) }],
  });
  const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const parsed = extractJson(text);
  if (!Array.isArray(parsed.items)) throw new Error("la respuesta no contiene items[]");
  return parsed.items;
}

// ───────────────────────── og:image fallback ─────────────────────────

async function findOgImage(url) {
  try {
    const html = await fetchText(url, 9000);
    const head = html.slice(0, 120000);
    const patterns = [
      /<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
      /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
    ];
    for (const re of patterns) {
      const m = head.match(re);
      if (m && /^https?:/.test(m[1])) return m[1].replace(/&amp;/g, "&");
    }
  } catch (e) {
    warn(`og:image ${hostOf(url)}: ${e.message}`);
  }
  return null;
}

// ───────────────────────── main ─────────────────────────

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Falta ANTHROPIC_API_KEY"); process.exit(1);
  }

  const feedsCfg = JSON.parse(await fs.readFile(path.join(__dirname, "feeds.json"), "utf8"));
  const feeds = feedsCfg.feeds.filter((f) => f.url && !f.disabled);
  log(`Descargando ${feeds.length} feeds…`);

  const cands = await collectCandidates(feeds);
  log(`${cands.length} candidatos únicos tras filtrar y deduplicar.`);
  if (cands.length < MIN_ITEMS) {
    warn("Muy pocos candidatos; continúo igualmente.");
  }
  if (!cands.length) { console.error("Sin candidatos. Aborto."); process.exit(1); }

  log(`Curando con ${MODEL}…`);
  const selected = await curateWithClaude(cands);
  log(`Claude seleccionó ${selected.length} piezas.`);

  // mapear de vuelta a los candidatos por id
  const items = [];
  for (const sel of selected) {
    const c = cands[Number(sel.id)];
    if (!c) { warn(`id inválido devuelto por Claude: ${sel.id}`); continue; }
    items.push({
      id: c.url,
      source: c.source,
      author: c.author || "",
      url: c.url,
      topic: ["tech", "ciencia", "long-form"].includes(sel.topic) ? sel.topic : c.topic,
      published: c.published,
      image: c.image || null,
      title: (sel.title || c.title).trim(),
      summary: (sel.summary || "").trim(),
      body: Array.isArray(sel.body) ? sel.body.map((p) => String(p).trim()).filter(Boolean) : [],
    });
  }

  if (!items.length) { console.error("Tras el mapeo no quedaron items. Aborto."); process.exit(1); }

  // completar imágenes que falten (en paralelo, sólo de los seleccionados)
  const missing = items.filter((it) => !it.image);
  log(`Buscando og:image para ${missing.length} piezas sin imagen…`);
  await Promise.allSettled(missing.map(async (it) => { it.image = await findOgImage(it.url); }));

  const payload = {
    curated_at: new Date().toISOString(),
    model: MODEL,
    count: items.length,
    items,
  };

  await fs.mkdir(ARCHIVE_DIR, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  await fs.writeFile(path.join(DATA_DIR, "latest.json"), JSON.stringify(payload, null, 2) + "\n");
  await fs.writeFile(path.join(ARCHIVE_DIR, `${day}.json`), JSON.stringify(payload, null, 2) + "\n");

  log(`✓ Escrito data/latest.json y data/archive/${day}.json con ${items.length} piezas.`);
  const withImg = items.filter((i) => i.image).length;
  log(`  Imágenes: ${withImg}/${items.length}.`);
}

main().catch((err) => { console.error("Fallo de curación:", err); process.exit(1); });
