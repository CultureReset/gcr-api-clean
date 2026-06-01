require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const db = createClient(process.env.GCR_SUPABASE_URL, process.env.GCR_SUPABASE_SERVICE_KEY);

const SLUG = 'cobalt-the-restaurant';

const cobaltData = {
  "restaurant": {
    "name": "Cobalt the Restaurant",
    "address": "28099 Perdido Beach Blvd, Orange Beach, AL 36561",
    "phone": "(251) 923-5300",
    "description": "Waterfront seafood restaurant known for contemporary coastal cuisine, bay views, casual atmosphere, live music, lunch, dinner, Sunday brunch, happy hour specials, boat slips, and indoor/outdoor seating.",
    "price_range": "$20–30",
    "rating": 4.5
  },
  "menus": [
    {
      "name": "Lunch Menu",
      "sections": [
        { "name": "Lunch Appetizers", "items": [
          { "name": "Crab Claws", "price": null, "description": "Lightly fried and served with cocktail sauce." },
          { "name": "Tuna And Avocado Stack", "price": "$14.00", "description": "Sashimi grade tuna and avocado tossed in sweet Asian sauce, served between crisp wontons." },
          { "name": "BBQ Gulf Shrimp", "price": "$15.00", "description": "Sautéed in a Creole butter sauce and served with grilled French bread." },
          { "name": "Firecracker Shrimp", "price": "$14.00", "description": "Lightly dusted bay shrimp fried and tossed in spicy remoulade sauce." },
          { "name": "Cobalt Crab And Shrimp Dip", "price": "$15.00", "description": "Hot creamy blend of fresh blue crab and tender bay shrimp with roasted sweet red peppers, Parmesan and Swiss cheese. Accompanied by grilled French bread." },
          { "name": "Cobalt Caviar", "price": "$9.00", "description": "Black beans, edamame, corn, red onion, Roma tomatoes and cilantro tossed in a light vinaigrette with corn tortilla chips." },
          { "name": "Crab And Scallop Cakes", "price": "$13.00", "description": "Three fried crab and scallop cakes over cole slaw with charred green tomato remoulade." },
          { "name": "Cobalt Cheese Dip", "price": "$10.00", "description": "Parmesan and Swiss cheese blend topped with Cotija cheese and poblano green tomato relish. Served with crisp corn chips." }
        ]},
        { "name": "Lunch Soups", "items": [
          { "name": "Cobalt Crab Bisque", "price": "$6.00", "description": "Creamy blend of sweet blue crab, sweet corn and roasted tomato." },
          { "name": "Soup Of The Day", "price": "$6.00", "description": null }
        ]},
        { "name": "Lunch Salads", "items": [
          { "name": "House", "price": "$10.00", "description": "Romaine and spring greens with tomato, red onions, cucumbers and peppadews." },
          { "name": "Caesar", "price": "$6.00", "description": "Romaine, housemade traditional dressing, croutons and shaved Parmesan." },
          { "name": "Cobalt Wedge", "price": "$12.00", "description": "Baby iceberg lettuce with tomato, cucumber, red onion, bacon, bleu cheese crumbles and bleu cheese dressing." },
          { "name": "Blackened Tuna", "price": "$20.00", "description": "Mixed greens with Champagne citrus vinaigrette, candied pecans, goat cheese, orange segments and pickled vegetables." }
        ]},
        { "name": "Lunch Entrées", "items": [
          { "name": "Fresh Catch", "price": "Market", "description": "Served grilled, blackened or fried with jambalaya rice and brown butter green beans." },
          { "name": "Pecan Fried Catfish", "price": "$14.50", "description": "Alabama farm-raised filet over tasso ham, sweet corn and black-eyed pea succotash with dill tartar." },
          { "name": "Gulf Shrimp And Grits", "price": "$14.00", "description": "Half dozen Gulf shrimp skewered, chargrilled and topped with Cajun cream sauce over buttermilk pepper jack cheese grits." },
          { "name": "Fried Platters", "price": "$16.00", "description": "Lightly dusted and fried Gulf seafood with fries, cole slaw and cocktail or tartar sauce." }
        ]},
        { "name": "Lunch Sandwiches", "items": [
          { "name": "Cobalt Beast Burger", "price": "$20.00", "description": "Elk, wild boar, wagyu and bison burger with bleu cheese, bacon, caramelized onions and garlic aioli." },
          { "name": "The Do It Yourselfer", "price": "$14.00", "description": "Certified Angus Beef chuck, short rib and brisket burger on sourdough bun." },
          { "name": "Sweet Heat Chicken Sandwich", "price": "$13.00", "description": "Fried chicken tossed in sweet heat sauce with lettuce, tomato, onion, pickles, garlic aioli and provolone." },
          { "name": "Po' Boys", "price": "$14.00", "description": "Served on toasted French loaf with lettuce and tomato." }
        ]}
      ]
    },
    {
      "name": "Dinner Menu",
      "sections": [
        { "name": "Dinner Entrées", "items": [
          { "name": "Fresh Catch", "price": "Market", "description": "Served grilled, blackened or fried with jambalaya rice and brown butter green beans." },
          { "name": "Surf-N-Surf", "price": "$35.00", "description": "Blackened Gulf yellowfin tuna and two fried crab and scallop cakes over grits and asparagus." },
          { "name": "Pecan Fried Catfish", "price": "$26.00", "description": "Alabama farm-raised filets over tasso ham, sweet corn and black-eyed pea succotash." },
          { "name": "Gulf Shrimp And Grits", "price": "$25.00", "description": "One dozen Gulf shrimp over buttermilk pepper jack cheese grits with Cajun cream sauce." },
          { "name": "Blackened Redfish", "price": "$31.00", "description": "Served with jambalaya, grilled asparagus and Louisiana hot sauce hollandaise." },
          { "name": "Delmonico Ribeye", "price": "$43.00", "description": "14 oz ribeye with smoked cheddar bacon mashed potatoes, green beans and port demi-glace." },
          { "name": "Filet", "price": "$41.00", "description": "8 oz filet with mashed potatoes, asparagus and Cobalt steak butter." },
          { "name": "Free Range Chicken Breast", "price": "$22.00", "description": "Bone-in chicken over pepper jack grits, Brussels sprouts and Creole tasso gravy." }
        ]}
      ]
    },
    {
      "name": "Kids Menu",
      "sections": [
        { "name": "Kids Entrées", "items": [
          { "name": "Hamburger", "price": "$8.00", "description": "Served with fries." },
          { "name": "Cheeseburger", "price": "$9.00", "description": "Served with fries." },
          { "name": "Fish", "price": "$9.00", "description": "Grilled or fried. Served with fries." },
          { "name": "Chicken", "price": "$7.00", "description": "Grilled or fried. Served with fries." },
          { "name": "Fried Shrimp", "price": "$8.00", "description": "Served with fries." }
        ]}
      ]
    },
    {
      "name": "Sunday Brunch",
      "sections": [
        { "name": "Eggs Benedict", "items": [
          { "name": "Crab And Scallop Cake Benedict", "price": "$15.00", "description": "Two crab and scallop cakes over English muffin with poached eggs and roasted red bell pepper hollandaise." },
          { "name": "Traditional Benedict", "price": "$12.00", "description": "English muffins with Canadian bacon, poached eggs and Louisiana hot sauce hollandaise." }
        ]},
        { "name": "Omelets", "items": [
          { "name": "Western Omelet", "price": "$14.00", "description": "Andouille sausage, tomato, onion, tasso and cheddar with salsa." },
          { "name": "Seafood Omelet", "price": "$18.00", "description": "Bay shrimp, blue crab, spinach, onion and Parmesan with roasted red bell pepper hollandaise." },
          { "name": "Cheese Omelet", "price": "$11.00", "description": "Cheddar cheese omelet." }
        ]}
      ]
    }
  ],
  "drinks": [
    {
      "name": "Specialty Drinks",
      "items": [
        { "name": "Orange Beach Margarita", "price": "$12.00", "description": "Lunazul Silver, lemon, lime, Gran Gala, orange zest and house salt." },
        { "name": "The Lost Paloma", "price": "$13.00", "description": "Ruby red grapefruit, agave, Tajin, lime and Montelobos Mezcal." },
        { "name": "Bourbon Blush", "price": "$13.00", "description": "Maker's Mark, lemon, mint, pomegranate cactus pear juice and maple syrup." },
        { "name": "Espresso Martini", "price": "$12.00", "description": "Tito's, Kahlúa and fresh espresso." }
      ]
    }
  ],
  "happy_hour": {
    "days": "Monday,Tuesday,Wednesday,Thursday,Friday",
    "start": "15:00",
    "end": "18:00",
    "items": [
      { "name": "Cobalt Caviar", "price": "$5.00", "original_price": "$9.00", "description": "Happy hour special." },
      { "name": "House Wine", "price": "$4.00", "original_price": "$7.00", "description": "Happy hour special." }
    ]
  }
};

