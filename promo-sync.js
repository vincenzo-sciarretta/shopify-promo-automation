// promo-sync.js - Automazione prezzi promo con gestione varianti
const fetch = require('node-fetch');

const SHOP = process.env.SHOPIFY_STORE;
const ACCESS_TOKEN = process.env.SHOPIFY_TOKEN;
const API_VERSION = '2024-10';

const GRAPHQL_ENDPOINT = `https://${SHOP}/admin/api/${API_VERSION}/graphql.json`;

// Funzione per eseguire query GraphQL
async function graphqlQuery(query, variables = {}) {
  const response = await fetch(GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': ACCESS_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });

  const result = await response.json();
  
  if (result.errors) {
    console.error('GraphQL Errors:', JSON.stringify(result.errors, null, 2));
    throw new Error('GraphQL query failed');
  }
  
  return result.data;
}

// Recupera tutte le promo attive dal metaobject calendario_promo
async function getActivePromos() {
  const today = new Date().toISOString().split('T')[0];
  
  const query = `
    query {
      metaobjects(type: "calendario_promo", first: 50) {
        edges {
          node {
            id
            fields {
              key
              value
              reference {
                ... on ProductVariant {
                  id
                  price
                  product {
                    id
                    title
                  }
                }
              }
              references(first: 50) {
                edges {
                  node {
                    ... on ProductVariant {
                      id
                      price
                      product {
                        id
                        title
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

  const data = await graphqlQuery(query);
  const promos = [];

  for (const edge of data.metaobjects.edges) {
    const fields = edge.node.fields;
    
    const dataInizio = fields.find(f => f.key === 'data_inizio')?.value;
    const dataFine = fields.find(f => f.key === 'data_fine')?.value;
    const sconto = parseFloat(fields.find(f => f.key === 'sconto')?.value || 0);
    const nomePromo = fields.find(f => f.key === 'nome_promozione')?.value;
    const prezzoOriginale = parseFloat(fields.find(f => f.key === 'prezzo_originale')?.value || 0);
    
    // Recupera le varianti dal campo "prodotti" (lista di riferimenti)
    const prodottiField = fields.find(f => f.key === 'prodotti');
    const varianti = prodottiField?.references?.edges.map(e => e.node) || [];

    // Verifica se la promo è attiva oggi
    const isActive = dataInizio <= today && today <= dataFine;

    promos.push({
      id: edge.node.id,
      nome: nomePromo,
      dataInizio,
      dataFine,
      sconto,
      prezzoOriginale,
      varianti,
      isActive,
    });
  }

  return promos;
}

// Aggiorna il prezzo di una variante
async function updateVariantPrice(variantId, newPrice) {
  // Prima recuperiamo il productId dalla variante
  const getProductQuery = `
    query getProduct($id: ID!) {
      productVariant(id: $id) {
        id
        product {
          id
        }
      }
    }
  `;
  
  const variantData = await graphqlQuery(getProductQuery, { id: variantId });
  const productId = variantData.productVariant.product.id;
  
  // Poi aggiorniamo il prodotto con la variante modificata
  const mutation = `
    mutation productUpdate($input: ProductInput!) {
      productUpdate(input: $input) {
        product {
          id
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
      id: productId,
      variants: [
        {
          id: variantId,
          price: newPrice.toFixed(2),
        },
      ],
    },
  };

  const data = await graphqlQuery(mutation, variables);
  
  if (data.productUpdate.userErrors.length > 0) {
    console.error('Errori aggiornamento variante:', data.productUpdate.userErrors);
    throw new Error('Errore aggiornamento prezzo variante');
  }

  return data.productUpdate.product;
}

// Salva il prezzo originale nel metafield della variante (backup)
async function saveOriginalPrice(variantId, originalPrice) {
  const mutation = `
    mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields {
          id
          value
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = {
    metafields: [
      {
        ownerId: variantId,
        namespace: 'promo',
        key: 'backup_price',
        value: originalPrice.toString(),
        type: 'number_decimal',
      },
    ],
  };

  await graphqlQuery(mutation, variables);
}

// Recupera il prezzo di backup dalla variante
async function getBackupPrice(variantId) {
  const query = `
    query getVariant($id: ID!) {
      productVariant(id: $id) {
        id
        price
        metafield(namespace: "promo", key: "backup_price") {
          value
        }
      }
    }
  `;

  const data = await graphqlQuery(query, { id: variantId });
  const backupPrice = data.productVariant.metafield?.value;
  
  return backupPrice ? parseFloat(backupPrice) : null;
}

// Funzione principale
async function main() {
  console.log('🚀 Avvio sincronizzazione promo...');
  
  const promos = await getActivePromos();
  console.log(`📋 Trovate ${promos.length} promo nel calendario`);

  for (const promo of promos) {
    console.log(`\n📌 Promo: ${promo.nome}`);
    console.log(`   Periodo: ${promo.dataInizio} → ${promo.dataFine}`);
    console.log(`   Sconto: ${promo.sconto}%`);
    console.log(`   Varianti: ${promo.varianti.length}`);
    console.log(`   Attiva: ${promo.isActive ? '✅ SÌ' : '❌ NO'}`);

    for (const variante of promo.varianti) {
      const variantId = variante.id;
      const currentPrice = parseFloat(variante.price);
      const productTitle = variante.product.title;

      if (promo.isActive) {
        // APPLICA SCONTO
        
        // 1. Recupera il prezzo di backup (se esiste)
        let backupPrice = await getBackupPrice(variantId);
        
        // 2. Se non esiste backup, usa prezzo_originale dal metaobject o prezzo corrente
        if (!backupPrice) {
          backupPrice = promo.prezzoOriginale > 0 ? promo.prezzoOriginale : currentPrice;
          await saveOriginalPrice(variantId, backupPrice);
          console.log(`   💾 Salvato backup: €${backupPrice.toFixed(2)} per ${productTitle}`);
        }

        // 3. Calcola prezzo scontato dal backup
        const discountedPrice = backupPrice * (1 - promo.sconto / 100);

        // 4. Applica solo se diverso dal prezzo corrente
        if (Math.abs(currentPrice - discountedPrice) > 0.01) {
          await updateVariantPrice(variantId, discountedPrice);
          console.log(`   ✅ ${productTitle}: €${currentPrice.toFixed(2)} → €${discountedPrice.toFixed(2)}`);
        } else {
          console.log(`   ⏭️  ${productTitle}: già scontato a €${discountedPrice.toFixed(2)}`);
        }

      } else {
        // RIPRISTINA PREZZO ORIGINALE
        
        const backupPrice = await getBackupPrice(variantId);
        
        if (backupPrice && Math.abs(currentPrice - backupPrice) > 0.01) {
          await updateVariantPrice(variantId, backupPrice);
          console.log(`   🔄 ${productTitle}: €${currentPrice.toFixed(2)} → €${backupPrice.toFixed(2)} (ripristinato)`);
        } else {
          console.log(`   ⏭️  ${productTitle}: già al prezzo originale €${currentPrice.toFixed(2)}`);
        }
      }
    }
  }

  console.log('\n✅ Sincronizzazione completata!');
}

main().catch(error => {
  console.error('❌ Errore:', error);
  process.exit(1);
});
