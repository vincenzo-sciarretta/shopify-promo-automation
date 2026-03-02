// promo-sync.js
// Shopify Promo Automation v2.1
// FIX metaobject field parsing
// API Version: 2025-01

const fetch = require("node-fetch");

const SHOP = process.env.SHOPIFY_STORE;
const TOKEN = process.env.SHOPIFY_TOKEN;
const API_VERSION = "2025-01";

if (!SHOP || !TOKEN) {
  console.error("❌ Variabili ambiente mancanti.");
  process.exit(1);
}

const GRAPHQL_URL = `https://${SHOP}/admin/api/${API_VERSION}/graphql.json`;
const REST_BASE = `https://${SHOP}/admin/api/${API_VERSION}`;

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

/* =====================================================
   GRAPHQL QUERY
===================================================== */

async function fetchPromos() {
  const query = `
  query GetPromos {
    metaobjects(type: "calendario_promo", first: 50) {
      edges {
        node {
          id
          fields {
            key
            value
          }
          field(key: "righe_promo") {
            references(first: 50) {
              edges {
                node {
                  ... on Metaobject {
                    id
                    fields {
                      key
                      value
                      reference {
                        ... on ProductVariant {
                          id
                          title
                          price
                          compareAtPrice
                          metafield(namespace: "promo", key: "backup_price") {
                            value
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
      }
    }
  }`;

  const response = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": TOKEN,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ query })
  });

  const json = await response.json();

  if (json.errors) {
    console.error("❌ Errore GraphQL:", JSON.stringify(json.errors, null, 2));
    process.exit(1);
  }

  return json.data.metaobjects.edges;
}

/* =====================================================
   UTILS
===================================================== */

function getField(fields, key) {
  return fields.find((f) => f.key === key);
}

function isPromoActive(start, end) {
  const now = new Date();
  return now >= new Date(start) && now <= new Date(end);
}

/* =====================================================
   SAVE BACKUP
===================================================== */

async function saveBackupPrice(variantId, price) {
  const numericId = variantId.split("/").pop();

  await fetch(`${REST_BASE}/metafields.json`, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": TOKEN,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      metafield: {
        namespace: "promo",
        key: "backup_price",
        value: price.toString(),
        type: "single_line_text_field",
        owner_id: numericId,
        owner_resource: "variant"
      }
    })
  });

  console.log(`💾 Backup salvato variante ${numericId}`);
  await delay(400);
}

/* =====================================================
   APPLY DISCOUNT
===================================================== */

async function updateVariantPrice(variant, discountPercent) {
  const numericId = variant.id.split("/").pop();
  const currentPrice = parseFloat(variant.price);
  const compareAt = variant.compareAtPrice
    ? parseFloat(variant.compareAtPrice)
    : null;

  const backup = variant.metafield?.value
    ? parseFloat(variant.metafield.value)
    : null;

  const basePrice = backup || currentPrice;

  if (!backup) {
    await saveBackupPrice(variant.id, currentPrice);
  }

  const newPrice = (basePrice * (1 - discountPercent / 100)).toFixed(2);

  // IDMPOTENZA
  if (
    currentPrice.toFixed(2) === newPrice &&
    compareAt === basePrice
  ) {
    console.log(`✔ Variante ${numericId} già aggiornata`);
    return;
  }

  const response = await fetch(
    `${REST_BASE}/variants/${numericId}.json`,
    {
      method: "PUT",
      headers: {
        "X-Shopify-Access-Token": TOKEN,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        variant: {
          id: numericId,
          price: newPrice,
          compare_at_price: basePrice.toFixed(2)
        }
      })
    }
  );

  if (!response.ok) {
    console.error(`❌ Errore update variante ${numericId}`);
  } else {
    console.log(
      `🔥 ${discountPercent}% applicato a variante ${numericId} → ${newPrice}€`
    );
  }

  await delay(400);
}

/* =====================================================
   RESTORE
===================================================== */

async function restoreVariantPrice(variant) {
  const numericId = variant.id.split("/").pop();
  const backup = variant.metafield?.value;

  if (!backup) {
    console.log(`⚠ Nessun backup per variante ${numericId}`);
    return;
  }

  await fetch(`${REST_BASE}/variants/${numericId}.json`, {
    method: "PUT",
    headers: {
      "X-Shopify-Access-Token": TOKEN,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      variant: {
        id: numericId,
        price: parseFloat(backup).toFixed(2),
        compare_at_price: null
      }
    })
  });

  console.log(`♻ Ripristinata variante ${numericId}`);
  await delay(400);
}

/* =====================================================
   MAIN
===================================================== */

(async () => {
  console.log("🚀 Avvio sincronizzazione promo...\n");

  const promos = await fetchPromos();

  let updated = 0;
  let restored = 0;

  for (const edge of promos) {
    const promo = edge.node;

    const promoFields = promo.fields;

    const nome = getField(promoFields, "nome_promozione")?.value;
    const dataInizio = getField(promoFields, "data_inizio")?.value;
    const dataFine = getField(promoFields, "data_fine")?.value;

    const active = isPromoActive(dataInizio, dataFine);

    console.log(
      `📦 Promo: ${nome} → ${active ? "ATTIVA" : "NON ATTIVA"}`
    );

    const righe =
      promo.field?.references?.edges || [];

    for (const r of righe) {
      const riga = r.node;
      const rigaFields = riga.fields;

      const scontoField = getField(
        rigaFields,
        "sconto_percentuale"
      );

      const varianteField = getField(
        rigaFields,
        "variante"
      );

      if (!scontoField || !varianteField?.reference) continue;

      const discount = parseFloat(scontoField.value);
      const variant = varianteField.reference;

      if (active) {
        await updateVariantPrice(variant, discount);
        updated++;
      } else {
        await restoreVariantPrice(variant);
        restored++;
      }
    }

    console.log("");
  }

  console.log("=================================");
  console.log(`✅ Varianti aggiornate: ${updated}`);
  console.log(`♻ Varianti ripristinate: ${restored}`);
  console.log("🏁 Fine esecuzione\n");
})();
