require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const db = createClient(
  process.env.GCR_SUPABASE_URL,
  process.env.GCR_SUPABASE_SERVICE_KEY
);

async function insertTiki() {
  try {
    console.log('Inserting Tiki & Raw Bar data...\n');

    // 1. Insert entity
    const { data: entity, error: entityError } = await db
      .from('entity')
      .insert({
        slug: 'tiki-raw-bar',
        name: 'Tiki & Raw Bar',
        subtitle: 'Waterfront Marina Restaurant & Bar',
        description: 'Tiki & Raw Bar is a waterfront restaurant and bar in Orange Beach, located at Safe Harbor Sportsman Marina. Tropical open-air tiki vibe with fresh seafood, raw bar items, tiki cocktails, live music, outdoor seating, and views of Terry Cove.',
        entity_type: 'restaurant',
        entity_subtype: 'bar',
        phone: '(251) 277-4800',
        website_url: 'tikibarorangebeach.com',
        address_line_1: '27844 Canal Rd',
        city: 'Orange Beach',
        state: 'AL',
        zip: '36561',
        price_range: '$$',
        rating: 4.6,
        review_count: 185,
        hero_image_url: 'https://images.unsplash.com/photo-1514432324607-2e467f4af445?w=800&q=80',
        social_instagram: 'tikibarorangebeach',
        hh_start: '15:00',
        hh_end: '18:00',
        hh_days: 'Mon-Fri',
        hh_description: 'Daily happy hour 3-6 PM with food & drink specials',
        live_music: true,
        outdoor_seating: true,
        serves_beer: true,
        serves_wine: true,
        serves_cocktails: true,
        serves_lunch: true,
        serves_dinner: true,
        dine_in: true,
        takeout: true,
        featured: true,
        is_active: true,
      })
      .select()
      .single();

    if (entityError) throw entityError;
    console.log('✓ Entity created:', entity.slug);

    const slug = entity.slug;

    // 2. Insert hours (0=Sunday, 1-6=Mon-Sat)
    const hoursData = [
      { day_of_week: 0, opens_at: '11:00', closes_at: '21:00' }, // Sun
      { day_of_week: 1, opens_at: '11:00', closes_at: '21:00' }, // Mon
      { day_of_week: 2, opens_at: '11:00', closes_at: '21:00' }, // Tue
      { day_of_week: 3, opens_at: '11:00', closes_at: '21:00' }, // Wed
      { day_of_week: 4, opens_at: '11:00', closes_at: '21:00' }, // Thu
      { day_of_week: 5, opens_at: '11:00', closes_at: '22:00' }, // Fri
      { day_of_week: 6, opens_at: '11:00', closes_at: '22:00' }, // Sat
    ];

    for (const h of hoursData) {
      await db.from('entity_hours').insert({
        entity_slug: slug,
        ...h,
      });
    }
    console.log('✓ Hours inserted (7 days)');

    // 3. Insert tags
    const tags = [
      'Full Bar', 'Live Music', 'Outdoor Seating', 'Waterfront', 'Marina View',
      'Sunset View', 'Happy Hour Food', 'Raw Bar', 'Fresh Seafood', 'Tiki Cocktails', 'Pet Friendly'
    ];

    for (const tag of tags) {
      await db.from('entity_tags').insert({
        entity_slug: slug,
        tag_name: tag,
      });
    }
    console.log(`✓ Tags inserted (${tags.length})`);

    // 4. Insert menu sections and items
    const menuData = {
      'Appetizers': [
        { name: 'Oysters on the Half Shell (Half Dozen)', price: 12, desc: 'Fresh raw oysters' },
        { name: 'Oysters on the Half Shell (Dozen)', price: 19, desc: 'Fresh raw oysters' },
        { name: 'Chargrilled Oysters (Half Dozen)', price: 15, desc: 'Chargrilled oysters' },
        { name: 'Chargrilled Oysters (Dozen)', price: 24, desc: 'Chargrilled oysters' },
        { name: 'Crab Claws', price: 20, desc: 'Flash fried blue fin crab claws' },
        { name: 'Street Corn Salsa', price: 10, desc: 'Fire roasted corn, pico de gallo, cilantro, cotija cheese' },
        { name: 'Caribbean Pork Nachos', price: 13, desc: 'Caribbean jerk pork, queso, pico de gallo, mango, jalapeños' },
        { name: 'Poke Nachos', price: 18, desc: 'Tortilla chips, tuna poke, pico de gallo, mango, cabbage, seaweed salad, spicy mayo' },
        { name: 'Loaded Potato Crowns', price: 12, desc: 'Loaded baked potato tots with queso, bacon, chives, sour cream' },
        { name: 'Fried Okra Basket', price: 8, desc: 'Golden fried okra served with ranch' },
        { name: 'Pretzel Bites & Queso', price: 10, desc: 'Soft pretzel bites with queso' },
        { name: 'Smoked Tuna Dip', price: 14, desc: 'Served with naan dippers and optional chips' },
        { name: 'Chips & Queso', price: 8, desc: 'Tortilla chips with queso' },
        { name: 'Fried Mac & Cheese', price: 10, desc: 'Deep fried mac & cheese bites' },
      ],
      'Entrées': [
        { name: 'Tuna Poke', price: 18, desc: 'Ahi tuna, jasmine rice, red cabbage, mango, edamame, seaweed salad' },
        { name: 'Grouper Entrée', price: 28, desc: 'Grilled grouper with citrus rice and steamed vegetables' },
        { name: 'Grouper', price: 24, desc: 'Grilled grouper with steamed vegetables and mashed potatoes' },
        { name: 'Baja Chicken Dinner', price: 20, desc: 'Blackened chicken breast topped with mozzarella, street corn, coleslaw' },
        { name: 'Grilled Chicken', price: 20, desc: 'Two grilled chicken breasts with steamed vegetables and mashed potatoes' },
        { name: 'Chicken Caesar Salad', price: 14, desc: 'Fresh romaine, Caesar dressing, parmesan cheese, grilled chicken' },
        { name: 'Oyster Basket', price: 22, desc: 'Fried oysters served with steak fries, cocktail sauce, coleslaw' },
        { name: 'Fish Basket', price: 19, desc: 'Fried cod with fries, coleslaw, tartar sauce' },
        { name: 'Shrimp Basket', price: 17, desc: 'Fried domestic shrimp with fries, cocktail sauce, coleslaw' },
        { name: 'Chicken Tender Basket', price: 16, desc: 'Golden fried tenders with steak fries' },
        { name: 'Island Wings', price: 15, desc: 'Island spiced wings tossed in island BBQ sauce with steak fries' },
        { name: 'Hickory Smoked Half Rack', price: 25, desc: 'Smoked ribs glazed with hickory BBQ sauce, baked beans, potato salad' },
        { name: 'Country Fried Steak', price: 18, desc: 'Breaded beef cutlet with brown gravy, mac & cheese, mashed potatoes' },
      ],
      'Flatbreads': [
        { name: 'OB Flatbread', price: 12, desc: 'Conecuh sausage, bell peppers, onions, tomato sauce, Cajun spice, mozzarella' },
        { name: 'Margherita Flatbread', price: 12, desc: 'Mozzarella, tomato, fresh basil' },
        { name: 'Pepperoni Flatbread', price: 12, desc: 'Pepperoni, tomato sauce, mozzarella' },
      ],
      'Sandwiches': [
        { name: 'Grouper Sandwich', price: 20, desc: 'Blackened or grilled grouper with lettuce, tomato, tartar sauce' },
        { name: 'Seared Tuna Sandwich', price: 17, desc: 'Lightly blackened ahi tuna steak, cucumber aioli, lettuce, tomato' },
        { name: 'Cheeseburger', price: 16, desc: 'Double patty, lettuce, tomato, onion, pickle, American cheese' },
        { name: 'Po\'boy', price: 18, desc: 'Gambino roll with lettuce, tomato, pickles, tartar sauce, fried shrimp or oysters' },
        { name: 'Patty Melt', price: 16, desc: 'Caramelized onions, pickles, Texas toast, comeback sauce, American cheese' },
        { name: 'Ocho Rios Taco', price: 16, desc: 'Jamaican jerk shrimp, cabbage, mango, pico de gallo, cilantro, spicy mayo' },
        { name: 'Maho Bay Taco', price: 18, desc: 'Grilled mahi mahi, cabbage, cilantro, onion, spicy mayo' },
        { name: 'Key West Taco', price: 16, desc: 'Grilled chicken, cabbage, pico, key lime sauce, cilantro, cotija' },
        { name: 'Chicken Sandwich', price: 15, desc: 'Grilled chicken breast, lettuce, tomato, onion, steak fries' },
      ],
      'Kids Menu': [
        { name: 'Cheese Quesadilla', price: 10, desc: 'For children 12 and under' },
        { name: 'Chicken Tenders', price: 10, desc: 'With fries and drink' },
        { name: 'Fried Shrimp', price: 10, desc: 'With fries and drink' },
        { name: 'Kids Cheeseburger', price: 10, desc: 'With fries and drink' },
      ],
      'Desserts': [
        { name: 'Brownie A La Mode', price: 8, desc: 'Warm brownie with vanilla ice cream, caramel, chocolate sauce' },
        { name: 'Churros', price: 12, desc: 'Cream cheese-filled churros coated in cinnamon sugar' },
        { name: 'Banana Pudding', price: 7, desc: 'Homemade banana pudding' },
      ],
    };

    let menuCount = 0;
    for (const [sectionName, items] of Object.entries(menuData)) {
      const { data: section, error: sectionError } = await db
        .from('menu_sections')
        .insert({
          entity_slug: slug,
          section_name: sectionName,
          sort_order: 0,
        })
        .select()
        .single();

      if (sectionError) throw sectionError;

      for (const item of items) {
        await db.from('menu_items').insert({
          section_id: section.id,
          entity_slug: slug,
          item_name: item.name,
          price: item.price,
          description: item.desc,
        });
        menuCount++;
      }
    }
    console.log(`✓ Menu sections inserted (6 sections, ${menuCount} items)`);

    // 5. Insert drink sections and items
    const drinkData = {
      'Tiki Originals': [
        { name: 'Pain Killer', price: 12, desc: 'Dark rum, pineapple juice, orange juice, coconut cream, nutmeg' },
        { name: 'Alabama Point', price: 12, desc: 'Coconut rum, banana rum, peach schnapps, pineapple juice, orange juice' },
        { name: 'O.B. Sunset', price: 10, desc: 'Coconut rum, spiced rum, pineapple juice, orange juice, grenadine' },
        { name: 'Blue Angel', price: 10, desc: 'Lemon vodka and coconut Red Bull' },
        { name: 'Tiki Rita', price: 12, desc: 'Tequila, key lime juice, agave, sour mix, Grand Marnier' },
        { name: 'Coco Rita', price: 12, desc: 'Coconut tequila, pineapple juice, coconut cream, toasted coconut' },
        { name: 'Spicy Paloma', price: 12, desc: 'Jalapeño tequila, grapefruit juice, agave, lime juice, soda' },
        { name: 'Stargazer', price: 12, desc: 'Honeysuckle vodka, cucumber gin, prickly pear, cucumber, soda' },
        { name: 'Strawberry Shores', price: 12, desc: 'Strawberry vodka, lemon juice, strawberries, lemonade' },
        { name: 'Perdido Key Lime', price: 10, desc: 'Whipped cream vodka, coconut cream, key lime juice, soda' },
        { name: 'Orange-gasm', price: 10, desc: 'Whipped cream vodka, orange vodka, coconut cream, orange juice' },
      ],
      'Frozen Drinks': [
        { name: 'Frozen Margarita', price: 10, desc: 'Frozen margarita' },
        { name: 'Dock Daiquiri', price: 12, desc: 'Strawberry, piña colada, or mango' },
        { name: 'Tiki Bushwacker', price: 15, desc: 'Frozen bushwacker with tropical garnish' },
      ],
      'Beer': [
        { name: 'Budweiser', price: 5, desc: '' },
        { name: 'Bud Light', price: 5, desc: '' },
        { name: 'Corona Extra', price: 6, desc: '' },
        { name: 'Modelo', price: 6, desc: '' },
        { name: 'Guinness', price: 7, desc: '' },
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
    console.log(`✓ Drink sections inserted (3 sections, ${drinkCount} items)`);

    // 6. Insert events
    const events = [
      { date: '2026-05-28', artist: 'Amanda Pruitt Duo', time: '18:00' },
      { date: '2026-05-28', artist: 'Funky Lampshades', time: '20:00' },
      { date: '2026-05-29', artist: 'Bobby Trent Toy Duo', time: '18:30' },
      { date: '2026-05-29', artist: 'Pineapple Express Band', time: '20:00' },
      { date: '2026-05-30', artist: 'Basch Jernigan Trio', time: '18:30' },
      { date: '2026-05-30', artist: 'Bobby Trent & the Regulars', time: '20:00' },
      { date: '2026-05-31', artist: 'Justin Colvard & Adam Ty', time: '18:00' },
      { date: '2026-05-31', artist: 'Strictly Rivers', time: '20:00' },
    ];

    for (const evt of events) {
      await db.from('entity_events').insert({
        entity_slug: slug,
        entity_name: 'Tiki & Raw Bar',
        event_name: `Live Music: ${evt.artist}`,
        artist_name: evt.artist,
        event_date: evt.date,
        start_time: evt.time,
        description: `Live music performance`,
        is_active: true,
      });
    }
    console.log(`✓ Events inserted (${events.length})`);

    console.log('\n✅ All Tiki & Raw Bar data inserted successfully!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

insertTiki();
