const https = require('https');
require('dotenv').config();

const shop = (process.env.SHOPIFY_SHOP_DOMAIN || '').trim();
const accessToken = process.env.SHOPIFY_ACCESS_TOKEN;

// GraphQL per leggere i metaobject
function graphqlRequest(query, variables = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ query, variables });
    
    const options = {
      hostname: shop,
      path: '/admin/api/2024-01/graphql.json',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken,
        'Content-Length': data.length
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          if (json.errors) {
            reject(new Error(JSON.stringify(json.errors)));
          } else {
            resolve(json.data);
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// REST API per aggiornare varianti
function restRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: shop,
      path: path,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken
      }
    };

    const req = https.request(options, (res) => {
      let responseBody = '';
      res.on('data', (chunk) => responseBody += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(responseBody);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(json);
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${JSON.stringify(json)}`));
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function getPromos() {
  const query = `
    query {
      metaobjects(type: "calendario_promo", first: 50) {
        edges {
          node {
            id
            handle
            fields {
              key
              value
            }
          }
        }
      }
    }
  `;

  const data = await graphqlRequest(query);
  
  return data.metaobjects.edges.map(edge => {
    const fields = edge.node.fields;
    const nome = fields.find(f => f.key === 'nome_promozione')?.value || fields.find(f => f.key === 'nome')?.value;
    const dataInizio = fields.find(f => f.key === 'data_inizio')?.value;
    const dataFine = fields.find(f => f.key === 'data_fine')?.value;
    const prodottiScontati = fields.find(f => f.key === 'prodotti_scontati')?.value;

    return {
      id: edge.node.id,
      handle: edge.node.handle,
      nome,
      dataInizio: new Date(dataInizio),
      dataFine: new Date(dataFine),
      prodotti: prodottiScontati ? JSON.parse(prodottiScontati) : []
    };
  });
}

async function getVariantREST(variantId) {
  const numericId = variantId.replace('gid://shopify/ProductVariant/', '');
  const path = `/admin/api/2024-01/variants/${numericId}.json`;
  const data = await restRequest('GET', path);
  return data.variant;
}

async function updateVariantREST(variantId, newPrice) {
  const numericId = variantId.replace('gid://shopify/ProductVariant/', '');
  const path = `/admin/api/2024-01/variants/${numericId}.json`;
  
  const body = {
    variant: {
      id: parseInt(numericId),
      price: newPrice.toFixed(2)
    }
  };

  const data = await restRequest('PUT', path, body);
  return data.variant;
}

async function getVariantMetafields(variantId) {
  const numericId = variantId.replace('gid://shopify/ProductVariant/', '');
  const path = `/admin/api/2024-01/variants/${numericId}/metafields.json`;
  const data = await restRequest('GET', path);
  return data.metafields || [];
}

async function createVariantMetafield(variantId, key, value) {
  const numericId = variantId.replace('gid://shopify/ProductVariant/', '');
  const path = `/admin/api/2024-01/variants/${numericId}/metafields.json`;
  
  const body = {
    metafield: {
      namespace: "custom",
      key: key,
      value: value.toString(),
      type: "number_decimal"
    }
  };

  const data = await restRequest('POST', path, body);
  return data.metafield;
}

async function deleteMetafieldREST(metafieldId) {
  const path = `/admin/api/2024-01/metafields/${metafieldId}.json`;
  await restRequest('DELETE', path);
}

async function syncPromos() {
  console.log('🚀 Avvio sincronizzazione promo...');
  
  try {
    const promos = await getPromos();
    const now = new Date();

    console.log(`📅 Trovate ${promos.length} promo totali`);

    const promoAttive = promos.filter(p => p.dataInizio <= now && p.dataFine >= now);
    const promoScadute = promos.filter(p => p.dataFine < now);

    console.log(`✅ Trovate ${promoAttive.length} promo attive`);
    console.log(`❌ Trovate ${promoScadute.length} promo scadute da ripristinare`);

    // Applica sconti per promo attive
    for (const promo of promoAttive) {
      console.log(`\n📢 Promo ATTIVA: "${promo.nome}"`);
      console.log(`   Scade il: ${promo.dataFine.toLocaleString('it-IT')}`);
      console.log(`   Applicazione sconti...`);

      for (const prodotto of promo.prodotti) {
        try {
          const variantId = prodotto.variant_id;
          const scontoPercentuale = prodotto.sconto_percentuale;

          const variant = await getVariantREST(variantId);
          const prezzoAttuale = parseFloat(variant.price);

          // Controlla se esiste già il metafield
          const metafields = await getVariantMetafields(variantId);
          const metafieldPrezzo = metafields.find(m => m.namespace === 'custom' && m.key === 'prezzo_originale');

          let prezzoOriginale;
          if (metafieldPrezzo) {
            prezzoOriginale = parseFloat(metafieldPrezzo.value);
            console.log(`   💾 Prezzo originale già salvato: €${prezzoOriginale}`);
          } else {
            prezzoOriginale = prezzoAttuale;
            console.log(`   💾 Salvo prezzo originale: €${prezzoOriginale}`);
            await createVariantMetafield(variantId, 'prezzo_originale', prezzoOriginale);
          }

          const prezzoScontato = prezzoOriginale * (1 - scontoPercentuale / 100);
          const prezzoScontatoArrotondato = Math.round(prezzoScontato * 100) / 100;

          if (Math.abs(prezzoAttuale - prezzoScontatoArrotondato) > 0.01) {
            await updateVariantREST(variantId, prezzoScontatoArrotondato);
            console.log(`   ✅ ${variant.title}: €${prezzoOriginale} → €${prezzoScontatoArrotondato} (-${scontoPercentuale}%)`);
          } else {
            console.log(`   ⏭️  ${variant.title}: Già scontato a €${prezzoScontatoArrotondato}`);
          }

          await new Promise(resolve => setTimeout(resolve, 500));
        } catch (error) {
          console.error(`   ❌ Errore su ${prodotto.variant_id}:`, error.message);
        }
      }
    }

    // Ripristina prezzi per promo scadute
    for (const promo of promoScadute) {
      console.log(`\n⏰ Promo SCADUTA: "${promo.nome}"`);
      console.log(`   Scaduta il: ${promo.dataFine.toLocaleString('it-IT')}`);
      console.log(`   Ripristino prezzi originali...`);

      for (const prodotto of promo.prodotti) {
        try {
          const variantId = prodotto.variant_id;
          const variant = await getVariantREST(variantId);
          const prezzoAttuale = parseFloat(variant.price);

          const metafields = await getVariantMetafields(variantId);
          const metafieldPrezzo = metafields.find(m => m.namespace === 'custom' && m.key === 'prezzo_originale');

          if (metafieldPrezzo) {
            const prezzoOriginale = parseFloat(metafieldPrezzo.value);

            if (Math.abs(prezzoAttuale - prezzoOriginale) > 0.01) {
              await updateVariantREST(variantId, prezzoOriginale);
              console.log(`   ✅ ${variant.title}: Ripristinato a €${prezzoOriginale}`);
            } else {
              console.log(`   ⏭️  ${variant.title}: Già al prezzo originale €${prezzoOriginale}`);
            }

            await deleteMetafieldREST(metafieldPrezzo.id);
            console.log(`   🗑️  Metafield rimosso`);
          } else {
            console.log(`   ⚠️  ${variantId}: Prezzo originale non trovato, salto`);
          }

          await new Promise(resolve => setTimeout(resolve, 500));
        } catch (error) {
          console.error(`   ❌ Errore su ${prodotto.variant_id}:`, error.message);
        }
      }
    }

    console.log('\n✅ Sincronizzazione completata!');
  } catch (error) {
    console.error('❌ Errore durante la sincronizzazione:', error);
    process.exit(1);
  }
}

syncPromos();
