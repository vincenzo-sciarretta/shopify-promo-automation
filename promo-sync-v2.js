require('dotenv').config();
const https = require('https');

const SHOP = process.env.SHOPIFY_SHOP_DOMAIN;
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

// ========================================
// FUNZIONI HELPER API
// ========================================

function graphqlRequest(query) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ query });
    const options = {
      hostname: SHOP,
      path: '/admin/api/2024-01/graphql.json',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': TOKEN,
        'Content-Length': data.length
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
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

function restRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: SHOP,
      path: path,
      method: method,
      headers: {
        'X-Shopify-Access-Token': TOKEN,
        'Content-Type': 'application/json'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
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

// ========================================
// FUNZIONI GESTIONE TAG
// ========================================

async function addTagToProduct(productId, tag) {
  const numericId = productId.split('/').pop();
  
  // Leggi prodotto attuale
  const product = await restRequest('GET', `/admin/api/2024-01/products/${numericId}.json`);
  
  if (!product.product) {
    console.log(`   ⚠️ Prodotto ${numericId} non trovato`);
    return;
  }
  
  // Aggiungi tag se non esiste già
  let tags = product.product.tags ? product.product.tags.split(', ') : [];
  
  if (!tags.includes(tag)) {
    tags.push(tag);
    const newTags = tags.join(', ');
    
    await restRequest('PUT', `/admin/api/2024-01/products/${numericId}.json`, {
      product: { id: parseInt(numericId), tags: newTags }
    });
    
    console.log(`   ✅ Tag "${tag}" aggiunto a prodotto ${numericId}`);
  } else {
    console.log(`   ℹ️ Tag "${tag}" già presente su prodotto ${numericId}`);
  }
}

async function removeTagFromProduct(productId, tag) {
  const numericId = productId.split('/').pop();
  
  // Leggi prodotto attuale
  const product = await restRequest('GET', `/admin/api/2024-01/products/${numericId}.json`);
  
  if (!product.product) {
    console.log(`   ⚠️ Prodotto ${numericId} non trovato`);
    return;
  }
  
  // Rimuovi tag se esiste
  let tags = product.product.tags ? product.product.tags.split(', ') : [];
  
  if (tags.includes(tag)) {
    tags = tags.filter(t => t !== tag);
    const newTags = tags.join(', ');
    
    await restRequest('PUT', `/admin/api/2024-01/products/${numericId}.json`, {
      product: { id: parseInt(numericId), tags: newTags }
    });
    
    console.log(`   ✅ Tag "${tag}" rimosso da prodotto ${numericId}`);
  } else {
    console.log(`   ℹ️ Tag "${tag}" non presente su prodotto ${numericId}`);
  }
}

// ========================================
// FUNZIONI GESTIONE PREZZI
// ========================================

async function applyDiscount(variantId, discountPercent, tag) {
  const numericId = variantId.split('/').pop();
  
  // Leggi variante attuale
  const variant = await restRequest('GET', `/admin/api/2024-01/variants/${numericId}.json`);
  
  if (!variant.variant) {
    console.log(`   ⚠️ Variante ${numericId} non trovata`);
    return;
  }
  
  const currentPrice = parseFloat(variant.variant.price);
  const currentCompareAtPrice = variant.variant.compare_at_price ? parseFloat(variant.variant.compare_at_price) : null;
  
  // ✅ CONTROLLO: Se compare_at_price è già impostato, lo sconto è già applicato
  if (currentCompareAtPrice && currentCompareAtPrice > currentPrice) {
    console.log(`   ℹ️ Variante ${numericId}: Sconto già applicato (€${currentCompareAtPrice} → €${currentPrice}), skip`);
    
    // Aggiungi comunque il tag se manca
    await addTagToProduct(variant.variant.product_id.toString(), tag);
    return;
  }
  
  // Calcola prezzo scontato
  const discountedPrice = (currentPrice * (1 - discountPercent / 100)).toFixed(2);
  
  // Salva prezzo originale in metafield (backup)
  await restRequest('POST', `/admin/api/2024-01/variants/${numericId}/metafields.json`, {
    metafield: {
      namespace: 'custom',
      key: 'prezzo_originale',
      value: currentPrice.toString(),
      type: 'number_decimal'
    }
  });
  
  // Imposta compare_at_price (prezzo barrato) e price (prezzo scontato)
  await restRequest('PUT', `/admin/api/2024-01/variants/${numericId}.json`, {
    variant: { 
      id: parseInt(numericId), 
      price: discountedPrice,
      compare_at_price: currentPrice.toFixed(2)
    }
  });
  
  // Aggiungi tag al prodotto
  await addTagToProduct(variant.variant.product_id.toString(), tag);
  
  console.log(`   ✅ Variante ${numericId}: €${currentPrice} → €${discountedPrice} (sconto ${discountPercent}%)`);
}


// ========================================
// FUNZIONE PRINCIPALE
// ========================================

async function syncPromo() {
  console.log('🚀 Avvio sincronizzazione promo v2.0...\n');
  
  // Leggi tutti i calendari promo
  const query = `{
    metaobjects(type: "calendario_promo", first: 50) {
      edges {
        node {
          id
          fields {
            key
            value
          }
        }
      }
    }
  }`;
  
  const response = await graphqlRequest(query);
  const calendars = response.data.metaobjects.edges;
  
  console.log(`📋 Trovati ${calendars.length} calendari promo\n`);
  
  const now = new Date();
  
  for (const cal of calendars) {
    const fields = cal.node.fields;
    
    const nome = fields.find(f => f.key === 'nome_promozione')?.value;
    const dataInizio = new Date(fields.find(f => f.key === 'data_inizio')?.value);
    const dataFine = new Date(fields.find(f => f.key === 'data_fine')?.value);
    const tagEsclusione = fields.find(f => f.key === 'tag_esclusione')?.value || 'promo-carosello';
    const prodottiJson = fields.find(f => f.key === 'prodotti_scontati')?.value;
    
    if (!prodottiJson) {
      console.log(`⚠️ Promo "${nome}": campo prodotti_scontati vuoto, skip\n`);
      continue;
    }
    
    let prodotti;
    try {
      prodotti = JSON.parse(prodottiJson);
    } catch (e) {
      console.log(`❌ Promo "${nome}": JSON non valido, skip\n`);
      continue;
    }
    
    const isActive = now >= dataInizio && now <= dataFine;
    const isExpired = now > dataFine;
    
    console.log(`📌 Promo: "${nome}"`);
    console.log(`   Periodo: ${dataInizio.toLocaleString('it-IT')} → ${dataFine.toLocaleString('it-IT')}`);
    console.log(`   Tag: ${tagEsclusione}`);
    console.log(`   Prodotti: ${prodotti.length}`);
    console.log(`   Stato: ${isActive ? '✅ ATTIVA' : isExpired ? '🔴 SCADUTA' : '🟡 PROGRAMMATA'}\n`);
    
    if (isActive) {
      // Applica sconti e aggiungi tag
      for (const prod of prodotti) {
        await applyDiscount(prod.variant_id, prod.sconto_percentuale, tagEsclusione);
      }
    } else if (isExpired) {
      // Ripristina prezzi e rimuovi tag
      for (const prod of prodotti) {
        await restorePrice(prod.variant_id, tagEsclusione);
      }
    }
    
    console.log('');
  }
  
  console.log('✅ Sincronizzazione completata!\n');
}

// ========================================
// ESECUZIONE
// ========================================

syncPromo().catch(err => {
  console.error('❌ Errore:', err);
  process.exit(1);
});
