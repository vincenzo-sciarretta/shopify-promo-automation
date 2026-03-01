// promo-sync.js - Automazione Offerte del Giorno
const STORE = process.env.SHOPIFY_STORE;
const TOKEN = process.env.SHOPIFY_TOKEN;
const API_URL = `https://${STORE}.myshopify.com/admin/api/2024-01/graphql.json`;

async function fetchGraphQL(query) {
  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': TOKEN
    },
    body: JSON.stringify({ query })
  });
  return response.json();
}

async function getActivePromos() {
  const query = `{
    metaobjects(type: "calendario_promo", first: 10) {
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
  
  const result = await fetchGraphQL(query);
  const today = new Date().toISOString().split('T')[0];
  
  return result.data.metaobjects.edges
    .map(edge => {
      const fields = {};
      edge.node.fields.forEach(f => fields[f.key] = f.value);
      return fields;
    })
    .filter(promo => promo.data_inizio <= today && promo.data_fine >= today);
}

async function updateProductPrice(productId, newPrice, originalPrice) {
  const mutation = `mutation {
    productUpdate(input: {
      id: "${productId}",
      variants: [{
        price: "${newPrice}"
      }]
    }) {
      product {
        id
        variants(first: 1) {
          edges {
            node {
              price
            }
          }
        }
      }
    }
  }`;
  
  console.log(`Aggiornamento prezzo prodotto ${productId}: ${originalPrice} → ${newPrice}`);
  return fetchGraphQL(mutation);
}

async function main() {
  console.log('🚀 Avvio sincronizzazione promo...');
  
  const activePromos = await getActivePromos();
  console.log(`✅ Trovate ${activePromos.length} promo attive`);
  
  for (const promo of activePromos) {
    const productId = promo.prodotto_id;
    const discountPercent = parseFloat(promo.sconto_percentuale);
    const originalPrice = parseFloat(promo.prezzo_originale);
    const newPrice = (originalPrice * (1 - discountPercent / 100)).toFixed(2);
    
    await updateProductPrice(productId, newPrice, originalPrice);
  }
  
  console.log('✅ Sincronizzazione completata!');
}

main().catch(err => {
  console.error('❌ Errore:', err);
  process.exit(1);
});
