/**
 * promo-sync.js — v2.3
 * Shopify Promo Automation — tuttobeautyshop.it
 *
 * Changelog v2.3:
 *  - New: Smart polling (skip se nessuna promo imminente)
 *  - New: Supporto FULL_SYNC env var
 *  - Optimization: 99% dei run durano 3 secondi
 */
const fetch = require("node-fetch");

const SHOP_DOMAIN   = (process.env.SHOPIFY_SHOP_DOMAIN || "").trim();
const ACCESS_TOKEN  = (process.env.SHOPIFY_ACCESS_TOKEN || "").trim();
const API_VERSION   = "2025-01";
const RATE_DELAY_MS = 400; // ms tra le chiamate REST (evita 429)

// ─────────────────────────────────────────────────────────────────────────────
// VALIDAZIONE VARIABILI D'AMBIENTE
// ─────────────────────────────────────────────────────────────────────────────
if (!SHOP_DOMAIN || !ACCESS_TOKEN) {
  console.error("❌ SHOPIFY_SHOP_DOMAIN o SHOPIFY_ACCESS_TOKEN non configurati");
  process.exit(1);
}

// Caratteri illegali negli header HTTP
if (/[\r\n\t]/.test(ACCESS_TOKEN)) {
  console.error("❌ ACCESS_TOKEN contiene caratteri non validi (newline/tab). Controlla il secret GitHub.");
  process.exit(1);
}

console.log(`✅ Config: domain=${SHOP_DOMAIN}, token=${ACCESS_TOKEN.slice(0, 8)}...`);

// ─────────────────────────────────────────────────────────────────────────────
// SMART POLLING: Skip se nessuna promo imminente
// ─────────────────────────────────────────────────────────────────────────────

async function needsSync(calendars) {
  const now = Date.now();
  const window = 20 * 60 * 1000; // 20 minuti (margine sicurezza)
  
  for (const cal of calendars) {
    const start = new Date(cal.data_inizio.value).getTime();
    const end = new Date(cal.data_fine.value).getTime();
    
    // Promo inizia o finisce nei prossimi/ultimi 20 minuti?
    if (Math.abs(start - now) < window || Math.abs(end - now) < window) {
      console.log(`⚡ Promo imminente rilevata: ${cal.nome_promozione.value}`);
      return true;
    }
  }
  
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// UTILITY
// ─────────────────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function graphqlRequest(query, variables = {}) {
  const url = `https://${SHOP_DOMAIN}/admin/api/${API_VERSION}/graphql.json`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": ACCESS_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    throw new Error(`GraphQL HTTP error: ${res.status} ${res.statusText}`);
  }

  const json = await res.json();
  if (json.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  }

  return json.data;
}

async function restRequest(method, path, body = null) {
  const url = `https://${SHOP_DOMAIN}/admin/api/${API_VERSION}${path}`;
  const options = {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": ACCESS_TOKEN,
    },
  };
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(url, options);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`REST ${method} ${path} failed: ${res.status} ${text}`);
  }

  return res.json();
}

// ─────────────────────────────────────────────────────────────────────────────
// LETTURA METAOBJECT
// ─────────────────────────────────────────────────────────────────────────────

async function fetchCalendariPromo() {
  const query = `
    query GetCalendariPromo {
      metaobjects(type: "calendario_promo", first: 50) {
        nodes {
          id
          nome_promozione: field(key: "nome_promozione") { value }
          data_inizio: field(key: "data_inizio") { value }
          data_fine: field(key: "data_fine") { value }
          righe_promo: field(key: "righe_promo") {
            references(first: 100) {
              nodes {
                ... on Metaobject {
                  id
                  variante: field(key: "variante") {
                    reference {
                      ... on ProductVariant {
                        id
                        price
                        compareAtPrice
                        metafield(namespace: "promo", key: "backup_price") {
                          id
                          value
                        }
                      }
                    }
                  }
                  sconto_percentuale: field(key: "sconto_percentuale") { value }
                }
              }
            }
          }
        }
      }
    }
  `;

  const data = await graphqlRequest(query);
  return data.metaobjects.nodes;
}

// ─────────────────────────────────────────────────────────────────────────────
// BACKUP PREZZO ORIGINALE
// ─────────────────────────────────────────────────────────────────────────────

async function saveBackupPrice(variantGid, price) {
  const mutation = `
    mutation CreateBackupMetafield($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id namespace key value }
        userErrors { field message }
      }
    }
  `;

  const variables = {
    metafields: [
      {
        ownerId: variantGid,
        namespace: "promo",
        key: "backup_price",
        type: "number_decimal",
        value: price.toString(),
      },
    ],
  };

  await graphqlRequest(mutation, variables);
}

