require('dotenv').config({ path: '.env.local' });
const { createClient } = require('@supabase/supabase-js');

const db = createClient(
  process.env.GCR_SUPABASE_URL.trim(),
  process.env.GCR_SUPABASE_SERVICE_KEY.trim()
);

const slug = 'cobalt-the-restaurant';

const entity = {
  slug,
  name: 'Cobalt the Restaurant',
  subtitle: 'Waterfront Seafood & Coastal Cuisine',
  entity_type: 'restaurant',
  entity_subtype: 'seafood',
  description: 'Waterfront seafood restaurant known for contemporary coastal cuisine, bay views, casual atmosphere, live music, lunch, dinner, Sunday brunch, happy hour specials, boat slips, and indoor/outdoor seating.',
  phone: '(251) 923-5300',
  address_line_1: '28099 Perdido Beach Blvd',
  city: 'Orange Beach',
  state: 'AL',
  zip: '36561',
  price_range: '$$$',
  rating: 4.5,
  review_count: 6800,
  icon: '🦞',
  serves_brunch: true,
  serves_lunch: true,
  serves_dinner: true,
  outdoor_seating: true,
  live_music: true,
  reservable: true,
  dine_in: true,
  takeout: true,
  delivery: true,
  serves_beer: true,
  serves_wine: true,
  serves_cocktails: true,
  good_for_groups: true,
  good_for_kids: true,
  hh_days: 'Daily',
  hh_start: '15:00',
  hh_end: '17:00',
  hh_description: 'Daily 3:00–5:00 PM. Drink specials and discounted appetizers.',
  is_active: true,
  featured: false,
};

const tags = [
  { tag_name: 'Seafood',             tag_category: 'cuisine' },
  { tag_name: 'Waterfront Dining',   tag_category: 'vibe' },
  { tag_name: 'Live Music',          tag_category: 'vibe' },
  { tag_name: 'Happy Hour',          tag_category: 'feature' },
  { tag_name: 'Sunday Brunch',       tag_category: 'feature' },
  { tag_name: 'Boat Access',         tag_category: 'feature' },
  { tag_name: 'Cocktails',           tag_category: 'feature' },
  { tag_name: 'Great Wine List',     tag_category: 'feature' },
  { tag_name: 'Great Coffee',        tag_category: 'feature' },
  { tag_name: 'Private Dining Room', tag_category: 'feature' },
  { tag_name: 'Gluten-Free Menu',    tag_category: 'dietary' },
  { tag_name: 'Catering Available',  tag_category: 'feature' },
  { tag_name: 'Good For Kids',       tag_category: 'audience' },
  { tag_name: 'Good For Groups',     tag_category: 'audience' },
  { tag_name: 'Outdoor Seating',     tag_category: 'feature' },
  { tag_name: 'Dogs Allowed',          tag_category: 'feature' },
  { tag_name: 'Orange Beach',          tag_category: 'location' },
  { tag_name: 'Casual',               tag_category: 'atmosphere' },
  { tag_name: 'Upscale',              tag_category: 'atmosphere' },
  { tag_name: 'Romantic',             tag_category: 'atmosphere' },
  { tag_name: 'Trendy',               tag_category: 'atmosphere' },
  { tag_name: 'Free Parking',         tag_category: 'feature' },
  { tag_name: 'High Chairs',          tag_category: 'feature' },
  { tag_name: 'Changing Tables',      tag_category: 'feature' },
  { tag_name: 'Wi-Fi',                tag_category: 'feature' },
  { tag_name: 'Bar Onsite',           tag_category: 'feature' },
  { tag_name: 'Wheelchair Accessible', tag_category: 'feature' },
];

