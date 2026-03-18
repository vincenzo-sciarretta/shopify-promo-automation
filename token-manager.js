require('dotenv').config();

async function getToken() {
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  if (!token) throw new Error('SHOPIFY_ACCESS_TOKEN non configurato nei secrets!');
  console.log('✅ Token dalla variabile ambiente');
  return token;
}

module.exports = { getToken };

if (require.main === module) {
  getToken()
    .then(token => {
      console.log('\n✅ Token disponibile e pronto!');
    })
    .catch(err => {
      console.error('❌ Errore:', err.message);
      process.exit(1);
    });
}
