# Feb (profiles) Recovery Vault Index

Source project: mhafixflyffflwjhcgfn ("profiles", Feb snapshot). 207 sites in `businesses`.
Matching: normalized-phone (site_content.contact_phone) against live entity.phone; Feb has no Google place IDs so place-id matching is N/A. 85 sites matched, 9 keyed sites with no live match, 113 sites unkeyed (no phone; mostly per-product tour pages and test sites).
When one phone maps to multiple live entities, live_slug = best name-similar entity, preferring entities that carry a google_place_id (canonical over placeholder duplicates); such records carry phone_ambiguous + phone_entity_count. Known aggregator phone 8504245125 maps to ~36 live tour entities.

## Files / totals

| file | records | net_new | overlap | unmatched |
|---|---|---|---|---|
| specials.json | 91 | 77 | 0 | 14 |
| events.json | 105 | 97 | 0 | 8 |
| reviews.json | 267 | 20 | 58 | 189 |
| menus.json | 1186 | 171 | 788 | 227 |
| about-texts.json | 177 | 1 | 81 | 95 |
| galleries.json | 108 | 0 | 45 | 63 |
| qna.json | 306 | 20 | 0 | 286 |
| whats-included.json | 319 | 28 | 0 | 291 |
| site-meta.json | 176 | 82 | 0 | 94 |
| net-new-candidates.json | 9 | 9 | 0 | 0 |