// ── Food → menu_sections ──────────────────────────────────────────────────────
const menuSections = [
  {
    name: 'Lunch Appetizers',
    items: [
      { name: 'Crab Claws', price: null, description: 'Lightly fried and served with cocktail sauce.' },
      { name: 'Tuna And Avocado Stack', price: 14.00, description: 'Sashimi grade tuna and avocado tossed in sweet Asian sauce, served between crisp wontons.' },
      { name: 'BBQ Gulf Shrimp', price: 15.00, description: 'Sautéed in a Creole butter sauce and served with grilled French bread.' },
      { name: 'Firecracker Shrimp', price: 14.00, description: 'Lightly dusted bay shrimp fried and tossed in spicy remoulade sauce.' },
      { name: 'Cobalt Crab And Shrimp Dip', price: 15.00, description: 'Hot creamy blend of fresh blue crab and tender bay shrimp with roasted sweet red peppers, Parmesan and Swiss cheese. Accompanied by grilled French bread.' },
      { name: 'Cobalt Caviar', price: 9.00, description: 'Black beans, edamame, corn, red onion, Roma tomatoes and cilantro tossed in a light vinaigrette with corn tortilla chips.' },
      { name: 'Crab And Scallop Cakes', price: 13.00, description: 'Three fried crab and scallop cakes over cole slaw with charred green tomato remoulade.' },
      { name: 'Cobalt Cheese Dip', price: 10.00, description: 'Parmesan and Swiss cheese blend topped with Cotija cheese and poblano green tomato relish. Served with crisp corn chips.' },
    ],
  },
  {
    name: 'Lunch Oysters',
    items: [
      { name: 'Raw', price: null, description: 'Gulf raw oysters served with cocktail sauce and horseradish.' },
      { name: 'Creole Casino', price: null, description: 'Tasso, jalapeño, red bell pepper, shallots, cream cheese and smoked Gouda. Served with grilled French bread.' },
      { name: 'Garlic Parmesan Chargrilled', price: null, description: 'Garlic butter and Parmesan cheese. Served with grilled French bread.' },
      { name: 'Rockefeller', price: null, description: 'Spinach, garlic, shallots, parsley, anchovies, green onion, anisette and Parmesan. Served with grilled French bread.' },
      { name: 'Combination', price: null, description: 'Selection of Garlic Parmesan, Creole Casino and Rockefeller oysters.' },
    ],
  },
  {
    name: 'Lunch Soups',
    items: [
      { name: 'Cobalt Crab Bisque', price: 6.00, description: 'Creamy blend of sweet blue crab, sweet corn and roasted tomato.' },
      { name: 'Soup Of The Day', price: 6.00, description: null },
    ],
  },
  {
    name: 'Lunch Salads',
    items: [
      { name: 'House', price: 10.00, description: 'Romaine and spring greens with tomato, red onions, cucumbers and peppadews.' },
      { name: 'Caesar', price: 6.00, description: 'Romaine, housemade traditional dressing, croutons and shaved Parmesan.' },
      { name: 'Cobalt Wedge', price: 12.00, description: 'Baby iceberg lettuce with tomato, cucumber, red onion, bacon, bleu cheese crumbles and bleu cheese dressing.' },
      { name: 'Blackened Tuna', price: 20.00, description: 'Mixed greens with Champagne citrus vinaigrette, candied pecans, goat cheese, orange segments and pickled vegetables.' },
    ],
  },
  {
    name: 'Lunch Entrées',
    items: [
      { name: 'Fresh Catch', price: null, description: 'Served grilled, blackened or fried with jambalaya rice and brown butter green beans. Oscar topping available.' },
      { name: 'Pecan Fried Catfish', price: 14.50, description: 'Alabama farm-raised filet over tasso ham, sweet corn and black-eyed pea succotash with dill tartar.' },
      { name: 'Gulf Shrimp And Grits', price: 14.00, description: 'Half dozen Gulf shrimp skewered, chargrilled and topped with Cajun cream sauce over buttermilk pepper jack cheese grits.' },
      { name: 'Fried Platters', price: 16.00, description: 'Lightly dusted and fried Gulf seafood with fries, cole slaw and cocktail or tartar sauce.' },
    ],
  },
  {
    name: 'Lunch Pizza',
    items: [
      { name: 'Margherita', price: 14.00, description: 'House crust with olive oil, roasted Roma tomatoes, fresh mozzarella and basil.' },
      { name: 'Cobalt Pizza', price: 17.00, description: 'Grilled chicken, smoked bacon, spinach, arugula, mushrooms, onions, marinara, mozzarella and smoked Gouda.' },
      { name: 'Build Your Own Pizza', price: 11.00, description: 'Sauce: marinara, Alfredo or roasted garlic oil. Additional toppings $2 each.' },
    ],
  },
  {
    name: 'Lunch Pasta',
    items: [
      { name: 'Chicken Parmesan', price: 14.00, description: 'Parmesan and herb-crusted chicken over angel hair pasta with marinara.' },
      { name: 'Zydeco Chicken', price: 18.00, description: 'Blackened chicken with tasso ham, onions, bell peppers and pappardelle pasta in Cajun Alfredo.' },
      { name: 'Shrimp Fra Diavolo', price: 18.00, description: 'Gulf shrimp with mushrooms, onions, lemon, spinach, arugula and spicy marinara over angel hair.' },
    ],
  },
  {
    name: 'Lunch Sandwiches',
    items: [
      { name: 'Cobalt Beast Burger', price: 20.00, description: 'Elk, wild boar, wagyu and bison burger with bleu cheese, bacon, caramelized onions and garlic aioli.' },
      { name: 'The Do It Yourselfer', price: 14.00, description: 'Certified Angus Beef chuck, short rib and brisket burger on sourdough bun.' },
      { name: 'Sweet Heat Chicken Sandwich', price: 13.00, description: 'Fried chicken tossed in sweet heat sauce with lettuce, tomato, onion, pickles, garlic aioli and provolone.' },
      { name: 'Super Grilled Cheese', price: 13.00, description: 'Smoked Gouda, Parmesan, Swiss, provolone and American cheeses with bacon and tomatoes.' },
      { name: "Po' Boys", price: 14.00, description: 'Served on toasted French loaf with lettuce and tomato.' },
      { name: 'Fish Sandwich', price: null, description: 'Fresh selection grilled, blackened or fried on sourdough with lettuce, tomato and onion.' },
      { name: 'Tuna Melt', price: 13.00, description: 'Housemade tuna salad on BuzzCatz bread with aioli, lettuce, tomato and shredded cheddar.' },
    ],
  },
  {
    name: 'Dinner Entrées',
    items: [
      { name: 'Fresh Catch', price: null, description: 'Served grilled, blackened or fried with jambalaya rice and brown butter green beans.' },
      { name: 'Surf-N-Surf', price: 35.00, description: 'Blackened Gulf yellowfin tuna and two fried crab and scallop cakes over grits and asparagus.' },
      { name: 'Bronzed Gulf Grouper', price: null, description: 'Served over Parmesan risotto with Cajun cream sautéed blue crab.' },
      { name: 'Pecan Fried Catfish', price: 26.00, description: 'Alabama farm-raised filets over tasso ham, sweet corn and black-eyed pea succotash.' },
      { name: 'Gulf Shrimp And Grits', price: 25.00, description: 'One dozen Gulf shrimp over buttermilk pepper jack cheese grits with Cajun cream sauce.' },
      { name: 'Fried Platters', price: 24.00, description: 'Fried Gulf seafood with fries, cole slaw and cocktail or tartar sauce.' },
      { name: 'Blackened Redfish', price: 31.00, description: 'Served with jambalaya, grilled asparagus and Louisiana hot sauce hollandaise.' },
      { name: 'White BBQ Pork Tenderloin', price: 24.00, description: 'Pork tenderloin with Brie cream gnocchi, Brussels sprouts, onion rings and pepper jelly.' },
      { name: 'Delmonico Ribeye', price: 43.00, description: '14 oz ribeye with smoked cheddar bacon mashed potatoes, green beans and port demi-glace.' },
      { name: 'Filet', price: 41.00, description: '8 oz filet with mashed potatoes, asparagus and Cobalt steak butter.' },
      { name: 'Free Range Chicken Breast', price: 22.00, description: 'Bone-in chicken over pepper jack grits, Brussels sprouts and Creole tasso gravy.' },
    ],
  },
  {
    name: 'Kids Entrées',
    items: [
      { name: 'Hamburger', price: 8.00, description: 'Served with fries.' },
      { name: 'Cheeseburger', price: 9.00, description: 'Served with fries.' },
      { name: 'Fish', price: 9.00, description: 'Grilled or fried. Served with fries.' },
      { name: 'Chicken', price: 7.00, description: 'Grilled or fried. Served with fries.' },
      { name: 'Fried Shrimp', price: 8.00, description: 'Served with fries.' },
      { name: 'Pasta Marinara', price: 5.00, description: null },
      { name: 'Pasta Alfredo', price: 7.00, description: null },
    ],
  },
  {
    name: 'Eggs Benedict',
    items: [
      { name: 'Crab And Scallop Cake Benedict', price: 15.00, description: 'Two crab and scallop cakes over English muffin with poached eggs and roasted red bell pepper hollandaise.' },
      { name: 'Traditional Benedict', price: 12.00, description: 'English muffins with Canadian bacon, poached eggs and Louisiana hot sauce hollandaise.' },
    ],
  },
  {
    name: 'Omelets',
    items: [
      { name: 'Western Omelet', price: 14.00, description: 'Andouille sausage, tomato, onion, tasso and cheddar with salsa.' },
      { name: 'Seafood Omelet', price: 18.00, description: 'Bay shrimp, blue crab, spinach, onion and Parmesan with roasted red bell pepper hollandaise.' },
      { name: 'Vegetable Omelet', price: 12.00, description: 'Tomato, spinach, onion and bell pepper.' },
      { name: 'Cheese Omelet', price: 11.00, description: 'Cheddar cheese omelet.' },
    ],
  },
  {
    name: 'Morning Fare',
    items: [
      { name: 'Sausage Biscuit', price: 3.00, description: null },
      { name: 'Ham & Swiss Croissant', price: 7.00, description: null },
      { name: 'Spinach & Feta Croissant', price: 7.00, description: null },
      { name: 'Chocolate Croissant', price: 3.00, description: null },
      { name: 'Glazed Donuts', price: 2.00, description: null },
      { name: 'Muffin', price: 3.00, description: 'Banana nut or blueberry.' },
      { name: 'Cinnamon Roll', price: 3.00, description: null },
    ],
  },
];

