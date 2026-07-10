#!/usr/bin/env python3
"""
Yelp Orange Beach master listing + full-detail collector.

Two phases:

1. Search collection - opens each Yelp search category, paginates through
   results, and extracts a lightweight row per listing (name, Yelp URL,
   rating, review count, price, categories, address snippet, sponsored
   flag). Deduplicates into a master business list.

2. Detail collection - visits every unique business's Yelp page and pulls
   the full profile: phone, external website (decoded from Yelp's redirect
   link), full street address, lat/lng, price level, full category list,
   weekly hours, rating/review count, a representative photo, and the meta
   description.

Important:
- This script does not solve CAPTCHAs or bypass access controls.
- Run it on your own computer with a visible (non-headless) browser. If
  Yelp asks you to verify or sign in, complete that step manually in the
  opened browser, then press Enter in the terminal.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
import time
from dataclasses import dataclass, asdict, field
from pathlib import Path
from typing import Iterable
from urllib.parse import parse_qs, unquote, urlencode, urljoin, urlparse, urlunparse

from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError


SEARCHES = {
    "Restaurants": "https://m.yelp.com/search?find_desc=Restaurants&find_loc=Orange+Beach%2C+AL",
    "Tours": "https://m.yelp.com/search?find_desc=Tours&find_loc=Orange+Beach%2C+AL+36561",
    "Rentals": "https://m.yelp.com/search?find_desc=Rentals&find_loc=Orange+Beach%2C+AL+36561",
    "Things to Do": "https://m.yelp.com/search?find_desc=Things+to+Do&find_loc=Orange+Beach%2C+AL+36561",
    "Things to Do with Teenagers": "https://m.yelp.com/search?find_desc=Things+to+Do+with+Teenagers&find_loc=Orange+Beach%2C+AL+36561",
    "Food": "https://m.yelp.com/search?find_desc=Food&find_loc=Orange+Beach%2C+AL+36561",
    "Delivery Food": "https://m.yelp.com/search?find_desc=Delivery+Food&find_loc=Orange+Beach%2C+AL",
    "Fishing": "https://m.yelp.com/search?find_desc=Fishing&find_loc=Orange+Beach%2C+AL+36561",
    "Condos for Rent": "https://m.yelp.com/search?find_desc=Condos+for+Rent&find_loc=Orange+Beach%2C+AL+36561",
    "Activities": "https://m.yelp.com/search?find_desc=Activities&find_loc=Orange+Beach%2C+AL+36561",
    "Hotels": "https://m.yelp.com/search?find_desc=Hotels&find_loc=Orange+Beach%2C+AL+36561",
}


@dataclass
class Listing:
    search_category: str
    search_url: str
    page_number: int
    result_position: int
    business_name: str
    yelp_url: str
    yelp_business_id: str
    rating: str
    review_count: str
    price_level: str
    categories: str
    address_or_snippet: str
    sponsored: bool


@dataclass
class BusinessDetail:
    yelp_business_id: str
    yelp_url: str
    business_name: str
    phone: str = ""
    website: str = ""
    price_level: str = ""
    categories: str = ""
    rating: str = ""
    review_count: str = ""
    street_address: str = ""
    city: str = ""
    state: str = ""
    zip_code: str = ""
    latitude: str = ""
    longitude: str = ""
    hours: str = ""  # JSON-encoded {"Monday": "11:00 AM - 9:00 PM", ...}
    description: str = ""
    main_photo_url: str = ""
    search_categories: str = ""
    scrape_status: str = "ok"
    error_message: str = ""


def clean_text(value: str | None) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def canonical_yelp_url(href: str) -> tuple[str, str]:
    absolute = urljoin("https://www.yelp.com", href)
    parsed = urlparse(absolute)
    path = parsed.path.rstrip("/")
    match = re.search(r"/biz/([^/?#]+)", path)
    business_id = match.group(1) if match else path
    canonical = urlunparse(("https", "www.yelp.com", path, "", "", ""))
    return canonical, business_id


def set_start(url: str, start: int) -> str:
    parsed = urlparse(url)
    query = parse_qs(parsed.query, keep_blank_values=True)
    query["start"] = [str(start)]
    flat = [(k, v) for k, vals in query.items() for v in vals]
    return urlunparse(parsed._replace(query=urlencode(flat)))


def first_text(locator, selectors: Iterable[str]) -> str:
    for selector in selectors:
        try:
            candidate = locator.locator(selector).first
            if candidate.count():
                txt = clean_text(candidate.inner_text(timeout=1500))
                if txt:
                    return txt
        except Exception:
            pass
    return ""


def extract_json_ld(page, category: str, search_url: str, page_number: int) -> list[Listing]:
    found: list[Listing] = []
    scripts = page.locator('script[type="application/ld+json"]')
    for i in range(scripts.count()):
        try:
            raw = scripts.nth(i).text_content() or ""
            data = json.loads(raw)
        except Exception:
            continue

        nodes = data if isinstance(data, list) else [data]
        for node in nodes:
            if not isinstance(node, dict):
                continue
            item_list = node.get("itemListElement")
            if not isinstance(item_list, list):
                continue

            for entry in item_list:
                item = entry.get("item", entry) if isinstance(entry, dict) else {}
                if not isinstance(item, dict):
                    continue
                name = clean_text(item.get("name"))
                url = item.get("url", "")
                if not name or "/biz/" not in str(url):
                    continue

                yelp_url, business_id = canonical_yelp_url(str(url))
                aggregate = item.get("aggregateRating") or {}
                address = item.get("address") or {}
                if isinstance(address, dict):
                    address_text = ", ".join(
                        clean_text(address.get(k))
                        for k in ("streetAddress", "addressLocality", "addressRegion", "postalCode")
                        if clean_text(address.get(k))
                    )
                else:
                    address_text = clean_text(str(address))

                found.append(
                    Listing(
                        search_category=category,
                        search_url=search_url,
                        page_number=page_number,
                        result_position=len(found) + 1,
                        business_name=name,
                        yelp_url=yelp_url,
                        yelp_business_id=business_id,
                        rating=clean_text(str(aggregate.get("ratingValue", ""))),
                        review_count=clean_text(str(aggregate.get("reviewCount", ""))),
                        price_level=clean_text(str(item.get("priceRange", ""))),
                        categories="",
                        address_or_snippet=address_text,
                        sponsored=False,
                    )
                )
    return found


def extract_dom(page, category: str, search_url: str, page_number: int) -> list[Listing]:
    results: list[Listing] = []

    anchors = page.locator('a[href*="/biz/"]')
    seen_on_page: set[str] = set()

    for i in range(anchors.count()):
        anchor = anchors.nth(i)
        try:
            href = anchor.get_attribute("href") or ""
            text = clean_text(anchor.inner_text(timeout=1000))
        except Exception:
            continue

        if not href or not text or "/biz/" not in href:
            continue

        yelp_url, business_id = canonical_yelp_url(href)
        if business_id in seen_on_page:
            continue

        # Ignore common non-title links when possible.
        if len(text) < 2 or text.lower() in {"more info", "website", "directions", "menu"}:
            continue

        seen_on_page.add(business_id)

        container = anchor.locator(
            "xpath=ancestor::*[self::li or self::div]["
            ".//a[contains(@href, '/biz/')]][1]"
        )
        if not container.count():
            container = anchor.locator("xpath=ancestor::div[1]")

        blob = ""
        try:
            blob = clean_text(container.inner_text(timeout=1500))
        except Exception:
            pass

        rating = first_text(
            container,
            [
                '[aria-label*="star rating"]',
                '[role="img"][aria-label*="star"]',
                'span[class*="rating"]',
            ],
        )
        if rating:
            m = re.search(r"(\d+(?:\.\d+)?)", rating)
            rating = m.group(1) if m else rating

        review_count = ""
        m = re.search(r"(\d[\d,]*)\s+reviews?", blob, flags=re.I)
        if m:
            review_count = m.group(1).replace(",", "")

        price = ""
        m = re.search(r"(?<!\$)(\${1,4})(?!\$)", blob)
        if m:
            price = m.group(1)

        sponsored = bool(re.search(r"\bSponsored\b", blob, flags=re.I))

        # Category text is often near the title, but layout changes frequently.
        categories = ""
        pieces = [p.strip() for p in re.split(r"[•·|]", blob) if p.strip()]
        category_candidates = [
            p for p in pieces
            if 1 <= len(p.split(",")) <= 8
            and not re.search(r"\b(review|mile|open|closed|sponsored)\b", p, re.I)
            and p != text
        ]
        if category_candidates:
            categories = category_candidates[0][:300]

        results.append(
            Listing(
                search_category=category,
                search_url=search_url,
                page_number=page_number,
                result_position=len(results) + 1,
                business_name=text,
                yelp_url=yelp_url,
                yelp_business_id=business_id,
                rating=rating,
                review_count=review_count,
                price_level=price,
                categories=categories,
                address_or_snippet=blob[:1000],
                sponsored=sponsored,
            )
        )

    return results


def page_is_blocked(page) -> bool:
    text = clean_text(page.locator("body").inner_text(timeout=5000)).lower()
    markers = (
        "captcha",
        "unusual activity",
        "access denied",
        "verify you are human",
        "robot",
        "temporarily unavailable",
    )
    return any(marker in text for marker in markers)


def handle_block_if_needed(page, headless: bool) -> None:
    if not page_is_blocked(page):
        return
    if headless:
        raise RuntimeError(
            "Yelp presented a verification/block page. "
            "Run again without --headless and complete the prompt manually."
        )
    print("\nYelp requires verification or sign-in.")
    input("Complete it in the browser, then press Enter here to continue... ")
    page.reload(wait_until="domcontentloaded")
    page.wait_for_timeout(2500)


def collect(
    context,
    output_dir: Path,
    headless: bool,
    page_size: int,
    max_pages: int,
    delay: float,
) -> list[Listing]:
    raw_dir = output_dir / "raw_html"
    raw_dir.mkdir(parents=True, exist_ok=True)

    all_rows: list[Listing] = []
    page = context.pages[0] if context.pages else context.new_page()
    page.set_default_timeout(15000)

    for category, base_url in SEARCHES.items():
        print(f"\n=== {category} ===")
        prior_ids: set[str] = set()

        for page_idx in range(max_pages):
            start = page_idx * page_size
            url = set_start(base_url, start)
            print(f"Page {page_idx + 1}: {url}")

            try:
                page.goto(url, wait_until="domcontentloaded", timeout=45000)
                page.wait_for_timeout(2500)
            except PlaywrightTimeoutError:
                print("  Navigation timed out; attempting extraction from loaded content.")

            handle_block_if_needed(page, headless)

            html_path = raw_dir / f"{slugify(category)}_page_{page_idx + 1}.html"
            html_path.write_text(page.content(), encoding="utf-8")

            rows = extract_json_ld(page, category, base_url, page_idx + 1)
            if not rows:
                rows = extract_dom(page, category, base_url, page_idx + 1)

            # Remove duplicates inside this page.
            page_unique: dict[str, Listing] = {}
            for row in rows:
                page_unique.setdefault(row.yelp_business_id, row)
            rows = list(page_unique.values())

            new_rows = [r for r in rows if r.yelp_business_id not in prior_ids]
            print(f"  Extracted {len(rows)}; new unique in category: {len(new_rows)}")

            if not rows or not new_rows:
                print("  No new listings detected; stopping this category.")
                break

            for row in new_rows:
                row.result_position = len(prior_ids) + 1
                prior_ids.add(row.yelp_business_id)
                all_rows.append(row)

            time.sleep(delay)

    return all_rows


def slugify(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", value.lower()).strip("_")


def export(rows: list[Listing], output_dir: Path) -> list[dict]:
    raw_csv = output_dir / "01_yelp_raw_search_results.csv"
    raw_json = output_dir / "01_yelp_raw_search_results.json"
    master_csv = output_dir / "02_master_businesses.csv"
    master_json = output_dir / "02_master_businesses.json"

    fields = list(Listing.__dataclass_fields__.keys())
    with raw_csv.open("w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        writer.writerows(asdict(r) for r in rows)

    raw_json.write_text(
        json.dumps([asdict(r) for r in rows], indent=2, ensure_ascii=False),
        encoding="utf-8",
    )

    grouped: dict[str, dict] = {}
    for row in rows:
        rec = grouped.setdefault(
            row.yelp_business_id,
            {
                "business_name": row.business_name,
                "yelp_business_id": row.yelp_business_id,
                "yelp_url": row.yelp_url,
                "search_categories": set(),
                "yelp_categories": set(),
                "rating": row.rating,
                "review_count": row.review_count,
                "price_level": row.price_level,
                "address_or_snippet": row.address_or_snippet,
                "sponsored_in_any_search": False,
            },
        )
        rec["search_categories"].add(row.search_category)
        if row.categories:
            rec["yelp_categories"].add(row.categories)
        rec["sponsored_in_any_search"] |= row.sponsored

        # Prefer populated values.
        for key in ("rating", "review_count", "price_level", "address_or_snippet"):
            if not rec[key] and getattr(row, key):
                rec[key] = getattr(row, key)

    master = []
    for rec in grouped.values():
        rec["search_categories"] = " | ".join(sorted(rec["search_categories"]))
        rec["yelp_categories"] = " | ".join(sorted(rec["yelp_categories"]))
        master.append(rec)

    master.sort(key=lambda x: x["business_name"].lower())

    master_fields = [
        "business_name",
        "yelp_business_id",
        "yelp_url",
        "search_categories",
        "yelp_categories",
        "rating",
        "review_count",
        "price_level",
        "address_or_snippet",
        "sponsored_in_any_search",
    ]
    with master_csv.open("w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=master_fields)
        writer.writeheader()
        writer.writerows(master)

    master_json.write_text(
        json.dumps(master, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )

    print(f"\nRaw appearances: {len(rows)}")
    print(f"Unique businesses: {len(master)}")
    print(f"Saved to: {output_dir.resolve()}")
    return master


# ---------------------------------------------------------------------------
# Phase 2: full business detail collection
# ---------------------------------------------------------------------------

_WEEKDAY_MAP = {
    "monday": "Monday", "mo": "Monday",
    "tuesday": "Tuesday", "tu": "Tuesday",
    "wednesday": "Wednesday", "we": "Wednesday",
    "thursday": "Thursday", "th": "Thursday",
    "friday": "Friday", "fr": "Friday",
    "saturday": "Saturday", "sa": "Saturday",
    "sunday": "Sunday", "su": "Sunday",
}


def _normalize_day(value: str) -> str:
    key = value.rsplit("/", 1)[-1].strip().lower()
    return _WEEKDAY_MAP.get(key, clean_text(value))


def _format_time(value: str) -> str:
    m = re.match(r"^(\d{1,2}):(\d{2})", value or "")
    if not m:
        return value or ""
    hour, minute = int(m.group(1)), m.group(2)
    suffix = "AM" if hour < 12 else "PM"
    hour12 = hour % 12
    if hour12 == 0:
        hour12 = 12
    return f"{hour12}:{minute} {suffix}"


def decode_biz_redir(href: str) -> str:
    """Yelp wraps outbound business websites behind /biz_redir?url=<encoded>."""
    if not href:
        return ""
    parsed = urlparse(urljoin("https://www.yelp.com", href))
    if "biz_redir" not in parsed.path:
        return href if href.startswith("http") else ""
    query = parse_qs(parsed.query)
    for key in ("url", "website"):
        if key in query and query[key]:
            return unquote(query[key][0])
    return ""


def extract_business_json_ld(page) -> dict:
    scripts = page.locator('script[type="application/ld+json"]')
    for i in range(scripts.count()):
        try:
            raw = scripts.nth(i).text_content() or ""
            data = json.loads(raw)
        except Exception:
            continue

        nodes = data if isinstance(data, list) else [data]
        for node in nodes:
            if not isinstance(node, dict):
                continue
            node_type = node.get("@type", "")
            types = node_type if isinstance(node_type, list) else [node_type]
            if not any("business" in str(t).lower() or "restaurant" in str(t).lower() or "localbusiness" in str(t).lower() for t in types) and "address" not in node:
                continue
            return node
    return {}


def extract_business_detail(page, business_id: str, yelp_url: str, fallback_name: str) -> BusinessDetail:
    detail = BusinessDetail(
        yelp_business_id=business_id,
        yelp_url=yelp_url,
        business_name=fallback_name,
    )

    ld = extract_business_json_ld(page)

    if ld:
        detail.business_name = clean_text(ld.get("name")) or detail.business_name
        detail.phone = clean_text(str(ld.get("telephone", "")))
        detail.price_level = clean_text(str(ld.get("priceRange", "")))

        address = ld.get("address") or {}
        if isinstance(address, dict):
            detail.street_address = clean_text(address.get("streetAddress"))
            detail.city = clean_text(address.get("addressLocality"))
            detail.state = clean_text(address.get("addressRegion"))
            detail.zip_code = clean_text(address.get("postalCode"))

        geo = ld.get("geo") or {}
        if isinstance(geo, dict):
            detail.latitude = clean_text(str(geo.get("latitude", "")))
            detail.longitude = clean_text(str(geo.get("longitude", "")))

        aggregate = ld.get("aggregateRating") or {}
        if isinstance(aggregate, dict):
            detail.rating = clean_text(str(aggregate.get("ratingValue", "")))
            detail.review_count = clean_text(str(aggregate.get("reviewCount", "")))

        cuisines = ld.get("servesCuisine")
        if cuisines:
            if isinstance(cuisines, list):
                detail.categories = ", ".join(clean_text(str(c)) for c in cuisines if clean_text(str(c)))
            else:
                detail.categories = clean_text(str(cuisines))

        hours_spec = ld.get("openingHoursSpecification")
        if isinstance(hours_spec, list):
            hours: dict[str, str] = {}
            for spec in hours_spec:
                if not isinstance(spec, dict):
                    continue
                days = spec.get("dayOfWeek", [])
                days = days if isinstance(days, list) else [days]
                opens = _format_time(str(spec.get("opens", "")))
                closes = _format_time(str(spec.get("closes", "")))
                if not opens or not closes:
                    continue
                for day in days:
                    day_name = _normalize_day(str(day))
                    hours[day_name] = f"{opens} - {closes}"
            if hours:
                detail.hours = json.dumps(hours, ensure_ascii=False)

        image = ld.get("image")
        if isinstance(image, list) and image:
            detail.main_photo_url = clean_text(str(image[0]))
        elif isinstance(image, str):
            detail.main_photo_url = clean_text(image)

    # DOM fallbacks for fields Yelp's JSON-LD frequently omits.
    if not detail.phone:
        tel_locator = page.locator('a[href^="tel:"]').first
        try:
            if tel_locator.count():
                href = tel_locator.get_attribute("href") or ""
                detail.phone = clean_text(href.replace("tel:", ""))
        except Exception:
            pass

    if not detail.website:
        redir_locator = page.locator('a[href*="biz_redir"]').first
        try:
            if redir_locator.count():
                href = redir_locator.get_attribute("href") or ""
                detail.website = decode_biz_redir(href)
        except Exception:
            pass

    if not detail.main_photo_url:
        try:
            og_image = page.locator('meta[property="og:image"]').first
            if og_image.count():
                detail.main_photo_url = clean_text(og_image.get_attribute("content") or "")
        except Exception:
            pass

    try:
        meta_description = page.locator('meta[name="description"]').first
        if meta_description.count():
            detail.description = clean_text(meta_description.get_attribute("content") or "")
    except Exception:
        pass

    if not detail.categories:
        try:
            chips = page.locator('a[href*="cflt="]')
            names = []
            for i in range(min(chips.count(), 15)):
                txt = clean_text(chips.nth(i).inner_text(timeout=800))
                if txt and txt not in names:
                    names.append(txt)
            if names:
                detail.categories = ", ".join(names)
        except Exception:
            pass

    return detail


def load_master(output_dir: Path) -> list[dict]:
    master_json = output_dir / "02_master_businesses.json"
    if not master_json.exists():
        raise FileNotFoundError(
            f"{master_json} not found. Run without --skip-search first, "
            "or point --output at a directory that already has it."
        )
    return json.loads(master_json.read_text(encoding="utf-8"))


def collect_details(
    context,
    output_dir: Path,
    master: list[dict],
    headless: bool,
    delay: float,
) -> list[BusinessDetail]:
    raw_dir = output_dir / "raw_html"
    raw_dir.mkdir(parents=True, exist_ok=True)

    page = context.pages[0] if context.pages else context.new_page()
    page.set_default_timeout(15000)

    details: list[BusinessDetail] = []
    total = len(master)

    for idx, business in enumerate(master, start=1):
        business_id = business["yelp_business_id"]
        yelp_url = business["yelp_url"]
        name = business.get("business_name", "")
        print(f"[{idx}/{total}] {name} -> {yelp_url}")

        try:
            page.goto(yelp_url, wait_until="domcontentloaded", timeout=45000)
            page.wait_for_timeout(2000)
            handle_block_if_needed(page, headless)

            html_path = raw_dir / f"biz_{business_id}.html"
            html_path.write_text(page.content(), encoding="utf-8")

            detail = extract_business_detail(page, business_id, yelp_url, name)
            detail.search_categories = business.get("search_categories", "")
        except Exception as exc:  # noqa: BLE001 - keep going across a large business list
            print(f"  ERROR: {exc}")
            detail = BusinessDetail(
                yelp_business_id=business_id,
                yelp_url=yelp_url,
                business_name=name,
                search_categories=business.get("search_categories", ""),
                scrape_status="error",
                error_message=str(exc),
            )

        details.append(detail)
        time.sleep(delay)

    return details


def export_details(details: list[BusinessDetail], output_dir: Path) -> None:
    detail_csv = output_dir / "03_business_details.csv"
    detail_json = output_dir / "03_business_details.json"

    fields = list(BusinessDetail.__dataclass_fields__.keys())
    with detail_csv.open("w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        writer.writerows(asdict(d) for d in details)

    detail_json.write_text(
        json.dumps([asdict(d) for d in details], indent=2, ensure_ascii=False),
        encoding="utf-8",
    )

    ok = sum(1 for d in details if d.scrape_status == "ok")
    print(f"\nBusiness detail pages scraped: {len(details)} ({ok} ok, {len(details) - ok} errors)")
    print(f"Saved to: {output_dir.resolve()}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default="yelp_orange_beach_export")
    parser.add_argument("--headless", action="store_true")
    parser.add_argument("--page-size", type=int, default=10)
    parser.add_argument("--max-pages", type=int, default=30)
    parser.add_argument("--delay", type=float, default=2.5)
    parser.add_argument(
        "--skip-search",
        action="store_true",
        help="Skip phase 1 and reuse an existing 02_master_businesses.json in --output.",
    )
    parser.add_argument(
        "--search-only",
        action="store_true",
        help="Run phase 1 only; do not visit individual business pages.",
    )
    parser.add_argument(
        "--max-businesses",
        type=int,
        default=0,
        help="Limit phase 2 to the first N businesses (0 = no limit). Useful for a test run.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)
    profile_dir = output_dir / "browser_profile"

    try:
        with sync_playwright() as p:
            context = p.chromium.launch_persistent_context(
                user_data_dir=str(profile_dir),
                headless=args.headless,
                viewport={"width": 1440, "height": 1000},
                locale="en-US",
                slow_mo=100 if not args.headless else 0,
            )

            if not args.skip_search:
                rows = collect(
                    context=context,
                    output_dir=output_dir,
                    headless=args.headless,
                    page_size=args.page_size,
                    max_pages=args.max_pages,
                    delay=args.delay,
                )
                master = export(rows, output_dir)
            else:
                master = load_master(output_dir)

            if not args.search_only:
                if args.max_businesses:
                    master = master[: args.max_businesses]
                details = collect_details(
                    context=context,
                    output_dir=output_dir,
                    master=master,
                    headless=args.headless,
                    delay=args.delay,
                )
                export_details(details, output_dir)

            context.close()
        return 0
    except KeyboardInterrupt:
        print("\nStopped by user.", file=sys.stderr)
        return 130
    except Exception as exc:
        print(f"\nERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
