require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const db = createClient(
  process.env.GCR_SUPABASE_URL,
  process.env.GCR_SUPABASE_SERVICE_KEY
);

async function insertTikiComplete() {
  try {
    console.log('Adding missing Tiki & Raw Bar drinks...\n');

    const slug = 'tiki-raw-bar';

    // Complete drink data from the file
    const drinkData = {
      'Seasonal Sips': [
        { name: 'Tropic Like Its Hot', price: null, desc: 'Pineapple tequila, jalapeño syrup, Tajin rim' },
        { name: 'Tai Mai Boat', price: null, desc: "Papa's Pilar rum, orgeat, triple sec, mint" },
        { name: "Clyde's Coastal Smash", price: null, desc: 'Alabama whiskey, blackberry puree, ginger beer' },
        { name: "Clyde May's Pirate's Passion", price: null, desc: 'Passionfruit puree, chile liqueur, lemon' },
        { name: 'Pom Voyage', price: null, desc: 'Rum, pomegranate liqueur, mint, lime' },
        { name: 'Lavender Lagoon', price: null, desc: 'Empress gin, lavender syrup, lemon juice' },
        { name: 'Red Headed Stranger', price: null, desc: 'Ginger liqueur, peach puree, prosecco' },
        { name: 'Bloody Mary', price: null, desc: "Tito's vodka with Captain Buck Mayo mix" },
      ],
      'Shooters': [
        { name: 'Cheeseburger Shooter', price: null, desc: 'Tequila-based signature shooter' },
        { name: 'Breakfast Shot', price: null, desc: 'Jameson, butterscotch schnapps, orange juice' },
        { name: 'Sunny D', price: null, desc: 'Orange vodka, triple sec, orange juice, Red Bull' },
        { name: 'Beach Bomb', price: null, desc: 'Crown Apple and tropical Red Bull' },
      ],
      'Beer': [
        { name: 'Budweiser', price: null, desc: '' },
        { name: 'Bud Light', price: null, desc: '' },
        { name: 'Busch Light', price: null, desc: '' },
        { name: 'Coors Banquet', price: null, desc: '' },
        { name: 'Coors Light', price: null, desc: '' },
        { name: 'Corona Extra', price: null, desc: '' },
        { name: 'Corona Light', price: null, desc: '' },
        { name: 'Hazy Little Thing IPA', price: null, desc: '' },
        { name: 'Fly Llama Fly IPA', price: null, desc: '' },
        { name: 'Landshark', price: null, desc: '' },
        { name: 'Michelob Ultra', price: null, desc: '' },
        { name: 'Miller Lite', price: null, desc: '' },
        { name: 'Modelo', price: null, desc: '' },
        { name: 'Montucky', price: null, desc: '' },
        { name: 'Red Stripe', price: null, desc: '' },
        { name: 'Twisted Tea', price: null, desc: '' },
        { name: 'Yuengling', price: null, desc: '' },
        { name: 'Guinness', price: null, desc: '' },
        { name: 'Hoop Tea', price: null, desc: '' },
        { name: 'High Noon', price: null, desc: '' },
      ],
      'Ciders & Seltzers': [
        { name: 'Kopparberg Pear Cider', price: null, desc: '' },
        { name: 'Kopparberg Strawberry Cider', price: null, desc: '' },
        { name: 'High Noon Peach', price: null, desc: '' },
        { name: 'High Noon Pineapple', price: null, desc: '' },
        { name: 'High Noon Tequila', price: null, desc: '' },
      ],
      'Wine': [
        { name: 'Chardonnay', price: 6.50, desc: 'Glass' },
        { name: 'Pinot Grigio', price: 6.50, desc: 'Glass' },
        { name: 'Cabernet Sauvignon', price: 6.50, desc: 'Glass' },
        { name: 'Pinot Noir', price: 6.50, desc: 'Glass' },
        { name: 'Prosecco', price: 6.50, desc: 'Glass' },
        { name: 'Seasonal Sangria', price: 7, desc: 'Glass' },
        { name: 'Mark West Pinot Noir', price: 25, desc: 'Bottle' },
        { name: 'Josh Cabernet', price: 25, desc: 'Bottle' },
        { name: 'Kim Crawford Sauvignon Blanc', price: 25, desc: 'Bottle' },
        { name: 'Franciscan Chardonnay', price: 25, desc: 'Bottle' },
        { name: 'Mezzacorona Pinot Grigio', price: 25, desc: 'Bottle' },
        { name: 'Seaglass Cabernet', price: 25, desc: 'Bottle' },
        { name: 'LaMarca Prosecco', price: 25, desc: 'Bottle' },
      ],
    };

    let drinkCount = 0;
    for (const [sectionName, items] of Object.entries(drinkData)) {
      const { data: section, error: sectionError } = await db
        .from('drink_sections')
        .insert({
          entity_slug: slug,
          section_name: sectionName,
          sort_order: 0,
        })
        .select()
        .single();

      if (sectionError) throw sectionError;

      for (const item of items) {
        await db.from('drink_items').insert({
          section_id: section.id,
          entity_slug: slug,
          item_name: item.name,
          price: item.price,
          description: item.desc,
        });
        drinkCount++;
      }
    }
    console.log(`✓ Added ${Object.keys(drinkData).length} drink sections with ${drinkCount} items total`);
    console.log('\n✅ All missing Tiki & Raw Bar drinks added!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

insertTikiComplete();
