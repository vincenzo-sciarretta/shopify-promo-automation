// promo-sync.js - Automazione Offerte del Giorno (PRODUCT ID CORRETTO)
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
      variants(first: 10) {
        edges {
          node {
            id
            price
            displayName
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
  
  if (result.data?.productUpdate?.userErrors?.length > 0) {
    console.error(`❌ ERRORE salvataggio prezzo:`, result.data.productUpdate.userErrors);
  }
  
  return result;
}

async function updateVariantPrice(productId, variantId, newPrice) {
  const mutation = `mutation {
    productVariantsBulkUpdate(
      productId: "${productId}",
      variants: [{
        id: "${variantId}",
        price: "${newPrice}"
      }]
    ) {
      productVariants {
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
  console.log(`   Product ID: ${productId}`);
  console.log(`   Variante ID: ${variantId}`);
  console.log(`   Nuovo prezzo: ${newPrice}`);
  console.log(`   Risposta GraphQL:`, JSON.stringify(result, null, 2));
  
  if (result.data?.productVariantsBulkUpdate?.userErrors?.length > 0) {
    console.error(`❌ ERRORE aggiornamento prezzo:`, result.data.productVariantsBulkUpdate.userErrors);
    return false;
  }
  
  if (result.data?.productVariantsBulkUpdate?.productVariants) {
    console.log(`✅ Prezzo aggiornato con successo!`);
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
        
        if (!details || !details.variants.edges.length) {
          console.log(`⚠️ Prodotto ${product.title}: nessuna variante trovata`);
          continue;
        }
        
        // Controlla se esiste uno sconto personalizzato nel metafield del prodotto
        const productDiscount = details.metafield?.value 
          ? parseFloat(details.metafield.value) 
          : defaultDiscount;
        
        console.log(`   Sconto da applicare: ${productDiscount}%`);
        console.log(`   Varianti trovate: ${details.variants.edges.length}`);
        
        // Elabora TUTTE le varianti del prodotto
        for (const variantEdge of details.variants.edges) {
          const variant = variantEdge.node;
          const currentPrice = parseFloat(variant.price);
          
          console.log(`\n   📦 Variante: ${variant.displayName}`);
          console.log(`      ID: ${variant.id}`);
          console.log(`      Prezzo attuale: €${currentPrice}`);
          
          // Usa il prezzo di backup se esiste, altrimenti usa il prezzo attuale
          const originalPrice = details.originalPriceMetafield?.value
            ? parseFloat(details.originalPriceMetafield.value)
            : currentPrice;
          
          // Salva il prezzo originale se non esiste già (solo per la prima variante)
          if (!details.originalPriceMetafield?.value && variantEdge === details.variants.edges[0]) {
            console.log(`      💾 Salvataggio prezzo originale...`);
            await saveOriginalPrice(product.id, currentPrice.toFixed(2));
          }
          
          // Calcola il nuovo prezzo scontato
          const newPrice = (currentPrice * (1 - productDiscount / 100)).toFixed(2);
          
          console.log(`      Calcolo: €${currentPrice} × (1 - ${productDiscount}/100) = €${newPrice}`);
          
          // Aggiorna il prezzo solo se è diverso
          if (Math.abs(currentPrice - parseFloat(newPrice)) > 0.01) {
            console.log(`      🔄 Aggiornamento prezzo da €${currentPrice} a €${newPrice}...`);
            const success = await updateVariantPrice(product.id, variant.id, newPrice);
            
            if (success) {
              console.log(`      ✅ Prezzo aggiornato: €${currentPrice} → €${newPrice}`);
            } else {
              console.log(`      ❌ ERRORE durante l'aggiornamento!`);
            }
          } else {
            console.log(`      ⏭️ Prezzo già aggiornato (€${newPrice})`);
          }
        }
        
        console.log(`\n✅ ${product.title}: tutte le varianti elaborate (sconto ${productDiscount}%)`);
        
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
