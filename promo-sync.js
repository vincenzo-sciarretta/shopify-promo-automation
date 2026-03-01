// promo-sync.js - Automazione Offerte del Giorno (DEBUG AVANZATO)
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
      userErrors {
        field
        message
      }
    }
  }`;
  
  const result = await fetchGraphQL(mutation);
  
  console.log(`\n🔍 DEBUG - Salvataggio prezzo originale:`);
  console.log(`   Prodotto: ${productId}`);
  console.log(`   Prezzo: ${price}`);
  console.log(`   Risposta GraphQL:`, JSON.stringify(result, null, 2));
  
  if (result.data?.productUpdate?.userErrors?.length > 0) {
    console.error(`❌ ERRORE salvataggio prezzo:`, result.data.productUpdate.userErrors);
  }
  
  return result;
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
      userErrors {
        field
        message
      }
    }
  }`;
  
  const result = await fetchGraphQL(mutation);
  
  console.log(`\n🔍 DEBUG - Aggiornamento prezzo variante:`);
  console.log(`   Variante ID: ${variantId}`);
  console.log(`   Nuovo prezzo: ${newPrice}`);
  console.log(`   Risposta GraphQL:`, JSON.stringify(result, null, 2));
  
  if (result.data?.productVariantUpdate?.userErrors?.length > 0) {
    console.error(`❌ ERRORE aggiornamento prezzo:`, result.data.productVariantUpdate.userErrors);
    return false;
  }
  
  if (result.data?.productVariantUpdate?.productVariant) {
    console.log(`✅ Prezzo aggiornato con successo! Nuovo prezzo: ${result.data.productVariantUpdate.productVariant.price}`);
    return true;
  }
  
  return false;
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
        console.log(`\n--- Elaborazione prodotto: ${product.title} ---`);
        
        const details = await getProductDetails(product.id);
        
        if (!details || !details.variants.edges[0]) {
          console.log(`⚠️ Prodotto ${product.title}: dati non trovati`);
          continue;
        }
        
        const variant = details.variants.edges[0].node;
        const currentPrice = parseFloat(variant.price);
        
        console.log(`   Variante ID: ${variant.id}`);
        console.log(`   Prezzo attuale: €${currentPrice}`);
        
        // Controlla se esiste uno sconto personalizzato nel metafield del prodotto
        const productDiscount = details.metafield?.value 
          ? parseFloat(details.metafield.value) 
          : defaultDiscount;
        
        console.log(`   Sconto da applicare: ${productDiscount}%`);
        
        // Usa il prezzo di backup se esiste, altrimenti usa il prezzo attuale
        const originalPrice = details.originalPriceMetafield?.value
          ? parseFloat(details.originalPriceMetafield.value)
          : currentPrice;
        
        console.log(`   Prezzo originale (backup): €${originalPrice}`);
        
        // Salva il prezzo originale se non esiste già
        if (!details.originalPriceMetafield?.value) {
          console.log(`   💾 Salvataggio prezzo originale...`);
          await saveOriginalPrice(product.id, currentPrice.toFixed(2));
        }
        
        // Calcola il nuovo prezzo scontato
        const newPrice = (originalPrice * (1 - productDiscount / 100)).toFixed(2);
        
        console.log(`   Calcolo: €${originalPrice} × (1 - ${productDiscount}/100) = €${newPrice}`);
        
        // Aggiorna il prezzo solo se è diverso
        if (Math.abs(currentPrice - parseFloat(newPrice)) > 0.01) {
          console.log(`   🔄 Aggiornamento prezzo da €${currentPrice} a €${newPrice}...`);
          const success = await updateProductPrice(variant.id, newPrice);
          
          if (success) {
            console.log(`✅ ${product.title}: €${originalPrice.toFixed(2)} → €${newPrice} (sconto ${productDiscount}%)`);
          } else {
            console.log(`❌ ${product.title}: ERRORE durante l'aggiornamento!`);
          }
        } else {
          console.log(`⏭️ ${product.title}: prezzo già aggiornato (€${newPrice})`);
        }
        
      } catch (err) {
        console.error(`❌ Errore elaborazione ${product.title}:`, err.message);
        console.error(`   Stack trace:`, err.stack);
      }
    }
  }
  
  console.log('\n✅ Sincronizzazione completata!');
}

main().catch(err => {
  console.error('❌ Errore fatale:', err);
  console.error('Stack trace:', err.stack);
  process.exit(1);
});