// ── Drinks → drink_sections ───────────────────────────────────────────────────
const drinkSections = [
  {
    name: 'Specialty Drinks',
    items: [
      { name: 'Orange Beach Margarita', price: 12.00, description: 'Lunazul Silver, lemon, lime, Gran Gala, orange zest and house salt. Don Julio Blanco upgrade $6.' },
      { name: 'The Lost Paloma', price: 13.00, description: 'Ruby red grapefruit, agave, Tajin, lime and Montelobos Mezcal. Chili pepper lime juice add-on $1.' },
      { name: 'Bourbon Blush', price: 13.00, description: "Maker's Mark, lemon, mint, pomegranate cactus pear juice and maple syrup." },
      { name: 'Espresso Martini', price: 12.00, description: "Smirnoff Whipped Vodka, Kahlúa, Bailey's Irish Cream and espresso." },
      { name: 'Sangria', price: 10.00, description: 'Red or white.' },
      { name: 'Ube Squeeze', price: 11.00, description: 'Ube, Smirnoff Raspberry Vodka and lemonade.' },
      { name: 'Pain Killer', price: 11.00, description: 'Pineapple, orange, coconut and Captain Morgan Spiced Rum. 151 Rum or Skrewball floater add-on $3.' },
      { name: 'The Lei', price: 10.00, description: 'Captain Morgan Spiced Rum, Cruzan Coconut Rum, Blue Curaçao and pineapple juice.' },
    ],
  },
  {
    name: 'Frozen Drinks',
    items: [
      { name: 'Bushwacker', price: 12.00, description: 'Cruzan Coconut Rum, coffee liqueur, dark Créme de Cocoa and vanilla bean ice cream. Floater add-on $3.' },
      { name: 'Daiquiris', price: 12.00, description: 'Strawberry, Banana, Piña Colada, or Strawberry Colada blended with house rum.' },
      { name: 'Margarita', price: 12.00, description: 'House tequila and Pelican Bay margarita mix with salt rim and lime.' },
    ],
  },
  {
    name: 'Brunch Drinks',
    items: [
      { name: 'Mimosa', price: 4.00, description: null },
      { name: 'Poinsetta', price: 4.00, description: null },
      { name: 'Bloody Mary', price: 4.00, description: null },
      { name: 'Screwdriver', price: 4.00, description: null },
      { name: 'Champagne', price: 5.00, description: null },
    ],
  },
  {
    name: 'Kids Drinks',
    items: [
      { name: 'Virgin Frozen Daiquiri', price: 6.00, description: 'Pina Colada, Strawberry, or Banana.' },
      { name: 'Fairlife Milk', price: 2.50, description: 'Classic, Chocolate or Strawberry.' },
      { name: 'Juice', price: 2.50, description: 'Orange or Apple.' },
      { name: 'Abita Rootbeer', price: 3.50, description: null },
      { name: 'Soft Drinks', price: 3.75, description: 'Coca-Cola products.' },
      { name: 'Sweet Or Unsweet Tea', price: 3.75, description: null },
    ],
  },
  {
    name: 'Hot Coffee Drinks',
    items: [
      { name: 'Drip Coffee', price: 3.00, description: null },
      { name: 'Americano', price: 4.50, description: null },
      { name: 'Cappuccino', price: 4.25, description: null },
      { name: 'Chai Tea Latte', price: 4.25, description: null },
      { name: 'Latte', price: 4.25, description: null },
      { name: 'Macchiato', price: 4.25, description: null },
      { name: 'Mocha', price: 4.50, description: null },
      { name: 'Cuban', price: 4.50, description: null },
      { name: 'Hot Chocolate', price: 4.50, description: null },
      { name: 'White Chocolate', price: 4.50, description: null },
      { name: 'Espresso', price: 3.25, description: null },
      { name: 'Flavored Syrups', price: 0.85, description: null },
      { name: 'Alternative Milk', price: 0.85, description: null },
      { name: 'Extra Shot Of Espresso', price: 1.00, description: null },
      { name: 'Double Shot Of Espresso', price: 3.25, description: null },
    ],
  },
  {
    name: 'Cold Coffee Drinks',
    items: [
      { name: 'Iced Latte', price: 4.25, description: null },
      { name: 'Chai Tea Latte', price: 4.25, description: null },
      { name: 'Macchiato', price: 4.25, description: null },
      { name: 'Iced Americano', price: 4.50, description: null },
      { name: 'Iced Cuban', price: 4.50, description: null },
      { name: 'Iced Mocha', price: 4.50, description: null },
      { name: 'Iced White Mocha', price: 4.50, description: null },
      { name: 'Cold Brew', price: 4.25, description: null },
      { name: 'Cobalt Frappe', price: 5.50, description: null },
    ],
  },
  {
    name: 'Cafe Drinks',
    items: [
      { name: 'Frozen Virgin Daiquiris', price: 6.00, description: 'Strawberry, Banana, Piña Colada, or Mango.' },
      { name: 'Poolside Punch', price: 14.00, description: 'Vodka, coconut, pineapple and mango. Frozen or on the rocks.' },
      { name: 'Seahorse', price: 14.00, description: 'Vodka, lemonade and strawberry purée. Frozen or on the rocks.' },
      { name: 'Yellow Hammer', price: 14.00, description: 'Vodka, pineapple juice and orange juice.' },
      { name: 'Cabana Flamingo', price: 14.00, description: 'Rum, pineapple, fresh lime and grenadine. Frozen or on the rocks.' },
      { name: 'Cabana Banana', price: 14.00, description: 'Rum, banana purée, pineapple juice and orange juice.' },
      { name: 'Bloody Mary', price: 14.00, description: 'Vodka and Zing Zang.' },
      { name: 'Daiquiris', price: 14.00, description: 'Rum with Strawberry, Banana, Piña Colada, Mango, or mix of two.' },
      { name: 'House Margaritas', price: 14.00, description: 'House tequila, triple sec and lime, mango or strawberry mix.' },
      { name: 'Bushwacker', price: 14.00, description: 'Hand scooped ice cream, coconut rum and chocolate.' },
      { name: 'Domestic Beer', price: 4.25, description: null },
      { name: 'Imported Beer', price: 5.50, description: null },
      { name: 'Craft Beer', price: null, description: 'Ask server for selection.' },
    ],
  },
  {
    name: 'Chardonnay',
    items: [
      { name: 'Seasun By Caymus', price: 9.00, description: 'California' },
      { name: 'Josh Cellars Craftsmen Collection', price: 10.00, description: 'California' },
      { name: 'Duckhorn Decoy', price: 11.00, description: 'California' },
      { name: 'La Crema', price: 13.00, description: 'Monterey, California' },
      { name: 'Rombauer', price: 93.00, description: 'Carneros, California' },
    ],
  },
  {
    name: 'Pinot Gris & Pinot Grigio',
    items: [
      { name: 'Kris', price: 9.00, description: 'Delle Venezie, Italy' },
      { name: 'J Vineyards Pinot Gris', price: 11.00, description: 'California' },
      { name: 'Santa Margherita', price: 54.00, description: 'Alto-Adige, Italy' },
    ],
  },
  {
    name: 'Sauvignon Blanc',
    items: [
      { name: 'Emmolo', price: 10.00, description: 'California' },
      { name: 'Mohua', price: 11.00, description: 'Marlborough, New Zealand' },
      { name: 'Whitehaven', price: 12.00, description: 'Marlborough, New Zealand' },
      { name: 'Napa Cellars', price: 13.00, description: 'Napa Valley, California' },
      { name: 'Orin Swift Blank Stare', price: 71.00, description: 'Russian River Valley, Sonoma County' },
      { name: 'Domaine Reverdy-Ducroux, Sancerre', price: 75.00, description: 'Sancerre AOC, France' },
    ],
  },
  {
    name: 'Red Wines',
    items: [
      { name: 'Charles & Charles, Bolt Cabernet Sauvignon', price: 9.00, description: 'Columbia Valley, Washington' },
      { name: 'Joel Gott Cabernet Sauvignon', price: 12.00, description: 'California' },
      { name: 'Broadbent Cabernet Sauvignon', price: 13.00, description: 'North Coast, California' },
      { name: 'Murphy Goode Merlot', price: 9.00, description: 'California' },
      { name: 'Tinto Negro Malbec', price: 9.00, description: 'Mendoza, Argentina' },
      { name: 'Rabble Zinfandel', price: 13.00, description: 'Paso Robles, California' },
      { name: 'The Prisoner', price: 90.00, description: 'Napa Valley, California' },
    ],
  },
  {
    name: 'Reserve List',
    items: [
      { name: 'Caymus Napa Cabernet Sauvignon', price: 116.00, description: null },
      { name: 'Orin Swift Papillon Red', price: 126.00, description: null },
      { name: "Stagg's Leap Artemis", price: 145.00, description: null },
      { name: 'Frank Family Winston Hill Reserve', price: 245.00, description: null },
      { name: 'Silver Oak Cabernet Sauvignon', price: 292.00, description: null },
    ],
  },
];

