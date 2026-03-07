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

async function getVariantInfo(variantId) {
  const query = `
    query getVariant($id: ID!) {
      productVariant(id: $id) {
        id
        price
        product {
          id
          title
        }
      }
    }
  `;

  const data = await graphqlRequest(query, { id: variantId });
  return data.productVariant;
}

async function updateVariantPrice(variantId, newPrice) {
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

  const variables = {
    input: {
      id: variantId,
      price: newPrice.toFixed(2)
    }
  };

  const data = await graphqlRequest(mutation, variables);

  if (data.productVariantUpdate.userErrors.length > 0) {
    throw new Error(JSON.stringify(data.productVariantUpdate.userErrors));
  }

  return data.productVariantUpdate.productVariant;
}

// Mappa per salvare i prezzi originali in memoria
const prezziOriginali = new Map();

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

          const variantInfo = await getVariantInfo(variantId);
          const prezzoAttuale = parseFloat(variantInfo.price);

          // Salva prezzo originale se non già salvato
          if (!prezziOriginali.has(variantId)) {
            prezziOriginali.set(variantId, prezzoAttuale);
            console.log(`   💾 Salvato prezzo originale: €${prezzoAttuale}`);
          }

          const prezzoOriginale = prezziOriginali.get(variantId);
          const prezzoScontato = prezzoOriginale * (1 - scontoPercentuale / 100);
          const prezzoScontatoArrotondato = Math.round(prezzoScontato * 100) / 100;

          if (Math.abs(prezzoAttuale - prezzoScontatoArrotondato) > 0.01) {
            await updateVariantPrice(variantId, prezzoScontatoArrotondato);
            console.log(`   ✅ ${variantId}: €${prezzoOriginale} → €${prezzoScontatoArrotondato} (-${scontoPercentuale}%)`);
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

          if (prezziOriginali.has(variantId)) {
            const prezzoOriginale = prezziOriginali.get(variantId);
            const variantInfo = await getVariantInfo(variantId);
            const prezzoAttuale = parseFloat(variantInfo.price);

            if (Math.abs(prezzoAttuale - prezzoOriginale) > 0.01) {
              await updateVariantPrice(variantId, prezzoOriginale);
              console.log(`   ✅ ${variantId}: Ripristinato a €${prezzoOriginale}`);
              prezziOriginali.delete(variantId);
            } else {
              console.log(`   ⏭️  ${variantId}: Già al prezzo originale €${prezzoOriginale}`);
            }
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
