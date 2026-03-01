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
            type
            references(first: 20) {
              edges {
                node {
                  ... on Product {
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
  }`;
  
  const result = await fetchGraphQL(query);
  const now = new Date();
  
  console.log(`\n🕐 Data/ora corrente: ${now.toISOString()}`);
  
  return result.data.metaobjects.edges
    .map(edge => {
      const promo = { products: [], nome: '' };
      
      edge.node.fields.forEach(f => {
        if (f.key === 'nome_promozione') promo.nome = f.value;
        else if (f.key === 'data_inizio') promo.data_inizio = f.value;
        else if (f.key === 'data_fine') promo.data_fine = f.value;
        else if (f.key === 'sconto') promo.sconto_percentuale = f.value;
        else if (f.key === 'prodotti' && f.references && f.references.edges) {
          promo.products = f.references.edges.map(e => ({
            id: e.node.id,
            title: e.node.title
          }));
        }
      });
      
      return promo;
    })
    .filter(promo => {
      if (!promo.data_inizio || !promo.data_fine) {
        console.log(`⚠️ Promo "${promo.nome}": date mancanti, saltata`);
        return false;
      }
      
      const startDate = new Date(promo.data_inizio);
      const endDate = new Date(promo.data_fine);
      const isActive = startDate <= now && endDate >= now;
      
      console.log(`\n📅 Promo: "${promo.nome}"`);
      console.log(`   Inizio: ${startDate.toISOString()}`);
      console.log(`   Fine: ${endDate.toISOString()}`);
      console.log(`   Stato: ${isActive ? '✅ ATTIVA' : '❌ NON ATTIVA'}`);
      
      return isActive;
    });
}

async function getProductDetails(productId) {
  const query = `{
    product(id: "${productId}") {
      id
      title
      variants(first: 1) {
        edges {
          node {
            id
            price
          }
        }
      }
      metafield(namespace: "custom", key: "sconto_promo") {
        value
      }
      originalPriceMetafield: metafield(namespace: "custom", key: "prezzo_originale_backup") {
        value
      }
    }
  }`;
  
  const result = await fetchGraphQL(query);
  return result.data.product;
}

async function saveOriginalPrice(productId, price) {
  const mutation = `mutation {
    productUpdate(input: {
      id: "${productId}",
      metafields: [{
        namespace: "custom",
        key: "prezzo_originale_backup",
        value: "${price}",
        type: "number_decimal"
      }]
    }) {
      product {
        id
      }
    }
  }`;
  
  return fetchGraphQL(mutation);
}

async function updateProductPrice(variantId, newPrice) {
  const mutation = `mutation {
    productVariantUpdate(input: {
      id: "${variantId}",
      price: "${newPrice}"
    }) {
      productVariant {
        id
        price
      }
    }
  }`;
  
  return fetchGraphQL(mutation);
}

async function main() {
  console.log('🚀 Avvio sincronizzazione promo...');
  
  const activePromos = await getActivePromos();
  console.log(`\n✅ Trovate ${activePromos.length} promo attive`);
  
  if (activePromos.length === 0) {
    console.log('⚠️ Nessuna promo attiva al momento');
    return;
  }
  
  for (const promo of activePromos) {
    const defaultDiscount = parseFloat(promo.sconto_percentuale) || 0;
    
    console.log(`\n📦 Elaborazione promo "${promo.nome}"`);
    console.log(`   Prodotti: ${promo.products.length}`);
    console.log(`   Sconto base: ${defaultDiscount}%`);
    
    if (promo.products.length === 0) {
      console.log('⚠️ ATTENZIONE: Nessun prodotto trovato nella promo!');
      continue;
    }
    
    for (const product of promo.products) {
      try {
        const details = await getProductDetails(product.id);
        
        if (!details || !details.variants.edges[0]) {
          console.log(`⚠️ Prodotto ${product.title}: dati non trovati`);
          continue;
        }
        
        const variant = details.variants.edges[0].node;
        const currentPrice = parseFloat(variant.price);
        
        // Controlla se esiste uno sconto personalizzato nel metafield del prodotto
        const productDiscount = details.metafield?.value 
          ? parseFloat(details.metafield.value) 
          : defaultDiscount;
        
        // Usa il prezzo di backup se esiste, altrimenti usa il prezzo attuale
        const originalPrice = details.originalPriceMetafield?.value
          ? parseFloat(details.originalPriceMetafield.value)
          : currentPrice;
        
        // Salva il prezzo originale se non esiste già
        if (!details.originalPriceMetafield?.value) {
          await saveOriginalPrice(product.id, currentPrice.toFixed(2));
          console.log(`💾 Salvato prezzo originale per ${product.title}: €${currentPrice.toFixed(2)}`);
        }
        
        // Calcola il nuovo prezzo scontato
        const newPrice = (originalPrice * (1 - productDiscount / 100)).toFixed(2);
        
        // Aggiorna il prezzo solo se è diverso
        if (Math.abs(currentPrice - parseFloat(newPrice)) > 0.01) {
          await updateProductPrice(variant.id, newPrice);
          console.log(`✅ ${product.title}: €${originalPrice.toFixed(2)} → €${newPrice} (sconto ${productDiscount}%)`);
        } else {
          console.log(`⏭️ ${product.title}: prezzo già aggiornato (€${newPrice})`);
        }
        
      } catch (err) {
        console.error(`❌ Errore elaborazione ${product.title}:`, err.message);
      }
    }
  }
  
  console.log('\n✅ Sincronizzazione completata!');
}

main().catch(err => {
  console.error('❌ Errore:', err);
  process.exit(1);
});