// ── Happy Hour → happy_hour_sections ─────────────────────────────────────────
const happyHourSections = [
  {
    name: 'Drink Specials',
    items: [
      { name: 'Urban South Paradise Park Draft', price: 2.50 },
      { name: "Luna's House Brew", price: 2.50 },
      { name: 'Good People Muchacho', price: 3.00 },
      { name: 'Braided River Hoppy By Nature IPA', price: 5.00 },
      { name: 'House Wine', price: 3.00 },
      { name: 'Well Drinks', price: 3.50 },
    ],
  },
  {
    name: 'Happy Hour Appetizers',
    items: [
      { name: 'Raw Oysters', price: null, description: 'Market price.' },
      { name: 'Cheese Pizza', price: 8.00, description: null },
      { name: 'Cobalt Caviar', price: 5.00, description: 'Black beans, edamame, corn, red onion, roma tomatoes and cilantro tossed in a light vinaigrette and served with corn tortilla chips.' },
      { name: 'Cheese Dip', price: 8.00, description: 'A velvety blend of parmesan and Swiss cheeses. Topped with crumbled Cotija cheese and a poblano green tomato relish. Served with corn tortilla chips.' },
      { name: 'Firecracker Shrimp', price: 8.00, description: 'Lightly dusted bay shrimp fried and tossed in spicy remoulade sauce.' },
    ],
  },
];

