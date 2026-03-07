const https = require('https');
require('dotenv').config();

const shop = (process.env.SHOPIFY_SHOP_DOMAIN || '').trim();
const accessToken = process.env.SHOPIFY_ACCESS_TOKEN;

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

async function updateVariantPrice(variantId, newPrice, originalPrice) {
  const mutation = `
    mutation productVariantUpdate($input: ProductVariantInput!) {
      productVariantUpdate(input: $input) {
        productVariant {
          id
          price
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const numericId = variantId.replace('gid://shopify/ProductVariant/', '');

  const variables = {
    input: {
      id: variantId,
      price: newPrice.toString(),
      metafields: [
        {
          namespace: "custom",
          key: "prezzo_originale",
          value: originalPrice.toString(),
          type: "number_decimal"
        }
      ]
    }
  };

  const data = await graphqlRequest(mutation, variables);

  if (data.productVariantUpdate.userErrors.length > 0) {
    throw new Error(JSON.stringify(data.productVariantUpdate.userErrors));
  }

  return data.productVariantUpdate.productVariant;
}

async function getVariantPrice(variantId) {
  const query = `
    query getVariant($id: ID!) {
      productVariant(id: $id) {
        id
        price
        metafield(namespace: "custom", key: "prezzo_originale") {
          value
        }
      }
    }
  `;

  const data = await graphqlRequest(query, { id: variantId });
  
  return {
    currentPrice: parseFloat(data.productVariant.price),
    originalPrice: data.productVariant.metafield?.value 
      ? parseFloat(data.productVariant.metafield.value)
      : parseFloat(data.productVariant.price)
  };
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

          const { currentPrice, originalPrice } = await getVariantPrice(variantId);

          const prezzoScontato = originalPrice * (1 - scontoPercentuale / 100);
          const prezzoScontatoArrotondato = Math.round(prezzoScontato * 100) / 100;

          if (Math.abs(currentPrice - prezzoScontatoArrotondato) > 0.01) {
            await updateVariantPrice(variantId, prezzoScontatoArrotondato, originalPrice);
            console.log(`   ✅ ${variantId}: €${originalPrice} → €${prezzoScontatoArrotondato} (-${scontoPercentuale}%)`);
          } else {
            console.log(`   ⏭️  ${variantId}: Già scontato a €${prezzoScontatoArrotondato}`);
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
          const { currentPrice, originalPrice } = await getVariantPrice(variantId);

          if (Math.abs(currentPrice - originalPrice) > 0.01) {
            await updateVariantPrice(variantId, originalPrice, originalPrice);
            console.log(`   ✅ ${variantId}: Ripristinato a €${originalPrice}`);
          } else {
            console.log(`   ⏭️  ${variantId}: Già al prezzo originale €${originalPrice}`);
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