- galleries.json spans 108 sites / 1071 image URLs — ALL galleries extracted (widened scope). No matched live entity is photo-less, so none are net_new; the prior audit's "8 zero-photo businesses / 87 URLs" reflected placeholder duplicate live entities (the canonical entities all have photos).
- menus.json: all 1,186 menu_items rows across 90 sites (widened scope). net_new = rows on matched sites whose live entity has zero menu_items (10 businesses / 171 rows: DeSoto's Seafood Kitchen 70, Milkshake Momma 27, The Clubhouse Bar & Grill 15, Island Ice Cream & Treats 14, Wacked Out Weiner Gulf Shores 13, The Tin Top Restaurant & Oyster Bar 8, Bar 45 7, Yumm Twister & Ice Cream 7, Happy Pappys Coffeehouse 5, Pizza At The Pass 5); rows on matched sites where live already has a menu = overlap.
- reviews.json: net_new only where the matched live entity has zero entity_reviews (Bottomed Out Fishing Charters 10, Sunny Lady 10); other matched-site reviews = overlap.
- about-texts.json: every site with non-empty about_text/hero_text/hero_subtext. net_new = matched live entity with empty description (only Beachside Circle Boat Rentals and Sales under canonical matching).

## Per-business (sites with any recovered content)

| business | site_id | live_slug | status | specials | events | reviews | menu items | gallery urls | qna | whats_incl | about | meta |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A Specialty Bakery and Party Shoppe | 2a836d00-fd56-4345-8ed0-ea455f823f75 |  | net_new_site | 0 | 0 | 0 | 20 | 4 | 0 | 0 | 1 | 1 |
| Agave Bar & Grill | 65e28dbe-3a67-494c-b484-8889229ad9fe |  | net_new_site | 0 | 0 | 0 | 3 | 8 | 0 | 0 | 1 | 1 |
| Alabama Gulf Coast Zoo | 78be87c2-5235-4b3f-8c44-f607ffdaa1ed | alabama-gulf-coast-zoo | matched | 2 | 10 | 0 | 0 | 12 | 0 | 0 | 1 | 1 |
| Amberjack E-bike Rentals | 7acc510c-6b7c-4788-85dd-cdde00f2ef62 |  | unmatched | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 |
| Anchor Bar & Grill | 694472dc-2728-4200-97e3-7bb77f3e1ca3 | anchor-bar-and-grill | matched | 0 | 0 | 6 | 0 | 0 | 0 | 0 | 1 | 1 |
| Anchored Coffeehouse | ddacbece-7a70-44f4-a8c1-19cd671bb919 |  | unmatched | 0 | 0 | 0 | 60 | 2 | 0 | 0 | 1 | 1 |
| Angry Crab Shack | b4ef2f4b-0770-4ebd-8399-9b7fd92aae3b |  | net_new_site | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 1 | 1 |
| Bahama Bob's | ab904e01-7ce4-4f7b-afc5-e97469aec927 | bahama-bob-s-beach-side-cafe | matched | 0 | 0 | 3 | 0 | 0 | 0 | 0 | 1 | 1 |
| Bar 45 | 0e27f2c2-2c2d-42e6-b876-028cbed7434e | bar-45 | matched | 0 | 0 | 0 | 7 | 12 | 0 | 0 | 1 | 1 |
| Barometer Waterfront Grille | 803c1786-5fa4-4c72-bb26-32de82950732 | barometer-waterfront-grille | matched | 8 | 7 | 0 | 0 | 0 | 0 | 0 | 1 | 1 |
| Beach Club Resort | b3c80813-a650-4580-88df-15f6a7a54225 |  | unmatched | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 |
| Beachside Circle Boat Rentals and Sales | 22222222-2222-2222-2222-222222222222 | beachside-circle-boat-rentals-and-sales | matched | 0 | 0 | 0 | 0 | 8 | 10 | 7 | 1 | 1 |
| Big Beach Brewing Company | c46b0c37-7617-471a-b138-29c6e116eb14 | big-beach-brewing | matched | 0 | 1 | 0 | 0 | 10 | 0 | 0 | 1 | 1 |
| Big Mike's Steakhouse | 85fbd056-7c5e-436d-8322-5abfcfd58469 |  | unmatched | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 1 | 1 |
| Bird Dog Chicken Company | 0eeb726f-de25-4ccf-a965-95d14fc1a240 | bird-dog-chicken-company | matched | 0 | 0 | 0 | 0 | 11 | 0 | 0 | 0 | 0 |
| Bleus Burger | 59663204-f62d-4cd7-ba80-bc94f87bcd4c |  | unmatched | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 |
| BOLO Steak & Seafood | ce3b5ad0-d157-4ff5-a6f4-b71cc04887f6 |  | net_new_site | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 |
| Bottomed Out Fishing Charters | 0382f712-4f82-45e0-ae01-d57ec25ae767 | bottomed-out-fishing-charters | matched | 0 | 0 | 10 | 0 | 0 | 0 | 0 | 1 | 1 |
| Brick & Spoon | ff2977ec-a8db-495b-ae38-2bf2efaf9fe4 | eden-spa-salon | matched | 3 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 |
| BuzzCatz Coffee & Sweets | bd2fe45a-075b-4dfd-ae6e-521b557ac3b5 |  | unmatched | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| BuzzCatz Coffee & Sweets | bfebaf69-d3e7-4a4d-8fcc-ca9ae9f83be5 | lunas-eat-and-drink-orange-beach | matched | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 |
| Cactus Cantina Mexican Grill | a8a82df5-a1a6-4d28-8ae4-abb3e24b6e20 |  | unmatched | 0 | 0 | 0 | 0 | 3 | 0 | 0 | 1 | 1 |
| Carmelo | b6bc283b-5d91-4b36-add9-657a5e2e1999 | ristorante-carmelo | matched | 0 | 0 | 0 | 0 | 12 | 0 | 0 | 1 | 1 |
| Carmelo Italian | ae2328e9-4f88-424e-8e44-4e8dce1746db | ristorante-carmelo | matched | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 |
| Coastal Bakery | 388a699f-d47b-4ed0-a609-ca77866ae061 |  | unmatched | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 |
| COASTAL Orange Beach | fbbc15b6-7e86-4ba9-b324-a486dafa4027 | coastal-orange-beach | matched | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 1 | 1 |
| Cobalt The Restaurant | d100d8e6-fc48-48cc-a248-e50db9f93824 | cobalt-the-restaurant | matched | 2 | 1 | 0 | 267 | 12 | 0 | 0 | 1 | 1 |
| Cosmo's Restaurant & Bar | bf4cd444-ec5e-430a-9fb8-d69d390be0ee | cosmo-s-restaurant-bar | matched | 7 | 1 | 0 | 13 | 4 | 5 | 8 | 1 | 1 |
| Cosmo's Restaurant & Bar | a7db3a25-2f94-410d-9694-fbee5658bb23 | cosmo-s-restaurant-bar | matched | 0 | 0 | 0 | 13 | 12 | 0 | 0 | 1 | 1 |
| Cosmo's Restaurant & Bar | bb655e3d-5c89-4387-86bf-a68a2e98c72f | cosmo-s-restaurant-bar | matched | 0 | 0 | 0 | 16 | 4 | 5 | 8 | 1 | 1 |
| Crico's Pizza & Subs | f41e3ee5-1c6c-431a-b055-1385daadc71b | crico-s-pizza-subs | matched | 0 | 0 | 3 | 6 | 9 | 0 | 0 | 1 | 1 |
| Crico's Pizza & Subs | 92c72bba-735d-47e3-b51f-b4c3cf6708ec | crico-s-pizza-subs | matched | 0 | 0 | 0 | 6 | 9 | 0 | 0 | 1 | 1 |
| DeSoto's Seafood Kitchen | 9d0a7cda-b4cd-484b-a65d-5b7f6c372ad1 | de-soto-s-seafood-kitchen | matched | 1 | 0 | 3 | 35 | 12 | 0 | 0 | 1 | 1 |
| DeSoto's Seafood Kitchen | bfa258af-cd3f-4407-97a8-c29eb8426284 | de-soto-s-seafood-kitchen | matched | 0 | 0 | 0 | 35 | 12 | 0 | 0 | 1 | 1 |
| Dick's Last Resort | a48bb768-27ba-4fe0-8879-4110343fe246 |  | unmatched | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 |
| Doc's Seafood Shack & Oyster Bar | bf0ce867-888b-4ca3-ae6f-0942583ac073 | docs-seafood-shack-and-oyster-bar | matched | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 |
| Doc's Seafood Shack and Oyster Bar | 99ef4ec8-0aca-4b81-825c-7b14c139b008 | docs-seafood-shack-and-oyster-bar | matched | 0 | 0 | 0 | 1 | 12 | 0 | 0 | 1 | 1 |
| Down South BBQ | aed521da-49bc-44ae-a79a-be4a4b266ea6 | down-south-bbq | matched | 0 | 0 | 0 | 15 | 8 | 0 | 0 | 1 | 1 |
| Efes Greek Kitchen | 076a5934-1444-4362-b982-d0739c84a3f6 | efes-greek-kitchen | matched | 0 | 0 | 0 | 17 | 9 | 0 | 0 | 1 | 1 |
| El Toro Mexican Restaurant | ad6b962e-6f44-4acd-8eb0-a79d9575a9d3 |  | net_new_site | 0 | 0 | 0 | 3 | 5 | 0 | 0 | 1 | 1 |
| Fish River Grill | 5d7b4390-0a03-4625-b73b-1c7cfa2f6be4 |  | unmatched | 0 | 0 | 0 | 6 | 12 | 0 | 0 | 1 | 1 |
| Flora-Bama Lounge and Oyster Bar | 550d8d79-40f7-4201-9318-c526edb0f74c | flora-bama-lounge | matched | 5 | 30 | 0 | 0 | 0 | 0 | 0 | 1 | 1 |
| Flora-Bama Ole River Grill | 74988b8d-6315-43ec-bdd1-c9458d9589d0 | flora-bama-ole-river-grill | matched | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 |
| Foam Coffee | 9311c4eb-7b3e-4589-83f2-1354e467ded2 |  | unmatched | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 |
| Fort Morgan Parasailing & Banana Boat Experience | f46c331a-955c-4380-bb7c-fe3cf8888024 |  | unmatched | 0 | 0 | 5 | 2 | 12 | 3 | 6 | 1 | 1 |
| Gelato Joe's Italian Restaurant & Bar | 2d4ae7b8-4856-4ae5-babf-bf375d7c701e | gelato-joes | matched | 1 | 6 | 3 | 0 | 0 | 0 | 0 | 1 | 1 |
| GT's On The Bay | 0c6c871b-bf37-4a1b-b98f-528b4a3f2bf5 |  | unmatched | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| GT's On The Bay | e71b6bb8-4c6e-4564-8ba3-a85b8b036b57 | island-house-hotel-orange-beach-a-doubletree-by-hilton | matched | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 |
| GTs on the Bay | 8211ffcf-bf2a-44eb-8fdb-7c295bf1c3c0 | gts-on-the-bay | matched | 0 | 1 | 0 | 33 | 12 | 0 | 0 | 1 | 1 |
| Gulf Island Grill | 60d102c3-5eff-4cd6-a068-bbeca2b47e7c | gulf-island-grill | matched | 0 | 0 | 3 | 0 | 0 | 0 | 0 | 1 | 1 |
| Gulf Shores Kayak Rental | 593c2bbc-39b2-4ce7-bb7e-e512ab35f79a |  | unmatched | 0 | 0 | 0 | 3 | 12 | 6 | 5 | 1 | 1 |
| Gulf Shores Paddleboarding Lesson & Tour | da3e1d28-2d83-47e5-8f68-e45ea37e31d5 |  | unmatched | 0 | 0 | 2 | 3 | 12 | 5 | 5 | 1 | 1 |
| Gulf Shores Steamer | 3d4b1eb5-474a-4800-9090-24aa5aae1f3d |  | unmatched | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 |
| Gulf Shores: Extreme Jet Ski Rental | 028e57c1-43eb-40d3-a9d1-d241315e2823 |  | unmatched | 0 | 0 | 4 | 2 | 12 | 4 | 6 | 1 | 1 |
| Gulf Shores: Family Fun Banana Boat Rides | d8e0e53c-af3a-44fd-af0b-60a4e0d91556 |  | unmatched | 0 | 0 | 5 | 1 | 12 | 2 | 4 | 1 | 1 |
| Gulf Shores: Launch from the Beach Jet Ski Rentals | 7f99f9a5-37b4-4796-81aa-682073f64e35 |  | unmatched | 0 | 0 | 5 | 2 | 12 | 4 | 6 | 1 | 1 |
| Gulf Shores: Parasailing & Banana Boat Adventure | 07df0ea1-d0d2-4c35-92f3-7a6bd0628654 |  | unmatched | 0 | 0 | 5 | 2 | 12 | 4 | 6 | 1 | 1 |
| Gulf State Park | b72a5e18-76a3-4111-b4ae-97d4e01b0741 | gulf-state-park-jNqW-k | matched | 0 | 3 | 0 | 0 | 0 | 0 | 0 | 1 | 1 |
| Happy Harbor | 97bba085-5e96-4810-9200-7b96481f7b09 | happy-harbor-marina-dry-storage | matched | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 |
| Happy Harbor Marina | d0811c8f-f701-4870-a153-8ecceee29133 | happy-harbor-marina-dry-storage | matched | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 |
| Happy Pappys Coffeehouse | 11ee286b-ac41-4912-b918-c79aa17adb9a | happy-pappys-coffeehouse | matched | 0 | 0 | 0 | 5 | 12 | 0 | 0 | 1 | 1 |
| Hurricane Grill & Wings | b08dffeb-f6a6-4158-a09f-bbb98a02dc2c |  | unmatched | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 |
| Icehouse Tap Room | 7318cf9d-2a5f-45d7-868b-7a0e6e7aedb1 | ice-house-taproom | matched | 17 | 0 | 0 | 24 | 12 | 0 | 0 | 1 | 1 |
| Island Ice Cream & Treats | 96240c2b-eaae-464c-b36b-b0b813d9c46f | island-ice-cream-treats | matched | 0 | 0 | 0 | 14 | 12 | 0 | 0 | 1 | 1 |
| Island Wing Company | c88ad484-9cdb-44ef-bc3f-17fe55b1f321 |  | unmatched | 0 | 2 | 0 | 0 | 0 | 0 | 0 | 1 | 1 |
| Janino's Pizza | 82acef3a-f50f-42ad-890d-729e1f6269df |  | unmatched | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 |
| Jesse's Restaurant | a25147e2-c733-47f1-ba02-9d1f683327b0 |  | unmatched | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 |
| Kilwins | eeb17ed8-a93a-413e-84fa-401b89a2615b |  | unmatched | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 |
| King Neptune's Seafood Restaurant | 06ab9cec-3c7b-4b75-b397-f69bc68eedfc | king-neptune-s-seafood-restaurant | matched | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 |
| Kitty's Kafe | 619ab943-5ee0-4f6e-82d6-8bfd9e323a59 |  | unmatched | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 |
| Kraken Reels Charter Services | 842ecb5d-ff73-4937-aec7-c2245cdfe951 | kraken-reels-llc-GpIRco | matched | 0 | 0 | 5 | 0 | 0 | 0 | 0 | 1 | 1 |
| Lulu's | 24fc7e14-36fd-4971-ba6e-0a3dc16c996b |  | unmatched | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 |
| LuLu's Gulf Shores | 1fdf3024-978d-4aac-ac9d-19233776d3b2 |  | unmatched | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| LuLu's Gulf Shores | ba5cc0d0-ed77-4bd7-ad78-1a54820dc8c9 | lulu-s-gulf-shores | matched | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 |
| Luna's Eat & Drink | a61a524a-868d-459e-be0d-0fbf8ae491e2 |  | unmatched | 2 | 0 | 0 | 0 | 12 | 0 | 0 | 1 | 1 |
| Maggie's Cakes and More | 11111111-1111-1111-1111-111111111111 |  | net_new_site | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 0 |
| Mikee's Seafood Restaurant | 765f86d7-5c9e-44d3-b79a-2715852392b5 | mikee-s-seafood | matched | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 |
| Mile Marker 158 Dockside | 5ce56042-b1c9-42b5-94ce-9524312dd774 |  | unmatched | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 |
| Milkshake Momma | 70357c31-f818-4213-880f-479dcea1c56b | milkshake-momma-mama-orange-beach | matched | 0 | 0 | 0 | 27 | 12 | 0 | 0 | 1 | 1 |
| Moe's Original BBQ | b6fec41d-9d33-4d2b-a453-1a369d596ece |  | unmatched | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 |
| Niki's Seafood & Thai | dfb55665-6c54-495b-bdcf-b18ea162b1f9 | niki-s-seafood-thai | matched | 0 | 0 | 0 | 0 | 12 | 0 | 0 | 0 | 0 |
| Orange Beach 20-Foot Pontoon Rental | c8f9ef32-a1dc-4704-9206-22c9f8187db1 |  | unmatched | 0 | 0 | 3 | 2 | 8 | 4 | 5 | 1 | 1 |
| Orange Beach 24-Foot Pontoon Rental | 686f4daf-4c54-4121-8e8d-5bd431859383 |  | unmatched | 0 | 0 | 1 | 2 | 6 | 4 | 6 | 1 | 1 |
| Orange Beach Dolphin & Sunset Cruises Aboard Sunny Lady | 4286b619-3698-4dd8-9264-a3e1044681d9 | orange-beach-dolphin-and-sunset-cruises-and-the-wharf-aboard-sunny-lady | matched | 0 | 1 | 10 | 0 | 0 | 0 | 5 | 1 | 1 |
| Orange Beach History Museum | 8d2fec35-ddfc-40cd-b36d-5e5d83ff6111 | orange-beach-history-museum | matched | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 |
| Orange Beach Sea Fox Center Console Boat Rental | b342b4ce-75f8-4c24-b3ca-a4055e61cef6 |  | unmatched | 0 | 0 | 0 | 2 | 7 | 5 | 5 | 1 | 1 |
| Orange Beach Tritoon Boat Rental | 5d2bf839-d2ab-4fa0-80a9-918e702eac92 |  | unmatched | 0 | 0 | 5 | 3 | 12 | 5 | 5 | 1 | 1 |
| Orange Beach Tritoon Rental | 7af0e517-6fa2-471e-ad43-394dbb03b57d |  | unmatched | 0 | 0 | 1 | 3 | 8 | 6 | 5 | 1 | 1 |
| Orange Beach Tritoon with Slide | cde9d092-9f24-4bd9-8ea7-945d74436d6d |  | unmatched | 0 | 0 | 5 | 2 | 9 | 6 | 5 | 1 | 1 |
| Orange Beach: 22-Foot Pontoon Rental | 86e1bba1-81e3-4b2f-81bf-372e4762f3d5 |  | unmatched | 0 | 0 | 0 | 2 | 7 | 4 | 5 | 1 | 1 |
| Orange Beach: 24ft Bentley Pontoon with 90HP | 9c132e75-98e6-445c-ba6c-e7d38c704d2c |  | unmatched | 0 | 0 | 5 | 2 | 4 | 5 | 6 | 1 | 1 |
| Orange Beach: 24ft Bentley Sport Pontoon with 140 HP | 45aed543-fedc-4d02-a21f-25933f94a015 |  | unmatched | 0 | 0 | 0 | 2 | 6 | 5 | 6 | 1 | 1 |
| Orange Beach: 24ft Double Deck Pontoon with Slide and 115 HP | 1e37eafc-94de-4fd5-8d5f-adaf554b0743 |  | unmatched | 0 | 0 | 0 | 2 | 10 | 5 | 2 | 1 | 1 |
| Orange Beach: 24ft Double Deck Pontoon with Slide and 70HP | da93747d-020c-45c4-9e74-7e74976a6c97 |  | unmatched | 0 | 0 | 4 | 2 | 5 | 5 | 2 | 1 | 1 |
| Orange Beach: 30ft Double Deck Pontoon with 2 Slides and 115HP | 826b6616-a5fc-4aef-be86-d1647a39ce44 |  | unmatched | 0 | 0 | 5 | 2 | 7 | 5 | 2 | 1 | 1 |
| Orange Beach: Bear Point Marina Jet Ski Rental | 3253114c-1096-4341-85d7-c2cf1ce73166 |  | unmatched | 0 | 0 | 5 | 3 | 12 | 4 | 6 | 1 | 1 |
| Orange Beach: Chute Em Up Parasail Tours | 9f559a77-78a8-4b6a-9236-441607ee016e |  | unmatched | 0 | 0 | 5 | 2 | 12 | 5 | 5 | 1 | 1 |
| Orange Beach: Daytime Dolphin Sightseeing Cruise | 09246ccd-d6a3-4c2a-abfa-b9e727d9e31d |  | unmatched | 0 | 0 | 5 | 2 | 12 | 6 | 4 | 1 | 1 |
| Orange Beach: Dockside Parasail | c94282d3-6219-4a3b-9809-e159a22a2a77 |  | unmatched | 0 | 0 | 0 | 2 | 12 | 6 | 5 | 1 | 1 |
| Orange Beach: Dockside Parasail | 1c641f4c-54ca-4223-b418-d53b1502cb69 | orange-beach-dockside-parasail | matched | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 |
| Orange Beach: Dolphin & Sunset Cruises Aboard the Southern Rose | 470965c1-5182-4ca6-9828-df3d5dce116e |  | unmatched | 0 | 0 | 5 | 3 | 10 | 6 | 5 | 1 | 1 |
| Orange Beach: Dolphin Cruises aboard Cruise Orange Beach | 7640efde-cba9-402a-9d0f-aff899a0c727 |  | unmatched | 0 | 0 | 5 | 3 | 12 | 6 | 5 | 1 | 1 |
| Orange Beach: Dolphin Eco Cruise on The Explorer | 1ae9b1a4-91a3-4a7e-9a1a-e73fd16d0144 |  | unmatched | 0 | 0 | 5 | 3 | 7 | 7 | 5 | 1 | 1 |
| Orange Beach: Dolphin Sailing Tour Aboard a 52-Foot Catamaran | c049e829-8703-4ba8-80d4-747aa46dde6a |  | unmatched | 0 | 0 | 5 | 3 | 12 | 8 | 5 | 1 | 1 |
| Orange Beach: Dolphin Sunset Cruise on the Explorer | fa78c61a-8297-4f80-8fa2-39bfb618bee7 |  | unmatched | 0 | 0 | 5 | 3 | 12 | 7 | 6 | 1 | 1 |
| Orange Beach: Family-Friendly Dolphin Cruise | 2cf50de3-f50b-45a0-87eb-b560a586bde4 |  | unmatched | 0 | 0 | 5 | 3 | 12 | 6 | 8 | 1 | 1 |
| Orange Beach: Full-Day Jet Ski Rentals departing from Happy Harbor Marina | 8c7f54f2-4b4f-48b2-8a55-7f9360505ff2 |  | unmatched | 0 | 0 | 0 | 2 | 12 | 4 | 4 | 1 | 1 |
| Orange Beach: Guided Jet Ski Dolphin Tour | 89a8d2a7-44af-47fe-b1f9-b9bf51bdba25 |  | unmatched | 0 | 0 | 5 | 1 | 12 | 5 | 6 | 1 | 1 |
| Orange Beach: Gulf Coast 4-Seater Golf Cart Rental | 905806c3-6493-430b-8de2-d2f46a1ed3d3 |  | unmatched | 0 | 0 | 0 | 0 | 8 | 3 | 4 | 1 | 1 |
| Orange Beach: Gulf Coast 6-Seater Golf Cart Rental | 7ad38e9d-82d4-4ebc-ab3c-c4a9cf35731c |  | unmatched | 0 | 0 | 1 | 0 | 12 | 3 | 4 | 1 | 1 |
| Orange Beach: Gulf Coast Sweet Jeep Rental | 8231d9cd-ae77-4a2f-8a56-e12ca47d6743 |  | unmatched | 0 | 0 | 0 | 8 | 10 | 5 | 5 | 1 | 1 |
| Orange Beach: Gulf Shores Helicopter Tours | 50b99b08-d703-4846-a71b-73d4b114e0d9 |  | unmatched | 0 | 0 | 5 | 7 | 12 | 7 | 6 | 1 | 1 |
| Orange Beach: Half-Day Jet Ski Rentals departing from Happy Harbor Marina | e6996e87-fc39-4cc1-a3b6-9a0612cc81f4 |  | unmatched | 0 | 0 | 1 | 2 | 12 | 4 | 4 | 1 | 1 |
| Orange Beach: Hourly Jet Ski Rentals departing from Happy Harbor Marina | 4aa69fb5-ec36-4e85-8e2a-8a9da6bcb911 |  | unmatched | 0 | 0 | 5 | 2 | 11 | 4 | 4 | 1 | 1 |
| Orange Beach: Polaris Slingshot Rental | d80c412c-d123-4296-9939-26f5e0048113 |  | unmatched | 0 | 0 | 5 | 0 | 6 | 4 | 4 | 1 | 1 |
| Orange Beach: Private Bachelor(ette) Boat Tour | 196e9d6f-b9e7-4819-a124-84a352410961 |  | unmatched | 0 | 0 | 0 | 1 | 12 | 6 | 7 | 1 | 1 |
| Orange Beach: Private Blue Angels Airshow Boat Tour | 2ae9891d-6761-49f3-b24d-49efedb76e53 |  | unmatched | 0 | 0 | 0 | 3 | 12 | 6 | 7 | 1 | 1 |
| Orange Beach: Private Bushwacker & Restaurant Boat Tour | b7a5c059-5c58-4f7c-9590-023e89293aee |  | unmatched | 0 | 0 | 1 | 1 | 12 | 6 | 6 | 1 | 1 |
| Orange Beach: Private Dolphin Sightseeing Tour | 36d88ec5-083a-4449-80e1-2ac2289d3003 |  | unmatched | 0 | 0 | 5 | 2 | 12 | 6 | 6 | 1 | 1 |
| Orange Beach: Private Island Grillin & Chillin Boat Cruise | 269157ad-5ecf-411c-9cc3-e32fe6060bf1 |  | unmatched | 0 | 0 | 3 | 1 | 12 | 6 | 6 | 1 | 1 |
| Orange Beach: Private Islands Booze Cruise | e45aecc1-7ac0-4ff5-8493-5bb460e4a5b8 |  | unmatched | 0 | 0 | 0 | 1 | 12 | 6 | 6 | 1 | 1 |
| Orange Beach: Private ONO Island Sightseeing Cruise | d6c99c35-ed38-4177-bc28-e072c48ede6b |  | unmatched | 0 | 0 | 5 | 1 | 12 | 6 | 7 | 1 | 1 |
| Orange Beach: Private Sightseeing & Eco Boat Tour | f7d0faf2-1caf-44c0-b06e-8c35753fdcf8 |  | unmatched | 0 | 0 | 1 | 1 | 12 | 6 | 7 | 1 | 1 |
| Orange Beach: Sunset & Crab Grab Clear Kayak Tour | 15fcfa33-dfd0-44b3-99a6-4c4207d6d30a |  | unmatched | 0 | 0 | 5 | 0 | 9 | 5 | 5 | 1 | 1 |
| Orange Beach: Sunset Dolphin Cruise with Captain | 19067db9-5439-4cbb-82ea-b8917ecdcc63 |  | unmatched | 0 | 0 | 5 | 1 | 12 | 5 | 5 | 1 | 1 |
| Orange Beach: Sunset Helicopter Tour | be2fc148-a4aa-4581-bb6e-54547f3cd7b9 |  | unmatched | 0 | 0 | 5 | 1 | 12 | 7 | 6 | 1 | 1 |
| Orange Beach: Sunset Sailing Tour Aboard a 52-Foot Catamaran | 174e2b52-ca71-4c8f-b2ae-5c2a13bc8458 |  | unmatched | 0 | 0 | 5 | 2 | 12 | 6 | 5 | 1 | 1 |
| Orange Beach: Swim, Grill, & Chill Excursion | 6b561ac2-0bcb-4864-87d1-0e83bd45d1c3 |  | unmatched | 0 | 0 | 5 | 1 | 10 | 6 | 5 | 1 | 1 |
| Orange Beach: Waverunner Dolphin Tour with Free Photos | b9125a84-a60c-4b19-8b9b-be48ec90757b |  | unmatched | 0 | 0 | 5 | 0 | 9 | 4 | 5 | 1 | 1 |
| OSO Alabama | 4c12a570-40c2-4dec-a004-9b938b05dd57 |  | unmatched | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 |
| OSO at Bear Point Harbor | 6e2e3e59-1606-4a2e-a2ab-7426a881ea83 | oso-at-bear-point-harbor-orange-beach | matched | 1 | 1 | 0 | 21 | 2 | 0 | 0 | 1 | 1 |
| OSO at Bear Point Harbor | 283ff209-a060-4614-bf3e-a7b94fadabfc | oso-at-bear-point-harbor-orange-beach | matched | 0 | 0 | 0 | 21 | 2 | 0 | 0 | 1 | 1 |
| Papa Rocco's | 09391167-90ed-495f-84b4-f38669699508 | papa-roccos | matched | 0 | 2 | 3 | 1 | 11 | 0 | 0 | 1 | 1 |
| Pelican Grill | f5d1dd0d-c895-4b56-b795-edd59f5865c9 | pelican-grill-orange-beach | matched | 0 | 1 | 3 | 0 | 0 | 0 | 0 | 1 | 1 |
| Perch at Gulf State Park | 56034c77-daee-41ab-ac7b-c63df16bd9a1 | perch | matched | 0 | 0 | 6 | 0 | 0 | 0 | 0 | 1 | 1 |
| Perdido Beach Resort | 33d0234d-393e-4282-aff0-e1f2c9aae915 | perdido-beach-resort | matched | 2 | 2 | 0 | 0 | 12 | 0 | 0 | 1 | 1 |
| Perdido Key: Banana Boat Ride Experience | be37ed51-9516-4b19-9d32-dd26a61047e9 |  | unmatched | 0 | 0 | 5 | 1 | 12 | 3 | 4 | 1 | 1 |
| Perdido Key: Parasailing Adventure | 8d4179cc-4a27-40a3-85bf-e85655c1e210 |  | unmatched | 0 | 0 | 5 | 0 | 12 | 5 | 7 | 1 | 1 |
| Pink Pony Pub | c0fb769e-90db-4203-bf03-34c06d7d4905 | pink-pony-pub | matched | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 |
| Pizza At The Pass | f2a845d8-4847-409f-b85e-a808cb7b65e1 | pizza-at-the-pass | matched | 0 | 0 | 0 | 5 | 2 | 0 | 0 | 1 | 1 |
| Pleasure Island Tiki | 5634d3ff-a203-436e-97d3-894e7fa5cbb8 |  | unmatched | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 |
| Pontoon Boat Rental in Orange Beach | e1a0f4fc-24c4-46a9-8e0d-3433d49060b3 |  | unmatched | 0 | 0 | 5 | 3 | 12 | 5 | 5 | 1 | 1 |
| Pontoon Boat Rental with Slide in Orange Beach | 218765c6-1c64-4a65-92b7-8b5bdf7e9609 |  | unmatched | 0 | 0 | 5 | 3 | 10 | 5 | 5 | 1 | 1 |
| POUR Smart Bar | 74b4926c-812d-4a22-98f2-a7bb826d1889 |  | unmatched | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 |
| Rotolo's Pizzeria | ec8068f0-9808-46dc-b39f-852cef2c8030 |  | unmatched | 2 | 0 | 0 | 17 | 0 | 0 | 0 | 1 | 1 |
| Sea N Suds - Restaurant and Oyster Bar | ba6a38f5-f3d7-47f4-ba1a-50e764a8898f | sea-n-suds | matched | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 |
| Sea-N-Suds | 20e698cb-0bae-4b4e-b379-053fe4c9df06 | sea-n-suds | matched | 0 | 0 | 0 | 75 | 12 | 0 | 0 | 1 | 1 |
| Shipp's Dockside Grill | 684ba2d1-0d8d-4b40-9e0a-d0480e2bcb0a | shipps-dockside-grill | matched | 0 | 0 | 0 | 0 | 8 | 0 | 0 | 1 | 1 |
| Southern Rose Parasailing Cruises | 64be34bd-b3b1-4be6-b3c4-3a0e9514e500 |  | net_new_site | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 |
| Southern Shores Coffee | 6c7e3919-9d0e-48c2-93fc-8f42c2237c46 |  | unmatched | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 |
| Sugar Shack | d7ece42e-55bf-4f22-a9a7-c01e94507e4f | sugar-shack | matched | 0 | 5 | 0 | 0 | 0 | 0 | 0 | 1 | 1 |
| Sunliner Diner | 4eb0f788-3161-417b-afed-b047b2e82285 | sunliner-diner-gulf-shores | matched | 0 | 0 | 0 | 0 | 12 | 0 | 0 | 1 | 1 |
| Surfside Pizza | dc2d1078-94a6-4714-b330-3bdf92991199 | surfside-pizza-orange-beach | matched | 0 | 0 | 4 | 0 | 0 | 0 | 0 | 1 | 1 |
| Sweet Retreat | d01c12b9-c78c-47d5-9628-d5996b83d722 |  | unmatched | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 |
| Tacky Jacks Seafood Restaurant and Tavern | 5c0b17c1-92c0-46ba-8f7f-ed77229c1df3 | tacky-jacks-orange-beach | matched | 1 | 2 | 0 | 9 | 12 | 0 | 0 | 1 | 1 |
| Tee Off at The Wharf Powered by TOPGOLF Swing Suites | 37a9252a-0a8d-4209-8242-93461ef2e575 | tee-off-at-the-wharf | matched | 2 | 1 | 0 | 137 | 0 | 0 | 0 | 1 | 1 |
| The Beach Bun | 0cdb0a09-6fa8-4e4c-9722-63271b27fea2 | the-beach-bun | matched | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 1 | 1 |
| The Beach House Kitchen & Cocktails | e29def0c-38f7-44af-ad09-bfa5b417a07f | the-beach-house-kitchen-and-cocktails | matched | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 |
| The Clubhouse Bar & Grill | cc0aaa15-74ff-45a3-b289-78b17ee98c60 | the-clubhouse-bar-grill | matched | 0 | 0 | 0 | 15 | 12 | 0 | 0 | 1 | 1 |
| The Cove Bar and Grill | 02837eb5-96bb-49a2-801a-d4771ef66315 | the-cove-bar-and-grill | matched | 0 | 1 | 4 | 3 | 11 | 0 | 0 | 1 | 1 |
| The Galley on the River | 49f130fc-11d0-4e37-9032-4561d81912db | the-galley-on-the-river | matched | 0 | 1 | 5 | 0 | 0 | 0 | 0 | 1 | 1 |
| The Gulf Orange Beach | 5a11764b-13db-4cec-a383-569ddb85a6f9 | the-gulf | matched | 1 | 0 | 0 | 21 | 0 | 0 | 0 | 1 | 1 |
| The Hangout Gulf Shores | 01344591-7bb1-41ff-98df-6654bb3f32be |  | unmatched | 2 | 5 | 0 | 5 | 0 | 0 | 0 | 1 | 1 |
| The Keg Lounge | a5776c54-988f-4442-bc1c-8d06ba30c8f5 |  | unmatched | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 |
| The Lodge at Gulf State Park - Eat & Drink | 61fedaf7-b5c1-4812-8650-5786eb5cfbb2 | the-lodge-at-gulf-state-park-a-hilton-hotel | matched | 0 | 2 | 0 | 0 | 0 | 0 | 0 | 1 | 1 |
| The Original Oyster House | 90039386-f66d-4c69-bdbd-772d708bda46 | original-oyster-house | matched | 4 | 2 | 0 | 0 | 0 | 0 | 0 | 1 | 1 |
| The Point Restaurant | a9ee6e71-60a9-4b62-847d-85b6270547f8 | the-point-restaurant | matched | 2 | 3 | 0 | 0 | 12 | 0 | 0 | 1 | 1 |
| The Sloop | c1c71c19-bb50-4c61-b4b4-a8a00cac37fe | the-sloop | matched | 0 | 0 | 0 | 28 | 12 | 0 | 0 | 1 | 1 |
| The Southern Grind Coffee House at the WHARF | b1c32412-48ac-4b55-af25-0e59ccfeb38f | the-southern-grind-coffee-house-at-the-wharf | matched | 0 | 0 | 0 | 15 | 6 | 0 | 0 | 1 | 1 |
| The Steamer & Baked Oyster Bar | 32b492ba-d872-4f43-94e9-aaf2baa604bf |  | unmatched | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 |
| The Tin Top Restaurant & Oyster Bar | c9269c01-db0b-468d-ad5c-1ac00f6a3154 | the-tin-top-restaurant-oyster-bar | matched | 3 | 0 | 3 | 8 | 12 | 0 | 0 | 1 | 1 |
| TIKI & RAW BAR | f3a9a693-ca1e-4674-a652-387e41a9cf5e | tiki-and-raw-bar-orange-beach | matched | 2 | 3 | 0 | 0 | 0 | 0 | 0 | 1 | 1 |
| Tiki & Raw Bar Orange Beach | 80bc09ae-a12e-425b-938d-0ba782bb11fd | tiki-and-raw-bar-orange-beach | matched | 0 | 0 | 0 | 0 | 12 | 0 | 0 | 1 | 1 |
| Treehouse | 020e195a-bc88-4dc0-be23-39739f446db8 | treehouse-cafe | matched | 0 | 0 | 0 | 0 | 2 | 0 | 0 | 0 | 0 |
| Villaggio Grille | 0d0f6002-be96-4c46-bb89-a0816d2d24a2 |  | unmatched | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 |
| Vinny's Pizzeria | d715dd18-a2d6-4774-862d-59aaf1e24a1a | vinny-s-pizzeria | matched | 0 | 0 | 0 | 46 | 12 | 0 | 0 | 1 | 1 |
| Voyagers | b7559559-af20-4c0a-a11d-246caddf6974 | voyagers | matched | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 |
| Wacked Out Weiner Gulf Shores | 735c6448-a675-422a-bd8e-b1701dd68172 | wacked-out-weiner-gulf-shores | matched | 0 | 0 | 0 | 13 | 9 | 0 | 0 | 1 | 1 |
| Wolf Bay Lodge | eb54ba00-a97c-4cc8-9f15-f399bc3d46c8 | wolf-bay-restaurant-at-foley-V-Ba0I | matched | 8 | 8 | 0 | 0 | 0 | 0 | 0 | 1 | 1 |
| Wolf Bay Restaurant | 188fdc7c-2066-4e95-89f3-f3a1826ca20b |  | unmatched | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| Wolf Bay Restaurant | 03f51b7a-3bfe-4ee8-acd7-fa5ceca32a95 |  | net_new_site | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 |
| Woodside Restaurant | 9c20b7a6-0c01-4ad2-ae42-09183932c650 | woodside-restaurant | matched | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 1 | 1 |
| Yumm Twister & Ice Cream | b8917be9-1502-40fc-a675-5acd0b41fb53 | yumm-twister-ice-cream | matched | 0 | 0 | 0 | 7 | 12 | 0 | 0 | 1 | 1 |
| Zeke's Landing Marina | ab75653b-5443-4614-b9c1-77c6c263a0fa | zeke-s-landing-and-marina | matched | 0 | 0 | 4 | 0 | 12 | 0 | 0 | 1 | 1 |

## Net-new candidate sites (keyed, no live match)

- A Specialty Bakery and Party Shoppe — phone 2519682253
- Agave Bar & Grill — phone 2512573798
- Angry Crab Shack — phone 4803987099
- BOLO Steak & Seafood — phone 2519816800
- El Toro Mexican Restaurant — phone 2513172361
- Maggie's Cakes and More — phone 2515550199 (likely test data)
- Southern Rose Parasailing Cruises — phone 2513038524
- Test Pizza Shop — phone 2515559999 (likely test data)
- Wolf Bay Restaurant — phone 2519816991

Note: "A Specialty Bakery and Party Shoppe" and "Agave Bar & Grill" appear to exist in live under slugs a-specialty-bakery / agave-bar-grill (name evidence only — no phone/place-id match, so left as net_new per matching rules).

Excluded per instructions: customers, bookings, waivers, Square/payment data.