// ── Events ────────────────────────────────────────────────────────────────────
const events = [
  { event_name: 'Homies Duo', artist_name: 'Homies Duo', event_date: '2026-06-01', start_time: '17:00', event_type: 'Live Music', recurring: false },
  { event_name: 'Strickly Rivers', artist_name: 'Strickly Rivers', event_date: '2026-06-02', start_time: '17:00', event_type: 'Live Music', recurring: false },
  { event_name: 'Justin Fobes', artist_name: 'Justin Fobes', event_date: '2026-06-03', start_time: '17:00', event_type: 'Live Music', recurring: false },
  { event_name: 'Caviar Blake', artist_name: 'Cavair Blake', event_date: '2026-06-04', start_time: '17:00', event_type: 'Live Music', recurring: false },
  { event_name: 'Thin Red Line', artist_name: 'Thin Red Line', event_date: '2026-06-05', start_time: '17:30', event_type: 'Live Music', recurring: false },
  { event_name: 'The Mellow-Dramatics', artist_name: 'The Mellow-Dramatics', event_date: '2026-06-06', start_time: '17:30', event_type: 'Live Music', recurring: false },
  { event_name: 'Justin Fobes — Sunday Brunch', artist_name: 'Justin Fobes', event_date: '2026-06-07', start_time: '11:00', end_time: '14:00', event_type: 'Sunday Brunch Music', recurring: false },
  { event_name: 'Nigel Dickie', artist_name: 'Nigel Dickie', event_date: '2026-06-07', start_time: '17:00', event_type: 'Live Music', recurring: false },
];