async function run() {
  console.log('Checking if cobalt-the-restaurant exists in DB...');
  const { data: entity } = await db.from('entity').select('id, slug, name').eq('slug', SLUG).single();

  if (!entity) {
    console.log('Entity not found — creating cobalt-the-restaurant...');
    const { error } = await db.from('entity').insert({
      slug: SLUG,
      name: cobaltData.restaurant.name,
      description: cobaltData.restaurant.description,
      phone: cobaltData.restaurant.phone,
      address_line_1: cobaltData.restaurant.address,
      city: 'Orange Beach',
      state: 'AL',
      price_range: cobaltData.restaurant.price_range,
      rating: cobaltData.restaurant.rating,
      entity_type: 'restaurant',
      menu_pin: '1234',
      is_active: true
    });
    if (error) { console.error('Failed to create entity:', error.message); process.exit(1); }
    console.log('✅ Entity created');
  } else {
    console.log('✅ Entity exists:', entity.name);
    // Set PIN
    await db.from('entity').update({ menu_pin: '1234' }).eq('slug', SLUG);
  }

  // Clear existing menu data
  console.log('Clearing existing menu data...');
  await db.from('menu_sections').delete().eq('entity_slug', SLUG);
  await db.from('drink_sections').delete().eq('entity_slug', SLUG);
  await db.from('happy_hour_sections').delete().eq('entity_slug', SLUG);

  // Insert all menu sections from all menus (flatten into menu_sections)
  console.log('Inserting menu sections...');
  let menuOrder = 0;
  for (const menu of cobaltData.menus) {
    for (const section of menu.sections) {
      const { data: sec } = await db.from('menu_sections').insert({
        entity_slug: SLUG,
        section_name: `${section.name}`,
        sort_order: menuOrder++
      }).select().single();

      if (sec && section.items) {
        for (const item of section.items) {
          const priceNum = item.price && item.price !== 'Market' ? parseFloat(item.price.replace('$','')) : null;
          await db.from('menu_items').insert({
            entity_slug: SLUG,
            section_id: sec.id,
            item_name: item.name,
            description: item.description || null,
            price: priceNum
          });
        }
      }
    }
  }
  console.log(`✅ Inserted ${menuOrder} menu sections`);

  // Insert drink sections
  console.log('Inserting drink sections...');
  for (let i = 0; i < cobaltData.drinks.length; i++) {
    const drinkSection = cobaltData.drinks[i];
    const { data: sec } = await db.from('drink_sections').insert({
      entity_slug: SLUG,
      section_name: drinkSection.name,
      sort_order: i
    }).select().single();

    if (sec && drinkSection.items) {
      for (const item of drinkSection.items) {
        const priceNum = item.price ? parseFloat(item.price.replace('$','')) : null;
        await db.from('drink_items').insert({
          entity_slug: SLUG,
          section_id: sec.id,
          item_name: item.name,
          description: item.description || null,
          price: priceNum
        });
      }
    }
  }
  console.log('✅ Drink sections inserted');

  // Insert happy hour
  console.log('Inserting happy hour...');
  await db.from('entity').update({
    hh_days: cobaltData.happy_hour.days,
    hh_start: cobaltData.happy_hour.start,
    hh_end: cobaltData.happy_hour.end
  }).eq('slug', SLUG);

  const { data: hhSec } = await db.from('happy_hour_sections').insert({
    entity_slug: SLUG,
    section_name: 'Happy Hour Specials',
    sort_order: 0
  }).select().single();

  if (hhSec) {
    for (const item of cobaltData.happy_hour.items) {
      await db.from('happy_hour_items').insert({
        entity_slug: SLUG,
        section_id: hhSec.id,
        item_name: item.name,
        description: item.description || null,
        price: item.price ? parseFloat(item.price.replace('$','')) : null,
        original_price: item.original_price ? parseFloat(item.original_price.replace('$','')) : null
      });
    }
  }
  console.log('✅ Happy hour inserted');

  console.log('\n✅ DONE! Cobalt the Restaurant is in the DB.');
  console.log(`   Slug: ${SLUG}`);
  console.log(`   PIN: 1234`);
  console.log(`   Menu editor URL: https://restaurant-menu-editor.vercel.app/?slug=${SLUG}`);
  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
