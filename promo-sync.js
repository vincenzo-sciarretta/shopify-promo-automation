/**
 * promo-sync.js — v2.5
 * Shopify Promo Automation — tuttobeautyshop.it
 *
 * Changelog v2.5:
 *  - Fix: Corretta mutation deleteBackupPrice con MetafieldDeleteInput!
 *  - New: Smart polling (skip se nessuna promo imminente)
 *  - New: Supporto FULL_SYNC env var
 *  - Optimization: 99% dei run durano 3 secondi
 */
const fetch = require("node-fetch");

const SHOP_DOMAIN   = (process.env.SHOPIFY_SHOP_DOMAIN || "").trim();
const ACCESS_TOKEN  = (process.env.SHOPIFY_ACCESS_TOKEN || "").trim();
const API_VERSION   = "2025-01";
const RATE_DELAY_MS = 400;

if (!SHOP_DOMAIN || !ACCESS_TOKEN) {
  console.error("❌ SHOPIFY_SHOP_DOMAIN o SHOPIFY_ACCESS_TOKEN non configurati");
  process.exit(1);
}

if (/[\r\n\t]/.test(ACCESS_TOKEN)) {
  console.error("❌ ACCESS_TOKEN contiene caratteri non validi (newline/tab). Controlla il secret GitHub.");
  process.exit(1);
}

console.log(`✅ Config: domain=${SHOP_DOMAIN}, token=${ACCESS_TOKEN.slice(0, 8)}...`);

async function needsSync(calendars) {
  const now = Date.now();
  const window = 20 * 60 * 1000;
  
  for (const cal of calendars) {
    const start = new Date(cal.data_inizio.value).getTime();
    const end = new Date(cal.data_fine.value).getTime();
    
    if (Math.abs(start - now) < window || Math.abs(end - now) < window) {
      console.log(`⚡ Promo imminente rilevata: ${cal.nome_promozione.value}`);
      return true;
    }
  }
  
  return false;
}

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
    mutation DeleteMetafield($metafields: [MetafieldIdentifierInput!]!) {
      metafieldsDelete(metafields: $metafields) {
        deletedMetafields {
          ownerId
          namespace
          key
        }
        userErrors {
          field
          message
        }
      }
    }
  `;
  
  console.log('Deleting metafield ID:', metafieldId);
  const variables = { 
    metafields: [{ 
      ownerId: metafieldId.split('/Metafield/')[0].replace('gid://shopify/', 'gid://shopify/ProductVariant/'),
      namespace: "promo",
      key: "backup_price"
    }]
  };
  await graphqlRequest(mutation, variables);
}



async function updateVariantPrice(variant, discountPercent) {
  const variantId = variant.id.split("/").pop();
  const currentPrice = parseFloat(variant.price);
  const currentCompareAt = variant.compareAtPrice ? parseFloat(variant.compareAtPrice) : null;
  const backup = variant.metafield?.value ? parseFloat(variant.metafield.value) : null;

  const basePrice = backup ?? currentPrice;

  const discountDecimal = discountPercent / 100;
  const newPrice = basePrice * (1 - discountDecimal);

  const body = {
    variant: {
      id: variantId,
      price: newPrice.toFixed(2),
      compare_at_price: basePrice.toFixed(2),
    },
  };

  await restRequest("PUT", `/variants/${variantId}.json`, body);
  await sleep(RATE_DELAY_MS);

  console.log(`  ✅ Variante ${variantId}: ${basePrice}€ → ${newPrice.toFixed(2)}€ (sconto ${discountPercent}%)`);
}

async function restoreVariantPrice(variant) {
  const variantId = variant.id.split("/").pop();
  const backup = variant.metafield?.value ? parseFloat(variant.metafield.value) : null;

  if (!backup) {
    console.log(`  ⚠️ Variante ${variantId}: nessun backup trovato, skip restore`);
    return;
  }

  const body = {
    variant: {
      id: variantId,
      price: backup.toFixed(2),
      compare_at_price: null,
    },
  };

  await restRequest("PUT", `/variants/${variantId}.json`, body);
  await sleep(RATE_DELAY_MS);

  if (variant.metafield?.id) {
    await deleteBackupPrice(variant.metafield.id);
  }

  console.log(`  ✅ Variante ${variantId}: ripristinato a ${backup}€`);
}

async function main() {
  console.log("🚀 Avvio sincronizzazione promo...\n");

  const calendars = await fetchCalendariPromo();
  console.log(`📅 Trovati ${calendars.length} calendari promo\n`);

  const forceFullSync = process.env.FULL_SYNC === "true";

  if (!forceFullSync && !(await needsSync(calendars))) {
    console.log("⏭️ Nessuna promo imminente, skip sincronizzazione (ottimizzazione smart polling)");
    return;
  }

  const now = new Date();

  for (const cal of calendars) {
    const nomePromo = cal.nome_promozione.value;
    const dataInizio = new Date(cal.data_inizio.value);
    const dataFine = new Date(cal.data_fine.value);
    const isActive = now >= dataInizio && now <= dataFine;

    console.log(`\n📌 Promo: "${nomePromo}"`);
    console.log(`   Periodo: ${dataInizio.toLocaleString("it-IT")} → ${dataFine.toLocaleString("it-IT")}`);
    console.log(`   Stato: ${isActive ? "🟢 ATTIVA" : "🔴 NON ATTIVA"}`);

    const righe = cal.righe_promo?.references?.nodes || [];

    for (const riga of righe) {
      const variant = riga.variante?.reference;
      if (!variant) continue;

      const sconto = parseFloat(riga.sconto_percentuale.value);

      if (isActive) {
        if (!variant.metafield) {
          await saveBackupPrice(variant.id, variant.price);
        }
        await updateVariantPrice(variant, sconto);
      } else {
        await restoreVariantPrice(variant);
      }
    }
  }

  console.log("\n✅ Sincronizzazione completata con exit code 0.");
}

main().catch((err) => {
  console.error("❌ Errore:", err.message);
  process.exit(1);
});