// ── helpers ───────────────────────────────────────────────────────────────────
function parsePrice(p) {
  if (p == null || p === 'Market') return null;
  return parseFloat(String(p).replace('$', ''));
}

async function insertSections(table, itemTable, sections) {
  for (const [i, sec] of sections.entries()) {
    const { data: s, error } = await db.from(table)
      .insert({ entity_slug: slug, section_name: sec.name, sort_order: i })
      .select('id').single();
    if (error || !s) { console.error(`  ⚠️  ${table} "${sec.name}":`, error?.message); continue; }
    if (sec.items?.length) {
      const rows = sec.items.map((item) => ({
        entity_slug: slug, section_id: s.id,
        item_name: item.name,
        description: item.description || null,
        price: parsePrice(item.price),
      }));
      const { error: ie } = await db.from(itemTable).insert(rows);
      if (ie) console.error(`  ⚠️  ${itemTable} items for "${sec.name}":`, ie.message);
    }
  }
}

async function run() {
  console.log('Inserting Cobalt the Restaurant...\n');

  const { error: e1 } = await db.from('entity').upsert(entity, { onConflict: 'slug' });
  if (e1) { console.error('❌ entity:', e1.message); process.exit(1); }
  console.log('✅ Entity');

  await db.from('entity_tags').delete().eq('entity_slug', slug);
  await db.from('entity_tags').insert(tags.map(t => ({ entity_slug: slug, ...t })));
  console.log(`✅ ${tags.length} tags`);

  await db.from('menu_items').delete().eq('entity_slug', slug);
  await db.from('menu_sections').delete().eq('entity_slug', slug);
  await insertSections('menu_sections', 'menu_items', menuSections);
  console.log(`✅ ${menuSections.length} menu sections`);

  await db.from('drink_items').delete().eq('entity_slug', slug);
  await db.from('drink_sections').delete().eq('entity_slug', slug);
  await insertSections('drink_sections', 'drink_items', drinkSections);
  console.log(`✅ ${drinkSections.length} drink sections`);

  await db.from('happy_hour_items').delete().eq('entity_slug', slug);
  await db.from('happy_hour_sections').delete().eq('entity_slug', slug);
  await insertSections('happy_hour_sections', 'happy_hour_items', happyHourSections);
  console.log(`✅ ${happyHourSections.length} happy hour sections`);

  await db.from('entity_events').delete().eq('entity_slug', slug);
  const { error: evErr } = await db.from('entity_events').insert(events.map(e => ({
    entity_slug: slug,
    event_name: e.event_name,
    artist_name: e.artist_name,
    event_date: e.event_date,
    start_time: e.start_time,
    end_time: e.end_time || null,
    recurring: e.recurring,
    is_active: true,
  })));
  if (evErr) console.error('⚠️  events:', evErr.message);
  else console.log(`✅ ${events.length} events`);

  console.log('\nDone! Cobalt the Restaurant is live.');
}

run();
