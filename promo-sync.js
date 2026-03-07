const https = require('https');

const shop = process.env.SHOPIFY_SHOP_DOMAIN;
const accessToken = process.env.SHOPIFY_ACCESS_TOKEN;

// ═══════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function graphqlRequest(query, variables = {}) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({ query, variables });
    
    const options = {
      hostname: shop,
      path: '/admin/api/2024-01/graphql.json',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken,
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          const response = JSON.parse(body);
          if (response.errors) {
            reject(new Error(JSON.stringify(response.errors)));
          } else {
            resolve(response.data);
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function restRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: shop,
      path: `/admin/api/2024-01/${path}`,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          resolve(response);
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ═══════════════════════════════════════════════════════════
// MAIN FUNCTIONS
// ═══════════════════════════════════════════════════════════

async function getAllPromos() {
  const query = `{
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
  }`;

  const data = await graphqlRequest(query);
  const now = new Date();
  const activePromos = [];
  const expiredPromos = [];

  for (const edge of data.metaobjects.edges) {
    const node = edge.node;
    const fields = {};
    
    node.fields.forEach(f => {
      fields[f.key] = f.value;
    });

    const dataInizio = new Date(fields.data_inizio);
    const dataFine = new Date(fields.data_fine);
    
    let prodottiScontati = [];
    if (fields.prodotti_scontati) {
      try {
        prodottiScontati = JSON.parse(fields.prodotti_scontati);
      } catch (e) {
        console.log(`⚠️ Errore parsing JSON per ${fields.nome_promozione}:`, e.message);
      }
    }

    const promo = {
      id: node.id,
      handle: node.handle,
      nome: fields.nome_promozione || node.handle,
      dataInizio,
      dataFine,
      tagEsclusione: fields.tag_esclusione || 'promo-carosello',
      prodottiScontati
    };

    // LOGICA SEMPLIFICATA: Solo date, no campo "attiva"
    if (now >= dataInizio && now <= dataFine) {
      activePromos.push(promo);
    } else if (now > dataFine && prodottiScontati.length > 0) {
      expiredPromos.push(promo);
    }
  }

  return { activePromos, expiredPromos };
}

async function applyDiscount(variantId, originalPrice, discountPercent) {
  const discountedPrice = (originalPrice * (1 - discountPercent / 100)).toFixed(2);
  const numericId = variantId.split('/').pop();
  
  const response = await restRequest('PUT', `variants/${numericId}.json`, {
    variant: {
      id: parseInt(numericId),
      price: discountedPrice,
      compare_at_price: originalPrice.toFixed(2)
    }
  });

  if (response.errors) {
    throw new Error(JSON.stringify(response.errors));
  }

  return discountedPrice;
}

async function restorePrice(variantId, originalPrice) {
  const numericId = variantId.split('/').pop();
  
  const response = await restRequest('PUT', `variants/${numericId}.json`, {
    variant: {
      id: parseInt(numericId),
      price: originalPrice.toFixed(2),
      compare_at_price: null
    }
  });

  if (response.errors) {
    throw new Error(JSON.stringify(response.errors));
  }
}

async function syncPromos() {
  console.log('🚀 Avvio sincronizzazione promo...\n');
  
  const { activePromos, expiredPromos } = await getAllPromos();
  
  console.log(`✅ Trovate ${activePromos.length} promo attive`);
  console.log(`🔄 Trovate ${expiredPromos.length} promo scadute da ripristinare\n`);

  // APPLICA SCONTI per promo attive
  for (const promo of activePromos) {
    console.log(`📦 Promo ATTIVA: "${promo.nome}"`);
    console.log(`   📅 Dal ${promo.dataInizio.toLocaleString('it-IT')} al ${promo.dataFine.toLocaleString('it-IT')}`);
    console.log(`   🛍️ Prodotti: ${promo.prodottiScontati.length}`);
    
    for (const prodotto of promo.prodottiScontati) {
      try {
        const query = `{
          productVariant(id: "${prodotto.variant_id}") {
            id
            price
            product {
              title
            }
          }
        }`;
        
        const data = await graphqlRequest(query);
        const currentPrice = parseFloat(data.productVariant.price);
        const productTitle = data.productVariant.product.title;
        
        // Salva prezzo originale se non già scontato
        if (!prodotto.prezzo_originale) {
          prodotto.prezzo_originale = currentPrice;
        }
        
        const discountedPrice = await applyDiscount(
          prodotto.variant_id,
          prodotto.prezzo_originale,
          prodotto.sconto_percentuale
        );
        
        console.log(`   ✅ ${productTitle} ${prodotto.formato}: €${prodotto.prezzo_originale.toFixed(2)} → €${discountedPrice} (-${prodotto.sconto_percentuale}%)`);
        
        await sleep(500);
        
      } catch (e) {
        console.log(`   ❌ Errore su ${prodotto.product_title}:`, e.message);
      }
    }
    
    console.log('');
  }

  // RIPRISTINA PREZZI per promo scadute
  for (const promo of expiredPromos) {
    console.log(`🔄 Promo SCADUTA: "${promo.nome}"`);
    console.log(`   📅 Scaduta il ${promo.dataFine.toLocaleString('it-IT')}`);
    console.log(`   🔙 Ripristino prezzi originali...`);
    
    for (const prodotto of promo.prodottiScontati) {
      try {
        const query = `{
          productVariant(id: "${prodotto.variant_id}") {
            id
            product {
              title
            }
          }
        }`;
        
        const data = await graphqlRequest(query);
        const productTitle = data.productVariant.product.title;
        
        // Usa prezzo_originale dal JSON
        const originalPrice = prodotto.prezzo_originale || prodotto.prezzo_base || 0;
        
        if (originalPrice > 0) {
          await restorePrice(prodotto.variant_id, originalPrice);
          console.log(`   ✅ ${productTitle} ${prodotto.formato}: Ripristinato a €${originalPrice.toFixed(2)}`);
        } else {
          console.log(`   ⚠️ ${productTitle} ${prodotto.formato}: Prezzo originale non trovato, skip`);
        }
        
        await sleep(500);
        
      } catch (e) {
        console.log(`   ❌ Errore su ${prodotto.product_title}:`, e.message);
      }
    }
    
    console.log('');
  }

  console.log('✅ Sincronizzazione completata!\n');
}

// ═══════════════════════════════════════════════════════════
// RUN
// ═══════════════════════════════════════════════════════════

syncPromos().catch(err => {
  console.error('❌ Errore fatale:', err);
  process.exit(1);
});
