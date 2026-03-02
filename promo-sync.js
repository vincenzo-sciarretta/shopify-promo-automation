promo-sync.js — v2.2
Shopify Promo Automation — tuttobeautyshop.it
Changelog v2.2
•	Fix: compareAtPrice incluso nel GraphQL fragment
•	Fix: idempotenza con Math.abs (float-safe)
•	New: funzione resetVariantPrice
•	New: funzione resetAllActivePromos (utility manuale)
•	Refactor: basePrice sempre letto dal backup metafield
Utilizzo
Sync normale (GitHub Actions):
node promo-sync.js
Reset manuale di emergenza:
node promo-sync.js reset
Codice Completo
/**
 * promo-sync.js — v2.2
 * Shopify Promo Automation — tuttobeautyshop.it
 *
 * Changelog v2.2:
 *  - Fix: compareAtPrice incluso nel GraphQL fragment
 *  - Fix: idempotenza con Math.abs (float-safe)
 *  - New: funzione resetVariantPrice
 *  - New: funzione resetAllActivePromos (utility manuale)
 *  - Refactor: basePrice sempre letto dal backup metafield
 */
 
const SHOP_DOMAIN   = process.env.SHOPIFY_SHOP_DOMAIN;   // es. tuttobeautyshop.myshopify.com
const ACCESS_TOKEN  = process.env.SHOPIFY_ACCESS_TOKEN;
const API_VERSION   = "2025-01";
const RATE_DELAY_MS = 400; // ms tra le chiamate REST (evita 429)
 
// ─────────────────────────────────────────────────────────────────────────────
// UTILITY
// ─────────────────────────────────────────────────────────────────────────────
 
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
 
/**
 * Confronto float sicuro — evita problemi con 23.800000001 vs 23.8
 */
function floatEquals(a, b, tolerance = 0.01) {
  return Math.abs(a - b) < tolerance;
}
 
// ─────────────────────────────────────────────────────────────────────────────
// SHOPIFY GRAPHQL CLIENT
// ─────────────────────────────────────────────────────────────────────────────
 
async function graphqlRequest(query, variables = {}) {
  const url = `https://${SHOP_DOMAIN}/admin/api/${API_VERSION}/graphql.json`;
 
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type":          "application/json",
      "X-Shopify-Access-Token": ACCESS_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });
 
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GraphQL HTTP ${response.status}: ${text}`);
  }
 
  const json = await response.json();
 
  if (json.errors?.length) {
    throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  }
 
  return json.data;
}
 
// ─────────────────────────────────────────────────────────────────────────────
// SHOPIFY REST CLIENT
// ─────────────────────────────────────────────────────────────────────────────
 
async function restRequest(method, path, body = null) {
  const url = `https://${SHOP_DOMAIN}/admin/api/${API_VERSION}/${path}`;
 
  const options = {
    method,
    headers: {
      "Content-Type":          "application/json",
      "X-Shopify-Access-Token": ACCESS_TOKEN,
    },
  };
 
  if (body) options.body = JSON.stringify(body);
 
  const response = await fetch(url, options);
 
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`REST ${method} ${path} → HTTP ${response.status}: ${text}`);
  }
 
  return response.json();
}
 
// ─────────────────────────────────────────────────────────────────────────────
// GRAPHQL QUERIES
// ─────────────────────────────────────────────────────────────────────────────
 
/**
 * Fragment variante — include compareAtPrice e metafield backup
 * QUESTO ERA IL BUG v2.1: compareAtPrice mancava
 */
const VARIANT_FRAGMENT = `
  fragment VariantFields on ProductVariant {
    id
    price
    compareAtPrice
    metafield(namespace: "promo", key: "backup_price") {
      id
      value
    }
  }
`;
 
/**
 * Recupera tutti i calendari promo dal metaobject
 */