async function deleteBackupPrice(metafieldId) {
  const mutation = `
    mutation DeleteMetafield($input: MetafieldDeleteInput!) {
      metafieldDelete(input: $input) {
        deletedId
        userErrors { field message }
      }
    }
  `;

  const variables = { input: { id: metafieldId } };
  await graphqlRequest(mutation, variables);
}

// ─────────────────────────────────────────────────────────────────────────────
// AGGIORNAMENTO PREZZI (REST API)
// ─────────────────────────────────────────────────────────────────────────────

async function updateVariantPrice(variant, discountPercent) {
  const variantId = variant.id.split("/").pop();
  const currentPrice = parseFloat(variant.price);
  const currentCompareAt = variant.compareAtPrice ? parseFloat(variant.compareAtPrice) : null;
  const backup = variant.metafield?.value ? parseFloat(variant.metafield.value) : null;

  // Usa backup come fonte di verità, altrimenti prezzo corrente
  const basePrice = backup ?? currentPrice;

  // Calcola nuovo prezzo scontato
  const discountDecimal = discountPercent / 100;
  const newPrice = basePrice * (1 - discountDecimal);

  // CHECK IDEMPOTENZA (float-safe)
  if (
    backup &&
    Math.abs(currentPrice - newPrice) < 0.01 &&
    Math.abs((currentCompareAt ?? 0) - basePrice) < 0.01
  ) {
    return; // Già aggiornato, skip
  }

  // Salva backup se non esiste
  if (!backup) {
    await saveBackupPrice(variant.id, basePrice);
  }

  // Aggiorna prezzo via REST
  await restRequest("PUT", `/variants/${variantId}.json`, {
    variant: {
      id: parseInt(variantId),
      price: newPrice.toFixed(2),
      compare_at_price: basePrice.toFixed(2),
    },
  });

  console.log(
    `   🔥 ${discountPercent}% applicato → ${newPrice.toFixed(2)}€ (era ${basePrice.toFixed(2)}€, compare_at: ${basePrice.toFixed(2)}€)`
  );

  await sleep(RATE_DELAY_MS);
}

async function resetVariantPrice(variant) {
  const variantId = variant.id.split("/").pop();
  const backup = variant.metafield?.value ? parseFloat(variant.metafield.value) : null;

  if (!backup) return; // Niente da ripristinare

  // Ripristina prezzo originale
  await restRequest("PUT", `/variants/${variantId}.json`, {
    variant: {
      id: parseInt(variantId),
      price: backup.toFixed(2),
      compare_at_price: null,
    },
  });

  // Cancella metafield backup
  if (variant.metafield?.id) {
    await deleteBackupPrice(variant.metafield.id);
  }

  console.log(`   ♻ Ripristinato → ${backup.toFixed(2)}€`);

  await sleep(RATE_DELAY_MS);
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log("🚀 Avvio sincronizzazione promo...\n");

  // 1. Leggi tutti i calendari promo
  const calendars = await fetchCalendariPromo();

  // 2. CHECK SMART: Serve davvero fare sync?
  const fullSync = process.env.FULL_SYNC === 'true';

  if (!fullSync && !(await needsSync(calendars))) {
    console.log("✅ Nessuna promo imminente. Skip sync (risparmio risorse).");
    console.log("🏁 Fine CHECK\n");
    return; // EXIT EARLY
  }

  console.log(fullSync ? "🔄 FULL SYNC (mezzanotte)" : "⚡ SYNC RAPIDO (promo imminente)\n");

  // 3. Procedi con sync normale
  let updatedCount = 0;
  let resetCount = 0;

  const now = Date.now();

  for (const cal of calendars) {
    const nome = cal.nome_promozione.value;
    const start = new Date(cal.data_inizio.value).getTime();
    const end = new Date(cal.data_fine.value).getTime();
    const isActive = now >= start && now <= end;

    console.log(`📦 Promo: "${nome}" → ${isActive ? "ATTIVA" : "NON ATTIVA"}`);

    const righe = cal.righe_promo.references?.nodes || [];

    for (const riga of righe) {
      const variant = riga.variante?.reference;
      const sconto = parseFloat(riga.sconto_percentuale.value);

      if (!variant) continue;

      if (isActive) {
        await updateVariantPrice(variant, sconto);
        updatedCount++;
      } else {
        await resetVariantPrice(variant);
        resetCount++;
      }
    }

    console.log("");
  }

  console.log("=================================");
  console.log(`✅ Varianti aggiornate: ${updatedCount}`);
  console.log(`♻ Varianti ripristinate: ${resetCount}`);
  console.log("🏁 Fine SYNC\n");
}

main().catch((err) => {
  console.error("❌ Errore:", err.message);
  process.exit(1);
});