const GET_CALENDARI_PROMO = `
  ${VARIANT_FRAGMENT}
 
  query GetCalendariPromo($type: String!) {
    metaobjects(type: $type, first: 50) {
      nodes {
        id
        handle
        fields {
          key
          value
          references(first: 20) {
            nodes {
              ... on Metaobject {
                id
                fields {
                  key
                  value
                  reference {
                    ... on ProductVariant {
                      ...VariantFields
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;
 
// ─────────────────────────────────────────────────────────────────────────────
// LETTURA METAOBJECT
// ─────────────────────────────────────────────────────────────────────────────
 
function getField(fields, key) {
  return fields.find((f) => f.key === key);
}
 
function parseCalendario(node) {
  const fields = node.fields;
 
  const nome        = getField(fields, "nome_promozione")?.value ?? "(senza nome)";
  const dataInizio  = new Date(getField(fields, "data_inizio")?.value);
  const dataFine    = new Date(getField(fields, "data_fine")?.value);
  const righeField  = getField(fields, "righe_promo");
 
  const righe = righeField?.references?.nodes?.map(parseRigaPromo) ?? [];
 
  return { id: node.id, nome, dataInizio, dataFine, righe };
}
 
function parseRigaPromo(node) {
  const fields = node.fields;
 
  const varianteField   = getField(fields, "variante");
  const scontoField     = getField(fields, "sconto_percentuale");
  const originaleField  = getField(fields, "prezzo_originale");
 
  return {
    id:               node.id,
    variant:          varianteField?.reference ?? null,  // oggetto VariantFields
    discountPercent:  scontoField  ? parseFloat(scontoField.value)    : 0,
    prezzoOriginale:  originaleField ? parseFloat(originaleField.value) : null,
  };
}
 
function isPromoActive(calendario, now = new Date()) {
  return now >= calendario.dataInizio && now <= calendario.dataFine;
}
 
// ─────────────────────────────────────────────────────────────────────────────
// BACKUP METAFIELD
// ─────────────────────────────────────────────────────────────────────────────
 
async function saveBackupPrice(variantGid, price) {
  const mutation = `
    mutation SetBackupPrice($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id key value }
        userErrors  { field message }
      }
    }
  `;
 
  const variables = {
    metafields: [
      {
        ownerId:   variantGid,
        namespace: "promo",
        key:       "backup_price",
        value:     price.toFixed(2),
        type:      "number_decimal",
      },
    ],
  };
 
  const data = await graphqlRequest(mutation, variables);
  const errors = data.metafieldsSet?.userErrors ?? [];
 
  if (errors.length) {
    throw new Error(`saveBackupPrice errors: ${JSON.stringify(errors)}`);
  }
 
  console.log(`   💾 Backup salvato: ${price.toFixed(2)}€`);
}
 
async function deleteBackupMetafield(metafieldId) {
  if (!metafieldId) return;
 
  const mutation = `
    mutation DeleteMetafield($id: ID!) {
      metafieldDelete(input: { id: $id }) {
        deletedId
        userErrors { field message }
      }
    }
  `;
 
  const data = await graphqlRequest(mutation, { id: metafieldId });
  const errors = data.metafieldDelete?.userErrors ?? [];
 
  if (errors.length) {
    console.warn(`   ⚠ deleteBackupMetafield errors: ${JSON.stringify(errors)}`);
  }
}
 
// ─────────────────────────────────────────────────────────────────────────────
// AGGIORNAMENTO PREZZO (REST)
// ─────────────────────────────────────────────────────────────────────────────
 
async function updatePriceViaREST(numericId, price, compareAtPrice) {
  const body = {
    variant: {
      id:               numericId,
      price:            price,
      compare_at_price: compareAtPrice,
    },
  };
 
  await restRequest("PUT", `variants/${numericId}.json`, body);
}
 
// ─────────────────────────────────────────────────────────────────────────────
// CORE: APPLICA SCONTO — con idempotenza robusta
// ─────────────────────────────────────────────────────────────────────────────
 
/**
 * Applica uno sconto percentuale a una variante.
 * Idempotente: se il prezzo è già corretto, non fa nulla.
 *
 * @param {object} variant  — oggetto VariantFields da GraphQL
 * @param {number} discountPercent — es. 30 per il 30%
 * @param {object} stats    — contatore risultati (mutato in-place)
 */
async function updateVariantPrice(variant, discountPercent, stats) {
  const numericId    = variant.id.split("/").pop();
  const currentPrice = parseFloat(variant.price);
  const compareAt    = variant.compareAtPrice
    ? parseFloat(variant.compareAtPrice)
    : null;
 
  // Backup = fonte di verità del prezzo originale
  const backupMetafield = variant.metafield ?? null;
  const backup          = backupMetafield ? parseFloat(backupMetafield.value) : null;
 
  // Prezzo base: usa SEMPRE il backup se esiste, altrimenti il prezzo corrente
  const basePrice = backup ?? currentPrice;
 
  // Prezzo target dopo sconto
  const newPrice = parseFloat((basePrice * (1 - discountPercent / 100)).toFixed(2));
 
  // ── CHECK IDEMPOTENZA (v2.2 — float-safe) ───────────────────────────────
  // La variante è già correttamente scontata se:
  //  1. Il backup esiste (promo già applicata in precedenza)
  //  2. Il prezzo corrente ≈ prezzo scontato calcolato dal backup
  //  3. Il compare_at_price ≈ prezzo originale (backup)
  const alreadyUpdated =
    backup !== null &&
    floatEquals(currentPrice, newPrice) &&
    compareAt !== null &&
    floatEquals(compareAt, basePrice);
 
  if (alreadyUpdated) {
    console.log(`   ✔ Variante ${numericId} già aggiornata (${currentPrice.toFixed(2)}€)`);
    stats.skipped++;
    return;
  }
 
  // ── SALVA BACKUP (solo se non esiste ancora) ────────────────────────────
  if (!backup) {
    await saveBackupPrice(variant.id, currentPrice);
  }
 
  // ── APPLICA SCONTO ───────────────────────────────────────────────────────
  await updatePriceViaREST(
    numericId,
    newPrice.toFixed(2),
    basePrice.toFixed(2)
  );
 
  console.log(
    `   🔥 ${discountPercent}% applicato → ${newPrice.toFixed(2)}€` +
    ` (era ${basePrice.toFixed(2)}€, compare_at: ${basePrice.toFixed(2)}€)`
  );
 
  stats.updated++;
  await sleep(RATE_DELAY_MS);
}
 
// ─────────────────────────────────────────────────────────────────────────────
// CORE: RIPRISTINA PREZZO ORIGINALE
// ─────────────────────────────────────────────────────────────────────────────
 
/**
 * Ripristina il prezzo originale di una variante leggendolo dal backup metafield.
 * Rimuove compare_at_price e cancella il metafield di backup.
 *
 * @param {object} variant — oggetto VariantFields da GraphQL
 * @param {object} stats   — contatore risultati (mutato in-place)
 */
async function resetVariantPrice(variant, stats) {
  const numericId    = variant.id.split("/").pop();
  const backupMetafield = variant.metafield ?? null;
  const backup       = backupMetafield ? parseFloat(backupMetafield.value) : null;
 
  if (!backup) {
    console.log(`   ⚠ Variante ${numericId}: nessun backup trovato, skip ripristino`);
    stats.skipped++;
    return;
  }
 
  const currentPrice = parseFloat(variant.price);
 
  // Già ripristinata?
  if (floatEquals(currentPrice, backup) && variant.compareAtPrice === null) {
    console.log(`   ✔ Variante ${numericId} già ripristinata (${backup.toFixed(2)}€)`);
    stats.skipped++;
    return;
  }
 
  // Ripristina prezzo originale, rimuovi compare_at_price
  await updatePriceViaREST(
    numericId,
    backup.toFixed(2),
    null              // null = rimuove il prezzo barrato
  );
 
  // Cancella il metafield backup
  await deleteBackupMetafield(backupMetafield?.id);
 
  console.log(`   ♻ Variante ${numericId} ripristinata → ${backup.toFixed(2)}€`);
 
  stats.restored++;
  await sleep(RATE_DELAY_MS);
}
 
// ─────────────────────────────────────────────────────────────────────────────
// UTILITY MANUALE: Reset tutte le promo attive
// ─────────────────────────────────────────────────────────────────────────────
 
/**
 * Utility da eseguire manualmente per ripristinare i prezzi dopo un bug.
 * Legge tutte le righe_promo e chiama resetVariantPrice su ognuna.
 */
async function resetAllActivePromos() {
  console.log("\n🔄 RESET MANUALE: ripristino prezzi originali...\n");
 
  const data = await graphqlRequest(GET_CALENDARI_PROMO, {
    type: "calendario_promo",
  });
 
  const calendari = (data.metaobjects?.nodes ?? []).map(parseCalendario);
  const stats     = { updated: 0, restored: 0, skipped: 0, errors: 0 };
 
  for (const calendario of calendari) {
    console.log(`📦 Promo: "${calendario.nome}"`);
 
    for (const riga of calendario.righe) {
      if (!riga.variant) {
        console.log("   ⚠ Riga senza variante, skip");
        continue;
      }
 
      try {
        await resetVariantPrice(riga.variant, stats);
      } catch (err) {
        console.error(`   ❌ Errore reset variante: ${err.message}`);
        stats.errors++;
      }
    }
  }
 
  printStats(stats, "RESET");
}
 
// ─────────────────────────────────────────────────────────────────────────────
// MAIN: Sincronizzazione promo
// ─────────────────────────────────────────────────────────────────────────────
 
function printStats(stats, label = "SYNC") {
  console.log("\n=================================");
  if (stats.updated  > 0) console.log(`✅ Varianti aggiornate:  ${stats.updated}`);
  if (stats.restored > 0) console.log(`♻  Varianti ripristinate: ${stats.restored}`);
  if (stats.skipped  > 0) console.log(`⏭  Varianti skippate:     ${stats.skipped}`);
  if (stats.errors   > 0) console.log(`❌ Errori:                ${stats.errors}`);
  console.log(`🏁 Fine ${label}\n`);
}
 
async function syncPromo() {
  console.log("🚀 Avvio sincronizzazione promo...\n");
 
  const now   = new Date();
  const stats = { updated: 0, restored: 0, skipped: 0, errors: 0 };
 
  // ── Recupera tutti i calendari ───────────────────────────────────────────
  let data;
  try {
    data = await graphqlRequest(GET_CALENDARI_PROMO, {
      type: "calendario_promo",
    });
  } catch (err) {
    console.error(`❌ Errore lettura metaobject: ${err.message}`);
    process.exit(1);
  }
 
  const calendari = (data.metaobjects?.nodes ?? []).map(parseCalendario);
 
  if (calendari.length === 0) {
    console.log("ℹ Nessun calendario promo trovato.");
    return;
  }
 
  // ── Processa ogni calendario ─────────────────────────────────────────────
  for (const calendario of calendari) {
    const attiva = isPromoActive(calendario, now);
 
    console.log(
      `📦 Promo: "${calendario.nome}" ` +
      `(${calendario.dataInizio.toISOString()} → ${calendario.dataFine.toISOString()}) ` +
      `→ ${attiva ? "ATTIVA" : "NON ATTIVA"}`
    );
 
    for (const riga of calendario.righe) {
      if (!riga.variant) {
        console.log("   ⚠ Riga senza variante collegata, skip");
        continue;
      }
 
      try {
        if (attiva) {
          // Applica sconto
          await updateVariantPrice(riga.variant, riga.discountPercent, stats);
        } else {
          // Promo non attiva: ripristina se era stata scontata
          await resetVariantPrice(riga.variant, stats);
        }
      } catch (err) {
        console.error(
          `   ❌ Errore variante ${riga.variant.id.split("/").pop()}: ${err.message}`
        );
        stats.errors++;
      }
    }
 
    console.log(); // riga vuota tra le promo
  }
 
  printStats(stats, "SYNC");
}
 
// ─────────────────────────────────────────────────────────────────────────────
// ENTRYPOINT
// ─────────────────────────────────────────────────────────────────────────────
 
// Modalità: SYNC (default) oppure RESET (manuale)
const mode = process.argv[2] ?? "sync";
 
if (mode === "reset") {
  resetAllActivePromos().catch((err) => {
    console.error("❌ Errore fatale nel reset:", err);
    process.exit(1);
  });
} else {
  syncPromo().catch((err) => {
    console.error("❌ Errore fatale nella sync:", err);
    process.exit(1);
  });
}
 
 
Generato automaticamente — promo-sync.js v2.2
